# Roadmap

## Done
- v1: LT fountain code, AES-GCM container, single-file sender and receiver pages, decoder test harness.
- Cycle 1: protocol v2 degree boost (lower overhead and a much shorter tail for K = 12–3000).

## Next (rough priority)
1. Throughput: denser frames and an adaptive frame rate on the sender; consider a Raptor-style precode for K > 3000, where peeling is still used.
2. Receiver robustness: multi-strategy scanning (binarization, contrast, inverted), duplicate and corrupt-frame handling stats, resume from saved partial state.
3. UX: receiver block-progress map, live QR quality hints, sender speed auto-tuning, accessibility, keyboard, dark and light themes.
4. Multi-file and folder transfer with CompressionStream, streaming large files.
5. Encryption: early wrong-passphrase detection (key check value), PBKDF2 iteration calibration, strength meter.
6. Reverse channel: receiver shows an ACK QR the sender can scan.
7. Tests: visual-degradation simulation before decode, fuzzing, offline PWA install, GitHub Pages if safe.
8. Docs: comparison with TXQR, BBQr, UR and Cimbar, with citations.
