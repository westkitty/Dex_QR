# Throughput benchmark

`tests/bench/bench.mjs` covers block sizes 200–1400 bytes at EC levels L, M and Q. For each configuration it renders 60 frames, each with the QR code about 600 px wide and the largest whole number of pixels per module. Three versions of each frame are decoded:

- **clean:** the rendered PNG.
- **moderate:** a synthetic camera-like image. The code is 600 px wide on a 1280×720 frame, with screen-like levels 45/215, 4° rotation, a 1.2 px Gaussian blur, noise with σ = 8, and JPEG quality 75.
- **harsh:** the code is 360 px wide on 1280×720, with levels 60/200, 7° rotation, a 1.4 px blur, noise with σ = 10, and JPEG quality 60.

The degradations are **synthetic** (`tests/bench/degrade.py`) and only stand in for a camera. They are useful for ranking settings, not for predicting a particular phone.

Decoders:
- zbar 0.23.x and zxing-cpp, both native, run single-process so the time is per CPU core.
- The receiver page's two built-in engines run inside headless Chrome on the first 30 frames: **zxing-cpp compiled to WebAssembly** (the default when the browser has no `BarcodeDetector`) and **jsQR**.

**Goodput** is the file data the receiver ends up with, per second: fps × block size × per-frame decode success ÷ 1.02. The 1.02 is the fountain overhead measured for files of 100 KiB and up. The 23-byte header, the CRC and the Base45 expansion are not counted in the block size.

**Maximum fps:**
- *Decoder limit:* zbar decodes these frames in about 5–15 ms clean and about 30 ms degraded per core, so it can keep up with 30+ fps on one core. zxing-cpp is faster. Each frame in a file pipeline is a separate image, so no "max fps" limit applies there beyond CPU speed.
- *Real limit:* the camera, unmeasured here. Cameras capture 30 (sometimes 60) fps, exposures blend consecutive sender frames, and rolling shutters tear them. A sender rate around a third to a half of the camera rate is the usual safe zone. The receiver page also needs time per frame (see the tables). With jsQR on noisy frames, it falls to about 2–3 frames/s.

## Results

### Decode success rate per frame (60 frames per config; jsQR and zxing-wasm in-page on the first 30)

