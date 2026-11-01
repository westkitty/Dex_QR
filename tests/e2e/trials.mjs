// Drop-rate trials over cached real-decoder output.
// Each rendered frame was decoded ONCE by a real QR decoder (zbar or zxing-cpp); each trial then
// replays those decoded strings with a random start frame and i.i.d. random frame drops, feeds them
// to the receiver's ReceiverSession (the same JS as receiver.html), and checks SHA-256 of the result.
// Usage: node tests/e2e/trials.mjs --dir work/f10k --decoder zbar --trials 100 --drops 0.1,0.3,0.5 [--seed 1]
import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
const require = createRequire(import.meta.url);
const DQ = require("../lib/load.cjs").load();
const args = Object.fromEntries(process.argv.slice(2).reduce((a, x, i, arr) => (x.startsWith("--") ? a.concat([[x.slice(2), arr[i + 1]]]) : a), []));
const dir = args.dir, decoder = args.decoder || "zbar", trials = Number(args.trials || 100);
const drops = (args.drops || "0.1,0.3,0.5").split(",").map(Number);
const man = JSON.parse(fs.readFileSync(path.join(dir, "manifest.json")));
const dec = JSON.parse(fs.readFileSync(path.join(dir, `decoded_${decoder}.json`)));
const frames = dec.frames.map((f) => f.texts);
const M = frames.length;
let rs = Number(args.seed || 1) >>> 0;
const rand = () => { rs = (rs + 0x6d2b79f5) | 0; let t = Math.imul(rs ^ (rs >>> 15), 1 | rs); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
const startRange = Math.max(1, Math.min(M - 1, man.K)); // random start anywhere in the first "pass" of K frames
const results = [];
for (const p of drops) {
  for (let t = 0; t < trials; t++) {
    const start = Math.floor(rand() * startRange);
    const r = new DQ.ReceiverSession();
    let shown = 0, received = 0, ok = false, sha = null, err = null;
    for (let i = start; i < M; i++) {
      shown++;
      if (rand() < p) continue;        // frame dropped
      received++;
      for (const txt of frames[i]) r.addText(txt);
      if (r.done) break;
    }
    if (r.done) {
      try { const out = await r.open(); sha = crypto.createHash("sha256").update(out.data).digest("hex"); ok = sha === man.sha256; if (!ok) err = "hash-mismatch"; }
      catch (e) { err = e.code || e.message; }
    } else err = "ran-out-of-frames";
    results.push({ size: man.size, drop: p, trial: t, start, framesShown: shown, framesReceived: received, packetsUsed: r.decoder ? r.decoder.received : 0, K: man.K, overhead: r.decoder ? r.decoder.received / man.K : null, ok, err });
  }
}
const summary = drops.map((p) => {
  const rows = results.filter((x) => x.drop === p);
  const okRows = rows.filter((x) => x.ok);
  const ov = okRows.map((x) => x.overhead).sort((a, b) => a - b);
  const sh = okRows.map((x) => x.framesShown / man.K).sort((a, b) => a - b);
  const q = (a, f) => a.length ? a[Math.min(a.length - 1, Math.floor(f * a.length))] : null;
  const mean = (a) => a.length ? a.reduce((s, x) => s + x, 0) / a.length : null;
  return { size: man.size, K: man.K, blockSize: man.blockSize, ecl: man.ecl, qrVersion: man.qrVersion, decoder, drop: p, trials: rows.length, success: okRows.length,
    overheadMean: mean(ov), overheadP50: q(ov, 0.5), overheadP95: q(ov, 0.95), overheadMax: ov[ov.length - 1] ?? null,
    framesShownPerKMean: mean(sh), framesShownPerKMax: sh[sh.length - 1] ?? null, failures: rows.filter((x) => !x.ok).map((x) => x.err) };
});
const frameDecodeRate = frames.filter((f) => f.length).length / M;
const outFile = args.out || path.join(dir, `trials_${decoder}.json`);
fs.writeFileSync(outFile, JSON.stringify({ manifest: man, decoder, decoderSummary: dec.summary, frameDecodeRate, summary, results }, null, 1));
for (const s of summary) console.log(JSON.stringify({ ...s, failures: s.failures.length }));
