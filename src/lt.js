/* Dex_QR — LT fountain code (Luby 2002) with the robust soliton degree distribution.
 * Original code, MIT License.
 *
 * Encoder: every encoded packet is identified by a 32-bit seed. The seed (mixed with the
 * file ID) drives a deterministic PRNG that picks the packet's degree d from the robust
 * soliton distribution and then d distinct source blocks; the packet payload is the XOR
 * of those blocks. Sender and receiver derive the same neighbour set from the seed, so
 * only the seed travels in the packet header.
 *
 * Decoder, two modes chosen by K:
 *  - "ml" (K <= mlMaxK, default 3000): incremental Gaussian elimination over GF(2). Each new
 *    packet is reduced against the current pivot rows (an XOR basis); the file is recovered
 *    as soon as the received packets have rank K, i.e. maximum-likelihood decoding, which needs
 *    fewer packets than peeling. Cost is O(K^2/32) word operations per packet plus one
 *    back-substitution at the end, which is cheap for K up to a few thousand.
 *  - "peel" (larger K): classic belief-propagation "peeling" (resolve degree-1 packets,
 *    substitute, repeat), plus a GF(2) Gaussian-elimination finisher on the residual system
 *    once at most `geMaxUnknown` blocks are left unresolved.
 * Both modes give byte-identical results; they differ only in how many packets they need.
 */
