// Headless Chrome tests of transparent compression (cycle 2), using the browser's real CompressionStream and
// DecompressionStream from file:// pages with their CSP. Sender page -> PNG frames -> receiver page (file input).
// Also: a receiver without DecompressionStream, a sender without CompressionStream, and an incompressible JPEG.
import { chromium } from "playwright-core";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..", "..");
const CHROME = process.env.CHROME || "/usr/bin/google-chrome";
const WORK = path.join(ROOT, "work", "compression_" + Date.now().toString(36));
fs.mkdirSync(WORK, { recursive: true });
const sha = (b) => crypto.createHash("sha256").update(b).digest("hex");
const results = [], netViolations = [];
const url = (p) => "file://" + path.join(ROOT, p);
function record(name, ok, details = {}) { results.push({ name, ok, ...details }); console.log((ok ? "PASS " : "FAIL ") + name, JSON.stringify(details)); }
async function waitFor(page, fn, arg, timeout = 60000) {
  const end = Date.now() + timeout;
  for (;;) { if (await page.evaluate(fn, arg)) return true; if (Date.now() > end) return false; await new Promise((r) => setTimeout(r, 100)); }
}
async function open(browser, page, init) {
  const ctx = await browser.newContext({ acceptDownloads: true, viewport: { width: 1280, height: 800 } });
  if (init) await ctx.addInitScript(init);
  const p = await ctx.newPage();
  const errors = [];
  p.on("pageerror", (e) => errors.push(e.message));
  p.on("request", (r) => { if (!/^(file:|data:|blob:)/.test(r.url())) netViolations.push({ page, url: r.url() }); });
  await p.goto(url(page));
  return { ctx, p, errors };
}
const csv = Buffer.from("time,sensor,value\n" + Array.from({ length: 1500 }, (_, i) => `2026-11-01T05:${String(i % 60).padStart(2, "0")}:00Z,s${i % 7},${(Math.sin(i / 9) * 100).toFixed(2)}`).join("\n") + "\n");
const JPEG = "/usr/local/go/src/image/testdata/video-001.jpeg";

async function send(browser, name, mime, data, { init, zip = true } = {}) {
  const { ctx, p, errors } = await open(browser, "sender.html", init);
  await p.setInputFiles("#file", { name, mimeType: mime, buffer: data });
  await p.evaluate(() => { const d = document.getElementById("tuning"); if (d) d.open = true; });   // cycle 6: settings live in the Tuning disclosure
  if (!zip) await p.uncheck("#zip");
  await p.fill("#px", "4");
  await p.click("#prepare");
  await waitFor(p, () => window.__dexqrSender.session && !document.getElementById("prepare").disabled);
  const info = await p.evaluate(() => { const s = window.__dexqrSender.session; return { K: s.K, payload: s.payload.length, compression: s.compression, zipText: document.getElementById("s-zip").textContent, msg: document.getElementById("msg").textContent }; });
  const frames = [];
  for (let i = 0; i < Math.ceil(info.K * 1.5) + 8; i++) {
    const u = await p.evaluate(() => window.__dexqrSender.renderNextForTest());
    const f = path.join(WORK, `${name}_${zip}_${frames.length}.png`.replace(/[^\w.]/g, "_"));
    fs.writeFileSync(f, Buffer.from(u.split(",")[1], "base64")); frames.push(f);
  }
  await ctx.close();
  return { ...info, frames, errors };
}
async function receive(browser, frames, init) {
  const { ctx, p, errors } = await open(browser, "receiver.html", init);
  await p.click("summary");
  await p.setInputFiles("#files", frames);
  await waitFor(p, () => { const s = window.__dexqrReceiver; return s.phase === "done" || s.phase === "cannot unpack" || s.phase === "error" || (s.session.done && !s.opening); });
  await p.waitForTimeout(200);
  const st = await p.evaluate(() => { const s = window.__dexqrReceiver; return { phase: s.phase, result: s.result, error: s.error, msg: document.getElementById("msg").textContent, zip: document.getElementById("r-zip").textContent, note: (document.querySelector("#result .note") || {}).textContent || "" }; });
  await ctx.close();
  return { ...st, errors };
}

const browser = await chromium.launch({ executablePath: CHROME, headless: true });
{
  const s = await send(browser, "log.csv", "text/csv", csv);
  const plain = await send(browser, "log.csv", "text/csv", csv, { zip: false });
  const r = await receive(browser, s.frames);
  record("sender page compresses a CSV with the browser's CompressionStream; receiver page unpacks it byte for byte", s.compression.used && s.K < plain.K / 2 && /deflate-raw/.test(s.zipText) && r.phase === "done" && r.result.sha256 === sha(csv) && r.result.compressed && /^yes/.test(r.zip) && /unpacked from/.test(r.note) && !s.errors.length && !r.errors.length,
    { K: s.K, KUncompressed: plain.K, zipText: s.zipText, plainZipText: plain.zipText, phase: r.phase, zip: r.zip, note: r.note, errors: [...s.errors, ...r.errors] });
  const noInflate = await receive(browser, s.frames, () => { delete window.DecompressionStream; });
  record("receiver without DecompressionStream explains clearly instead of failing silently", noInflate.phase === "cannot unpack" && /DecompressionStream/.test(noInflate.msg) && !noInflate.result && !noInflate.errors.length, { phase: noInflate.phase, msg: noInflate.msg, errors: noInflate.errors });
}
{
  const s = await send(browser, "log.csv", "text/csv", csv, { init: () => { delete window.CompressionStream; } });
  const r = await receive(browser, s.frames);
  record("sender without CompressionStream falls back to an uncompressed stream that still decodes", !s.compression.used && s.compression.reason === "unavailable" && /not available/.test(s.zipText) && r.phase === "done" && r.result.sha256 === sha(csv) && !r.result.compressed, { K: s.K, zipText: s.zipText, phase: r.phase, errors: [...s.errors, ...r.errors] });
}
if (fs.existsSync(JPEG)) {
  const jpg = fs.readFileSync(JPEG);
  const s = await send(browser, "photo.jpeg", "image/jpeg", jpg);
  const r = await receive(browser, s.frames);
  record("JPEG does not shrink: compression is skipped and said so", !s.compression.used && s.compression.reason === "no-gain" && /skipped/.test(s.zipText) && r.phase === "done" && r.result.sha256 === sha(jpg) && r.zip === "no", { K: s.K, zipText: s.zipText, phase: r.phase, errors: [...s.errors, ...r.errors] });
}
await browser.close();
const out = { when: new Date().toISOString(), browser: "headless Chrome via playwright-core, file:// pages", results, networkRequestsOutsideFileDataBlob: netViolations };
fs.writeFileSync(path.join(ROOT, "results", "compression_browser.json"), JSON.stringify(out, null, 1));
console.log("compression browser tests passed", results.filter((r) => r.ok).length, "/", results.length, "network violations:", netViolations.length);
if (netViolations.length || results.some((r) => !r.ok)) process.exitCode = 1;
