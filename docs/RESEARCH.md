# Research notes

Sources were read on 2026-11-01. Licenses were checked through the GitHub API (`gh api repos/OWNER/REPO`) and the license files in each repository or npm package. Dex_QR copies no code from the transfer projects listed in section 3. Its code is original, and the only third-party code it contains is the three QR libraries in section 4.

## 1. QR codes: capacity and error correction

- QR Code is standardised as **ISO/IEC 18004** (ISO/IEC 18004:2015, as referenced by RFC 9285: [iso.org/standard/62021](https://www.iso.org/standard/62021.html)). Denso Wave, the inventor, publishes summary tables. It has waived its patent for standard-compliant QR codes. [QRcode.com: Standardization](https://www.qrcode.com/en/about/standards.html)
- **Versions 1–40:** a symbol is 21×21 modules at version 1 and grows by 4 modules per side up to 177×177 at version 40. [QRcode.com: Information capacity and versions](https://www.qrcode.com/en/about/version.html)
- **Maximum capacity** (version 40, EC level L): 7,089 numeric, **4,296 alphanumeric**, **2,953 bytes**, or 1,817 kanji characters. At version 40 the alphanumeric capacity is 3,391 (M), 2,420 (Q) and 1,852 (H). [QRcode.com: versions 31–40](https://www.qrcode.com/en/about/versionPage/versionPage31_40.html)
- **Error correction** uses Reed–Solomon. The levels restore about **L 7%, M 15%, Q 25% and H 30%** of codewords. [QRcode.com: Standardization](https://www.qrcode.com/en/about/standards.html)
- **Binary data in QR:** RFC 9285 notes that "even in Byte mode, a typical QR code reader tries to interpret a byte sequence as text encoded in UTF-8 or ISO/IEC 8859-1. Thus, QR codes cannot be used to encode arbitrary binary data directly." It defines **Base45**, which maps 2 bytes to 3 characters of the 45-character alphanumeric set. Alphanumeric mode packs 2 characters into 11 bits, so Base45 costs 16.5 bits per 16 bits of data, **3.1% overhead**. Base64 in byte mode costs 33%. [RFC 9285, The Base45 Data Encoding](https://www.rfc-editor.org/rfc/rfc9285.html)
- **Decision for Dex_QR:** packets are Base45 in a single alphanumeric segment. This sidesteps decoder charset guessing (zbar, jsQR, zxing-cpp and the browser BarcodeDetector all return text) at a cost of about 3% capacity. BBQr makes the same choice for the same reason (see below). The Base45 alphabet includes a space, which some readers might trim. The Dex_QR text always starts with the prefix `DQ`, and Base45 output never ends in a space (the last character encodes a value ≤ 32), so trimming cannot corrupt a packet. A unit test checks this.

## 2. Fountain codes

- **LT codes** (Luby, 2002) are the first practical rateless erasure codes. Each encoded symbol is the XOR of *d* randomly chosen source blocks, with *d* drawn from a degree distribution. The decoder can recover *k* blocks from any *k + O(√k · ln²(k/δ))* encoded symbols with probability 1 − δ, using a simple "peeling" (belief-propagation) process. The **robust soliton distribution** μ(d) = (ρ(d) + τ(d))/β, with R = c·ln(k/δ)·√k, is defined there. M. Luby, "LT Codes", *43rd IEEE FOCS*, 2002, [doi:10.1109/SFCS.2002.1181950](https://doi.org/10.1109/SFCS.2002.1181950) ([PDF](https://pages.cs.wisc.edu/~suman/courses/740/papers/luby02lt.pdf))
- **Raptor codes** (Shokrollahi, 2006) put a high-rate pre-code in front of a weakened LT code. This gives linear-time encoding and decoding, and recovery from k(1+ε) symbols. Systematic variants also exist. A. Shokrollahi, "Raptor Codes", *IEEE Trans. Inf. Theory* 52(6), June 2006, p. 2551 ff., [doi:10.1109/TIT.2006.874390](https://doi.org/10.1109/TIT.2006.874390)
- **RFC 5053** (Raptor) and **RFC 6330** (RaptorQ) are the IETF-standardised versions. RaptorQ is systematic, works over GF(256) as well as GF(2), and usually decodes from exactly K symbols, rarely needing slightly more. Its specification depends on large fixed tables (systematic indices and random-number tables) and a multi-phase inactivation decoder. [RFC 6330](https://www.rfc-editor.org/rfc/rfc6330.html), [RFC 5053](https://www.rfc-editor.org/rfc/rfc5053.html)
- **Decision for Dex_QR:** the task asked for an LT code with the robust soliton distribution, and Dex_QR uses one. The code is small and fully original, and anyone can re-implement it from docs/PROTOCOL.md. A Raptor-like benefit comes from the decoder rather than a pre-code. For K ≤ 3000, Dex_QR decodes by **incremental Gaussian elimination over GF(2)** (maximum-likelihood decoding), not peeling alone. That cut the measured reception overhead from 12–50% (peeling) to about 0.3–2% at K ≥ 200 (results/lt_sweep.json). Above K = 3000 it falls back to peeling plus a Gaussian-elimination finisher. RaptorQ would reach similar or lower overhead with less CPU, at much greater implementation complexity.

## 3. Existing open-source animated-QR transfer projects (studied, not copied)

| Project | What it does | License (as checked) |
|---|---|---|
| [divan/txqr](https://github.com/divan/txqr) | Go protocol and tools for "transfer via animated QR". Uses fountain codes (LT) for loss tolerance. Its author's blog posts benchmark QR size, fps and error correction against phone readers. | MIT |
| [sz3/libcimbar](https://github.com/sz3/libcimbar) | "Color icon matrix barcodes", a custom (non-QR) colour barcode. Its README claims about 850 kbit/s (~106 KB/s) from a monitor to a phone camera, using the `wirehair` fountain code and zstd. Shows how far past QR a custom symbology can go. | MPL-2.0 (the earlier proof of concept, [sz3/cimbar](https://github.com/sz3/cimbar), is MIT) |
| [BlockchainCommons Uniform Resources (UR)](https://github.com/BlockchainCommons/Research/blob/master/papers/bcr-2020-005-ur.md), reference library [bc-ur](https://github.com/BlockchainCommons/bc-ur) | Multipart UR for Bitcoin wallets. Sends the fragments in order first, then "fountain" parts that XOR pseudo-random mixes of fragments, plus a CRC-32 of the whole message in every part. | BSD-2-Clause-Patent |
| [coinkite/BBQr](https://github.com/coinkite/BBQr) | "Better Bitcoin QR". An 8-character header with a part count and index, and data in **QR alphanumeric mode** (hex, Base32 or zlib), recommending EC level L for screen-to-camera use. Plain sequential splitting with no fountain code. | Public domain (Unlicense) |

What Dex_QR takes from these, as ideas only:
- From TXQR: a rateless code means the receiver can start at any frame, and lost frames need no back channel.
- From UR: a whole-message checksum in every part, so the receiver can tell the parts belong together and verify the result.
- From BBQr: alphanumeric mode instead of byte mode.

Dex_QR differs in three ways. It uses a robust-soliton LT code with an ML (Gaussian-elimination) decoder. It has optional authenticated encryption. And it ships as single-file offline pages.

## 4. Libraries used (license-checked)

| Library | Used for | License | Where |
|---|---|---|---|
| [Nayuki QR Code generator](https://github.com/nayuki/QR-Code-generator) (TypeScript edition, commit `bcfe1b0`, compiled with tsc) | Making QR symbols (sender, tests) | MIT | `vendor/qrcodegen.js` |
| [jsQR 1.4.0](https://github.com/cozmo/jsQR) | Pure-JS QR reading (receiver option) | Apache-2.0 | `vendor/jsQR.js` |
| [zxing-wasm 3.1.6](https://github.com/Sec-ant/zxing-wasm), wrapping [zxing-cpp](https://github.com/zxing-cpp/zxing-cpp) | Default receiver decoder (WebAssembly, inlined) | MIT (zxing-wasm), Apache-2.0 (zxing-cpp) | `vendor/zxing-wasm-reader.js`, `vendor/zxing-reader-wasm.b64.js` |

Test-only tools, not shipped in the pages:
- zbar 0.23.x (LGPL-2.1, via conda-forge), called from Python through pyzbar (MIT)
- zxing-cpp Python bindings (Apache-2.0)
- Pillow (MIT-CMU)
- NumPy (BSD-3-Clause)
- FFmpeg (LGPL/GPL build from Debian)
- Playwright-core (Apache-2.0)

## 5. Key derivation choice

- **What the tool uses:** WebCrypto offers PBKDF2, HKDF and ECDH key derivation, but **no Argon2 or scrypt**. A memory-hard KDF would mean shipping a third-party WASM or JS implementation. Dex_QR therefore uses **PBKDF2-HMAC-SHA-256 with 600,000 iterations**, the OWASP Password Storage Cheat Sheet figure for PBKDF2-HMAC-SHA256. [OWASP Password Storage Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Password_Storage_Cheat_Sheet.html)
- **Why the passphrase still matters:** OWASP recommends Argon2id first. PBKDF2 is not memory-hard, so GPUs speed up guessing. The real protection is passphrase strength (see THREAT_NOTE.md).
