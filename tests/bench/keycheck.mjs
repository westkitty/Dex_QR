// Cycle 3 measurement: how long until a receiver can tell the user "wrong passphrase", before (only after the
// whole file is decoded: AES-GCM tag) and after (first key-check frame), and what the key frames cost.
// Simulated channel: the receiver starts at a random frame (0..255) of an endless stream and misses each frame
// independently with probability `drop`. 8 fps. PBKDF2 time is measured in Node (600,000 iterations).
import { createRequire } from "node:module";
import fs from "node:fs";
const require = createRequire(import.meta.url);
const DQ = require("../lib/load.cjs").load();
const { testFile } = require("../lib/testfile.cjs");
const TRIALS = Number(process.argv[2] || 100), FPS = 8, BS = 400, PASS = "orbit lantern quiet mosaic thunder";
let seed = 12345; const rnd = () => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 2 ** 32);

const t0 = performance.now(); const runs = 5;
for (let i = 0; i < runs; i++) await DQ.container.deriveKeys(PASS + i, new Uint8Array(16), 600000);
const pbkdf2Ms = (performance.now() - t0) / runs;

const rows = [];
for (const size of [20000, 100000, 500000]) {
  const data = testFile(size, "kc-bench-" + size);                 // incompressible, so K is the same both ways
  const s = await DQ.SenderSession.create({ name: "b.bin", data, blockSize: BS, passphrase: PASS, iterations: 600000, startSeed: 1 });
  const frames = [];
  const N = Math.ceil(s.K * 3) + 600;
  for (let i = 0; i < N; i++) frames.push(s.nextFrame());
  // "before": the same stream without key frames (what a pre-cycle-3 sender shows)
  const plain = []; for (let i = 0; i < N; i++) plain.push(s.textForSeed(1 + i));
  for (const drop of [0, 0.3, 0.5]) {
    const before = [], afterDetect = [], afterDone = [];
    for (let t = 0; t < TRIALS; t++) {
      const start = Math.floor(rnd() * 256);
      // before: frames until decoded
      { const r = new DQ.ReceiverSession(); let n = 0;
        for (let i = start; i < N && !r.done; i++) { n++; if (rnd() >= drop) r.addText(plain[i]); }
        before.push(n); }
      // after: frames until a key frame is held (plus at least one data packet so the transfer is known), and until decoded
      { const r = new DQ.ReceiverSession(); let n = 0, det = 0;
        for (let i = start; i < N && !r.done; i++) { n++; if (rnd() >= drop) r.addText(frames[i]); if (!det && r.keyCheck) det = n; }
        afterDetect.push(det || n); afterDone.push(n); }
    }
    const st = (a) => { const b = a.slice().sort((x, y) => x - y); return { mean: +(a.reduce((x, y) => x + y, 0) / a.length).toFixed(1), p50: b[Math.floor(b.length / 2)], p95: b[Math.floor(b.length * 0.95)], max: b[b.length - 1] }; };
    const B = st(before), A = st(afterDetect), D = st(afterDone);
    const row = { size, K: s.K, drop, trials: TRIALS,
      beforeFramesToWrongPass: B, afterFramesToWrongPass: A,
      beforeSecondsMean: +(B.mean / FPS + pbkdf2Ms / 1000).toFixed(2), afterSecondsMean: +(A.mean / FPS + pbkdf2Ms / 1000).toFixed(2),
      beforeSecondsP95: +(B.p95 / FPS + pbkdf2Ms / 1000).toFixed(2), afterSecondsP95: +(A.p95 / FPS + pbkdf2Ms / 1000).toFixed(2),
      framesToFileBefore: B.mean, framesToFileAfter: D.mean, fileTimeOverheadPct: +(100 * (D.mean / B.mean - 1)).toFixed(1) };
    rows.push(row);
    console.log(`${size} B K=${s.K} drop ${drop * 100}%: wrong passphrase known after ${B.mean} frames (${row.beforeSecondsMean} s) -> ${A.mean} frames (${row.afterSecondsMean} s); p95 ${row.beforeSecondsP95} s -> ${row.afterSecondsP95} s; frames to file ${B.mean} -> ${D.mean} (${row.fileTimeOverheadPct >= 0 ? "+" : ""}${row.fileTimeOverheadPct}%)`);
  }
}
const kf = DQ.packet.KEY_FRAME_LEN, kfText = 2 + Math.floor(kf / 2) * 3 + (kf % 2 ? 2 : 0);
const out = { when: new Date().toISOString(), node: process.version, fps: FPS, blockSize: BS, pbkdf2Ms600k: +pbkdf2Ms.toFixed(0), keyEvery: DQ.SenderSession.KEY_EVERY,
  bytes: { dataPacketHeaderAdded: 0, payloadBytesAdded: 0, keyFrameBytes: kf, keyFrameTextChars: kfText, keyFrameQrVersionAtM: DQ.render.makeQr("DK" + "0".repeat(kfText - 2), "M").version, dataQrVersionAtM400: DQ.render.versionFor(BS, "M") }, rows };
fs.mkdirSync(new URL("../../results/", import.meta.url), { recursive: true });
fs.writeFileSync(new URL("../../results/keycheck.json", import.meta.url), JSON.stringify(out, null, 1));
console.log(`PBKDF2 600k in Node: ${out.pbkdf2Ms600k} ms; key frame ${kf} bytes = ${kfText} chars (QR v${out.bytes.keyFrameQrVersionAtM} at M) vs data QR v${out.bytes.dataQrVersionAtM400}; data packets and payload: +0 bytes`);
