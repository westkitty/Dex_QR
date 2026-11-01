// Build the single-file pages: inline CSS, the shared header and logo, vendor libraries and Dex_QR scripts
// into sender.html / receiver.html / index.html.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => fs.readFileSync(path.join(ROOT, p), "utf8");
const css = read("src/pages/common.css");
const logo = read("src/pages/logo.svg").trim();
const core = ["src/base45.js", "src/crc32.js", "src/lt.js", "src/packet.js", "src/strength.js", "src/container.js", "src/session.js", "src/render.js", "src/ack.js"];
const pages = {
  "sender.html": { tpl: "src/pages/sender.template.html", scripts: ["vendor/qrcodegen.js", "vendor/jsQR.js", ...core, "src/scan.js", "src/pages/ui.js"], app: "src/pages/sender.app.js" },
  "receiver.html": { tpl: "src/pages/receiver.template.html", scripts: ["vendor/qrcodegen.js", "vendor/jsQR.js", "vendor/zxing-wasm-reader.js", "vendor/zxing-reader-wasm.b64.js", ...core, "src/scan.js", "src/coach.js", "src/pages/ui.js", "src/pages/blockmap.js"], app: "src/pages/receiver.app.js" },
  "index.html": { tpl: "src/pages/index.template.html", scripts: [], app: null },
};
// Theme and motion preferences are applied before first paint (no flash of the wrong theme). localStorage
// may be unavailable on file:// in some browsers; then the choice lasts for the page only.
const HEADSCRIPT = `<script>try{var d=document.documentElement,t=localStorage.getItem("dexqr-theme"),m=localStorage.getItem("dexqr-motion");if(t==="light"||t==="dark")d.setAttribute("data-theme",t);if(m==="reduce")d.setAttribute("data-motion","reduce")}catch(e){}</script>`;
const ICON_THEME = `<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path fill="currentColor" d="M12 3a9 9 0 1 0 0 18zm0 1.8a7.2 7.2 0 0 1 0 14.4z" fill-rule="evenodd"/><circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" stroke-width="1.6"/></svg>`;
const ICON_MOTION = `<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" d="M3 12c2.5-5 5.5-5 8 0s5.5 5 8 0M3 18h4M3 6h4"/></svg>`;
function header(which) {
  const sub = { home: "", send: "Send", recv: "Receive" }[which];
  const cur = (k) => (k === which ? ' aria-current="page"' : "");
  const tools = which === "home" ? "" : `<button id="motion" class="tool" type="button" aria-pressed="false" title="Reduce motion">${ICON_MOTION}<span class="lbl">Motion</span></button><button id="theme" class="tool" type="button" aria-label="Auto colour theme: automatic (follows the system). Press to change." title="Colour theme">${ICON_THEME}<span class="lbl" id="theme-lbl">Auto</span></button>`;
  return `<header class="top"><a class="brand" href="index.html">${logo}<b>Dex_QR</b>${sub ? `<span>${sub}</span>` : ""}</a><nav aria-label="Pages"><a class="home" href="index.html"${cur("home")}>Home</a><a href="sender.html"${cur("send")}>Send</a><a href="receiver.html"${cur("recv")}>Receive</a>${tools}</nav></header>`;
}
for (const [out, p] of Object.entries(pages)) {
  let html = read(p.tpl).replace("/*INLINE_CSS*/", () => css);
  html = html.replace(/<!--HEADER:(\w+)-->/, (_, w) => header(w)).replace("<!--HEADSCRIPT-->", () => HEADSCRIPT);
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
