// Cycle 9: the reverse-channel Done confirmation in headless Chrome from file://.
// The receiver's Done code is checked as drawn (whole pixels per module, white 4-module quiet zone, pure black and
// white, decodes to this transfer's ID, reduced-motion static). The sender's "Confirm with camera" is driven by
// Chrome's fake camera playing Y4M files of synthetic frames (tests/lib/synthframe.cjs): the receiver's own Done
// canvas on a grey "room", foreign QR codes, Done codes for other transfers, a newer ACK version and stream frames.
// Nothing here is a real phone or laptop camera.
// Usage: node tests/browser/ack.mjs [--shots DIR] [--out results/ack.json]
import { chromium } from "playwright-core";
import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
const require = createRequire(import.meta.url);
const DQ = require("../lib/load.cjs").load();
const { encodeGray } = require("../lib/png.cjs");
const { testFile } = require("../lib/testfile.cjs");
const { frame } = require("../lib/synthframe.cjs");
const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..", "..");
const arg = (k) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : null; };
const SHOTS = arg("--shots"), OUTJSON = arg("--out") || path.join(ROOT, "results", "ack.json");
const CHROME = process.env.CHROME || "/usr/bin/google-chrome";
const WORK = path.join(ROOT, "work", "ack_" + Date.now().toString(36)); fs.mkdirSync(WORK, { recursive: true });
const results = [], net = [], measurements = {};
function record(name, ok, d = {}) { results.push({ name, ok, ...d }); console.log((ok ? "PASS " : "FAIL ") + name, JSON.stringify(d)); }
const url = (p) => "file://" + path.join(ROOT, p);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function poll(p, fn, t = 30000, a) { const end = Date.now() + t; while (!(await p.evaluate(fn, a))) { if (Date.now() > end) return false; await sleep(100); } return true; }
const gray = (f) => { const g = new Uint8Array(f.width * f.height); for (let i = 0; i < g.length; i++) g[i] = f.data[i * 4]; return { width: f.width, height: f.height, data: g }; };
function y4m(name, frames, fps = 10) {
  const dir = path.join(WORK, name); fs.mkdirSync(dir);
  frames.forEach((f, i) => fs.writeFileSync(path.join(dir, `f_${String(i).padStart(4, "0")}.png`), encodeGray(f)));
  const out = path.join(WORK, name + ".y4m");
  const r = spawnSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-framerate", String(fps), "-i", path.join(dir, "f_%04d.png"), "-vf", "pad=ceil(iw/2)*2:ceil(ih/2)*2:color=white,format=yuv420p", out], { encoding: "utf8" });
  if (r.status !== 0) throw new Error(r.stderr);
  return out;
}
const W = 640, H = 480;
const codeOf = (text) => DQ.render.toGray(DQ.render.makeQr(text, "M"), 1);
const cam = (qr, i, scale = 6) => gray(frame({ w: W, h: H, qr, scale, seed: i + 1, noise: 2 }));
const envelope = (bytes) => { const x = new Uint8Array(bytes.length + 4); x.set(bytes); new DataView(x.buffer).setUint32(bytes.length, DQ.crc32(x, 0, bytes.length)); return "DA" + DQ.base45.encode(x); };

// The transfer both pages use: an incompressible 2,000-byte file, so the page (compression on, skipped) and Node
// (compression off) build the same payload and the same transfer ID.
const FILE = path.join(WORK, "postcard.bin"); fs.writeFileSync(FILE, testFile(2000, "ack-postcard"));
const S = await DQ.SenderSession.create({ name: "postcard.bin", mime: "application/octet-stream", data: testFile(2000, "ack-postcard"), blockSize: 400, startSeed: 1, compress: false });
const MINE = DQ.packet.hex(S.fileId);
const otherId = Uint8Array.from(S.fileId); otherId[0] ^= 0x5a;
const streamFrames = [];
for (let i = 0; i < Math.ceil(S.K * 1.6) + 6; i++) { const f = path.join(WORK, `s_${String(i).padStart(4, "0")}.png`); fs.writeFileSync(f, encodeGray(DQ.render.toGray(DQ.render.makeQr(S.nextFrame(), "M"), 4))); streamFrames.push(f); }

