// Generate docs/RESULTS.md and docs/BENCHMARK.md tables from results/*.json.
import fs from "node:fs";
import { goodput } from "../tests/bench/goodput.mjs";
import path from "node:path";
import { fileURLToPath } from "node:url";
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const R = (f) => JSON.parse(fs.readFileSync(path.join(ROOT, "results", f)));
const pct = (x) => (x == null ? "–" : (100 * x).toFixed(1) + "%");
const f3 = (x) => (x == null ? "–" : x.toFixed(3));
const kib = (n) => (n / 1024) + " KiB";
let md = "";
const sizes = [10240, 102400, 512000];

// ---- trials
md += "## Drop-rate trials (100 trials per cell, real decoder output)\n\n";
const t0 = R(`trials_10240_zbar.json`);
md += `Settings: block size ${t0.manifest.blockSize} B, EC ${t0.manifest.ecl}, QR version ${t0.manifest.qrVersion} (${t0.manifest.textLength} alphanumeric characters), ${t0.manifest.scale} px/module PNG frames. Overhead = unique packets the receiver used ÷ K (1.000 = no overhead). "Frames shown ÷ K" counts every frame displayed from the random start frame until decoding finished, including dropped ones.\n\n`;
for (const dec of ["zbar", "zxing"]) {
  md += `### Decoder: ${dec === "zbar" ? "zbar 0.23.x (via pyzbar)" : "zxing-cpp (Python bindings)"}\n\n`;
  md += "| File | K | Frame drop | Success | Overhead mean | p50 | p95 | max | Frames shown ÷ K, mean (max) |\n|---|---|---|---|---|---|---|---|---|\n";
  for (const s of sizes) {
    const t = R(`trials_${s}_${dec}.json`);
    for (const row of t.summary) md += `| ${kib(s)} | ${row.K} | ${row.drop * 100}% | **${row.success}/${row.trials}** | ${f3(row.overheadMean)} | ${f3(row.overheadP50)} | ${f3(row.overheadP95)} | ${f3(row.overheadMax)} | ${f3(row.framesShownPerKMean)} (${f3(row.framesShownPerKMax)}) |\n`;
  }
  const rates = sizes.map((s) => { const t = R(`trials_${s}_${dec}.json`); return `${kib(s)}: ${t.decoderSummary.decoded}/${t.decoderSummary.files} frames decoded, ${t.decoderSummary.ms_per_frame_mean} ms/frame`; });
  md += `\nPer-frame decode with ${dec}: ${rates.join("; ")}.\n\n`;
}
// ---- video e2e
md += "## Truly end-to-end runs: H.264 video → ffmpeg → zbar → decoder → SHA-256\n\n";
md += "Per run: random start frame, i.i.d. frame drops applied to the sender's frames, the remaining frames encoded as H.264 (libx264, CRF 23, yuv420p, 10 fps), decoded back to images by ffmpeg, read by zbar, fed to the receiver code, and the output compared by SHA-256. Nothing is cached in this path.\n\n";
md += "| File | K | Drop | Runs OK | Overhead per run | zbar frames decoded / video frames |\n|---|---|---|---|---|---|\n";
for (const s of sizes) {
  const v = R(`video_e2e_${s}.json`);
  for (const p of [0.1, 0.3, 0.5]) {
    const rows = v.rows.filter((r) => r.drop === p);
    md += `| ${kib(s)} | ${rows[0].K} | ${p * 100}% | **${rows.filter((r) => r.ok).length}/${rows.length}** | ${rows.map((r) => f3(r.overhead)).join(", ")} | ${rows.map((r) => r.framesDecodedByZbar + "/" + r.videoFrames).join(", ")} |\n`;
  }
}
md += "\n";
// ---- browser
const b = R("browser.json");
md += `## Headless browser tests (Chrome ${b.chrome}, pages loaded from file://)\n\n`;
md += `Network requests outside file:/data:/blob: during all page tests: **${b.networkRequestsOutsideFileDataBlob.length}**. Pages run with their real Content-Security-Policy.\n\n`;
md += "| Test | Result | Details |\n|---|---|---|\n";
for (const r of b.results) {
  const d = [];
  if (r.decoder) d.push(`decoder ${r.decoder}`);
  if (r.K != null) d.push(`K ${r.K}`);
  if (r.framesGiven != null) d.push(`${r.framesGiven} frames given, ${r.framesScanned} scanned`);
  if (r.framesRendered != null) d.push(`${r.framesRendered} frames rendered by the page, ${r.framesDecodedByZbar} read by zbar, decoded after ${r.framesUsed}`);
  if (r.cameraFramesScanned != null) d.push(`fake camera ${r.fakeCameraFps} fps, ${r.cameraFramesScanned} camera frames scanned, ${r.uniquePackets} unique packets, ${r.duplicates} duplicates`);
  if (r.overhead != null) d.push(`overhead ${f3(r.overhead)}`);
  if (r.phase) d.push(`final state “${r.phase}”`);
  if (r.afterWrong) d.push(`after wrong passphrase: “${r.afterWrong}”`);
  if (r.downloadSha256Matches != null) d.push(`downloaded file SHA-256 matches: ${r.downloadSha256Matches}`);
  if (r.seconds != null) d.push(`${r.seconds.toFixed(1)} s`);
  md += `| ${r.name} | ${r.ok ? "PASS" : "**FAIL**"} | ${d.join("; ")} |\n`;
}
md += "\n";
// ---- codec sweep
const sw = R("lt_sweep.json");
md += `## Codec-only overhead (no QR), ${sw.trials} trials per cell\n\nPackets needed ÷ K for the chosen protocol parameters, and for peeling-only decoding for comparison (from results/lt_sweep.json).\n\n| K | c | δ | Decoder | mean | p95 | p99 | max |\n|---|---|---|---|---|---|---|---|\n`;
for (const r of sw.rows.filter((r) => (r.c === 0.1 && r.delta === 0.05) || (r.c === 0.03 && r.delta === 0.5))) md += `| ${r.K} | ${r.c} | ${r.delta} | ${r.decoder} | ${f3(r.mean)} | ${f3(r.p95)} | ${f3(r.p99)} | ${f3(r.max)} |\n`;
const resultsHeader = fs.readFileSync(path.join(ROOT, "docs", "RESULTS.head.md"), "utf8");
fs.writeFileSync(path.join(ROOT, "docs", "RESULTS.md"), resultsHeader + "\n" + md);

