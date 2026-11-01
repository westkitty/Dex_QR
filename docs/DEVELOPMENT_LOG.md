# Development log

Append-only record of each improvement cycle: what was tried, measured and decided.

## 2026-11-01, cycle 1 (hourly improvement routine)

- Picked the theme "throughput and overhead". Baseline from results/ (v1): mean overhead 1.11–1.14 at K = 26, worst trial 1.65; heavy tail at every size.
- Systematic packets were considered and dropped for now: the sender starts at a random seed, so the receiver would rarely see the systematic prefix.
- Experiment (work/, not committed) comparing five neighbour rules with the ML decoder at K = 26, 100, 257, 1281: v1; minimum degree ceil(log2 K); minimum degree 2·log2 K; d + ceil(log2 K); dense random (p = 1/2). "d + log2 K" matched dense random on overhead at a fraction of the cost. "Minimum degree 2·log2 K" was much worse at K = 26 (mean 2.36): a fixed even degree only spans the even-weight subspace.
- Implemented as protocol v2 with backward-compatible v1 decoding. A cap-at-K bug was found by the existing K = 3 unit test and fixed; boost restricted to K ≥ 12 after a K = 1..40 scan.
- Verified: 17/17 unit tests; 1,800/1,800 drop trials (zbar and zxing-cpp) on freshly rendered v2 frames; 27/27 H.264 end-to-end runs; 17/17 headless Chrome page tests. Numbers in CHANGELOG.md, docs/RESULTS.md and results/degree_boost.json.
- Next: receiver robustness or larger/denser frame modes (see docs/ROADMAP.md).

## 2026-11-01, manual full improvement pass (not a counted routine cycle)

- Took .dev-state/cycle.lock at 04:42 EST; tree was clean at 56c3833. Baseline: 17/17 unit, 17/17 browser, axe 0 violations, drop trials as in cycle 1.
- Probed before changing anything: measured 8 fps → 7.50 fps (frame clock), reproduced a one-frame receiver freeze (forged K = 16,777,215: 5.9 s, 2.8 GB heap), found the stale-lock dead end, unhandled rejections in file mode, a leaking poll timer and object URLs, and later (via the new soak test) a camera-restart race.
- Rejected after critique: multi-strategy scanning (no failing frames to justify the per-frame cost; zxing already decodes 100% of harsh synthetic frames at the default), resume across reloads (would leave file fragments on disk by default), adaptive frame rate (one-way channel, nothing to adapt to), c = 0.03 (protocol change with no measured gain over the v2 boost), a light theme (cosmetic), enabling GitHub Pages (publishing is the owner's call).
- Implemented receiver limits and transfer switching in src/packet.js and src/session.js (no wire change), rewrote the page logic around explicit states, and added ux, a11y, soak and lint tooling. Details in CHANGELOG.md and Dex_QR_bible.md.
- Verified: 24/24 unit, lint 0 problems, 17/17 browser, 17/17 ux, axe 0 violations in 12 states, 60 s soaks pass, 1,800/1,800 drop trials identical to cycle 1, 27/27 H.264 runs.

## 2026-11-01, cycle 2 (hourly improvement routine)

- Lock held by the routine from 05:12 EST; tree clean at 79094f4. Compression was not implemented anywhere (only a roadmap mention), so the cycle did compression rather than the fallback (key check value).
- Design choices: a container-level marker (`DQZ1`) rather than a new protocol version, so the version byte and LT rules stay v2 and old streams are untouched; an informational header flag only for unencrypted streams (lets the receiver warn at the first frame, leaks nothing extra for encrypted ones); a 2% minimum gain so marginal cases keep the old, maximally compatible format; deflate-raw first, gzip as a fallback for older Chromium; output counted while inflating, with the declared size checked before any work.
- Test first: tests/unit/compression.test.mjs (11 tests) failed 0/11 against the old code; then container.js, packet.js and session.js changes made it 11/11. tests/fixtures/make-legacy-streams.mjs recorded streams from a 79094f4 worktree under work/ for the compatibility test.
- Measured with tests/bench/compression.mjs against a 79094f4 worktree (before) and this tree (after): CSV 192.4 → 35.5 frames, JSON 173.6 → 11.7, HTML 258.7 → 79.2, JS 53.9 → 19.6, JPEG 55.4 → 55.5 (skipped), random 258.7 → 258.8 (skipped), mean frames at 0% loss, 400 B / M. A 1 GiB zip bomb was stopped at the 32 MiB cap in 106 ms.
- `make` is not installed on this box, so the Makefile targets were run as their underlying commands (node tools/build.mjs, node tools/lint.mjs, node --test tests/unit/*.test.mjs, and the browser, e2e and soak scripts) with PY and LD_LIBRARY_PATH set to the box's venv and conda zbar.
- Verified: unit 35/35, lint 0, browser 17/17, ux 17/17, axe 0, soak 2/2, compression browser 4/4, trials 1,800/1,800 (identical files), H.264 27/27.
- Next: early wrong-passphrase detection via a key check value (roadmap item 5).

## 2026-11-01, cycle 3 (manual run on the owner's request, counted as cycle 3 of 12)

- Took .dev-state/cycle.lock at 05:29 EST (cycle 2 had released it); tree clean at f89f51b, in sync with origin/main. Baseline: unit 35/35, lint 0.
- Placement was the main design question. Putting the KCV into the DQE1 header would only help once source block 0 is recovered, which with the ML decoder is effectively at the end, and changing DQE1 or the packet header would break older receivers. A separate frame type with its own prefix (`DK`) is skipped by older receivers (the `DQ` prefix check makes it a foreign code), needs no protocol version bump, and can arrive at any time. Cost is time, not bytes: 1 frame in 32.
- KCV derivation: PBKDF2 `deriveBits` once, import as the AES-GCM key (identical to the old `deriveKey` result, pinned by a test) and as an HKDF key; KCV = HKDF-SHA-256 with info "Dex_QR key check v1", 2 bytes. Raw bits are zeroed after import.
- Considered and rejected: a 4-byte KCV (a stronger offline confirmation oracle for no UX gain, since AES-GCM catches the 1-in-65,536 false accept), sending the key frame more often (every 16: 6% overhead for about 1 s less wait), and auto-focusing the passphrase box when it appears mid-scan (an unexpected focus move; the page announces it instead).
- Test first: tests/unit/keycheck.test.mjs (9 tests) failed 8/9 against the old code (the format-unchanged test passed, as intended); then 9/9. One test bug of mine (key frame fed before any data packet) was fixed in the test, not the code.
- tests/browser/keycheck.mjs (5 checks) through the real receiver page; tests/browser/a11y.mjs gained a state. The first a11y run failed because `page.waitForFunction` evaluates strings, which the page CSP blocks; replaced with an evaluate-polling helper (test-only).
- A sender blemish caught by tests/browser/run.mjs output: the QR stat line showed "version 3" because the preview drew the key frame; the preview now draws a data packet.
- The browser suite needs PY=/workspace/toolchain/venv-qr/bin/python and LD_LIBRARY_PATH=/workspace/toolchain/mamba/zbar/lib on this box (the first attempt without them failed to find zbar output; environment, not code).
- Measured: mean time to a wrong-passphrase verdict 31.6 s → 2.1 s for 100 KB at 0% loss, 314 s → 6.7 s for 500 KB at 50% loss; +2.6% to +3.9% frames to the file. Table in CHANGELOG.md.
- Next: PBKDF2 iteration calibration and a better strength estimate, or fuzzing parseText / parseKeyFrame / ReceiverSession.