| Block | EC | QR ver. | Modules | zbar clean / moderate / harsh | zxing-cpp clean / mod. / harsh | page zxing-wasm clean / mod. / harsh | page jsQR clean / mod. / harsh |
|---|---|---|---|---|---|---|---|
| 200 | L | 10 | 57 | 100.0% / 100.0% / 91.7% | 100.0% / 100.0% / 100.0% | 100.0% / 100.0% / 100.0% | 100.0% / 100.0% / 100.0% |
| 400 | L | 14 | 73 | 100.0% / 98.3% / 5.0% | 100.0% / 100.0% / 100.0% | 100.0% / 100.0% / 100.0% | 100.0% / 100.0% / 86.7% |
| 600 | L | 18 | 89 | 100.0% / 100.0% / 0.0% | 100.0% / 100.0% / 96.7% | 100.0% / 100.0% / 93.3% | 100.0% / 100.0% / 3.3% |
| 800 | L | 20 | 97 | 100.0% / 100.0% / 0.0% | 100.0% / 100.0% / 63.3% | 100.0% / 100.0% / 63.3% | 100.0% / 96.7% / 0.0% |
| 1000 | L | 23 | 109 | 100.0% / 100.0% / 0.0% | 100.0% / 100.0% / 0.0% | 100.0% / 100.0% / 0.0% | 0.0% / 0.0% / 0.0% |
| 1400 | L | 28 | 129 | 100.0% / 88.3% / 0.0% | 100.0% / 100.0% / 0.0% | 100.0% / 100.0% / 0.0% | 100.0% / 6.7% / 0.0% |
| 200 | M | 11 | 61 | 100.0% / 100.0% / 88.3% | 100.0% / 100.0% / 100.0% | 100.0% / 100.0% / 100.0% | 100.0% / 100.0% / 100.0% |
| 400 | M | 16 | 81 | 100.0% / 100.0% / 0.0% | 100.0% / 100.0% / 100.0% | 100.0% / 100.0% / 100.0% | 100.0% / 100.0% / 76.7% |
| 600 | M | 20 | 97 | 100.0% / 100.0% / 0.0% | 100.0% / 100.0% / 95.0% | 100.0% / 100.0% / 90.0% | 100.0% / 96.7% / 0.0% |
| 800 | M | 23 | 109 | 100.0% / 98.3% / 0.0% | 100.0% / 100.0% / 0.0% | 100.0% / 100.0% / 0.0% | 100.0% / 100.0% / 0.0% |
| 1000 | M | 27 | 125 | 100.0% / 90.0% / 0.0% | 100.0% / 100.0% / 0.0% | 100.0% / 100.0% / 0.0% | 100.0% / 0.0% / 0.0% |
| 1400 | M | 32 | 145 | 100.0% / 85.0% / 0.0% | 100.0% / 100.0% / 0.0% | 100.0% / 100.0% / 0.0% | 100.0% / 0.0% / 0.0% |
| 200 | Q | 13 | 69 | 100.0% / 100.0% / 90.0% | 100.0% / 100.0% / 100.0% | 100.0% / 100.0% / 100.0% | 100.0% / 100.0% / 96.7% |
| 400 | Q | 19 | 93 | 100.0% / 100.0% / 0.0% | 100.0% / 100.0% / 93.3% | 100.0% / 100.0% / 93.3% | 100.0% / 100.0% / 0.0% |
| 600 | Q | 24 | 113 | 100.0% / 100.0% / 0.0% | 100.0% / 100.0% / 0.0% | 100.0% / 100.0% / 0.0% | 100.0% / 100.0% / 0.0% |
| 800 | Q | 28 | 129 | 100.0% / 91.7% / 0.0% | 100.0% / 100.0% / 0.0% | 100.0% / 100.0% / 0.0% | 100.0% / 6.7% / 0.0% |
| 1000 | Q | 32 | 145 | 100.0% / 80.0% / 0.0% | 100.0% / 100.0% / 0.0% | 100.0% / 100.0% / 0.0% | 100.0% / 0.0% / 0.0% |
| 1400 | Q | 38 | 169 | 100.0% / 31.7% / 0.0% | 100.0% / 100.0% / 0.0% | 100.0% / 100.0% / 0.0% | 100.0% / 0.0% / 0.0% |

### Decode time per frame (ms, one CPU core of the test box)

