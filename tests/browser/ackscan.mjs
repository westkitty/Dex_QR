// Cycle 9: scan reliability of the receiver's Done code as painted on screen, at 1280x800 and 390x844.
// One real transfer is completed (rendered frames as image files), then N different Done codes are drawn through
// the page's own drawing path (state.ackText + resize) and each is captured as (a) a crop around the code with its
// ring and (b) the whole viewport. Decoded with zbar and zxing-cpp, clean and after tests/bench/degrade.py
// (moderate, harsh; synthetic, NOT a camera). Usage: node tests/browser/ackscan.mjs [--n 20] [--out FILE]
import { chromium } from "playwright-core";
import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
const require = createRequire(import.meta.url);
const DQ = require("../lib/load.cjs").load();
const { encodeGray } = require("../lib/png.cjs");
const { testFile } = require("../lib/testfile.cjs");
const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..", "..");
const arg = (k, d) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : d; };
const N = Number(arg("--n", 20)), OUT = path.resolve(arg("--out", path.join(ROOT, "results", "cycle9", "ackscan.json")));
const CHROME = process.env.CHROME || "/usr/bin/google-chrome", PY = process.env.PY || "python3";
const WORK = path.join(ROOT, "work", "ackscan_" + Date.now().toString(36)); fs.mkdirSync(WORK, { recursive: true });
const s = await DQ.SenderSession.create({ name: "a.bin", data: testFile(3000, "ackscan"), blockSize: 400, startSeed: 3, compress: false });
const frames = [];
for (let i = 0; i < Math.ceil(s.K * 1.6) + 6; i++) { const f = path.join(WORK, `s_${i}.png`); fs.writeFileSync(f, encodeGray(DQ.render.toGray(DQ.render.makeQr(s.nextFrame(), "M"), 4))); frames.push(f); }
const texts = Array.from({ length: N }, (_, i) => { const id = new Uint8Array(8); for (let k = 0; k < 8; k++) id[k] = (i * 37 + k * 101 + 13) & 255; return DQ.ack.build(id); });
const browser = await chromium.launch({ executablePath: CHROME, headless: true });
const rows = [];
for (const [w, h] of [[1280, 800], [390, 844]]) {
  const ctx = await browser.newContext({ viewport: { width: w, height: h }, colorScheme: "dark", reducedMotion: "reduce" });
  const p = await ctx.newPage(); const errors = []; p.on("pageerror", (e) => errors.push(e.message));
  await p.goto("file://" + path.join(ROOT, "receiver.html"));
  await p.click("details.opts summary"); await p.selectOption("#dec", "zxing"); await p.evaluate(() => { document.querySelector("details.opts").open = false; });
  await p.setInputFiles("#files", frames);
  for (let i = 0; i < 300 && (await p.evaluate(() => window.__dexqrReceiver.phase)) !== "done"; i++) await p.waitForTimeout(100);
  await p.evaluate(() => scrollTo(0, 0)); await p.waitForTimeout(300);
  const dir = path.join(WORK, `w${w}`), crop = path.join(dir, "crop"), full = path.join(dir, "full");
  fs.mkdirSync(crop, { recursive: true }); fs.mkdirSync(full, { recursive: true });
  let geom = null;
  for (let i = 0; i < N; i++) {
    await p.evaluate((t) => { window.__dexqrReceiver.ackText = t; window.dispatchEvent(new Event("resize")); }, texts[i]);
    await p.waitForTimeout(80);
    geom = await p.evaluate(() => { const r = document.getElementById("ack-code").getBoundingClientRect(), a = window.__dexqrReceiver.ackInfo; return { x: r.x, y: r.y, w: r.width, h: r.height, modulePx: a.modulePx, modules: a.size, version: a.version, vw: innerWidth, vh: innerHeight }; });
    const m = 12, clip = { x: Math.max(0, geom.x - m), y: Math.max(0, geom.y - m), width: Math.min(geom.vw, geom.w + 2 * m), height: Math.min(geom.vh, geom.h + 2 * m) };
    const name = `frame_${String(i).padStart(5, "0")}.png`;
    await p.screenshot({ path: path.join(crop, name), clip });
    await p.screenshot({ path: path.join(full, name) });
  }
  for (const level of ["moderate", "harsh"]) spawnSync(PY, ["tests/bench/degrade.py", crop, path.join(dir, level), level], { cwd: ROOT, stdio: "inherit" });
  const sets = { "crop clean": [crop, "frame_*.png"], "full viewport clean": [full, "frame_*.png"], "crop moderate": [path.join(dir, "moderate"), "frame_*.jpg"], "crop harsh": [path.join(dir, "harsh"), "frame_*.jpg"] };
  const row = { width: w, geometry: { modulePx: geom.modulePx, modules: geom.modules, version: geom.version, codeCssPx: geom.modulePx * (geom.modules + 8), quietZonePx: 4 * geom.modulePx }, errors, decode: {} };
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
  rows.push(row); console.log(JSON.stringify(row));
  await ctx.close();
}
await browser.close();
fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, JSON.stringify({ when: new Date().toISOString(), n: N, degradation: "tests/bench/degrade.py moderate/harsh (synthetic, not a camera)", rows }, null, 1));
const bad = rows.some((r) => r.errors.length || ["crop clean zbar", "crop clean zxing", "full viewport clean zbar", "full viewport clean zxing", "crop moderate zxing"].some((k) => r.decode[k].ok !== N || r.decode[k].wrong));
if (bad) process.exitCode = 1;
