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

## Cycle 2 (2026-11-01, about 5:27 AM EST): transparent compression before fountain coding

**What changed.** The sender wraps the file container in a new compressed container `DQZ1` (magic, algorithm byte, uncompressed length, deflate data) made with the browser's built-in `CompressionStream("deflate-raw")` (gzip where deflate-raw is missing), and uses it only when it saves at least 2%; otherwise the payload is byte-identical to the old `DQF1` format. With a passphrase it compresses first, then encrypts. Unencrypted compressed streams set flag bit 1 in the packet header (never on encrypted streams, so the ciphertext does not reveal it). Protocol version byte stays 2. A "Compress when it helps" checkbox (on by default) and a Compression line on the sender; a Compressed line, result note and two new errors on the receiver. No new dependency, no network, works from `file://`. See docs/PROTOCOL.md §2 and §4 and the new length-leak paragraph in docs/THREAT_NOTE.md.

**Receiver guards.** A declared uncompressed size over 32 MiB + 4 KiB is refused before inflating (`TOO_LARGE`); inflation counts bytes and stops as soon as output passes the declared size (`TOO_LARGE`). Measured in Node: 1 MB of deflated zeros that would expand to 1 GiB was stopped at 32 MiB after 106 ms with about 64 MB of extra memory. Short output, corrupt data, unknown algorithm or a nested container is `BAD_FORMAT`. No `DecompressionStream` → `NO_DECOMPRESSION`, and the receiver page warns at the first frame of a flagged stream. No `CompressionStream` on the sender → sent uncompressed.

**Before → after** (`tests/bench/compression.mjs`, shipped defaults 400 B / EC M / 8 fps, simulated reception with 100 trials per cell from random start frames, no camera; input files frozen at commit 79094f4; before = code at 79094f4, after = this commit; results/compression_before.json and compression_after.json):

| File (bytes) | Payload bytes | K | Mean frames, 0% loss | Mean frames, 30% loss | Time at 8 fps, 0% / 30% loss |
|---|---|---|---|---|---|
| sensor-log.csv, generated (76,350) | 76,379 → 13,206 | 191 → 34 | 192.4 → 35.5 | 276.5 → 50.7 | 24.1 s → 4.4 s / 34.6 s → 6.3 s |
| trials_102400_zxing.json (68,378) | 68,425 → 3,857 | 172 → 10 | 173.6 → 11.7 | 247.2 → 17.7 | 21.7 s → 1.5 s / 30.9 s → 2.2 s |
| sender.html, HTML + inlined JS (102,485) | 102,512 → 30,826 | 257 → 78 | 258.7 → 79.2 | 367.9 → 114.9 | 32.3 s → 9.9 s / 46.0 s → 14.4 s |
| receiver.app.js, JS source (20,693) | 20,730 → 7,019 | 52 → 18 | 53.9 → 19.6 | 76.1 → 28.0 | 6.7 s → 2.5 s / 9.5 s → 3.5 s |
| video-001.jpeg, real photo (21,459) | 21,490 → 21,490 (skipped) | 54 → 54 | 55.4 → 55.5 | 78.8 → 79.2 | 6.9 s → 6.9 s / 9.8 s → 9.9 s |
| random.bin (102,400) | 102,441 → 102,441 (skipped) | 257 → 257 | 258.7 → 258.8 | 371.4 → 369.2 | 32.3 s → 32.4 s / 46.4 s → 46.1 s |

Encrypted payloads shrink the same way (+52 bytes each: CSV 76,431 → 13,258). The JSON file is very repetitive test output, so 14.8× is the high end; source and HTML gave 2.7–3.3×, the CSV 5.4×. JPEG and random data are unchanged within simulation noise (the skip path sends identical bytes). Sender preparation time rose by at most about 9 ms for these files.

**Tests.** Unit 24 → 35 (11 new in tests/unit/compression.test.mjs, written first and failing 0/11 before the implementation; one existing test now passes `compress: false` because 300 kB of zeros legitimately fits once compressed). Recorded v1/v2, plain/encrypted streams from commit 79094f4 (tests/fixtures/legacy_streams.json) still decode. New headless Chrome suite tests/browser/compression.mjs 4/4 with the browser's real CompressionStream, 0 network requests. Existing suites rerun: lint 0 problems, browser 17/17, ux 17/17, axe 0 serious/critical violations, soak 2/2, drop trials 1,800/1,800 (results/trials_*.json byte-identical to before), H.264 end-to-end 27/27.

**Not tested:** real phone or laptop cameras; Safari and Firefox CompressionStream (Chrome 156 headless and Node 24 only).
