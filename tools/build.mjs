// Build the single-file pages: inline CSS, vendor libraries and Dex_QR scripts into sender.html / receiver.html / index.html.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => fs.readFileSync(path.join(ROOT, p), "utf8");
const css = read("src/pages/common.css");
const core = ["src/base45.js", "src/crc32.js", "src/lt.js", "src/packet.js", "src/strength.js", "src/container.js", "src/session.js", "src/render.js"];
const pages = {
  "sender.html": { tpl: "src/pages/sender.template.html", scripts: ["vendor/qrcodegen.js", ...core], app: "src/pages/sender.app.js" },
  "receiver.html": { tpl: "src/pages/receiver.template.html", scripts: ["vendor/qrcodegen.js", "vendor/jsQR.js", "vendor/zxing-wasm-reader.js", "vendor/zxing-reader-wasm.b64.js", ...core, "src/scan.js"], app: "src/pages/receiver.app.js" },
  "index.html": { tpl: "src/pages/index.template.html", scripts: [], app: null },
};
for (const [out, p] of Object.entries(pages)) {
  let html = read(p.tpl).replace("/*INLINE_CSS*/", () => css);
  const blocks = p.scripts.map((s) => {
    const src = read(s);
    if (/<\/script/i.test(src)) throw new Error(s + " contains </script");
    return `<script>/* ---- ${s} ---- */\n${src}\n</script>`;
  }).join("\n");
  html = html.replace("<!--INLINE_SCRIPTS-->", () => blocks);
  if (p.app) html = html.replace("/*INLINE_APP*/", () => read(p.app));
  fs.writeFileSync(path.join(ROOT, out), html);
  console.log(out, html.length, "bytes");
}