const plain = await chromium.launch({ executablePath: CHROME, headless: true });
async function openPage(b, page, vp, opts = {}) {
  const ctx = await b.newContext({ viewport: vp, deviceScaleFactor: 1, colorScheme: "dark", reducedMotion: opts.reduced ? "reduce" : "no-preference" });
  if (opts.init) await ctx.addInitScript(opts.init);
  const p = await ctx.newPage(); const errors = [];
  p.on("pageerror", (e) => errors.push(e.message));
  p.on("request", (r) => { if (!/^(file:|data:|blob:)/.test(r.url())) net.push(r.url()); });
  await p.goto(url(page));
  return { ctx, p, errors };
}
async function shot(p, name, w) { if (!SHOTS) return; fs.mkdirSync(SHOTS, { recursive: true }); const f = path.join(path.resolve(SHOTS), `cycle9-after-${name}-${w}.png`); await p.evaluate(() => scrollTo(0, 0)); await sleep(200); await p.screenshot({ path: f, fullPage: true }); console.log("saved", f); }

// 1. Receiver: the Done code as drawn, at both widths; reduced motion; Reset removes it.
let ackImage = null;
for (const vp of [{ width: 1280, height: 800 }, { width: 390, height: 844 }]) for (const reduced of [false, true]) {
  const { ctx, p, errors } = await openPage(plain, "receiver.html", vp, { reduced });
  await p.click("details.opts summary"); await p.selectOption("#dec", "zxing"); await p.evaluate(() => { document.querySelector("details.opts").open = false; });
  await p.setInputFiles("#files", streamFrames);
  await poll(p, () => window.__dexqrReceiver.phase === "done");
  await sleep(reduced ? 200 : 1500);
  const info = await p.evaluate(() => {
    const st = window.__dexqrReceiver, c = document.getElementById("ackqr"), g = c.getContext("2d"), d = g.getImageData(0, 0, c.width, c.height).data;
    const n = st.ackInfo.size + 2 * st.ackInfo.quiet, px = st.ackInfo.modulePx, q = st.ackInfo.quiet * px;
    let onlyBW = true, quietWhite = true;
    for (let y = 0; y < c.height; y++) for (let x = 0; x < c.width; x++) {
      const k = (y * c.width + x) * 4, v = d[k];
      if (!((v === 0 || v === 255) && d[k + 1] === v && d[k + 2] === v && d[k + 3] === 255)) onlyBW = false;
      if ((x < q || y < q || x >= c.width - q || y >= c.height - q) && v !== 255) quietWhite = false;
    }
    const r = window.jsQR(d, c.width, c.height, { inversionAttempts: "dontInvert" });
    const rect = c.getBoundingClientRect(), wrap = document.getElementById("ack-code").getBoundingClientRect(), vpr = document.getElementById("viewport").getBoundingClientRect();
    const anim = getComputedStyle(document.getElementById("ack-code")).animationName;
    const gr = []; for (let y = 0; y < c.height; y += px) for (let x = 0; x < c.width; x += px) gr.push(d[(y * c.width + x) * 4]);
    return { text: r && r.data, rid: document.getElementById("r-id").textContent, canvas: [c.width, c.height], css: [Math.round(rect.width), Math.round(rect.height)], n, px, quietModules: st.ackInfo.quiet, version: st.ackInfo.version, onlyBW, quietWhite,
      inView: rect.top >= vpr.top && rect.bottom <= vpr.bottom && rect.left >= vpr.left && rect.right <= vpr.right, ringOutside: wrap.width > rect.width && wrap.height > rect.height, anim, hidden: document.getElementById("ack").hidden, empty: document.getElementById("empty").hidden, modules: gr, size: c.width / px };
  });
  const parsed = info.text ? DQ.ack.parse(info.text) : { ok: false };
  const tag = `${vp.width}${reduced ? " reduced motion" : ""}`;
  record(`receiver ${tag}: Done code shown in the camera area, decodes to this transfer's ID`, !info.hidden && info.empty && parsed.ok && parsed.fileIdHex === info.rid && info.rid === MINE && info.inView && errors.length === 0, { text: info.text, rid: info.rid, version: info.version, errors });
  record(`receiver ${tag}: Done code drawn clean (whole ${info.px} px modules >= 4, white ${info.quietModules}-module quiet zone, pure black/white, CSS size = canvas size, ring outside the code)`, info.onlyBW && info.quietWhite && info.px >= 4 && Number.isInteger(info.px) && info.quietModules === 4 && info.css[0] === info.canvas[0] && info.css[1] === info.canvas[1] && info.ringOutside, { px: info.px, canvas: info.canvas, css: info.css });
  record(`receiver ${tag}: animation ${reduced ? "off (static final picture)" : "plays"}`, reduced ? info.anim === "none" : /ackpop/.test(info.anim), { anim: info.anim });
  measurements[`receiver_ack_${vp.width}`] = { modulePx: info.px, canvasPx: info.canvas[0], qrVersion: info.version };
  if (!reduced && vp.width === 1280) { ackImage = { width: info.size, height: info.size, data: Uint8Array.from(info.modules) }; await shot(p, "receiver-done", vp.width); }
  if (!reduced && vp.width === 390) await shot(p, "receiver-done", vp.width);
  if (!reduced) {
    await p.click("#reset"); await sleep(200);
    const after = await p.evaluate(() => ({ ack: document.getElementById("ack").hidden, empty: document.getElementById("empty").hidden, text: window.__dexqrReceiver.ackText }));
    record(`receiver ${tag}: Reset removes the Done code`, after.ack && !after.empty && !after.text, after);
  }
  await ctx.close();
}

