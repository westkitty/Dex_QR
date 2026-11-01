# Dex_QR Bible

The canonical, append-only project ledger for Dex_QR: enough context for another developer or agent to resume safely. **Add new dated entries at the bottom. Never rewrite, compact, reorder or delete earlier entries.**

Related ledgers (also append-only): [CHANGELOG.md](CHANGELOG.md) (what changed, with numbers), [docs/DEVELOPMENT_LOG.md](docs/DEVELOPMENT_LOG.md) (per-cycle working notes), [docs/ROADMAP.md](docs/ROADMAP.md) (what is next). The protocol is specified in [docs/PROTOCOL.md](docs/PROTOCOL.md).

---

## 2026-11-01 — Full improvement, implementation, QA and bug-sweep pass (manual; not one of the hourly routine's 12 counted cycles)

### Repository and branch
- Repository: https://github.com/westkitty/Dex_QR (public), local clone `/workspace/Dex_QR` on the shared box.
- Branch: `main`, upstream `origin/main`. Remote verified as `https://github.com/westkitty/Dex_QR.git`.
- Coordination: took `.dev-state/cycle.lock` at 04:42 EST (owner "manual full improvement pass"), so the hourly routine skipped; released at the end. No PAUSED or STOPPED file existed.

### Starting state (commit 56c3833, clean working tree)
- **Architecture:** no framework. Plain ES5/ES2017 browser scripts in `src/` attach to `globalThis.DexQR` (`base45`, `crc32`, `lt`, `packet`, `container`, `session`, `render`, `scan`); page logic in `src/pages/*.app.js`; `tools/build.mjs` inlines CSS, vendor libraries (qrcodegen MIT, jsQR Apache-2.0, zxing-wasm MIT with base64-inlined .wasm) and the scripts into single-file `sender.html`, `receiver.html` and `index.html`, each with a CSP that forbids network. Node tests load the same scripts through `tests/lib/load.cjs`.
- **Protocol:** v2 (LT code, robust soliton, degree boost for 12 ≤ K ≤ 3000), receivers accept v1 and v2.
- **Baseline commands and results:** `npm run build` OK; `npm test` 17/17; `node tests/browser/run.mjs` 17/17 with 0 network requests; axe-core (added this pass) 0 violations on the default page states. No lint or type-check existed.
- **Works well:** codec, packet framing, encryption container, drop-rate and video harness, CSP and no-network guarantee, the core sender and receiver flows.
- **Incomplete or fragile:** receiver error paths (unhandled rejections in file mode, generic camera errors), lifecycle (timers, object URLs, camera restarts), no confirmation before discarding progress, no way out of a stale transfer lock, no resource limits on headers, sender frame clock inaccurate.
- **Misleading:** README and checklist pointed to a "GitHub Pages copy" that does not exist; README and BENCHMARK quoted v1 overhead (10–15%, 1.5×) after v2 changed it.
- **Visibly unfinished:** on phones the receiver's camera view sat below every control; the empty video box had no explanation; the sender's "Full screen" did nothing on browsers without the Fullscreen API.
- **Cannot be verified here:** real phone or laptop cameras, Safari, Firefox, screen readers used by a person, Wake Lock on hardware.

### Goals of this pass
Find and rank the most important remaining improvements across mechanics, assets, UI, UX and accessibility, and performance and reliability; critique the ranking; implement what survives; run an exhaustive bug sweep; record everything; deliver through Git without breaking protocol compatibility or the offline guarantee.

### Evaluation findings (prioritized; evidence measured before any change)
| # | Category | Problem and evidence | Consequence | Priority / scope | Acceptance criterion |
|---|---|---|---|---|---|
| 1 | Reliability | One CRC-valid frame claiming K = 16,777,215 froze the old receiver 5.9 s and used 2.8 GB of heap (Node, old `src/` from HEAD) | A stray or hostile code crashes the receiver tab, losing progress | Critical / small | Such a frame is rejected in < 200 ms with no decoder allocated; the largest legitimate stream still parses |
| 2 | Mechanics | Sender at 8 fps measured 7.50 fps in headless Chrome (60 Hz rAF); 25 fps would run at 20 | Default speed 6% slow; ETA wrong; higher speeds badly off | High / small | 8 and 25 fps within 3% |
| 3 | Mechanics / UX | Receiver locks onto the first transfer forever; re-preparing an encrypted send changes the file ID, so the new stream is ignored with no hint | Transfer silently never finishes | High / medium | Switch is offered after a streak of the other transfer and completes from buffered packets |
| 4 | Reliability | `decodeFiles` had no catch (unsupported decoder → unhandled rejection); same files could not be re-picked; camera stayed on during file decoding; video poll interval leaked on error; result object URLs never revoked; concurrent Decrypt presses | Dead UI, leaks, wasted PBKDF2 work | High / small | Tests show messages instead of errors; timers and URLs released |
| 5 | UX | Reset discarded progress instantly; reload lost progress silently | Accidental loss of minutes of scanning | High / small | Second press required; Esc cancels; beforeunload prompt |
| 6 | UX | Camera failures shown as raw `Camera error: …`; no hint when the camera sees non-Dex_QR codes | User cannot tell what to do | Medium / small | Distinct, actionable messages per error kind |
| 7 | Accessibility | No live regions, progress bars without values, no custom focus style, 37 px buttons, colour-coded states | Screen-reader and keyboard users get no feedback | Medium / small | axe 0 violations; live regions; ≥ 44 px targets; ✓/✗ text marks |
| 8 | UI (phone) | Receiver camera view below all controls at 390 px; Full screen dead on iPhone Safari | Users scroll while aiming; the code is too small to scan | Medium / small | Camera view first at 390 px; in-page full-screen fallback fits the viewport |
| 9 | UX (sender) | Changing file, passphrase or density after Prepare silently kept the old stream; inputs unclamped; no keyboard control; screen may sleep mid-transfer | Wrong file sent; transfers interrupted | Medium / small | Stale flag until Prepare; Space/K/F; clamped inputs; Wake Lock while playing |
| 10 | Docs | Pages copy and v1 overhead claims | Misleading instructions | Medium / small | Docs match the repo |
| 11 | Reliability (found by the new soak test) | Two quick camera changes stopped each other's streams, leaving no camera and a disabled Stop | Camera switching breaks scanning | High / small | One live track after churn; Stop releases it |

