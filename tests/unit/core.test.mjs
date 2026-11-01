import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { createHash, randomBytes } from "node:crypto";
const require = createRequire(import.meta.url);
const DQ = require("../lib/load.cjs").load();

test("base45 matches RFC 9285 examples", () => {
  const enc = (s) => DQ.base45.encode(new TextEncoder().encode(s));
  assert.equal(enc("AB"), "BB8");
  assert.equal(enc("Hello!!"), "%69 VD92EX0");
  assert.equal(enc("base-45"), "UJCLQE7W581");
  assert.equal(new TextDecoder().decode(DQ.base45.decode("QED8WEX0")), "ietf!");
  assert.throws(() => DQ.base45.decode("GGW"));
  assert.throws(() => DQ.base45.decode("ab"));
});

test("base45 round-trips random bytes; never ends in a space", () => {
  for (let n = 0; n < 300; n++) {
    const b = randomBytes(n);
    const s = DQ.base45.encode(b);
    assert.deepEqual(Buffer.from(DQ.base45.decode(s)), b);
    if (s.length) assert.notEqual(s[s.length - 1], " ");
  }
});

test("crc32 known vector", () => {
  assert.equal(DQ.crc32(new TextEncoder().encode("123456789")), 0xcbf43926);
});

test("robust soliton cdf is a distribution", () => {
  for (const K of [1, 2, 10, 100, 1000]) {
    const cdf = DQ.lt.robustSolitonCdf(K);
    assert.equal(cdf[K], 1);
    for (let d = 1; d <= K; d++) assert.ok(cdf[d] >= cdf[d - 1]);
  }
});

test("neighbour sets are deterministic, distinct, in range", () => {
  for (let seed = 0; seed < 2000; seed++) {
    const a = DQ.lt.neighbours(500, seed, 0xdeadbeef);
    const b = DQ.lt.neighbours(500, seed, 0xdeadbeef);
    assert.deepEqual(a, b);
    assert.equal(new Set(a).size, a.length);
    for (const x of a) assert.ok(x < 500);
  }
});

test("packet framing round-trip and CRC rejection", () => {
  const meta = { encrypted: true, fileId: new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]), K: 3, blockSize: 10, length: 25 };
  const block = new Uint8Array(10).map((_, i) => i * 7);
  const txt = DQ.packet.packetToText(DQ.packet.buildPacket(meta, 0xfffffffe, block));
  assert.equal(txt.length, DQ.packet.textLength(10));
  assert.match(txt, /^[0-9A-Z $%*+\-./:]+$/);
  const p = DQ.packet.parseText(txt);
  assert.ok(p.ok);
  assert.equal(p.seed, 0xfffffffe);
  assert.equal(p.meta.K, 3); assert.equal(p.meta.encrypted, true);
  assert.deepEqual(Array.from(p.block), Array.from(block));
  const bytes = DQ.base45.decode(txt.slice(2)); bytes[30] ^= 1;
  assert.equal(DQ.packet.parseBytes(bytes).reason, "crc");
  assert.equal(DQ.packet.parseText("hello").reason, "foreign");
});

async function transfer(size, blockSize, { passphrase, dropRate = 0, start = 0, rng = Math.random } = {}) {
  const data = randomBytes(size);
  const s = await DQ.SenderSession.create({ name: "t.bin", mime: "application/octet-stream", data, blockSize, passphrase, iterations: passphrase ? 100000 : undefined, startSeed: start });
  const r = new DQ.ReceiverSession();
  let sent = 0;
  while (!r.done) { const t = s.nextText(); sent++; if (rng() >= dropRate) r.addText(t); if (sent > s.K * 20) throw new Error("no convergence"); }
  return { data, s, r, sent };
}

test("end-to-end without QR: plain, byte-identical", async () => {
  for (const size of [0, 1, 999, 10000, 100000]) {
    const { data, r } = await transfer(size, 400, { dropRate: 0.3, start: 12345 });
    const out = await r.open();
    assert.equal(createHash("sha256").update(out.data).digest("hex"), createHash("sha256").update(data).digest("hex"));
    assert.equal(out.name, "t.bin");
  }
});

