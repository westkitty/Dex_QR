/* Dex_QR — Base45 (RFC 9285) encoder/decoder. Original code, MIT License. */
(function (root) {
  "use strict";
  const ALPHABET = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ $%*+-./:";
  const LOOKUP = new Int16Array(128).fill(-1);
  for (let i = 0; i < ALPHABET.length; i++) LOOKUP[ALPHABET.charCodeAt(i)] = i;

  function encode(bytes) {
    const out = [];
    let i = 0;
    for (; i + 1 < bytes.length; i += 2) {
      let n = bytes[i] * 256 + bytes[i + 1];
      const c = n % 45; n = (n - c) / 45;
      const d = n % 45; const e = (n - d) / 45;
      out.push(ALPHABET[c], ALPHABET[d], ALPHABET[e]);
    }
    if (i < bytes.length) {
      const a = bytes[i];
      out.push(ALPHABET[a % 45], ALPHABET[(a - (a % 45)) / 45]);
    }
    return out.join("");
  }

  function val(str, i) {
    const code = str.charCodeAt(i);
    const v = code < 128 ? LOOKUP[code] : -1;
    if (v < 0) throw new Error("base45: invalid character at " + i);
    return v;
  }

  function decode(str) {
    if (str.length % 3 === 1) throw new Error("base45: invalid length");
    const out = new Uint8Array(Math.floor(str.length / 3) * 2 + (str.length % 3 === 2 ? 1 : 0));
    let o = 0, i = 0;
    for (; i + 2 < str.length; i += 3) {
      const n = val(str, i) + val(str, i + 1) * 45 + val(str, i + 2) * 2025;
      if (n > 0xffff) throw new Error("base45: triplet overflow");
      out[o++] = n >> 8; out[o++] = n & 0xff;
    }
    if (i < str.length) {
      const n = val(str, i) + val(str, i + 1) * 45;
      if (n > 0xff) throw new Error("base45: pair overflow");
      out[o++] = n;
    }
    return out;
  }

  root.DexQR = root.DexQR || {};
  root.DexQR.base45 = { encode, decode, ALPHABET };
})(typeof globalThis !== "undefined" ? globalThis : this);
