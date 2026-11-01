// Parameter sweep for the robust soliton (c, delta) and the decoder (peeling only vs peeling + GE finisher).
// Codec level only (no QR). Measures packets needed / K. Writes results/lt_sweep.json.
// Usage: node tests/unit/lt-sweep.mjs [trials]
import { createRequire } from "node:module";
import fs from "node:fs";
const require = createRequire(import.meta.url);
const DQ = require("../lib/load.cjs").load();
const trials = Number(process.argv[2] || 200);
const Ks = (process.argv[3] || "10,20,50,100,200,500,1000").split(",").map(Number);
const params = [[0.01, 0.5], [0.03, 0.5], [0.05, 0.5], [0.1, 0.5], [0.03, 0.05], [0.1, 0.05], [0.2, 0.05]];
const T = 16;
function run(K, c, delta, mode, seedBase) {
  const fileKey = DQ.lt.mix32(seedBase);
  const payload = new Uint8Array(K * T); for (let i = 0; i < payload.length; i++) payload[i] = (i * 31 + seedBase) & 255;
  const enc = new DQ.lt.LTEncoder(payload, T, fileKey, { c, delta });
  const dec = new DQ.lt.LTDecoder(K, T, fileKey, { c, delta, mode: mode === "ml" ? "ml" : "peel", useGE: mode === "peel+GE", geMaxUnknown: 400 });
  let seed = DQ.lt.mix32(seedBase + 7);
  let n = 0;
  while (!dec.done) { dec.addPacket(seed, enc.encode(seed)); seed = (seed + 1) >>> 0; n++; if (n > 50 * K + 100) return Infinity; }
  const out = dec.result(payload.length);
  for (let i = 0; i < out.length; i++) if (out[i] !== payload[i]) throw new Error("corrupt decode");
  return n;
}
function stats(a) { a = a.slice().sort((x, y) => x - y); const q = (p) => a[Math.min(a.length - 1, Math.floor(p * a.length))]; return { mean: a.reduce((s, x) => s + x, 0) / a.length, p50: q(0.5), p95: q(0.95), p99: q(0.99), max: a[a.length - 1] }; }
const rows = [];
for (const K of Ks) for (const [c, delta] of params) for (const mode of ["peel", "peel+GE", "ml"]) {
  const ratios = [];
  for (let t = 0; t < trials; t++) ratios.push(run(K, c, delta, mode, t * 1000003 + K) / K);
  const s = stats(ratios);
  rows.push({ K, c, delta, decoder: mode, trials, ...s });
  console.log(`K=${K} c=${c} d=${delta} ${mode.padEnd(7)} mean=${s.mean.toFixed(3)} p95=${s.p95.toFixed(3)} p99=${s.p99.toFixed(3)} max=${s.max.toFixed(3)}`);
}
fs.mkdirSync("results", { recursive: true });
fs.writeFileSync("results/lt_sweep.json", JSON.stringify({ trials, blockBytes: T, rows }, null, 1));
