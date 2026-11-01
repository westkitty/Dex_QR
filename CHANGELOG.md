# Changelog

Append-only. Newest entries at the bottom.

## Cycle 1 (2026-11-01, about 4:30 AM EST): protocol v2 degree boost cuts fountain-code overhead and its tail

**What changed.** Protocol version 2. For 12 ≤ K ≤ 3000, each packet's robust-soliton degree d becomes d + ceil(log2 K) whenever that stays below K. Senders now emit v2; receivers accept v1 and v2 and lock onto the first packet's version. Packet layout is unchanged. See docs/PROTOCOL.md §3.

**Why.** The ML (Gaussian-elimination) decoder was waiting on rank, not on information: sparse soliton rows leave blocks uncovered or in small dependent clusters. A few extra random neighbours make the rows act like a dense random code, which is near-optimal (about K + 1.6 packets).

**Before → after, same harness, same seeds** (real zbar and zxing-cpp output, random start frame, 100 trials per cell, 400 B blocks, EC M, QR v16):

| File | Mean overhead v1 → v2 | Worst trial v1 → v2 | Frames shown ÷ K at 50% drop, v1 → v2 |
|---|---|---|---|
| 10 KiB (K = 26) | 1.108–1.138 → 1.067–1.083 | 1.654 → 1.308 | 2.217 → 2.142 |
| 100 KiB (K = 257) | 1.011–1.016 → 1.006–1.007 | 1.339 → 1.035 | 2.040 → 2.019 |
| 500 KiB (K = 1281) | 1.003–1.007 → 1.001 | 1.229 → 1.006 | 2.009 → 2.004 |

Success stayed at 900/900 per decoder (1,800 trials), every file SHA-256 identical. 27/27 end-to-end H.264 video runs pass. 17/17 headless Chrome page tests pass with 0 network violations. 17/17 unit tests pass.

Codec level (`node tests/unit/degree-boost.mjs`, results/degree_boost.json): K = 26 mean 1.110 → 1.060, p95 1.346 → 1.192, max 2.154 → 1.346. K = 100 max 1.42 → 1.09. K = 500 max 1.222 → 1.016.

**Cost.** Encoding XORs about log2 K more blocks per packet (5–11 extra 400 B XORs), and total decode time in Node roughly doubles (K = 1281: 65 → 117 ms for the whole file; K = 257: 2.8 → 5.1 ms). Both are small next to QR scanning time.

**Bug caught during the cycle.** A first version capped the boosted degree at K. At K = 3 that made every row all-ones, and the unit test never converged. Capping at any fixed even degree traps the system in the even-weight subspace, so the boost now only applies when d + extra < K, and only from K = 12 up (a 400-trial scan of K = 1..40 showed mixed results below that).

**Compatibility.** A v1 sender stream still decodes (new unit test). Mixed v1/v2 packets for the same file are rejected as another transfer. Older v1-only receivers will reject v2 packets with reason "version".

**Not tested.** Real phone or laptop cameras.
