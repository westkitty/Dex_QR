// Cycle 8: before/after screenshots of the sender at 1280x800 and 390x844 (full page).
// Usage: node tests/browser/sender-shots.mjs --root DIR --tag before|after --out docs/screenshots
// States: ready (file chosen), sending; on builds that have them also "likely done" and "finished".
import { chromium } from "playwright-core";
import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";
const require = createRequire(import.meta.url);
const { testFile } = require("../lib/testfile.cjs");
const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..", "..");
const arg = (k, d) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : d; };
const SRC = path.resolve(arg("--root", ROOT)), TAG = arg("--tag", "after"), OUT = path.resolve(arg("--out", path.join(ROOT, "docs", "screenshots")));
const CHROME = process.env.CHROME || "/usr/bin/google-chrome";
fs.mkdirSync(OUT, { recursive: true });
const WORK = path.join(ROOT, "work", "shots_" + Date.now().toString(36)); fs.mkdirSync(WORK, { recursive: true });
const big = path.join(WORK, "field-notes.csv"); fs.writeFileSync(big, testFile(30000, "shots"));
const small = path.join(WORK, "postcard.txt"); fs.writeFileSync(small, testFile(2000, "shots-small"));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function poll(p, fn, t = 30000) { const end = Date.now() + t; while (!(await p.evaluate(fn))) { if (Date.now() > end) return false; await sleep(100); } return true; }
const browser = await chromium.launch({ executablePath: CHROME, headless: true });
const made = [];
for (const [w, h] of [[1280, 800], [390, 844]]) {
  const p = await browser.newPage({ viewport: { width: w, height: h }, colorScheme: "dark" });
  await p.goto("file://" + path.join(SRC, "sender.html"));
  await p.setInputFiles("#file", big);
  await p.click("#play"); await poll(p, () => window.__dexqrSender.playing); await sleep(1500);
  let f = path.join(OUT, `cycle8-${TAG}-sender-sending-${w}.png`); await p.evaluate(() => scrollTo(0, 0)); await sleep(150); await p.screenshot({ path: f, fullPage: true }); made.push(f);
  const hasFinish = await p.evaluate(() => !!document.getElementById("finish"));
  if (hasFinish) {
    await p.click("#play");
    await p.setInputFiles("#file", small);
    await p.evaluate(() => { const d = document.getElementById("tuning"); d.open = true; });
    await p.fill("#fps", "30"); await p.dispatchEvent("#fps", "change");
    await p.evaluate(() => { document.getElementById("tuning").open = false; });
    await p.click("#play"); await poll(p, () => !document.getElementById("finish").hidden); await sleep(900);
    f = path.join(OUT, `cycle8-${TAG}-sender-likely-done-${w}.png`); await p.evaluate(() => scrollTo(0, 0)); await sleep(150); await p.screenshot({ path: f, fullPage: true }); made.push(f);
    await p.click("#finish-stop"); await sleep(1200);
    f = path.join(OUT, `cycle8-${TAG}-sender-finished-${w}.png`); await p.evaluate(() => scrollTo(0, 0)); await sleep(150); await p.screenshot({ path: f, fullPage: true }); made.push(f);
  }
  await p.close();
}
await browser.close();
console.log(made.join("\n"));
