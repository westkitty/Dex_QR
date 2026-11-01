// Headless Chrome tests of the early passphrase check (key-check frames, cycle 3). Pages load from file://
// with their real CSP; frames are rendered to PNG with the same code the sender page uses and decoded by the
// receiver page's zxing-cpp build. Also measures the time from pressing "Check passphrase" to the verdict.
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
const WORK = path.join(ROOT, "work", "kc_" + Date.now().toString(36));
fs.mkdirSync(WORK, { recursive: true });
const PASS = "orbit lantern quiet mosaic thunder";
const sha = (b) => crypto.createHash("sha256").update(b).digest("hex");
const results = [], netViolations = [];
function record(name, ok, details = {}) { results.push({ name, ok, ...details }); console.log((ok ? "PASS " : "FAIL ") + name, JSON.stringify(details)); }
async function waitFor(page, fn, arg, timeout = 60000) {
  const end = Date.now() + timeout;
  for (;;) { if (await page.evaluate(fn, arg)) return true; if (Date.now() > end) return false; await new Promise((r) => setTimeout(r, 50)); }
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
const rs = (p) => p.evaluate(() => { const s = window.__dexqrReceiver; return { phase: s.phase, done: s.session.done, received: s.session.decoder ? s.session.decoder.received : 0, keyFrames: s.session.stats.keyFrames, foreign: s.session.stats.foreign, key: document.getElementById("r-key").textContent, msg: document.getElementById("msg").textContent, role: document.getElementById("msg").getAttribute("role"), passVisible: !document.getElementById("passbox").hidden, button: document.getElementById("decrypt").textContent, focus: document.activeElement && document.activeElement.id, result: s.result }; });

async function main() {
  // A 60 KB encrypted file with the sender's real default of 600,000 PBKDF2 iterations.
  const data = testFile(60000, "kc-main");
  const s = await DQ.SenderSession.create({ name: "kc.bin", data, blockSize: 400, passphrase: PASS, startSeed: 77 });
  const texts = []; for (let i = 0; i < Math.ceil(s.K * 1.4) + 40; i++) texts.push(s.nextFrame());
  const files = texts.map((t, i) => png(path.join(WORK, `f_${String(i).padStart(5, "0")}.png`), t));
  const keyIdx = texts.map((t, i) => (t.startsWith("DK") ? i : -1)).filter((i) => i >= 0);
  console.log(`K=${s.K}, frames=${texts.length}, key frames at ${keyIdx.slice(0, 4).join(",")}…, DK text ${texts[0].length} chars, data text ${texts[1].length} chars`);
  const browser = await chromium.launch({ executablePath: CHROME, headless: true });

  // 1. wrong passphrase reported from the first frames, retry without losing progress, file opens by itself
  {
    const { ctx, p, errors } = await open(browser, "receiver.html");
    await p.click("details.opts summary"); await p.selectOption("#dec", "zxing");
    await p.setInputFiles("#files", files.slice(0, 6));
    await waitFor(p, () => window.__dexqrReceiver.phase === "incomplete");
    const early = await rs(p);
    await p.fill("#pass", PASS + "x");
    const t0 = Date.now(); await p.click("#decrypt");
    await waitFor(p, () => /does not match/.test(document.getElementById("r-key").textContent), null, 30000);
    const wrongMs = Date.now() - t0;
    const wrong = await rs(p);
    await p.fill("#pass", PASS);
    const t1 = Date.now(); await p.click("#decrypt");
    await waitFor(p, () => /matches the sender/.test(document.getElementById("r-key").textContent), null, 30000);
    const okMs = Date.now() - t1;
    const ok = await rs(p);
    await p.setInputFiles("#files", files.slice(6));
    await waitFor(p, () => ["done", "wrong passphrase", "error", "incomplete"].includes(window.__dexqrReceiver.phase), null, 300000);
    const fin = await rs(p);
    record("receiver: wrong passphrase reported after 6 of " + texts.length + " frames, before the file is decoded; scanning progress kept", early.passVisible && early.button === "Check passphrase" && /key-check frame received/.test(early.key) && early.keyFrames === 1 && early.foreign === 0 && /Wrong passphrase/.test(wrong.msg) && wrong.role === "alert" && wrong.focus === "pass" && !wrong.done && wrong.received === early.received && errors.length === 0, { early: { phase: early.phase, received: early.received, key: early.key, button: early.button }, wrong: { msg: wrong.msg, role: wrong.role, focus: wrong.focus }, wrongMs, errors });
    record("receiver: right passphrase accepted early; the file then opens by itself with the cached key (no second PBKDF2)", /matches/.test(ok.key) && ok.role === "status" && fin.phase === "done" && fin.result && fin.result.sha256 === sha(data) && fin.result.usedCachedKey === true && /AES-GCM authentication passed/.test(fin.key) && errors.length === 0, { okMs, finPhase: fin.phase, usedCachedKey: fin.result && fin.result.usedCachedKey, key: fin.key });
    results.at(-2).wrongMs = wrongMs; results.at(-1).okMs = okMs;
    await ctx.close();
  }

  // 2. passphrase typed before any key frame: "waiting", then checked automatically when one arrives
  {
    const { ctx, p, errors } = await open(browser, "receiver.html");
    await p.click("details.opts summary"); await p.selectOption("#dec", "zxing");
    await p.setInputFiles("#files", files.slice(1, 5));
    await waitFor(p, () => window.__dexqrReceiver.phase === "incomplete");
    await p.fill("#pass", "not it"); await p.click("#decrypt");
    const waiting = await rs(p);
    await p.setInputFiles("#files", [files[keyIdx[1]]]);
    await waitFor(p, () => /does not match/.test(document.getElementById("r-key").textContent), null, 30000);
    const after = await rs(p);
    record("receiver: passphrase entered before a key frame waits, then is checked when one is scanned", /waiting for the sender's key-check frame/.test(waiting.key) && /Passphrase noted/.test(waiting.msg) && /does not match/.test(after.key) && errors.length === 0, { waiting: waiting.key, after: after.key, errors });
    await ctx.close();
  }

  // 3. legacy encrypted stream (no key frames): behaves as before, checked at the end
  {
    const legacy = JSON.parse(fs.readFileSync(path.join(ROOT, "tests/fixtures/legacy_streams.json"), "utf8")).streams.find((x) => x.encrypted && x.version === 2);
    const lf = legacy.texts.map((t, i) => png(path.join(WORK, `l_${String(i).padStart(4, "0")}.png`), t));
    const { ctx, p, errors } = await open(browser, "receiver.html");
    await p.click("details.opts summary"); await p.selectOption("#dec", "zxing");
    await p.setInputFiles("#files", lf.slice(0, 3));
    await waitFor(p, () => window.__dexqrReceiver.phase === "incomplete");
    await p.fill("#pass", legacy.passphrase); await p.click("#decrypt");
    const mid = await rs(p);
    await p.setInputFiles("#files", lf.slice(3));
    await waitFor(p, () => ["done", "wrong passphrase", "error", "incomplete"].includes(window.__dexqrReceiver.phase), null, 120000);
    const fin = await rs(p);
    record("receiver: pre-cycle-3 encrypted stream (no key frames) still decodes with the passphrase typed early", /waiting/.test(mid.key) && fin.phase === "done" && fin.result.encrypted && errors.length === 0, { mid: mid.key, phase: fin.phase, errors });
    await ctx.close();
  }

  // 4. sender page: key frame first and every 32nd; none with the box unticked or without a passphrase
  {
    const sample = path.join(WORK, "sample.bin"); fs.writeFileSync(sample, testFile(30000, "kc-sender"));
    const { ctx, p, errors } = await open(browser, "sender.html");
    await p.setInputFiles("#file", sample); await p.fill("#pass", PASS); await p.evaluate(() => { const d = document.getElementById("tuning"); if (d) d.open = true; });   // cycle 6: settings live in the Tuning disclosure
    await p.click("#prepare");
    await waitFor(p, () => /Ready/.test(document.getElementById("msg").textContent), null, 30000);
    const shown = await p.evaluate(() => { const s = window.__dexqrSender, out = []; for (let i = 0; i < 70; i++) { s.renderNextForTest(); out.push(s.text.slice(0, 2)); } return { out, enc: document.getElementById("s-enc").textContent }; });
    const idx = shown.out.map((t, i) => (t === "DK" ? i : -1)).filter((i) => i >= 0);
    await p.uncheck("#kc"); const stale = await p.evaluate(() => document.getElementById("prepare").textContent);
    await p.click("#prepare"); await waitFor(p, () => /Ready/.test(document.getElementById("msg").textContent), null, 30000);
    const off = await p.evaluate(() => { const s = window.__dexqrSender, out = []; for (let i = 0; i < 70; i++) { s.renderNextForTest(); out.push(s.text.slice(0, 2)); } return out; });
    record("sender: key-check frame at frames 0, 32, 64; unticking the box marks settings stale and removes them", JSON.stringify(idx) === "[0,32,64]" && /early passphrase check on/.test(shown.enc) && /apply changes/.test(stale) && off.every((t) => t === "DQ") && errors.length === 0, { idx, enc: shown.enc, stale, errors });
    await ctx.close();
  }
  await browser.close();
  const out = { when: new Date().toISOString(), K: s.K, frames: texts.length, results, networkRequestsOutsideFileDataBlob: netViolations };
  fs.mkdirSync(path.join(ROOT, "results"), { recursive: true });
  fs.writeFileSync(path.join(ROOT, "results", "keycheck_browser.json"), JSON.stringify(out, null, 1));
  console.log("keycheck browser tests passed", results.filter((r) => r.ok).length, "/", results.length, "network violations:", netViolations.length);
  if (results.some((r) => !r.ok) || netViolations.length) process.exitCode = 1;
}
main().catch((e) => { console.error(e); process.exitCode = 1; });
