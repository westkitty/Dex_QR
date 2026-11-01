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
