// Dex_QR deterministic fuzz harness (cycle 5). Original code, MIT License. No dependencies.
//
// Feeds random and mutated frames to packet.parseText, packet.parseKeyFrame and ReceiverSession (plus
// session.open on completed transfers and container.openPayload on mutated containers) and checks that
// nothing throws, nothing takes too long, memory stays bounded and the session state stays consistent.
// The same --seed always gives the same cases.
//
// Usage: node --expose-gc tests/fuzz/fuzz.mjs [--cases 100000] [--seed 1] [--root DIR] [--out results/fuzz.json]
//   --root DIR  load src/ from another checkout (e.g. a `git worktree` of an older commit) to measure "before".
// Exit code 1 when anything is found. Findings are grouped by kind and first message, with a reproducer
// (case number and the input text, shortened) for each group.
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const args = Object.fromEntries(process.argv.slice(2).reduce((a, x, i, all) => (x.startsWith("--") ? a.concat([[x.slice(2), all[i + 1] && !all[i + 1].startsWith("--") ? all[i + 1] : "1"]]) : a), []));
const CASES = Number(args.cases ?? 100000);
const SEED = Number(args.seed ?? 1) >>> 0;
const ROOT = path.resolve(args.root ?? path.join(HERE, "..", ".."));
const HANG_MS = Number(args.hang ?? 1000);          // one call slower than this counts as a hang
const HEAP_LIMIT_MB = Number(args.heap ?? 48);       // retained growth (after GC) above this counts as unbounded allocation

const SCRIPTS = ["src/base45.js", "src/crc32.js", "src/lt.js", "src/packet.js", "src/strength.js", "src/container.js", "src/session.js"];
const ctx = vm.createContext({ TextEncoder, TextDecoder, crypto: globalThis.crypto, CompressionStream, DecompressionStream, performance, Date, Math, Uint8Array, console });
ctx.globalThis = ctx;
for (const rel of SCRIPTS) if (fs.existsSync(path.join(ROOT, rel))) vm.runInContext(fs.readFileSync(path.join(ROOT, rel), "utf8"), ctx, { filename: rel });
const DQ = ctx.DexQR;
const P = DQ.packet;

// ---- deterministic PRNG (mulberry32), independent of the code under test ----
let rs = SEED || 1;
function rnd() { rs = (rs + 0x6d2b79f5) | 0; let t = Math.imul(rs ^ (rs >>> 15), 1 | rs); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }
const ri = (n) => Math.floor(rnd() * n);                 // [0, n)
const pick = (a) => a[ri(a.length)];
const chance = (p) => rnd() < p;
const bytesOf = (n) => { const b = new Uint8Array(n); for (let i = 0; i < n; i++) b[i] = ri(256); return b; };
const sha8 = (b) => new Uint8Array(createHash("sha256").update(b).digest().subarray(0, 8));
const short = (s) => (typeof s === "string" && s.length > 160 ? s.slice(0, 160) + `…(${s.length} chars)` : s);

// ---- findings ----
const findings = new Map();      // key -> {kind, msg, count, firstCase, input}
let caseNo = 0;
function report(kind, msg, input) {
  const key = kind + ": " + String(msg).split("\n")[0].replace(/\d+/g, "N").slice(0, 140);
  const f = findings.get(key);
  if (f) f.count++; else findings.set(key, { kind, msg: String(msg).split("\n")[0].slice(0, 300), count: 1, firstCase: caseNo, input: short(typeof input === "string" ? input : JSON.stringify(input)) });
}
let maxCallMs = 0, maxCallWhat = "";
function timed(what, input, fn) {
  const t0 = performance.now();
  let out;
  try { out = fn(); } catch (e) { report("exception", `${what} threw ${e && e.name}: ${e && e.message}`, input); out = undefined; }
  const ms = performance.now() - t0;
  if (ms > maxCallMs) { maxCallMs = ms; maxCallWhat = what; }
  if (ms > HANG_MS) report("hang", `${what} took ${ms.toFixed(0)} ms`, input);
  return out;
}
const check = (cond, msg, input) => { if (!cond) report("invariant", msg, input); return cond; };

