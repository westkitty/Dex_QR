# Dex_QR protocol, version 1

This note is detailed enough for an independent re-implementation. The reference code is `src/*.js`.

## 1. Overview

```
file ──► container (name, MIME, data) ──► [optional AES-256-GCM] ──► payload P (F bytes)
P ──► K = ceil(F / T) source blocks of T bytes (last block zero-padded)
     ──► LT encoder: packet(seed) = XOR of d blocks chosen by PRNG(seed, file ID)
     ──► 23-byte header + T-byte block + CRC-32 ──► Base45 ──► "DQ" + text ──► QR (alphanumeric mode)
```

The sender shows an endless stream of QR codes, one packet per frame, with seeds `s0, s0+1, …` (s0 is random). It never repeats a packet. The receiver can start at any frame and miss any frames. It decodes as soon as it holds enough independent packets, which in practice is K plus a few percent.

## 2. Payload

**Inner container** (all integers big-endian):

| bytes | field |
|---|---|
| 4 | magic `DQF1` |
| 2 | name length *n* (≤ 1024) |
| *n* | file name, UTF-8 |
| 1 | MIME length *m* (≤ 255) |
| *m* | MIME type, UTF-8 |
| rest | file data |

**Plain payload** = inner container.

**Encrypted payload**:

| bytes | field |
|---|---|
| 4 | magic `DQE1` |
| 4 | PBKDF2 iteration count *i* (sender default 600,000; receiver accepts 100,000–10,000,000) |
| 16 | salt (random) |
| 12 | AES-GCM IV (random) |
| rest | AES-256-GCM ciphertext of the inner container, with a 16-byte tag. The additional authenticated data is the first 24 bytes (magic, *i*, salt). |

The key is `PBKDF2(HMAC-SHA-256, UTF-8(passphrase), salt, i)` → 256-bit AES-GCM key, via WebCrypto `deriveKey`.

**Why PBKDF2 and not Argon2:** WebCrypto has no Argon2 or scrypt. Adding one would mean shipping a third-party WASM or JS KDF, and the receiver must work with nothing but the page. 600,000 iterations is the OWASP figure for PBKDF2-HMAC-SHA256. It takes about 0.3–1 s in a desktop browser and longer on phones (not measured on phones). PBKDF2 is not memory-hard, so the passphrase must be strong (see THREAT_NOTE.md). The UI shows a rough strength estimate and a warning.

**What is encrypted:** the file name, MIME type and contents. The payload is encrypted **before** fountain coding, so every packet carries fountain-coded ciphertext.

**What stays in the clear:**
- the packet header (version, the encrypted flag, file ID, K, T, F, seed, CRC)
- the KDF parameters (magic, iteration count, salt, IV), which are inside the coded payload but not secret

**File ID** = the first 8 bytes of SHA-256(payload). It serves both as the transfer identifier and as the whole-file checksum. In encrypted mode it is the hash of the ciphertext. That hash is fresh on every send because of the random salt and IV, so it does not reveal whether two transfers carry the same file.

## 3. LT code

- **Parameters:** K = ceil(F/T), with F ≥ 1 (an empty file still has the container header). T is set by the sender (UI presets 200–1400 bytes; anything 1–65535 is valid).
- **Robust soliton distribution** (Luby 2002):
  - R = c·ln(K/δ)·√K, pivot = clamp(floor(K/R), 1, K)
  - ρ(1) = 1/K, ρ(d) = 1/(d(d−1)) for d ≥ 2
  - τ(d) = R/(dK) for d < pivot, τ(pivot) = R·ln(R/δ)/K, and τ(d) = 0 above the pivot
  - μ(d) = (ρ(d)+τ(d))/Σ(ρ+τ)
  - K = 1 means degree 1.
- **Protocol constants** (version 1, chosen from the sweep in `results/lt_sweep.json`):
  - K ≤ 3000: **c = 0.1, δ = 0.05** (lowest overhead with the Gaussian-elimination decoder)
  - K > 3000: **c = 0.03, δ = 0.5** (best for the peeling decoder used there)
- **PRNG per packet:**
  - `fileKey = uint32 from fileId[0..3]` (big-endian)
  - `state = mix32(seed XOR mix32(fileKey))`, where `mix32` is the "lowbias32" integer hash: `x ^= x>>>16; x *= 0x7feb352d; x ^= x>>>15; x *= 0x846ca68b; x ^= x>>>16` (32-bit arithmetic)
  - The generator is mulberry32 from `state`. Each call does `a += 0x6D2B79F5; t = imul(a ^ a>>>15, 1|a); t = (t + imul(t ^ t>>>7, 61|t)) ^ t; return (t ^ t>>>14) >>> 0`.
