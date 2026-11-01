// Receiver-side PBKDF2 time estimate (cycle 7): a short probe on this device scaled to the stream's count.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const DQ = require("../lib/load.cjs").load();
const C = DQ.container;
const device = (nsPerIter) => { const calls = []; const measure = async (n) => { calls.push(n); return (n * nsPerIter) / 1e6; }; measure.calls = calls; return measure; };

test("estimate scales the probe linearly and flags slow devices at 3 s", async () => {
  const fast = await C.estimateDerive(8000000, { measure: device(120) });     // laptop-like: 0.12 µs per iteration
  assert.ok(fast.measured && Math.abs(fast.ms - 960) < 1, JSON.stringify(fast));
  assert.equal(fast.slow, false);
  const slow = await C.estimateDerive(8000000, { measure: device(2000) });    // slow phone-like: 2 µs per iteration
  assert.ok(Math.abs(slow.ms - 16000) < 1); assert.equal(slow.slow, true);
  const edge = await C.estimateDerive(600000, { measure: device(5000) });
  assert.ok(Math.abs(edge.ms - 3000) < 1); assert.equal(edge.slow, true);
  assert.equal(C.SLOW_DERIVE_MS, 3000);
});

test("estimate probes stay small: at most 800,000 iterations in total", async () => {
  for (const ns of [10, 120, 2000, 50000]) {
    const m = device(ns); await C.estimateDerive(8000000, { measure: m });
    const total = m.calls.reduce((a, b) => a + b, 0);
    assert.ok(total <= 800000, `ns ${ns}: ${total}`);
  }
});

test("estimate fails safe: no measurement means no warning", async () => {
  const r = await C.estimateDerive(8000000, { measure: async () => { throw new Error("no crypto"); } });
  assert.deepEqual([r.measured, r.slow, r.ms], [false, false, null]);
  const z = await C.estimateDerive(0, { measure: device(100) });
  assert.equal(z.slow, false);
});

test("estimate is close to a real derive on this machine (within a factor of 2)", async () => {
  const est = await C.estimateDerive(2000000);
  const t0 = performance.now(); await C.measurePbkdf2(2000000); const real = performance.now() - t0;
  assert.ok(est.measured && est.ms > real / 2 && est.ms < real * 2, `estimate ${est.ms.toFixed(0)} ms, real ${real.toFixed(0)} ms`);
});
