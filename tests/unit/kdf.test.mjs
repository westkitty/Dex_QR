// PBKDF2 iteration calibration, the receiver's iteration bound, and the passphrase strength estimate (cycle 4).
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import fs from "node:fs";
const require = createRequire(import.meta.url);
const DQ = require("../lib/load.cjs").load();
const C = DQ.container, P = DQ.packet;
const te = new TextEncoder();
const LEGACY = JSON.parse(fs.readFileSync(new URL("../fixtures/legacy_streams.json", import.meta.url), "utf8"));
const PASS = "orbit lantern quiet mosaic thunder";
const data = te.encode("cycle four ".repeat(300));

// A fake device: deriving n iterations takes n * nsPerIter nanoseconds.
const device = (nsPerIter) => { const calls = []; const measure = async (n) => { calls.push(n); return (n * nsPerIter) / 1e6; }; measure.calls = calls; return measure; };

test("calibration constants: floor is the old default, cap stays inside every receiver's accepted range", () => {
  assert.equal(C.DEFAULT_ITERATIONS, 600000);
  assert.equal(C.CALIBRATION.floor, C.DEFAULT_ITERATIONS);
  assert.ok(C.CALIBRATION.cap > C.CALIBRATION.floor);
  assert.ok(C.CALIBRATION.cap <= C.MAX_ITERATIONS, "older receivers accept up to MAX_ITERATIONS, so calibrated streams stay readable");
  assert.equal(C.CALIBRATION.targetMs, 1000);
  assert.equal(C.MAX_ITERATIONS, 10000000);
});

test("calibrateIterations aims at about 1 s on the measured device, rounded down to 100,000", async () => {
  const r = await C.calibrateIterations({ measure: device(127) });       // this box: about 127 ns per iteration
  assert.equal(r.iterations, 7800000);
  assert.ok(r.estimatedMs > 900 && r.estimatedMs <= 1000, String(r.estimatedMs));
  assert.equal(r.capped, false); assert.equal(r.floored, false);
  const slow = await C.calibrateIterations({ measure: device(1000) });     // 1 µs per iteration
  assert.equal(slow.iterations, 1000000);
  const phone = await C.calibrateIterations({ measure: device(600) });
  assert.equal(phone.iterations, 1600000);
});

test("calibration never goes below the old default or above the cap", async () => {
  const verySlow = await C.calibrateIterations({ measure: device(5000) });
  assert.equal(verySlow.iterations, 600000); assert.equal(verySlow.floored, true);
  const veryFast = await C.calibrateIterations({ measure: device(10) });
  assert.equal(veryFast.iterations, C.CALIBRATION.cap); assert.equal(veryFast.capped, true);
});

test("calibration grows the probe when the timer is too coarse, and falls back to the default when it cannot measure", async () => {
  // A timer with 1 ms resolution on a fast device: small probes read as 0 ms.
  const coarse = device(127); const m = async (n) => Math.floor(await coarse(n));
  const r = await C.calibrateIterations({ measure: m });
  assert.ok(m && coarse.calls.length >= 2);
  assert.ok(Math.max(...coarse.calls) > coarse.calls[0], "probe grew");
  assert.ok(r.iterations >= 7000000 && r.iterations <= 8000000, String(r.iterations));
  const broken = await C.calibrateIterations({ measure: async () => 0 });
  assert.equal(broken.iterations, 600000); assert.equal(broken.measured, false);
  const throws = await C.calibrateIterations({ measure: async () => { throw new Error("no subtle"); } });
  assert.equal(throws.iterations, 600000); assert.equal(throws.measured, false);
});

test("calibration cost stays small: total probe iterations under 1.5 M when the timer works", async () => {
  const m = device(127);
  await C.calibrateIterations({ measure: m });
  assert.ok(m.calls.reduce((a, b) => a + b, 0) <= 1500000, JSON.stringify(m.calls));
});

test("real calibration in Node returns a sane count and the measurement is real PBKDF2", async () => {
  const r = await C.calibrateIterations();
  assert.equal(r.measured, true);
  assert.ok(r.iterations >= 600000 && r.iterations <= C.CALIBRATION.cap && r.iterations % 100000 === 0);
});

test("the calibrated count travels in DQE1 and the key frame; payload size and K are unchanged", async () => {
  const mk = (iterations) => DQ.SenderSession.create({ name: "a.txt", data, blockSize: 200, passphrase: PASS, iterations, startSeed: 1 });
  const a = await mk(600000), b = await mk(2300000);
  assert.equal(a.payload.length, b.payload.length);
  assert.equal(a.K, b.K);
  assert.equal(C.encryptedParams(b.payload).iterations, 2300000);
  assert.equal(P.parseKeyFrame(b.keyFrameText).iterations, 2300000);
  assert.equal(b.keyFrameText.length, a.keyFrameText.length);
  const r = new DQ.ReceiverSession();
  for (let i = 0; !r.done && i < 500; i++) r.addText(b.nextFrame());
  assert.equal((await r.checkPassphrase(PASS)).result, "ok");
  const out = await r.open(PASS);
  assert.equal(out.usedCachedKey, true);
  assert.deepEqual(out.data, data);
});

