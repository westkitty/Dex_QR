# Development log

Append-only record of each improvement cycle: what was tried, measured and decided.

## 2026-11-01, cycle 1 (hourly improvement routine)

- Picked the theme "throughput and overhead". Baseline from results/ (v1): mean overhead 1.11–1.14 at K = 26, worst trial 1.65; heavy tail at every size.
- Systematic packets were considered and dropped for now: the sender starts at a random seed, so the receiver would rarely see the systematic prefix.
- Experiment (work/, not committed) comparing five neighbour rules with the ML decoder at K = 26, 100, 257, 1281: v1; minimum degree ceil(log2 K); minimum degree 2·log2 K; d + ceil(log2 K); dense random (p = 1/2). "d + log2 K" matched dense random on overhead at a fraction of the cost. "Minimum degree 2·log2 K" was much worse at K = 26 (mean 2.36): a fixed even degree only spans the even-weight subspace.
- Implemented as protocol v2 with backward-compatible v1 decoding. A cap-at-K bug was found by the existing K = 3 unit test and fixed; boost restricted to K ≥ 12 after a K = 1..40 scan.
- Verified: 17/17 unit tests; 1,800/1,800 drop trials (zbar and zxing-cpp) on freshly rendered v2 frames; 27/27 H.264 end-to-end runs; 17/17 headless Chrome page tests. Numbers in CHANGELOG.md, docs/RESULTS.md and results/degree_boost.json.
- Next: receiver robustness or larger/denser frame modes (see docs/ROADMAP.md).