// ---- base corpus: real streams from the real sender ----
const enc = new TextEncoder();
async function stream(opts) { const s = await DQ.SenderSession.create(opts); return s; }
const corpus = [
  await stream({ name: "a.bin", data: bytesOf(3000), blockSize: 200, compress: false }),                       // K 16, v2, ML
  await stream({ name: "one", data: bytesOf(5), blockSize: 400, compress: false }),                            // K 1
  await stream({ name: "v1.bin", data: bytesOf(1500), blockSize: 100, version: 1, compress: false }),          // v1
  await stream({ name: "e.bin", data: bytesOf(2000), blockSize: 100, passphrase: "pw fuzz", iterations: 100000, compress: false }), // encrypted + key frames
  await stream({ name: "z.csv", data: enc.encode("id,v\n" + Array.from({ length: 400 }, (_, i) => `${i},${i * 7 % 13}`).join("\n")), blockSize: 64 }), // compressed
  await stream({ name: "odd.bin", data: bytesOf(777), blockSize: 37, compress: false }),                       // odd T
];
const peel = await stream({ name: "p.bin", data: bytesOf(3100 * 8), blockSize: 8, compress: false });          // K > 3000: peeling decoder
const files = new Map();   // fileIdHex -> {data, passphrase}
const corpusFiles = [bytesOf(0)];
for (const s of corpus.concat([peel])) files.set(P.hex(s.fileId), s);
const passFor = (s) => (s.encrypted ? "pw fuzz" : undefined);
const validTexts = corpus.flatMap((s) => Array.from({ length: 6 }, (_, i) => s.textForSeed(i * 7919 + 3)));
const validKeys = corpus.filter((s) => s.keyFrameText).map((s) => s.keyFrameText);

// ---- mutators ----
const B45 = P.PREFIX.length ? "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ $%*+-./:" : "";
const JUNK = ["a", "z", "\u0000", "\u00e9", "\u20ac", "\ud83d\ude00", "\n", "~", "_", "#", "\ud800"];
function fixCrc(b, end) { if (end >= 0 && b.length >= end + 4) new DataView(b.buffer, b.byteOffset, b.byteLength).setUint32(end, DQ.crc32(b, 0, end)); }
function setU(b, off, n, v) { for (let i = n - 1; i >= 0; i--) { if (off + i < b.length) b[off + i] = v & 0xff; v = Math.floor(v / 256); } }

function mutateBytes(src, isKey) {
  let b = src.slice();
  const ops = 1 + ri(3);
  let crcFix = chance(0.6);
  for (let o = 0; o < ops; o++) {
    switch (ri(9)) {
      case 0: { const n = 1 + ri(8); for (let i = 0; i < n; i++) { const at = chance(0.7) ? ri(Math.min(b.length, isKey ? 36 : 23)) : ri(b.length); if (b.length) b[at] ^= 1 << ri(8); } break; }   // header-biased bit flips
      case 1: b = b.slice(0, ri(b.length + 1)); break;                                                      // truncation
      case 2: { const n = b.length; const x = new Uint8Array(n + 1 + ri(64)); x.set(b); x.set(bytesOf(x.length - n), n); b = x; break; } // extension
      case 3: if (b.length) b[0] = pick([0, 1, 2, 3, 9, 127, 255]); break;                                  // wrong version
      case 4: if (isKey) { setU(b, 10, 4, pick([0, 1, 99999, 100000, 10000000, 10000001, 0xffffffff, ri(2 ** 32)])); }
              else setU(b, 10, 3, pick([0, 1, 2, 3000, 3001, P.MAX_K, P.MAX_K + 1, 0xffffff, ri(2 ** 24)])); break; // K / iterations
      case 5: if (isKey) b[1] = pick([0, 2, 255]); else setU(b, 13, 2, pick([0, 1, 2, 65535, ri(65536)])); break; // KDF id / T
      case 6: if (!isKey) setU(b, 15, 4, pick([0, 1, 2 ** 32 - 1, P.MAX_LENGTH, P.MAX_LENGTH + 1, ri(2 ** 32)])); break; // F
      case 7: if (!isKey) setU(b, 19, 4, pick([0, 1, 2 ** 32 - 1, ri(2 ** 32)])); break;                    // seed
      case 8: if (!isKey && b.length > 1) b[1] = ri(256); break;                                            // flags
    }
  }
  if (!isKey && chance(0.4) && b.length >= 23) {
    // Make the header self-consistent (K = ceil(F/T), length = 23+T+4) so the frame reaches the decoder.
    const T = Math.max(1, ((b[13] << 8) | b[14]) % 600 || 1 + ri(300));
    const K = 1 + ri(chance(0.2) ? P.MAX_K : 4000);
    const F = (K - 1) * T + 1 + ri(T);
    setU(b, 10, 3, K); setU(b, 13, 2, T); setU(b, 15, 4, F);
    const x = new Uint8Array(23 + T + 4); x.set(b.subarray(0, Math.min(b.length, x.length))); b = x; crcFix = true;
  }
  if (crcFix) fixCrc(b, isKey ? 32 : b.length - 4);
  return b;
}

