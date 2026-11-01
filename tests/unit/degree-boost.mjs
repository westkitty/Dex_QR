// Protocol v1 vs v2 (degree boost) at codec level: packets needed / K with the ML decoder, plus
// decode time. Deterministic seeds. Writes results/degree_boost.json.
// Usage: node tests/unit/degree-boost.mjs [trials]
import { createRequire } from "node:module";
import fs from "node:fs";
const require = createRequire(import.meta.url);
const DQ = require("../lib/load.cjs").load();
const L = DQ.lt, T = 400, trials = Number(process.argv[2] || 300);
const Ks = [12, 26, 50, 100, 257, 500, 1281, 2560];
function run(v, K, t) {
  const fk = L.mix32(t * 7919 + K), ex = L.extraDegreeFor(v, K);
  const enc = new L.LTEncoder(new Uint8Array(K * T).map((_, i) => (i * 131 + t) & 255), T, fk, { extra: ex });
  const dec = new L.LTDecoder(K, T, fk, { extra: ex });
  let s = L.mix32(t + 13), n = 0; const t0 = performance.now();
  while (!dec.done) { dec.addPacket(s, enc.encode(s)); s = (s + 1) >>> 0; n++; }
  const ms = performance.now() - t0;
  const out = dec.result(K * T); for (let i = 0; i < out.length; i += 97) if (out[i] !== ((i * 131 + t) & 255)) throw new Error("corrupt");
  return [n / K, ms];
}
const q = (a, p) => a[Math.min(a.length - 1, Math.floor(p * a.length))];
const rows = [];
for (const K of Ks) for (const v of [1, 2]) {
  const n = K > 1000 ? Math.min(trials, 60) : trials, r = [], ms = [];
  for (let t = 0; t < n; t++) { const [a, b] = run(v, K, t); r.push(a); ms.push(b); }
  r.sort((a, b) => a - b);
  const row = { K, version: v, extra: L.extraDegreeFor(v, K), trials: n, mean: r.reduce((s, x) => s + x, 0) / n, p95: q(r, 0.95), p99: q(r, 0.99), max: r[n - 1], decodeMsMean: ms.reduce((s, x) => s + x, 0) / n };
  rows.push(row);
  console.log(`K=${K} v${v} extra=${row.extra} mean=${row.mean.toFixed(4)} p95=${row.p95.toFixed(4)} max=${row.max.toFixed(4)} decode=${row.decodeMsMean.toFixed(1)}ms`);
}
fs.mkdirSync("results", { recursive: true });
fs.writeFileSync("results/degree_boost.json", JSON.stringify({ trials, blockBytes: T, node: process.version, rows }, null, 1));
