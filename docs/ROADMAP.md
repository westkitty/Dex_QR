# Roadmap

## Done
- v1: LT fountain code, AES-GCM container, single-file sender and receiver pages, decoder test harness.
- Cycle 1: protocol v2 degree boost (lower overhead and a much shorter tail for K = 12–3000).
- Cycle 2: transparent compression (CompressionStream deflate-raw, container `DQZ1`, auto-skip below 2% gain, compress-then-encrypt, zip-bomb guard on the receiver). Text-like files need 2.7–14.8× fewer frames at the default settings; JPEG and random data unchanged.
- Cycle 3: early wrong-passphrase detection. Key-check frames (`DK`, 1 in 32, encrypted streams only) with a 2-byte HKDF key check value; mean wait for a wrong-passphrase verdict 31.6 s → 2.1 s (100 KB, no loss), +3% stream time, data packets unchanged, older receivers unaffected.
- Manual full pass (2026-11-01): receiver resource limits, switch to the transfer on screen, exact frame clock, camera error states, Reset confirmation, keyboard and full-screen fallback, accessibility (axe 0 violations), lifecycle leaks and a camera-restart race fixed; ux, a11y, soak and lint tooling.

## Next (rough priority)
0. **First:** run docs/TEST_CHECKLIST.md on a real phone and laptop; everything camera-related is still untested on hardware.
1. Throughput: denser frames once real-camera limits are known (an adaptive frame rate needs the reverse channel in item 6, since the sender cannot see the receiver); consider a Raptor-style precode for K > 3000, where peeling is still used.
2. Receiver robustness: multi-strategy scanning (binarization, contrast, inverted) only once real-camera results show frames the current decoders miss. Per-reason rejection counts are done. Resume across reloads was rejected for privacy (it stores file fragments); revisit only as an explicit opt-in.
3. UX: receiver block-progress map, live QR quality hints, a person testing with a screen reader, Safari and Firefox checks. (Keyboard, focus, live regions, contrast and targets are done.)
4. Multi-file and folder transfer (one archive container, compressed as a whole), streaming large files. Single-file compression is done (cycle 2).
5. Encryption: **next planned (cycle 4):** PBKDF2 iteration calibration (measure the device, aim for about 1 s) and a better strength estimate. Early wrong-passphrase detection is done (cycle 3).
6. Reverse channel: receiver shows an ACK QR the sender can scan.
7. Tests: visual-degradation simulation before decode, fuzzing of parseText and the session, offline PWA install. GitHub Pages would let phones that block file:// cameras use the receiver; it needs the owner's go-ahead to publish.
8. Docs: comparison with TXQR, BBQr, UR and Cimbar, with citations.

## Update 2026-11-01 (cycle 4)
- Done: PBKDF2 iteration calibration (about 1 s on the sender, 600,000–8,000,000, carried in the stream; receivers bound 100,000–10,000,000) and a pattern-aware passphrase strength meter (src/strength.js). Item 5's cycle-4 plan is complete.
- Next planned (cycle 5): fuzzing parseText, parseKeyFrame and ReceiverSession with random and mutated frames (item 7). Then: estimate the receiver's derive time from the stream's count and warn on slow devices.

## Update 2026-11-01 (cycle 5)
- Done: deterministic seeded fuzzing of parseText, parseKeyFrame, ReceiverSession and open (tests/fuzz/fuzz.mjs, `npm run fuzz`, quick run in `make all`). Found and fixed three bugs: truncated DQF1 containers accepted with header bytes as data, truncated DQE1 payloads throwing a RangeError or reported as a wrong passphrase, and an unbounded soliton-table cache (295 MB → 14 MB retained over 300 transfers). 0 findings in 200,000 cases afterwards. The fuzzing part of item 7 is done.
- Next planned (cycle 6): estimate the receiver's PBKDF2 time from the stream's iteration count (a short local probe when the first encrypted packet or key frame arrives) and warn before the user types a passphrase on a device where it will take several seconds. Chosen over the block-progress map because cycle 4's tuned counts (up to 8,000,000, measured on a laptop) can make a phone receiver wait with no explanation. Then: the receiver block-progress map (item 3).

## Update 2026-11-01 (cycle 6)
- Done: the interface pass the owner asked for (ease of use, looks, animation): home page with Send / Receive, stepped sender with drag-and-drop, paste and a one-press Start sending, Tuning disclosure, progress ring outside the code, receiver Scan → Receive → Save steps, reticle lock-on, block map with completion animation (item 3's block-progress map is done), dark and light themes with a toggle, reduce-motion toggle, original logo. Protocol unchanged.
- Next planned (cycle 7): the deferred receiver-side PBKDF2 time estimate (short local probe when the first encrypted packet or key frame arrives) and a slow-device warning before the passphrase is typed. Then: live QR quality hints on the receiver (distance, blur, glare) from decode failures, and a visual pass on the passphrase and error states.

## Update 2026-11-01 (cycle 7)
- Done: receiver-side PBKDF2 time estimate with a slow-device warning before the passphrase is typed (item 5), and live scan coaching on the receiver (item 3's "live QR quality hints"): dark, glare, plain view, blurry, too small, cut off, not reading, foreign code, repeats only, Locked on, Almost there; throttled polite announcements. Thresholds set on synthetic frames only.
- Next planned (cycle 8): sender-side polish for ease of use: an animated "how to scan" card beside the code (outside the code area, reduced-motion aware) and a clearer finished state on the sender; then a reverse-channel ACK design (item 6). Still first: run docs/TEST_CHECKLIST.md on a real phone and laptop and retune the coach thresholds from what real cameras produce.

## Update 2026-11-01 (cycle 8)
- Done: sender-side polish. An animated "How to receive" card under the code (6 s loop, transform and opacity only, a still final picture with reduced motion) replaces the tip chips; a finished state: at the frame estimate the ring turns green and a "should have it by now" card appears in view (control column on wide screens, under the code on phones) while the stream keeps playing; "Receiver done: stop" shows a summary and a check in place of the code; "Send another file" returns to step 1 and opens the picker (3 → 2 presses to the next stream). Module size and quiet zone unchanged; page-rendering scan test added (tests/browser/pagescan.mjs).
- Next planned (cycle 9): reverse-channel ACK design (item 6): the receiver shows a small static "done" QR (transfer ID + check) and the sender can optionally scan it with its own camera to turn "should have it" into "Done"; design the frame format with versioning, a fallback when the sender has no camera, and tests with synthetic frames. Still first: run docs/TEST_CHECKLIST.md on a real phone and laptop.
