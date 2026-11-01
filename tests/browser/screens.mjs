// Screenshots of the built pages in their main states, at a desktop (1280) and a phone (390) width.
// Usage: node tests/browser/screens.mjs <out-dir> <prefix>   (default: work/screens dexqr)
// States that need newer UI (theme toggle, reduced motion, celebration) are skipped on older builds.
// No camera: the receiver's partial and finished states are reached by decoding rendered QR frames as image files.
import { chromium } from "playwright-core";
import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";
const require = createRequire(import.meta.url);
const DQ = require("../lib/load.cjs").load();
const { encodeGray } = require("../lib/png.cjs");
const { testFile } = require("../lib/testfile.cjs");
const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..", "..");
const CHROME = process.env.CHROME || "/usr/bin/google-chrome";
const OUT = path.resolve(process.argv[2] || path.join(ROOT, "work", "screens"));
const PREFIX = process.argv[3] || "dexqr";
fs.mkdirSync(OUT, { recursive: true });
const WORK = path.join(ROOT, "work", "screens_" + Date.now().toString(36)); fs.mkdirSync(WORK, { recursive: true });
async function poll(p, fn, timeout = 60000) { const end = Date.now() + timeout; while (!(await p.evaluate(fn))) { if (Date.now() > end) throw new Error("timeout"); await new Promise((r) => setTimeout(r, 100)); } }

const data = testFile(60000, "screens");
const s = await DQ.SenderSession.create({ name: "field-notes.csv", data, blockSize: 400, startSeed: 77, compress: false });
const frames = [];
for (let i = 0; i < Math.ceil(s.K * 1.4) + 10; i++) { const f = path.join(WORK, `f_${String(i).padStart(4, "0")}.png`); fs.writeFileSync(f, encodeGray(DQ.render.toGray(DQ.render.makeQr(s.nextText(), "M"), 4))); frames.push(f); }
const partial = frames.slice(0, Math.round(s.K * 0.55));
const sample = path.join(WORK, "field-notes.csv"); fs.writeFileSync(sample, data);

const browser = await chromium.launch({ executablePath: CHROME, headless: true });
const shots = [];
async function shot(name, w, file, setup, opts = {}) {
  const ctx = await browser.newContext({ viewport: { width: w, height: w > 600 ? 800 : 844 }, deviceScaleFactor: 1, colorScheme: opts.scheme || "dark", reducedMotion: opts.reduced ? "reduce" : "no-preference" });
  const p = await ctx.newPage();
  await p.goto("file://" + path.join(ROOT, file));
  try {
    const ok = await setup(p);
    if (ok === false) { await ctx.close(); return; }
    const out = path.join(OUT, `${PREFIX}_${name}_${w}.png`);
    await p.screenshot({ path: out, fullPage: !!opts.full });
    shots.push(out); console.log("saved", out);
  } catch (e) { console.log("skip", name, w, e.message); }
  await ctx.close();
}
const newUi = async (p) => !!(await p.$("#theme"));
const feed = async (p, list) => {
  if (await p.$("details.opts summary")) await p.evaluate(() => { const d = document.querySelector("details.opts"); if (d) d.open = true; });
  await p.selectOption("#dec", "zxing");
  await p.setInputFiles("#files", list);
};
for (const w of [1280, 390]) {
  await shot("home", w, "index.html", async () => {});
  await shot("sender-idle", w, "sender.html", async () => {});
  await shot("sender-showing", w, "sender.html", async (p) => {
    await p.setInputFiles("#file", sample);
    if (await newUi(p)) { await p.click("#play"); await poll(p, () => window.__dexqrSender.playing); await p.waitForTimeout(2600); }
    else { await p.click("#prepare"); await poll(p, () => !!window.__dexqrSender.session && !document.getElementById("play").disabled); await p.click("#play"); await p.waitForTimeout(2600); }
    await p.evaluate(() => { const st = document.getElementById("stage"); if (st && innerWidth < 600) st.scrollIntoView({ block: "center" }); });
  });
  await shot("receiver-idle", w, "receiver.html", async () => {});
  await shot("receiver-partial", w, "receiver.html", async (p) => {
    await feed(p, partial);
    await poll(p, () => { const s = window.__dexqrReceiver; return s.phase !== "decoding files" && !s.busyFiles; });
    await p.waitForTimeout(900);
    await p.evaluate(() => { const d = document.querySelector("details.opts"); if (d) d.open = false; window.scrollTo(0, 0); });
  });
  await shot("receiver-done", w, "receiver.html", async (p) => {
    if (!(await newUi(p))) return false;
    await feed(p, frames);
    await poll(p, () => window.__dexqrReceiver.phase === "done");
    await p.evaluate(() => { const d = document.querySelector("details.opts"); if (d) d.open = false; window.scrollTo(0, 0); });
    await p.waitForTimeout(450);   // mid-celebration
  });
  await shot("sender-light", w, "sender.html", async (p) => { if (!(await newUi(p))) return false; await p.setInputFiles("#file", sample); }, { scheme: "light" });
  await shot("receiver-light", w, "receiver.html", async (p) => {
    if (!(await newUi(p))) return false;
    await feed(p, partial); await poll(p, () => !window.__dexqrReceiver.busyFiles); await p.waitForTimeout(700);
    await p.evaluate(() => { const d = document.querySelector("details.opts"); if (d) d.open = false; window.scrollTo(0, 0); });
  }, { scheme: "light" });
  await shot("home-light", w, "index.html", async (p) => { if (!(await p.$(".hero"))) return false; }, { scheme: "light" });
  await shot("receiver-done-reduced", w, "receiver.html", async (p) => {
    if (!(await newUi(p))) return false;
    await feed(p, frames); await poll(p, () => window.__dexqrReceiver.phase === "done");
    await p.evaluate(() => { const d = document.querySelector("details.opts"); if (d) d.open = false; window.scrollTo(0, 0); });
  }, { reduced: true });
}
await browser.close();
fs.writeFileSync(path.join(OUT, `${PREFIX}_screens.json`), JSON.stringify(shots, null, 1));
