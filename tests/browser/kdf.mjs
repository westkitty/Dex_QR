// Headless Chrome tests of PBKDF2 iteration calibration and the new strength meter (cycle 4). Pages load from
// file:// with their real CSP. The sender page calibrates on this machine; its frames are captured with the
// page's own test hook and decoded by the receiver page (zxing-cpp), which must use the iteration count from
// the stream. A forged key-check frame asking for 4,294,967,295 iterations must be refused without deriving.
import { chromium } from "playwright-core";
import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
const require = createRequire(import.meta.url);
const DQ = require("../lib/load.cjs").load();
const { encodeGray } = require("../lib/png.cjs");
const { testFile } = require("../lib/testfile.cjs");
const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..", "..");
const CHROME = process.env.CHROME || "/usr/bin/google-chrome";
const WORK = path.join(ROOT, "work", "kdf_" + Date.now().toString(36));
fs.mkdirSync(WORK, { recursive: true });
const PASS = "orbit lantern quiet mosaic thunder";
const sha = (b) => crypto.createHash("sha256").update(b).digest("hex");
const results = [], netViolations = [];
function record(name, ok, details = {}) { results.push({ name, ok, ...details }); console.log((ok ? "PASS " : "FAIL ") + name, JSON.stringify(details)); }
async function waitFor(page, fn, arg, timeout = 60000) {
  const end = Date.now() + timeout;
  for (;;) { if (await page.evaluate(fn, arg)) return true; if (Date.now() > end) return false; await new Promise((r) => setTimeout(r, 25)); }
}
const png = (file, text) => { fs.writeFileSync(file, encodeGray(DQ.render.toGray(DQ.render.makeQr(text, "M"), 4))); return file; };
async function open(browser, page) {
  const ctx = await browser.newContext({ acceptDownloads: true, viewport: { width: 1280, height: 800 } });
  const p = await ctx.newPage(); const errors = [];
  p.on("pageerror", (e) => errors.push(e.message));
  p.on("request", (r) => { if (!/^(file:|data:|blob:)/.test(r.url())) netViolations.push({ page, url: r.url() }); });
  await p.goto("file://" + path.join(ROOT, page));
  return { ctx, p, errors };
}
const iterOf = (p) => p.evaluate(() => { const s = window.__dexqrSender.session; return new DataView(s.payload.buffer, s.payload.byteOffset).getUint32(4); });

