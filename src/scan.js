/* Dex_QR — receiver-side QR scanning helper around jsQR. Original code, MIT License.
 * Pass 1: jsQR on the frame as given. Pass 2 (only if pass 1 found nothing): jsQR on a 3x3 box-blurred
 * grayscale copy. jsQR's local-threshold binarizer is sensitive to per-pixel sensor-like noise; the blur
 * removes most of it (see docs/BENCHMARK.md for the measured effect on synthetic noisy frames). */
(function (root) {
  "use strict";
  const DQ = root.DexQR;
  function boxBlurGrayToRGBA(src, w, h) {
    const gray = new Float32Array(w * h);
    for (let i = 0, j = 0; i < gray.length; i++, j += 4) gray[i] = (src[j] * 77 + src[j + 1] * 150 + src[j + 2] * 29) / 256;
    const tmp = new Float32Array(w * h);
    for (let y = 0; y < h; y++) {
      const o = y * w;
      for (let x = 0; x < w; x++) {
        const a = gray[o + (x > 0 ? x - 1 : x)], b = gray[o + x], c = gray[o + (x < w - 1 ? x + 1 : x)];
        tmp[o + x] = (a + b + c) / 3;
      }
    }
    const out = new Uint8ClampedArray(w * h * 4);
    for (let y = 0; y < h; y++) {
      const up = (y > 0 ? y - 1 : y) * w, mid = y * w, dn = (y < h - 1 ? y + 1 : y) * w;
      for (let x = 0; x < w; x++) {
        const v = (tmp[up + x] + tmp[mid + x] + tmp[dn + x]) / 3, k = (mid + x) * 4;
        out[k] = out[k + 1] = out[k + 2] = v; out[k + 3] = 255;
      }
    }
    return out;
  }
  /* Returns {texts, pass} where pass is 0 (nothing), 1 or 2. */
  function decodeImageData(rgba, w, h, jsQR) {
    jsQR = jsQR || root.jsQR;
    let r = jsQR(rgba, w, h, { inversionAttempts: "dontInvert" });
    if (r && r.data) return { texts: [r.data], pass: 1 };
    r = jsQR(boxBlurGrayToRGBA(rgba, w, h), w, h, { inversionAttempts: "dontInvert" });
    if (r && r.data) return { texts: [r.data], pass: 2 };
    return { texts: [], pass: 0 };
  }
  DQ.scan = { decodeImageData, boxBlurGrayToRGBA };
})(typeof globalThis !== "undefined" ? globalThis : this);
