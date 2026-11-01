// Early wrong-passphrase detection with a key check value (KCV) sent in separate "DK" key-check frames (cycle 3).
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
const data = te.encode("id,v\n" + Array.from({ length: 400 }, (_, i) => `${i},${(i * 7919) % 1000}`).join("\n"));

async function sender(opts = {}) {
  return DQ.SenderSession.create({ name: "k.csv", mime: "text/csv", data, blockSize: 200, passphrase: PASS, iterations: 100000, startSeed: 5, ...opts });
}

test("KCV is 2 bytes, deterministic for (passphrase, salt, iterations), and domain-separated from the AES key", async () => {
  const salt = new Uint8Array(16).fill(3);
  const a = await C.deriveKeys(PASS, salt, 100000), b = await C.deriveKeys(PASS, salt, 100000), c = await C.deriveKeys(PASS + "!", salt, 100000);
  assert.equal(a.kcv.length, C.KCV_LEN); assert.equal(C.KCV_LEN, 2);
  assert.deepEqual(a.kcv, b.kcv);
  assert.notDeepEqual(a.kcv, c.kcv);
  // The KCV is not a prefix of the AES key bytes (HKDF with its own label, not a truncation of the key).
  const raw = new Uint8Array(await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt, iterations: 100000 }, await crypto.subtle.importKey("raw", te.encode(PASS), "PBKDF2", false, ["deriveBits"]), 256));
  assert.notDeepEqual(Array.from(raw.slice(0, 2)), Array.from(a.kcv));
  assert.equal(a.key.extractable, false);
});

test("key frame round trip; CRC, prefix, version and iteration limits are enforced", async () => {
  const s = await sender();
  assert.ok(s.keyFrameText.startsWith("DK"));
  const k = P.parseKeyFrame(s.keyFrameText);
  assert.equal(k.ok, true);
  assert.equal(k.fileIdHex, P.hex(s.fileId));
  assert.equal(k.iterations, 100000);
  assert.deepEqual(k.salt, s.payload.slice(8, 24));
  assert.equal(k.kcv.length, 2);
  const bytes = DQ.base45.decode(s.keyFrameText.slice(2));
  assert.equal(bytes.length, P.KEY_FRAME_LEN);
  const bad = bytes.slice(); bad[31] ^= 1;
  assert.equal(P.parseKeyFrame("DK" + DQ.base45.encode(bad)).reason, "crc");
  assert.equal(P.parseKeyFrame("DQ" + DQ.base45.encode(bytes)).reason, "foreign");
  assert.equal(P.parseKeyFrame("DK" + DQ.base45.encode(bytes.slice(0, 20))).reason, "length");
  const v9 = bytes.slice(); v9[0] = 9; new DataView(v9.buffer).setUint32(32, DQ.crc32(v9, 0, 32));
  assert.equal(P.parseKeyFrame("DK" + DQ.base45.encode(v9)).reason, "version");
  const it = P.buildKeyFrame({ fileId: s.fileId, iterations: 50, salt: k.salt, kcv: k.kcv });
  assert.equal(P.parseKeyFrame(it).reason, "limits");
});

test("sender interleaves one key frame every KEY_EVERY frames (frame 0 first), only when encrypted", async () => {
  const s = await sender();
  const frames = []; for (let i = 0; i < 3 * DQ.SenderSession.KEY_EVERY; i++) frames.push(s.nextFrame());
  const keyIdx = frames.map((t, i) => (t.startsWith("DK") ? i : -1)).filter((i) => i >= 0);
  assert.deepEqual(keyIdx, [0, 32, 64]);
  assert.equal(DQ.SenderSession.KEY_EVERY, 32);
  const plain = await sender({ passphrase: undefined });
  assert.equal(plain.keyFrameText, null);
  for (let i = 0; i < 40; i++) assert.ok(plain.nextFrame().startsWith("DQ"));
  const off = await sender({ keyCheck: false });
  assert.equal(off.keyFrameText, null);
  for (let i = 0; i < 40; i++) assert.ok(off.nextFrame().startsWith("DQ"));
});

