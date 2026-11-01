// Compression benchmark (cycle 2): payload size, blocks and frames a receiver needs for realistic files at the
// shipped default settings (400 B per QR, EC M, 8 fps), with the Dex_QR code found at DQ_ROOT (default: this
// checkout). Run once against the pre-compression commit and once against the current tree to get before/after:
//   git worktree add --detach work/base-79094f4 79094f4
//   DQ_ROOT=work/base-79094f4 BENCH_OUT=compression_before.json node tests/bench/compression.mjs
//   BENCH_OUT=compression_after.json node tests/bench/compression.mjs
// Frames are simulated (packet texts fed straight to ReceiverSession, random start seed, i.i.d. frame loss);
// no camera is involved. Input files are frozen at git commit 79094f4 so both runs use identical bytes.
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..", "..");
const SRC = path.resolve(process.env.DQ_ROOT || ROOT);
for (const rel of ["src/base45.js", "src/crc32.js", "src/lt.js", "src/packet.js", "src/container.js", "src/session.js"])
  vm.runInThisContext(fs.readFileSync(path.join(SRC, rel), "utf8"), { filename: rel });
const DQ = globalThis.DexQR;
const { testFile } = require("../lib/testfile.cjs");
const T = 400, FPS = 8, TRIALS = Number(process.env.BENCH_TRIALS || 100), REF = "79094f4";
const git = (p) => execFileSync("git", ["show", `${REF}:${p}`], { cwd: ROOT, maxBuffer: 1 << 26 });

function csvLog() {   // deterministic sensor log, the kind of CSV people move between devices
  let s = "timestamp,station,temp_c,humidity_pct,pressure_hpa,status\n", x = 12345;
  const rnd = () => ((x = (Math.imul(x, 1103515245) + 12345) >>> 0) / 2 ** 32);
  for (let i = 0; i < 1500; i++) {
    const t = new Date(Date.UTC(2026, 9, 1) + i * 60000).toISOString();
    s += `${t},ST-${(i % 5) + 1},${(15 + 8 * Math.sin(i / 200) + rnd()).toFixed(2)},${(55 + 20 * rnd()).toFixed(1)},${(1013 + 5 * Math.cos(i / 300) + rnd()).toFixed(1)},${rnd() < 0.97 ? "ok" : "check"}\n`;
  }
  return Buffer.from(s);
}
const JPEG = "/usr/local/go/src/image/testdata/video-001.jpeg";   // a real camera JPEG (Go test data, BSD licence)
const files = [
  { name: "sensor-log.csv", mime: "text/csv", kind: "CSV (generated, deterministic)", data: csvLog() },
  { name: "trials_102400_zxing.json", mime: "application/json", kind: `JSON (${REF}:results/trials_102400_zxing.json)`, data: git("results/trials_102400_zxing.json") },
  { name: "sender.html", mime: "text/html", kind: `HTML + inlined JS (${REF}:sender.html)`, data: git("sender.html") },
  { name: "receiver.app.js", mime: "text/javascript", kind: `JS source (${REF}:src/pages/receiver.app.js)`, data: git("src/pages/receiver.app.js") },
  fs.existsSync(JPEG) ? { name: "video-001.jpeg", mime: "image/jpeg", kind: "JPEG photo (Go testdata video-001.jpeg)", data: fs.readFileSync(JPEG) } : null,
  { name: "random.bin", mime: "application/octet-stream", kind: "pseudo-random 100 KiB (tests/lib/testfile.cjs)", data: testFile(102400, "compress-bench") },
].filter(Boolean);

let rs = 987654321;
const rnd = () => ((rs = (Math.imul(rs ^ (rs >>> 15), 0x2c1b3c6d) + 0x9e3779b9) >>> 0) / 2 ** 32);
function framesNeeded(s, loss) {
  const r = new DQ.ReceiverSession();
  let seed = (rnd() * 2 ** 32) >>> 0, shown = 0;
  while (!r.done) { shown++; const t = s.textForSeed(seed); seed = (seed + 1) >>> 0; if (rnd() >= loss) r.addText(t); if (shown > 20 * s.K + 200) throw new Error("no convergence"); }
  return shown;
}
const stat = (a) => { a = a.slice().sort((x, y) => x - y); return { mean: +(a.reduce((p, q) => p + q, 0) / a.length).toFixed(1), p95: a[Math.floor(0.95 * (a.length - 1))], max: a[a.length - 1] }; };
const rows = [];
for (const f of files) for (const enc of [false, true]) {
  const t0 = performance.now();
  const s = await DQ.SenderSession.create({ name: f.name, mime: f.mime, data: new Uint8Array(f.data), blockSize: T, passphrase: enc ? "bench passphrase words here" : undefined, iterations: enc ? 100000 : undefined, startSeed: 1 });
  const prepMs = performance.now() - t0;
  // round-trip check with the same code
  const r = new DQ.ReceiverSession(); let seed = 5; while (!r.done) r.addText(s.textForSeed(seed++));
  const t1 = performance.now(); const out = await r.open(enc ? "bench passphrase words here" : undefined); const openMs = performance.now() - t1;
  if (Buffer.compare(Buffer.from(out.data), f.data) !== 0) throw new Error("round trip failed for " + f.name);
  const row = { file: f.name, kind: f.kind, sha256: createHash("sha256").update(f.data).digest("hex").slice(0, 16), fileBytes: f.data.length, encrypted: enc,
    compression: s.compression ? (s.compression.used ? s.compression.algorithm : "skipped:" + s.compression.reason) : "n/a (pre-compression code)",
    payloadBytes: s.payload.length, K: s.K, prepareMs: +prepMs.toFixed(1), openMs: +openMs.toFixed(1) };
  if (!enc) for (const loss of [0, 0.3]) {
    const fr = []; for (let i = 0; i < TRIALS; i++) fr.push(framesNeeded(s, loss));
    const st = stat(fr); row[`frames_loss${loss * 100}`] = st; row[`seconds_loss${loss * 100}_at${FPS}fps`] = +(st.mean / FPS).toFixed(1);
  }
  rows.push(row); console.log(JSON.stringify(row));
}
const outName = process.env.BENCH_OUT || "compression.json";
fs.writeFileSync(path.join(ROOT, "results", outName), JSON.stringify({ when: new Date().toISOString(), codeRoot: path.relative(ROOT, SRC) || ".", settings: { blockSize: T, ecl: "M", fps: FPS, trials: TRIALS, losses: [0, 0.3] }, note: "Simulated reception (no camera). Frames = QR frames shown until the receiver finished; seconds = mean frames / fps.", rows }, null, 1));
