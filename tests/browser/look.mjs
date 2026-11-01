// Headless Chrome tests of the cycle-6 interface: home page links, drag-and-drop and paste on the sender,
// the one-button send flow, the QR panel staying clean (quiet zone white, decoration outside the canvas),
// theme and reduce-motion toggles, and the receiver's block map, steps and completion state.
// Pages load from file:// with their real CSP; network requests and page errors are recorded. No camera.
import { chromium } from "playwright-core";
import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";
const require = createRequire(import.meta.url);
const DQ = require("../lib/load.cjs").load();
const { encodeGray } = require("../lib/png.cjs");
const { testFile } = require("../lib/testfile.cjs");
const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..", "..");
const CHROME = process.env.CHROME || "/usr/bin/google-chrome";
const WORK = path.join(ROOT, "work", "look_" + Date.now().toString(36)); fs.mkdirSync(WORK, { recursive: true });
const results = [], netViolations = [];
const url = (p) => "file://" + path.join(ROOT, p);
function record(name, ok, details = {}) { results.push({ name, ok, ...details }); console.log((ok ? "PASS " : "FAIL ") + name, JSON.stringify(details)); }
async function waitFor(page, fn, arg, timeout = 60000) { const end = Date.now() + timeout; for (;;) { if (await page.evaluate(fn, arg)) return true; if (Date.now() > end) return false; await new Promise((r) => setTimeout(r, 100)); } }
async function open(browser, page, opts = {}) {
  const ctx = opts.ctx || await browser.newContext({ acceptDownloads: true, viewport: opts.viewport || { width: 1280, height: 800 }, reducedMotion: opts.reduced ? "reduce" : "no-preference", colorScheme: opts.scheme || "dark" });
  const p = await ctx.newPage(); const errors = [];
  p.on("pageerror", (e) => errors.push(e.message));
  p.on("request", (r) => { if (!/^(file:|data:|blob:)/.test(r.url())) netViolations.push({ page, url: r.url() }); });
  await p.goto(url(page));
  return { ctx, p, errors };
}
// Build a File inside the page and dispatch a drag-and-drop or paste carrying it.
const dropFiles = (p, sel, files, kind = "drop") => p.evaluate(({ sel, files, kind }) => {
  const dt = new DataTransfer();
  for (const f of files) dt.items.add(new File([new Uint8Array(f.bytes)], f.name, { type: f.type }));
  const el = document.querySelector(sel);
  if (kind === "paste") { el.dispatchEvent(new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true })); return; }
  el.dispatchEvent(new DragEvent("dragenter", { dataTransfer: dt, bubbles: true }));
  const over = new DragEvent("dragover", { dataTransfer: dt, bubbles: true, cancelable: true }); el.dispatchEvent(over);
  el.dispatchEvent(new DragEvent("drop", { dataTransfer: dt, bubbles: true, cancelable: true }));
}, { sel, files, kind });

const sample = Array.from(testFile(30000, "look-sample"));
const small = await DQ.SenderSession.create({ name: "look.txt", data: testFile(24000, "look-recv"), blockSize: 400, startSeed: 5, compress: false });
const frames = [];
for (let i = 0; i < Math.ceil(small.K * 1.5) + 10; i++) { const f = path.join(WORK, `f_${String(i).padStart(4, "0")}.png`); fs.writeFileSync(f, encodeGray(DQ.render.toGray(DQ.render.makeQr(small.nextText(), "M"), 4))); frames.push(f); }

const browser = await chromium.launch({ executablePath: CHROME, headless: true });

// 1. Home page: one screen, two big links, no script.
{
  const { ctx, p, errors } = await open(browser, "index.html");
  const info = await p.evaluate(() => ({ links: Array.from(document.querySelectorAll(".cta a")).map((a) => a.getAttribute("href")), scripts: document.scripts.length, h1: document.querySelector("h1").textContent, fold: document.querySelector(".cta").getBoundingClientRect().bottom <= innerHeight }));
  await p.click(".cta a.send"); const t1 = await p.title(); await p.goBack();
  await p.click(".cta a.recv"); const t2 = await p.title();
  record("home: Send and Receive buttons above the fold open the sender and receiver; no scripts", JSON.stringify(info.links) === '["sender.html","receiver.html"]' && info.scripts === 0 && info.fold && /send/i.test(t1) && /receive/i.test(t2) && errors.length === 0, { info, t1, t2, errors });
  await ctx.close();
}

