// Defensive-handling tests added in the 2026-11-01 full improvement pass: hostile or corrupt
// packets, block-size boundaries, interleaved transfers and switching between them.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { createHash, randomBytes } from "node:crypto";
const require = createRequire(import.meta.url);
const DQ = require("../lib/load.cjs").load();
const sha = (b) => createHash("sha256").update(b).digest("hex");

function craft({ K, T, F, version = 2 }) {
  // A CRC-valid packet with arbitrary header fields (what garbage or a hostile QR could carry).
  const meta = { version, encrypted: false, fileId: new Uint8Array(8).fill(9), K, blockSize: T, length: F };
  return DQ.packet.packetToText(DQ.packet.buildPacket(meta, 1, new Uint8Array(T)));
}

test("oversized headers are rejected before any decoder allocation", () => {
  assert.equal(DQ.packet.parseText(craft({ K: 16777215, T: 1, F: 16777215 })).reason, "limits");
  { const F = DQ.packet.MAX_LENGTH + 1, T = 65535; assert.equal(DQ.packet.parseText(craft({ K: Math.ceil(F / T), T, F })).reason, "limits"); }
  assert.equal(DQ.packet.parseText(craft({ K: DQ.packet.MAX_K + 1, T: 1, F: DQ.packet.MAX_K + 1 })).reason, "limits");
  // The largest stream the sender UI can produce (32 MiB file, 200 B blocks) still parses.
  const F = 32 * 1024 * 1024 + 1300, T = 200;
  assert.ok(DQ.packet.parseText(craft({ K: Math.ceil(F / T), T, F })).ok);
  const r = new DQ.ReceiverSession();
  const t0 = Date.now();
  r.addText(craft({ K: 16777215, T: 1, F: 16777215 }));
  assert.equal(r.meta, null);
  assert.equal(r.stats.reasons.limits, 1);
  assert.ok(Date.now() - t0 < 200, "rejection must be cheap");
});

test("sender refuses streams a receiver would reject", async () => {
  // compress:false: 300 kB of zeros would otherwise deflate to a few hundred bytes and fit (since cycle 2).
  await assert.rejects(DQ.SenderSession.create({ name: "big", data: new Uint8Array(300000), blockSize: 1, compress: false }), /Too large/);
});

test("rejection reasons are counted per kind (version, crc, length, base45, foreign)", async () => {
  const s = await DQ.SenderSession.create({ name: "a", data: randomBytes(3000), blockSize: 200 });
  const r = new DQ.ReceiverSession();
  const good = s.textForSeed(3);
  const bytes = DQ.base45.decode(good.slice(2));
  const v9 = bytes.slice(); v9[0] = 9;
  const crc = bytes.slice(); crc[40] ^= 0xff;
  r.addText("DQ" + DQ.base45.encode(v9));
  r.addText("DQ" + DQ.base45.encode(crc));
  r.addText("DQ" + DQ.base45.encode(bytes.slice(0, bytes.length - 3)));
  r.addText("DQ:::");
  r.addText("https://example.com/");
  r.addText(good.slice(0, good.length - 2));    // truncated text
  assert.deepEqual(r.stats.reasons, { version: 1, crc: 1, length: 2, base45: 1 });
  assert.equal(r.stats.foreign, 1);
  assert.equal(r.meta, null);
  assert.equal(r.addText(good), "ok");
});

test("block-size boundaries: payload exactly K*T, K*T-1, K*T+1, and K = 1", async () => {
  const T = 64;
  for (const target of [T, T - 1, T + 1, 12 * T, 12 * T - 1, 12 * T + 1, 40 * T, 40 * T + 1]) {
    // Container overhead for name "b.bin" and the default MIME: 4 + 2 + 5 + 1 + 24 bytes.
    const overhead = DQ.container.buildInner("b.bin", "", new Uint8Array(0)).length;
    const size = Math.max(0, target - overhead);
    const data = randomBytes(size);
    const s = await DQ.SenderSession.create({ name: "b.bin", data, blockSize: T, startSeed: 1000 + target });
    assert.equal(s.meta.length, overhead + size);
    assert.equal(s.K, Math.max(1, Math.ceil(s.meta.length / T)));
    const r = new DQ.ReceiverSession();
    let n = 0;
    while (!r.done) { r.addText(s.nextText()); if (++n > s.K * 20 + 20) throw new Error("no convergence at " + target); }
    assert.equal(sha((await r.open()).data), sha(data), "payload " + target);
  }
});

test("out-of-order, duplicated and interleaved packets still give the right file", async () => {
  const data = randomBytes(20000);
  const a = await DQ.SenderSession.create({ name: "a", data, blockSize: 300, startSeed: 5 });
  const b = await DQ.SenderSession.create({ name: "b", data: randomBytes(20000), blockSize: 300, startSeed: 5 });
  const seeds = Array.from({ length: a.K * 3 }, (_, i) => i).sort((x, y) => DQ.lt.mix32(x) - DQ.lt.mix32(y));
  const r = new DQ.ReceiverSession();
  for (const sd of seeds) {
    const t = a.textForSeed(sd);
    r.addText(t); r.addText(t);                 // every packet twice
    r.addText(b.textForSeed(sd));               // another transfer interleaved
    if (r.done) break;
  }
  assert.ok(r.done);
  assert.equal(r.otherTransferWaiting, false, "the locked transfer kept arriving, so no switch is offered");
  assert.equal(sha((await r.open()).data), sha(data));
});

test("a stale lock can be switched to the transfer now on screen without losing its packets", async () => {
  const old = await DQ.SenderSession.create({ name: "old", data: randomBytes(5000), blockSize: 200 });
  const dataNew = randomBytes(9000);
  const now = await DQ.SenderSession.create({ name: "new.bin", data: dataNew, blockSize: 200, startSeed: 77 });
  const r = new DQ.ReceiverSession();
  r.addText(old.textForSeed(0));                // locked onto the old transfer
  let n = 0;
  while (!r.otherTransferWaiting) { r.addText(now.nextText()); if (++n > 100) throw new Error("switch never offered"); }
  assert.equal(n, DQ.ReceiverSession.SWITCH_AFTER);
  r.addText(old.textForSeed(1));                // one packet of the locked transfer resets the streak
  assert.equal(r.otherTransferWaiting, false);
  r.stats.frames = 42;
  assert.ok(r.switchToPending());
  assert.equal(r.meta.fileIdHex, DQ.packet.hex(now.fileId));
  assert.equal(r.decoder.received, n, "buffered packets were replayed");
  assert.equal(r.stats.frames, 42, "frame count survives the switch");
  while (!r.done) r.addText(now.nextText());
  assert.equal(sha((await r.open()).data), sha(dataNew));
});

test("other-transfer buffer is bounded", async () => {
  const a = await DQ.SenderSession.create({ name: "a", data: randomBytes(500), blockSize: 100 });
  const b = await DQ.SenderSession.create({ name: "b", data: randomBytes(500), blockSize: 100 });
  const r = new DQ.ReceiverSession();
  r.addText(a.textForSeed(0));
  const max = DQ.ReceiverSession.PENDING_MAX;
  for (let i = 0; i < max + 50; i++) r.addText(b.textForSeed(i));
  r.addText(b.textForSeed(0));                  // duplicate text is not stored twice
  assert.equal(r.pending.texts.length, max);
});
