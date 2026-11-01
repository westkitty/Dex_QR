# Dex_QR

Dex_QR moves a file from one device to another as a stream of animated QR codes. It needs no network, no server, no pairing and no app install. The sender page shows an endless **LT fountain code** stream (robust soliton distribution). The receiver page scans it with the camera and rebuilds the file once it has enough independent frames. Any frames will do, in any order, starting anywhere in the stream. A passphrase optionally encrypts the file with AES-256-GCM (key from PBKDF2-SHA-256).

- **`sender.html`** and **`receiver.html`** are single self-contained files. Download them and open them from disk (`file://`).
- **No network at runtime:** each page has a Content-Security-Policy with `connect-src 'none'`, and the automated tests check that no request leaves `file:`, `data:` or `blob:`.
- **Original code** under the MIT license. The bundled QR libraries are license-checked (see [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)).

> **Untested:** real camera scanning on a phone or a laptop. Every automated test used rendered frames, H.264 video, or Chrome's fake camera fed from a video file. Please run [docs/TEST_CHECKLIST.md](docs/TEST_CHECKLIST.md) before relying on it.

## Use

1. **Sender** (the device with the file): open `sender.html`.
   - Pick the file. Optionally enter a passphrase; read the strength hint and warning.
   - Pick a density (bytes per QR, default 400), an error-correction level (default M) and a speed (default 8 fps).
   - Press **Prepare**, then **Play**. Full screen helps. The page shows the SHA-256 of the file, its block count K, the QR version and an estimated time.
2. **Receiver** (the device with the camera): open `receiver.html` and press **Start camera**.
   - Point it at the code. The bar shows decoded packets out of K.
   - When it reaches K, the file is checked (SHA-256 against the sender's ID, plus the AES-GCM tag if encrypted). If the transfer is encrypted, you are asked for the passphrase.
   - Press **Save**, then compare the SHA-256 with the sender page.
3. The receiver can also decode **image files or a video file** instead of the camera, which is handy for testing or for a screen recording.

**Error messages on the receiver:**
- *Checksum mismatch:* the rebuilt data does not match the sender's SHA-256. Nothing is saved.
- *Wrong passphrase:* AES-GCM authentication failed. Retype the passphrase; there is no need to rescan.

**Opening from `file://`:**
- Desktop Chrome, Edge and Firefox allow the camera on `file://` pages.
- Some mobile browsers do not. If yours refuses, serve the folder on localhost (`python3 -m http.server`) or use the GitHub Pages copy. The page still makes no network requests after it loads.

**Decoders in the receiver:**
- *auto* (default): the browser's own `BarcodeDetector` if it has one (usually Android Chrome and macOS browsers), otherwise zxing-cpp compiled to WebAssembly.
- *zxing-cpp (WebAssembly):* built in and inlined, so nothing is downloaded.
- *jsQR:* built in, pure JavaScript, and much weaker on noisy frames.

## How it works (short)

file → container (name, type, data) → optional AES-256-GCM → K blocks of T bytes → LT packets (each the XOR of d blocks; d from the robust soliton distribution, blocks chosen by a PRNG seeded from the packet seed and the file ID) → 23-byte header + block + CRC-32 → Base45 → QR code in alphanumeric mode.

The receiver decodes by incremental Gaussian elimination over GF(2) when K ≤ 3000, which is maximum-likelihood decoding. Above that it uses peeling plus a Gaussian-elimination finisher. The full specification is in [docs/PROTOCOL.md](docs/PROTOCOL.md).

## Results (details in [docs/RESULTS.md](docs/RESULTS.md) and [docs/BENCHMARK.md](docs/BENCHMARK.md))

- **Drop-rate trials:** 10 / 100 / 500 KiB at 10 / 30 / 50% frame drop, 100 trials each, from random start frames, using real decoder output. **All 900 succeeded with zbar and all 900 with zxing-cpp**, every one SHA-256-identical. Mean overhead was 1.11–1.14× K at 10 KiB, 1.01–1.02× at 100 KiB and 1.003–1.007× at 500 KiB. The worst single trial was 1.65×.
- **Truly end-to-end** (H.264 video → ffmpeg → zbar → decoder): 27 of 27 runs succeeded.
- **Headless Chrome 156:** 17 of 17 tests passed with 0 network requests, all from `file://`. They cover the sender page into zbar into the decoder (including encryption), the receiver page fed frames at 10/30/50% drop with zxing-wasm, jsQR and auto (500 KiB at 50% drop included), the camera path through Chrome's fake camera (`getUserMedia` with a Y4M of sender frames), wrong then right passphrases, and forged frames causing a checksum mismatch. See RESULTS.md.
- **Throughput** on synthetic camera-like frames (BENCHMARK.md): the default 400 B / EC M decoded 100% of moderate and harsh frames with the page's zxing-wasm, at about 7 ms per frame, for ≈ 3.1 KB/s at 8 fps. Dense settings (1000–1400 B) reach 10–20 KB/s on moderate frames but fail on harsh ones. Module size matters more than the EC level, so prefer L/M over Q/H.

## Honest limits

- **Real cameras are untested** (see above). Real-world throughput depends on the camera, the screen, lighting and steadiness.
- **Speed:** 400-byte frames at 8 fps carry about 3 KB/s. That is fine for keys, documents and small images, and slow for anything over a few MB. Tools with custom symbologies, such as libcimbar, are much faster than any QR-based approach.
- **Overhead on small files:** about 10–15% extra frames, with an occasional 1.5×.
- **Encryption** protects the contents and the file name, but not the fact of the transfer, its size or its timing. Anyone who records the screen can brute-force a weak passphrase offline. See [docs/THREAT_NOTE.md](docs/THREAT_NOTE.md).
- **Memory and size:** the whole file is held in memory, and the UI accepts up to 32 MiB.
- **One-way:** the sender never learns when the receiver is done, so stop it yourself.

## Reproducing the tests

Requirements:
- Node ≥ 20.
- Google Chrome (`CHROME=/path`, default `/usr/bin/google-chrome`).
- ffmpeg.
- Python 3 with `pyzbar pillow numpy zxing-cpp`.
- libzbar (`ZBAR_LIB=/dir/containing/libzbar.so`; on the build box it came from conda-forge `zbar`).

```
npm install            # playwright-core (dev only)
make build test        # build pages, unit tests
make trials video      # drop-rate trials and end-to-end video runs  (PY=..., ZBAR_LIB=...)
make browser bench     # headless browser tests, throughput benchmark
make report            # regenerate docs/RESULTS.md and docs/BENCHMARK.md
```

## Docs

- [Protocol](docs/PROTOCOL.md)
- [Research and sources](docs/RESEARCH.md)
- [Threat note](docs/THREAT_NOTE.md)
- [Camera test checklist](docs/TEST_CHECKLIST.md)
- [Results](docs/RESULTS.md)
- [Benchmark](docs/BENCHMARK.md)

## License

MIT for Dex_QR's own code. Bundled third-party components keep their MIT and Apache-2.0 licenses; see [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