test("a calibrated payload opens with the pre-cycle-4 key derivation (format unchanged)", async () => {
  const s = await DQ.SenderSession.create({ name: "a.txt", data, blockSize: 200, passphrase: PASS, iterations: 1700000, startSeed: 1, compress: false });
  const p = s.payload, dv = new DataView(p.buffer, p.byteOffset);
  const it = dv.getUint32(4);
  const base = await crypto.subtle.importKey("raw", te.encode(PASS), "PBKDF2", false, ["deriveKey"]);
  const key = await crypto.subtle.deriveKey({ name: "PBKDF2", hash: "SHA-256", salt: p.slice(8, 24), iterations: it }, base, { name: "AES-GCM", length: 256 }, false, ["decrypt"]);
  const inner = new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv: p.slice(24, 36), additionalData: p.subarray(0, 24) }, key, p.subarray(36)));
  assert.equal(String.fromCharCode(...inner.slice(0, 4)), "DQF1");
});

test("receiver refuses iteration counts above the bound without deriving anything (DoS guard)", async () => {
  const s = await DQ.SenderSession.create({ name: "a.txt", data, blockSize: 200, passphrase: PASS, iterations: 600000, startSeed: 1 });
  const k = P.parseKeyFrame(s.keyFrameText);
  for (const n of [C.MAX_ITERATIONS + 1, 0xffffffff]) assert.equal(P.parseKeyFrame(P.buildKeyFrame({ fileId: s.fileId, iterations: n, salt: k.salt, kcv: k.kcv })).reason, "limits");
  assert.equal(P.parseKeyFrame(P.buildKeyFrame({ fileId: s.fileId, iterations: C.MAX_ITERATIONS, salt: k.salt, kcv: k.kcv })).ok, true);
  // Forged DQE1 header with 4,294,967,295 iterations: rejected before PBKDF2 starts.
  const forged = s.payload.slice(); new DataView(forged.buffer).setUint32(4, 0xffffffff);
  const id = (await C.sha256(forged)).slice(0, 8);
  const t0 = Date.now();
  await assert.rejects(C.openPayload(forged, id, PASS), (e) => e.code === "BAD_FORMAT" && /iteration/.test(e.message));
  assert.ok(Date.now() - t0 < 200);
  // A forged key frame with too many iterations is not used for the early check.
  const r = new DQ.ReceiverSession();
  r.addText(s.textForSeed(3));
  assert.equal(r.addText(P.buildKeyFrame({ fileId: s.fileId, iterations: 0xffffffff, salt: k.salt, kcv: k.kcv })), "rejected:key-limits");
  assert.equal((await r.checkPassphrase(PASS)).result, "pending");
});

test("sender refuses iteration counts outside what receivers accept", async () => {
  for (const n of [50000, C.MAX_ITERATIONS + 1]) await assert.rejects(C.buildPayload({ name: "a", data, passphrase: PASS, iterations: n }), (e) => e.code === "BAD_ITERATIONS");
});

test("recorded pre-cycle-4 encrypted streams still open", async () => {
  const enc = LEGACY.streams.filter((x) => x.passphrase);
  assert.ok(enc.length > 0);
  for (const st of enc) {
    const r = new DQ.ReceiverSession();
    for (const t of st.texts) { r.addText(t); if (r.done) break; }
    assert.ok(r.done, "v" + st.version);
    const out = await r.open(st.passphrase);
    assert.equal(out.encrypted, true);
  }
});

// ---- strength estimate ----
const S = (p) => C.estimateStrength(p);
test("strength: empty, and the result shape", () => {
  assert.deepEqual({ bits: S("").bits, label: S("").label }, { bits: 0, label: "none" });
  const r = DQ.strength.estimate("Summer2024!");
  assert.ok(Array.isArray(r.parts) && r.parts.length > 0);
  assert.ok(Array.isArray(r.warnings));
  assert.equal(typeof r.bits, "number");
});

test("strength: common passwords and their decorated variants are weak", () => {
  for (const p of ["password", "Password1", "P@ssw0rd", "password123", "qwerty", "123456789", "letmein!", "iloveyou", "dragon2020", "Welcome1!", "drowssap"]) {
    const r = S(p); assert.ok(r.bits < 30, `${p}: ${r.bits}`); assert.equal(r.label, "weak", p);
  }
});

test("strength: keyboard runs, sequences, repeats and years are cheap", () => {
  for (const p of ["qwertyuiop1234567890", "aaaaaaaaaaaaaaaa", "abcabcabcabcabc", "abcdefghijklmnop", "zxcvbnm,./", "19871987", "ZYXWVUTSRQ"]) {
    const r = S(p); assert.ok(r.bits < 30, `${p}: ${r.bits}`);
  }
  assert.ok(DQ.strength.estimate("qwertyuiop1234567890").warnings.some((w) => /sequence|keyboard|common/i.test(w)));
  assert.ok(DQ.strength.estimate("zxcvbnm,./").warnings.some((w) => /keyboard/i.test(w)));
  assert.ok(DQ.strength.estimate("abcabcabcabcabc").warnings.some((w) => /repeat/i.test(w)));
});

