// Cycle 8: scan reliability of the sender page as rendered on screen (not just the QR library output).
// Loads sender.html from --root (default this checkout) at 1280x800 and 390x844, sends a 10 KB file and, for
// each of N frames, takes (a) a crop around the code as the browser painted it and (b) the whole viewport
// (what a camera pointed at the screen sees, including the cards beside the code). Every image is decoded with
// zbar and zxing-cpp, clean and after tests/bench/degrade.py (moderate, harsh; synthetic, NOT a camera).
// Also records the module size and the code's on-screen size so a layout change that shrinks the code shows up.
// Usage: node tests/browser/pagescan.mjs [--root DIR] [--frames 40] [--out results/pagescan.json] [--shots DIR]
import { chromium } from "playwright-core";
import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
const require = createRequire(import.meta.url);
const { testFile } = require("../lib/testfile.cjs");
const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..", "..");
const arg = (k, d) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : d; };
const SRC = path.resolve(arg("--root", ROOT)), N = Number(arg("--frames", 40)), OUT = path.resolve(arg("--out", path.join(ROOT, "results", "pagescan.json")));
const SHOTS = arg("--shots", null);
const CHROME = process.env.CHROME || "/usr/bin/google-chrome";
const PY = process.env.PY || "python3";
const WORK = path.join(ROOT, "work", "pagescan_" + Date.now().toString(36)); fs.mkdirSync(WORK, { recursive: true });
const sample = path.join(WORK, "scan.bin"); fs.writeFileSync(sample, testFile(10240, "pagescan"));
const browser = await chromium.launch({ executablePath: CHROME, headless: true });
const rows = [];
for (const [w, h] of [[1280, 800], [390, 844]]) {
  const p = await browser.newPage({ viewport: { width: w, height: h }, colorScheme: "dark" });
  const errors = []; p.on("pageerror", (e) => errors.push(e.message));
  await p.goto("file://" + path.join(SRC, "sender.html"));
  await p.setInputFiles("#file", sample);
  await p.click("#play");
  for (let i = 0; i < 100 && !(await p.evaluate(() => window.__dexqrSender.playing)); i++) await p.waitForTimeout(100);
  await p.waitForTimeout(400);
  await p.click("#play");   // pause; frames are then stepped one by one with the test hook
  await p.evaluate(() => document.getElementById("qr").scrollIntoView({ block: "center" }));
  await p.waitForTimeout(300);
  const dir = path.join(WORK, `w${w}`), crop = path.join(dir, "crop"), full = path.join(dir, "full");
  fs.mkdirSync(crop, { recursive: true }); fs.mkdirSync(full, { recursive: true });
  const texts = [];
  let geom = null;
  for (let i = 0; i < N; i++) {
    const t = await p.evaluate(() => { window.__dexqrSender.renderNextForTest(); return window.__dexqrSender.text; });
    texts.push(t);
    geom = await p.evaluate(() => { const r = document.getElementById("qr").getBoundingClientRect(), s = window.__dexqrSender; return { x: r.x, y: r.y, w: r.width, h: r.height, modulePx: s.modulePx, modules: s.qrSize, version: s.qrVersion, vw: innerWidth, vh: innerHeight }; });
    const m = 12;
    const clip = { x: Math.max(0, geom.x - m), y: Math.max(0, geom.y - m), width: Math.min(geom.vw, geom.w + 2 * m), height: Math.min(geom.vh, geom.h + 2 * m) };
    const name = `frame_${String(i).padStart(5, "0")}.png`;
    await p.screenshot({ path: path.join(crop, name), clip });
    await p.screenshot({ path: path.join(full, name) });
    if (SHOTS && i === 0) { fs.mkdirSync(SHOTS, { recursive: true }); fs.copyFileSync(path.join(full, name), path.join(SHOTS, `pagescan-${w}.png`)); }
  }
  fs.writeFileSync(path.join(dir, "texts.json"), JSON.stringify(texts));
  for (const level of ["moderate", "harsh"]) spawnSync(PY, ["tests/bench/degrade.py", crop, path.join(dir, level), level], { cwd: ROOT, stdio: "inherit" });
  const sets = { "crop clean": [crop, "frame_*.png"], "full viewport clean": [full, "frame_*.png"], "crop moderate": [path.join(dir, "moderate"), "frame_*.jpg"], "crop harsh": [path.join(dir, "harsh"), "frame_*.jpg"] };
  const row = { width: w, geometry: { modulePx: geom.modulePx, modules: geom.modules, version: geom.version, codeCssPx: Math.round(geom.w), quietZonePx: 4 * geom.modulePx }, errors, decode: {} };
  for (const [label, [d, glob]] of Object.entries(sets)) for (const dec of ["zbar", "zxing"]) {
    const outJ = path.join(d, `dec_${dec}.json`);
    const r = spawnSync(PY, ["tests/e2e/decode_frames.py", d, "--decoder", dec, "--glob", glob, "--out", outJ], { cwd: ROOT, encoding: "utf8" });
    if (r.status !== 0) { console.error(r.stderr); throw new Error("decode failed"); }
    const res = JSON.parse(fs.readFileSync(outJ, "utf8"));
    const list = Array.isArray(res) ? res : res.frames || res.results || Object.values(res);
    let ok = 0, wrong = 0, multi = 0;
    for (const e of list) {
      const f = e.file || e.name || e.path || ""; const idx = Number((/(\d{5})/.exec(f) || [])[1]);
      const got = e.texts || e.decoded || e.results || [];
      if (got.length > 1) multi++;
      if (got.includes(texts[idx])) ok++; else if (got.length) wrong++;
    }
    row.decode[`${label} ${dec}`] = { ok, of: N, wrong, multi };
  }
  rows.push(row);
  console.log(JSON.stringify(row));
  await p.close();
}
await browser.close();
fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, JSON.stringify({ when: new Date().toISOString(), root: SRC, frames: N, degradation: "tests/bench/degrade.py moderate/harsh (synthetic, not a camera)", rows }, null, 1));
