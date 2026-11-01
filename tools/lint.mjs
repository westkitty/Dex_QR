// Repository checks with no extra dependencies (there is no ESLint/TypeScript setup in this project):
//  1. syntax of every first-party .js/.mjs/.cjs file (node --check)
//  2. no debug leftovers (console.*, debugger) and no innerHTML in shipped source (src/)
//  3. the built pages are up to date with src/ (rebuild in memory and compare)
//  4. every built page keeps its Content-Security-Policy with no network (connect-src 'none' / default-src 'none')
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const problems = [];
const walk = (d) => fs.readdirSync(path.join(ROOT, d), { withFileTypes: true }).flatMap((e) => e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]);
const files = ["src", "tests", "tools"].flatMap(walk).filter((f) => /\.(m|c)?js$/.test(f));
for (const f of files) {
  const r = spawnSync(process.execPath, ["--check", path.join(ROOT, f)], { encoding: "utf8" });
  if (r.status !== 0) problems.push(`${f}: syntax error\n${r.stderr}`);
}
for (const f of files.filter((f) => f.startsWith("src"))) {
  fs.readFileSync(path.join(ROOT, f), "utf8").split("\n").forEach((line, i) => {
    if (/\bconsole\.(log|debug|info|warn|error)\b|\bdebugger\b/.test(line)) problems.push(`${f}:${i + 1}: debug leftover`);
    if (/\.innerHTML\s*=/.test(line)) problems.push(`${f}:${i + 1}: innerHTML assignment (build DOM nodes instead)`);
  });
}
const before = Object.fromEntries(["sender.html", "receiver.html", "index.html"].map((p) => [p, fs.readFileSync(path.join(ROOT, p), "utf8")]));
const tmp = fs.mkdtempSync(path.join(ROOT, "work", "lint-"));
// Rebuild into a temporary copy so the checked-in pages are not touched.
for (const d of ["src", "vendor", "tools"]) fs.cpSync(path.join(ROOT, d), path.join(tmp, d), { recursive: true });
const b = spawnSync(process.execPath, [path.join(tmp, "tools", "build.mjs")], { encoding: "utf8" });
if (b.status !== 0) problems.push("build failed: " + b.stderr);
for (const [p, html] of Object.entries(before)) {
  if (b.status === 0 && fs.readFileSync(path.join(tmp, p), "utf8") !== html) problems.push(`${p} is stale: run npm run build`);
  const csp = (html.match(/http-equiv="Content-Security-Policy" content="([^"]+)"/) || [])[1] || "";
  if (!/default-src 'none'/.test(csp) || (/connect-src/.test(csp) && !/connect-src 'none'/.test(csp))) problems.push(`${p}: CSP missing or allows network: ${csp}`);
}
console.log(`lint: ${files.length} files checked, ${problems.length} problem(s)`);
for (const p of problems) console.log(" - " + p);
if (problems.length) process.exitCode = 1;
