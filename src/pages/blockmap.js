/* Dex_QR receiver block map (cycle 6): a grid of squares that fills as the transfer's information arrives,
 * with a short completion animation. Original code, MIT License.
 *
 * Honesty note: for K <= 3000 the decoder solves all blocks at once at the end (maximum-likelihood mode),
 * so a lit square stands for a share of the collected information (rank), lit in a fixed shuffled order.
 * In "peel" mode (K > 3000) a square lights when the blocks it stands for are actually resolved.
 * Drawing happens only while something animates; requestAnimationFrame pauses in hidden tabs. */
(function () {
  "use strict";
  const MAX_CELLS = 320, GAP = 3, NEW_MS = 700, CELEBRATE_MS = 1500;
  class BlockMap {
    constructor(canvas, ui) {
      this.c = canvas; this.g = canvas.getContext("2d"); this.ui = ui;
      this.K = 0; this.N = 0; this.lit = new Uint8Array(0); this.litAt = new Float64Array(0); this.order = null;
      this.doneAt = 0; this.raf = 0; this.lastActive = 0; this.particles = [];
      this.layoutKey = ""; this.colors = null;
      this.frameCount = 0;                       // frames drawn (read by tests to check the loop goes idle)
      const ro = window.ResizeObserver ? new ResizeObserver(() => { this.layoutKey = ""; this.draw(performance.now()); }) : null;
      if (ro) ro.observe(canvas.parentElement);
      document.addEventListener("visibilitychange", () => { if (!document.hidden) this.kick(); });
      window.addEventListener("dexqr-theme", () => { this.colors = null; this.draw(performance.now()); });
      if (window.matchMedia) { const m = window.matchMedia("(prefers-color-scheme: light)"); if (m.addEventListener) m.addEventListener("change", () => { this.colors = null; this.draw(performance.now()); }); }
      this.reset();
    }
    reset() { this.K = 0; this.setCells(96); this.doneAt = 0; this.particles = []; this.draw(performance.now()); }
    setCells(n) {
      this.N = n; this.lit = new Uint8Array(n); this.litAt = new Float64Array(n); this.layoutKey = "";
      // Fixed pseudo-random fill order (xorshift seeded by n) so progress sparkles across the grid instead of sweeping.
      const o = Array.from({ length: n }, (_, i) => i); let x = (n * 2654435761) >>> 0 || 1;
      for (let i = n - 1; i > 0; i--) { x ^= x << 13; x >>>= 0; x ^= x >>> 17; x ^= x << 5; x >>>= 0; const j = x % (i + 1); [o[i], o[j]] = [o[j], o[i]]; }
      this.order = o;
    }
    /** have = progress count (0..K); known = per-block array in peel mode (else null). */
    update(K, have, known) {
      if (K !== this.K) { this.K = K; this.setCells(Math.min(K, MAX_CELLS)); this.doneAt = 0; }
      const now = performance.now(), N = this.N;
      let changed = false;
      const light = (i) => { if (!this.lit[i]) { this.lit[i] = 1; this.litAt[i] = now; changed = true; } };
      if (known && have < K) {
        for (let i = 0; i < N; i++) {
          const a = Math.floor((i * K) / N), b = Math.max(a + 1, Math.floor(((i + 1) * K) / N));
          let k = 0; for (let j = a; j < b; j++) if (known[j]) k++;
          if (k * 2 >= b - a) light(i);
        }
      } else {
        const L = have >= K ? N : Math.min(N - 1, Math.floor((have / K) * N));
        for (let r = 0; r < L; r++) light(this.order[r]);
      }
      if (changed) { this.lastActive = now; this.kick(); }
    }
    celebrate() {
      if (this.doneAt) return;
      for (let i = 0; i < this.N; i++) if (!this.lit[i]) { this.lit[i] = 1; this.litAt[i] = 0; }
      this.doneAt = performance.now();
      if (!this.ui.reducedMotion()) {
        const w = this.c.width, h = this.c.height, cx = w / 2, cy = h / 2, dpr = this.dpr || 1;
        this.particles = Array.from({ length: 42 }, (_, i) => { const a = (i / 42) * Math.PI * 2 + Math.random() * 0.2, v = (0.12 + Math.random() * 0.22) * dpr; return { x: cx, y: cy, vx: Math.cos(a) * v, vy: Math.sin(a) * v, r: (1.5 + Math.random() * 2.5) * dpr }; });
      }
      this.lastActive = this.doneAt; this.kick();
    }
    kick() {
      if (this.raf) return;
      if (this.ui.reducedMotion()) { this.draw(performance.now()); return; }
      const step = (ts) => {
        this.raf = 0;
        this.draw(ts);
        const busy = ts - this.lastActive < NEW_MS + 50 || (this.doneAt && ts - this.doneAt < CELEBRATE_MS);
        if (busy && !document.hidden) this.raf = requestAnimationFrame(step);
      };
      this.raf = requestAnimationFrame(step);
    }
    layout() {
      const dpr = Math.min(2, window.devicePixelRatio || 1), W = Math.max(120, this.c.parentElement.clientWidth - 26);
      const key = W + "x" + this.N + "@" + dpr;
      if (key === this.layoutKey) return;
      this.layoutKey = key; this.dpr = dpr;
      let s = Math.floor(Math.sqrt((W * 130) / this.N)) - GAP; s = Math.max(5, Math.min(26, s));
      const cols = Math.max(1, Math.floor((W + GAP) / (s + GAP))), rows = Math.ceil(this.N / cols);
      this.s = s; this.cols = cols; this.rows = rows;
      this.ox = Math.floor((W - (cols * (s + GAP) - GAP)) / 2);
      const H = rows * (s + GAP) - GAP;
      this.c.width = Math.round(W * dpr); this.c.height = Math.round(H * dpr);
    }
    draw(now) {
      this.layout();
      if (!this.colors) { const v = (n) => this.ui.cssVar(n); this.colors = { cell: v("--cell"), on: v("--cell-on"), done: v("--cell-done"), glow: v("--acc2") || v("--cell-on") }; }
      const g = this.g, dpr = this.dpr, s = this.s, col = this.colors, reduce = this.ui.reducedMotion();
      this.frameCount++;
      g.setTransform(1, 0, 0, 1, 0, 0); g.clearRect(0, 0, this.c.width, this.c.height);
      g.setTransform(dpr, 0, 0, dpr, 0, 0);
      const maxD = Math.hypot(this.cols / 2, this.rows / 2) || 1;
      for (let i = 0; i < this.N; i++) {
        const cx = i % this.cols, cy = (i / this.cols) | 0;
        let x = this.ox + cx * (s + GAP), y = cy * (s + GAP), size = s, color = col.cell, glow = 0;
        if (this.lit[i]) {
          color = col.on;
          const age = now - this.litAt[i];
          if (!reduce && this.litAt[i] && age < NEW_MS) { const k = 1 - age / NEW_MS; size = s * (1 + 0.35 * k); glow = k; }
          if (this.doneAt) {
            const delay = (Math.hypot(cx - this.cols / 2 + 0.5, cy - this.rows / 2 + 0.5) / maxD) * 500;
            const t = reduce ? 1 : (now - this.doneAt - delay) / 300;
            if (t >= 0) { color = col.done; if (t < 1) { size = s * (1 + 0.22 * Math.sin(Math.PI * t)); glow = Math.max(glow, 1 - t); } }
          }
        }
        const d = (size - s) / 2; x -= d; y -= d;
        if (glow > 0) { g.shadowColor = color; g.shadowBlur = 6 * glow; } else g.shadowBlur = 0;
        g.fillStyle = color;
        const r = Math.min(4, size / 3.5);
        g.beginPath(); if (g.roundRect) g.roundRect(x, y, size, size, r); else g.rect(x, y, size, size); g.fill();
      }
      g.shadowBlur = 0;
      if (this.particles.length && this.doneAt && !reduce) {
        const t = now - this.doneAt;
        g.setTransform(1, 0, 0, 1, 0, 0);
        if (t < 1000) {
          g.fillStyle = col.done;
          for (const p of this.particles) { g.globalAlpha = Math.max(0, 1 - t / 1000); g.beginPath(); g.arc(p.x + p.vx * t, p.y + p.vy * t + 0.00012 * t * t * dpr, p.r, 0, Math.PI * 2); g.fill(); }
          g.globalAlpha = 1;
        } else this.particles = [];
      }
    }
  }
  window.DexBlockMap = BlockMap;
})();
