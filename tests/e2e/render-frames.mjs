// Render a sender stream to PNG frames using the same code as sender.html (SenderSession + qrcodegen).
// Usage: node tests/e2e/render-frames.mjs --size 10240 --bs 600 --ecl M --frames 200 --scale 4 --out work/f10k [--pass PHRASE]
import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
const require = createRequire(import.meta.url);
const DQ = require("../lib/load.cjs").load();
const { encodeGray } = require("../lib/png.cjs");
const { testFile } = require("../lib/testfile.cjs");
const args = Object.fromEntries(process.argv.slice(2).reduce((a, x, i, arr) => (x.startsWith("--") ? a.concat([[x.slice(2), arr[i + 1]]]) : a), []));
const size = Number(args.size), bs = Number(args.bs || 600), ecl = args.ecl || "M", scale = Number(args.scale || 4);
const out = args.out; fs.mkdirSync(out, { recursive: true });
const data = testFile(size);
const s = await DQ.SenderSession.create({ name: `test_${size}.bin`, mime: "application/octet-stream", data, blockSize: bs, passphrase: args.pass, iterations: args.pass ? 600000 : undefined, startSeed: 0 });
const frames = Number(args.frames || Math.ceil(s.K * 5.2) + 60);
fs.writeFileSync(path.join(out, "original.bin"), data);
const texts = [];
let version = 0, dim = 0;
const t0 = Date.now();
for (let i = 0; i < frames; i++) {
  const text = s.nextText(); texts.push(text);
  const qr = DQ.render.makeQr(text, ecl); version = qr.version;
  const g = DQ.render.toGray(qr, scale); dim = g.width;
  fs.writeFileSync(path.join(out, `frame_${String(i).padStart(5, "0")}.png`), encodeGray(g));
}
const manifest = { size, blockSize: bs, ecl, scale, K: s.K, payloadLength: s.payload.length, encrypted: s.encrypted, fileIdHex: DQ.packet.hex(s.fileId), qrVersion: version, imagePx: dim, frames, textLength: texts[0].length, sha256: crypto.createHash("sha256").update(data).digest("hex"), renderMs: Date.now() - t0 };
fs.writeFileSync(path.join(out, "manifest.json"), JSON.stringify(manifest, null, 1));
fs.writeFileSync(path.join(out, "texts.json"), JSON.stringify(texts));
console.log(JSON.stringify(manifest));
