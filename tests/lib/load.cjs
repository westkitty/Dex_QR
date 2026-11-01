// Loads the exact browser scripts (vendor + src) into the Node global scope, the same way the
// built HTML pages inline them. Returns globalThis.DexQR.
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const ROOT = path.resolve(__dirname, "..", "..");
const SCRIPTS = ["vendor/qrcodegen.js", "src/base45.js", "src/crc32.js", "src/lt.js", "src/packet.js", "src/container.js", "src/session.js", "src/render.js", "src/scan.js"];
let loaded = false;
function load(extra = []) {
  if (!loaded) {
    for (const rel of SCRIPTS.concat(extra)) vm.runInThisContext(fs.readFileSync(path.join(ROOT, rel), "utf8"), { filename: rel });
    loaded = true;
  }
  return globalThis.DexQR;
}
module.exports = { load, ROOT, SCRIPTS };
