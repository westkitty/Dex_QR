/* Dex_QR — high-level sender/receiver sessions shared by the pages and the tests. Original code, MIT License. */
(function (root) {
  "use strict";
  const DQ = root.DexQR;

  class SenderSession {
    /* opts: {name, mime, data:Uint8Array, blockSize, passphrase?, iterations?, startSeed?, compress? (default true),
     *        keyCheck? (default true: encrypted streams interleave a "DK" key-check frame every KEY_EVERY frames)} */
    static async create(opts) {
      const s = new SenderSession();
      const built = await DQ.container.buildPayload(opts);
      s.payload = built.payload; s.encrypted = built.encrypted; s.fileId = built.fileId; s.compression = built.compression;
      s.blockSize = opts.blockSize;
      s.version = opts.version ?? DQ.packet.VERSION;
      const K = Math.max(1, Math.ceil(s.payload.length / s.blockSize));
      // Refuse what a receiver would reject (packet.MAX_K / MAX_LENGTH), instead of streaming it forever.
      if (K > DQ.packet.MAX_K || s.payload.length > DQ.packet.MAX_LENGTH) throw new Error(`Too large for one transfer: ${K} blocks, ${s.payload.length} bytes (limits ${DQ.packet.MAX_K} blocks, ${DQ.packet.MAX_LENGTH} bytes). Use a larger QR density or a smaller file.`);
      s.encoder = new DQ.lt.LTEncoder(s.payload, s.blockSize, DQ.packet.fileKey32(s.fileId), { extra: DQ.lt.extraDegreeFor(s.version, K) });
      s.K = s.encoder.K;
      s.meta = { version: s.version, encrypted: s.encrypted, compressed: !s.encrypted && DQ.container.isCompressedPayload(s.payload), fileId: s.fileId, K: s.K, blockSize: s.blockSize, length: s.payload.length };
      s.nextSeed = (opts.startSeed ?? 0) >>> 0;
      s.keyCheck = built.keyCheck;
      s.keyFrameText = built.keyCheck ? DQ.packet.buildKeyFrame({ fileId: s.fileId, ...built.keyCheck }) : null;
      s.frameIndex = 0;
      return s;
    }
    /* What the sender page shows next: a key-check frame at frame 0, KEY_EVERY, 2*KEY_EVERY, ... (encrypted
     * streams only), otherwise the next data packet. Data packets are never skipped, only delayed. */
    nextFrame() {
      const i = this.frameIndex++;
      if (this.keyFrameText && i % SenderSession.KEY_EVERY === 0) return this.keyFrameText;
      return this.nextText();
    }
    /* Fraction of frames that are data packets (1 - 1/KEY_EVERY with key frames, else 1). */
    get dataFrameShare() { return this.keyFrameText ? 1 - 1 / SenderSession.KEY_EVERY : 1; }
    textForSeed(seed) { return DQ.packet.packetToText(DQ.packet.buildPacket(this.meta, seed, this.encoder.encode(seed))); }
    nextText() { const t = this.textForSeed(this.nextSeed); this.nextSeed = (this.nextSeed + 1) >>> 0; return t; }
  }

  SenderSession.KEY_EVERY = 32;   // one key-check frame per 32 frames: +3.1% stream time, at most 4 s wait at 8 fps

  class ReceiverSession {
    constructor(opts = {}) { this.opts = opts; this.keyFrames = new Map(); this.reset(); }
    reset() {
      this.meta = null; this.decoder = null;
      this.derived = null;          // {passphrase, iterations, salt, key, kcvOk} from the last early check
      this.keyCheckMismatch = false;
      this.stats = { frames: 0, qrTexts: 0, accepted: 0, duplicates: 0, rejected: 0, foreign: 0, otherFile: 0, keyFrames: 0, reasons: {} };
      // Another transfer seen after this one locked: the receiver keeps ignoring it, but remembers its
      // packets (up to PENDING_MAX distinct texts) so the user can switch to it without losing them.
      this.pending = null;          // {fileIdHex, texts: string[], seen: Set<string>}
      this.otherStreak = 0;         // other-transfer packets since the last packet of the locked transfer
    }
    /* Feed one decoded QR string. Returns status string. */
    addText(text) {
      this.stats.qrTexts++;
      if (typeof text === "string" && text.startsWith(DQ.packet.KEY_PREFIX)) return this.addKeyFrame(text);
      const p = DQ.packet.parseText(text);
      if (!p.ok) {
        if (p.reason === "foreign") this.stats.foreign++; else { this.stats.rejected++; this.stats.reasons[p.reason] = (this.stats.reasons[p.reason] || 0) + 1; }
        return "rejected:" + p.reason;
      }
      if (!this.meta) {
        this.meta = p.meta;
        this.decoder = new DQ.lt.LTDecoder(p.meta.K, p.meta.blockSize, DQ.packet.fileKey32(p.meta.fileId), { ...this.opts, extra: DQ.lt.extraDegreeFor(p.meta.version, p.meta.K) });
      } else if (!sameTransfer(p.meta, this.meta)) {
        this.stats.otherFile++;
        this.otherStreak++;
        const key = p.meta.version + ":" + p.meta.fileIdHex + ":" + p.meta.K + ":" + p.meta.blockSize + ":" + p.meta.length;
        if (!this.pending || this.pending.key !== key) this.pending = { key, fileIdHex: p.meta.fileIdHex, meta: p.meta, texts: [], seen: new Set() };
        if (!this.pending.seen.has(text) && this.pending.texts.length < ReceiverSession.PENDING_MAX) { this.pending.seen.add(text); this.pending.texts.push(text); }
        return "other-file";
      }
      this.otherStreak = 0;
      const before = this.decoder.duplicates;
      const r = this.decoder.addPacket(p.seed, p.block);
      if (this.decoder.duplicates > before) this.stats.duplicates++; else this.stats.accepted++;
      return r;
    }
    /* Key-check frames are kept per transfer (up to KEY_MAX transfers) so one seen before the first data
     * packet, or for a transfer the user later switches to, still counts. Two different key frames for the
     * same transfer mean one of them is forged: the early check is then disabled for that transfer. */
    addKeyFrame(text) {
      const k = DQ.packet.parseKeyFrame(text);
      if (!k.ok) { this.stats.rejected++; const r = "key-" + k.reason; this.stats.reasons[r] = (this.stats.reasons[r] || 0) + 1; return "rejected:" + r; }
      this.stats.keyFrames++;
      const prev = this.keyFrames.get(k.fileIdHex);
      if (!prev) {
        if (this.keyFrames.size >= ReceiverSession.KEY_MAX) this.keyFrames.delete(this.keyFrames.keys().next().value);
        this.keyFrames.set(k.fileIdHex, k);
      } else if (!prev.conflict && (prev.iterations !== k.iterations || !DQ.container.sameBytes(prev.salt, k.salt) || !DQ.container.sameBytes(prev.kcv, k.kcv))) {
        prev.conflict = true;
        if (this.meta && this.meta.fileIdHex === k.fileIdHex) this.derived = null;
      }
      return "key-check";
    }
    /* The usable key check for the locked transfer, or null. */
    get keyCheck() {
      if (!this.meta || !this.meta.encrypted) return null;
      const k = this.keyFrames.get(this.meta.fileIdHex);
      return k && !k.conflict ? k : null;
    }
    get keyCheckConflict() { const k = this.meta && this.keyFrames.get(this.meta.fileIdHex); return !!(k && k.conflict); }
    /* Early passphrase check against the sender's KCV, without waiting for the file. Resolves to
     * {result: "ok" | "wrong" | "pending" (no key frame seen yet) | "conflict" | "not-encrypted" | "no-transfer", ms}.
     * "ok" means the KCV matched (a wrong passphrase still passes 1 time in 65,536; AES-GCM decides at the end). */
    async checkPassphrase(passphrase) {
      const t0 = Date.now();
      if (!this.meta) return { result: "no-transfer", ms: 0 };
      if (!this.meta.encrypted) return { result: "not-encrypted", ms: 0 };
      if (this.keyCheckConflict) return { result: "conflict", ms: 0 };
      const k = this.keyCheck;
      if (!k) return { result: "pending", ms: 0 };
      const meta = this.meta;
      const d = await DQ.container.deriveKeys(passphrase, k.salt, k.iterations);
      if (this.meta !== meta || this.keyCheck !== k) return { result: "stale", ms: Date.now() - t0 };
      const ok = DQ.container.sameBytes(d.kcv, k.kcv);
      this.derived = { passphrase, iterations: k.iterations, salt: k.salt, key: d.key, kcvOk: ok };
      return { result: ok ? "ok" : "wrong", ms: Date.now() - t0 };
    }
    /* True when another transfer has been on screen for a while and the locked one has not: offer a switch. */
    get otherTransferWaiting() { return !!(this.pending && !this.done && this.otherStreak >= ReceiverSession.SWITCH_AFTER); }
    /* Drop the current transfer and continue with the other one, replaying its buffered packets. */
    switchToPending() {
      const pend = this.pending;
      if (!pend) return false;
      const frames = this.stats.frames, keyFrames = this.stats.keyFrames;
      this.reset();
      this.stats.frames = frames; this.stats.keyFrames = keyFrames;
      for (const t of pend.texts) this.addText(t);
      return true;
    }
    get done() { return !!(this.decoder && this.decoder.done); }
    progress() {
      if (!this.decoder) return { K: 0, recovered: 0, received: 0, fraction: 0 };
      const d = this.decoder;
      return { K: d.K, recovered: d.knownCount, received: d.received, fraction: d.knownCount / d.K };
    }
    payload() { return this.decoder.result(this.meta.length); }
    async open(passphrase) {
      const payload = this.payload();
      const out = await DQ.container.openPayload(payload, this.meta.fileId, passphrase, { derived: this.derived });
      // A key frame whose KDF parameters differ from the real payload header was forged or stale: note it.
      const k = this.keyFrames.get(this.meta.fileIdHex);
      if (out.encrypted && k) {
        const h = DQ.container.encryptedParams(payload);
        if (h.iterations !== k.iterations || !DQ.container.sameBytes(h.salt, k.salt)) this.keyCheckMismatch = true;
      }
      return out;
    }
  }
  ReceiverSession.KEY_MAX = 8;          // transfers whose key-check frame is remembered
  ReceiverSession.PENDING_MAX = 4096;   // distinct packets kept from another transfer (about 4096 x 0.6 KB of text at most)
  ReceiverSession.SWITCH_AFTER = 8;     // consecutive other-transfer packets before a switch is offered

  function sameTransfer(a, b) {
    return a.version === b.version && a.fileIdHex === b.fileIdHex && a.K === b.K && a.blockSize === b.blockSize && a.length === b.length;
  }

  DQ.SenderSession = SenderSession;
  DQ.ReceiverSession = ReceiverSession;
})(typeof globalThis !== "undefined" ? globalThis : this);
