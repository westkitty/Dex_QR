// Throughput benchmark across QR densities (block size) and EC levels.
// For each config: render N frames (QR side ~600 px), decode clean and synthetically degraded frames with
// zbar and zxing-cpp (single process, so ms/frame is a per-core decode cost) and with the receiver page's
// jsQR inside headless Chrome. Goodput = fps * blockSize * frameSuccess / overhead.
import { createRequire } from "node:module";
import { goodput } from "./goodput.mjs";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { chromium } from "playwright-core";
const require = createRequire(import.meta.url);
const DQ = require("../lib/load.cjs").load();
const { encodeGray } = require("../lib/png.cjs");
const { testFile } = require("../lib/testfile.cjs");
const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..", "..");
const PY = process.env.PY || "python3";
const N = Number(process.env.BENCH_FRAMES || 120);
const SIDE = 600;
const blockSizes = (process.env.BENCH_BS || "200,400,600,800,1000,1400").split(",").map(Number);
const ecls = (process.env.BENCH_ECL || "L,M,Q").split(",");
const OVERHEAD = 1.02;   // conservative LT reception overhead for >= 100 KB files (measured mean 1.003-1.016, see RESULTS.md)
const work = path.join(ROOT, "work", "bench_" + Date.now().toString(36));
const rows = [];
const browser = await chromium.launch({ executablePath: process.env.CHROME || "/usr/bin/google-chrome", headless: true });
const page = await browser.newPage();
await page.goto("file://" + path.join(ROOT, "receiver.html"));
await page.evaluate(() => window.__dexqrReceiver.decodeImageData({ data: new Uint8ClampedArray(4 * 16), width: 8, height: 8 }, "zxing")); // warm up WASM
function decode(dir, decoder, glob) {
  const out = path.join(dir, `dec_${decoder}_${glob.includes("jpg") ? "deg" : "clean"}.json`);
  const r = spawnSync(PY, ["tests/e2e/decode_frames.py", dir, "--decoder", decoder, "--glob", glob, "--out", out, "--jobs", "1"], { cwd: ROOT, encoding: "utf8" });
  if (r.status !== 0) throw new Error(r.stderr);
  return JSON.parse(fs.readFileSync(out));
}
async function jsqr(dir, glob, texts) {
  const files = fs.readdirSync(dir).filter((f) => f.endsWith(glob)).sort().slice(0, Number(process.env.BENCH_JS_FRAMES || 30));
  let ok = 0, ms = 0, ok2 = 0, ms2 = 0;
  for (const f of files) {
    const i = Number(f.match(/(\d+)/)[1]);
    const b64 = fs.readFileSync(path.join(dir, f)).toString("base64");
    const r = await page.evaluate(async ({ b64, mime }) => {
      const bin = atob(b64); const u8 = new Uint8Array(bin.length); for (let k = 0; k < bin.length; k++) u8[k] = bin.charCodeAt(k);
      const bmp = await createImageBitmap(new Blob([u8], { type: mime }));
      const c = new OffscreenCanvas(bmp.width, bmp.height); const g = c.getContext("2d"); g.drawImage(bmp, 0, 0);
      const img = g.getImageData(0, 0, bmp.width, bmp.height);
      const dec = window.__dexqrReceiver.decodeImageData;
      let t = performance.now(); const a = await dec(img, "jsqr"); const dt = performance.now() - t;
      t = performance.now(); const b = await dec(img, "zxing"); const dt2 = performance.now() - t;
      return { text: a[0] || null, dt, text2: b[0] || null, dt2 };
    }, { b64, mime: f.endsWith("jpg") ? "image/jpeg" : "image/png" });
    if (!r) return { error: "fetch(data:) blocked" };
    ms += r.dt; if (r.text === texts[i]) ok++;
    ms2 += r.dt2; if (r.text2 === texts[i]) ok2++;
  }
  return { frames: files.length, ok, rate: ok / files.length, msPerFrame: ms / files.length, rate2: ok2 / files.length, msPerFrame2: ms2 / files.length };
}
for (const ecl of ecls) for (const bs of blockSizes) {
  const version = DQ.render.versionFor(bs, ecl);
  if (!version) { rows.push({ bs, ecl, version: null, note: "does not fit in QR version 40" }); continue; }
  const dir = path.join(work, `${ecl}_${bs}`); fs.mkdirSync(dir, { recursive: true });
  const s = await DQ.SenderSession.create({ name: "b.bin", data: testFile(bs * 300, "bench"), blockSize: bs });
  const texts = []; let qrMs = 0, modules = 0;
  for (let i = 0; i < N; i++) {
    const t = s.nextText(); texts.push(t);
    const t0 = performance.now(); const qr = DQ.render.makeQr(t, ecl); qrMs += performance.now() - t0;
    modules = qr.size;
    const scale = Math.max(1, Math.floor(SIDE / (qr.size + 8)));
    fs.writeFileSync(path.join(dir, `frame_${String(i).padStart(5, "0")}.png`), encodeGray(DQ.render.toGray(qr, scale)));
  }
  for (const level of ["moderate", "harsh"]) spawnSync(PY, ["tests/bench/degrade.py", dir, path.join(dir, level), level], { cwd: ROOT });
  const res = { bs, ecl, version, modules, textChars: texts[0].length, pxPerModuleAt600: +(SIDE / (modules + 8)).toFixed(2), encodeMsPerFrame: +(qrMs / N).toFixed(2) };
  const sets = [["clean", dir, "frame_*.png", ".png"], ["moderate", path.join(dir, "moderate"), "frame_*.jpg", ".jpg"], ["harsh", path.join(dir, "harsh"), "frame_*.jpg", ".jpg"]];
  for (const dec of ["zbar", "zxing"]) for (const [kind, ddir, g] of sets) {
    const d = decode(ddir, dec, g);
    const ok = d.frames.filter((f) => f.texts.includes(texts[Number(f.file.match(/(\d+)/)[1])])).length;
    res[`${dec}_${kind}_rate`] = +(ok / d.frames.length).toFixed(3);
    res[`${dec}_${kind}_ms`] = d.summary.ms_per_frame_mean;
  }
  for (const [kind, ddir, , ext] of sets) {
    const j = await jsqr(ddir, ext, texts);
    res[`jsqr_${kind}_rate`] = j.rate ?? null; res[`jsqr_${kind}_ms`] = j.msPerFrame ? +j.msPerFrame.toFixed(1) : null; if (j.error) res.jsqrError = j.error;
    res[`zxingWasm_${kind}_rate`] = j.rate2 ?? null; res[`zxingWasm_${kind}_ms`] = j.msPerFrame2 ? +j.msPerFrame2.toFixed(1) : null;
  }
  for (const fps of [5, 10, 15, 20]) for (const level of ["moderate", "harsh"]) for (const engine of ["zbar", "zxing", "zxingWasm", "jsqr"])
    res[`goodput_${level}_${fps}fps_${engine}`] = goodput(res, { fps, level, engine, overhead: OVERHEAD });
  rows.push(res); console.log(JSON.stringify(res));
}
await browser.close();
fs.writeFileSync(path.join(ROOT, "results", process.env.BENCH_OUT || "bench.json"), JSON.stringify({ frames: N, qrSidePx: SIDE, overheadAssumed: OVERHEAD, degradation: "tests/bench/degrade.py levels moderate and harsh (synthetic, not a camera)", rows }, null, 1));
