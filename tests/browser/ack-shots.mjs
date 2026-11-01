// Cycle 9: before/after screenshots of the screens the Done confirmation changes, at 1280x800 and 390x844
// (full page): the receiver's finished screen and the sender's "should have it by now" state.
// Usage: node tests/browser/ack-shots.mjs --root DIR --tag before|after --out DIR
// The sender's camera states (looking for the Done code, confirmed) need a fake camera; tests/browser/ack.mjs
// saves those with --shots.
import { chromium } from "playwright-core";
import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";
const require = createRequire(import.meta.url);
const DQ = require("../lib/load.cjs").load();
const { encodeGray } = require("../lib/png.cjs");
const { testFile } = require("../lib/testfile.cjs");
const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..", "..");
const arg = (k, d) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : d; };
const SRC = path.resolve(arg("--root", ROOT)), TAG = arg("--tag", "after"), OUT = path.resolve(arg("--out", path.join(ROOT, "docs", "screenshots")));
const CHROME = process.env.CHROME || "/usr/bin/google-chrome";
fs.mkdirSync(OUT, { recursive: true });
const WORK = path.join(ROOT, "work", "ackshots_" + Date.now().toString(36)); fs.mkdirSync(WORK, { recursive: true });
const small = path.join(WORK, "postcard.txt"); fs.writeFileSync(small, testFile(2000, "shots-small"));
const s = await DQ.SenderSession.create({ name: "field-notes.csv", data: testFile(20000, "ack-shots"), blockSize: 400, startSeed: 9, compress: false });
const frames = [];
for (let i = 0; i < Math.ceil(s.K * 1.6) + 6; i++) { const f = path.join(WORK, `f_${String(i).padStart(4, "0")}.png`); fs.writeFileSync(f, encodeGray(DQ.render.toGray(DQ.render.makeQr(s.nextFrame(), "M"), 4))); frames.push(f); }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function poll(p, fn, t = 30000) { const end = Date.now() + t; while (!(await p.evaluate(fn))) { if (Date.now() > end) return false; await sleep(100); } return true; }
const browser = await chromium.launch({ executablePath: CHROME, headless: true });
const made = [];
const shot = async (p, name, w) => { const f = path.join(OUT, `cycle9-${TAG}-${name}-${w}.png`); await p.evaluate(() => scrollTo(0, 0)); await sleep(150); await p.screenshot({ path: f, fullPage: true }); made.push(f); };
for (const [w, h] of [[1280, 800], [390, 844]]) {
  let p = await browser.newPage({ viewport: { width: w, height: h }, colorScheme: "dark" });
  await p.goto("file://" + path.join(SRC, "receiver.html"));
  await p.click("details.opts summary"); await p.selectOption("#dec", "zxing"); await p.evaluate(() => { document.querySelector("details.opts").open = false; });
  await p.setInputFiles("#files", frames); await poll(p, () => window.__dexqrReceiver.phase === "done"); await sleep(1800);
  await shot(p, "receiver-done", w); await p.close();
  p = await browser.newPage({ viewport: { width: w, height: h }, colorScheme: "dark" });
  await p.goto("file://" + path.join(SRC, "sender.html"));
  await p.setInputFiles("#file", small);
  await p.evaluate(() => { document.getElementById("tuning").open = true; });
  await p.fill("#fps", "30"); await p.dispatchEvent("#fps", "change");
  await p.evaluate(() => { document.getElementById("tuning").open = false; });
  await p.click("#play"); await poll(p, () => !document.getElementById("finish").hidden); await sleep(900);
  await p.click("#play");   // pause so the code in the picture is one frame, not mid-redraw
  await sleep(200); await shot(p, "sender-likely-done", w); await p.close();
}
await browser.close();
console.log(made.join("\n"));
