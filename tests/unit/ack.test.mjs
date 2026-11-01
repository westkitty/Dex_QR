// Reverse-channel "Done" confirmation frame (cycle 9): encode, parse, classify, and a seeded fuzz of the parser.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const DQ = require("../lib/load.cjs").load();
const A = DQ.ack, B45 = DQ.base45;
const id = Uint8Array.from([0x1a, 0x2b, 0x3c, 0x4d, 0x5e, 0x6f, 0x70, 0x81]);
const hexId = DQ.packet.hex(id);
const frameOf = (bytes) => { const b = Uint8Array.from(bytes); const x = new Uint8Array(b.length + 4); x.set(b); new DataView(x.buffer).setUint32(b.length, DQ.crc32(x, 0, b.length)); return "DA" + B45.encode(x); };

test("Done frame round trip: 14 bytes, DA prefix, QR alphanumeric only, fits a version 1 or 2 code", () => {
  const t = A.build(id);
  assert.ok(t.startsWith("DA"));
  assert.match(t, /^[0-9A-Z $%*+\-./:]+$/);
  assert.equal(B45.decode(t.slice(2)).length, A.LEN);
  const r = A.parse(t);
  assert.equal(r.ok, true); assert.equal(r.version, 1); assert.equal(r.kind, A.KIND_DONE); assert.equal(r.fileIdHex, hexId);
  assert.deepEqual(Array.from(r.fileId), Array.from(id));
  assert.ok(DQ.render.makeQr(t, "M").version <= 2);
  assert.equal(A.build(r.fileId), t, "deterministic");
});

test("the Done frame carries the transfer ID only: same for the same transfer, different for another", async () => {
  const s = await DQ.SenderSession.create({ name: "a.txt", data: new TextEncoder().encode("hello ".repeat(300)), blockSize: 200, compress: false, startSeed: 3 });
  const r = A.parse(A.build(s.fileId));
  assert.equal(r.fileIdHex, DQ.packet.hex(s.fileId));
  const s2 = await DQ.SenderSession.create({ name: "a.txt", data: new TextEncoder().encode("hellO ".repeat(300)), blockSize: 200, compress: false, startSeed: 3 });
  assert.notEqual(A.build(s2.fileId), A.build(s.fileId));
});

test("rejections: foreign, damaged (crc), newer version, wrong length, unknown kind, short, bad base45, too long", () => {
  const t = A.build(id);
  assert.equal(A.parse("HELLO").reason, "foreign");
  assert.equal(A.parse(null).reason, "foreign");
  assert.equal(A.parse(12).reason, "foreign");
  assert.equal(A.parse("da" + t.slice(2)).reason, "foreign");
  const b = B45.decode(t.slice(2)); b[5] ^= 1;
  assert.equal(A.parse("DA" + B45.encode(b)).reason, "crc");
  const v2 = A.parse(frameOf([2, 1, ...id]));
  assert.equal(v2.ok, false); assert.equal(v2.reason, "version"); assert.equal(v2.version, 2);
  assert.equal(A.parse(frameOf([2, 1, ...id, 9, 9, 9, 9, 9])).reason, "version", "a longer future frame is still recognised as a newer version");
  assert.equal(A.parse(frameOf([1, 1, ...id, 0])).reason, "length");
  assert.equal(A.parse(frameOf([1, 7, ...id])).reason, "kind");
  assert.equal(A.parse(frameOf([1])).reason, "short");
  assert.equal(A.parse("DA").reason, "short");
  assert.equal(A.parse("DA" + "~~~").reason, "base45");
  assert.equal(A.parse("DA" + "0".repeat(600)).reason, "toolong");
});

