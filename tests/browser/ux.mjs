// Headless Chrome tests of interaction states, error paths and lifecycle (added in the 2026-11-01 full pass).
// Pages load from file:// with their real CSP; every page records network requests and page errors.
// Fixtures (QR frames, an H.264 video) are rendered here with the same code the pages use.
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
const WORK = path.join(ROOT, "work", "ux_" + Date.now().toString(36));
fs.mkdirSync(WORK, { recursive: true });
const sha = (b) => crypto.createHash("sha256").update(b).digest("hex");
const results = [], netViolations = [];
const url = (p) => "file://" + path.join(ROOT, p);
function record(name, ok, details = {}) { results.push({ name, ok, ...details }); console.log((ok ? "PASS " : "FAIL ") + name, JSON.stringify(details)); }
async function waitFor(page, fn, arg, timeout = 60000) {
  const end = Date.now() + timeout;
  for (;;) { if (await page.evaluate(fn, arg)) return true; if (Date.now() > end) return false; await new Promise((r) => setTimeout(r, 100)); }
}

async function renderSet(name, { size, label, bs = 400, frames, pass, startSeed = 0 }) {
  const dir = path.join(WORK, name); fs.mkdirSync(dir);
  const data = testFile(size, label);
  const s = await DQ.SenderSession.create({ name: name + ".bin", data, blockSize: bs, passphrase: pass, iterations: pass ? 100000 : undefined, startSeed });
  const files = [];
  for (let i = 0; i < (frames || Math.ceil(s.K * 1.6) + 6); i++) {
    const f = path.join(dir, `frame_${String(i).padStart(5, "0")}.png`);
    fs.writeFileSync(f, encodeGray(DQ.render.toGray(DQ.render.makeQr(s.nextText(), "M"), 4))); files.push(f);
  }
  return { dir, files, K: s.K, sha256: sha(data), fileIdHex: DQ.packet.hex(s.fileId) };
}
function qrPng(file, text) { fs.writeFileSync(file, encodeGray(DQ.render.toGray(DQ.render.makeQr(text, "M"), 4))); return file; }

async function open(browser, page, opts = {}) {
  const ctx = await browser.newContext({ acceptDownloads: true, viewport: opts.viewport || { width: 1280, height: 800 } });
  if (opts.init) await ctx.addInitScript(opts.init);
  const p = await ctx.newPage();
  const errors = [];
  p.on("pageerror", (e) => errors.push(e.message));
  p.on("request", (r) => { if (!/^(file:|data:|blob:)/.test(r.url())) netViolations.push({ page, url: r.url() }); });
  await p.goto(url(page));
  return { ctx, p, errors };
}
const rstate = (p) => p.evaluate(() => { const s = window.__dexqrReceiver; return { phase: s.phase, meta: !!s.session.meta, fileId: s.session.meta && s.session.meta.fileIdHex, received: s.session.decoder ? s.session.decoder.received : 0, frames: s.session.stats.frames, reasons: s.session.stats.reasons, foreign: s.session.stats.foreign, msg: document.getElementById("msg").textContent, msgRole: document.getElementById("msg").getAttribute("role"), start: document.getElementById("start").disabled, stop: document.getElementById("stop").disabled, stream: !!s.stream, running: s.running, videoPoll: s.videoPoll, result: s.result, downloads: document.querySelectorAll("#download").length, switchVisible: !document.getElementById("switchbox").hidden, reset: document.getElementById("reset").textContent, videoSrc: document.getElementById("video").getAttribute("src") }; });