// ---- benchmark
let be;
if (fs.existsSync(path.join(ROOT, "results", "bench_L.json"))) {
  const parts = ["L", "M", "Q"].filter((e) => fs.existsSync(path.join(ROOT, "results", `bench_${e}.json`))).map((e) => R(`bench_${e}.json`));
  be = { ...parts[0], rows: parts.flatMap((p) => p.rows).map((r) => Object.fromEntries(Object.entries(r).filter(([k]) => !k.startsWith("goodput_Bps_")))), mergedFrom: parts.length, note: "goodput is derived in tools/report.mjs via tests/bench/goodput.mjs" };
  fs.writeFileSync(path.join(ROOT, "results", "bench.json"), JSON.stringify(be, null, 1));
} else be = R("bench.json");
let bm = fs.readFileSync(path.join(ROOT, "docs", "BENCHMARK.head.md"), "utf8") + "\n";
bm += `### Decode success rate per frame (${be.frames} frames per config; jsQR and zxing-wasm in-page on the first 30)\n\n| Block | EC | QR ver. | Modules | zbar clean / moderate / harsh | zxing-cpp clean / mod. / harsh | page zxing-wasm clean / mod. / harsh | page jsQR clean / mod. / harsh |\n|---|---|---|---|---|---|---|---|\n`;
for (const r of be.rows) {
  if (!r.version) { bm += `| ${r.bs} | ${r.ecl} | – | – | ${r.note} | | | |\n`; continue; }
  const t = (e) => ["clean", "moderate", "harsh"].map((k) => pct(r[`${e}_${k}_rate`])).join(" / ");
  bm += `| ${r.bs} | ${r.ecl} | ${r.version} | ${r.modules} | ${t("zbar")} | ${t("zxing")} | ${t("zxingWasm")} | ${t("jsqr")} |\n`;
}
bm += `\n### Decode time per frame (ms, one CPU core of the test box)\n\n| Block | EC | zbar clean / mod. / harsh | zxing-cpp | page zxing-wasm | page jsQR | QR encode (sender) |\n|---|---|---|---|---|---|---|\n`;
const ms = (r, e) => ["clean", "moderate", "harsh"].map((k) => (r[`${e}_${k}_ms`] == null ? "–" : Number(r[`${e}_${k}_ms`]).toFixed(1))).join(" / ");
for (const r of be.rows) if (r.version) bm += `| ${r.bs} | ${r.ecl} | ${ms(r, "zbar")} | ${ms(r, "zxing")} | ${ms(r, "zxingWasm")} | ${ms(r, "jsqr")} | ${r.encodeMsPerFrame} |\n`;
const gp = (r, fps, level, engine) => { const v = goodput(r, { fps, level, engine, overhead: be.overheadAssumed }); return v == null ? "–" : v; };
bm += `\n### Goodput in file bytes per second (after ${be.overheadAssumed}× fountain overhead; header and Base45 costs are already outside the block size)\n\nGoodput = fps × block size × per-frame success ÷ ${be.overheadAssumed}. For the receiver page engines, the frame rate is also capped at what the page can decode (1000 ÷ ms per frame). Computed by \`tests/bench/goodput.mjs\` from the measured rates and times above.\n\n| Block | EC | QR ver. | 10 fps moderate: zbar / page zxing-wasm / page jsQR | 10 fps harsh: zbar / page zxing-wasm / page jsQR | 15 fps moderate: zbar / page zxing-wasm | 20 fps moderate: page zxing-wasm |\n|---|---|---|---|---|---|---|\n`;
for (const r of be.rows) if (r.version) bm += `| ${r.bs} | ${r.ecl} | ${r.version} | ${gp(r, 10, "moderate", "zbar")} / ${gp(r, 10, "moderate", "zxingWasm")} / ${gp(r, 10, "moderate", "jsqr")} | ${gp(r, 10, "harsh", "zbar")} / ${gp(r, 10, "harsh", "zxingWasm")} / ${gp(r, 10, "harsh", "jsqr")} | ${gp(r, 15, "moderate", "zbar")} / ${gp(r, 15, "moderate", "zxingWasm")} | ${gp(r, 20, "moderate", "zxingWasm")} |\n`;
bm += "\n" + fs.readFileSync(path.join(ROOT, "docs", "BENCHMARK.tail.md"), "utf8");
fs.writeFileSync(path.join(ROOT, "docs", "BENCHMARK.md"), bm);
console.log("wrote docs/RESULTS.md and docs/BENCHMARK.md");