### Adversarial critique conclusions
- #1: justified by measurement; the fix is a parse-time guard, not a wire change, and the caps sit above anything the sender UI can produce (32 MiB, T ≥ 200 → K ≤ 167,773).
- #2: real but small per frame; fixed with an absolute schedule rather than a timer thread, so frames still change only on display refreshes.
- #3: a smaller alternative (auto-switch on majority) was rejected because a second code in view could hijack a transfer; the switch stays a deliberate click, and the buffer is bounded (4,096 packets).
- #5: `confirm()` was rejected (blocks the scan loop and is auto-dismissed in automation); an inline second press was chosen.
- #7: axe passed even before the pass, so the evidence for #7 is the code review (no live regions, no progress values), not the scanner. Kept small.
- Moving camera/decoder/file controls into a disclosure was challenged as hiding features; kept, because the defaults work, the summary text names all three, and phones gain a screen of space. Tests open it the way a user would.

### Suggestions rejected and why
- Multi-strategy scanning (binarization, contrast, inversion): no failing frames to justify it; zxing-wasm already reads 100% of the harsh synthetic frames at the default settings; it would cost per-frame time on phones. Revisit with real-camera failures.
- Resume across reloads (IndexedDB): stores file fragments on disk by default, against the project's privacy stance. Replaced by a leave-page prompt.
- Adaptive frame rate: the channel is one-way; the sender has nothing to adapt to without the reverse channel (roadmap item 6).
- c = 0.03 for K ≤ 3000: a wire-protocol change with no measured gain over the v2 boost.
- Light theme and other cosmetic rework: no user problem identified.
- Enabling GitHub Pages: publishing a site is the owner's decision; documented as the fix for phones that block file:// cameras.

### Changes implemented
- **Mechanics/protocol (no wire change):** `src/packet.js` adds `MAX_K = 262144` and `MAX_LENGTH = 32 MiB + 4 KiB`, rejection reason `"limits"`. `src/session.js`: sender refuses over-limit streams; `ReceiverSession` counts rejection reasons, buffers one other transfer (`pending`, max 4,096 distinct texts), tracks `otherStreak`, exposes `otherTransferWaiting` (streak ≥ 8) and `switchToPending()`.
- **Sender page:** absolute-schedule frame clock with actual-fps display; inputs clamped (fps 1–30, module 0–20); stale-settings flag; EC level and module size apply live; Space/K play-pause, F full screen, Esc exit; full-screen fallback ("focus mode") with Pause and Exit buttons; redraw on resize and fullscreen change; Wake Lock while playing; aria-pressed, live regions, progressbar values; flashing-content note.
- **Receiver page:** explicit start token (newest start wins); camera errors by kind; track `ended` handling; camera change restarts the camera, decoder change applies live; file mode stops the camera, catches errors, resets the input, distinguishes "no QR" from "QR but not Dex_QR"; video-file path releases its timer, object URL and source; one decrypt at a time with session-identity checks; result URL revoked on reset; Reset confirmation; leave-page prompt; switch banner; hints for foreign codes and unsupported versions; focus to Save on success; Wake Lock while scanning.
- **Assets/visual:** no image assets exist; shared CSS gained focus rings, 44 px targets, hover/active/disabled/danger/attention states, monospace for hashes (no more mid-word breaks elsewhere), an empty camera state, phone ordering, disclosure marker, reduced-motion rules, `color-scheme: dark`.
- **Accessibility:** role=status/alert messages, progressbar semantics, labelled sections, `aria-describedby` on the passphrase, keyboard shortcuts that never fire inside fields, ✓/✗ text marks.
- **Performance/lifecycle:** no per-frame allocations added; 60 s soaks show flat heaps; camera streams and timers released.
- **Tooling:** `tools/lint.mjs` (`npm run lint`), `tests/unit/robustness.test.mjs`, `tests/browser/ux.mjs`, `tests/browser/a11y.mjs` (axe-core 4.14.0, MPL-2.0, dev-only), `tests/browser/soak.mjs`; Makefile and npm scripts; `tools/report.mjs` adds ux, soak and a11y sections to docs/RESULTS.md.
- **Docs:** README (use, limits, results, commands), PROTOCOL §4 limits and switching, §6 frame clock, THREAT_NOTE (nothing stored; hostile frames), TEST_CHECKLIST (new real-device checks; Pages claim removed), BENCHMARK tail (v2 overhead), RESULTS head (regression check), THIRD_PARTY_NOTICES (axe-core), CHANGELOG, DEVELOPMENT_LOG, ROADMAP.

