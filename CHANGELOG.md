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

## Manual full pass (2026-11-01, about 5:10 AM EST): receiver hardening, interaction states, accessibility and lifecycle fixes

Not one of the hourly routine's 12 counted cycles. No wire-format change: protocol v2, v1 streams still decode.

**Defects fixed (each reproduced first, then covered by a test):**
- *One forged frame could freeze or crash the receiver.* A CRC-valid packet claiming K ≈ 16.7 million made the decoder allocate per-block state for every block: 5.9 s and 2.8 GB of heap in Node from a single frame. Packets with K > 262,144 or F > 32 MiB + 4 KiB are now rejected as "limits" (under 1 ms); the sender refuses such streams too.
- *8 fps actually ran at 7.50 fps* (and 25 fps at 20) on a 60 Hz display, because each frame was rounded up to whole refreshes. The frame clock is now an absolute schedule: measured 8.00 and 24.99 fps.
- *A stale lock was a dead end.* If the receiver locked onto an old transfer (the sender re-prepared with a new passphrase, or another code was in view first), it ignored the new one forever. It now buffers the other transfer's packets (bounded) and offers "Switch to the new transfer", which completes without rescanning.
- *Two quick camera changes left no camera running* and a disabled Stop button: two overlapping starts stopped each other's streams. Only the newest start now wins.
- *File-input errors were unhandled promise rejections* (e.g. "BarcodeDetector only" in a browser without it); picking the same files twice did nothing; picking files while the camera ran left the camera on; a failing video file left a 200 ms poll timer running forever; each completed transfer leaked its object URL; repeated Decrypt presses ran several PBKDF2 derivations at once.
- *Reset discarded partial progress without asking.* It now asks with a second press (5 s, Esc cancels). Leaving the page with partial progress asks too.

**Interaction and accessibility:** camera errors explained by kind (permission denied, no camera, camera busy, camera stopped mid-scan) with the file fallback named; hints when the camera sees non-Dex_QR codes or an unsupported protocol version; live regions for status and errors, progress bars with values, visible focus rings, 44 px targets, focus moved to Save on success and back to the passphrase on a wrong one, ✓/✗ marks so states do not rely on colour; on phones the receiver's camera view comes first; camera/decoder/file options in a disclosure. Sender: Space/K play-pause, F full screen with an in-page fallback where the Fullscreen API is missing (iPhone Safari), live EC level and module size, a "settings changed" flag until Prepare, clamped inputs, actual fps shown, Wake Lock while playing (receiver too, while the camera runs), redraw on resize, and a flashing-content note.

**Tests:** unit tests 17 → 24; new `tests/browser/ux.mjs` (17 checks), `tests/browser/a11y.mjs` (axe-core, 12 page states, 0 violations), `tests/browser/soak.mjs` (60 s per page, no heap growth, one camera stream after churn), `tools/lint.mjs` (syntax, debug leftovers, innerHTML, stale build, CSP). Existing browser suite 17/17 (now opens the options disclosure like a user). Drop-rate trials re-rendered and re-decoded: 1,800/1,800, identical to cycle 1 in all 18 cells. H.264 end-to-end 27/27.

**Not tested:** real phone and laptop cameras, Safari, Firefox, screen readers used by a person, and Wake Lock on a real device.