(function (root) {
  "use strict";

  // Protocol v1 parameters, chosen by the sweep in tests/unit/lt-sweep.mjs (results/lt_sweep.json):
  // K <= ML_MAX_K is decoded by Gaussian elimination, where (c=0.1, delta=0.05) gave the lowest
  // overhead; larger K is decoded by peeling, where (c=0.03, delta=0.5) did best.
  const ML_MAX_K = 3000;
  const DEFAULT_C = 0.1;
  const DEFAULT_DELTA = 0.05;
  function paramsForK(K) { return K <= ML_MAX_K ? { c: 0.1, delta: 0.05 } : { c: 0.03, delta: 0.5 }; }

  /* Protocol v2 ("degree boost"): for K <= ML_MAX_K every packet's robust-soliton degree d is
   * raised to d + ceil(log2 K) whenever that stays below K. Sparse soliton rows leave the GF(2) system rank-deficient
   * for a while (a block nobody covers, or small dependent clusters); adding ~log2 K extra random
   * neighbours makes the rows behave like a dense random code, so the ML decoder finishes at
   * about K + 1.6 packets. Measured in tests/unit/degree-boost.mjs (results/degree_boost.json).
   * K < BOOST_MIN_K and K > ML_MAX_K keep v1 behaviour (extra = 0) because the peeling decoder needs degree-1 packets.
   * Protocol v1 packets always use extra = 0, so v1 streams still decode. */
  // Below 12 blocks the boost was mixed (worse at K = 5, 6, 10, 11 in a 400-trial scan), so v2
  // keeps the v1 rule there.
  const BOOST_MIN_K = 12;
  function extraDegreeFor(version, K) {
    if (version >= 2 && K >= BOOST_MIN_K && K <= ML_MAX_K) return Math.ceil(Math.log2(K));
    return 0;
  }

  /* lowbias32 integer hash (Chris Wellons, public-domain constants). */
  function mix32(x) {
    x = x >>> 0;
    x ^= x >>> 16; x = Math.imul(x, 0x7feb352d);
    x ^= x >>> 15; x = Math.imul(x, 0x846ca68b);
    x ^= x >>> 16;
    return x >>> 0;
  }

  /* mulberry32 PRNG (Tommy Ettinger, public domain algorithm); returns uint32. */
  function makeRng(state) {
    let a = state | 0;
    return function next() {
      a = (a + 0x6d2b79f5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return (t ^ (t >>> 14)) >>> 0;
    };
  }

  function packetRng(fileKey32, seed) {
    return makeRng(mix32((seed >>> 0) ^ mix32(fileKey32 >>> 0)));
  }

  /* Robust soliton distribution mu(d), d = 1..K (Luby 2002, Def. 11; MacKay ITILA ch. 50).
   * Returns the cumulative distribution as Float64Array cdf[0..K] with cdf[K] = 1. */
  const cdfCache = new Map();
  function robustSolitonCdf(K, c = DEFAULT_C, delta = DEFAULT_DELTA) {
    const key = K + ":" + c + ":" + delta;
    const hit = cdfCache.get(key);
    if (hit) return hit;
    const cdf = new Float64Array(K + 1);
    if (K === 1) { cdf[1] = 1; cdfCache.set(key, cdf); return cdf; }
    const R = c * Math.log(K / delta) * Math.sqrt(K);
    let pivot = Math.floor(K / R);
    if (pivot < 1) pivot = 1;
    if (pivot > K) pivot = K;
    const mu = new Float64Array(K + 1);
    for (let d = 1; d <= K; d++) {
      const rho = d === 1 ? 1 / K : 1 / (d * (d - 1));
      let tau = 0;
      if (d < pivot) tau = R / (d * K);
      else if (d === pivot) tau = (R * Math.log(R / delta)) / K;
      mu[d] = rho + Math.max(0, tau);
    }
    let beta = 0;
    for (let d = 1; d <= K; d++) beta += mu[d];
    let acc = 0;
    for (let d = 1; d <= K; d++) { acc += mu[d] / beta; cdf[d] = acc; }
    cdf[K] = 1;
    cdfCache.set(key, cdf);
    return cdf;
  }

  function sampleDegree(cdf, u) {
    let lo = 1, hi = cdf.length - 1;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (cdf[mid] >= u) hi = mid; else lo = mid + 1;
    }
    return lo;
  }

  /* Deterministic neighbour set for (fileKey32, seed, K). Returns a sorted Uint32Array. */
  function neighbours(K, seed, fileKey32, c = DEFAULT_C, delta = DEFAULT_DELTA, extra = 0) {
    const rng = packetRng(fileKey32, seed);
    const cdf = robustSolitonCdf(K, c, delta);
    const u = (rng() + 0.5) / 4294967296; // (0,1)
    let d = sampleDegree(cdf, u);
    // Boost only when the boosted degree stays below K. Capping at K instead would pile many
    // packets onto one fixed degree; with a fixed even degree every row lies in the even-weight
    // subspace and the system can never reach rank K (found by the K=3 unit test).
    if (extra > 0 && d + extra < K) d += extra;
    // Partial Fisher-Yates over [0, K) using a sparse swap map: O(d) time and memory.
    const swaps = new Map();
    const out = new Uint32Array(d);
    for (let i = 0; i < d; i++) {
      const j = i + (rng() % (K - i));
      const vj = swaps.has(j) ? swaps.get(j) : j;
      const vi = swaps.has(i) ? swaps.get(i) : i;
      swaps.set(j, vi);
      out[i] = vj;
    }
    out.sort();
    return out;
  }

  function xorInto(dst, src) {
    const n = dst.length;
    if ((n & 3) === 0 && (dst.byteOffset & 3) === 0 && (src.byteOffset & 3) === 0) {
      const a = new Uint32Array(dst.buffer, dst.byteOffset, n >> 2);
      const b = new Uint32Array(src.buffer, src.byteOffset, n >> 2);
      for (let i = 0; i < a.length; i++) a[i] ^= b[i];
    } else {
      for (let i = 0; i < n; i++) dst[i] ^= src[i];
    }
  }

  class LTEncoder {
    constructor(payload, blockSize, fileKey32, opts = {}) {
      if (!(blockSize > 0)) throw new Error("blockSize must be > 0");
      this.blockSize = blockSize;
      this.fileKey32 = fileKey32 >>> 0;
      this.K = Math.max(1, Math.ceil(payload.length / blockSize));
      this.c = opts.c ?? paramsForK(this.K).c;
      this.delta = opts.delta ?? paramsForK(this.K).delta;
      this.extra = opts.extra ?? 0;
      const padded = new Uint8Array(this.K * blockSize);
      padded.set(payload);
      this.padded = padded;
    }
    block(i) { return this.padded.subarray(i * this.blockSize, (i + 1) * this.blockSize); }
    encode(seed) {
      const nb = neighbours(this.K, seed, this.fileKey32, this.c, this.delta, this.extra);
      const out = new Uint8Array(this.blockSize);
      for (let i = 0; i < nb.length; i++) xorInto(out, this.block(nb[i]));
      return out;
    }
  }

  class LTDecoder {
    constructor(K, blockSize, fileKey32, opts = {}) {
      this.K = K; this.blockSize = blockSize; this.fileKey32 = fileKey32 >>> 0;
      this.c = opts.c ?? paramsForK(K).c;
      this.delta = opts.delta ?? paramsForK(K).delta;
      this.extra = opts.extra ?? 0;
      this.useGE = opts.useGE !== false;
      this.mode = opts.mode || (K <= (opts.mlMaxK ?? ML_MAX_K) ? "ml" : "peel");
      this.rank = 0;
      if (this.mode === "ml") {
        this.W = (K + 31) >>> 5;
        this.pivRows = new Array(K).fill(null);
        this.pivData = new Array(K).fill(null);
      }
      this.geMaxUnknown = opts.geMaxUnknown ?? 400;
      this.known = new Array(K).fill(null);
      this.knownCount = 0;
      this.packets = new Map();            // id -> {nb:Set<number>, data:Uint8Array}
      this.byBlock = Array.from({ length: K }, () => new Set());
      this.nextId = 1;
      this.seen = new Set();
      this.received = 0;                   // unique packets accepted
      this.duplicates = 0;
      this.geAttempts = 0;
      this.geSolved = 0;
      this._lastGERows = -1;
    }
    get done() { return this.knownCount === this.K; }

    /* Add one packet. `data` is copied. Returns "dup" | "ok" | "done". */
    addPacket(seed, data) {
      seed = seed >>> 0;
      if (this.seen.has(seed)) { this.duplicates++; return this.done ? "done" : "dup"; }
      this.seen.add(seed);
      this.received++;
      if (this.done) return "done";
      const buf = new Uint8Array(this.blockSize);
      buf.set(data.subarray(0, this.blockSize));
      const nbArr = neighbours(this.K, seed, this.fileKey32, this.c, this.delta, this.extra);
      if (this.mode === "ml") { this._addML(nbArr, buf); return this.done ? "done" : "ok"; }
      const nb = new Set();
      for (const b of nbArr) {
        const kb = this.known[b];
        if (kb) xorInto(buf, kb); else nb.add(b);
      }
      if (nb.size === 1) {
        this._resolve(nb.values().next().value, buf);
      } else if (nb.size > 1) {
        const id = this.nextId++;
        this.packets.set(id, { nb, data: buf });
        for (const b of nb) this.byBlock[b].add(id);
      }
      if (!this.done && this.useGE && this.received >= this.K) this._maybeGE();
      return this.done ? "done" : "ok";
    }

    _addML(nbArr, data) {
      const W = this.W, row = new Uint32Array(W);
      for (const b of nbArr) row[b >>> 5] |= 1 << (b & 31);
      let w = 0;
      for (;;) {
        while (w < W && row[w] === 0) w++;
        if (w === W) return;                       // linearly dependent: adds nothing
        const x = row[w];
        const col = (w << 5) + (31 - Math.clz32(x & -x));
        const pr = this.pivRows[col];
        if (!pr) { this.pivRows[col] = row; this.pivData[col] = data; this.rank++; break; }
        for (let k = w; k < W; k++) row[k] ^= pr[k];
        xorInto(data, this.pivData[col]);
      }
      if (this.rank === this.K) {
        // Back-substitution, highest pivot first: row c has its lowest bit at c.
        for (let col = this.K - 1; col >= 0; col--) {
          const r = this.pivRows[col], d = this.pivData[col];
          for (let w2 = col >>> 5; w2 < W; w2++) {
            let bits = r[w2];
            if (w2 === col >>> 5) { const p = col & 31; bits = p === 31 ? 0 : bits & (~0 << (p + 1)); }
            while (bits) {
              const t = bits & -bits;
              const h = (w2 << 5) + (31 - Math.clz32(t));
              xorInto(d, this.known[h]);
              bits ^= t;
            }
          }
          this.known[col] = d;
        }
        this.knownCount = this.K;
        this.pivRows = null; this.pivData = null;
      }
    }

    /* Information collected so far, 0..K (rank in "ml" mode, resolved blocks in "peel" mode). */
    get progressCount() { return this.mode === "ml" ? this.rank : this.knownCount; }

    _resolve(block, data) {
      const queue = [[block, data]];
      while (queue.length) {
        const [b, d] = queue.pop();
        if (this.known[b]) continue;
        this.known[b] = d; this.knownCount++;
        const ids = this.byBlock[b];
        this.byBlock[b] = new Set();
        for (const id of ids) {
          const p = this.packets.get(id);
          if (!p) continue;
          xorInto(p.data, d);
          p.nb.delete(b);
          if (p.nb.size === 1) {
            const r = p.nb.values().next().value;
            this.byBlock[r].delete(id);
            this.packets.delete(id);
            if (!this.known[r]) queue.push([r, p.data]);
          } else if (p.nb.size === 0) {
            this.packets.delete(id);
          }
        }
      }
    }

    _maybeGE() {
      const unknown = this.K - this.knownCount;
      const rows = this.packets.size;
      if (unknown > this.geMaxUnknown || rows < unknown || rows === this._lastGERows) return;
      this._lastGERows = rows;
      this.geAttempts++;
      const cols = [];
      const colIndex = new Int32Array(this.K).fill(-1);
      for (let b = 0; b < this.K; b++) if (!this.known[b]) { colIndex[b] = cols.length; cols.push(b); }
      const n = cols.length, W = (n + 31) >>> 5;
      const mats = [], datas = [];
      for (const p of this.packets.values()) {
        const row = new Uint32Array(W);
        for (const b of p.nb) { const ci = colIndex[b]; row[ci >>> 5] |= 1 << (ci & 31); }
        mats.push(row); datas.push(p.data.slice());
      }
      const m = mats.length;
      const pivotRow = new Int32Array(n).fill(-1);
      let r = 0;
      for (let col = 0; col < n && r < m; col++) {
        const w = col >>> 5, bit = 1 << (col & 31);
        let piv = -1;
        for (let i = r; i < m; i++) if (mats[i][w] & bit) { piv = i; break; }
        if (piv < 0) return false;            // rank deficient: wait for more packets
        if (piv !== r) {
          let t = mats[piv]; mats[piv] = mats[r]; mats[r] = t;
          t = datas[piv]; datas[piv] = datas[r]; datas[r] = t;
        }
        const pr = mats[r], pd = datas[r];
        for (let i = 0; i < m; i++) {
          if (i !== r && (mats[i][w] & bit)) {
            const mi = mats[i];
            for (let k = w; k < W; k++) mi[k] ^= pr[k];
            xorInto(datas[i], pd);
          }
        }
        pivotRow[col] = r; r++;
      }
      if (r < n) return false;
      for (let col = 0; col < n; col++) {
        const b = cols[col];
        if (!this.known[b]) { this.known[b] = datas[pivotRow[col]]; this.knownCount++; }
      }
      this.packets.clear();
      for (const s of this.byBlock) s.clear();
      this.geSolved++;
      return true;
    }

    /* Returns the reconstructed payload truncated to `length` bytes. */
    result(length) {
      if (!this.done) throw new Error("not decoded yet");
      const out = new Uint8Array(this.K * this.blockSize);
      for (let i = 0; i < this.K; i++) out.set(this.known[i], i * this.blockSize);
      return out.subarray(0, length);
    }
  }

  root.DexQR = root.DexQR || {};
  root.DexQR.lt = {
    DEFAULT_C, DEFAULT_DELTA, ML_MAX_K, paramsForK, extraDegreeFor, packetRng, mix32, makeRng, robustSolitonCdf, sampleDegree,
    neighbours, xorInto, LTEncoder, LTDecoder,
  };
})(typeof globalThis !== "undefined" ? globalThis : this);
