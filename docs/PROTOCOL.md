# Dex_QR protocol, version 2

**Versioning.** Byte 0 of every packet is the protocol version. Senders write 2. Receivers accept 1 and 2 and lock onto the version of the first valid packet, so a v1 sender still works with a current receiver. v2 differs from v1 only in the LT degree rule (§3, "Degree boost"); the payload container, packet layout, Base45 text and QR framing are unchanged. A v1-only receiver rejects v2 packets with reason "version".

**Compression (added in cycle 2, 2026-11-01; protocol version byte still 2).** The sender may wrap the inner container in a compressed container `DQZ1` (§2) and, for unencrypted payloads only, sets flag bit 1 in every packet (§4). Receivers from before cycle 2 ignore that bit and would report "Not a Dex_QR file container" after the full scan, so a compressed stream needs a receiver from this release or later; any stream an older sender produced (v1 or v2, `DQF1` or `DQE1`) still decodes byte for byte (tested against recorded streams in `tests/fixtures/legacy_streams.json`). Senders can turn compression off, and they skip it automatically when it does not help, in which case the payload is exactly the pre-cycle-2 format.

**Key-check frames (added in cycle 3, 2026-11-01; protocol version byte still 2, data packets and payload unchanged).** Encrypted streams may interleave a small separate QR frame with the text prefix `DK` (§4a) carrying the KDF parameters and a 2-byte key check value, so a receiver can reject a wrong passphrase after one such frame instead of after the whole file. Receivers from before cycle 3 treat `DK` frames as unrelated QR codes and ignore them (they only cost about 3% more stream time), so the stream stays fully readable by them. Pre-cycle-3 encrypted streams have no key-check frames and open as before; the passphrase is then checked at the end. The DQE1 payload, its key derivation and the data packets are byte-for-byte unchanged (unit test: a cycle-3 payload decrypts with the pre-cycle-3 `deriveKey` code).

This note is detailed enough for an independent re-implementation. The reference code is `src/*.js`.

## 1. Overview