function mutateText(t) {
  const ops = 1 + ri(3);
  for (let o = 0; o < ops; o++) {
    const at = ri(t.length + 1);
    switch (ri(8)) {
      case 0: t = t.slice(0, at) + pick(JUNK) + t.slice(at + 1); break;                         // invalid character
      case 1: t = t.slice(0, at) + B45[ri(45)] + t.slice(at + 1); break;                        // valid character, wrong value
      case 2: t = t.slice(0, at) + t.slice(at + 1 + ri(4)); break;                              // deletion (length % 3 changes)
      case 3: t = t.slice(0, at) + ":::" + t.slice(at); break;                                  // triplet overflow
      case 4: t = t.toLowerCase(); break;
      case 5: t = pick(["DQ", "DK", "dq", "D", "", "DQDQ", "DKDQ", " DQ"]) + t.slice(2); break;  // prefix games
      case 6: t = t.slice(0, ri(t.length + 1)); break;                                          // truncated text
      case 7: t = t + t.slice(2, 2 + ri(t.length)); break;                                      // concatenated garbage
    }
  }
  return t;
}

function randomText() {
  const n = chance(0.05) ? ri(30000) : ri(200);
  const pre = pick(["DQ", "DK", "", "http://", "DQ", "DK"]);
  let s = pre;
  const alpha = chance(0.7) ? B45 : B45 + "abcxyz\u00e9\u0000\ud83d";
  for (let i = 0; i < n; i++) s += alpha[ri(alpha.length)];
  return s;
}

function garbageFrame() {
  const r = ri(10);
  if (r < 2) return randomText();
  if (r < 4) return mutateText(pick(validTexts.concat(validKeys)));
  if (r < 8) { const src = pick(validTexts); return P.PREFIX + DQ.base45.encode(mutateBytes(DQ.base45.decode(src.slice(2)), false)); }
  if (validKeys.length) { const src = pick(validKeys); return P.KEY_PREFIX + DQ.base45.encode(mutateBytes(DQ.base45.decode(src.slice(2)), true)); }
  return randomText();
}
// A non-string from a misbehaving scanner callback.
const ODD = [undefined, null, 42, {}, [], new Uint8Array(4), { toString() { return "DQ"; } }];