| Block | EC | zbar clean / mod. / harsh | zxing-cpp | page zxing-wasm | page jsQR | QR encode (sender) |
|---|---|---|---|---|---|---|
| 200 | L | 5.0 / 31.4 / 30.4 | 2.9 / 8.0 / 8.4 | 2.7 / 6.4 / 6.7 | 19.4 / 412.7 / 493.0 | 2.37 |
| 400 | L | 7.2 / 33.8 / 31.5 | 2.0 / 8.8 / 8.9 | 2.0 / 6.3 / 6.7 | 18.5 / 413.7 / 493.0 | 3.73 |
| 600 | L | 10.3 / 30.5 / 31.0 | 2.3 / 8.8 / 9.0 | 2.4 / 7.0 / 7.3 | 23.7 / 440.5 / 511.8 | 5.56 |
| 800 | L | 15.4 / 32.1 / 30.6 | 2.1 / 8.4 / 8.6 | 2.0 / 6.4 / 8.8 | 20.6 / 422.5 / 510.9 | 5.94 |
| 1000 | L | 23.8 / 32.1 / 31.5 | 2.8 / 9.0 / 10.3 | 2.7 / 6.5 / 10.6 | 71.3 / 443.6 / 460.2 | 7.29 |
| 1400 | L | 11.4 / 30.7 / 28.1 | 3.0 / 9.2 / 8.3 | 2.5 / 6.8 / 9.6 | 31.5 / 405.0 / 455.9 | 10.4 |
| 200 | M | 4.7 / 32.6 / 30.2 | 1.6 / 8.0 / 8.4 | 2.6 / 6.4 / 7.0 | 15.8 / 405.8 / 496.7 | 2.57 |
| 400 | M | 9.6 / 32.7 / 31.0 | 1.8 / 8.6 / 8.7 | 1.9 / 6.4 / 6.8 | 19.6 / 431.2 / 511.9 | 4.52 |
| 600 | M | 11.8 / 30.7 / 31.3 | 2.3 / 8.9 / 9.1 | 2.1 / 6.7 / 7.6 | 21.2 / 442.5 / 544.8 | 5.8 |
| 800 | M | 19.8 / 30.7 / 29.2 | 2.7 / 8.7 / 8.9 | 3.2 / 6.6 / 10.8 | 30.1 / 472.9 / 555.6 | 7.42 |
| 1000 | M | 12.8 / 33.9 / 29.6 | 2.9 / 9.9 / 8.4 | 2.3 / 6.9 / 9.7 | 28.5 / 498.4 / 564.5 | 10.79 |
| 1400 | M | 16.1 / 30.8 / 28.4 | 1.9 / 10.4 / 8.1 | 2.2 / 7.1 / 9.6 | 31.1 / 506.7 / 559.7 | 12.65 |
| 200 | Q | 5.5 / 31.2 / 30.8 | 1.4 / 8.2 / 8.6 | 2.7 / 6.5 / 6.8 | 20.3 / 412.4 / 448.5 | 3.22 |
| 400 | Q | 14.3 / 32.8 / 31.9 | 2.0 / 8.7 / 9.0 | 1.8 / 6.5 / 7.2 | 17.9 / 404.8 / 421.0 | 5.43 |
| 600 | Q | 8.0 / 31.1 / 28.7 | 1.6 / 8.9 / 8.8 | 1.9 / 7.1 / 11.4 | 20.6 / 405.7 / 449.7 | 7.74 |
| 800 | Q | 13.7 / 31.1 / 28.7 | 3.0 / 9.1 / 8.2 | 2.7 / 7.0 / 9.6 | 26.8 / 382.7 / 426.2 | 10.89 |
| 1000 | Q | 15.7 / 30.4 / 28.0 | 2.0 / 10.1 / 8.1 | 2.5 / 7.3 / 9.6 | 28.3 / 430.9 / 437.5 | 12.82 |
| 1400 | Q | 30.1 / 31.1 / 29.2 | 3.5 / 9.4 / 8.3 | 3.2 / 7.5 / 9.6 | 39.1 / 422.1 / 432.8 | 17.16 |

### Goodput in file bytes per second (after 1.02× fountain overhead; header and Base45 costs are already outside the block size)

Goodput = fps × block size × per-frame success ÷ 1.02. For the receiver page engines, the frame rate is also capped at what the page can decode (1000 ÷ ms per frame). Computed by `tests/bench/goodput.mjs` from the measured rates and times above.

| Block | EC | QR ver. | 10 fps moderate: zbar / page zxing-wasm / page jsQR | 10 fps harsh: zbar / page zxing-wasm / page jsQR | 15 fps moderate: zbar / page zxing-wasm | 20 fps moderate: page zxing-wasm |
|---|---|---|---|---|---|---|
| 200 | L | 10 | 1961 / 1961 / 475 | 1798 / 1961 / 398 | 2941 / 2941 | 3922 |
| 400 | L | 14 | 3855 / 3922 / 948 | 196 / 3922 / 689 | 5782 / 5882 | 7843 |
| 600 | L | 18 | 5882 / 5882 / 1335 | 0 / 5490 / 38 | 8824 / 8824 | 11765 |
| 800 | L | 20 | 7843 / 7843 / 1794 | 0 / 4967 / 0 | 11765 / 11765 | 15686 |
| 1000 | L | 23 | 9804 / 9804 / 0 | 0 / 0 / 0 | 14706 / 14706 | 19608 |
| 1400 | L | 28 | 12120 / 13725 / 226 | 0 / 0 / 0 | 18179 / 20588 | 27451 |
| 200 | M | 11 | 1961 / 1961 / 483 | 1731 / 1961 / 395 | 2941 / 2941 | 3922 |
| 400 | M | 16 | 3922 / 3922 / 909 | 0 / 3922 / 587 | 5882 / 5882 | 7843 |
| 600 | M | 20 | 5882 / 5882 / 1285 | 0 / 5294 / 0 | 8824 / 8824 | 11765 |
| 800 | M | 23 | 7710 / 7843 / 1659 | 0 / 0 / 0 | 11565 / 11765 | 15686 |
| 1000 | M | 27 | 8824 / 9804 / 0 | 0 / 0 / 0 | 13235 / 14706 | 19608 |
| 1400 | M | 32 | 11667 / 13725 / 0 | 0 / 0 / 0 | 17500 / 20588 | 27451 |
| 200 | Q | 13 | 1961 / 1961 / 475 | 1765 / 1961 / 423 | 2941 / 2941 | 3922 |
| 400 | Q | 19 | 3922 / 3922 / 969 | 0 / 3660 / 0 | 5882 / 5882 | 7843 |
| 600 | Q | 24 | 5882 / 5882 / 1450 | 0 / 0 / 0 | 8824 / 8824 | 11765 |
| 800 | Q | 28 | 7192 / 7843 / 137 | 0 / 0 / 0 | 10788 / 11765 | 15686 |
| 1000 | Q | 32 | 7843 / 9804 / 0 | 0 / 0 / 0 | 11765 / 14706 | 19608 |
| 1400 | Q | 38 | 4351 / 13725 / 0 | 0 / 0 / 0 | 6526 / 20588 | 27451 |