test("classify: this transfer, another transfer, newer, stream frames, damaged and foreign codes", async () => {
  assert.equal(A.classify(A.build(id), hexId).verdict, "done");
  const other = Uint8Array.from(id); other[7] ^= 0xff;
  assert.equal(A.classify(A.build(other), hexId).verdict, "other");
  assert.equal(A.classify(frameOf([3, 1, ...id]), hexId).verdict, "newer");
  assert.equal(A.classify(frameOf([1, 2, ...id]), hexId).verdict, "newer");
  const s = await DQ.SenderSession.create({ name: "a.txt", data: new TextEncoder().encode("x".repeat(900)), blockSize: 200, compress: false, passphrase: "orbit lantern quiet mosaic thunder", iterations: 100000 });
  assert.equal(A.classify(s.textForSeed(1), hexId).verdict, "stream");
  assert.equal(A.classify(s.keyFrameText, hexId).verdict, "stream");
  const b = B45.decode(A.build(id).slice(2)); b[13] ^= 0x10;
  assert.equal(A.classify("DA" + B45.encode(b), hexId).verdict, "bad");
  assert.equal(A.classify("https://example.org", hexId).verdict, "foreign");
});

test("stream parsers ignore the Done frame and the Done parser ignores stream frames (no cross-talk)", async () => {
  const t = A.build(id);
  assert.equal(DQ.packet.parseText(t).ok, false);
  assert.equal(DQ.packet.parseKeyFrame(t).ok, false);
  const r = new DQ.ReceiverSession(); r.addText(t);
  assert.equal(r.meta, null); assert.equal(r.stats.accepted, 0);
  const s = await DQ.SenderSession.create({ name: "a.txt", data: new TextEncoder().encode("y".repeat(900)), blockSize: 200, compress: false });
  for (let i = 0; i < 20; i++) assert.equal(A.parse(s.nextText()).ok, false);
});

test("fuzz: 60,000 seeded random and mutated texts never throw, never accept a wrong frame, reasons are known", () => {
  let st = 20261101;
  const rnd = () => { st = (st + 0x6d2b79f5) | 0; let x = Math.imul(st ^ (st >>> 15), 1 | st); x = (x + Math.imul(x ^ (x >>> 7), 61 | x)) ^ x; return ((x ^ (x >>> 14)) >>> 0) / 4294967296; };
  const ri = (n) => Math.floor(rnd() * n);
  const CH = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ $%*+-./:";
  const good = A.build(id), goodBytes = B45.decode(good.slice(2));
  let accepted = 0, wrongAccepted = 0;
  const t0 = Date.now();
  for (let i = 0; i < 60000; i++) {
    let t;
    switch (i % 6) {
      case 0: t = "DA" + Array.from({ length: ri(40) }, () => CH[ri(45)]).join(""); break;                    // random Base45 text
      case 1: { const b = Uint8Array.from(goodBytes); const n = 1 + ri(4); for (let k = 0; k < n; k++) b[ri(b.length)] ^= 1 << ri(8); t = "DA" + B45.encode(b); break; } // bit flips
      case 2: t = good.slice(0, ri(good.length + 1)); break;                                                     // truncation
      case 3: { const b = new Uint8Array(ri(64)); for (let k = 0; k < b.length; k++) b[k] = ri(256); t = "DA" + B45.encode(b); break; } // random bytes
      case 4: { const b = new Uint8Array(1 + ri(30)); for (let k = 0; k < b.length; k++) b[k] = ri(256); t = frameOf(b); break; }        // CRC-valid random envelopes
      default: { const a = good.split(""); a[2 + ri(a.length - 2)] = String.fromCharCode(ri(128)); t = a.join(""); }              // any character
    }
    let r;
    assert.doesNotThrow(() => { r = A.parse(t); }, t);
    assert.equal(typeof r.ok, "boolean");
    if (r.ok) {
      accepted++;
      const b = B45.decode(t.slice(2));
      // Anything accepted is exactly a well-formed v1 Done frame for the fileId it reports.
      if (!(b.length === 14 && b[0] === 1 && b[1] === 1 && A.build(r.fileId) === t)) wrongAccepted++;
    } else assert.ok(A.REASONS.includes(r.reason), r.reason);
    assert.doesNotThrow(() => A.classify(t, hexId));
  }
  assert.equal(wrongAccepted, 0);
  assert.ok(accepted > 0, "the CRC-valid case generator produces some valid frames");
  assert.ok(Date.now() - t0 < 20000);
});