### Bug-sweep ledger (severity · reproduction · root cause · fix · test · result)
1. **Critical** · feed one CRC-valid frame with K = 16,777,215, T = 1 · no bounds on header fields · `limits` check in `parseBytes` · robustness.test "oversized headers…", ux "forged huge-K frame" · fixed, verified (< 1 ms; old code 5.9 s, 2.8 GB).
2. **High** · sender at 8 fps for 6 s · `ts - last >= interval` rounds every frame up to whole refreshes · absolute schedule `due += interval` · ux "frame clock" · fixed, verified (8.00, 24.99 fps; old 7.50).
3. **High** · lock onto transfer A, then show only B · lock never released, no UI · bounded pending buffer, streak, Switch button · robustness.test switch tests, ux "stale transfer" · fixed, verified.
4. **High** · select camera twice quickly (two `change` events) · overlapping `startCamera` calls; the older one's error path stopped the newer stream · start token · soak "Start/Stop churn" · fixed, verified (1 live track).
5. **High** · choose "BarcodeDetector only" in a browser without it, then pick files · `decodeFiles` promise had no catch · try/catch/finally with message · ux "unsupported decoder" · fixed, verified.
6. **Medium** · pick the same files twice · input value never cleared · `input.value = ""` · ux "same files can be picked again" · fixed, verified.
7. **Medium** · pick files while the camera runs · camera never stopped; two loops on one video element · `stopCamera()` first, scan generations · covered by ux file tests · fixed, verified.
8. **Medium** · video file that errors · poll interval cleared only on `ended` · idempotent `finish()` clears it · ux "video file… released" · fixed, verified.
9. **Medium** · complete several transfers with Reset between · object URLs never revoked · `revokeResult()` · code review (no observable API in tests) · fixed, partially verified.
10. **Medium** · press Decrypt repeatedly · concurrent PBKDF2 derivations and duplicate results · `opening` guard, disabled button, session identity check · ux "repeated Decrypt" · fixed, verified.
11. **Medium** · Reset with progress · immediate discard · two-press confirmation, Esc cancels · ux "Reset… asks first" · fixed, verified.
12. **Medium** · deny camera permission / no mediaDevices / track ends · generic or no message; ended track left a dead preview · messages by error name, `ended` listener · ux three tests · fixed, verified.
13. **Low** · after Stop with no progress, the "camera sees QR codes" hint stayed · message not cleared · Stop clears it · manual headless probe (fake camera; message empty after each Stop), no committed test · fixed, verified by probe.
14. **Low** · sender changes density after Prepare · stream silently kept old settings · stale flag · ux "stale settings" · fixed, verified.
15. **Low** · type 99 in Speed · loop clamped to 60 while the field said 30 max · clamp and write back · ux "clamps" · fixed, verified.
16. **Low** · Full screen on browsers without the API · nothing happened · in-page focus mode · ux "full-screen fallback" · fixed, verified in Chrome with the API removed (not on an iPhone).
17. **Low** · `listCameras` built options with `innerHTML` and unescaped device IDs · string HTML · DOM nodes · lint forbids `innerHTML` in src · fixed, verified.
18. **Low (docs)** · README/checklist "GitHub Pages copy"; v1 overhead quoted · stale docs · corrected · review · fixed.
19. **Cosmetic** · `word-break: break-all` split ordinary words in the stats · overflow-wrap anywhere + monospace for hashes · screenshots · fixed.
- Static sweep: no `console.*`, `debugger`, secrets or `innerHTML` in `src/` (enforced by lint); removed two unused sender state fields (`last`, `file`) after grepping pages and tests.

### Tests added or changed
- Added `tests/unit/robustness.test.mjs` (7 tests): limits, sender refusal, per-reason counts, block-size boundaries (K·T, K·T±1, K = 1), out-of-order/duplicate/interleaved packets, switching, bounded buffer.
- Added `tests/browser/ux.mjs` (17 checks), `tests/browser/a11y.mjs`, `tests/browser/soak.mjs`, `tools/lint.mjs`.
- Changed `tests/browser/run.mjs`: opens the options disclosure before choosing a decoder.

### Commands run and validation results (final run, after all changes)
- `npm run build` OK; `npm run lint` → 29 files, 0 problems; `npm test` → 24/24.
- `node tests/browser/run.mjs` → 17/17, 0 network requests (Chrome 156).
- `node tests/browser/ux.mjs` → 17/17, 0 network requests.
- `node tests/browser/a11y.mjs` → 0 violations in 12 states (390 and 1280 px).
- `SOAK_SECONDS=60 node tests/browser/soak.mjs` → 2/2 (sender 30.0 fps for 60 s, heap 2.2 → 1.8 MB; receiver 601 frames in 60 s, heap 2.1 → 2.2 MB; 1 live track after churn; none after Stop).
- Drop-rate regression: re-rendered 10/100/500 KiB frames from the current code, decoded with zbar (conda-forge libzbar + pyzbar in `/workspace/toolchain/venv-qr`) and zxing-cpp, 100 trials per cell at 10/30/50% → 1,800/1,800, SHA-256 identical, all 18 cells identical to cycle 1 (means 1.067–1.083, 1.006–1.007, 1.001; worst 1.308). `results/regression_2026-11-01.json`.
- H.264 end-to-end: 27/27 (`results/video_e2e_*.json`).
- Not re-run: the throughput benchmark (`make bench`); the decode path it measures did not change.