// ---- oracles ----
const PARSE_REASONS = new Set(["foreign", "base45", "short", "version", "length", "crc", "inconsistent", "limits", "too-long"]);
const KEY_REASONS = new Set(["foreign", "base45", "length", "crc", "version", "limits", "too-long"]);
function checkParse(text) {
  const r = timed("parseText", text, () => P.parseText(text));
  if (!r) return;
  if (!check(typeof r.ok === "boolean", "parseText result has no boolean ok", text)) return;
  if (!r.ok) { check(PARSE_REASONS.has(r.reason), "parseText unknown reason " + r.reason, text); return; }
  const m = r.meta;
  check(P.SUPPORTED.includes(m.version), "parseText accepted version " + m.version, text);
  check(m.K >= 1 && m.K <= P.MAX_K && m.length <= P.MAX_LENGTH, `parseText accepted out-of-limit K=${m.K} F=${m.length}`, text);
  check(m.blockSize >= 1 && r.block.length === m.blockSize && Math.ceil(m.length / m.blockSize) === m.K, "parseText accepted inconsistent header", text);
  check(!(m.compressed && m.encrypted), "parseText: compressed and encrypted both set", text);
  check(m.fileId.length === 8 && m.fileIdHex === P.hex(m.fileId) && r.seed >>> 0 === r.seed, "parseText bad fileId/seed", text);
  const flags = DQ.base45.decode(text.slice(2))[1];
  if ((flags & ~3) === 0 && flags !== 3) check(P.packetToText(P.buildPacket(m, r.seed, r.block)) === text, "parseText round trip differs", text);
}
function checkKey(text) {
  const r = timed("parseKeyFrame", text, () => P.parseKeyFrame(text));
  if (!r) return;
  if (!check(typeof r.ok === "boolean", "parseKeyFrame result has no boolean ok", text)) return;
  if (!r.ok) { check(KEY_REASONS.has(r.reason), "parseKeyFrame unknown reason " + r.reason, text); return; }
  check(r.iterations >= 100000 && r.iterations <= 10000000, "parseKeyFrame accepted iterations " + r.iterations, text);
  check(r.salt.length === 16 && r.kcv.length === 2 && r.fileId.length === 8, "parseKeyFrame field sizes", text);
  check(P.buildKeyFrame(r) === text, "parseKeyFrame round trip differs", text);
}
function checkSession(s, lockedMeta, input) {
  const st = s.stats;
  // switchToPending keeps stats.keyFrames (key frames stay remembered) but restarts the other counters.
  const sum = st.accepted + st.duplicates + st.rejected + st.foreign + st.otherFile + st.keyFrames - (s.fuzzKeyBase || 0);
  check(sum === st.qrTexts, `session counters do not add up (${sum} vs ${st.qrTexts})`, input);
  if (lockedMeta) check(s.meta === lockedMeta, "session meta changed without reset or switch", input);
  if (s.meta) {
    check(s.decoder && s.decoder.K === s.meta.K && s.decoder.blockSize === s.meta.blockSize, "decoder does not match meta", input);
    const p = s.progress();
    check(p.fraction >= 0 && p.fraction <= 1 && p.recovered <= p.K, "progress out of range", input);
  } else check(!s.decoder, "decoder without meta", input);
  if (s.pending) check(s.pending.texts.length <= DQ.ReceiverSession.PENDING_MAX && s.pending.texts.length === s.pending.seen.size, "pending buffer inconsistent or unbounded", input);
  check(s.keyFrames.size <= DQ.ReceiverSession.KEY_MAX, "key-frame map unbounded", input);
}

