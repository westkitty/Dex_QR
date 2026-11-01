// Live scan coaching and the slow-device passphrase warning (cycle 7), in headless Chrome from file://.
// Each camera scenario is a Y4M played by Chrome's fake camera (synthetic frames from tests/lib/synthframe.cjs:
// a code on a grey "room", dimmed, blurred or replaced); nothing here is a real phone camera.
// Usage: node tests/browser/coach.mjs [--root <checkout>] [--shots <dir> <prefix>] [--out <json>]
//   --root runs the same scenarios against another build (the "before" measurement); checks that need the
//   cycle-7 UI are then recorded as measurements only.
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
const arg = (k) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv.slice(i + 1) : null; };
const PAGE_ROOT = path.resolve((arg("--root") || [ROOT])[0]);
const SHOTS = arg("--shots"), OUTJSON = (arg("--out") || [path.join(ROOT, "results", "coach.json")])[0];
const CHROME = process.env.CHROME || "/usr/bin/google-chrome";
const WORK = path.join(ROOT, "work", "coach_" + Date.now().toString(36)); fs.mkdirSync(WORK, { recursive: true });
const SECS = 8;
const results = [], net = [];
function record(name, ok, d = {}) { results.push({ name, ok, ...d }); console.log((ok ? "PASS " : "FAIL ") + name, JSON.stringify(d)); }
const url = (p) => "file://" + path.join(PAGE_ROOT, p);

const gray = (f) => { const g = new Uint8Array(f.width * f.height); for (let i = 0; i < g.length; i++) g[i] = f.data[i * 4]; return { width: f.width, height: f.height, data: g }; };
function y4m(name, frames, fps = 10) {
  const dir = path.join(WORK, name); fs.mkdirSync(dir);
  frames.forEach((f, i) => fs.writeFileSync(path.join(dir, `f_${String(i).padStart(4, "0")}.png`), encodeGray(f)));
  const out = path.join(WORK, name + ".y4m");
  const r = spawnSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-framerate", String(fps), "-i", path.join(dir, "f_%04d.png"), "-vf", "pad=ceil(iw/2)*2:ceil(ih/2)*2:color=white,format=yuv420p", out], { encoding: "utf8" });
  if (r.status !== 0) throw new Error(r.stderr);
  return out;
}
const W = 1280, H = 720;
const stream = await DQ.SenderSession.create({ name: "notes.txt", data: testFile(10240, "coach"), blockSize: 400, startSeed: 31, compress: false });
const codeOf = (text) => DQ.render.toGray(DQ.render.makeQr(text, "M"), 1);
const one = codeOf(stream.textForSeed(5));
const synth = (o, n = 6) => Array.from({ length: n }, (_, i) => gray(frame({ w: W, h: H, seed: i + 1, noise: 2, ...o })));
const SCEN = {
  dark:     { want: "dark", frames: synth({ qr: one, scale: 6, gain: 0.12, offset: 3, blur: 3, passes: 2 }) },
  blank:    { want: "blank", frames: synth({ bg: 128 }) },
  blurry:   { want: "blurry", frames: synth({ qr: one, scale: 5, blur: 4, passes: 2 }) },
  foreign:  { want: "foreign", frames: synth({ qr: codeOf("HELLO FROM ANOTHER APP"), scale: 10 }) },
  receiving: { want: "steady", frames: Array.from({ length: 30 }, (_, i) => gray(frame({ w: W, h: H, qr: codeOf(stream.textForSeed(100 + i)), scale: 6, seed: i + 1, noise: 2 }))), fps: 3 },
};

const browserFor = (file) => chromium.launch({ executablePath: CHROME, headless: true, args: ["--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream", `--use-file-for-fake-video-capture=${file}`] });
async function openPage(b, vp, opts = {}) {
  const ctx = await b.newContext({ viewport: vp, deviceScaleFactor: 1, colorScheme: "dark", reducedMotion: opts.reduced ? "reduce" : "no-preference" });
  if (opts.init) await ctx.addInitScript(opts.init);
  const p = await ctx.newPage(); const errors = [];
  p.on("pageerror", (e) => errors.push(e.message));
  p.on("request", (r) => { if (!/^(file:|data:|blob:)/.test(r.url())) net.push(r.url()); });
  await p.goto(url("receiver.html"));
  return { ctx, p, errors };
}
const snap = (p) => p.evaluate(() => {
  const c = document.getElementById("coach"), s = window.__dexqrReceiver;
  return { coach: c && !c.hidden ? c.textContent.trim() : null, id: c ? c.dataset.id || null : null, live: (document.getElementById("coach-live") || {}).textContent || null,
    msg: document.getElementById("msg").textContent, phase: s.phase, received: s.session.decoder ? s.session.decoder.received : 0, log: s.coachLog || null };
});
async function shot(p, name, w) {
  if (!SHOTS) return;
  const [dir, prefix] = SHOTS; fs.mkdirSync(dir, { recursive: true });
  const out = path.join(path.resolve(dir), `${prefix}_${name}_${w}.png`);
  await p.evaluate(() => window.scrollTo(0, 0));
  await p.waitForTimeout(400);
  await p.screenshot({ path: out }); console.log("saved", out);
}

