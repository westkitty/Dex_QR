/* Dex_QR — file container and optional passphrase encryption (WebCrypto). Original code, MIT License.
 *
 * Inner container ("DQF1"):  magic(4) | nameLen u16 | name (UTF-8) | mimeLen u8 | mime | data
 * Compressed inner  ("DQZ1"): magic(4) | algorithm u8 (1 = deflate-raw, 2 = gzip) | inner length u32 | compressed DQF1
 *   Added in cycle 2. The sender compresses the DQF1 container with the browser's built-in CompressionStream
 *   and uses the result only when it saves at least MIN_GAIN (2%) of the bytes; otherwise it sends DQF1 as before.
 * Plain payload     = inner container (DQF1 or DQZ1)
 * Encrypted payload = "DQE1"(4) | iterations u32 | salt(16) | iv(12) | AES-256-GCM(inner, aad = first 24 bytes)
 *   (compress-then-encrypt: the encrypted inner may be DQZ1; see THREAT_NOTE.md on what the size reveals)
 *   key = PBKDF2-HMAC-SHA-256(passphrase UTF-8, salt, iterations) -> 256-bit AES-GCM key
 * Key check value (cycle 3): KCV = first 2 bytes of HKDF-SHA-256(ikm = the 32-byte PBKDF2 output, salt = empty,
 *   info = "Dex_QR key check v1"). The AES key is still the PBKDF2 output itself, so DQE1 is unchanged; the KCV
 *   travels in separate "DK" key-check frames (packet.js), never inside the payload. See THREAT_NOTE.md.
 * The payload (plain or encrypted) is what gets LT fountain-coded, so with encryption every
 * packet carries fountain-coded ciphertext. File name and MIME type are inside the encrypted part.
 */
