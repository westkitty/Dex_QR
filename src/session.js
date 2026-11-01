/* Dex_QR — high-level sender/receiver sessions shared by the pages and the tests. Original code, MIT License. */
(function (root) {
  "use strict";
  const DQ = root.DexQR;

  class SenderSession {
    /* opts: {name, mime, data:Uint8Array, blockSize, passphrase?, iterations?, startSeed?} */
    static async create(opts) {
      const s = new SenderSession();
      const built = await DQ.container.buildPayload(opts);
      s.payload = built.payload; s.encrypted = built.encrypted; s.fileId = built.fileId;
      s.blockSize = opts.blockSize;
      s.version = opts.version ?? DQ.packet.VERSION;
      const K = Math.max(1, Math.ceil(s.payload.length / s.blockSize));
      // Refuse what a receiver would reject (packet.MAX_K / MAX_LENGTH), instead of streaming it forever.
      if (K > DQ.packet.MAX_K || s.payload.length > DQ.packet.MAX_LENGTH) throw new Error(`Too large for one transfer: ${K} blocks, ${s.payload.length} bytes (limits ${DQ.packet.MAX_K} blocks, ${DQ.packet.MAX_LENGTH} bytes). Use a larger QR density or a smaller file.`);
      s.encoder = new DQ.lt.LTEncoder(s.payload, s.blockSize, DQ.packet.fileKey32(s.fileId), { extra: DQ.lt.extraDegreeFor(s.version, K) });
      s.K = s.encoder.K;
      s.meta = { version: s.version, encrypted: s.encrypted, fileId: s.fileId, K: s.K, blockSize: s.blockSize, length: s.payload.length };
      s.nextSeed = (opts.startSeed ?? 0) >>> 0;
      return s;
    }
    textForSeed(seed) { return DQ.packet.packetToText(DQ.packet.buildPacket(this.meta, seed, this.encoder.encode(seed))); }
    nextText() { const t = this.textForSeed(this.nextSeed); this.nextSeed = (this.nextSeed + 1) >>> 0; return t; }
  }

  class ReceiverSession {
    constructor(opts = {}) { this.opts = opts; this.reset(); }
    reset() {
      this.meta = null; this.decoder = null;
      this.stats = { frames: 0, qrTexts: 0, accepted: 0, duplicates: 0, rejected: 0, foreign: 0, otherFile: 0, reasons: {} };
      // Another transfer seen after this one locked: the receiver keeps ignoring it, but remembers its
      // packets (up to PENDING_MAX distinct texts) so the user can switch to it without losing them.
      this.pending = null;          // {fileIdHex, texts: string[], seen: Set<string>}
      this.otherStreak = 0;         // other-transfer packets since the last packet of the locked transfer
    }
    /* Feed one decoded QR string. Returns status string. */
    addText(text) {
      this.stats.qrTexts++;
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
    /* True when another transfer has been on screen for a while and the locked one has not: offer a switch. */
    get otherTransferWaiting() { return !!(this.pending && !this.done && this.otherStreak >= ReceiverSession.SWITCH_AFTER); }
    /* Drop the current transfer and continue with the other one, replaying its buffered packets. */
    switchToPending() {
      const pend = this.pending;
      if (!pend) return false;
      const frames = this.stats.frames;
      this.reset();
      this.stats.frames = frames;
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
    async open(passphrase) { return DQ.container.openPayload(this.payload(), this.meta.fileId, passphrase); }
  }
  ReceiverSession.PENDING_MAX = 4096;   // distinct packets kept from another transfer (about 4096 x 0.6 KB of text at most)
  ReceiverSession.SWITCH_AFTER = 8;     // consecutive other-transfer packets before a switch is offered

  function sameTransfer(a, b) {
    return a.version === b.version && a.fileIdHex === b.fileIdHex && a.K === b.K && a.blockSize === b.blockSize && a.length === b.length;
  }

  DQ.SenderSession = SenderSession;
  DQ.ReceiverSession = ReceiverSession;
})(typeof globalThis !== "undefined" ? globalThis : this);
