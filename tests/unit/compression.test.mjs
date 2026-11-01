// Transparent payload compression (container "DQZ1", cycle 2) and backward compatibility.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { randomBytes } from "node:crypto";
import fs from "node:fs";
const require = createRequire(import.meta.url);
const DQ = require("../lib/load.cjs").load();
const C = DQ.container;
const te = new TextEncoder();
const LEGACY = JSON.parse(fs.readFileSync(new URL("../fixtures/legacy_streams.json", import.meta.url), "utf8"));

const csv = te.encode("time,sensor,value\n" + Array.from({ length: 2000 }, (_, i) => `2026-11-01T05:${String(i % 60).padStart(2, "0")}:00Z,s${i % 7},${(Math.sin(i / 9) * 100).toFixed(2)}`).join("\n"));
const magic = (b) => String.fromCharCode(b[0], b[1], b[2], b[3]);
async function deflate(bytes, alg = "deflate-raw") {
  return new Uint8Array(await new Response(new Blob([bytes]).stream().pipeThrough(new CompressionStream(alg))).arrayBuffer());
}
function dqz(algByte, declared, body) {
  const out = new Uint8Array(9 + body.length);
  out.set(te.encode("DQZ1"), 0); out[4] = algByte; new DataView(out.buffer).setUint32(5, declared); out.set(body, 9);
  return out;
}
async function idOf(p) { return (await C.sha256(p)).slice(0, 8); }
async function transfer(opts, passphrase) {
  const s = await DQ.SenderSession.create({ blockSize: 400, ...opts });
  const r = new DQ.ReceiverSession();
  let seed = 7, guard = 0;
  while (!r.done && guard++ < 10 * s.K + 100) r.addText(s.textForSeed(seed++));
  assert.ok(r.done, "receiver finished");
  return { s, r, out: await r.open(passphrase) };
}
async function withoutGlobal(name, fn) {
  const saved = globalThis[name];
  try { delete globalThis[name]; return await fn(); } finally { globalThis[name] = saved; }
}

test("compressible file: DQZ1 container, fewer blocks, exact round trip, header flag set", async () => {
  const plain = await DQ.SenderSession.create({ name: "log.csv", mime: "text/csv", data: csv, blockSize: 400, compress: false });
  const { s, r, out } = await transfer({ name: "log.csv", mime: "text/csv", data: csv });
  assert.equal(magic(s.payload), "DQZ1");
  assert.equal(s.compression.used, true);
  assert.equal(s.compression.algorithm, "deflate-raw");
  assert.ok(s.K < plain.K / 2, `K ${s.K} vs uncompressed ${plain.K}`);
  assert.equal(r.meta.compressed, true);
  assert.deepEqual(Buffer.from(out.data), Buffer.from(csv));
  assert.equal(out.name, "log.csv"); assert.equal(out.mime, "text/csv");
  assert.equal(out.compressed, true); assert.equal(out.encrypted, false);
});

test("incompressible file is sent uncompressed, byte-identical to the old DQF1 format", async () => {
  const data = randomBytes(20000);
  const b = await C.buildPayload({ name: "r.bin", mime: "", data });
  assert.equal(magic(b.payload), "DQF1");
  assert.equal(b.compression.used, false);
  assert.equal(b.compression.reason, "no-gain");
  assert.deepEqual(Buffer.from(b.payload), Buffer.from(C.buildInner("r.bin", "", data)));
  const { r, out } = await transfer({ name: "r.bin", data });
  assert.equal(r.meta.compressed, false); assert.equal(out.compressed, false);
  assert.deepEqual(Buffer.from(out.data), data);
});

test("compress:false turns it off", async () => {
  const b = await C.buildPayload({ name: "a.csv", mime: "text/csv", data: csv, compress: false });
  assert.equal(magic(b.payload), "DQF1"); assert.equal(b.compression.used, false); assert.equal(b.compression.reason, "off");
});

test("compress-then-encrypt: smaller ciphertext, no clear-text compression flag, wrong passphrase still detected", async () => {
  const pass = "pale-violet-anchor-drift-cobalt";
  const enc0 = await C.buildPayload({ name: "a.csv", mime: "text/csv", data: csv, passphrase: pass, iterations: 100000, compress: false });
  const { s, r, out } = await transfer({ name: "a.csv", mime: "text/csv", data: csv, passphrase: pass, iterations: 100000 }, pass);
  assert.equal(magic(s.payload), "DQE1");
  assert.ok(s.payload.length < enc0.payload.length / 2);
  assert.equal(r.meta.encrypted, true);
  assert.equal(r.meta.compressed, false, "flag must not reveal compression of an encrypted payload");
  assert.deepEqual(Buffer.from(out.data), Buffer.from(csv));
  assert.equal(out.compressed, true); assert.equal(out.encrypted, true);
  await assert.rejects(r.open("wrong"), (e) => e.code === "WRONG_PASSPHRASE");
});