// ---- session scenarios ----
const outcomes = {};
const tkey = (m) => [m.version, P.hex(m.fileId), m.K, m.blockSize, m.length].join(":");
const sameB = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);
let resetOrSwitched = false;
function switchNow(s) { resetOrSwitched = true; const kf = s.stats.keyFrames; timed("switchToPending", "", () => s.switchToPending()); s.fuzzKeyBase = kf; }
const openJobs = [];
let sessionFrames = 0, sessionsDone = 0, sessionsOpened = 0;
function sessionScenario() {
  const base = chance(0.01) ? peel : pick(corpus);
  const other = pick(corpus.filter((x) => x !== base));
  const s = new DQ.ReceiverSession();
  const clean = new DQ.lt.LTDecoder(base.K, base.blockSize, P.fileKey32(base.fileId), { extra: DQ.lt.extraDegreeFor(base.version, base.K) });
  const garbageRate = pick([0, 0.1, 0.5, 0.9]), dupRate = pick([0, 0.2, 0.5]), otherRate = pick([0, 0, 0.1, 0.4]);
  const maxValid = base.K * 3 + 40;
  resetOrSwitched = false; let locked = null, validFed = 0, cleanDoneAt = -1, poisoned = false, last = "";
  const seeds = []; let seed = ri(2 ** 32);
  const feed = (t, kind) => {
    sessionFrames++; last = t;
    const r = timed("ReceiverSession.addText", t, () => s.addText(t));
    check(r === undefined || typeof r === "string", "addText returned " + typeof r, t);
    if (!locked && s.meta) locked = s.meta;
    checkSession(s, locked, t);
    if (kind === "garbage" && !poisoned) {
      // A CRC-valid hostile packet that carries the real transfer header but wrong data for its seed: the file
      // cannot be right after that (the SHA-256 check at the end must catch it); the harness only notes it.
      const q = P.parseText(t);
      if (q.ok && tkey(q.meta) === tkey(base.meta)) {
        if (!sameB(q.block, base.encoder.encode(q.seed))) poisoned = true;
        else if (cleanDoneAt < 0) { clean.addPacket(q.seed, q.block); if (clean.done) cleanDoneAt = validFed; }   // a mutation that left an honest packet
      }
    }
  };
  if (chance(0.3)) for (let i = 0; i < 1 + ri(4); i++) feed(garbageFrame(), "garbage");      // garbage before the first packet (may lock onto a hostile header)
  if (chance(0.05)) feed(pick(ODD), "garbage");
  while (validFed < maxValid && !(s.done && s.meta && tkey(s.meta) === tkey(base.meta))) {
    if (chance(garbageRate)) { feed(garbageFrame(), "garbage"); continue; }
    if (chance(otherRate)) { feed(other.nextFrame ? other.textForSeed(ri(5000)) : "", "other"); if (s.otherTransferWaiting && chance(0.3)) { switchNow(s); locked = s.meta; checkSession(s, locked, "switch"); } continue; }
    if (base.keyFrameText && chance(0.03)) { feed(base.keyFrameText, "key"); continue; }
    if (seeds.length && chance(dupRate)) { feed(base.textForSeed(pick(seeds)), "dup"); continue; }
    if (chance(0.002)) { s.reset(); resetOrSwitched = true; s.fuzzKeyBase = 0; locked = null; clean.seen.clear(); }   // user pressed Reset: start counting again
    seed = (seed + 1 + (chance(0.2) ? ri(1000) : 0)) >>> 0; seeds.push(seed);
    const t = base.textForSeed(seed);
    validFed++;
    if (cleanDoneAt < 0) { clean.addPacket(seed, P.parseText(t).block); if (clean.done) cleanDoneAt = validFed; }
    feed(t, "valid");
    // Locked to something else (a hostile header or the other stream): switch when offered, like the page does.
    if (s.meta && tkey(s.meta) !== tkey(base.meta) && s.otherTransferWaiting) { switchNow(s); locked = s.meta; }
  }
  const onBase = s.meta && tkey(s.meta) === tkey(base.meta);
  const why = !s.meta ? "no-lock" : !onBase ? "locked-elsewhere" : !s.done ? "not-done" : poisoned ? "poisoned" : "done";
  outcomes[why] = (outcomes[why] || 0) + 1;
  // Garbage, duplicates and other transfers must not change how many valid packets the decoder needs.
  if (why === "done" && !resetOrSwitched) check(validFed === cleanDoneAt, `decoder needed ${validFed} valid packets with noise vs ${cleanDoneAt} without`, "base K " + base.K);
  if (why === "not-done" && !resetOrSwitched && cleanDoneAt > 0) report("invariant", "session did not finish although a clean decoder finished on the same valid packets", "base K " + base.K);
  if (onBase && s.done && !poisoned) {
    sessionsDone++;
    const pl = timed("payload", last, () => s.payload());
    check(pl && sha8(pl).every((x, i) => x === base.fileId[i]), "session finished with a wrong payload", "base " + base.K);
    if (chance(0.15)) openJobs.push({ s, base });
  }
}

