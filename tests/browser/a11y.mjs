// Accessibility check of the built pages with axe-core (dev-only dependency, MPL-2.0, never shipped in the pages).
// Each page is loaded from file:// with its real CSP, in a few UI states, at a phone and a desktop width.
// Fails on any axe violation with impact "serious" or "critical"; lists every violation.
import { chromium } from "playwright-core";
import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";
const require = createRequire(import.meta.url);
const AXE = fs.readFileSync(require.resolve("axe-core/axe.min.js"), "utf8");
const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..", "..");
const CHROME = process.env.CHROME || "/usr/bin/google-chrome";
const TMP = path.join(ROOT, "work", "a11y_" + Date.now().toString(36));
fs.mkdirSync(TMP, { recursive: true });
const sample = path.join(TMP, "sample.txt"); fs.writeFileSync(sample, "Dex_QR accessibility sample\n".repeat(200));

const states = {
  "index": async () => {},
  "sender": async () => {},
  "sender prepared": async (p) => { await p.setInputFiles("#file", sample); await p.fill("#pass", "abc"); await p.click("#prepare"); await p.waitForTimeout(800); },
  "receiver": async () => {},
  "receiver options": async (p) => { await p.click("details.opts summary"); await p.click("#start"); await p.waitForTimeout(800); },
  "sender focus-mode": async (p) => { await p.setInputFiles("#file", sample); await p.click("#prepare"); await p.waitForTimeout(800); await p.evaluate(() => { delete Element.prototype.requestFullscreen; }); await p.click("#fs"); await p.waitForTimeout(200); },
};
const browser = await chromium.launch({ executablePath: CHROME, headless: true });
const report = [];
let serious = 0;
for (const [w, h] of [[390, 844], [1280, 800]]) {
  for (const [label, setup] of Object.entries(states)) {
    const file = label.split(" ")[0] + ".html";
    const page = await browser.newPage({ viewport: { width: w, height: h } });
    await page.goto("file://" + path.join(ROOT, file));
    await setup(page);
    await page.evaluate(AXE); // CDP evaluation is not subject to the page CSP, so the pages keep their real policy
    const res = await page.evaluate(async () => {
      const r = await window.axe.run(document, { resultTypes: ["violations"] });
      return r.violations.map((v) => ({ id: v.id, impact: v.impact, help: v.help, nodes: v.nodes.map((n) => n.target.join(" ")).slice(0, 6) }));
    });
    for (const v of res) if (v.impact === "serious" || v.impact === "critical") serious++;
    report.push({ page: label, width: w, violations: res });
    console.log(`${label} @${w}px: ${res.length ? res.map((v) => `${v.impact}:${v.id} [${v.nodes.join(", ")}]`).join("; ") : "no violations"}`);
    await page.close();
  }
}
await browser.close();
fs.mkdirSync(path.join(ROOT, "results"), { recursive: true });
fs.writeFileSync(path.join(ROOT, "results", "a11y.json"), JSON.stringify({ axe: require("axe-core/package.json").version, when: new Date().toISOString(), report }, null, 1));
console.log("serious/critical violations:", serious);
if (serious) process.exitCode = 1;