test("receiver: wrong passphrase detected from the first key frame, before the file is decoded; right one accepted", async () => {
  const s = await sender();
  const r = new DQ.ReceiverSession();
  for (let i = 0; i < 3; i++) r.addText(s.nextFrame());
  assert.equal(r.done, false);
  assert.ok(r.keyCheck, "key check held");
  const t0 = performance.now();
  const wrong = await r.checkPassphrase(PASS.toUpperCase());
  const ms = performance.now() - t0;
  assert.equal(wrong.result, "wrong");
  assert.equal(r.done, false);
  assert.ok(ms < 5000, `check took ${ms} ms`);
  const right = await r.checkPassphrase(PASS);
  assert.equal(right.result, "ok");
  // progress was not lost: keep feeding and finish
  let g = 0; while (!r.done && g++ < 10 * s.K + 100) r.addText(s.nextFrame());
  assert.ok(r.done);
  assert.equal(r.stats.keyFrames >= 1, true);
  const out = await r.open(PASS);
  assert.deepEqual(Buffer.from(out.data), Buffer.from(data));
  assert.equal(out.usedCachedKey, true, "open reuses the key derived by the early check");
});

test("receiver without a key frame yet answers 'pending'; plain transfers answer 'not-encrypted'", async () => {
  const s = await sender();
  const r = new DQ.ReceiverSession();
  r.addText(s.textForSeed(9));          // a data packet only
  assert.equal((await r.checkPassphrase(PASS)).result, "pending");
  const p = await sender({ passphrase: undefined });
  const r2 = new DQ.ReceiverSession(); r2.addText(p.nextFrame());
  assert.equal((await r2.checkPassphrase(PASS)).result, "not-encrypted");
});

test("key frames for another transfer are ignored; conflicting key frames for one transfer disable the early check", async () => {
  const s = await sender(), other = await sender({ startSeed: 99 });
  const r = new DQ.ReceiverSession();
  r.addText(s.textForSeed(1));
  assert.equal(r.addText(other.keyFrameText), "key-check");
  assert.equal(r.keyCheck, null);
  r.addText(s.keyFrameText);
  assert.ok(r.keyCheck);
  const k = P.parseKeyFrame(s.keyFrameText);
  const forged = P.buildKeyFrame({ fileId: s.fileId, iterations: 100000, salt: k.salt, kcv: new Uint8Array([k.kcv[0] ^ 0xff, k.kcv[1]]) });
  r.addText(forged);
  assert.equal(r.keyCheck, null);
  assert.equal(r.keyCheckConflict, true);
  assert.equal((await r.checkPassphrase(PASS)).result, "conflict");
});

test("a key frame whose salt does not match the payload is not trusted at open (AES-GCM stays authoritative)", async () => {
  const s = await sender();
  const r = new DQ.ReceiverSession();
  const fakeSalt = new Uint8Array(16).fill(7);
  const fk = await C.deriveKeys(PASS, fakeSalt, 100000);
  r.addText(P.buildKeyFrame({ fileId: s.fileId, iterations: 100000, salt: fakeSalt, kcv: fk.kcv }));
  r.addText(s.textForSeed(0));
  assert.equal((await r.checkPassphrase(PASS)).result, "ok");
  let g = 0; while (!r.done && g++ < 10 * s.K + 100) r.addText(s.textForSeed(g));
  const out = await r.open(PASS);
  assert.equal(out.usedCachedKey, false);
  assert.deepEqual(Buffer.from(out.data), Buffer.from(data));
  assert.equal(r.keyCheckMismatch, true);
});

test("old receiver logic ignores key frames as foreign; legacy encrypted streams (no key frames) still decode", async () => {
  const s = await sender();
  assert.equal(P.parseText(s.keyFrameText).reason, "foreign");   // what a pre-cycle-3 receiver does with them
  for (const st of LEGACY.streams.filter((x) => x.encrypted)) {
    const r = new DQ.ReceiverSession();
    for (const t of st.texts) { if (r.done) break; r.addText(t); }
    assert.equal((await r.checkPassphrase(st.passphrase)).result, "pending");
    const out = await r.open(st.passphrase);
    assert.equal(new TextDecoder().decode(out.data), LEGACY.fileText);
  }
});

test("the encrypted payload format is unchanged: a DQE1 payload built now opens with the pre-cycle-3 key derivation", async () => {
  const s = await sender({ compress: false });
  const salt = s.payload.slice(8, 24), iv = s.payload.slice(24, 36);
  const base = await crypto.subtle.importKey("raw", te.encode(PASS), "PBKDF2", false, ["deriveKey"]);
  const key = await crypto.subtle.deriveKey({ name: "PBKDF2", hash: "SHA-256", salt, iterations: 100000 }, base, { name: "AES-GCM", length: 256 }, false, ["decrypt"]);
  const inner = new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv, additionalData: s.payload.subarray(0, 24) }, key, s.payload.subarray(36)));
  assert.equal(String.fromCharCode(...inner.slice(0, 4)), "DQF1");
});
