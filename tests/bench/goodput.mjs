// Goodput model shared by bench.mjs and tools/report.mjs.
// goodput (file bytes/s) = effective fps × block size × per-frame success ÷ fountain overhead.
// The receiver page can only use frames it has time to scan, so its rate is capped at 1000 / ms-per-frame.
export function goodput(r, { fps, level, engine, overhead }) {
  const rate = r[`${engine}_${level}_rate`];
  if (rate == null) return null;
  let eff = fps;
  if (engine === "zxingWasm" || engine === "jsqr") {
    const ms = r[`${engine}_${level}_ms`];
    if (ms) eff = Math.min(fps, 1000 / ms);
  }
  return Math.round((eff * r.bs * rate) / overhead);
}
