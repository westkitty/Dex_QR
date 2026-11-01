/* Dex_QR — live scan coaching for the receiver. Original code, MIT License.
 * frameStats() measures a camera frame cheaply (brightness, contrast, clipping and an edge-sharpness ratio on a
 * sparse grid of rows); ScanCoach turns per-frame samples (those stats plus what the decoder and the session
 * saw) into one calm, plain-language hint, held steady against flicker, with throttled announcements.
 * Pure logic, no DOM: the page feeds it and shows the result; tests feed it synthetic frames. */
(function (root) {
  "use strict";
  const DQ = root.DexQR || (root.DexQR = {});

  /* Brightness / contrast / sharpness of the central 80% of an RGBA frame, on a sparse grid of rows.
   * sharp = (the steepest 0.2% of one-pixel luminance steps, horizontal and vertical) / (the frame's 2nd–98th
   * percentile luminance range). A crisp black-to-white edge changes in one pixel step, so the ratio is near 1;
   * blur spreads the same change over several pixels and the ratio falls to about 1 / (blur width). It does
   * not depend on brightness, contrast or module size, and sensor-like noise moves it only a little. */
  function frameStats(rgba, w, h, opts) {
    const rows = (opts && opts.rows) || 96;
    const x0 = Math.floor(w * 0.1), x1 = Math.max(x0 + 2, Math.floor(w * 0.9) - 1);
    const y0 = Math.floor(h * 0.1), y1 = Math.max(y0 + 1, Math.floor(h * 0.9) - 1);
    const ystep = Math.max(1, Math.floor((y1 - y0) / rows)), xstep = Math.max(1, Math.floor((x1 - x0) / 720));
    const L = (x, y) => { const k = (y * w + x) * 4; return (rgba[k] * 77 + rgba[k + 1] * 150 + rgba[k + 2] * 29) >> 8; };
    const lum = new Uint32Array(256), step = new Uint32Array(256);
    let n = 0, sum = 0, sq = 0, hi = 0, lo = 0;
    for (let y = y0; y < y1 && y + 1 < h; y += ystep) {
      for (let x = x0; x < x1 && x + 1 < w; x += xstep) {
        const v = L(x, y);
        n++; sum += v; sq += v * v; lum[v]++;
        if (v >= 245) hi++; else if (v <= 12) lo++;
        step[Math.abs(L(x + 1, y) - v)]++; step[Math.abs(L(x, y + 1) - v)]++;
      }
    }
    if (!n) return { mean: 0, contrast: 0, range: 0, sharp: 0, clipHigh: 0, clipLow: 0, samples: 0 };
    const pct = (hist, total, q) => { let c = 0; const want = q * total; for (let i = 0; i < 256; i++) { c += hist[i]; if (c >= want) return i; } return 255; };
    const range = pct(lum, n, 0.98) - pct(lum, n, 0.02), steep = pct(step, 2 * n, 0.998);
    const mean = sum / n, contrast = Math.sqrt(Math.max(0, sq / n - mean * mean));
    return { mean, contrast, range, sharp: range > 0 ? Math.min(1, steep / range) : 0, clipHigh: hi / n, clipLow: lo / n, samples: n };
  }

  /* Thresholds (0–255 luminance). Chosen on synthetic frames (tests/unit/coach.test.mjs); not tuned on real
   * cameras. Darkness and glare are judged only while nothing decodes, so a well-lit white code that fills the
   * view (high mean, clipped whites) is never called "too bright" while it works. */
  const T = { dark: 50, bright: 200, glare: 0.6, blank: 10, blurry: 0.23, small: 0.3, large: 0.92 };

  const HINTS = {
    start:    { tone: "info", text: "Point the camera at the sender's screen and fill most of the view with the code." },
    looking:  { tone: "info", text: "Looking for the code. Hold the camera about a hand's width or two from the screen." },
    nocode:   { tone: "warn", text: "No code found yet. Point the camera straight at the sender's screen, with the whole code in view." },
    blank:    { tone: "warn", text: "The view is almost plain. Point the camera at the sender's screen." },
    dark:     { tone: "warn", text: "Too dark to read. Turn up the sender's screen brightness or move into better light." },
    bright:   { tone: "warn", text: "Too bright or there is glare. Tilt the phone a little, or turn the sender's screen brightness down." },
    blurry:   { tone: "warn", text: "The picture is blurry. Hold still, or move back a little so the camera can focus." },
    small:    { tone: "warn", text: "The code looks small. Move closer so it fills most of the view." },
    large:    { tone: "warn", text: "The code is cut off. Move back a little so all four corners are in view." },
    unread:   { tone: "warn", text: "A code is in view but is not reading yet. Hold steady and avoid reflections." },
    foreign:  { tone: "warn", text: "That is a QR code, but not a Dex_QR stream. Point the camera at the Dex_QR sender." },
    repeats:  { tone: "info", text: "Only repeats are arriving. Is the sender paused? Press Start sending there." },
    steady:   { tone: "ok",   text: "Locked on. Hold steady; pieces are arriving." },
    almost:   { tone: "ok",   text: "Almost there. Keep holding steady." },
  };

  class ScanCoach {
    constructor(o) {
      o = o || {};
      this.windowMs = o.windowMs || 1500;       // samples considered for a judgement
      this.holdMs = o.holdMs || 900;            // a new hint must persist this long before it is shown
      this.goodMs = o.goodMs || 1500;           // "receiving" lasts this long after the last new packet
      this.noCodeMs = o.noCodeMs || 3000;       // grace period before "no code found"
      this.announceGapMs = o.announceGapMs || 4000;
      this.reset(0);
    }
    reset(now) {
      this.samples = []; this.started = now || 0; this.lastNew = -1e12; this.lastOurs = -1e12; this.lastFound = -1e12;
      this.shown = "start"; this.candidate = "start"; this.candidateSince = now || 0;
      this.lastAnnounced = ""; this.lastAnnounceAt = -1e12; this.progress = 0;
    }
    /* sample: { t, stats: frameStats()|null, found: codes located (decoded or not), decoded: QR texts read,
     *   ours: Dex_QR packets accepted (incl. duplicates), fresh: new packets, foreign: non-Dex_QR texts,
     *   box: largest code side / frame's shorter side (0..1+) or null, edge: code touches the frame edge,
     *   progress: 0..1 } */
    push(s) {
      const t = s.t;
      this.samples.push(s);
      while (this.samples.length && this.samples[0].t < t - this.windowMs) this.samples.shift();
      if (s.fresh > 0) this.lastNew = t;
      if (s.ours > 0) this.lastOurs = t;
      if (s.found > 0 || s.decoded > 0) this.lastFound = t;
      if (typeof s.progress === "number") this.progress = s.progress;
      const want = this.judge(t);
      if (want !== this.candidate) { this.candidate = want; this.candidateSince = t; }
      // Good news and the neutral "looking" show at once; a problem must hold for holdMs so a single odd frame
      // never flips the hint.
      const hold = (want === "steady" || want === "almost" || want === "looking") ? 0 : this.holdMs;
      if (want !== this.shown && t - this.candidateSince >= hold) this.shown = want;
      return this.hint();
    }
    judge(t) {
      if (t - this.lastNew <= this.goodMs) return this.progress >= 0.85 ? "almost" : "steady";
      const w = this.samples, n = w.length;
      if (!n) return "start";
      if (t - this.lastOurs <= this.goodMs) return "repeats";
      let found = 0, foreign = 0, unread = 0, small = 0, large = 0, st = 0, mean = 0, contrast = 0, sharp = 0, hi = 0;
      for (const s of w) {
        if (s.found > 0 || s.decoded > 0) found++;
        if (s.foreign > 0) foreign++;
        if (s.found > s.decoded) unread++;
        if (s.box != null && s.box > 0) { if (s.box < T.small) small++; else if (s.box > T.large || s.edge) large++; }
        if (s.stats) { st++; mean += s.stats.mean; contrast += s.stats.contrast; sharp += s.stats.sharp; hi += s.stats.clipHigh; }
      }
      if (foreign * 2 >= n) return "foreign";
      if (st) { mean /= st; contrast /= st; sharp /= st; hi /= st; }
      if (st && mean < T.dark) return "dark";
      // Where the decoder located a code, its size is the most specific advice.
      if (large && large * 2 >= n) return "large";
      if (small && small * 2 >= n) return "small";
      if (st && (mean > T.bright || hi > T.glare)) return "bright";
      if (st && contrast < T.blank && !found) return "blank";
      if (st && sharp < T.blurry) return "blurry";
      if (unread && unread * 2 >= n) return "unread";
      if (t - Math.max(this.started, this.lastFound) >= this.noCodeMs) return "nocode";
      return "looking";
    }
    hint() { const h = HINTS[this.shown]; return { id: this.shown, tone: h.tone, text: h.text }; }
    /* Text for a polite live region: only when the shown hint changed, at most once per announceGapMs, and the
     * first "start" / "looking" states are not announced (the button press already said what happens). */
    announce(t) {
      const id = this.shown;
      if (id === this.lastAnnounced || id === "start" || id === "looking") return null;
      if (t - this.lastAnnounceAt < this.announceGapMs) return null;
      this.lastAnnounced = id; this.lastAnnounceAt = t;
      return HINTS[id].text;
    }
  }

  DQ.coach = { frameStats, ScanCoach, HINTS, THRESHOLDS: T };
})(typeof globalThis !== "undefined" ? globalThis : this);
