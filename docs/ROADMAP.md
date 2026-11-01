# Roadmap

## Done
- v1: LT fountain code, AES-GCM container, single-file sender and receiver pages, decoder test harness.
- Cycle 1: protocol v2 degree boost (lower overhead and a much shorter tail for K = 12–3000).
- Cycle 2: transparent compression (CompressionStream deflate-raw, container `DQZ1`, auto-skip below 2% gain, compress-then-encrypt, zip-bomb guard on the receiver). Text-like files need 2.7–14.8× fewer frames at the default settings; JPEG and random data unchanged.
- Manual full pass (2026-11-01): receiver resource limits, switch to the transfer on screen, exact frame clock, camera error states, Reset confirmation, keyboard and full-screen fallback, accessibility (axe 0 violations), lifecycle leaks and a camera-restart race fixed; ux, a11y, soak and lint tooling.

## Next (rough priority)
0. **First:** run docs/TEST_CHECKLIST.md on a real phone and laptop; everything camera-related is still untested on hardware.
1. Throughput: denser frames once real-camera limits are known (an adaptive frame rate needs the reverse channel in item 6, since the sender cannot see the receiver); consider a Raptor-style precode for K > 3000, where peeling is still used.
2. Receiver robustness: multi-strategy scanning (binarization, contrast, inverted) only once real-camera results show frames the current decoders miss. Per-reason rejection counts are done. Resume across reloads was rejected for privacy (it stores file fragments); revisit only as an explicit opt-in.
3. UX: receiver block-progress map, live QR quality hints, a person testing with a screen reader, Safari and Firefox checks. (Keyboard, focus, live regions, contrast and targets are done.)
4. Multi-file and folder transfer (one archive container, compressed as a whole), streaming large files. Single-file compression is done (cycle 2).
5. Encryption: **next planned (cycle 3):** early wrong-passphrase detection (key check value); then PBKDF2 iteration calibration and a better strength meter.
6. Reverse channel: receiver shows an ACK QR the sender can scan.
7. Tests: visual-degradation simulation before decode, fuzzing of parseText and the session, offline PWA install. GitHub Pages would let phones that block file:// cameras use the receiver; it needs the owner's go-ahead to publish.
8. Docs: comparison with TXQR, BBQr, UR and Cimbar, with citations.
