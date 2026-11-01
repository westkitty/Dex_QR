// Long-session lifecycle check: the sender plays at 30 fps and the receiver scans a fake camera for
// SOAK_SECONDS each (default 60); JS heap is sampled after forced GC at the start and the end.
// Also checks the receiver keeps exactly one camera stream after repeated Start/Stop/camera changes.
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
const CHROME = process.env.CHROME || "/usr/bin/google-chrome";
const SECS = Number(process.env.SOAK_SECONDS || 60);
const WORK = path.join(ROOT, "work", "soak_" + Date.now().toString(36)); fs.mkdirSync(WORK, { recursive: true });
const results = [];
const record = (name, ok, d) => { results.push({ name, ok, ...d }); console.log((ok ? "PASS " : "FAIL ") + name, JSON.stringify(d)); };
async function heapMB(page) {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("HeapProfiler.collectGarbage");
  const { usedSize } = await cdp.send("Runtime.getHeapUsage");
  return +(usedSize / 1048576).toFixed(1);
}

// Sender: 2 MB file, 30 fps.
{
  const b = await chromium.launch({ executablePath: CHROME, headless: true });
  const p = await b.newPage(); const errors = []; p.on("pageerror", (e) => errors.push(e.message));
  await p.goto("file://" + path.join(ROOT, "sender.html"));
  const f = path.join(WORK, "big.bin"); fs.writeFileSync(f, testFile(2 * 1024 * 1024, "soak"));
  await p.setInputFiles("#file", f); await p.evaluate(() => { const d = document.getElementById("tuning"); if (d) d.open = true; });   // cycle 6: settings live in the Tuning disclosure
  await p.fill("#fps", "30"); await p.dispatchEvent("#fps", "change");
  await p.click("#prepare");
  for (let i = 0; i < 100 && !(await p.evaluate(() => !!window.__dexqrSender.session)); i++) await p.waitForTimeout(100);
  await p.click("#play"); await p.waitForTimeout(3000);
  const h0 = await heapMB(p), s0 = await p.evaluate(() => window.__dexqrSender.sent);
  await p.waitForTimeout(SECS * 1000);
  const h1 = await heapMB(p), s1 = await p.evaluate(() => window.__dexqrSender.sent);
  record(`sender plays ${SECS} s at 30 fps without heap growth`, h1 - h0 < 5 && errors.length === 0, { heapMB: [h0, h1], frames: s1 - s0, fps: +((s1 - s0) / SECS).toFixed(2), errors });
  await b.close();
}

// Cycle 9: the sender keeps streaming at 30 fps while "Confirm with camera" scans a fake camera that shows only
// codes it must ignore (another app's QR, another transfer's Done code), for SECS (under its 2-minute limit).
{
  const fr = (text, i) => { const { frame } = require("../lib/synthframe.cjs"); const f = frame({ w: 640, h: 480, qr: DQ.render.toGray(DQ.render.makeQr(text, "M"), 1), scale: 6, seed: i + 1, noise: 2 }); const g = new Uint8Array(f.width * f.height); for (let k = 0; k < g.length; k++) g[k] = f.data[k * 4]; return { width: f.width, height: f.height, data: g }; };
  const other = new Uint8Array(8).fill(7);
  const dir = path.join(WORK, "ackcam"); fs.mkdirSync(dir);
  for (let i = 0; i < 8; i++) fs.writeFileSync(path.join(dir, `f_${i}.png`), encodeGray(fr(i % 2 ? "HELLO FROM ANOTHER APP" : DQ.ack.build(other), i)));
  const y4 = path.join(WORK, "ackcam.y4m");
  spawnSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-framerate", "4", "-i", path.join(dir, "f_%d.png"), "-pix_fmt", "yuv420p", y4]);
  const b = await chromium.launch({ executablePath: CHROME, headless: true, args: ["--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream", `--use-file-for-fake-video-capture=${y4}`] });
  const p = await b.newPage(); const errors = []; p.on("pageerror", (e) => errors.push(e.message));
  await p.goto("file://" + path.join(ROOT, "sender.html"));
  const f = path.join(WORK, "tiny.bin"); fs.writeFileSync(f, testFile(3000, "soak-ack"));
  await p.setInputFiles("#file", f); await p.evaluate(() => { document.getElementById("tuning").open = true; });
  await p.fill("#fps", "30"); await p.dispatchEvent("#fps", "change");
  await p.click("#play");
  for (let i = 0; i < 100 && (await p.evaluate(() => document.getElementById("finish-confirm").hidden)); i++) await p.waitForTimeout(100);
  await p.click("#finish-confirm"); await p.waitForTimeout(3000);
  const st = () => p.evaluate(() => { const s = window.__dexqrSender; return { sent: s.sent, scans: s.ack.scans || 0, cam: !!s.ack.stream, confirmed: s.confirmed, tracks: s.ack.stream ? s.ack.stream.getVideoTracks().filter((t) => t.readyState === "live").length : 0 }; });
  const h0 = await heapMB(p), a0 = await st();
  const secs = Math.min(SECS, 100);
  await p.waitForTimeout(secs * 1000);
  const h1 = await heapMB(p), a1 = await st();
  await p.click("#ackcam-cancel"); await p.waitForTimeout(300);
  const off = await st();
  record(`sender streams ${secs} s at 30 fps while Confirm with camera scans, without heap growth; Stop the camera releases it`, h1 - h0 < 5 && a1.cam && a1.tracks === 1 && !a1.confirmed && (a1.sent - a0.sent) / secs > 29 && !off.cam && errors.length === 0, { heapMB: [h0, h1], fps: +((a1.sent - a0.sent) / secs).toFixed(2), scansPerSec: +((a1.scans - a0.scans) / secs).toFixed(2), liveTracks: a1.tracks, afterStop: off.cam, errors });
  await b.close();
}