// 2. Sender: drop a file, one press prepares and plays; progress ring moves; the code panel stays clean.
{
  const { ctx, p, errors } = await open(browser, "sender.html");
  const before = await p.evaluate(() => ({ play: document.getElementById("play").disabled, step: document.getElementById("step1").className }));
  await dropFiles(p, "body", [{ name: "notes.bin", type: "application/octet-stream", bytes: sample }]);
  const afterDrop = await p.evaluate(() => ({ file: (document.getElementById("file").files[0] || {}).name, t1: document.getElementById("drop-t1").textContent, play: document.getElementById("play").disabled, step1: document.getElementById("step1").className, step3: document.getElementById("step3").className, label: document.getElementById("play-text").textContent }));
  await p.click("#play");
  await waitFor(p, () => window.__dexqrSender.playing);
  await p.waitForTimeout(1500);
  const playing = await p.evaluate(() => {
    const s = window.__dexqrSender, c = document.getElementById("qr"), g = c.getContext("2d"), px = s.modulePx, n = c.width;
    const img = g.getImageData(0, 0, n, n).data; let dark = 0;
    // The 4-module quiet zone on every side must be pure white.
    for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) { if (x >= 4 * px && x < n - 4 * px && y >= 4 * px && y < n - 4 * px) continue; const i = (y * n + x) * 4; if (img[i] !== 255 || img[i + 1] !== 255 || img[i + 2] !== 255) dark++; }
    const cr = c.getBoundingClientRect(), sr = document.getElementById("stage").getBoundingClientRect();
    return { sent: s.sent, label: document.getElementById("play-text").textContent, ring: document.getElementById("ring").style.getPropertyValue("--p"), ringPlaying: document.getElementById("ring").classList.contains("playing"), quietDark: dark, inside: cr.left >= sr.left && cr.right <= sr.right && cr.top >= sr.top && cr.bottom <= sr.bottom, stageBg: getComputedStyle(document.getElementById("stage")).backgroundColor, live: document.getElementById("live-text").textContent };
  });
  record("sender: dropping a file anywhere selects it and enables the big button", before.play && afterDrop.file === "notes.bin" && afterDrop.t1 === "notes.bin" && !afterDrop.play && /done/.test(afterDrop.step1) && /current/.test(afterDrop.step3) && afterDrop.label === "Start sending", { before, afterDrop });
  record("sender: one press prepares and plays; progress ring and live line update", playing.sent > 5 && playing.label === "Pause" && Number(playing.ring) > 0 && playing.ringPlaying && /Sending · frame/.test(playing.live), playing);
  record("sender: QR quiet zone stays pure white and the canvas sits inside the white stage (decoration outside)", playing.quietDark === 0 && playing.inside && playing.stageBg === "rgb(255, 255, 255)", { quietDark: playing.quietDark, inside: playing.inside, stageBg: playing.stageBg });
  await p.click("#play");
  const paused = await p.evaluate(() => ({ label: document.getElementById("play-text").textContent, playing: window.__dexqrSender.playing }));
  // Paste a second file: settings become stale; the big button offers Start sending again.
  await dropFiles(p, "body", [{ name: "pasted.txt", type: "text/plain", bytes: Array.from(new TextEncoder().encode("pasted ".repeat(300))) }], "paste");
  const pasted = await p.evaluate(() => ({ file: (document.getElementById("file").files[0] || {}).name, label: document.getElementById("play-text").textContent, stale: document.getElementById("prepare").textContent }));
  await dropFiles(p, "body", [{ name: "a.txt", type: "text/plain", bytes: [97] }, { name: "b.txt", type: "text/plain", bytes: [98] }]);
  const multi = await p.evaluate(() => ({ file: document.getElementById("file").files[0].name, msg: document.getElementById("msg").textContent }));
  record("sender: Pause/Resume label; paste picks a file and marks the stream stale; dropping two files uses the first and says so", paused.label === "Resume" && !paused.playing && pasted.file === "pasted.txt" && pasted.label === "Start sending" && /apply/.test(pasted.stale) && multi.file === "a.txt" && /One file at a time/.test(multi.msg) && errors.length === 0, { paused, pasted, multi, errors });
  await ctx.close();
}

