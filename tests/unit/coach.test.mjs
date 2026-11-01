// Live scan coaching (cycle 7): frame statistics on synthetic camera-like frames and the hint logic fed with
// sequences of samples at 10 frames per second. Thresholds are synthetic-frame values, not real-camera ones.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const DQ = require("../lib/load.cjs").load();
const { frame } = require("../lib/synthframe.cjs");
const { frameStats, ScanCoach, HINTS, THRESHOLDS: T } = DQ.coach;

const sender = await DQ.SenderSession.create({ name: "c.bin", data: new Uint8Array(5000).map((_, i) => (i * 7) & 255), blockSize: 400 });
const qr = DQ.render.toGray(DQ.render.makeQr(sender.nextText(), "M"), 1);   // 1 px per module; scaled in frame()
const W = 960, H = 540;
const stats = (o) => { const f = frame({ w: W, h: H, ...o }); return frameStats(f.data, f.width, f.height); };

// A run of identical samples at 10 fps; returns the hints seen (deduplicated) and the last one.
function run(coach, t0, secs, sample) {
  const seen = []; let h, t = t0;
  for (let i = 0; i < secs * 10; i++, t += 100) { h = coach.push({ t, stats: null, found: 0, decoded: 0, ours: 0, fresh: 0, foreign: 0, box: null, edge: false, ...sample(i, t) }); if (seen[seen.length - 1] !== h.id) seen.push(h.id); }
  return { seen, last: h, t };
}
const firstTime = (coach, t0, secs, sample, id) => { let t = t0; for (let i = 0; i < secs * 10; i++, t += 100) { const h = coach.push({ t, stats: null, found: 0, decoded: 0, ours: 0, fresh: 0, foreign: 0, box: null, edge: false, ...sample(i, t) }); if (h.id === id) return t - t0; } return null; };

test("frameStats: a crisp, well-lit code is bright enough, contrasty and sharp", () => {
  for (const mod of [3, 4, 6, 9]) {
    const s = stats({ qr, scale: mod });
    assert.ok(s.mean > T.dark && s.mean < T.bright, `mod ${mod} mean ${s.mean}`);
    assert.ok(s.contrast > T.blank, `mod ${mod} contrast ${s.contrast}`);
    assert.ok(s.sharp >= 0.9, `mod ${mod} sharp ${s.sharp}`);
    assert.ok(s.clipHigh < T.glare, `mod ${mod} clipHigh ${s.clipHigh}`);
  }
});

test("frameStats: sharpness falls monotonically with blur, independent of brightness and module size", () => {
  for (const mod of [3, 6]) {
    let prev = 2;
    for (const blur of [0, 1, 2, 3, 5]) { const s = stats({ qr, scale: mod, blur, passes: 2 }); assert.ok(s.sharp < prev, `mod ${mod} blur ${blur}: ${s.sharp} !< ${prev}`); prev = s.sharp; }
    const a = stats({ qr, scale: mod, blur: 3, passes: 2 }), b = stats({ qr, scale: mod, blur: 3, passes: 2, gain: 0.6, offset: 40 });
    assert.ok(Math.abs(a.sharp - b.sharp) < 0.05, `brightness changed sharpness ${a.sharp} vs ${b.sharp}`);
    assert.ok(stats({ qr, scale: mod, blur: 3, passes: 2, noise: 6, seed: 9 }).sharp < T.blurry, "blurred + noise still blurry");
  }
  assert.ok(stats({ qr, scale: 6, blur: 1 }).sharp > T.blurry, "a slight blur that decoders still read is not called blurry");
});

test("frameStats: dark, blown-out and blank frames", () => {
  const dark = stats({ qr, scale: 5, gain: 0.15, offset: 5, noise: 3 });
  assert.ok(dark.mean < T.dark, "dark " + dark.mean);
  const bright = stats({ qr, scale: 5, gain: 0.3, offset: 200 });
  assert.ok(bright.mean > T.bright, "bright " + bright.mean);
  const blank = stats({ bg: 120, noise: 3 });
  assert.ok(blank.contrast < T.blank, "blank contrast " + blank.contrast);
  const z = frameStats(new Uint8ClampedArray(0), 0, 0);
  assert.equal(z.samples, 0);
});

test("frameStats is cheap: under 3 ms for a 1080x608 frame", () => {
  const f = frame({ w: 1080, h: 608, qr, scale: 6 });
  for (let i = 0; i < 5; i++) frameStats(f.data, f.width, f.height);
  const t0 = performance.now(); for (let i = 0; i < 50; i++) frameStats(f.data, f.width, f.height);
  const ms = (performance.now() - t0) / 50;
  assert.ok(ms < 3, ms + " ms");
});

