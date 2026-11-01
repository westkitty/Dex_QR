// Writes tests/fixtures/legacy_streams.json: QR texts produced by a PREVIOUS Dex_QR build (pre-compression,
// commit 79094f4), so the unit tests can prove current receivers still decode old streams byte for byte.
// Usage: git worktree add --detach work/base-79094f4 79094f4 && node tests/fixtures/make-legacy-streams.mjs work/base-79094f4
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
const base = path.resolve(process.argv[2] || "work/base-79094f4");
const ctx = vm.createContext({ TextEncoder, TextDecoder, crypto: globalThis.crypto, console, Uint8Array, Math });
ctx.globalThis = ctx;
for (const rel of ["src/base45.js", "src/crc32.js", "src/lt.js", "src/packet.js", "src/container.js", "src/session.js"])
  vm.runInContext(fs.readFileSync(path.join(base, rel), "utf8"), ctx, { filename: rel });
const DQ = ctx.DexQR;
const text = "id,name,qty\n" + Array.from({ length: 60 }, (_, i) => `${i},item-${i},${(i * 37) % 101}`).join("\n") + "\n";
const data = new TextEncoder().encode(text);
const streams = [];
for (const version of [1, 2]) for (const passphrase of [undefined, "correct horse battery staple"]) {
  const s = await DQ.SenderSession.create({ name: "legacy.csv", mime: "text/csv", data, blockSize: 100, version, passphrase, iterations: passphrase ? 100000 : undefined, startSeed: 1000 * version });
  const texts = []; for (let i = 0; i < 3 * s.K + 20; i++) texts.push(s.nextText());
  streams.push({ version, encrypted: !!passphrase, passphrase: passphrase || null, K: s.K, texts });
}
const out = { source: "Dex_QR commit 79094f4 (before compression)", fileName: "legacy.csv", mime: "text/csv", fileText: text, streams };
fs.writeFileSync(new URL("./legacy_streams.json", import.meta.url), JSON.stringify(out, null, 1));
console.log(streams.map((s) => `v${s.version} enc=${s.encrypted} K=${s.K} texts=${s.texts.length}`).join("\n"));
