// Regression tests for what the cycle-5 fuzzer (tests/fuzz/fuzz.mjs) found. Each was written before its fix
// and failed against commit 2f907a9.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const DQ = require("../lib/load.cjs").load();
const C = DQ.container;
const te = new TextEncoder();
const idOf = async (p) => (await C.sha256(p)).slice(0, 8);
const cat = (...parts) => { const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0)); let o = 0; for (const p of parts) { out.set(p, o); o += p.length; } return out; };

// Finding 1: a DQF1 container whose name or MIME length points past the end was accepted, and the "file" then
// contained the container header itself (subarray/slice with NaN or out-of-range offsets).
test("truncated DQF1 containers are BAD_FORMAT, not a file made of header bytes", async () => {
  const good = C.buildInner("one", "text/plain", te.encode("hello"));
  const cases = [
    cat(te.encode("DQF1"), [0xff, 0xff], te.encode("abc")),          // name length 65535, 3 bytes present
    cat(te.encode("DQF1"), [0x00, 0x03], te.encode("one")),          // no MIME length byte at all
    cat(te.encode("DQF1"), [0x00, 0x03], te.encode("one"), [200], te.encode("text")),   // MIME length past the end
    te.encode("DQF1"), cat(te.encode("DQF1"), [0x00]),               // header itself cut short
    good.slice(0, 6), good.slice(0, 9),
  ];
  for (const p of cases) {
    await assert.rejects(C.openPayload(p, await idOf(p)), (e) => e.code === "BAD_FORMAT", "bytes " + Array.from(p).join(","));
  }
  // Exactly-full containers still open, including an empty name, empty MIME and empty data.
  const edge = cat(te.encode("DQF1"), [0, 0], [0]);
  const out = await C.openPayload(edge, await idOf(edge));
  assert.deepEqual([out.name, out.mime, out.data.length], ["", "", 0]);
  const o2 = await C.openPayload(good, await idOf(good));
  assert.deepEqual([o2.name, o2.mime, new TextDecoder().decode(o2.data)], ["one", "text/plain", "hello"]);
});

test("a truncated container inside DQZ1 is BAD_FORMAT", async () => {
  const inner = cat(te.encode("DQF1"), [0x00, 0x09], te.encode("abc"));   // name length 9, only 3 bytes
  const z = new Uint8Array(await new Response(new Blob([inner]).stream().pipeThrough(new CompressionStream("deflate-raw"))).arrayBuffer());
  const p = cat(te.encode("DQZ1"), [1, 0, 0, 0, inner.length], z);
  await assert.rejects(C.openPayload(p, await idOf(p)), (e) => e.code === "BAD_FORMAT");
});

// Finding 2: a DQE1 payload shorter than its 36-byte header + 16-byte GCM tag either threw a RangeError (no Dex_QR
// error code; 4–7 bytes read the iteration count past the end) or was reported as a wrong passphrase.
test("truncated DQE1 payloads are BAD_FORMAT before any key derivation, never a RangeError", async () => {
  const hdr = new Uint8Array(36); hdr.set(te.encode("DQE1")); new DataView(hdr.buffer).setUint32(4, 100000);
  for (const n of [4, 5, 7, 8, 20, 35, 36, 40, 51]) {
    const p = hdr.slice(0, Math.min(n, 36)).length === n ? hdr.slice(0, n) : cat(hdr, new Uint8Array(n - 36));
    const t0 = Date.now();
    await assert.rejects(C.openPayload(p, await idOf(p), "pw"), (e) => e.code === "BAD_FORMAT", "length " + n);
    assert.ok(Date.now() - t0 < 50, "rejected before PBKDF2 at length " + n);
  }
  assert.throws(() => C.encryptedParams(te.encode("DQE1")), (e) => e.code === "BAD_FORMAT");
});

// Finding 3: the robust-soliton CDF cache kept one Float64Array per distinct (K, c, delta) forever; a long-lived
// receiver page that sees many transfers (or hostile frames with ever-new K up to 2^18) grew without bound
// (300 transfers retained about 310 MB in the fuzzer).
test("the soliton CDF cache is bounded and keeps recent entries", () => {
  const max = DQ.lt.CDF_CACHE_MAX;
  assert.ok(Number.isInteger(max) && max >= 4 && max <= 64);
  const hot = DQ.lt.robustSolitonCdf(40);
  for (let K = 5000; K < 5000 + 3 * max; K++) { DQ.lt.robustSolitonCdf(K, 0.03, 0.5); DQ.lt.robustSolitonCdf(40); }
  assert.ok(DQ.lt.cdfCacheSize() <= max, "cache size " + DQ.lt.cdfCacheSize());
  assert.equal(DQ.lt.robustSolitonCdf(40), hot, "an entry in constant use stays cached");
  // Evicted entries are recomputed identically.
  const a = DQ.lt.robustSolitonCdf(5000, 0.03, 0.5);
  for (let K = 9000; K < 9000 + 2 * max; K++) DQ.lt.robustSolitonCdf(K, 0.03, 0.5);
  assert.deepEqual(Array.from(DQ.lt.robustSolitonCdf(5000, 0.03, 0.5)), Array.from(a));
});

test("a receiver that sees many large transfers keeps its memory bounded", () => {
  const r = new DQ.ReceiverSession();
  for (let i = 0; i < 3 * DQ.lt.CDF_CACHE_MAX; i++) {
    const K = 4000 + i * 97, T = 1;
    const meta = { version: 2, encrypted: false, fileId: new Uint8Array(8).fill(i & 255), K, blockSize: T, length: K };
    assert.equal(r.addText(DQ.packet.packetToText(DQ.packet.buildPacket(meta, i, new Uint8Array(T)))), "ok");
    r.reset();
  }
  assert.ok(DQ.lt.cdfCacheSize() <= DQ.lt.CDF_CACHE_MAX);
});
