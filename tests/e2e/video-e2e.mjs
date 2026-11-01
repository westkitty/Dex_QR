// Truly end-to-end runs: selected sender frames (random start + i.i.d. drops) -> H.264 video (ffmpeg)
// -> frames extracted back out of the video (ffmpeg) -> real QR decoder (zbar) -> receiver JS -> SHA-256.
// Nothing is cached between the video and the decoder in this path.
// Usage: node tests/e2e/video-e2e.mjs --dir work/drop_10240 --trials 3 --drops 0.1,0.3,0.5 [--crf 23] [--fps 10]
import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
const require = createRequire(import.meta.url);
const DQ = require("../lib/load.cjs").load();
const args = Object.fromEntries(process.argv.slice(2).reduce((a, x, i, arr) => (x.startsWith("--") ? a.concat([[x.slice(2), arr[i + 1]]]) : a), []));
const dir = path.resolve(args.dir), trials = Number(args.trials || 3), crf = String(args.crf || 23), fps = String(args.fps || 10);
const drops = (args.drops || "0.1,0.3,0.5").split(",").map(Number);
const PY = process.env.PY || "python3";
const man = JSON.parse(fs.readFileSync(path.join(dir, "manifest.json")));
let rs = Number(args.seed || 99) >>> 0;
const rand = () => { rs = (rs + 0x6d2b79f5) | 0; let t = Math.imul(rs ^ (rs >>> 15), 1 | rs); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
function run(cmd, a) { const r = spawnSync(cmd, a, { encoding: "utf8", maxBuffer: 1 << 28 }); if (r.status !== 0) throw new Error(cmd + " failed: " + r.stderr.slice(-2000)); return r.stdout; }
const out = [];
for (const p of drops) for (let t = 0; t < trials; t++) {
  const work = path.join(dir, `video_${Date.now().toString(36)}_p${p}_t${t}`);
  fs.mkdirSync(path.join(work, "x"), { recursive: true });
  const start = Math.floor(rand() * man.K);
  const budget = Math.ceil((man.K * 1.6 + 10) / (1 - p));            // frames the sender shows in this run
  const sel = [];
  for (let i = start; i < Math.min(man.frames, start + budget); i++) if (rand() >= p) sel.push(i);
  fs.writeFileSync(path.join(work, "list.txt"), sel.map((i) => `file '${path.join(dir, `frame_${String(i).padStart(5, "0")}.png`)}'\nduration ${1 / Number(fps)}`).join("\n") + "\n");
  const video = path.join(work, "stream.mp4");
  const t0 = Date.now();
  run("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-f", "concat", "-safe", "0", "-i", path.join(work, "list.txt"), "-vf", `fps=${fps},format=yuv420p`, "-c:v", "libx264", "-crf", crf, "-preset", "veryfast", video]);
  run("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-i", video, path.join(work, "x", "frame_%05d.png")]);
  const decOut = path.join(work, "decoded_zbar.json");
  run(PY, ["tests/e2e/decode_frames.py", path.join(work, "x"), "--decoder", "zbar", "--out", decOut]);
  const dec = JSON.parse(fs.readFileSync(decOut));
  const r = new DQ.ReceiverSession();
  let used = 0;
  for (const f of dec.frames) { used++; for (const txt of f.texts) r.addText(txt); if (r.done) break; }
  let ok = false, sha = null, err = null;
  if (r.done) { try { const o = await r.open(); sha = crypto.createHash("sha256").update(o.data).digest("hex"); ok = sha === man.sha256; if (!ok) err = "hash-mismatch"; } catch (e) { err = e.code || e.message; } } else err = "not-decoded";
  const row = { size: man.size, K: man.K, drop: p, trial: t, start, videoFrames: dec.frames.length, framesDecodedByZbar: dec.summary.decoded, videoBytes: fs.statSync(video).size, framesUsed: used, packetsUsed: r.decoder?.received ?? 0, overhead: (r.decoder?.received ?? 0) / man.K, ok, sha256: sha, err, seconds: (Date.now() - t0) / 1000 };
  out.push(row); console.log(JSON.stringify(row));
}
const file = args.out || path.join(dir, "video_e2e.json");
fs.writeFileSync(file, JSON.stringify({ manifest: man, crf, fps, rows: out }, null, 1));
