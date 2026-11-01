// Synthetic camera-like frames for the scan-coaching tests (test-only, original code).
// A rendered Dex_QR code is placed on a mid-grey "room" background, then optionally blurred (separable box
// blur, applied `passes` times), dimmed or brightened (gain/offset), clipped and given seeded noise.
"use strict";
function mulberry32(a) { return function () { a |= 0; a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
function boxBlur(g, w, h, r) {
  if (r <= 0) return g;
  const tmp = new Float32Array(w * h), out = new Float32Array(w * h), k = 2 * r + 1;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { let s = 0; for (let d = -r; d <= r; d++) s += g[y * w + Math.min(w - 1, Math.max(0, x + d))]; tmp[y * w + x] = s / k; }
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { let s = 0; for (let d = -r; d <= r; d++) s += tmp[Math.min(h - 1, Math.max(0, y + d)) * w + x]; out[y * w + x] = s / k; }
  return out;
}
/* opts: { w, h, qr: {width,height,data}|null, scale: frame px per bitmap px, cx, cy (0..1 centre), bg, blur, passes,
 *         gain, offset, noise (sd), seed } -> { data: RGBA Uint8ClampedArray, width, height } */
function frame(o) {
  const w = o.w || 640, h = o.h || 480, bg = o.bg == null ? 96 : o.bg;
  let g = new Float32Array(w * h).fill(bg);
  if (o.qr) {
    const s = o.scale || 1, qw = Math.round(o.qr.width * s), qh = Math.round(o.qr.height * s);
    const ox = Math.round((o.cx == null ? 0.5 : o.cx) * w - qw / 2), oy = Math.round((o.cy == null ? 0.5 : o.cy) * h - qh / 2);
    for (let y = 0; y < qh; y++) for (let x = 0; x < qw; x++) {
      const fx = ox + x, fy = oy + y; if (fx < 0 || fy < 0 || fx >= w || fy >= h) continue;
      g[fy * w + fx] = o.qr.data[Math.min(o.qr.height - 1, Math.floor(y / s)) * o.qr.width + Math.min(o.qr.width - 1, Math.floor(x / s))];
    }
  }
  for (let p = 0; p < (o.passes || 1); p++) g = boxBlur(g, w, h, o.blur || 0);
  const rnd = mulberry32(o.seed || 1), gain = o.gain == null ? 1 : o.gain, off = o.offset || 0, sd = o.noise || 0;
  const rgba = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < w * h; i++) {
    let v = g[i] * gain + off;
    if (sd) v += sd * (rnd() + rnd() + rnd() - 1.5) * 2;   // roughly normal, sd-ish
    rgba[i * 4] = rgba[i * 4 + 1] = rgba[i * 4 + 2] = v; rgba[i * 4 + 3] = 255;
  }
  return { data: rgba, width: w, height: h };
}
module.exports = { frame, boxBlur };