test("strength: human patterns the old meter overrated", () => {
  // The pre-cycle-4 meter called these good or strong.
  assert.ok(S("Summer2024!").bits < 40, String(S("Summer2024!").bits));
  assert.ok(S("Tr0ub4dor&3").bits < 45, String(S("Tr0ub4dor&3").bits));
  assert.ok(S("Football1234567").bits < 40, String(S("Football1234567").bits));
});

test("strength: random words count about 13 bits each, random characters count fully", () => {
  const five = S("orbit lantern quiet mosaic thunder").bits, six = S("orbit lantern quiet mosaic thunder velvet").bits;
  assert.ok(five >= 60 && five <= 75, String(five));
  assert.ok(six >= 72 && six <= 88, String(six));
  assert.ok(S("correct horse battery staple orbit").bits >= 44);
  assert.ok(S("k7#Qm2!vR9@xL4$z").bits >= 90, String(S("k7#Qm2!vR9@xL4$z").bits));
  assert.equal(S("k7#Qm2!vR9@xL4$z").label, "strong");
  assert.ok(S("x9fq2mzr").bits >= 35 && S("x9fq2mzr").bits <= 45, String(S("x9fq2mzr").bits));
});

test("strength: adding random material never lowers the estimate; labels follow the thresholds", () => {
  let p = "", prev = 0;
  for (const ch of "Gk4!pQz8#Lm2vR") { p += ch; const b = S(p).bits; assert.ok(b >= prev, `${p}: ${b} < ${prev}`); prev = b; }
  for (const p of ["password", "orbit lantern", "orbit lantern quiet mosaic", "orbit lantern quiet mosaic thunder velvet canyon"]) {
    const { bits, label } = S(p);
    assert.equal(label, bits < 40 ? "weak" : bits < 60 ? "fair" : bits < 80 ? "good" : "strong", p);
  }
});

test("strength: handles long and unusual input quickly", () => {
  const t0 = Date.now();
  S("a".repeat(5000)); S("ünïcødé пароль 密码 🙂🙂🙂"); S("x".repeat(256) + "y".repeat(256));
  assert.ok(Date.now() - t0 < 500, String(Date.now() - t0));
  assert.ok(S("пароль корова молоко сад").bits > 0);
});

test("strength: random strings are not badly underrated (deterministic sample)", () => {
  let x = 12345; const next = () => (x = (Math.imul(x, 1103515245) + 12345) >>> 0) >>> 8;
  const F = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789!@#$%^&*()-_=+[]{};:,.<>/?";
  const bits = [];
  for (let i = 0; i < 200; i++) { let p = ""; for (let j = 0; j < 16; j++) p += F[next() % F.length]; bits.push(S(p).bits); }
  bits.sort((a, b) => a - b);
  assert.ok(bits[100] >= 90, "median " + bits[100]);
  assert.ok(bits[0] >= 50, "min " + bits[0]);
});

// ---- cycle-3 streams (fixed 600,000 iterations, key-check frames on and off), recorded from commit 8949cb7 ----
const CYCLE3 = JSON.parse(fs.readFileSync(new URL("../fixtures/cycle3_streams.json", import.meta.url), "utf8"));
test("recorded cycle-3 streams at 600,000 iterations open, with and without key-check frames", async () => {
  assert.equal(CYCLE3.streams.length, 2);
  for (const st of CYCLE3.streams) {
    assert.equal(st.iterations, 600000);
    const r = new DQ.ReceiverSession();
    for (const t of st.texts) { r.addText(t); if (r.done) break; }
    assert.ok(r.done, "keyCheck=" + st.keyCheck);
    const out = await r.open(st.passphrase);
    assert.equal(new TextDecoder().decode(out.data), CYCLE3.fileText);
    await assert.rejects(new DQ.ReceiverSession().open("x"));   // nothing received: refuses, does not hang
  }
});
test("cycle-3 key-check frame: early check says ok for the right passphrase and wrong for a wrong one", async () => {
  const st = CYCLE3.streams.find((x) => x.keyCheck);
  const r = new DQ.ReceiverSession();
  for (const t of st.texts) { r.addText(t); if (r.keyCheck) break; }
  assert.ok(r.keyCheck && r.keyCheck.iterations === 600000);
  assert.equal((await r.checkPassphrase("wrong horse")).result, "wrong");
  assert.equal((await r.checkPassphrase(st.passphrase)).result, "ok");
  for (const t of st.texts) { r.addText(t); if (r.done) break; }
  const out = await r.open(st.passphrase);
  assert.equal(out.usedCachedKey, true);
  assert.equal(new TextDecoder().decode(out.data), CYCLE3.fileText);
});