const measurements = {};
for (const [name, sc] of Object.entries(SCEN)) {
  const b = await browserFor(y4m(name, sc.frames, sc.fps || 10));
  for (const vp of [{ width: 1280, height: 800 }, { width: 390, height: 844 }]) {
    const { ctx, p, errors } = await openPage(b, vp);
    await p.click("details.opts summary"); await p.selectOption("#dec", "zxing"); await p.evaluate(() => { document.querySelector("details.opts").open = false; });
    await p.click("#start");
    const t0 = Date.now(); let firstHint = null, firstMsg = null, last;
    while (Date.now() - t0 < SECS * 1000) {
      last = await snap(p);
      const el = (Date.now() - t0) / 1000;
      if (firstHint == null && last.id === sc.want) firstHint = el;
      if (firstMsg == null && last.msg) firstMsg = el;
      if (last.phase === "done") break;
      await new Promise((r) => setTimeout(r, 100));
    }
    const shown = last.log ? [...new Set(last.log.filter((x) => x.kind === "shown").map((x) => x.id))] : null;
    const said = last.log ? last.log.filter((x) => x.kind === "said") : null;
    const gaps = said ? said.slice(1).map((x, i) => x.t - said[i].t) : [];
    const m = { viewport: vp.width, want: sc.want, secondsToHint: firstHint, hintsShown: shown, announcements: said ? said.length : null, minAnnounceGapMs: gaps.length ? Math.min(...gaps) : null, finalHint: last.coach, secondsToAnyMessage: firstMsg, finalMessage: last.msg, phase: last.phase, packets: last.received, pageErrors: errors };
    measurements[`${name}_${vp.width}`] = m;
    await shot(p, name, vp.width);
    const hasCoach = !!(await p.$("#coach"));
    if (hasCoach) {
      const ok = firstHint != null && firstHint <= 4 && errors.length === 0 && (gaps.every((g) => g >= 4000));
      record(`${name} @${vp.width}: hint "${sc.want}" within 4 s, announcements ≥ 4 s apart`, ok, m);
    } else console.log("MEASURE", name, JSON.stringify(m));
    await ctx.close();
  }
  await b.close();
}

// The receiving scenario completes: the hint goes away with the camera, Save is the one action.
{
  const b = await browserFor(y4m("finish", Array.from({ length: Math.ceil(stream.K * 1.6) + 6 }, (_, i) => gray(frame({ w: W, h: H, qr: codeOf(stream.textForSeed(200 + i)), scale: 6, seed: i + 1, noise: 2 }))), 6));
  const { ctx, p, errors } = await openPage(b, { width: 1280, height: 800 });
  if (await p.$("#coach")) {
    await p.click("details.opts summary"); await p.selectOption("#dec", "zxing"); await p.evaluate(() => { document.querySelector("details.opts").open = false; });
    await p.click("#start");
    const t0 = Date.now(); let st; const seen = new Set();
    while (Date.now() - t0 < 60000) { st = await snap(p); if (st.id) seen.add(st.id); if (st.phase === "done") break; await new Promise((r) => setTimeout(r, 150)); }
    record("full camera scan: coach shows progress hints, then hides when the file is ready", st.phase === "done" && st.coach == null && (seen.has("steady") || seen.has("almost")) && errors.length === 0, { phase: st.phase, seen: [...seen], errors });
    // Reduced motion: the hint has no animation.
    const { ctx: c2, p: p2 } = await openPage(b, { width: 1280, height: 800 }, { reduced: true });
    await p2.click("#start"); await p2.waitForTimeout(1500);
    const anim = await p2.evaluate(() => { const c = document.getElementById("coach"); return [getComputedStyle(c).animationName, getComputedStyle(c.querySelector(".coach-ico")).animationName]; });
    record("reduced motion: the coach hint and its icon do not animate", anim.every((a) => a === "none"), { anim });
    // Accessibility basics: polite atomic live region, not the visible hint; 44px+ tall; reticle centre not covered.
    const a = await p2.evaluate(() => { const c = document.getElementById("coach"), l = document.getElementById("coach-live"), v = document.getElementById("viewport").getBoundingClientRect(), r = c.getBoundingClientRect();
      return { live: l.getAttribute("aria-live"), role: l.getAttribute("role"), atomic: l.getAttribute("aria-atomic"), visibleIsLive: c.hasAttribute("aria-live"), height: r.height, overlapsView: r.top < v.bottom && r.bottom > v.top }; });
    record("coach: polite atomic live region, visible hint ≥ 44 px and outside the camera view", a.live === "polite" && a.role === "status" && a.atomic === "true" && !a.visibleIsLive && a.height >= 44 && !a.overlapsView, a);
    await c2.close();
  }
  await ctx.close(); await b.close();
}