// Receiver: fake camera showing a QR that is not ours (it never completes, so it scans the whole time).
{
  const frames = path.join(WORK, "cam"); fs.mkdirSync(frames);
  for (let i = 0; i < 10; i++) fs.writeFileSync(path.join(frames, `f_${i}.png`), encodeGray(DQ.render.toGray(DQ.render.makeQr("HELLO " + i, "M"), 8)));
  const y4m = path.join(WORK, "cam.y4m");
  spawnSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-framerate", "10", "-i", path.join(frames, "f_%d.png"), "-vf", "scale=640:640,format=yuv420p", y4m]);
  const b = await chromium.launch({ executablePath: CHROME, headless: true, args: ["--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream", `--use-file-for-fake-video-capture=${y4m}`] });
  const p = await b.newPage(); const errors = []; p.on("pageerror", (e) => errors.push(e.message));
  await p.goto("file://" + path.join(ROOT, "receiver.html"));
  await p.click("details.opts summary"); await p.selectOption("#dec", "zxing");
  await p.click("#start");
  for (let i = 0; i < 100 && !(await p.evaluate(() => window.__dexqrReceiver.running)); i++) await p.waitForTimeout(100);
  await p.waitForTimeout(3000);
  const h0 = await heapMB(p), f0 = await p.evaluate(() => window.__dexqrReceiver.session.stats.frames);
  await p.waitForTimeout(SECS * 1000);
  const h1 = await heapMB(p), f1 = await p.evaluate(() => window.__dexqrReceiver.session.stats.frames);
  const mid = await p.evaluate(() => ({ phase: window.__dexqrReceiver.phase, running: window.__dexqrReceiver.running, msg: document.getElementById("msg").textContent, stop: document.getElementById("stop").disabled }));
  console.log("receiver after soak:", JSON.stringify(mid));
  // Start/Stop and camera re-selection churn: exactly one live stream afterwards, none after Stop.
  const rs = () => p.evaluate(() => ({ phase: window.__dexqrReceiver.phase, running: window.__dexqrReceiver.running, msg: document.getElementById("msg").textContent, start: document.getElementById("start").disabled, stop: document.getElementById("stop").disabled }));
  for (let i = 0; i < 10; i++) {
    await p.click("#stop"); await p.click("#start");
    let j = 0; for (; j < 200 && (await p.evaluate(() => document.getElementById("stop").disabled)); j++) await p.waitForTimeout(50);
    if (j === 200) { console.log("start did not complete:", JSON.stringify(await rs())); break; }
  }
  await p.selectOption("#cam", { index: 0 }); await p.dispatchEvent("#cam", "change"); await p.waitForTimeout(1500);
  const live = await p.evaluate(() => { const s = window.__dexqrReceiver.stream; return s ? s.getTracks().filter((t) => t.readyState === "live").length : 0; });
  await p.click("#stop");
  const after = await p.evaluate(() => ({ stream: !!window.__dexqrReceiver.stream, src: !!document.getElementById("video").srcObject }));
  record(`receiver scans ${SECS} s without heap growth; Start/Stop churn leaves one stream, Stop releases it`, h1 - h0 < 10 && live === 1 && !after.stream && !after.src && errors.length === 0, { heapMB: [h0, h1], framesScanned: f1 - f0, scanFps: +((f1 - f0) / SECS).toFixed(1), liveTracksAfterChurn: live, afterStop: after, errors });
  await b.close();
}
fs.writeFileSync(path.join(ROOT, "results", "soak.json"), JSON.stringify({ when: new Date().toISOString(), seconds: SECS, results }, null, 1));
if (results.some((r) => !r.ok)) process.exitCode = 1;