// ---- container scenarios: mutated containers with a matching file ID, through a real LT stream and session.open ----
const OPEN_CODES = new Set(["CHECKSUM_MISMATCH", "NEED_PASSPHRASE", "WRONG_PASSPHRASE", "BAD_FORMAT", "TOO_LARGE", "NO_DECOMPRESSION"]);
function mutateContainer(src) {
  let b = src.slice();
  switch (ri(7)) {
    case 0: b = b.slice(0, ri(Math.min(b.length + 1, 64))); break;                       // truncated (short headers)
    case 1: b = b.slice(0, ri(b.length + 1)); break;
    case 2: if (b.length > 5) { b[4] = ri(256); b[5] = ri(256); } break;                  // name length (DQF1) / algorithm+size (DQZ1)
    case 3: { const n = 1 + ri(6); for (let i = 0; i < n; i++) if (b.length) b[ri(Math.min(b.length, 40))] ^= 1 << ri(8); break; }
    case 4: if (b.length > 8) setU(b, 4, 4, pick([0, 99999, 100000, 10000001, 0xffffffff, 33558528, 33558529])); break;  // DQE1 iterations / DQZ1 alg+size
    case 5: { const m = pick(["DQF1", "DQZ1", "DQE1"]); for (let i = 0; i < 4 && i < b.length; i++) b[i] = m.charCodeAt(i); b = b.slice(0, ri(b.length + 1)); break; }
    case 6: { const m = pick(["DQF1", "DQZ1", "DQE1"]); b = new Uint8Array(ri(5)); for (let i = 0; i < b.length; i++) b[i] = m.charCodeAt(i); break; }
  }
  return b;
}
function containerJob() {
  const src = pick(corpus);
  const payload = mutateContainer(src.payload);
  if (payload.length === 0) return null;
  const T = 1 + ri(64), fileId = sha8(payload), K = Math.max(1, Math.ceil(payload.length / T));
  const meta = { version: 2, encrypted: payload[0] === 0x44 && payload[2] === 0x45, fileId, K, blockSize: T, length: payload.length };
  const e = new DQ.lt.LTEncoder(payload, T, P.fileKey32(fileId), { extra: DQ.lt.extraDegreeFor(2, K) });
  const s = new DQ.ReceiverSession();
  for (let sd = 0; !s.done && sd < K * 20 + 40; sd++) timed("ReceiverSession.addText", "container", () => s.addText(P.packetToText(P.buildPacket(meta, sd, e.encode(sd)))));
  if (!check(s.done, "crafted container stream did not finish", P.hex(payload.subarray(0, 40)))) return null;
  return { s, payload, pass: chance(0.8) ? "pw fuzz" : undefined };
}
// Reference view of a plain DQF1 container: what a correct parser may return.
function expectInner(buf) {
  if (buf.length < 7) return null;
  const nl = (buf[4] << 8) | buf[5];
  if (7 + nl > buf.length) return null;
  const ml = buf[6 + nl];
  if (7 + nl + ml > buf.length) return null;
  return { dataLength: buf.length - 7 - nl - ml };
}
async function runOpen(job, isContainer) {
  const t0 = performance.now();
  try {
    const out = await job.s.open(isContainer ? job.pass : passFor(job.base));
    if (isContainer) {
      const p = job.payload;
      const magic = String.fromCharCode(...p.subarray(0, 4));
      if (magic === "DQF1") { const ex = expectInner(p); check(ex && out.data.length === ex.dataLength, "open accepted a truncated DQF1 container (data includes header bytes)", P.hex(p.subarray(0, 40))); }
      check(out.data instanceof ctx.Uint8Array || out.data instanceof Uint8Array, "open returned non-bytes", P.hex(p.subarray(0, 40)));
    } else {
      sessionsOpened++;
      check(out.data.length >= 0, "open returned no data", "");
    }
  } catch (e) {
    if (!isContainer) report("invariant", "valid transfer failed to open: " + (e && (e.code || e.name)) + " " + (e && e.message), "");
    else if (!OPEN_CODES.has(e && e.code)) report("exception", `open threw ${e && e.name} without a Dex_QR code: ${e && e.message}`, P.hex(job.payload.subarray(0, 40)));
    else {
      const p = job.payload, magic = String.fromCharCode(...p.subarray(0, 4));
      // A truncated encrypted container is a format error, not a wrong passphrase.
      if (magic === "DQE1" && p.length < 36 + 16 && e.code === "WRONG_PASSPHRASE") report("invariant", "truncated DQE1 container reported as WRONG_PASSPHRASE", P.hex(p));
    }
  }
  const ms = performance.now() - t0;
  if (ms > HANG_MS + 1500) report("hang", `open took ${ms.toFixed(0)} ms`, isContainer ? P.hex(job.payload.subarray(0, 40)) : "");
}

// ---- long-lived receiver: many different transfers in one page session (Reset between them) ----
function heapMB() { if (globalThis.gc) globalThis.gc(); const m = process.memoryUsage(); return (m.heapUsed + m.arrayBuffers) / 1048576; }
function manyTransfers(n) {
  // Hostile or simply many: each transfer has its own K, so anything cached per K must stay bounded.
  const s = new DQ.ReceiverSession();
  for (let i = 0; i < n; i++) {
    const T = 1 + ri(4), K = 3001 + ri(P.MAX_K - 3001), F = (K - 1) * T + 1;
    const meta = { version: 2, encrypted: false, fileId: bytesOf(8), K, blockSize: T, length: F };
    timed("ReceiverSession.addText", `K=${K}`, () => s.addText(P.packetToText(P.buildPacket(meta, ri(2 ** 32), bytesOf(T)))));
    s.reset();
  }
}

