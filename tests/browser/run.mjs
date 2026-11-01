// Headless Chrome tests of the built single-file pages, loaded from file://.
//  1. sender.html: pick a file, prepare, render frames from the page's own canvas -> zbar -> ReceiverSession -> SHA-256
//  2. receiver.html (jsQR inside the page) fed PNG frames via its file input, random start + 30% drops, 10 KB and 100 KB
//  3. receiver.html encrypted flow: needs passphrase -> wrong passphrase -> right passphrase
//  4. receiver.html checksum-mismatch flow with forged (CRC-valid, wrong-content) frames
//  5. receiver.html camera path: getUserMedia with Chrome's fake camera playing a Y4M of the sender frames
// Every page records all network requests; anything other than file:, data:, blob: fails the run.
import { chromium } from "playwright-core";
import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
const require = createRequire(import.meta.url);
const DQ = require("../lib/load.cjs").load();
const { encodeGray } = require("../lib/png.cjs");
const { testFile } = require("../lib/testfile.cjs");
const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..", "..");
const CHROME = process.env.CHROME || "/usr/bin/google-chrome";
const PY = process.env.PY || "python3";
const WORK = path.join(ROOT, "work", "browser_" + Date.now().toString(36));
fs.mkdirSync(WORK, { recursive: true });
const sha = (b) => crypto.createHash("sha256").update(b).digest("hex");
const results = [];
const netViolations = [];
let rs = 4242;
const rand = () => { rs = (rs + 0x6d2b79f5) | 0; let t = Math.imul(rs ^ (rs >>> 15), 1 | rs); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
function record(name, ok, details) { results.push({ name, ok, ...details }); console.log((ok ? "PASS " : "FAIL ") + name, JSON.stringify(details)); }
function watchNet(page, label) {
  page.on("request", (r) => { const u = r.url(); if (!/^(file:|data:|blob:)/.test(u)) netViolations.push({ page: label, url: u }); });
}
// Poll with page.evaluate instead of page.waitForFunction: the pages' CSP forbids eval, which
// waitForFunction's polling relies on, and we test the pages with their real CSP (no bypassCSP).
async function waitFor(page, fn, arg, { timeout = 60000 } = {}) {
  const end = Date.now() + timeout;
  for (;;) {
    if (await page.evaluate(fn, arg)) return;
    if (Date.now() > end) throw new Error("waitFor timeout");
    await new Promise((r) => setTimeout(r, 100));
  }
}
// The decoder and file inputs live in a <details> disclosure since the 2026-11-01 pass; open it like a user would.
async function openOptions(page) { await page.click("details.opts summary"); }
function fileUrl(p) { return "file://" + path.join(ROOT, p); }

async function senderTest(browser, { size, pass, bs = 400, ecl = "M" }) {
  const name = `sender page ${size} B${pass ? " encrypted" : ""} -> zbar -> decoder`;
  const ctx = await browser.newContext({ acceptDownloads: true });
  const page = await ctx.newPage(); watchNet(page, "sender");
  const errors = []; page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(fileUrl("sender.html"));
  const data = testFile(size, "browser-sender");
  const inFile = path.join(WORK, `in_${size}.bin`); fs.writeFileSync(inFile, data);
  await page.setInputFiles("#file", inFile);
  await page.selectOption("#bs", String(bs)); await page.selectOption("#ecl", ecl);
  await page.fill("#px", "4");
  if (pass) await page.fill("#pass", pass);
  await page.click("#prepare");
  await waitFor(page, () => window.__dexqrSender.session && !document.getElementById("prepare").disabled, null, { timeout: 60000 });
  const K = await page.evaluate(() => window.__dexqrSender.session.K);
  const shownSha = await page.textContent("#s-sha");
  const dirF = path.join(WORK, `sender_${size}${pass ? "_enc" : ""}`); fs.mkdirSync(dirF);
  const n = Math.ceil(K * 1.6) + 8;
  for (let i = 0; i < n; i++) {
    const url = await page.evaluate(() => window.__dexqrSender.renderNextForTest());
    fs.writeFileSync(path.join(dirF, `frame_${String(i).padStart(5, "0")}.png`), Buffer.from(url.split(",")[1], "base64"));
  }
  const qrInfo = await page.textContent("#s-qr");
  spawnSync(PY, ["tests/e2e/decode_frames.py", dirF, "--decoder", "zbar"], { cwd: ROOT, encoding: "utf8" });
  const dec = JSON.parse(fs.readFileSync(path.join(dirF, "decoded_zbar.json")));
  const r = new DQ.ReceiverSession();
  let used = 0;
  for (const f of dec.frames) { used++; f.texts.forEach((t) => r.addText(t)); if (r.done) break; }
  let ok = false, err = null;
  try { const out = await r.open(pass); ok = sha(out.data) === sha(data) && shownSha === sha(data); } catch (e) { err = e.code || e.message; }
  record(name, ok && errors.length === 0, { K, framesRendered: n, framesDecodedByZbar: dec.summary.decoded, framesUsed: used, qr: qrInfo, err, pageErrors: errors });
  await ctx.close();
}

function pickFrames(dir, p) {
  const man = JSON.parse(fs.readFileSync(path.join(dir, "manifest.json")));
  const start = Math.floor(rand() * man.K);
  const sel = [];
  for (let i = start; i < man.frames && sel.length < Math.ceil(man.K * 1.5) + 10; i++) if (rand() >= p) sel.push(path.join(dir, `frame_${String(i).padStart(5, "0")}.png`));
  return { man, start, sel };
}

async function receiverFilesTest(browser, dir, p, label, opts = {}) {
  const ctx = await browser.newContext({ acceptDownloads: true });
  const page = await ctx.newPage(); watchNet(page, "receiver");
  const errors = []; page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(fileUrl("receiver.html"));
  await openOptions(page);
  await page.selectOption("#dec", opts.engine || "auto");
  const { man, start, sel } = opts.frames ? { man: JSON.parse(fs.readFileSync(path.join(dir, "manifest.json"))), start: 0, sel: opts.frames } : pickFrames(dir, p);
  const t0 = Date.now();
  await page.setInputFiles("#files", sel);
  const want = opts.expectPhase || "done";
  await waitFor(page, (w) => { const s = window.__dexqrReceiver; return s.phase === w || ["done", "checksum mismatch", "needs passphrase", "incomplete", "error"].includes(s.phase); }, want, { timeout: 300000 });
  let phase = await page.evaluate(() => window.__dexqrReceiver.phase);
  const extra = {};
  if (opts.wrongPass) {
    await page.fill("#pass", opts.wrongPass); await page.click("#decrypt");
    await waitFor(page, () => window.__dexqrReceiver.phase === "wrong passphrase" || window.__dexqrReceiver.phase === "done", null, { timeout: 60000 });
    extra.afterWrong = await page.evaluate(() => window.__dexqrReceiver.phase);
    extra.wrongMsg = await page.textContent("#msg");
    await page.fill("#pass", opts.rightPass); await page.click("#decrypt");
    await waitFor(page, () => window.__dexqrReceiver.phase === "done" || window.__dexqrReceiver.phase === "wrong passphrase", null, { timeout: 60000 });
    phase = await page.evaluate(() => window.__dexqrReceiver.phase);
    extra.afterRight = phase;
  }
  const st = await page.evaluate(() => ({ r: window.__dexqrReceiver.result, frames: window.__dexqrReceiver.session.stats.frames, received: window.__dexqrReceiver.session.decoder && window.__dexqrReceiver.session.decoder.received, msg: document.getElementById("msg").textContent, dec: window.__dexqrReceiver.decoderName }));
  let ok, dlSha = null;
  if (want === "done") {
    const dlP = page.waitForEvent("download");
    await page.click("#download");
    const dl = await dlP; const fp = path.join(WORK, "dl_" + Date.now()); await dl.saveAs(fp);
    dlSha = sha(fs.readFileSync(fp));
    ok = phase === "done" && st.r && st.r.sha256 === man.sha256 && dlSha === man.sha256 && (!opts.wrongPass || extra.afterWrong === "wrong passphrase");
  } else ok = phase === want;
  record(label, ok && errors.length === 0, { K: man.K, drop: p, start, framesGiven: sel.length, framesScanned: st.frames, packetsUsed: st.received, overhead: st.received ? +(st.received / man.K).toFixed(3) : null, phase, decoder: st.dec, downloadSha256Matches: dlSha ? dlSha === man.sha256 : null, message: st.msg, seconds: (Date.now() - t0) / 1000, ...extra, pageErrors: errors });
  await ctx.close();
}

async function cameraTest(dir, label, fps = 5, maxFrames = 0, engine = "auto") {
  const man = JSON.parse(fs.readFileSync(path.join(dir, "manifest.json")));
  const y4m = path.join(WORK, path.basename(dir) + ".y4m");
  const n = maxFrames || man.frames;
  const r = spawnSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-framerate", String(fps), "-i", path.join(dir, "frame_%05d.png"), "-frames:v", String(n), "-vf", "pad=ceil(iw/2)*2:ceil(ih/2)*2:color=white,format=yuv420p", y4m], { encoding: "utf8" });
  if (r.status !== 0) throw new Error(r.stderr);
  const browser = await chromium.launch({ executablePath: CHROME, headless: true, args: ["--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream", `--use-file-for-fake-video-capture=${y4m}`] });
  const ctx = await browser.newContext({ acceptDownloads: true });
  const page = await ctx.newPage(); watchNet(page, "receiver-camera");
  const errors = []; page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(fileUrl("receiver.html"));
  await openOptions(page);
  await page.selectOption("#dec", engine);
  const t0 = Date.now();
  await page.click("#start");
  let phase = "timeout";
  try {
    await waitFor(page, () => ["done", "checksum mismatch", "error"].includes(window.__dexqrReceiver.phase), null, { timeout: Math.max(120000, (n / fps) * 3000) });
    phase = await page.evaluate(() => window.__dexqrReceiver.phase);
  } catch (e) { phase = await page.evaluate(() => window.__dexqrReceiver.phase + " (timeout)"); }
  const st = await page.evaluate(() => ({ dec: window.__dexqrReceiver.decoderName, r: window.__dexqrReceiver.result, frames: window.__dexqrReceiver.session.stats.frames, qr: window.__dexqrReceiver.session.stats.qrTexts, received: window.__dexqrReceiver.session.decoder && window.__dexqrReceiver.session.decoder.received, dups: window.__dexqrReceiver.session.stats.duplicates, msg: document.getElementById("msg").textContent, cam: document.getElementById("cam").options.length }));
  const ok = phase === "done" && st.r && st.r.sha256 === man.sha256;
  record(label, ok && errors.length === 0, { decoder: st.dec, K: man.K, y4mFrames: n, fakeCameraFps: fps, cameraFramesScanned: st.frames, qrRead: st.qr, uniquePackets: st.received, duplicates: st.dups, overhead: st.received ? +(st.received / man.K).toFixed(3) : null, phase, seconds: (Date.now() - t0) / 1000, message: st.msg, pageErrors: errors });
  await browser.close();
}

async function main() {
  const browser = await chromium.launch({ executablePath: CHROME, headless: true });
  const version = browser.version();
  // 1. sender page
  await senderTest(browser, { size: 10240 });
  await senderTest(browser, { size: 102400 });
  await senderTest(browser, { size: 20000, pass: "orbit lantern quiet mosaic thunder" });
  // 2. receiver page, file mode, jsQR in the page
  for (const engine of ["zxing", "jsqr"]) {
    for (const p of [0.1, 0.3, 0.5]) await receiverFilesTest(browser, path.join(ROOT, "work/drop_10240"), p, `receiver page files 10 KB drop ${p * 100}% (${engine})`, { engine });
    await receiverFilesTest(browser, path.join(ROOT, "work/drop_102400"), 0.3, `receiver page files 100 KB drop 30% (${engine})`, { engine });
  }
  await receiverFilesTest(browser, path.join(ROOT, "work/drop_512000"), 0.5, "receiver page files 500 KB drop 50% (auto)", { engine: "auto" });
  // 3. encrypted flow
  const encDir = path.join(WORK, "enc_frames");
  spawnSync("node", ["tests/e2e/render-frames.mjs", "--size", "15000", "--bs", "400", "--ecl", "M", "--scale", "4", "--out", encDir, "--pass", "orbit lantern quiet mosaic thunder"], { cwd: ROOT });
  await receiverFilesTest(browser, encDir, 0.3, "receiver page encrypted: wrong then right passphrase", { expectPhase: "done", wrongPass: "orbit lantern quiet mosaic thundeR", rightPass: "orbit lantern quiet mosaic thunder" });
  // 4. checksum mismatch with forged frames
  const forgeDir = path.join(WORK, "forged"); fs.mkdirSync(forgeDir);
  const real = await DQ.SenderSession.create({ name: "x.bin", data: testFile(8000, "real"), blockSize: 400 });
  const evil = await DQ.SenderSession.create({ name: "x.bin", data: testFile(8000, "evil"), blockSize: 400 });
  const forged = [];
  for (let i = 0; i < 60; i++) {
    const t = DQ.packet.packetToText(DQ.packet.buildPacket(real.meta, i, evil.encoder.encode(i)));
    const f = path.join(forgeDir, `frame_${String(i).padStart(5, "0")}.png`); fs.writeFileSync(f, encodeGray(DQ.render.toGray(DQ.render.makeQr(t, "M"), 4))); forged.push(f);
  }
  fs.writeFileSync(path.join(forgeDir, "manifest.json"), JSON.stringify({ K: real.K, frames: 60, sha256: "n/a" }));
  await receiverFilesTest(browser, forgeDir, 0, "receiver page checksum mismatch is reported (forged frames)", { expectPhase: "checksum mismatch", frames: forged });
  await browser.close();
  // 5. camera path with Chrome's fake camera
  await cameraTest(path.join(ROOT, "work/drop_10240"), "receiver page camera (getUserMedia, fake camera Y4M) 10 KB, auto", 5);
  await cameraTest(path.join(ROOT, "work/drop_10240"), "receiver page camera (getUserMedia, fake camera Y4M) 10 KB, jsQR", 5, 0, "jsqr");
  await cameraTest(path.join(ROOT, "work/drop_102400"), "receiver page camera (getUserMedia, fake camera Y4M) 100 KB, auto", 10, 700);
  const out = { chrome: version, when: new Date().toISOString(), results, networkRequestsOutsideFileDataBlob: netViolations };
  fs.writeFileSync(path.join(ROOT, "results", "browser.json"), JSON.stringify(out, null, 1));
  console.log("chrome", version, "network violations:", netViolations.length, "passed", results.filter((r) => r.ok).length, "/", results.length);
  if (netViolations.length || results.some((r) => !r.ok)) process.exitCode = 1;
}
main().catch((e) => { console.error(e); process.exit(1); });