// Sender helper: tiny file at 30 fps reaches "should have it by now" in about a second.
async function toLikely(p) {
  await p.setInputFiles("#file", FILE);
  await p.evaluate(() => { document.getElementById("tuning").open = true; });
  await p.fill("#fps", "30"); await p.dispatchEvent("#fps", "change");
  await p.evaluate(() => { document.getElementById("tuning").open = false; });
  await p.click("#play");
  return poll(p, () => !document.getElementById("finish").hidden);
}
const camBrowser = (file, ui = true) => chromium.launch({ executablePath: CHROME, headless: true, args: ["--use-fake-device-for-media-stream", ...(ui ? ["--use-fake-ui-for-media-stream"] : []), `--use-file-for-fake-video-capture=${file}`] });
const senderSnap = (p) => p.evaluate(() => { const s = window.__dexqrSender; return { confirmed: s.confirmed, finish: s.finish, playing: s.playing, verdicts: s.ack.log.map((x) => x.verdict), hint: document.getElementById("ackcam-hint").textContent, h: document.getElementById("finish-h").textContent, cls: document.getElementById("finish").className, stageDone: !document.getElementById("stage-done").hidden, stageH: document.getElementById("stage-done-h").textContent, confirmBtn: !document.getElementById("finish-confirm").hidden, stopBtn: !document.getElementById("finish-stop").hidden, camOn: !!s.ack.stream, fps: s.actualFps, id: document.getElementById("s-id").textContent, decoder: s.ack.decoder && s.ack.decoder.name }; });