```
file ──► container (name, MIME, data) ──► [deflate if it saves ≥ 2%] ──► [optional AES-256-GCM] ──► payload P (F bytes)
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

**Compressed inner container** (cycle 2):

| bytes | field |
|---|---|
| 4 | magic `DQZ1` |
| 1 | algorithm: 1 = `deflate-raw` (RFC 1951), 2 = `gzip` (RFC 1952); anything else is rejected |
| 4 | *L*, the length of the uncompressed `DQF1` container (uint32) |
| rest | the `DQF1` container compressed with that algorithm |

- **Sender rule.** Compress the `DQF1` container with the browser's built-in `CompressionStream` (`deflate-raw`; `gzip` only where `deflate-raw` is missing, as in Chrome 80–102). Use the result only if `9 + compressed length ≤ 0.98 × L` (at least 2% saved); otherwise send `DQF1` unchanged. Already-compressed files (JPEG, PNG, ZIP, video) therefore go out exactly as before. If `CompressionStream` is missing, send `DQF1`. No third-party code is involved.
- **Receiver rule.** Refuse *L* above 32 MiB + 4 KiB (the payload limit of §4) before inflating anything (error `TOO_LARGE`). Inflate with `DecompressionStream`, counting output bytes, and abort as soon as the output exceeds *L* (error `TOO_LARGE`; measured: a 1 MB stream of deflated zeros that would expand to 1 GiB is stopped after 32 MiB in about 0.1 s, about 64 MB of memory, in Node). Output shorter than *L*, corrupt deflate data, an unknown algorithm byte, or anything but `DQF1` inside (no nesting) is `BAD_FORMAT`. Without `DecompressionStream` the receiver reports `NO_DECOMPRESSION` with instructions, and the receiver page warns at the first frame when flag bit 1 is set.

**Plain payload** = inner container (`DQF1` or `DQZ1`).

**Encrypted payload**:

| bytes | field |
|---|---|
| 4 | magic `DQE1` |
| 4 | PBKDF2 iteration count *i* (sender default 600,000; receiver accepts 100,000–10,000,000) |
| 16 | salt (random) |
| 12 | AES-GCM IV (random) |
| rest | AES-256-GCM ciphertext of the inner container (`DQF1` or `DQZ1`: compress-then-encrypt), with a 16-byte tag. The additional authenticated data is the first 24 bytes (magic, *i*, salt). |

The key is `PBKDF2(HMAC-SHA-256, UTF-8(passphrase), salt, i)` → 256-bit AES-GCM key, via WebCrypto `deriveKey`.

**Key check value (cycle 3).** `KCV = HKDF-SHA-256(IKM = the 32 PBKDF2 output bytes, salt = empty, info = UTF-8 "Dex_QR key check v1", L = 2)`. The AES key is the PBKDF2 output itself, exactly as before, so the KCV is a separate, domain-separated derivation and not a slice of the key. Implementations derive the 256 PBKDF2 bits once (`deriveBits`), import them as the AES-GCM key and as an HKDF key, and zero the raw bytes. 2 bytes is deliberate: a wrong passphrase passes the early check 1 time in 65,536 (AES-GCM still rejects it at the end), and an observer holding only a key-check frame cannot confirm a guess, only filter candidates (THREAT_NOTE.md).

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
- **Degree boost (v2 only):** let `extra = ceil(log2 K)` when 12 ≤ K ≤ 3000, otherwise 0 (and always 0 for v1). If `d + extra < K`, use `d + extra`; otherwise keep d. The neighbours are then drawn exactly as below with the new d. Reason: sparse soliton rows leave the GF(2) system rank-deficient for a while, which caused the v1 overhead tail. With about log2 K extra neighbours the rows behave like a dense random code and the Gaussian-elimination decoder finishes at about K + 1.6 packets. The rule never caps at K, because piling packets onto one fixed even degree keeps every row in the even-weight subspace, so rank K can never be reached (found at K = 3). Below K = 12 the boost was mixed in a 400-trial scan, so it is off there. Above 3000 the peeling decoder is used, which needs degree-1 packets, so it is off there too. Measured in `tests/unit/degree-boost.mjs` → `results/degree_boost.json`.
- **Neighbours:** a partial Fisher–Yates shuffle over [0, K). For i in 0..d−1, pick `j = i + rng() mod (K−i)`, swap positions i and j in a virtual identity array, and output the value now at position i. Sorting the output does not change the XOR.
- **Encoded block** = XOR of the chosen source blocks.

## 4. Packet and QR framing

All integers are big-endian.

| offset | size | field |
|---|---|---|
| 0 | 1 | version (2; receivers also accept 1) |
| 1 | 1 | flags (bit 0 = encrypted payload; bit 1 = unencrypted `DQZ1` payload, informational, never set together with bit 0; other bits are ignored) |
| 2 | 8 | file ID (SHA-256(payload)[0..8]) |
| 10 | 3 | K, the number of blocks |
| 13 | 2 | T, the block size |
| 15 | 4 | F, the payload length |
| 19 | 4 | seed |
| 23 | T | encoded block |
| 23+T | 4 | CRC-32 (IEEE) of bytes 0 .. 23+T−1 |

- **QR text** = `"DQ"` + Base45(packet), where Base45 is RFC 9285. The text is encoded as **one alphanumeric segment**, with the EC level chosen by the sender (default M) and the smallest version that fits.
- **Length:** a packet of T data bytes is `2 + 1.5·(27+T)` characters. Header and CRC cost 27 bytes per frame: 6.3% of a 400-byte block, 2.7% at 1000 bytes.
- **Receiver checks:** prefix, Base45 validity (strict, rejects overflow triplets), version, length = 27+T, CRC-32, and ceil(F/T) = K. The first valid packet locks the receiver to its protocol version, file ID, K, T and F. Packets from any other transfer are counted and ignored. Duplicate seeds are ignored.
- **Receiver resource limits** (added 2026-11-01; not a wire-format change): packets claiming K > 262,144 (2^18) or F > 32 MiB + 4 KiB are rejected with reason "limits" before any decoder state is allocated. Without this, one CRC-valid frame claiming K ≈ 16.7 million made the reference receiver allocate per-block state for 16.7 million blocks (measured: 5.9 s and 2.8 GB of heap in Node). The sender UI cannot produce such a stream (32 MiB maximum, T ≥ 200 → K ≤ 167,773), and `SenderSession.create` now refuses anything over the limits.
- **Switching transfers:** after the lock, packets from one other transfer are kept in a bounded buffer (4,096 distinct packets). When 8 or more of them arrive in a row with none from the locked transfer, the receiver page offers to switch; switching discards the locked transfer and replays the buffered packets. Nothing switches automatically, so a second code in view cannot hijack a transfer in progress.

## 4a. Key-check frame (cycle 3)

Only for encrypted transfers, and only if the sender leaves "Let the receiver check the passphrase early" on (the default). QR text = `"DK"` + Base45 of 36 bytes, big-endian:

| offset | size | field |
|---|---|---|
| 0 | 1 | key-frame version (1) |
| 1 | 1 | KDF id (1 = PBKDF2-HMAC-SHA-256 key with the HKDF KCV of §2) |
| 2 | 8 | file ID of the transfer it belongs to |
| 10 | 4 | PBKDF2 iterations (receiver accepts 100,000–10,000,000) |
| 14 | 16 | salt (the same salt as in the DQE1 header) |
| 30 | 2 | KCV |
| 32 | 4 | CRC-32 (IEEE) of bytes 0..31 |

- **Text** 56 characters, QR version 3 at EC M (data frames at 400 B are version 16).
- **Schedule.** The sender shows the key-check frame as frame 0 and every 32nd frame after (`SenderSession.KEY_EVERY = 32`); data packets keep their order and are only delayed. Cost: 1 frame in 32, measured +2.6% to +3.9% frames to the file (results/keycheck.json). No byte is added to any data packet or to the payload.
- **Receiver.** Checks prefix, Base45, length 36, CRC, version and KDF id, and the iteration bounds (else reason `key-<reason>`). Key frames are stored per file ID (at most 8 transfers), so one seen before the first data packet, or for a transfer you later switch to, still counts. Only the frame for the locked transfer is used. Two different key frames for the same file ID disable the early check for it (one is forged). The early check is advisory: at the end AES-GCM decides, and a cached key from the early check is reused only if the passphrase, salt and iterations equal the payload header's.

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
  2. If the payload is encrypted, ask for the passphrase (from the first packet on; with a key-check frame it is checked at once against the KCV, §4a). A failed early check or AES-GCM tag check reports **"wrong passphrase"**, and the user can retry without rescanning.
  3. Unwrap the container (inflating `DQZ1` under the limits in §2) and offer the file for download, with the SHA-256 of the file shown for comparison with the sender page.

## 6. Rendering

- The QR code is drawn on a `<canvas>` with a 4-module quiet zone (ISO/IEC 18004), black on white, with integer pixels per module. "0" means fit to the screen.
- Frame rate is user-set (1–30 fps, default 8). Frames are switched on `requestAnimationFrame`, so each code stays up for at least one display refresh. Frames are due on an absolute schedule (every 1000/fps ms), so the average rate matches the setting even when that interval is not a whole number of display refreshes; at 8 fps on a 60 Hz display, codes alternate between 7 and 8 refreshes. (Before 2026-11-01 each frame was rounded up to whole refreshes, so 8 fps actually ran at 7.5 fps and 25 fps at 20 fps.) After a stall such as a hidden tab, the schedule restarts rather than bursting to catch up.
- **Density presets** (block size T → QR version at EC M, from `DQ.render.versionFor`): 200 B → v11, 300 B → v14, **400 B → v16 (default)**, 600 B → v20, 800 B → v23, 1000 B → v27, 1400 B → about v31.

## 7. Limits

- Files up to 32 MiB are accepted by the UI. In practice, a stream of tens of thousands of frames is not useful.
- K is a uint24, F a uint32 and T a uint16.
- The receiver holds the whole file in memory. A compressed transfer may never expand beyond 32 MiB + 4 KiB.