## Recommended settings

These come from the synthetic degradations above, not from phone cameras, which were **not tested**. Use them as a starting point.

| Situation | Block size | EC | Sender fps | Expected goodput* | Why |
|---|---|---|---|---|---|
| **Default (shipped)** | 400 B | M | 8 | ≈ 3.1 KB/s | Version 16 with about 6.7 px/module at 600 px. The page's zxing-wasm decoded 100% of moderate *and* harsh frames in about 7 ms each. Leaves a wide margin. |
| Good light, steady phone, close range | 800 B (L) or 600 B (M) | L / M | 10 | ≈ 6–8 KB/s | 100% on moderate frames. Harsh frames still 63% (800 L) and 90% (600 M), which the fountain code absorbs. |
| Best case (screen fills camera view) | 1000–1400 B | L / M | 10–15 | ≈ 10–20 KB/s | 100% on moderate frames with zxing (native or wasm), but **0% on harsh**. Only works when the code is large in the camera image. |
| Difficult (far, shaky, glare, old phone) | 200 B | any | 6–10 | ≈ 1.2–2 KB/s | The only density that survived harsh frames with every decoder (zbar 88–92%, zxing 100%, jsQR 97–100%). |
| Receiver forced to jsQR | 200–400 B | M | ≤ 3 | ≈ 0.5–1 KB/s | jsQR needs its blur retry on noisy frames, which costs about 400 ms per frame (≈ 2.4 frames/s). It fails at 1000 B and up even on moderate frames. |

\*Goodput = fps × block size × per-frame success ÷ 1.02, assuming the receiver keeps up. On a real camera, exposure blending and rolling shutter will lose some frames. The fountain code tolerates loss, so the cost is time, not failure. At 50% loss, goodput halves.

Findings behind the table:

1. **Module size matters more than the EC level.** At a fixed block size, a higher EC level needs a bigger QR version and so smaller modules. On harsh frames, 600 B at **L** (v18) decoded 93–97% while 600 B at **Q** (v24) decoded 0%. Use L or M; Q and H only help with partial occlusion such as a glare spot, which this benchmark does not model.
2. **zxing-cpp beats zbar on degraded frames.** At 400 B on harsh frames, zbar decoded 0–5% while zxing-cpp and zxing-wasm decoded 93–100%. That is why the receiver page's default engine, when no native `BarcodeDetector` exists, is zxing-wasm and not jsQR.
3. **Sender fps vs. camera fps.** The page decodes a frame in about 7 ms, so the decoder is not the limit. The camera is. For a 30 fps camera, keep the sender at **≤ 10 fps** (one third of the camera rate) so each QR is held for at least about 3 camera frames. 15 fps and up is likely to show blended or torn frames. This is unmeasured.
4. **Encoding cost.** The sender spends 2–17 ms per frame on QR encoding, depending on version, so 30 fps is achievable on the sending side.
5. **Fountain overhead.** With protocol v2, files of 100 KiB and up need ≈ 1.001–1.007× K packets, so goodput ≈ raw frame throughput. Small files (≈ 26 blocks) need ≈ 7–8% extra packets (worst trial 1.31×), as shown in RESULTS.md. (Protocol v1 measured 1.01–1.02× and 10–15%; the goodput table above still divides by the conservative overhead stated in its heading.)