// 2b. Phone: Start sending brings the code panel (below the controls) into view.
{
  const { ctx, p, errors } = await open(browser, "sender.html", { viewport: { width: 390, height: 844 } });
  await dropFiles(p, "body", [{ name: "phone.bin", type: "application/octet-stream", bytes: sample }]);
  const before = await p.evaluate(() => document.getElementById("qr").getBoundingClientRect().top > innerHeight || document.getElementById("ring").getBoundingClientRect().top > innerHeight);
  await p.click("#play"); await waitFor(p, () => window.__dexqrSender.playing); await p.waitForTimeout(1200);
  const r = await p.evaluate(() => { const b = document.getElementById("qr").getBoundingClientRect(); return { top: Math.round(b.top), bottom: Math.round(b.bottom), vh: innerHeight }; });
  record("sender at 390 px: Start sending scrolls the code fully into view", before && r.top >= 0 && r.bottom <= r.vh && errors.length === 0, { panelBelowFoldBefore: before, ...r, errors });
  await ctx.close();
}

// 2c. Cycle 8: "How to receive" card beside the code (outside the code area), animated unless motion is reduced.
for (const [label, opts, toggle] of [["animated", {}, false], ["reduced (system)", { reduced: true }, false], ["reduced (motion toggle)", {}, true]]) {
  const { ctx, p, errors } = await open(browser, "sender.html", opts);
  if (toggle) await p.click("#motion");
  await dropFiles(p, "body", [{ name: "howto.bin", type: "application/octet-stream", bytes: sample }]);
  await p.click("#play"); await waitFor(p, () => window.__dexqrSender.playing); await p.waitForTimeout(700);
  const r = await p.evaluate(() => {
    const h = document.getElementById("howto"), st = document.getElementById("stage").getBoundingClientRect(), hr = h.getBoundingClientRect();
    const art = h.querySelector(".howto-art"), phone = art.querySelector(".h-phone"), ok = art.querySelector(".h-ok");
    const cs = getComputedStyle(phone), oks = getComputedStyle(ok);
    const overlap = !(hr.bottom <= st.top || hr.top >= st.bottom || hr.right <= st.left || hr.left >= st.right);
    return { visible: !h.hidden && hr.height > 0, overlap, artHidden: art.getAttribute("aria-hidden"), steps: h.querySelectorAll("ol li").length, anim: cs.animationName, okOpacity: oks.opacity, okAnim: oks.animationName, heading: document.getElementById("howto-h").textContent };
  });
  const reduced = label !== "animated";
  record(`sender: How to receive card is outside the code area with 3 steps; ${label}: ` + (reduced ? "no animation, complete static picture (check shown)" : "phone animation runs"),
    r.visible && !r.overlap && r.artHidden === "true" && r.steps === 3 && (reduced ? r.anim === "none" && r.okAnim === "none" && r.okOpacity === "1" : r.anim === "hphone" && r.okAnim === "hok") && errors.length === 0, { ...r, errors });
  await ctx.close();
}