async function main() {
  const browser = await chromium.launch({ executablePath: CHROME, headless: true });
  const data = testFile(3000, "kdf-main");
  const sample = path.join(WORK, "sample.bin"); fs.writeFileSync(sample, data);
  let calibrated = 0, frames = [];

  // 1. sender: calibrated by default, shown on the page, within [600,000, cap], multiple of 100,000
  {
    const { ctx, p, errors } = await open(browser, "sender.html");
    const dflt = await p.evaluate(() => document.getElementById("kdf") && document.getElementById("kdf").value);
    await p.setInputFiles("#file", sample); await p.fill("#pass", PASS);
    const t0 = Date.now(); await p.click("#prepare");
    await waitFor(p, () => /Ready|Could not/.test(document.getElementById("msg").textContent), null, 60000);
    const prepareMs = Date.now() - t0;
    calibrated = await iterOf(p);
    const info = await p.evaluate(() => ({ enc: document.getElementById("s-enc").textContent, cal: window.__dexqrSender.calibration }));
    const cap = DQ.container.CALIBRATION.cap;
    frames = await p.evaluate(() => { const s = window.__dexqrSender, out = []; for (let i = 0; i < 40; i++) { s.renderNextForTest(); out.push(s.text); } return out; });
    record("sender: tuned to this device by default (about 1 s), count shown and carried in the stream", dflt === "auto" && calibrated >= 600000 && calibrated <= cap && calibrated % 100000 === 0 && info.enc.includes(calibrated.toLocaleString("en-US")) && /tuned/.test(info.enc) && info.cal && info.cal.measured && errors.length === 0, { iterations: calibrated, prepareMs, enc: info.enc, calibration: info.cal, errors });
    // 2. "standard" keeps the old fixed count
    await p.selectOption("#kdf", "standard");
    const stale = await p.evaluate(() => document.getElementById("prepare").textContent);
    const t1 = Date.now(); await p.click("#prepare");
    await waitFor(p, () => /Ready|Could not/.test(document.getElementById("msg").textContent) && !document.getElementById("prepare").disabled, null, 60000);
    const stdMs = Date.now() - t1;
    const std = await iterOf(p);
    record("sender: 'Standard' sends 600,000 iterations; changing it marks settings stale", std === 600000 && /apply changes/.test(stale) && /600,000/.test(await p.evaluate(() => document.getElementById("s-enc").textContent)) && errors.length === 0, { std, stdMs, stale });
    // 3. strength meter: pattern-aware, and never echoes parts of the passphrase
    const meter = {};
    for (const pw of ["Summer2024!", "P@ssw0rd", "orbit lantern quiet mosaic thunder", "k7#Qm2!vR9@xL4$z"]) { await p.fill("#pass", pw); meter[pw] = await p.evaluate(() => ({ text: document.getElementById("strength").textContent, cls: document.getElementById("strength").className })); }
    const noEcho = Object.entries(meter).every(([pw, m]) => !pw.split(/\s+/).some((w) => w.length >= 4 && m.text.toLowerCase().includes(w.toLowerCase())));
    record("sender: strength meter rates Summer2024! and P@ssw0rd weak, five words good, 16 random characters strong; no passphrase text echoed", /weak/.test(meter["Summer2024!"].cls) && /weak/.test(meter["P@ssw0rd"].cls) && /good/.test(meter["orbit lantern quiet mosaic thunder"].cls) && /strong/.test(meter["k7#Qm2!vR9@xL4$z"].cls) && /common/i.test(meter["P@ssw0rd"].text) && noEcho && errors.length === 0, { meter });
    await ctx.close();
  }

  // 4. receiver: uses the stream's calibrated count; early check and final open both succeed
  {
    const files = frames.map((t, i) => png(path.join(WORK, `f_${String(i).padStart(3, "0")}.png`), t));
    const { ctx, p, errors } = await open(browser, "receiver.html");
    await p.click("details.opts summary"); await p.selectOption("#dec", "zxing");
    await p.setInputFiles("#files", files.slice(0, 3));
    await waitFor(p, () => !document.getElementById("passbox").hidden);
    const keyBefore = await p.evaluate(() => document.getElementById("r-key").textContent);
    await p.fill("#pass", PASS);
    const t0 = Date.now(); await p.click("#decrypt");
    await waitFor(p, () => /matches|does not match|Could not/.test(document.getElementById("r-key").textContent + document.getElementById("msg").textContent), null, 60000);
    const checkMs = Date.now() - t0;
    const mid = await p.evaluate(() => ({ key: document.getElementById("r-key").textContent, msg: document.getElementById("msg").textContent, it: window.__dexqrReceiver.session.keyCheck && window.__dexqrReceiver.session.keyCheck.iterations }));
    await p.setInputFiles("#files", files.slice(3));
    await waitFor(p, () => ["done", "wrong passphrase", "error", "incomplete"].includes(window.__dexqrReceiver.phase), null, 120000);
    const fin = await p.evaluate(() => ({ phase: window.__dexqrReceiver.phase, result: window.__dexqrReceiver.result }));
    record("receiver: early check uses the calibrated count from the key frame, shows it, then the file opens with the cached key", mid.it === calibrated && keyBefore.includes(calibrated.toLocaleString("en-US")) && /matches/.test(mid.key) && fin.phase === "done" && fin.result && fin.result.sha256 === sha(data) && fin.result.usedCachedKey === true && errors.length === 0, { iterations: mid.it, keyBefore, key: mid.key, checkMs, phase: fin.phase, errors });
    results.at(-1).checkMs = checkMs;
    await ctx.close();
  }

  // 5. receiver: a forged key frame demanding 4,294,967,295 iterations is refused; nothing is derived
  {
    const s = await DQ.SenderSession.create({ name: "f.bin", data: testFile(2000, "kdf-forged"), blockSize: 400, passphrase: PASS, iterations: 100000, startSeed: 9 });
    const k = DQ.packet.parseKeyFrame(s.keyFrameText);
    const forged = DQ.packet.buildKeyFrame({ fileId: s.fileId, iterations: 0xffffffff, salt: k.salt, kcv: k.kcv });
    const files = [png(path.join(WORK, "x_data1.png"), s.textForSeed(1)), png(path.join(WORK, "x_forged.png"), forged), png(path.join(WORK, "x_data2.png"), s.textForSeed(2))];
    const { ctx, p, errors } = await open(browser, "receiver.html");
    await p.click("details.opts summary"); await p.selectOption("#dec", "zxing");
    await p.setInputFiles("#files", files);
    await waitFor(p, () => window.__dexqrReceiver.session.stats.qrTexts >= 3, null, 30000);
    await p.fill("#pass", PASS);
    const t0 = Date.now(); await p.click("#decrypt");
    await p.waitForTimeout(300);
    const st = await p.evaluate(() => ({ key: document.getElementById("r-key").textContent, msg: document.getElementById("msg").textContent, reasons: window.__dexqrReceiver.session.stats.reasons, keyFrames: window.__dexqrReceiver.session.stats.keyFrames, checking: window.__dexqrReceiver.checking }));
    record("receiver: forged key frame with 4,294,967,295 iterations is rejected (no PBKDF2 started, page responsive)", st.reasons["key-limits"] === 1 && st.keyFrames === 0 && /waiting/.test(st.key) && !st.checking && Date.now() - t0 < 5000 && errors.length === 0, { ...st, ms: Date.now() - t0, errors });
    await ctx.close();
  }

  await browser.close();
  const out = { when: new Date().toISOString(), calibratedIterations: calibrated, results, networkRequestsOutsideFileDataBlob: netViolations };
  fs.mkdirSync(path.join(ROOT, "results"), { recursive: true });
  fs.writeFileSync(path.join(ROOT, "results", "kdf_browser.json"), JSON.stringify(out, null, 1));
  console.log("kdf browser tests passed", results.filter((r) => r.ok).length, "/", results.length, "network violations:", netViolations.length);
  if (results.some((r) => !r.ok) || netViolations.length) process.exitCode = 1;
}
main().catch((e) => { console.error(e); process.exit(1); });