test("encrypted transfer: right passphrase opens, wrong passphrase fails, none asks", async () => {
  const { data, r } = await transfer(5000, 300, { passphrase: "correct horse battery staple" });
  assert.equal(r.meta.encrypted, true);
  await assert.rejects(r.open(), (e) => e.code === "NEED_PASSPHRASE");
  await assert.rejects(r.open("wrong"), (e) => e.code === "WRONG_PASSPHRASE");
  const out = await r.open("correct horse battery staple");
  assert.deepEqual(Buffer.from(out.data), data);
  assert.equal(out.encrypted, true);
});

test("checksum mismatch is reported when reconstructed data is wrong", async () => {
  const data = randomBytes(3000);
  const s = await DQ.SenderSession.create({ name: "a", data, blockSize: 200 });
  // Forge packets: same header/fileId, CRC valid, but content of a different file.
  const evil = await DQ.SenderSession.create({ name: "a", data: randomBytes(3000), blockSize: 200 });
  const r = new DQ.ReceiverSession();
  let seed = 0;
  while (!r.done) {
    const block = evil.encoder.encode(seed);
    r.addText(DQ.packet.packetToText(DQ.packet.buildPacket(s.meta, seed, block)));
    seed++;
  }
  await assert.rejects(r.open(), (e) => e.code === "CHECKSUM_MISMATCH");
});

test("receiver ignores duplicates and packets from another file", async () => {
  const a = await DQ.SenderSession.create({ name: "a", data: randomBytes(2000), blockSize: 100 });
  const b = await DQ.SenderSession.create({ name: "b", data: randomBytes(2000), blockSize: 100 });
  const r = new DQ.ReceiverSession();
  const t0 = a.textForSeed(5);
  r.addText(t0); r.addText(t0);
  assert.equal(r.addText(b.textForSeed(1)), "other-file");
  assert.equal(r.stats.duplicates, 1); assert.equal(r.stats.otherFile, 1);
});

test("passphrase strength hint", () => {
  assert.equal(DQ.container.estimateStrength("password1").label, "weak");
  assert.ok(DQ.container.estimateStrength("correct horse battery staple orbit").bits >= 44);
});

test("protocol v1 golden vectors (pins PRNG, degree and neighbour selection)", () => {
  // If these change, the wire protocol changed: bump the version byte.
  assert.deepEqual(Array.from(DQ.lt.neighbours(100, 7, 0x12345678)), GOLDEN_A);
  assert.deepEqual(Array.from(DQ.lt.neighbours(5000, 123456, 0xdeadbeef)), GOLDEN_B);
});

test("both decoder modes (ml and peel+GE) recover the exact payload", () => {
  for (const [K, mode] of [[300, "ml"], [300, "peel"], [3500, undefined]]) {
    const T = 32, payload = randomBytes(K * T - 5);
    const enc = new DQ.lt.LTEncoder(payload, T, 99);
    const dec = new DQ.lt.LTDecoder(enc.K, T, 99, mode ? { mode } : {});
    let s = 1000;
    while (!dec.done) { dec.addPacket(s, enc.encode(s)); s++; if (s > 1000 + K * 3) throw new Error("no convergence " + mode); }
    assert.deepEqual(Buffer.from(dec.result(payload.length)), payload);
    if (!mode) assert.equal(dec.mode, "peel");
  }
});

test("jsQR blur fallback helper keeps image dimensions", () => {
  const rgba = new Uint8ClampedArray(4 * 6 * 5).fill(200);
  assert.equal(DQ.scan.boxBlurGrayToRGBA(rgba, 6, 5).length, rgba.length);
});

const GOLDEN_A = [37,80];
const GOLDEN_B = [1289,2294,2518,3700,4426];
