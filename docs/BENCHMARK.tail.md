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
