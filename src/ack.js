/* Dex_QR — reverse-channel "Done" confirmation frame (cycle 9). Original code, MIT License.
 *
 * When the receiver has rebuilt and verified a file it shows one small static QR code; the sender can scan it
 * with its own camera to turn "should have it by now" into a confirmed Done. Base45 with the text prefix "DA":
 *   off size field
 *    0   1   ACK version (=1)
 *    1   1   kind (1 = done: the whole transfer was rebuilt and its SHA-256 checksum verified)
 *    2   8   fileId of the transfer (the same 8 bytes every stream packet carries; nothing secret, no file content)
 *   10   4   CRC-32 of bytes [0, 10)
 * Envelope rule for every ACK version, present and future: the last 4 bytes are the CRC-32 of all bytes before
 * them. So a damaged or unrelated "DA..." code is rejected as "crc", and only a well-formed code from a newer
 * release is reported as "version" (with a plain-language message on the sender), never mistaken for Done.
 * Older senders never scan anything; older receivers never show it. Stream packets ("DQ") and key-check frames
 * ("DK") are unchanged.
 */
(function (root) {
  "use strict";
  const DQ = root.DexQR;
  const PREFIX = "DA";
  const VERSION = 1;
  const KIND_DONE = 1;
  const LEN = 14;
  const MIN_LEN = 6;                 // version + kind + CRC-32: the shortest frame any version can have
  const MAX_TEXT = 512;              // ACK codes are tiny; refuse to Base45-decode anything long
  const REASONS = ["foreign", "toolong", "base45", "short", "crc", "version", "length", "kind"];

  function build(fileId, kind = KIND_DONE) {
    if (!fileId || fileId.length < 8) throw new Error("fileId must be 8 bytes");
    const b = new Uint8Array(LEN), dv = new DataView(b.buffer);
    b[0] = VERSION; b[1] = kind;
    b.set(fileId.subarray ? fileId.subarray(0, 8) : fileId.slice(0, 8), 2);
    dv.setUint32(10, DQ.crc32(b, 0, 10));
    return PREFIX + DQ.base45.encode(b);
  }

  /* Returns {ok:true, version, kind, fileId, fileIdHex} or {ok:false, reason, version?}. Never throws. */
  function parse(text) {
    if (typeof text !== "string" || !text.startsWith(PREFIX)) return { ok: false, reason: "foreign" };
    if (text.length > MAX_TEXT) return { ok: false, reason: "toolong" };
    let b;
    try { b = DQ.base45.decode(text.slice(PREFIX.length)); } catch (e) { return { ok: false, reason: "base45" }; }
    if (b.length < MIN_LEN) return { ok: false, reason: "short" };
    const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
    if (DQ.crc32(b, 0, b.length - 4) !== dv.getUint32(b.length - 4)) return { ok: false, reason: "crc" };
    if (b[0] !== VERSION) return { ok: false, reason: "version", version: b[0] };
    if (b.length !== LEN) return { ok: false, reason: "length" };
    if (b[1] !== KIND_DONE) return { ok: false, reason: "kind", kind: b[1] };
    const fileId = b.slice(2, 10);
    return { ok: true, version: VERSION, kind: KIND_DONE, fileId, fileIdHex: DQ.packet.hex(fileId) };
  }

  /* What a sender expecting transfer `fileIdHex` should do with one scanned text:
   * "done" (this transfer is confirmed), "other" (a Done code for a different transfer), "newer" (an ACK version
   * or kind this page does not know), "stream" (a Dex_QR stream or key-check frame, e.g. its own screen in a
   * mirror), "bad" (a damaged "DA" code) or "foreign" (some other QR code). */
  function classify(text, fileIdHex) {
    const r = parse(text);
    if (r.ok) return { verdict: r.fileIdHex === fileIdHex ? "done" : "other", ack: r };
    if (r.reason === "version" || r.reason === "kind") return { verdict: "newer", ack: r };
    if (r.reason === "foreign") return { verdict: typeof text === "string" && (text.startsWith("DQ") || text.startsWith("DK")) ? "stream" : "foreign", ack: r };
    return { verdict: "bad", ack: r };
  }

  DQ.ack = { PREFIX, VERSION, KIND_DONE, LEN, REASONS, build, parse, classify };
})(typeof globalThis !== "undefined" ? globalThis : this);