### Architecture decisions
- Resource limits live in `packet.parseBytes` (the boundary), so every consumer (pages, tests, harness) gets them.
- Transfer switching lives in `ReceiverSession` (testable in Node); the page only renders the offer.
- Receiver concurrency is handled with two counters: `startToken` (newest camera start wins) and `scanGen` (one scan loop at a time).
- No persistence by design (privacy); `beforeunload` prompt instead.

### Important files changed
`src/packet.js`, `src/session.js`, `src/pages/receiver.app.js`, `src/pages/receiver.template.html`, `src/pages/sender.app.js`, `src/pages/sender.template.html`, `src/pages/common.css`, built `sender.html`/`receiver.html`/`index.html`, `tests/unit/robustness.test.mjs`, `tests/browser/{ux,a11y,soak}.mjs`, `tests/browser/run.mjs`, `tools/lint.mjs`, `tools/report.mjs`, `package.json`, `package-lock.json`, `Makefile`, docs listed above, `results/{browser,ux,a11y,soak,regression_2026-11-01,video_e2e_*}.json`.

### Known limitations and unverified behaviour
- Real phone and laptop camera scanning, Safari, Firefox, iPhone focus mode, Wake Lock on hardware, and screen-reader use by a person are **untested**. axe only checks what a machine can.
- Partial progress does not survive a reload (by design).
- Switching keeps at most 4,096 packets of the other transfer; very large transfers continue scanning after a switch.
- The sender's frame clock was measured in headless Chrome at 60 Hz; real displays at 90/120 Hz were not measured.

### Fragile areas
- `src/lt.js` neighbour selection and `extraDegreeFor`: pinned by golden vectors; any change is a wire-protocol change and needs a version bump.
- `receiver.app.js` async flows (`startCamera`, `tryOpen`, `decodeFiles`): keep the token, generation and session-identity checks when editing.
- `tools/build.mjs` inlining: a `</script` in any inlined file breaks the page (the build refuses it).

### Do-not-touch warnings
- Do not loosen the CSP or add any network fetch; tests fail on any non-file/data/blob request.
- Do not change `MAX_K`/`MAX_LENGTH` below what the sender UI can produce (32 MiB at 200 B blocks).
- Do not switch transfers automatically.
- Do not commit `work/` (gigabytes of frames) or `node_modules/`.

### Remaining work, by priority
1. Run docs/TEST_CHECKLIST.md on a real phone and laptop (owner).
2. Decide on GitHub Pages (owner) for phones that block file:// cameras.
3. Screen-reader, Safari and Firefox passes.
4. Fuzz `parseText` and `ReceiverSession`.
5. Reverse-channel ACK QR, then adaptive rate; multi-strategy scanning only with real failing frames.

### Final commit identifier
(added below after committing)

- Main commit: `06ca31167fbe5e2725795b06847888a2f602f13d` ("Full improvement and bug-sweep pass…") on `main`.
- This line was added in a small docs follow-up commit, which also records the pass in `.dev-state/cycles.log` (not tracked).

---

## 2026-11-01 — Cycle 2 of 12 (hourly routine): transparent compression

