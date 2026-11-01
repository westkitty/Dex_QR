/* Dex_QR — QR symbol construction (via Nayuki's MIT qrcodegen) and module-matrix helpers. Original code, MIT License. */
(function (root) {
  "use strict";
  const DQ = root.DexQR;
  const qrg = () => root.qrcodegen;
  const ECC = { L: "LOW", M: "MEDIUM", Q: "QUARTILE", H: "HIGH" };

  /* Build a QR symbol from Dex_QR packet text. The text only uses the 45-character alphanumeric
   * set, so a single alphanumeric segment is used (5.5 bits/char). boostEcl=false keeps the
   * requested EC level exactly (for reproducible benchmarks). */
  function makeQr(text, ecl = "M") {
    const g = qrg();
    const seg = g.QrSegment.makeAlphanumeric(text);
    return g.QrCode.encodeSegments([seg], g.QrCode.Ecc[ECC[ecl]], 1, 40, -1, false);
  }

  /* Smallest QR version that fits a given block size at an EC level (or null if > 40). */
  function versionFor(blockSize, ecl = "M") {
    const text = "DQ" + "0".repeat(DQ.packet.textLength(blockSize) - 2);
    try { return makeQr(text, ecl).version; } catch (e) { return null; }
  }

  /* Render to a grayscale bitmap with `scale` pixels per module and a quiet zone (ISO/IEC 18004 asks for 4 modules). */
  function toGray(qr, scale = 4, quiet = 4) {
    const n = qr.size, dim = (n + 2 * quiet) * scale;
    const px = new Uint8Array(dim * dim).fill(255);
    for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) {
      if (!qr.getModule(x, y)) continue;
      const oy = (y + quiet) * scale, ox = (x + quiet) * scale;
      for (let dy = 0; dy < scale; dy++) px.fill(0, (oy + dy) * dim + ox, (oy + dy) * dim + ox + scale);
    }
    return { width: dim, height: dim, data: px };
  }

  DQ.render = { makeQr, versionFor, toGray, ECC };
})(typeof globalThis !== "undefined" ? globalThis : this);