// 2d. Cycle 8: finished state. A tiny file at 30 fps reaches the frame estimate quickly; the card appears (in view,
// outside the code), the stream keeps playing; stop shows the summary; Send another file returns to step 1.
for (const [w, h] of [[1280, 800], [390, 844]]) {
  const { ctx, p, errors } = await open(browser, "sender.html", { viewport: { width: w, height: h } });
  await p.evaluate(() => { document.getElementById("tuning").open = true; });
  await p.fill("#fps", "30"); await p.dispatchEvent("#fps", "change");
  await p.evaluate(() => { document.getElementById("tuning").open = false; });
  await dropFiles(p, "body", [{ name: "tiny.txt", type: "text/plain", bytes: Array.from(testFile(1500, "tiny")) }]);
  await p.click("#play"); await waitFor(p, () => window.__dexqrSender.playing);
  const hiddenEarly = await p.evaluate(() => document.getElementById("finish").hidden);
  const ok1 = await waitFor(p, () => !document.getElementById("finish").hidden, null, 15000);
  await p.waitForTimeout(700);
  const likely = await p.evaluate(() => {
    const s = window.__dexqrSender, f = document.getElementById("finish").getBoundingClientRect(), st = document.getElementById("stage").getBoundingClientRect();
    return { sent: s.sent, need: s.need, playing: s.playing, finish: s.finish, inView: f.top >= 0 && f.bottom <= innerHeight, overlap: !(f.bottom <= st.top || f.top >= st.bottom || f.right <= st.left || f.left >= st.right), reached: document.getElementById("ring").classList.contains("reached"), say: document.getElementById("finish-say").textContent, h: document.getElementById("finish-h").textContent, qrHidden: document.getElementById("qr").hidden };
  });
  record(`sender @${w}: at the frame estimate a "should have it" card appears in view, outside the code; the stream keeps playing; polite announcement`, hiddenEarly && ok1 && likely.sent >= likely.need && likely.playing && likely.finish === "likely" && likely.inView && !likely.overlap && likely.reached && /Estimate reached|30%/.test(likely.say) && !likely.qrHidden, { hiddenEarly, ...likely });
  await p.click("#finish-stop"); await p.waitForTimeout(300);
  const fin = await p.evaluate(() => ({ playing: window.__dexqrSender.playing, finish: window.__dexqrSender.finish, qrHidden: document.getElementById("qr").hidden, done: !document.getElementById("stage-done").hidden, h: document.getElementById("finish-h").textContent, stats: document.getElementById("finish-stats").textContent, focus: document.activeElement.id, say: document.getElementById("finish-say").textContent }));
  record(`sender @${w}: "Receiver says Done: stop" stops, shows Sent with a summary instead of the code and focuses Send another file`, !fin.playing && fin.finish === "final" && fin.qrHidden && fin.done && /Sent tiny\.txt/.test(fin.h) && /Frames shown/.test(fin.stats) && fin.focus === "finish-again" && /Finished/.test(fin.say), fin);
  await p.click("#finish-resume"); await waitFor(p, () => window.__dexqrSender.playing); await p.waitForTimeout(300);
  const back = await p.evaluate(() => ({ playing: window.__dexqrSender.playing, qrHidden: document.getElementById("qr").hidden, done: !document.getElementById("stage-done").hidden, finish: window.__dexqrSender.finish }));
  await p.click("#finish-again"); await p.waitForTimeout(300);
  const again = await p.evaluate(() => ({ session: !!window.__dexqrSender.session, playing: window.__dexqrSender.playing, files: document.getElementById("file").files.length, step1: document.getElementById("step1").className, play: document.getElementById("play").disabled, finishHidden: document.getElementById("finish").hidden, empty: !document.getElementById("stage-empty").hidden, focus: document.activeElement.id, ring: document.getElementById("ring").className }));
  await dropFiles(p, "body", [{ name: "next.txt", type: "text/plain", bytes: Array.from(testFile(1500, "next")) }]);
  await p.click("#play"); await waitFor(p, () => window.__dexqrSender.playing); await p.waitForTimeout(200);
  const next = await p.evaluate(() => ({ sent: window.__dexqrSender.sent, finish: window.__dexqrSender.finish, qr: !document.getElementById("qr").hidden, name: document.getElementById("s-file").textContent }));
  record(`sender @${w}: Show the code again resumes the stream; Send another file clears the file and returns to step 1; the next file sends with one press`, back.playing && !back.qrHidden && !back.done && back.finish === "likely" && !again.session && !again.playing && again.files === 0 && /current/.test(again.step1) && again.play && again.finishHidden && again.empty && again.focus === "file" && /idle/.test(again.ring) && next.qr && /next\.txt/.test(next.name) && errors.length === 0, { back, again, next, errors });
  await ctx.close();
}