// 2. Sender with a fake camera that sees only codes it must ignore: foreign, other transfer, stream frames.
{
  const frames = [];
  for (let i = 0; i < 12; i++) frames.push(i % 3 === 2 ? cam(codeOf(S.textForSeed(50 + i)), i, 4) : cam(codeOf(i % 3 === 0 ? "HELLO FROM ANOTHER APP" : DQ.ack.build(otherId)), i));   // stream frames (QR v16) at 4 px so they fit
  const b = await camBrowser(y4m("ignore", frames, 6));
  for (const vp of [{ width: 1280, height: 800 }, { width: 390, height: 844 }]) {
    const { ctx, p, errors } = await openPage(b, "sender.html", vp);
    await toLikely(p);
    await poll(p, () => !document.getElementById("finish-confirm").hidden, 5000);
    const fpsBefore = (await senderSnap(p)).fps;
    await p.click("#finish-confirm");
    await sleep(2500);
    if (vp.width === 1280) await shot(p, "sender-looking", vp.width);
    await poll(p, (n) => new Set(window.__dexqrSender.ack.log.map((x) => x.verdict)).size >= n, 8000, 4);
    const s = await senderSnap(p);
    if (vp.width === 390) await shot(p, "sender-looking", vp.width);
    const seen = new Set(s.verdicts);
    record(`sender ${vp.width}: fake camera with foreign, other-transfer and stream codes: recognised as such and ignored (not confirmed)`, s.id === MINE && !s.confirmed && s.camOn && seen.has("foreign") && seen.has("other") && seen.has("stream") && !seen.has("done") && s.finish === "likely" && errors.length === 0, { verdicts: [...seen], hint: s.hint, decoder: s.decoder, errors });
    measurements[`sender_fps_${vp.width}`] = { setFps: 30, beforeCamera: +fpsBefore.toFixed(2), whileCameraScans: +s.fps.toFixed(2) };
    record(`sender ${vp.width}: stream keeps its rate while the camera looks (>= 27 of 30 fps)`, s.playing && s.fps >= 27, measurements[`sender_fps_${vp.width}`]);
    await p.click("#ackcam-cancel"); await sleep(200);
    const c = await senderSnap(p);
    record(`sender ${vp.width}: Stop the camera releases it and brings back Confirm with camera; manual stop still works`, !c.camOn && c.confirmBtn, {});
    await p.click("#finish-stop"); await sleep(300);
    const f = await senderSnap(p);
    record(`sender ${vp.width}: manual "Receiver done: stop" unchanged`, f.finish === "final" && !f.confirmed && f.stageH === "Sent" && f.confirmBtn, { h: f.h });
    await ctx.close();
  }
  await b.close();
}

// 3. A newer ACK version (well-formed v2 envelope) is rejected in plain language.
{
  const v2 = envelope(Uint8Array.from([2, 1, ...S.fileId]));
  const frames = Array.from({ length: 6 }, (_, i) => cam(codeOf(v2), i));
  const b = await camBrowser(y4m("newer", frames, 6));
  const { ctx, p, errors } = await openPage(b, "sender.html", { width: 1280, height: 800 });
  await toLikely(p); await poll(p, () => !document.getElementById("finish-confirm").hidden, 5000);
  await p.click("#finish-confirm");
  await poll(p, () => window.__dexqrSender.ack.log.some((x) => x.verdict === "newer"), 10000);
  const s = await senderSnap(p);
  record("sender: newer ACK version rejected with a plain-language message, not confirmed", !s.confirmed && /newer Dex_QR version/.test(s.hint) && errors.length === 0, { hint: s.hint });
  await ctx.close(); await b.close();
}