- **Degree:** `u = (rng() + 0.5) / 2^32`. d is the smallest d with CDF(d) ≥ u.
- **Neighbours:** a partial Fisher–Yates shuffle over [0, K). For i in 0..d−1, pick `j = i + rng() mod (K−i)`, swap positions i and j in a virtual identity array, and output the value now at position i. Sorting the output does not change the XOR.
- **Encoded block** = XOR of the chosen source blocks.

## 4. Packet and QR framing

All integers are big-endian.

| offset | size | field |
|---|---|---|
| 0 | 1 | version = 1 |
| 1 | 1 | flags (bit 0 = encrypted payload) |
| 2 | 8 | file ID (SHA-256(payload)[0..8]) |
| 10 | 3 | K, the number of blocks |
| 13 | 2 | T, the block size |
| 15 | 4 | F, the payload length |
| 19 | 4 | seed |
| 23 | T | encoded block |
| 23+T | 4 | CRC-32 (IEEE) of bytes 0 .. 23+T−1 |

- **QR text** = `"DQ"` + Base45(packet), where Base45 is RFC 9285. The text is encoded as **one alphanumeric segment**, with the EC level chosen by the sender (default M) and the smallest version that fits.
- **Length:** a packet of T data bytes is `2 + 1.5·(27+T)` characters. Header and CRC cost 27 bytes per frame: 6.3% of a 400-byte block, 2.7% at 1000 bytes.
- **Receiver checks:** prefix, Base45 validity (strict, rejects overflow triplets), version, length = 27+T, CRC-32, and ceil(F/T) = K. The first valid packet locks the receiver to its file ID, K, T and F. Packets from any other transfer are counted and ignored. Duplicate seeds are ignored.

**Evaluation: Base45/alphanumeric vs raw byte mode.**
- *Raw byte mode* would save about 3%, but readers decode byte mode as text with charset guessing (RFC 9285 §1). The browser BarcodeDetector exposes only `rawValue` strings, and zbar applies charset conversion. Binary data would be corrupted or would need decoder-specific workarounds.
- *Base64 in byte mode* costs 33%.
- *Base45 in alphanumeric mode* is text that every tested decoder returns verbatim. zbar, zxing-cpp (native and WASM) and jsQR returned exactly the encoded string for 100% of clean frames in the tests.

## 5. Decoding

- **K ≤ 3000, maximum-likelihood decoding.** Each packet becomes a K-bit row (its neighbour set) plus its block. The row is reduced against the current pivot rows: XOR in the pivot row for its lowest set bit, and repeat. If the row ends up non-zero, it becomes a new pivot. If it ends up zero, it was linearly dependent and is dropped. When the rank reaches K, back-substitution, highest pivot first, yields every block. This is optimal: decoding succeeds as soon as the received packets span the space.
- **K > 3000, peeling with a finisher.**
  - Peeling: degree-1 packets resolve blocks, and resolved blocks are XORed out of the stored packets. Repeat.
  - Finisher: once at most 400 blocks remain unresolved and enough packets are buffered, Gaussian elimination on the residual system completes the decode.
- **Verification:**
  1. Truncate the result to F bytes and check `SHA-256(payload)[0..8] == file ID`. On failure, report **"checksum mismatch"** and save nothing.
  2. If the payload is encrypted, ask for the passphrase. A failed AES-GCM tag check reports **"wrong passphrase"**, and the user can retry without rescanning.
  3. Unwrap the container and offer the file for download, with the SHA-256 of the file shown for comparison with the sender page.

## 6. Rendering

- The QR code is drawn on a `<canvas>` with a 4-module quiet zone (ISO/IEC 18004), black on white, with integer pixels per module. "0" means fit to the screen.
- Frame rate is user-set (default 8 fps). Frames are switched on `requestAnimationFrame`, so each code stays up for at least one display refresh.
- **Density presets** (block size T → QR version at EC M, from `DQ.render.versionFor`): 200 B → v11, 300 B → v14, **400 B → v16 (default)**, 600 B → v20, 800 B → v23, 1000 B → v27, 1400 B → about v31.

## 7. Limits

- Files up to 32 MiB are accepted by the UI. In practice, a stream of tens of thousands of frames is not useful.
- K is a uint24, F a uint32 and T a uint16.
- The receiver holds the whole file in memory.