async function main() {
  const browser = await chromium.launch({ executablePath: CHROME, headless: true });
  const main10 = await renderSet("main", { size: 10240, label: "ux-main", startSeed: 1000 });
  const other = await renderSet("other", { size: 3000, label: "ux-other", frames: 3 });
  const enc = await renderSet("enc", { size: 6000, label: "ux-enc", pass: "orbit lantern quiet mosaic thunder" });
  const sample = path.join(WORK, "sample.bin"); fs.writeFileSync(sample, testFile(20000, "ux-sample"));

  // ---- sender ----
  {
    const { ctx, p, errors } = await open(browser, "sender.html");
    await p.setInputFiles("#file", sample); await p.evaluate(() => { const d = document.getElementById("tuning"); if (d) d.open = true; });   // cycle 6: settings live in the Tuning disclosure
    await p.click("#prepare");
    await waitFor(p, () => !!window.__dexqrSender.session && !document.getElementById("prepare").disabled);
    const rates = {};
    for (const f of [8, 25]) {
      await p.fill("#fps", String(f)); await p.dispatchEvent("#fps", "change");
      await p.click("#play"); await p.waitForTimeout(500);
      const a = await p.evaluate(() => [window.__dexqrSender.sent, performance.now()]);
      await p.waitForTimeout(6000);
      const b = await p.evaluate(() => [window.__dexqrSender.sent, performance.now()]);
      await p.click("#play");
      rates[f] = +((1000 * (b[0] - a[0])) / (b[1] - a[1])).toFixed(2);
    }
    record("sender frame clock matches the set rate (8 and 25 fps, within 3%)", Math.abs(rates[8] - 8) / 8 < 0.03 && Math.abs(rates[25] - 25) / 25 < 0.03, { measured: rates, before: "8 fps measured 7.50 with the old scheduler" });

    await p.fill("#fps", "99"); await p.dispatchEvent("#fps", "change");
    const fpsVal = await p.inputValue("#fps");
    await p.fill("#px", "-3"); await p.dispatchEvent("#px", "change");
    record("sender clamps speed and module size inputs", fpsVal === "30" && (await p.inputValue("#px")) === "0", { fps: fpsVal, px: await p.inputValue("#px") });

    await p.selectOption("#bs", "600");
    const stale = { msg: await p.textContent("#msg"), btn: await p.textContent("#prepare") };
    await p.selectOption("#ecl", "Q");
    const qrInfo = await p.textContent("#s-qr");
    await p.click("#prepare"); await waitFor(p, () => !document.getElementById("prepare").disabled && /Ready/.test(document.getElementById("msg").textContent));
    const after = { msg: await p.textContent("#msg"), btn: await p.textContent("#prepare"), k: await p.textContent("#s-k") };
    record("sender flags stale settings, applies EC level live, Prepare clears the flag", /Settings changed/.test(stale.msg) && /apply/.test(stale.btn) && /EC Q/.test(qrInfo) && after.btn === "Prepare" && /× 600 bytes/.test(after.k), { stale, qrInfo, after });

    await p.focus("body"); await p.evaluate(() => document.activeElement && document.activeElement.blur());
    await p.keyboard.press("Space"); const k1 = await p.evaluate(() => window.__dexqrSender.playing);
    await p.keyboard.press("k"); const k2 = await p.evaluate(() => window.__dexqrSender.playing);
    await p.focus("#pass"); await p.keyboard.press("Space"); const k3 = await p.evaluate(() => window.__dexqrSender.playing);
    record("sender keyboard: Space/K toggle play, typing in a field does not", k1 === true && k2 === false && k3 === false, { k1, k2, k3, pressed: await p.getAttribute("#play", "aria-pressed") });
    record("sender page errors", errors.length === 0, { errors });
    await ctx.close();
  }
  {
    // Full screen fallback where the Fullscreen API is missing (as on iPhone Safari).
    const { ctx, p, errors } = await open(browser, "sender.html", { viewport: { width: 390, height: 844 }, init: () => { delete Element.prototype.requestFullscreen; } });
    await p.setInputFiles("#file", sample); await p.click("#prepare");
    await waitFor(p, () => !!window.__dexqrSender.session && !document.getElementById("prepare").disabled);
    await p.click("#fs");
    const inFocus = await p.evaluate(() => { const r = document.getElementById("qr").getBoundingClientRect(); return { focus: document.getElementById("stage").classList.contains("focus"), fits: r.bottom <= innerHeight && r.right <= innerWidth && r.width > 300, w: r.width, h: r.height, bar: !document.getElementById("stagebar").hidden, active: document.activeElement.id }; });
    await p.keyboard.press("Escape");
    const out = await p.evaluate(() => ({ focus: document.getElementById("stage").classList.contains("focus"), active: document.activeElement.id }));
    record("sender full-screen fallback (focus mode) fits the code on a phone and Esc leaves it", inFocus.focus && inFocus.fits && inFocus.bar && !out.focus && out.active === "fs", { inFocus, out, errors });
    const overflow = await p.evaluate(() => document.documentElement.scrollWidth <= innerWidth);
    record("sender has no horizontal overflow at 390 px", overflow);
    await ctx.close();
  }

  // ---- receiver: error paths ----
  {
    const { ctx, p, errors } = await open(browser, "receiver.html", { init: () => { if (navigator.mediaDevices) navigator.mediaDevices.getUserMedia = () => Promise.reject(new DOMException("Permission denied", "NotAllowedError")); } });
    await p.click("#start"); await waitFor(p, () => document.getElementById("msg").textContent.length > 0);
    const st = await rstate(p);
    record("receiver: camera permission denied gives a plain explanation and stays usable", /permission was denied/.test(st.msg) && st.msgRole === "alert" && !st.start && st.stop && !st.stream, { msg: st.msg, errors });
    await ctx.close();
  }
  {
    const { ctx, p, errors } = await open(browser, "receiver.html", { init: () => { Object.defineProperty(Navigator.prototype, "mediaDevices", { get: () => undefined }); } });
    await p.click("#start");
    const st = await rstate(p);
    record("receiver: no camera API explains file:// and file input fallback", /does not offer camera access/.test(st.msg) && errors.length === 0, { msg: st.msg, phase: st.phase, errors });
    await ctx.close();
  }
  {
    const { ctx, p, errors } = await open(browser, "receiver.html", { init: () => { delete window.BarcodeDetector; } });
    await p.click("details.opts summary"); await p.selectOption("#dec", "native");
    await p.setInputFiles("#files", main10.files.slice(0, 3));
    await waitFor(p, () => document.getElementById("msg").textContent.length > 0);
    const st = await rstate(p);
    const inputOk = await p.evaluate(() => !document.getElementById("files").disabled);
    record("receiver: unsupported decoder in file mode is an error message, not an unhandled rejection", /no BarcodeDetector/.test(st.msg) && inputOk && errors.length === 0, { msg: st.msg, errors });
    await ctx.close();
  }
  {
    const { ctx, p, errors } = await open(browser, "receiver.html");
    await p.click("details.opts summary"); await p.selectOption("#dec", "zxing");
    const foreign = [qrPng(path.join(WORK, "foreign1.png"), "HTTPS://EXAMPLE.COM/"), qrPng(path.join(WORK, "foreign2.png"), "HELLO WORLD")];
    const forged = DQ.packet.packetToText(DQ.packet.buildPacket({ version: 2, encrypted: false, fileId: new Uint8Array(8).fill(9), K: 16777215, blockSize: 1, length: 16777215 }, 1, new Uint8Array(1)));
    const huge = qrPng(path.join(WORK, "huge.png"), forged);
    const t0 = Date.now();
    await p.setInputFiles("#files", [...foreign, huge]);
    await waitFor(p, () => window.__dexqrReceiver.phase === "no Dex_QR codes found");
    const st = await rstate(p); const secs = (Date.now() - t0) / 1000;
    await p.setInputFiles("#files", foreign);
    await waitFor(p, (n) => window.__dexqrReceiver.session.stats.frames > n, st.frames, 20000);
    const st2 = await rstate(p);
    record("receiver: non-Dex_QR codes and a forged huge-K frame are ignored quickly; the same files can be picked again", st.foreign === 2 && st.reasons.limits === 1 && !st.meta && /none from a Dex_QR stream/.test(st.msg) && secs < 15 && st2.frames === st.frames + 2 && errors.length === 0, { foreign: st.foreign, reasons: st.reasons, msg: st.msg, seconds: secs, framesThenAgain: [st.frames, st2.frames], errors });
    await ctx.close();
  }

  // ---- receiver: stale lock -> switch to the transfer on screen ----
  {
    const { ctx, p, errors } = await open(browser, "receiver.html");
    await p.click("details.opts summary"); await p.selectOption("#dec", "zxing");
    await p.setInputFiles("#files", [...other.files.slice(0, 2), ...main10.files.map((f, i) => { const c = path.join(WORK, "main", `z_${String(i).padStart(5, "0")}.png`); fs.copyFileSync(f, c); return c; })]);
    await waitFor(p, () => ["incomplete", "done"].includes(window.__dexqrReceiver.phase));
    const before = await rstate(p);
    await p.click("#switch");
    await waitFor(p, () => window.__dexqrReceiver.phase === "done", null, 30000);
    const after = await rstate(p);
    const dlP = p.waitForEvent("download"); await p.click("#download"); const dl = await dlP; const fp = path.join(WORK, "switch.bin"); await dl.saveAs(fp);
    record("receiver: locked onto a stale transfer, offers a switch, and the switch completes from buffered packets", before.fileId === other.fileIdHex && before.switchVisible && after.fileId === main10.fileIdHex && after.phase === "done" && sha(fs.readFileSync(fp)) === main10.sha256 && errors.length === 0, { before: { fileId: before.fileId, phase: before.phase, switchVisible: before.switchVisible }, after: { fileId: after.fileId, phase: after.phase, received: after.received }, errors });
    await ctx.close();
  }

  // ---- receiver: reset asks before discarding progress ----
  {
    const { ctx, p, errors } = await open(browser, "receiver.html");
    await p.click("details.opts summary"); await p.selectOption("#dec", "zxing");
    await p.setInputFiles("#files", main10.files.slice(0, 8));
    await waitFor(p, () => window.__dexqrReceiver.phase === "incomplete");
    await p.click("#reset"); const armed = await rstate(p);
    await p.keyboard.press("Escape"); const disarmed = await rstate(p);
    await p.click("#reset"); await p.click("#reset"); const cleared = await rstate(p);
    record("receiver: Reset with partial progress asks first; Esc cancels; second press discards", armed.meta && /Discard 8 received packets/.test(armed.reset) && disarmed.reset === "Reset" && disarmed.meta && !cleared.meta && cleared.phase === "idle" && errors.length === 0, { armed: armed.reset, disarmed: disarmed.reset, clearedPhase: cleared.phase, errors });
    await ctx.close();
  }

  // ---- receiver: encrypted, double-clicked Decrypt ----
  {
    const { ctx, p, errors } = await open(browser, "receiver.html");
    await p.click("details.opts summary"); await p.selectOption("#dec", "zxing");
    await p.setInputFiles("#files", enc.files);
    await waitFor(p, () => window.__dexqrReceiver.phase === "needs passphrase");
    await p.fill("#pass", "orbit lantern quiet mosaic thunder");
    await p.evaluate(() => { const b = document.getElementById("decrypt"); b.click(); b.click(); document.getElementById("passbox").requestSubmit(); });
    await waitFor(p, () => window.__dexqrReceiver.phase === "done" || window.__dexqrReceiver.phase === "error");
    await p.waitForTimeout(1500);
    const st = await rstate(p);
    const focus = await p.evaluate(() => document.activeElement.id);
    record("receiver: repeated Decrypt presses run one derivation and give one result; focus moves to Save", st.phase === "done" && st.downloads === 1 && st.result.sha256 === enc.sha256 && focus === "download" && errors.length === 0, { phase: st.phase, downloads: st.downloads, focus, errors });
    await ctx.close();
  }

  // ---- receiver: video file input, then lifecycle cleanup ----
  {
    const mp4 = path.join(WORK, "main.mp4");
    const r = spawnSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-framerate", "8", "-i", path.join(main10.dir, "frame_%05d.png"), "-vf", "pad=ceil(iw/2)*2:ceil(ih/2)*2:color=white,format=yuv420p", "-c:v", "libx264", "-crf", "18", mp4], { encoding: "utf8" });
    if (r.status !== 0) throw new Error(r.stderr);
    const { ctx, p, errors } = await open(browser, "receiver.html");
    await p.click("details.opts summary"); await p.selectOption("#dec", "zxing");
    await p.setInputFiles("#files", mp4);
    const done = await waitFor(p, () => ["done", "incomplete"].includes(window.__dexqrReceiver.phase), null, 120000);
    await p.waitForTimeout(600);
    const st = await rstate(p);
    record("receiver: H.264 video file decodes; the poll timer, object URL and video source are released", done && st.phase === "done" && st.result.sha256 === main10.sha256 && st.videoPoll === null && !st.videoSrc && !st.running && errors.length === 0, { phase: st.phase, videoPoll: st.videoPoll, videoSrc: st.videoSrc, running: st.running, errors });
    await ctx.close();
  }

  // ---- layout ----
  {
    const { ctx, p } = await open(browser, "receiver.html", { viewport: { width: 390, height: 844 } });
    const lay = await p.evaluate(() => ({ videoTop: document.getElementById("video").getBoundingClientRect().top, startTop: document.getElementById("start").getBoundingClientRect().top, overflow: document.documentElement.scrollWidth > innerWidth, minTarget: Math.min(...[...document.querySelectorAll("button:not([hidden])")].filter((b) => b.offsetParent).map((b) => b.getBoundingClientRect().height)) }));
    record("receiver at 390 px: camera view first, no horizontal overflow, buttons ≥ 44 px tall", lay.videoTop < lay.startTop && !lay.overflow && lay.minTarget >= 44, lay);
    await ctx.close();
  }
  await browser.close();

  // ---- receiver camera: track ends mid-scan (unplugged / permission revoked) ----
  {
    const y4m = path.join(WORK, "main.y4m");
    spawnSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-framerate", "2", "-i", path.join(main10.dir, "frame_%05d.png"), "-frames:v", "20", "-vf", "pad=ceil(iw/2)*2:ceil(ih/2)*2:color=white,format=yuv420p", y4m]);
    const b2 = await chromium.launch({ executablePath: CHROME, headless: true, args: ["--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream", `--use-file-for-fake-video-capture=${y4m}`] });
    const { ctx, p, errors } = await open(b2, "receiver.html");
    await p.click("details.opts summary"); await p.selectOption("#dec", "zxing");
    await p.click("#start");
    await waitFor(p, () => window.__dexqrReceiver.session.stats.qrTexts >= 3, null, 60000);
    const mid = await rstate(p);
    await p.evaluate(() => window.__dexqrReceiver.stream.getVideoTracks()[0].dispatchEvent(new Event("ended")));
    await p.waitForTimeout(300);
    const st = await rstate(p);
    await p.click("#start");
    await waitFor(p, () => !!window.__dexqrReceiver.stream && window.__dexqrReceiver.running, null, 20000);
    const again = await rstate(p);
    await p.click("#stop");
    const stopped = await rstate(p);
    record("receiver: camera ending mid-scan keeps progress and explains; Start resumes; Stop releases", mid.meta && /camera stopped/.test(st.msg) && !st.stream && !st.start && st.meta && again.stream && again.received >= st.received && !stopped.stream && /Progress is kept/.test(stopped.msg) && errors.length === 0, { afterEnd: { msg: st.msg, phase: st.phase, received: st.received }, resumed: again.stream, stoppedMsg: stopped.msg, errors });
    await ctx.close(); await b2.close();
  }

  const out = { when: new Date().toISOString(), results, networkRequestsOutsideFileDataBlob: netViolations };
  fs.writeFileSync(path.join(ROOT, "results", "ux.json"), JSON.stringify(out, null, 1));
  console.log("ux tests passed", results.filter((r) => r.ok).length, "/", results.length, "network violations:", netViolations.length);
  if (netViolations.length || results.some((r) => !r.ok)) process.exitCode = 1;
}
main().catch((e) => { console.error(e); process.exit(1); });