// 3. Theme toggle cycles auto -> light -> dark -> auto, persists across reloads; colours change.
{
  const { ctx, p, errors } = await open(browser, "sender.html");
  const bg = () => p.evaluate(() => getComputedStyle(document.body).color);
  const seq = [{ t: await p.evaluate(() => document.documentElement.getAttribute("data-theme")), fg: await bg() }];
  for (let i = 0; i < 3; i++) { await p.click("#theme"); seq.push({ t: await p.evaluate(() => document.documentElement.getAttribute("data-theme")), fg: await bg(), label: await p.getAttribute("#theme", "aria-label") }); }
  await p.click("#theme");                          // -> light
  await p.waitForTimeout(300);                      // localStorage reaches other renderer processes asynchronously
  const p2 = await ctx.newPage(); await p2.goto(url("receiver.html"));
  const persisted = await p2.evaluate(() => ({ t: document.documentElement.getAttribute("data-theme"), lbl: document.getElementById("theme-lbl").textContent, stored: (() => { try { return localStorage.getItem("dexqr-theme"); } catch (e) { return "unavailable"; } })() }));
  persisted.first = await p.evaluate(() => [document.documentElement.getAttribute("data-theme"), localStorage.getItem("dexqr-theme")]);
  record("theme toggle: auto → light → dark → auto, labelled, colours change, choice persists to the other page", seq[0].t === null && seq[1].t === "light" && seq[2].t === "dark" && seq[3].t === null && seq[1].fg !== seq[2].fg && /^Light colour theme/.test(seq[1].label) && persisted.t === "light" && persisted.lbl === "Light" && errors.length === 0, { seq, persisted, errors });
  await ctx.close();
}

// 4. Reduce motion: the in-page toggle and the system setting both stop animations.
{
  const { ctx, p, errors } = await open(browser, "sender.html");
  await dropFiles(p, "body", [{ name: "m.bin", type: "application/octet-stream", bytes: sample }]);
  await p.click("#play"); await waitFor(p, () => window.__dexqrSender.playing);
  const anim = () => p.evaluate(() => getComputedStyle(document.getElementById("ring")).animationName);
  const a1 = await anim();
  await p.click("#motion");
  const a2 = await anim(), pressed = await p.getAttribute("#motion", "aria-pressed");
  const stillSending = await p.evaluate(async () => { const a = window.__dexqrSender.sent; await new Promise((r) => setTimeout(r, 700)); return window.__dexqrSender.sent - a; });
  record("reduce-motion toggle: stops decorative animation, the QR stream keeps its speed", a1 === "breathe" && a2 === "none" && pressed === "true" && stillSending >= 4 && errors.length === 0, { a1, a2, pressed, framesIn700ms: stillSending, errors });
  await ctx.close();
  const r = await open(browser, "sender.html", { reduced: true });
  const sys = await r.p.evaluate(() => ({ pressed: document.getElementById("motion").getAttribute("aria-pressed"), disabled: document.getElementById("motion").disabled, reduced: window.DexUI.reducedMotion() }));
  record("system reduced-motion: page reports reduced, toggle shows pressed and explains", sys.pressed === "true" && sys.disabled && sys.reduced, sys);
  await r.ctx.close();
}

