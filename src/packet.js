/* Dex_QR — packet framing. Original code, MIT License.
 *
 * Binary packet (big-endian), then Base45 (RFC 9285) with the text prefix "DQ":
 *   off size field
 *    0   1   version (=2 when sending; 1 and 2 are accepted. v2 changes only the LT degree
 *                rule, see lt.extraDegreeFor; the byte layout is identical)
 *    1   1   flags   (bit0 = payload is encrypted)
 *    2   8   fileId  = first 8 bytes of SHA-256(payload)  (also the whole-file checksum)
 *   10   3   K       = number of source blocks (uint24)
 *   13   2   T       = block size in bytes (uint16)
 *   15   4   F       = payload length in bytes (uint32)
 *   19   4   seed    = LT encoding-symbol id (uint32)
 *   23   T   LT-encoded block (XOR of the chosen source blocks)
 * 23+T   4   CRC-32 of bytes [0, 23+T)
 */
(function (root) {
  "use strict";
  const DQ = root.DexQR;
  const VERSION = 2;                 // version written by buildPacket
  const SUPPORTED = [1, 2];          // versions parseBytes accepts
  const HEADER_LEN = 23;
  const TRAILER_LEN = 4;
  const PREFIX = "DQ";
  const FLAG_ENCRYPTED = 1;
  // Receiver-side resource guards (not a wire-format change). A CRC-valid packet can still claim any
  // K up to 2^24 and any F up to 2^32; without a cap one such frame (garbage or hostile) makes the
  // decoder allocate per-block state for millions of blocks and freezes the tab. The sender UI accepts
  // files up to 32 MiB with presets T >= 200 B (K <= 167,773), so these caps reject nothing it can send.
  const MAX_LENGTH = 32 * 1024 * 1024 + 4096;   // 32 MiB file + container/encryption overhead
  const MAX_K = 262144;                         // 2^18 blocks

  function hex(bytes) { return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join(""); }

  function buildPacket(meta, seed, block) {
    const T = meta.blockSize;
    const buf = new Uint8Array(HEADER_LEN + T + TRAILER_LEN);
    const dv = new DataView(buf.buffer);
    buf[0] = meta.version ?? VERSION;
    buf[1] = meta.encrypted ? FLAG_ENCRYPTED : 0;
    buf.set(meta.fileId, 2);
    buf[10] = (meta.K >>> 16) & 0xff; buf[11] = (meta.K >>> 8) & 0xff; buf[12] = meta.K & 0xff;
    dv.setUint16(13, T);
    dv.setUint32(15, meta.length);
    dv.setUint32(19, seed >>> 0);
    buf.set(block, HEADER_LEN);
    dv.setUint32(HEADER_LEN + T, DQ.crc32(buf, 0, HEADER_LEN + T));
    return buf;
  }

  function packetToText(bytes) { return PREFIX + DQ.base45.encode(bytes); }

  /* Parse QR text. Returns {ok:true, meta, seed, block} or {ok:false, reason}. */
  function parseText(text) {
    if (typeof text !== "string" || !text.startsWith(PREFIX)) return { ok: false, reason: "foreign" };
    let bytes;
    try { bytes = DQ.base45.decode(text.slice(PREFIX.length)); } catch (e) { return { ok: false, reason: "base45" }; }
    return parseBytes(bytes);
  }

  function parseBytes(bytes) {
    if (bytes.length < HEADER_LEN + TRAILER_LEN + 1) return { ok: false, reason: "short" };
    const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const version = bytes[0];
    if (!SUPPORTED.includes(version)) return { ok: false, reason: "version" };
    const T = dv.getUint16(13);
    if (bytes.length !== HEADER_LEN + T + TRAILER_LEN) return { ok: false, reason: "length" };
    const crc = dv.getUint32(HEADER_LEN + T);
    if (DQ.crc32(bytes, 0, HEADER_LEN + T) !== crc) return { ok: false, reason: "crc" };
    const K = (bytes[10] << 16) | (bytes[11] << 8) | bytes[12];
    const length = dv.getUint32(15);
    if (K < 1 || T < 1 || Math.ceil(length / T) !== Math.max(1, K)) return { ok: false, reason: "inconsistent" };
    if (K > MAX_K || length > MAX_LENGTH) return { ok: false, reason: "limits" };
    const fileId = bytes.slice(2, 10);
    return {
      ok: true,
      meta: { version, encrypted: (bytes[1] & FLAG_ENCRYPTED) !== 0, fileId, fileIdHex: hex(fileId), K, blockSize: T, length },
      seed: dv.getUint32(19),
      block: bytes.subarray(HEADER_LEN, HEADER_LEN + T),
    };
  }

  /* 32-bit key mixed into every packet's PRNG seed. */
  function fileKey32(fileId) { return ((fileId[0] << 24) | (fileId[1] << 16) | (fileId[2] << 8) | fileId[3]) >>> 0; }

  /* Number of QR alphanumeric characters for a given block size. */
  function textLength(blockSize) {
    const n = HEADER_LEN + blockSize + TRAILER_LEN;
    return PREFIX.length + Math.floor(n / 2) * 3 + (n % 2 ? 2 : 0);
  }

  DQ.packet = { VERSION, SUPPORTED, HEADER_LEN, TRAILER_LEN, PREFIX, FLAG_ENCRYPTED, MAX_LENGTH, MAX_K, buildPacket, packetToText, parseText, parseBytes, fileKey32, textLength, hex };
})(typeof globalThis !== "undefined" ? globalThis : this);
