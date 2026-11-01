/* Dex_QR — CRC-32 (IEEE 802.3, reflected, poly 0xEDB88320). Original code, MIT License. */
(function (root) {
  "use strict";
  const TABLE = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    TABLE[n] = c >>> 0;
  }
  function crc32(bytes, start = 0, end = bytes.length) {
    let c = 0xffffffff;
    for (let i = start; i < end; i++) c = TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  }
  root.DexQR = root.DexQR || {};
  root.DexQR.crc32 = crc32;
})(typeof globalThis !== "undefined" ? globalThis : this);