// Slow-device passphrase warning: an encrypted stream with key-check frames at 8,000,000 iterations.
// "Slow device" is simulated by making PBKDF2 take 2 µs per iteration (a wrapper around deriveBits) on top of the
// real derive (about 1-1.5 s here), so the expected estimate is about 16 s + the real cost: 16-19 s is accepted.
{
  const PASS = "orbit lantern quiet mosaic thunder";
  const enc = await DQ.SenderSession.create({ name: "secret.txt", data: testFile(6000, "coach-enc"), blockSize: 400, passphrase: PASS, iterations: 8000000, startSeed: 9 });
  const dir = path.join(WORK, "enc"); fs.mkdirSync(dir);
  const files = [enc.keyFrameText, enc.textForSeed(9), enc.textForSeed(10)].map((t, i) => { const f = path.join(dir, `e_${i}.png`); fs.writeFileSync(f, encodeGray(DQ.render.toGray(DQ.render.makeQr(t, "M"), 4))); return f; });
  const slowInit = () => { const s = crypto.subtle, orig = s.deriveBits.bind(s); s.deriveBits = async (alg, key, len) => { const r = await orig(alg, key, len); if (alg && alg.name === "PBKDF2") await new Promise((res) => setTimeout(res, alg.iterations * 0.002)); return r; }; };
  const b = await chromium.launch({ executablePath: CHROME, headless: true });
  for (const [label, init] of [["simulated slow device (2 µs per iteration)", slowInit], ["this machine (headless Chrome, unthrottled)", null]]) {
    for (const vp of [{ width: 1280, height: 800 }, { width: 390, height: 844 }]) {
      const { ctx, p, errors } = await openPage(b, vp, { init });
      await p.click("details.opts summary"); await p.selectOption("#dec", "zxing");
      const t0 = Date.now();
      await p.setInputFiles("#files", files);
      let st = null;
      const has = !!(await p.$("#passslow"));
      for (let i = 0; i < 100; i++) { st = await p.evaluate(() => ({ box: !document.getElementById("passbox").hidden, slow: document.getElementById("passslow") ? (document.getElementById("passslow").hidden ? "" : document.getElementById("passslow").textContent) : null, key: document.getElementById("r-key").textContent, msg: document.getElementById("msg").textContent, est: window.__dexqrReceiver.kdfEst || null })); if (st.box && (!has || st.est)) break; await p.waitForTimeout(100); }
      const secs = (Date.now() - t0) / 1000;
      const m = { label, viewport: vp.width, warning: st.slow, estimateMs: st.est ? Math.round(st.est.ms) : null, secondsToWarning: secs, passphraseTyped: false, keyLine: st.key, pageErrors: errors };
      measurements[`kdf_${init ? "slow" : "fast"}_${vp.width}`] = m;
      if (has) {
        if (init) record(`slow-device warning shows before typing (${vp.width})`, /about 1[6-9] seconds/.test(st.slow || "") && /8,000,000/.test(st.slow) && st.est.slow && errors.length === 0 && secs < 5, m);
        else record(`no warning when this machine derives in about 1 s (${vp.width})`, st.slow === "" && st.est && !st.est.slow && st.est.ms < 3000 && errors.length === 0, m);
      } else console.log("MEASURE", JSON.stringify(m));
      if (init) { await p.evaluate(() => { const d = document.querySelector("details.opts"); if (d) d.open = false; document.getElementById("passbox").scrollIntoView({ block: "center" }); }); if (SHOTS) { const [dir2, prefix] = SHOTS; const out = path.join(path.resolve(dir2), `${prefix}_kdf-slow_${vp.width}.png`); await p.screenshot({ path: out }); console.log("saved", out); } }
      await ctx.close();
    }
  }
  await b.close();
}
record("no network requests", net.length === 0, { net });
fs.writeFileSync(OUTJSON, JSON.stringify({ when: new Date().toISOString(), root: PAGE_ROOT, measurements, results }, null, 1));
if (results.some((r) => !r.ok)) process.exitCode = 1;
