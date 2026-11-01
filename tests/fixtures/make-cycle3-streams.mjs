// Writes tests/fixtures/cycle3_streams.json: QR texts produced by the cycle-3 Dex_QR build (commit 8949cb7, fixed
// PBKDF2 600,000 iterations, key-check frames on or off), so cycle-4+ receivers can be proven to open them.
// Usage: mkdir -p work/base-8949cb7 && git archive 8949cb7 src | tar -x -C work/base-8949cb7
//        node tests/fixtures/make-cycle3-streams.mjs work/base-8949cb7
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
const base = path.resolve(process.argv[2] || "work/base-8949cb7");
const ctx = vm.createContext({ TextEncoder, TextDecoder, crypto: globalThis.crypto, console, Uint8Array, Math, CompressionStream, DecompressionStream, Blob, Response });
ctx.globalThis = ctx;
for (const rel of ["src/base45.js", "src/crc32.js", "src/lt.js", "src/packet.js", "src/container.js", "src/session.js"])
  vm.runInContext(fs.readFileSync(path.join(base, rel), "utf8"), ctx, { filename: rel });
const DQ = ctx.DexQR;
const text = "id,name,qty\n" + Array.from({ length: 60 }, (_, i) => `${i},item-${i},${(i * 37) % 101}`).join("\n") + "\n";
const data = new TextEncoder().encode(text);
const passphrase = "correct horse battery staple";
const streams = [];
for (const keyCheck of [true, false]) {
  const s = await DQ.SenderSession.create({ name: "cycle3.csv", mime: "text/csv", data, blockSize: 100, passphrase, startSeed: keyCheck ? 31 : 32, keyCheck });
  const texts = []; for (let i = 0; i < 3 * s.K + 40; i++) texts.push(s.nextFrame());
  const iterations = new DataView(s.payload.buffer, s.payload.byteOffset).getUint32(4);
  streams.push({ keyCheck, passphrase, iterations, K: s.K, keyFrames: texts.filter((t) => t.startsWith("DK")).length, texts });
}
const out = { source: "Dex_QR commit 8949cb7 (cycle 3, fixed 600,000 iterations)", fileName: "cycle3.csv", mime: "text/csv", fileText: text, streams };
fs.writeFileSync(new URL("./cycle3_streams.json", import.meta.url), JSON.stringify(out, null, 1));
console.log(streams.map((s) => `keyCheck=${s.keyCheck} it=${s.iterations} K=${s.K} texts=${s.texts.length} DK=${s.keyFrames}`).join("\n"));
