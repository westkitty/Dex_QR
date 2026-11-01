/* Dex_QR — file container and optional passphrase encryption (WebCrypto). Original code, MIT License.
 *
 * Inner container ("DQF1"):  magic(4) | nameLen u16 | name (UTF-8) | mimeLen u8 | mime | data
 * Plain payload     = inner container
 * Encrypted payload = "DQE1"(4) | iterations u32 | salt(16) | iv(12) | AES-256-GCM(inner, aad = first 24 bytes)
 *   key = PBKDF2-HMAC-SHA-256(passphrase UTF-8, salt, iterations) -> 256-bit AES-GCM key
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

  async function deriveKey(passphrase, salt, iterations) {
    const base = await subtle().importKey("raw", te.encode(passphrase), "PBKDF2", false, ["deriveKey"]);
    return subtle().deriveKey({ name: "PBKDF2", hash: "SHA-256", salt, iterations }, base, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
  }

  async function sha256(bytes) { return new Uint8Array(await subtle().digest("SHA-256", bytes)); }

  /* Build the payload to be fountain-coded. Returns {payload, encrypted, fileId}. */
  async function buildPayload({ name, mime, data, passphrase, iterations }) {
    const inner = buildInner(name, mime, data);
    let payload = inner, encrypted = false;
    if (passphrase) {
      iterations = iterations || DEFAULT_ITERATIONS;
      const salt = root.crypto.getRandomValues(new Uint8Array(16));
      const iv = root.crypto.getRandomValues(new Uint8Array(12));
      const head = new Uint8Array(36);
      head.set(MAGIC_ENC, 0);
      new DataView(head.buffer).setUint32(4, iterations);
      head.set(salt, 8); head.set(iv, 24);
      const key = await deriveKey(passphrase, salt, iterations);
      const ct = new Uint8Array(await subtle().encrypt({ name: "AES-GCM", iv, additionalData: head.subarray(0, 24) }, key, inner));
      payload = new Uint8Array(36 + ct.length);
      payload.set(head, 0); payload.set(ct, 36);
      encrypted = true;
    }
    const fileId = (await sha256(payload)).slice(0, 8);
    return { payload, encrypted, fileId };
  }

  function isEncryptedPayload(payload) {
    for (let i = 0; i < 4; i++) if (payload[i] !== MAGIC_ENC[i]) return false;
    return true;
  }

  /* Verify and open a reconstructed payload. Throws DexQRError with code
   * CHECKSUM_MISMATCH | NEED_PASSPHRASE | WRONG_PASSPHRASE | BAD_FORMAT. */
  async function openPayload(payload, expectedFileId, passphrase) {
    const digest = await sha256(payload);
    for (let i = 0; i < 8; i++) if (digest[i] !== expectedFileId[i]) throw new DexQRError("CHECKSUM_MISMATCH", "Checksum mismatch: the reconstructed data does not match the sender's SHA-256");
    if (!isEncryptedPayload(payload)) return { ...parseInner(payload), sha256: digest, encrypted: false };
    if (!passphrase) throw new DexQRError("NEED_PASSPHRASE", "This transfer is encrypted. Enter the passphrase.");
    const iterations = new DataView(payload.buffer, payload.byteOffset).getUint32(4);
    if (iterations < MIN_ITERATIONS || iterations > MAX_ITERATIONS) throw new DexQRError("BAD_FORMAT", "Unsupported PBKDF2 iteration count " + iterations);
    const salt = payload.slice(8, 24), iv = payload.slice(24, 36);
    const key = await deriveKey(passphrase, salt, iterations);
    let inner;
    try {
      inner = new Uint8Array(await subtle().decrypt({ name: "AES-GCM", iv, additionalData: payload.subarray(0, 24) }, key, payload.subarray(36)));
    } catch (e) {
      throw new DexQRError("WRONG_PASSPHRASE", "Wrong passphrase (or the data was tampered with): AES-GCM authentication failed");
    }
    return { ...parseInner(inner), sha256: digest, encrypted: true };
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

  DQ.container = { DEFAULT_ITERATIONS, MIN_ITERATIONS, MAX_ITERATIONS, DexQRError, buildInner, parseInner, buildPayload, openPayload, isEncryptedPayload, estimateStrength, sha256 };
})(typeof globalThis !== "undefined" ? globalThis : this);
