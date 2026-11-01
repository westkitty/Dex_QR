// Cycle 4 measurements: PBKDF2 calibration in Node (time, chosen count), derive times, old vs new strength estimate.
// Needs the cycle-3 sources: mkdir -p work/base-8949cb7 && git archive 8949cb7 src | tar -x -C work/base-8949cb7
import { createRequire } from "node:module"; import fs from "node:fs"; import vm from "node:vm";
const require = createRequire(import.meta.url);
const DQ = require("../lib/load.cjs").load(); const C = DQ.container;
const t = async (f) => { const t0 = performance.now(); const r = await f(); return [performance.now() - t0, r]; };
const node = {};
for (let i = 0; i < 3; i++) { const [ms, r] = await t(() => C.calibrateIterations()); (node.cal ||= []).push({ ms: +ms.toFixed(0), iterations: r.iterations, estMs: +r.estimatedMs.toFixed(0), probe: r.probeIterations }); }
for (const n of [600000, node.cal[0].iterations]) { const ms = []; for (let i = 0; i < 3; i++) ms.push(+(await C.measurePbkdf2(n)).toFixed(0)); node["derive_" + n] = ms; }
// old vs new strength
const ctx = vm.createContext({ TextEncoder, TextDecoder, crypto, console, Uint8Array, Math }); ctx.globalThis = ctx;
for (const rel of ["src/base45.js","src/crc32.js","src/lt.js","src/packet.js","src/container.js"]) vm.runInContext(fs.readFileSync("work/base-8949cb7/"+rel,"utf8"), ctx);
const old = ctx.DexQR.container.estimateStrength;
const S = {};
for (const p of ["password","P@ssw0rd","Password1","Summer2024!","Tr0ub4dor&3","Football1234567","qwertyuiop1234567890","abcabcabcabcabc","x9fq2mzr","orbit lantern quiet mosaic thunder","k7#Qm2!vR9@xL4$z"]) { const o = old(p), n = C.estimateStrength(p); S[p] = `${o.bits} ${o.label} -> ${n.bits} ${n.label}`; }
const t0 = performance.now(); for (let i = 0; i < 200; i++) C.estimateStrength("orbit lantern quiet mosaic thunder velvet canyon"); const per = (performance.now() - t0) / 200;
const out = { node, strength: S, strengthMsPer7Words: +per.toFixed(2) }; fs.mkdirSync("results", { recursive: true }); fs.writeFileSync("results/kdf_measure.json", JSON.stringify({ when: new Date().toISOString(), ...out }, null, 1)); console.log(JSON.stringify(out, null, 1));