test("sender without CompressionStream falls back to uncompressed", async () => {
  const b = await withoutGlobal("CompressionStream", () => C.buildPayload({ name: "a.csv", data: csv }));
  assert.equal(magic(b.payload), "DQF1"); assert.equal(b.compression.used, false); assert.equal(b.compression.reason, "unavailable");
});

test("receiver without DecompressionStream reports NO_DECOMPRESSION for a compressed stream, still opens plain ones", async () => {
  const b = await C.buildPayload({ name: "a.csv", data: csv });
  await withoutGlobal("DecompressionStream", async () => {
    await assert.rejects(C.openPayload(b.payload, b.fileId), (e) => e.code === "NO_DECOMPRESSION" && /DecompressionStream/.test(e.message));
    const p = await C.buildPayload({ name: "a.csv", data: csv, compress: false });
    assert.equal((await C.openPayload(p.payload, p.fileId)).data.length, csv.length);
  });
});

test("zip-bomb guard: a declared size over the receiver limit is refused before inflating", async () => {
  const body = await deflate(new Uint8Array(1000));
  const p = dqz(1, C.MAX_DECOMPRESSED + 1, body);
  await assert.rejects(C.openPayload(p, await idOf(p)), (e) => e.code === "TOO_LARGE");
});

test("zip-bomb guard: output beyond the declared size aborts early with bounded memory", async () => {
  const zeros = new Uint8Array(64 * 1024 * 1024);            // 64 MiB of zeros deflates to about 64 KB
  const body = await deflate(zeros);
  assert.ok(body.length < 200000);
  for (const declared of [1000, C.MAX_DECOMPRESSED]) {
    const p = dqz(1, declared, body);
    const t0 = performance.now();
    await assert.rejects(C.openPayload(p, await idOf(p)), (e) => e.code === "TOO_LARGE" && /limit|larger/i.test(e.message));
    assert.ok(performance.now() - t0 < 5000);
  }
  // direct check of the capped inflater: it never returns more than the cap
  await assert.rejects(C.inflateCapped(body, "deflate-raw", 4096), (e) => e.code === "TOO_LARGE");
});

test("DQZ1 with a declared size larger than the real output, corrupt data, unknown algorithm or nesting is BAD_FORMAT", async () => {
  const inner = C.buildInner("x.txt", "text/plain", csv);
  const body = await deflate(inner);
  const cases = [dqz(1, inner.length + 5, body), dqz(1, inner.length, body.slice(0, body.length >> 1)), dqz(1, inner.length, randomBytes(300)), dqz(9, inner.length, body)];
  const nested = dqz(1, 9 + body.length, await deflate(dqz(1, inner.length, body)));
  cases.push(nested);
  for (const p of cases) await assert.rejects(C.openPayload(p, await idOf(p)), (e) => e.code === "BAD_FORMAT", "case " + cases.indexOf(p));
  const ok = dqz(1, inner.length, body);
  assert.deepEqual(Buffer.from((await C.openPayload(ok, await idOf(ok))).data), Buffer.from(csv));
});

test("gzip-coded DQZ1 (algorithm 2) also opens", async () => {
  const inner = C.buildInner("g.csv", "text/csv", csv);
  const p = dqz(2, inner.length, await deflate(inner, "gzip"));
  const out = await C.openPayload(p, await idOf(p));
  assert.deepEqual(Buffer.from(out.data), Buffer.from(csv)); assert.equal(out.compressed, true);
});

test("streams recorded from the pre-compression build (v1 and v2, plain and encrypted) still decode", async () => {
  assert.equal(LEGACY.streams.length, 4);
  for (const st of LEGACY.streams) {
    const r = new DQ.ReceiverSession();
    for (const t of st.texts) { if (r.done) break; r.addText(t); }
    assert.ok(r.done, `v${st.version} enc=${st.encrypted} done`);
    assert.equal(r.meta.version, st.version); assert.equal(r.meta.compressed, false);
    const out = await r.open(st.passphrase || undefined);
    assert.equal(new TextDecoder().decode(out.data), LEGACY.fileText);
    assert.equal(out.name, LEGACY.fileName); assert.equal(out.compressed, false); assert.equal(out.encrypted, st.encrypted);
  }
});