// 4. End to end: the receiver's own Done canvas (from step 1), seen by the sender's fake camera after a few
//    unrelated codes, confirms the transfer: green, stream stopped, focus on Send another file.
{
  const frames = [cam(codeOf("HELLO FROM ANOTHER APP"), 0), cam(codeOf(DQ.ack.build(otherId)), 1)];
  for (let i = 0; i < 10; i++) frames.push(cam(ackImage, 10 + i, 1.2));
  const b = await camBrowser(y4m("confirm", frames, 6));
  for (const vp of [{ width: 1280, height: 800 }, { width: 390, height: 844 }]) for (const reduced of [false, true]) {
    const { ctx, p, errors } = await openPage(b, "sender.html", vp, { reduced });
    await toLikely(p); await poll(p, () => !document.getElementById("finish-confirm").hidden, 5000);
    const t0 = Date.now();
    await p.click("#finish-confirm");
    const ok = await poll(p, () => window.__dexqrSender.confirmed, 15000);
    const ms = Date.now() - t0;
    await sleep(reduced ? 200 : 1600);
    const s = await senderSnap(p);
    const extra = await p.evaluate(() => ({ focus: document.activeElement && document.activeElement.id, say: document.getElementById("finish-say").textContent, msg: document.getElementById("msg").textContent, rays: getComputedStyle(document.querySelector(".sd-rays")).animationName, raysShown: getComputedStyle(document.querySelector(".sd-rays")).display }));
    const tag = `${vp.width}${reduced ? " reduced motion" : ""}`;
    record(`sender ${tag}: the receiver's Done code confirms the transfer (camera released, stream stopped, green Confirmed state, announced, focus on Send another file)`, ok && s.confirmed && !s.camOn && !s.playing && s.finish === "final" && /confirmed/.test(s.cls) && s.stageDone && s.stageH === "Confirmed" && !s.confirmBtn && extra.focus === "finish-again" && /confirmed/i.test(extra.say + extra.msg) && errors.length === 0, { ms, verdicts: [...new Set(s.verdicts)], h: s.h, focus: extra.focus, errors });
    record(`sender ${tag}: celebration ${reduced ? "static (no animation, final picture shown)" : "animates once"}`, extra.raysShown !== "none" && (reduced ? extra.rays === "none" : extra.rays === "rays"), { rays: extra.rays });
    measurements[`confirm_ms_${tag}`] = ms;
    if (!reduced) await shot(p, "sender-confirmed", vp.width);
    if (!reduced && vp.width === 1280) {
      await p.click("#finish-again"); await sleep(300);
      const a = await senderSnap(p);
      record("sender: Send another file after a confirmed Done clears the confirmed state", !a.confirmed && a.finish === "" && a.stageH === "Sent", {});
    }
    await ctx.close();
  }
  await b.close();
}

// 5. No camera: no API (removed) and no device: the button is not offered, manual stop works. Permission denied:
//    plain-language message, button stays usable path back to manual stop.
{
  for (const [label, init] of [["no camera API", "Object.defineProperty(navigator, 'mediaDevices', { value: undefined, configurable: true });"], ["no camera device", null]]) {
    const { ctx, p, errors } = await openPage(plain, "sender.html", { width: 1280, height: 800 }, { init });
    await toLikely(p); await sleep(600);
    const s = await senderSnap(p);
    await p.click("#finish-stop"); await sleep(300);
    const f = await senderSnap(p);
    record(`sender (${label}): Confirm with camera not offered; "Receiver done: stop" works as before`, !s.confirmBtn && f.finish === "final" && errors.length === 0, { errors });
    await ctx.close();
  }
  const b = await camBrowser(y4m("denied", [cam(codeOf("X"), 0)], 6), false);
  const ctx = await b.newContext({ viewport: { width: 1280, height: 800 }, colorScheme: "dark" });
  const p = await ctx.newPage(); const errors = []; p.on("pageerror", (e) => errors.push(e.message));
  await p.goto(url("sender.html"));
  await toLikely(p); await poll(p, () => !document.getElementById("finish-confirm").hidden, 5000);
  await p.click("#finish-confirm");
  await poll(p, () => /denied|camera/i.test(document.getElementById("ackcam-hint").textContent) && !window.__dexqrSender.ack.starting, 10000);
  await sleep(300);
  const s = await senderSnap(p);
  record("sender (camera permission refused): plain-language message, no camera left on, manual stop still offered", !s.camOn && /Receiver done: stop/.test(s.hint) && s.stopBtn && !s.confirmed && errors.length === 0, { hint: s.hint });
  await ctx.close(); await b.close();
}
await plain.close();
record("no network requests from any page", net.length === 0, { net });
const pass = results.filter((r) => r.ok).length;
console.log(`${pass}/${results.length} passed`);
fs.mkdirSync(path.dirname(OUTJSON), { recursive: true });
fs.writeFileSync(OUTJSON, JSON.stringify({ when: new Date().toISOString(), note: "synthetic frames through Chrome's fake camera; not a real camera", results, measurements }, null, 1));
if (pass !== results.length) process.exitCode = 1;
