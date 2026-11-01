// Deterministic incompressible test files (so results are reproducible and not helped by compression).
const crypto = require("crypto");
function testFile(size, label = "dexqr") {
  const out = Buffer.alloc(size); let off = 0, ctr = 0;
  while (off < size) { const h = crypto.createHash("sha256").update(label + ":" + size + ":" + ctr++).digest(); h.copy(out, off); off += h.length; }
  return out;
}
module.exports = { testFile };