// 5. Receiver: block map and steps track progress; completion shows the burst, hides the scan buttons; map goes idle.
for (const reduced of [false, true]) {
  const { ctx, p, errors } = await open(browser, "receiver.html", { reduced });
  await p.evaluate(() => { document.querySelector("details.opts").open = true; });
  await p.selectOption("#dec", "zxing");
  const part = frames.slice(0, Math.round(small.K * 0.5));
  await p.setInputFiles("#files", part);
  await waitFor(p, () => !window.__dexqrReceiver.busyFiles && window.__dexqrReceiver.phase === "incomplete");
  const mid = await p.evaluate(() => { const s = window.__dexqrReceiver, m = s.blockMap; return { K: s.session.progress().K, have: s.session.decoder.progressCount, N: m.N, lit: m.lit.reduce((a, b) => a + b, 0), pct: document.getElementById("pct").textContent, steps: ["ph-scan", "ph-recv", "ph-save"].map((id) => document.getElementById(id).className), start: document.getElementById("start-text").textContent }; });
  await p.setInputFiles("#files", frames.slice(part.length));
  await waitFor(p, () => window.__dexqrReceiver.phase === "done");
  await p.waitForTimeout(50);
  const done = await p.evaluate(() => { const m = window.__dexqrReceiver.blockMap, b = document.getElementById("burst"); return { lit: m.lit.reduce((a, c) => a + c, 0), N: m.N, pct: document.getElementById("pct").textContent, burst: !b.hidden, burstAnim: getComputedStyle(b.querySelector("svg")).animationName, scanHidden: document.getElementById("scanbtns").hidden, steps: ["ph-scan", "ph-recv", "ph-save"].map((id) => document.getElementById(id).className), focus: document.activeElement.id }; });
  await p.waitForTimeout(2000);
  const f1 = await p.evaluate(() => window.__dexqrReceiver.blockMap.frameCount); await p.waitForTimeout(1000);
  const f2 = await p.evaluate(() => window.__dexqrReceiver.blockMap.frameCount);
  const dlP = p.waitForEvent("download"); await p.click("#download"); await dlP;
  const saved = await p.evaluate(() => document.getElementById("ph-save").className);
  await p.click("#reset");
  const reset = await p.evaluate(() => ({ lit: window.__dexqrReceiver.blockMap.lit.reduce((a, c) => a + c, 0), burst: !document.getElementById("burst").hidden, scanHidden: document.getElementById("scanbtns").hidden, steps: document.getElementById("ph-scan").className }));
  const expectLit = Math.floor((mid.have / mid.K) * mid.N);
  const tag = reduced ? " (reduced motion: no burst animation)" : "";
  record("receiver: block map lights in proportion to decoded rank; steps show Receive; button says Resume" + tag, mid.lit === expectLit && mid.lit > 0 && mid.pct === Math.floor((100 * mid.have) / mid.K) + "%" && JSON.stringify(mid.steps) === '["done","current",""]' && mid.start === "Resume scanning", mid);
  record("receiver: completion fills the map, shows the check, hides scan buttons, focuses Save; drawing stops afterwards" + tag, done.lit === done.N && done.pct === "100%" && done.burst && (reduced ? done.burstAnim === "none" : done.burstAnim === "pop") && done.scanHidden && JSON.stringify(done.steps) === '["done","done","current"]' && done.focus === "download" && f2 === f1, { ...done, framesDrawnIdle: f2 - f1 });
  record("receiver: Save marks the last step done; Reset clears map, check and steps" + tag, saved === "done" && reset.lit === 0 && !reset.burst && !reset.scanHidden && reset.steps === "current" && errors.length === 0, { saved, reset, errors });
  await ctx.close();
}

// 6. Receiver: dropping QR images on the page decodes them; a non-image drop explains.
{
  const { ctx, p, errors } = await open(browser, "receiver.html");
  await p.evaluate(() => { document.querySelector("details.opts").open = true; }); await p.selectOption("#dec", "zxing");
  const imgs = frames.slice(0, 6).map((f, i) => ({ name: `f${i}.png`, type: "image/png", bytes: Array.from(fs.readFileSync(f)) }));
  await dropFiles(p, "body", imgs);
  await waitFor(p, () => !window.__dexqrReceiver.busyFiles && window.__dexqrReceiver.session.stats.frames >= 6, null, 30000);
  const got = await p.evaluate(() => ({ received: window.__dexqrReceiver.session.decoder ? window.__dexqrReceiver.session.decoder.received : 0 }));
  await dropFiles(p, "body", [{ name: "x.txt", type: "text/plain", bytes: [1, 2] }]);
  const m = await p.textContent("#msg");
  record("receiver: dropped QR images are decoded; a dropped non-image file is explained", got.received === 6 && /sender page/.test(m) && errors.length === 0, { got, msg: m, errors });
  await ctx.close();
}

await browser.close();
fs.mkdirSync(path.join(ROOT, "results"), { recursive: true });
fs.writeFileSync(path.join(ROOT, "results", "look.json"), JSON.stringify({ when: new Date().toISOString(), results, networkRequestsOutsideFileDataBlob: netViolations }, null, 1));
console.log("look tests passed", results.filter((r) => r.ok).length, "/", results.length, "network violations:", netViolations.length);
if (netViolations.length || results.some((r) => !r.ok)) process.exitCode = 1;
