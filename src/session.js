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
      this.stats = { frames: 0, qrTexts: 0, accepted: 0, duplicates: 0, rejected: 0, foreign: 0, otherFile: 0 };
    }
    /* Feed one decoded QR string. Returns status string. */
    addText(text) {
      this.stats.qrTexts++;
      const p = DQ.packet.parseText(text);
      if (!p.ok) { if (p.reason === "foreign") this.stats.foreign++; else this.stats.rejected++; return "rejected:" + p.reason; }
      if (!this.meta) {
        this.meta = p.meta;
        this.decoder = new DQ.lt.LTDecoder(p.meta.K, p.meta.blockSize, DQ.packet.fileKey32(p.meta.fileId), { ...this.opts, extra: DQ.lt.extraDegreeFor(p.meta.version, p.meta.K) });
      } else if (p.meta.version !== this.meta.version || p.meta.fileIdHex !== this.meta.fileIdHex || p.meta.K !== this.meta.K || p.meta.blockSize !== this.meta.blockSize || p.meta.length !== this.meta.length) {
        this.stats.otherFile++; return "other-file";
      }
      const before = this.decoder.duplicates;
      const r = this.decoder.addPacket(p.seed, p.block);
      if (this.decoder.duplicates > before) this.stats.duplicates++; else this.stats.accepted++;
      return r;
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

  DQ.SenderSession = SenderSession;
  DQ.ReceiverSession = ReceiverSession;
})(typeof globalThis !== "undefined" ? globalThis : this);