// ---- run ----
const mix = { parse: 0.42, key: 0.25, session: 0.30, container: 0.03 };
const counts = { parse: 0, key: 0, session: 0, container: 0, longLived: 0 };
const time = { parse: 0, key: 0, session: 0, container: 0 };
const heap0 = heapMB();
const t0 = performance.now();
for (caseNo = 0; caseNo < CASES; caseNo++) {
  const u = rnd();
  const c0 = performance.now();
  if (u < mix.parse) {
    counts.parse++;
    const r = ri(10);
    let t;
    if (r < 2) t = randomText();
    else if (r < 4) t = mutateText(pick(validTexts));
    else if (r < 9) t = P.PREFIX + DQ.base45.encode(mutateBytes(DQ.base45.decode(pick(validTexts).slice(2)), false));
    else t = chance(0.5) ? pick(validTexts) : pick(ODD);
    checkParse(t);
    time.parse += performance.now() - c0;
  } else if (u < mix.parse + mix.key) {
    counts.key++;
    const r = ri(10);
    let t;
    if (r < 2) t = "DK" + randomText().slice(2);
    else if (r < 4) t = mutateText(pick(validKeys));
    else if (r < 9) t = P.KEY_PREFIX + DQ.base45.encode(mutateBytes(DQ.base45.decode(pick(validKeys).slice(2)), true));
    else t = chance(0.5) ? pick(validKeys) : pick(ODD);
    checkKey(t);
    time.key += performance.now() - c0;
  } else if (u < mix.parse + mix.key + mix.session) {
    counts.session++;
    sessionScenario();
    time.session += performance.now() - c0;
  } else {
    counts.container++;
    const job = containerJob();
    if (job) await runOpen(job, true);
    time.container += performance.now() - c0;
  }
  if (openJobs.length >= 8) { for (const j of openJobs.splice(0)) await runOpen(j, false); }
}
for (const j of openJobs.splice(0)) await runOpen(j, false);
// Long-lived receiver check (memory retained after GC, independent of CASES so before/after compare).
const heapA = heapMB();
const LONG = Number(args.long ?? 300);
manyTransfers(LONG); counts.longLived = LONG;
const heapB = heapMB();
if (heapB - heapA > HEAP_LIMIT_MB) report("alloc", `${LONG} transfers with different K in one receiver retained ${(heapB - heapA).toFixed(0)} MB after GC (limit ${HEAP_LIMIT_MB} MB)`, `manyTransfers(${LONG})`);
const totalMs = performance.now() - t0;
if (heapB - heap0 > HEAP_LIMIT_MB * 2) report("alloc", `whole run retained ${(heapB - heap0).toFixed(0)} MB after GC`, "");

const per10k = (k) => (counts[k] ? +(time[k] / counts[k] * 10000 / 1000).toFixed(2) : null);
const summary = {
  root: path.relative(process.cwd(), ROOT) || ".", seed: SEED, cases: CASES, counts,
  sessionFrames, sessionOutcomes: outcomes, sessionsDecoded: sessionsDone, sessionsOpened,
  seconds: +(totalMs / 1000).toFixed(1),
  secondsPer10k: { parseText: per10k("parse"), parseKeyFrame: per10k("key"), sessionScenario: per10k("session"), containerOpen: per10k("container") },
  maxCallMs: +maxCallMs.toFixed(1), maxCallWhat,
  retainedMB: { longLived: +(heapB - heapA).toFixed(1), wholeRun: +(heapB - heap0).toFixed(1), gc: !!globalThis.gc },
  findings: [...findings.values()].sort((a, b) => b.count - a.count),
  byKind: [...findings.values()].reduce((a, f) => ((a[f.kind] = (a[f.kind] || 0) + f.count), a), {}),
};
console.log(JSON.stringify(summary, null, 1));
if (args.out) fs.writeFileSync(path.resolve(args.out), JSON.stringify(summary, null, 1) + "\n");
if (findings.size) process.exitCode = 1;