(function (root) {
  "use strict";
  const DQ = root.DexQR;
  const subtle = () => root.crypto.subtle;
  const te = new TextEncoder();
  const td = new TextDecoder();
  const DEFAULT_ITERATIONS = 600000;   // OWASP Password Storage Cheat Sheet value for PBKDF2-HMAC-SHA256
  const MIN_ITERATIONS = 100000;       // receiver refuses less (downgrade guard)
  const MAX_ITERATIONS = 10000000;     // receiver refuses more (CPU DoS guard)
  const MAGIC_PLAIN = [0x44, 0x51, 0x46, 0x31];   // "DQF1"
  const MAGIC_ENC = [0x44, 0x51, 0x45, 0x31];     // "DQE1"
  const MAGIC_ZIP = [0x44, 0x51, 0x5a, 0x31];     // "DQZ1"
  const ZIP_HEADER = 9;
  const ALGORITHMS = { 1: "deflate-raw", 2: "gzip" };   // algorithm byte -> CompressionStream format
  const MIN_GAIN = 0.02;               // use compression only if it saves at least 2% (fewer frames, worth the dependency)
  // Zip-bomb guard: the receiver never inflates more than this (the packet-level payload limit, 32 MiB + 4 KiB,
  // which is more than the largest inner container the sender accepts: a 32 MiB file + name + MIME).
  const KCV_LEN = 2;                   // 16 bits: a wrong passphrase passes the early check 1 time in 65,536 (AES-GCM still catches it)
  const KCV_INFO = te.encode("Dex_QR key check v1");
  const MAX_DECOMPRESSED = (DQ.packet && DQ.packet.MAX_LENGTH) || (32 * 1024 * 1024 + 4096);

  class DexQRError extends Error { constructor(code, msg) { super(msg); this.code = code; } }

  function buildInner(name, mime, data) {
    const nameB = te.encode(name || "file").slice(0, 1024);
    const mimeB = te.encode(mime || "application/octet-stream").slice(0, 255);
    const out = new Uint8Array(4 + 2 + nameB.length + 1 + mimeB.length + data.length);
    out.set(MAGIC_PLAIN, 0);
    out[4] = nameB.length >> 8; out[5] = nameB.length & 0xff;
    out.set(nameB, 6);
    out[6 + nameB.length] = mimeB.length;
    out.set(mimeB, 7 + nameB.length);
    out.set(data, 7 + nameB.length + mimeB.length);
    return out;
  }

  function parseInner(buf) {
    for (let i = 0; i < 4; i++) if (buf[i] !== MAGIC_PLAIN[i]) throw new DexQRError("BAD_FORMAT", "Not a Dex_QR file container");
    const nl = (buf[4] << 8) | buf[5];
    const name = td.decode(buf.subarray(6, 6 + nl));
    const ml = buf[6 + nl];
    const mime = td.decode(buf.subarray(7 + nl, 7 + nl + ml));
    return { name, mime, data: buf.slice(7 + nl + ml) };
  }

  /* One PBKDF2 run gives both the AES-256-GCM key (the PBKDF2 output itself, exactly as before cycle 3, so old
   * streams still decrypt) and the key check value (HKDF-SHA-256 of that output with its own label, so the KCV is
   * not a slice of the key). The raw bits exist only inside this function and are zeroed after import. */
  async function deriveKeys(passphrase, salt, iterations) {
    const base = await subtle().importKey("raw", te.encode(passphrase), "PBKDF2", false, ["deriveBits"]);
    const bits = new Uint8Array(await subtle().deriveBits({ name: "PBKDF2", hash: "SHA-256", salt, iterations }, base, 256));
    try {
      const key = await subtle().importKey("raw", bits, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
      const hk = await subtle().importKey("raw", bits, "HKDF", false, ["deriveBits"]);
      const kcv = new Uint8Array(await subtle().deriveBits({ name: "HKDF", hash: "SHA-256", salt: new Uint8Array(0), info: KCV_INFO }, hk, KCV_LEN * 8));
      return { key, kcv };
    } finally { bits.fill(0); }
  }
  function sameBytes(a, b) { if (!a || !b || a.length !== b.length) return false; let d = 0; for (let i = 0; i < a.length; i++) d |= a[i] ^ b[i]; return d === 0; }

  async function sha256(bytes) { return new Uint8Array(await subtle().digest("SHA-256", bytes)); }

  function hasMagic(buf, m) { if (buf.length < 4) return false; for (let i = 0; i < 4; i++) if (buf[i] !== m[i]) return false; return true; }

  /* Pipe bytes through a (De)CompressionStream and collect the output, aborting once it exceeds maxOut bytes. */
  async function pipeCapped(stream, bytes, maxOut) {
    const writer = stream.writable.getWriter();
    writer.write(bytes).catch(() => {});
    writer.close().catch(() => {});
    const reader = stream.readable.getReader();
    const chunks = []; let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.length;
      if (total > maxOut) { reader.cancel().catch(() => {}); writer.abort().catch(() => {}); return null; }
      chunks.push(value);
    }
    const out = new Uint8Array(total); let o = 0;
    for (const c of chunks) { out.set(c, o); o += c.length; }
    return out;
  }

  /* Compress with the browser's CompressionStream. Returns {bytes, algorithmByte} or null if unavailable. */
  async function compressBytes(bytes) {
    const CS = root.CompressionStream;
    if (typeof CS !== "function") return null;
    for (const id of [1, 2]) {
      let cs;
      try { cs = new CS(ALGORITHMS[id]); } catch (e) { continue; }   // e.g. deflate-raw missing in Chrome < 103
      const out = await pipeCapped(cs, bytes, bytes.length + 1024);
      if (out) return { bytes: out, algorithmByte: id };
      return { bytes: null, algorithmByte: id };
    }
    return null;
  }

  /* Inflate with a hard output cap. Throws TOO_LARGE past maxOut, NO_DECOMPRESSION without DecompressionStream,
   * BAD_FORMAT on corrupt data. */
  async function inflateCapped(bytes, algorithm, maxOut) {
    const DS = root.DecompressionStream;
    if (typeof DS !== "function") throw new DexQRError("NO_DECOMPRESSION", "This transfer is compressed, but this browser has no DecompressionStream, so it cannot be unpacked here. Open the receiver in a current Chrome, Edge, Firefox or Safari (16.4+), or ask the sender to untick \"Compress\" and send again.");
    let ds;
    try { ds = new DS(algorithm); } catch (e) { throw new DexQRError("NO_DECOMPRESSION", `This browser's DecompressionStream does not support "${algorithm}". Use a current browser, or ask the sender to untick "Compress".`); }
    let out;
    try { out = await pipeCapped(ds, bytes, maxOut); }
    catch (e) { throw new DexQRError("BAD_FORMAT", "The compressed data is corrupt (" + (e && e.message || e) + ")"); }
    if (!out) throw new DexQRError("TOO_LARGE", `Refused: the compressed data expands to more than ${maxOut.toLocaleString("en-US")} bytes (the declared size or the receiver's limit). Nothing was saved. This looks like a corrupt or hostile stream.`);
    return out;
  }

  /* Open a DQZ1 container: checks the declared size against the limit before inflating anything. */
  async function openCompressed(buf) {
    if (buf.length < ZIP_HEADER) throw new DexQRError("BAD_FORMAT", "Truncated compressed container");
    const algorithm = ALGORITHMS[buf[4]];
    if (!algorithm) throw new DexQRError("BAD_FORMAT", "Unknown compression algorithm " + buf[4]);
    const declared = new DataView(buf.buffer, buf.byteOffset, buf.byteLength).getUint32(5);
    if (declared > MAX_DECOMPRESSED) throw new DexQRError("TOO_LARGE", `Refused: the transfer says it expands to ${declared.toLocaleString("en-US")} bytes, over the receiver's limit of ${MAX_DECOMPRESSED.toLocaleString("en-US")} bytes. Nothing was decompressed.`);
    const inner = await inflateCapped(buf.subarray(ZIP_HEADER), algorithm, declared);
    if (inner.length !== declared) throw new DexQRError("BAD_FORMAT", `Compressed data expands to ${inner.length} bytes, not the declared ${declared}`);
    if (!hasMagic(inner, MAGIC_PLAIN)) throw new DexQRError("BAD_FORMAT", "Not a Dex_QR file container inside the compressed data");
    return { inner, algorithm, compressedLength: buf.length };
  }

  /* Build the payload to be fountain-coded. Returns {payload, encrypted, fileId, compression}.
   * compression = {used, algorithm, innerLength, compressedLength, reason}; reason is "off", "unavailable",
   * "no-gain" or "" when used. Pass compress:false to disable. */
  async function buildPayload({ name, mime, data, passphrase, iterations, compress, keyCheck }) {
    let inner = buildInner(name, mime, data);
    const compression = { used: false, algorithm: null, innerLength: inner.length, compressedLength: null, reason: "off" };
    if (compress !== false) {
      const z = await compressBytes(inner);
      if (!z) compression.reason = "unavailable";
      else {
        compression.algorithm = ALGORITHMS[z.algorithmByte];
        if (z.bytes) compression.compressedLength = ZIP_HEADER + z.bytes.length;
        if (z.bytes && ZIP_HEADER + z.bytes.length <= inner.length * (1 - MIN_GAIN)) {
          const zc = new Uint8Array(ZIP_HEADER + z.bytes.length);
          zc.set(MAGIC_ZIP, 0); zc[4] = z.algorithmByte;
          new DataView(zc.buffer).setUint32(5, inner.length);
          zc.set(z.bytes, ZIP_HEADER);
          inner = zc; compression.used = true; compression.reason = "";
        } else { compression.reason = "no-gain"; compression.algorithm = null; }
      }
    }
    let payload = inner, encrypted = false, check = null;
    if (passphrase) {
      iterations = iterations || DEFAULT_ITERATIONS;
      const salt = root.crypto.getRandomValues(new Uint8Array(16));
      const iv = root.crypto.getRandomValues(new Uint8Array(12));
      const head = new Uint8Array(36);
      head.set(MAGIC_ENC, 0);
      new DataView(head.buffer).setUint32(4, iterations);
      head.set(salt, 8); head.set(iv, 24);
      const { key, kcv } = await deriveKeys(passphrase, salt, iterations);
      if (keyCheck !== false) check = { iterations, salt: salt.slice(), kcv };
      const ct = new Uint8Array(await subtle().encrypt({ name: "AES-GCM", iv, additionalData: head.subarray(0, 24) }, key, inner));
      payload = new Uint8Array(36 + ct.length);
      payload.set(head, 0); payload.set(ct, 36);
      encrypted = true;
    }
    const fileId = (await sha256(payload)).slice(0, 8);
    return { payload, encrypted, fileId, compression, keyCheck: check };
  }

  /* True for a plaintext DQZ1 payload (drives the informational header flag; never set for encrypted payloads). */
  function isCompressedPayload(payload) { return hasMagic(payload, MAGIC_ZIP); }

  /* DQF1 or DQZ1 -> {name, mime, data, compressed, compressedLength} */
  async function openInner(buf) {
    if (hasMagic(buf, MAGIC_ZIP)) {
      const z = await openCompressed(buf);
      return { ...parseInner(z.inner), compressed: true, compression: z.algorithm, compressedLength: z.compressedLength };
    }
    return { ...parseInner(buf), compressed: false, compression: null, compressedLength: null };
  }

  function isEncryptedPayload(payload) {
    for (let i = 0; i < 4; i++) if (payload[i] !== MAGIC_ENC[i]) return false;
    return true;
  }

  /* Verify and open a reconstructed payload. Throws DexQRError with code
   * CHECKSUM_MISMATCH | NEED_PASSPHRASE | WRONG_PASSPHRASE | BAD_FORMAT | TOO_LARGE | NO_DECOMPRESSION. */
  /* KDF parameters of a DQE1 payload: {iterations, salt}. */
  function encryptedParams(payload) {
    return { iterations: new DataView(payload.buffer, payload.byteOffset).getUint32(4), salt: payload.slice(8, 24) };
  }

  /* opts.derived = {passphrase, iterations, salt, key} from an earlier early check: reused only when the
   * passphrase, salt and iteration count all match this payload's header (else a fresh derivation). */
  async function openPayload(payload, expectedFileId, passphrase, opts = {}) {
    const digest = await sha256(payload);
    for (let i = 0; i < 8; i++) if (digest[i] !== expectedFileId[i]) throw new DexQRError("CHECKSUM_MISMATCH", "Checksum mismatch: the reconstructed data does not match the sender's SHA-256");
    if (!isEncryptedPayload(payload)) return { ...(await openInner(payload)), sha256: digest, encrypted: false };
    if (!passphrase) throw new DexQRError("NEED_PASSPHRASE", "This transfer is encrypted. Enter the passphrase.");
    const iterations = new DataView(payload.buffer, payload.byteOffset).getUint32(4);
    if (iterations < MIN_ITERATIONS || iterations > MAX_ITERATIONS) throw new DexQRError("BAD_FORMAT", "Unsupported PBKDF2 iteration count " + iterations);
    const salt = payload.slice(8, 24), iv = payload.slice(24, 36);
    const d = opts.derived;
    const usedCachedKey = !!(d && d.passphrase === passphrase && d.iterations === iterations && sameBytes(d.salt, salt));
    const key = usedCachedKey ? d.key : (await deriveKeys(passphrase, salt, iterations)).key;
    let inner;
    try {
      inner = new Uint8Array(await subtle().decrypt({ name: "AES-GCM", iv, additionalData: payload.subarray(0, 24) }, key, payload.subarray(36)));
    } catch (e) {
      throw new DexQRError("WRONG_PASSPHRASE", "Wrong passphrase (or the data was tampered with): AES-GCM authentication failed");
    }
    return { ...(await openInner(inner)), sha256: digest, encrypted: true, usedCachedKey };
  }

  /* Rough passphrase strength estimate (bits). Deliberately conservative and simple; it is a hint, not a guarantee. */
  function estimateStrength(p) {
    if (!p) return { bits: 0, label: "none" };
    let pool = 0;
    if (/[a-z]/.test(p)) pool += 26;
    if (/[A-Z]/.test(p)) pool += 26;
    if (/[0-9]/.test(p)) pool += 10;
    if (/[^a-zA-Z0-9]/.test(p)) pool += 33;
    const uniq = new Set(p).size;
    let bits = Math.log2(Math.max(pool, 2)) * Math.min(p.length, uniq * 2);
    const words = p.trim().split(/[\s\-_.]+/).filter((w) => w.length >= 3);
    if (words.length >= 4) bits = Math.max(bits, words.length * 11); // diceware-style: count ~11 bits/word, conservative
    if (/^(password|qwerty|letmein|123456|admin|welcome)/i.test(p)) bits = Math.min(bits, 10);
    if (/(.)\1{3,}/.test(p)) bits *= 0.7;
    bits = Math.round(bits);
    const label = bits < 40 ? "weak" : bits < 60 ? "fair" : bits < 80 ? "good" : "strong";
    return { bits, label };
  }

  DQ.container = { DEFAULT_ITERATIONS, MIN_ITERATIONS, MAX_ITERATIONS, KCV_LEN, deriveKeys, sameBytes, encryptedParams, MAX_DECOMPRESSED, MIN_GAIN, ALGORITHMS, DexQRError, buildInner, parseInner, buildPayload, openPayload, isEncryptedPayload, isCompressedPayload, inflateCapped, estimateStrength, sha256 };
})(typeof globalThis !== "undefined" ? globalThis : this);