test("coach: each bad camera condition gets its own plain-language hint within 2 s", () => {
  const cases = {
    dark: { stats: stats({ qr, scale: 5, gain: 0.15, offset: 5, noise: 3 }) },
    bright: { stats: stats({ qr, scale: 5, gain: 0.3, offset: 200 }) },
    blank: { stats: stats({ bg: 120, noise: 3 }) },
    blurry: { stats: stats({ qr, scale: 4, blur: 3, passes: 2 }) },
    small: { stats: stats({ qr, scale: 2 }), found: 1, box: 0.18 },
    large: { stats: stats({ qr, scale: 9 }), found: 1, box: 0.97, edge: true },
    unread: { stats: stats({ qr, scale: 5 }), found: 1, decoded: 0, box: 0.6 },
    foreign: { stats: stats({ qr, scale: 5 }), found: 1, decoded: 1, foreign: 1, box: 0.6 },
  };
  for (const [id, sample] of Object.entries(cases)) {
    const c = new ScanCoach(); c.reset(0);
    const ms = firstTime(c, 0, 4, () => sample, id);
    assert.ok(ms != null && ms <= 2000, `${id}: reached after ${ms} ms; saw ${JSON.stringify(run(new ScanCoach(), 0, 4, () => sample).seen)}`);
    assert.ok(HINTS[id].text.length < 120 && !/[A-Z]{3,}|rank|LT|K =/.test(HINTS[id].text), id + " hint is plain language");
  }
});

test("coach: a sharp, normal scene with no code says 'no code found' only after the grace period", () => {
  const c = new ScanCoach(); c.reset(0);
  const s = stats({ qr, scale: 5 });
  const r = run(c, 0, 2.5, () => ({ stats: s }));
  assert.deepEqual(r.seen, ["looking"]);
  const ms = firstTime(c, 2500, 3, () => ({ stats: s }), "nocode");
  assert.ok(ms != null && 2500 + ms >= 3000 && 2500 + ms <= 4100, "nocode at " + (2500 + ms));
});

test("coach: new packets show 'locked on' at once, 'almost there' near the end, and repeats when the sender pauses", () => {
  const c = new ScanCoach(); c.reset(0);
  const dark = stats({ gain: 0.2 });
  run(c, 0, 3, () => ({ stats: dark }));
  assert.equal(c.hint().id, "dark");
  let h = c.push({ t: 3000, stats: stats({ qr, scale: 5 }), found: 1, decoded: 1, ours: 1, fresh: 1, foreign: 0, box: 0.6, progress: 0.2 });
  assert.equal(h.id, "steady", "good news is immediate");
  h = c.push({ t: 3100, stats: stats({ qr, scale: 5 }), found: 1, decoded: 1, ours: 1, fresh: 1, foreign: 0, box: 0.6, progress: 0.9 });
  assert.equal(h.id, "almost");
  // The sender pauses: the same packet repeats.
  const r = run(c, 3200, 4, () => ({ stats: stats({ qr, scale: 5 }), found: 1, decoded: 1, ours: 1, fresh: 0, box: 0.6, progress: 0.9 }));
  assert.equal(r.last.id, "repeats");
});

test("coach: hysteresis — one bad frame in a good run, or a flickering condition, never flips the hint", () => {
  const c = new ScanCoach(); c.reset(0);
  const good = stats({ qr, scale: 5 }), dark = stats({ gain: 0.2 });
  // Packets every other frame with an occasional dark frame in between.
  const r = run(c, 0, 10, (i) => (i % 7 === 3 ? { stats: dark } : { stats: good, found: 1, decoded: 1, ours: 1, fresh: (i + 1) % 2, box: 0.6, progress: i / 200 }));
  assert.deepEqual(r.seen, ["steady"]);
  // Alternating dark and blank every 300 ms (neither holds 900 ms): the shown hint changes at most once.
  const c2 = new ScanCoach(); c2.reset(0);
  const blank = stats({ bg: 120 });
  const r2 = run(c2, 0, 6, (i) => ({ stats: Math.floor(i / 3) % 2 ? dark : blank }));
  assert.ok(r2.seen.length <= 2, JSON.stringify(r2.seen));
});

test("coach: announcements are polite-sized — only on change, never the opening states, at most one per 4 s", () => {
  const c = new ScanCoach(); c.reset(0);
  const seq = [["dark", stats({ gain: 0.2 })], ["blank", stats({ bg: 120 })], ["blurry", stats({ qr, scale: 4, blur: 3, passes: 2 })], ["dark", stats({ gain: 0.2 })]];
  const said = []; let t = 0;
  for (const [, s] of seq) for (let i = 0; i < 15; i++, t += 100) { c.push({ t, stats: s, found: 0, decoded: 0, ours: 0, fresh: 0, foreign: 0, box: null }); const a = c.announce(t); if (a) said.push({ t, a }); }
  assert.ok(said.length >= 2, JSON.stringify(said));
  for (let i = 1; i < said.length; i++) { assert.ok(said[i].t - said[i - 1].t >= 4000, "gap"); assert.notEqual(said[i].a, said[i - 1].a); }
  assert.ok(!said.some((x) => x.a === HINTS.start.text || x.a === HINTS.looking.text));
  // Steady state: no repeated announcements while nothing changes.
  const c2 = new ScanCoach(); c2.reset(0); let n = 0;
  for (let t2 = 0; t2 < 20000; t2 += 100) { c2.push({ t: t2, stats: stats({ gain: 0.2 }), found: 0, decoded: 0, ours: 0, fresh: 0, foreign: 0, box: null }); if (c2.announce(t2)) n++; }
  assert.equal(n, 1);
});

test("coach: memory stays bounded over a long session (window of samples only)", () => {
  const c = new ScanCoach(); c.reset(0);
  const s = stats({ qr, scale: 5 });
  for (let t = 0; t < 600000; t += 33) c.push({ t, stats: s, found: 1, decoded: 1, ours: 1, fresh: t % 99 === 0 ? 1 : 0, foreign: 0, box: 0.6 });
  assert.ok(c.samples.length <= 50, "samples " + c.samples.length);
});