- **Lock:** `.dev-state/cycle.lock` held by the routine from 05:12 EST, starting at commit 79094f4 (clean, in sync with origin/main).
- **What:** payload compression with the browser's built-in CompressionStream before fountain coding (and before encryption). New inner container `DQZ1` = magic | algorithm u8 (1 deflate-raw, 2 gzip) | uncompressed length u32 | data. Used only if it saves ≥ 2%; otherwise the payload is the unchanged `DQF1`. Packet flag bit 1 marks unencrypted compressed streams (informational; never set with encryption). Protocol version byte stays 2.
- **Receiver safety:** declared size > 32 MiB + 4 KiB refused before inflating; output counted and aborted past the declared size (`TOO_LARGE`); `BAD_FORMAT` for short output, corrupt data, unknown algorithm or nesting; `NO_DECOMPRESSION` without DecompressionStream, with an early warning on the page.
- **Compatibility:** every stream older senders produce still decodes (recorded fixtures from 79094f4, v1/v2, plain/encrypted). A compressed stream needs a receiver from this cycle or later; an older receiver fails at the end with a format error. Senders can untick compression.
- **Numbers (mean frames at 400 B / EC M, 0% loss, simulated):** CSV 76 KB 192.4 → 35.5; JSON 68 KB 173.6 → 11.7; HTML 102 KB 258.7 → 79.2; JS 21 KB 53.9 → 19.6; JPEG 21 KB 55.4 → 55.5 (skipped); random 100 KiB 258.7 → 258.8 (skipped). Files and method in CHANGELOG.md; data in results/compression_before.json and compression_after.json.
- **Tests:** unit 35/35 (24 before), compression browser 4/4, browser 17/17, ux 17/17, axe 0, soak 2/2, lint 0, trials 1,800/1,800, H.264 27/27. `make` is missing on the box; the targets' commands were run directly.
- **Files touched:** src/container.js, src/packet.js, src/session.js, src/pages/{sender,receiver}.{app.js,template.html}, src/pages/common.css, built pages, tests/unit/compression.test.mjs, tests/unit/robustness.test.mjs (one test now passes compress:false), tests/fixtures/*, tests/bench/compression.mjs, tests/browser/compression.mjs, Makefile, package.json, docs, results.
- **Untested:** real cameras; Safari/Firefox CompressionStream behaviour.
- **Next:** cycle 3, early wrong-passphrase detection via a key check value.

---

## 2026-11-01 — Cycle 3 of 12 (manual run on the owner's request): early wrong-passphrase detection

- **Lock:** `.dev-state/cycle.lock` taken by "manual cycle 3" at 05:29 EST (released by cycle 2), starting at f89f51b, clean and in sync with origin/main.
- **What:** encrypted streams interleave a key-check frame (`DK` + Base45 of 36 bytes: version, KDF id, file ID, iterations, salt, 2-byte KCV, CRC-32) at frame 0 and every 32nd frame. KCV = HKDF-SHA-256(PBKDF2 output, empty salt, info "Dex_QR key check v1")[0..2]. The AES key is still the PBKDF2 output, so DQE1 and data packets are unchanged.
- **Receiver UX:** passphrase box from the first encrypted packet with a "Check passphrase" button; verdict announced (alert for wrong, status otherwise); focus returns to the field on a wrong passphrase; scanning and progress continue; a passphrase typed before any key frame waits and is checked automatically when one arrives; with a match the file opens by itself at the end using the cached key. New "Passphrase check" status row.
- **Sender UX:** "Let the receiver check the passphrase early" (default on) with an explanation of the trade-off; part of the stale-settings check; ETA accounts for the key frames.
- **Numbers (simulated, 100 trials, 8 fps):** mean time to a wrong-passphrase verdict 20 KB 6.7 → 2.1 s, 100 KB 31.6 → 2.1 s, 500 KB 156.7 → 2.1 s at 0% loss; 500 KB at 50% loss 314.0 → 6.7 s (p95 326.0 → 19.8 s). Frames to the file +2.6% to +3.9%. +0 bytes per data packet. Full table in CHANGELOG.md; data in results/keycheck.json and results/keycheck_browser.json.
- **Compatibility:** pre-cycle-3 receivers ignore `DK` frames (they are foreign codes to them); pre-cycle-3 encrypted streams open as before with the check at the end; a payload built now decrypts with the old `deriveKey` code (unit test).
- **Security note:** no guess gets cheaper, but one filmed key frame lets an attacker filter guesses (16 bits, cannot confirm). Documented in THREAT_NOTE.md; senders can turn it off.
- **Tests:** unit 44/44 (9 new), key-check browser 5/5 (new), browser 17/17, ux 17/17, axe 0 serious/critical in 14 states, compression browser 4/4, soak 2/2, lint 0. Drop trials and H.264 not rerun (no codec or data-packet change).
- **Files touched:** src/container.js, src/packet.js, src/session.js, src/pages/{sender,receiver}.{app.js,template.html}, built pages, tests/unit/keycheck.test.mjs, tests/browser/keycheck.mjs, tests/browser/a11y.mjs, tests/bench/keycheck.mjs, Makefile, package.json, README.md, CHANGELOG.md, docs/{PROTOCOL,THREAT_NOTE,TEST_CHECKLIST,ROADMAP,DEVELOPMENT_LOG}.md, results/{keycheck,keycheck_browser,a11y,ux,…}.json.
- **Fragile:** `receiver.app.js` early-check flow (`earlyCheck`, `checkToken`, `pendingCheck`): keep the token and session checks; the early check must stay advisory (AES-GCM decides).
- **Untested:** real cameras (does the version-3 key QR read at the same distance; autofocus with the size change), Safari, Firefox, screen readers.
- **Next:** cycle 4, PBKDF2 iteration calibration and a better strength estimate (or fuzzing of the parsers).

- **Commit:** `1a31435762b240759719afb6c7ad684f8758fc15` on `main` (pushed f89f51b..1a31435; this line added in a docs follow-up commit).

---

## 2026-11-01 — Cycle 4: PBKDF2 calibrated to the device, pattern-aware strength meter (routine cycle 4, finished as "manual resume cycle 4")

- **Lock:** routine cycle 4 took `.dev-state/cycle.lock` at 06:07 EST and stopped midway at an Auto-review card, leaving uncommitted work. Resumed 06:29 EST by "manual resume cycle 4" from 8949cb7 (in sync with origin/main). The previous worker's diff was reviewed and kept; nothing stashed, reset, cleaned or deleted.
- **What:** `DQ.container.calibrateIterations()` times PBKDF2 probes (start 100,000, ×4 while under 40 ms, budget 1.5 M) and returns the count for about 1 s, rounded down to 100,000, clamped to [600,000, 8,000,000]; fails safe to 600,000. Sender "Key stretching" select: Tuned (default) or Standard 600,000; part of the stale-settings check. Sender refuses counts outside [100,000, 10,000,000]. Receiver messages show the stream's count and the measured check time. No wire-format change.
- **DoS bound:** receivers accept 100,000–10,000,000 iterations in DQE1 and key frames and reject others before PBKDF2 (unchanged bound since v1, now tested against 10,000,001 and 4,294,967,295 in unit and browser tests).
- **Strength meter:** `src/strength.js`, original, no dependencies, offline: minimum-cost segmentation (dynamic programming) over common-password list (case/leet/reversed), word-like runs (~13 bits each), sequences, keyboard rows, repeats, years, separators, random characters. Output: bits, label (weak < 40 ≤ fair < 60 ≤ good < 80 ≤ strong), generic warnings that never quote the passphrase. `aria-live="polite"`; ~0.2 ms per call.
- **Numbers (this box):** Node calibration 111–130 ms → 7.2–8.0 M iterations; derive 600,000 = 73–74 ms vs 7.2 M = 871–889 ms. Headless Chrome 156: 7,900,000 iterations, prepare 1,250 ms, receiver early check 1,039 ms, standard prepare 155 ms. Old → new meter: `Summer2024!` 72 good → 22 weak, `Football1234567` 89 strong → 10 weak, `P@ssw0rd` 53 fair → 11 weak, five random words 200 → 62 good, 16 random characters 105 → 105 strong. Data: results/kdf_measure.json, results/kdf_browser.json.
- **Compatibility:** recorded pre-cycle-3 (100,000) and cycle-3 (600,000, key-check on and off, from 8949cb7) streams open; cycle-3 key-check works with calibrated counts; a calibrated payload opens with the old `deriveKey` code.
- **Tests:** unit 65/65, kdf browser 5/5 (new), browser 17/17, ux 17/17, a11y 0 serious/critical, compression 4/4, keycheck 5/5, lint 0 (41 files), 0 network requests. Drop trials and H.264 not rerun (codec and data packets unchanged).
- **Files:** src/strength.js (new), src/container.js, src/pages/{sender.app.js,sender.template.html,receiver.app.js}, sender.html, receiver.html, tools/build.mjs, tests/lib/load.cjs, tests/unit/kdf.test.mjs, tests/browser/kdf.mjs, tests/bench/kdf.mjs, tests/fixtures/{make-cycle3-streams.mjs,cycle3_streams.json}, package.json, results/*.json, README.md, CHANGELOG.md, docs/{PROTOCOL,THREAT_NOTE,TEST_CHECKLIST,ROADMAP,DEVELOPMENT_LOG}.md.
- **Fragile:** keep `CALIBRATION.cap` ≤ `MAX_ITERATIONS` (older receivers); keep `packet.js` ITER_MIN/ITER_MAX equal to container MIN/MAX.
- **Untested:** real phone/laptop cameras, derive time on phones (a count tuned on a fast laptop may take several seconds there), Safari, Firefox, screen readers.
- **Next:** cycle 5, fuzzing parseText / parseKeyFrame / ReceiverSession.

- **Commit:** `0d984d7869c55d6c74f91d2f2b86a27cb86f4a35` on `main` (pushed 8949cb7..0d984d7; this line added in a docs follow-up commit).

---

## 2026-11-01 — Cycle 5 of 12 (hourly routine): seeded fuzzing, three bugs fixed

- **Lock:** `.dev-state/cycle.lock` held by "routine cycle 5" from 07:11 EST, starting at 2f907a9 (clean, in sync with origin/main).
- **What:** tests/fuzz/fuzz.mjs, deterministic seeded fuzzer (no dependencies) for parseText, parseKeyFrame, ReceiverSession, session.open and mutated containers through real LT streams; oracles for exceptions, hangs (> 1 s), retained memory after GC, rejection reasons, round-trip of accepted frames, session counters and meta, bounded buffers, decoder efficiency under noise, exact file output, Dex_QR error codes. `npm run fuzz` / `fuzz-quick`, `make fuzz` / `fuzz-quick` (in `make all`).
- **Fixed:** (1) container.parseInner bounds: truncated DQF1 (also inside DQZ1) is BAD_FORMAT instead of a file that begins with header bytes; (2) DQE1 shorter than 36 + 16 bytes is BAD_FORMAT before PBKDF2 (was RangeError at 4–7 bytes, WRONG_PASSPHRASE otherwise); DataViews bounded to the payload; (3) lt.robustSolitonCdf cache is LRU, 16 entries (`CDF_CACHE_MAX`, `cdfCacheSize()`), was unbounded.
- **Numbers (100,000 cases, seed 1):** before 3 exceptions, 763 wrong results, 295 MB retained by 300 transfers (1,380 MB whole run); after 0 / 0 / 14 MB (17 MB). Seed 2 after: 0 findings, 12 MB. parseText/parseKeyFrame had no findings before. Time per 10k cases: parse 0.15 → 0.14 s, session scenario 134 → 131 s. Data: results/fuzz_before.json, fuzz_after.json, fuzz_after_seed2.json.
- **Compatibility:** no wire-format change; valid containers are always longer than the new minimums; drop trials 1,800/1,800 with byte-identical results files; legacy and cycle-3 fixtures still decode (unit tests).
- **Tests:** unit 70/70 (5 new, failing first), browser 17/17, ux 17/17, axe 0, compression 4/4, keycheck 5/5, kdf 5/5, lint 0, fuzz 0 findings.
- **Files touched:** src/container.js, src/lt.js, sender.html, receiver.html, tests/fuzz/fuzz.mjs (new), tests/unit/fuzz-regressions.test.mjs (new), package.json, Makefile, README.md, CHANGELOG.md, docs/{ROADMAP,DEVELOPMENT_LOG}.md, results/*.json.
- **Fragile:** keep `CDF_CACHE_MAX` ≥ the number of K values in use at once (sender + receiver + a pending switch); the fuzzer's `--root` loads only src/*.js listed in its SCRIPTS array.
- **Untested:** real cameras, Safari, Firefox, phones.
- **Next:** cycle 6, receiver-side PBKDF2 time estimate and slow-device warning.

- **Commit:** `51b0b42332b17a58cf7f0f1aac8d062de0ca5fc6` on `main` (pushed 2f907a9..51b0b42; this line added in a docs follow-up commit).

---

## 2026-11-01 — Cycle 6 of 12 (manual, owner request): ease of use, looks and animation

- **Lock:** `.dev-state/cycle.lock` taken 07:45 EST by "manual cycle 6" after cycle 5 released it; start 33025df, clean, in sync with origin/main. The owner asked ("Continue Dex qr focus on ease of use and how cool it looks/animation", "Start immediately after") so the planned PBKDF2-time warning moved to cycle 7.
- **What:** interface only, no protocol/codec/crypto change. Home page with Send / Receive; sender in three steps (choose file by drop, paste or browse; optional passphrase; one-press Start sending that prepares and plays, then Pause/Resume); settings in a collapsed Tuning section, IDs and hashes in Transfer details; progress ring around (never over) the code, live status line, receiver tips; phone scrolls to the code. Receiver: Scan → Receive → Save steps, big Start/Resume scanning, reticle lock-on, block map (src/pages/blockmap.js) with a ripple and check mark on completion, Save as the one action when done, drop images or a recording to decode. Visual system in CSS variables, dark default and light theme, Auto/Light/Dark and Motion toggles (src/pages/ui.js, localStorage where allowed), original SVG logo (src/pages/logo.svg), shared header generated in tools/build.mjs.
- **Numbers (headless Chrome, scripted):** presses to start sending 2 → 1; sender primary button top 1,064 → 495 px at 1280×800 and 1,126 → 493 px at 390×844; words in the sender panel 429 → 143; receiver primary button 44 → 56 px tall; axe states 12 → 38 (both themes), 0 violations.
- **Invariants kept:** QR drawing code and module-size formula unchanged; quiet zone checked pure white during play; decoration outside the canvas; reduced motion (system or toggle) removes all page animation; CSP unchanged; single-file builds; no network.
- **Tests (final build):** lint 0 (47 files), unit 70/70, browser 17/17, ux 17/17, look 16/16 (new, tests/browser/look.mjs), compression 4/4, keycheck 5/5, kdf 5/5, a11y 0 in 38 states, soak pass (sender 30.03 fps, heap flat; receiver heap flat, one stream after churn), drop trials re-rendered 1,800/1,800 with trial results identical to the committed files. 0 network requests.
- **Files:** src/pages/{common.css, sender.template.html, receiver.template.html, index.template.html, sender.app.js, receiver.app.js, ui.js (new), blockmap.js (new), logo.svg (new)}, tools/build.mjs, sender.html, receiver.html, index.html, tests/browser/{look.mjs, screens.mjs (new), a11y.mjs, run.mjs, ux.mjs, soak.mjs, kdf.mjs, keycheck.mjs, compression.mjs}, package.json, Makefile, results/*.json, docs/screenshots/*.png (new), README.md, CHANGELOG.md, docs/{ROADMAP,DEVELOPMENT_LOG}.md.
- **Fragile:** element IDs are the test contract (keep them); `details.opts` must stay the receiver's first `<details>` (compression.mjs clicks the first summary); the Tuning disclosure must be opened before tests fill its fields; blockmap's honesty note (rank share in ML mode) must stay true if the decoder changes.
- **Untested:** real cameras on phones and laptops, Safari, Firefox, screen readers, animation smoothness on slow phones, localStorage on file:// outside Chrome (falls back to page-only).
- **Next:** cycle 7, receiver-side PBKDF2 time estimate and slow-device warning; then live QR quality hints.

- **Commit:** `fbd7c74688d51f87060291099eb446c8b8cf28df` on `main` (pushed 33025df..fbd7c74; this line added in a docs follow-up commit).

---

## 2026-11-01 — Cycle 7 of 12 (routine, finished as resume of a dead run): live scan coaching, slow-device passphrase warning

- **Lock:** `.dev-state/cycle.lock` held for cycle 7; the routine's worker stopped about 10:01 EST with uncommitted work; resumed 11:06 EST, start 6c29dba (in sync with origin/main). Work reviewed and kept, nothing discarded.
- **What:** src/coach.js (new): `frameStats` (mean, contrast, clipping, sharpness ratio on a sparse grid) and `ScanCoach` (1.5 s window, 0.9 s hold for problems, hints: start, looking, nocode, blank, dark, bright, blurry, small, large, unread, foreign, repeats, steady, almost; announce at most every 4 s). Receiver: hint card under the camera view, amber reticle on warnings, polite live region `#coach-live`, `state.coach` / `state.coachLog` test hooks. container.estimateDerive + SLOW_DERIVE_MS (3 s): slow-device warning `#passslow` above the passphrase, estimate on the key line. scan.decodeImageData returns `location`.
- **Numbers (fake camera, synthetic frames, 1280/390):** dark, blank, blurry hints from none to 1.14–1.24 s; foreign hint 1.14–1.24 s (status line unchanged 0.52–0.62 s); Locked on 0.41–0.51 s; slow warning 0.38–0.44 s after the key frame (est. 17.2 s, simulated), none on this machine (1.1 s); 1 announcement per scene, 7.3 s apart while receiving; a11y states 38 → 50 (0 violations); unit 70 → 84.
- **Invariants kept:** QR drawing, module size, quiet zone untouched; hint outside the camera view, 48 px tall; reduced motion static; no flashing (0.4–0.5 Hz breathing dot only); offline, single file, 0 network requests; no dependency; protocol unchanged.
- **Tests:** lint 0, unit 84/84, coach 18/18 (new), look 16/16, ux 17/17, browser 17/17, compression 4/4, keycheck 5/5, kdf 5/5, a11y 0 in 50 states, soak pass (sender 30.02 fps flat heap; receiver 10 fps 2.3 → 2.4 MB), drop trials 1,800/1,800 identical, H.264 27/27, fuzz-quick 0.
- **Files:** src/coach.js (new), src/scan.js, src/container.js, src/pages/{receiver.app.js, receiver.template.html, common.css}, tools/build.mjs, sender.html, receiver.html, index.html, tests/unit/{coach,slowkdf}.test.mjs (new), tests/browser/coach.mjs (new), tests/lib/synthframe.cjs (new), tests/lib/load.cjs, tests/browser/a11y.mjs, Makefile, package.json, README.md, docs/{TEST_CHECKLIST,ROADMAP,DEVELOPMENT_LOG}.md, CHANGELOG.md, results/*.json, results/cycle7/*.png, docs/screenshots/receiver-coach-1280.png.
- **Fragile:** coach thresholds (`DQ.coach.THRESHOLDS`) are synthetic-frame guesses; IDs `coach`, `coach-text`, `coach-live`, `passslow` are the test contract; coach.mjs's slow-device range assumes the real derive here is about 1–3 s.
- **Untested:** real cameras on phones and laptops (no claim that real scanning was tested), screen readers, Safari, Firefox.
- **Next:** run docs/TEST_CHECKLIST.md on real devices and retune thresholds; then a sender-side "receiver tips" card and a reverse-channel ACK design.

- **Commit:** `f1238ac22eb5ca92c69500d911900dae49cd7398` on `main` (pushed 6c29dba..f1238ac; this line added in a docs follow-up commit).

---

## 2026-11-01 — Cycle 8 of 12 (routine run 12:10): sender "How to receive" card and finished state

- **Lock:** `.dev-state/cycle.lock` held by "routine cycle 8 (run 12:10)"; start 044bb59, clean, in sync with origin/main.
- **What:** src/pages/sender.template.html: `#howto` card (animated SVG, 3 steps) replaces the `.tips` chips; `#finish` card (`#finish-h`, `#finish-p`, `#finish-stats`, `#finish-stop`, `#finish-again`, `#finish-resume`), `#finish-say` polite region, `#stage-done` check in the stage, `#step3-body`. src/pages/sender.app.js: `state.need`, `state.finish` ("" | "likely" | "final"), `state.playMs`; `checkFinish`, `finishNow`, `leaveFinal`, `sendAnother`, `placeFinish` (control column above 860 px, under the code below). src/pages/common.css: howto/finish/stage-done styles, `.ring.reached`, keyframes hphone/hscan/hok/hcorner/hbeam/draw40/draw64/draw264.
- **Numbers:** presses from receiver-done to next file streaming 3 → 2; done signal none → card + green ring at the estimate; module size 8 px @1280, 3 px @390 unchanged; pagescan clean/moderate 40/40 both decoders both widths before and after, whole viewport 40/40 with 0 wrong; harsh zxing 34→35 (1280), 18→17 (390); soak 30.02 fps flat heap; trials 1,800/1,800 identical; axe 0 in 58 states.
- **Invariants kept:** QR drawing, quiet zone and module-size formula untouched; cards never overlap the stage (tested); reduced motion gives a still final picture (tested for the system setting and the Motion button); no flashing; offline, single file, 0 network requests; no dependency; protocol unchanged.
- **Tests:** lint 0, unit 84/84, look 25/25 (9 new), ux 17/17, browser 17/17, a11y 0 in 58 states, soak pass, drop trials identical. New: tests/browser/pagescan.mjs, tests/browser/sender-shots.mjs.
- **Fragile:** the finished card's position depends on the 860 px breakpoint and the control column's height at 1280×800 (it ends at 762 px of 800); a longer step-2 note would push it off screen (look test catches it). The IDs above are the test contract.
- **Untested:** real cameras, screen readers, Safari, Firefox. "Likely done" is an estimate; the sender cannot see the receiver.
- **Next:** reverse-channel ACK design (item 6).

- **Commit:** `19d358130500ea80e7206ae877eab6837dcb21ac` on `main` (pushed 044bb59..19d3581; this line added in a docs follow-up commit).

### Cycle 9 (2026-11-01, ~3:20 PM EST): reverse-channel Done confirmation
- **What:** receiver shows a static `DA` Done code after a verified rebuild; sender's optional Confirm with camera turns the estimate into a confirmed Done, stops the stream, releases the camera and celebrates (reduced-motion still).
- **Format:** `DA` + Base45([ver 1, kind 1, fileId 8 B, CRC-32]); last-4-bytes-CRC envelope for every version; unknown version or kind is "newer", never Done.
- **Numbers:** ack 36/36; Done code 10 px @1280 / 6 px @390 modules, 4-module quiet zone; stream module size unchanged; pagescan clean/moderate 40/40 before = after; harsh zxing 35→37 / 18→17 (noise); soak 30.00 / 30.02 fps flat heap (an earlier loaded-box run read 18.6 / 24.2); a11y 0 in 66 states; look 25/25; unit 90/90; lint 0.
- **Invariants kept:** stream QR drawing, quiet zone and module size untouched; decoration outside codes; offline, single file, 0 network requests; no dependency; protocol stream frames unchanged and backward compatible.
- **Untested:** real cameras, Safari, Firefox, screen readers. A Done code is a convenience, not proof; compare the SHA-256.
- **Next:** real-device checklist run, then coach threshold retune.

- **Commit:** `85e182a909c69085c990a2aa93fe2bcbda5d3d11` on `main` (this line added in a docs follow-up commit).
