/* Dex_QR receiver page logic. Original code, MIT License. */
(function () {
  "use strict";
  const DQ = window.DexQR;
  const $ = (id) => document.getElementById(id);
  const MAX_SIDE = 1080;                         // downscale large camera frames before decoding
  const state = { session: new DQ.ReceiverSession(), stream: null, running: false, frames: 0, detector: null, decoderName: "", result: null, error: null, phase: "idle", opened: false };
  window.__dexqrReceiver = state;                 // read-only hook for automated tests

  function msg(text, cls) { const m = $("msg"); m.textContent = text || ""; m.className = "msg" + (text ? " show " + cls : ""); }
  function setPhase(p) { state.phase = p; $("r-status").textContent = p; }

  // zxing-cpp compiled to WebAssembly (zxing-wasm), inlined as base64: no file or network fetch.
  let zxingReady = null;
  function loadZXing() {
    if (!zxingReady) {
      const b64 = window.DEXQR_ZXING_WASM_B64, bin = atob(b64), bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      zxingReady = window.ZXingWASM.prepareZXingModule({ overrides: { wasmBinary: bytes.buffer }, fireImmediately: true });
    }
    return zxingReady;
  }
  const ZX_OPTS = { formats: ["QRCode"], tryHarder: true, maxNumberOfSymbols: 1 };

  async function pickDecoder() {
    const want = $("dec").value;
    state.detector = null; state.engine = null;
    if ((want === "auto" || want === "native") && "BarcodeDetector" in window) {
      try {
        const fmts = await window.BarcodeDetector.getSupportedFormats();
        if (fmts.includes("qr_code")) { state.detector = new window.BarcodeDetector({ formats: ["qr_code"] }); state.engine = "native"; state.decoderName = "BarcodeDetector (browser built-in)"; return; }
      } catch (e) { /* fall through */ }
    }
    if (want === "native") throw new Error("BarcodeDetector with QR support is not available in this browser.");
    if (want === "jsqr") { state.engine = "jsqr"; state.decoderName = "jsQR"; return; }
    await loadZXing();
    state.engine = "zxing"; state.decoderName = "zxing-cpp (WebAssembly)";
  }

  /* Decode RGBA ImageData with the chosen engine (also used by the automated benchmark). */
  async function decodeImageData(img, engine) {
    if (engine === "jsqr") return DQ.scan.decodeImageData(img.data, img.width, img.height, window.jsQR).texts;
    await loadZXing();
    const res = await window.ZXingWASM.readBarcodes(img, ZX_OPTS);
    return res.filter((r) => r.isValid).map((r) => r.text);
  }
  state.decodeImageData = decodeImageData;

  const canvas = $("work");
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  async function decodeSource(src, w, h) {
    if (state.engine === "native") {
      const codes = await state.detector.detect(src);
      return codes.map((c) => c.rawValue);
    }
    const s = Math.min(1, MAX_SIDE / Math.max(w, h));
    const cw = Math.max(1, Math.round(w * s)), ch = Math.max(1, Math.round(h * s));
    if (canvas.width !== cw || canvas.height !== ch) { canvas.width = cw; canvas.height = ch; }
    ctx.drawImage(src, 0, 0, cw, ch);
    return decodeImageData(ctx.getImageData(0, 0, cw, ch), state.engine);
  }

  function updateStats() {
    const s = state.session, p = s.progress();
    state.frames = s.stats.frames;
    $("r-frames").textContent = `${s.stats.frames} scanned, ${s.stats.qrTexts} QR read`;
    $("r-dec").textContent = state.decoderName || "–";
    if (!s.meta) return;
    $("r-id").textContent = s.meta.fileIdHex;
    $("r-enc").textContent = s.meta.encrypted ? "yes" : "no";
    const d = s.decoder, have = d.progressCount;
    $("r-prog").textContent = `${have} / ${p.K} (${((100 * have) / p.K).toFixed(1)}%), ${(s.meta.length).toLocaleString()} bytes in transfer`;
    $("r-pk").textContent = `${p.received} unique, ${s.stats.duplicates} duplicate, ${s.stats.rejected} rejected, ${s.stats.otherFile} from other transfers`;
    $("bar").style.width = ((100 * have) / p.K).toFixed(1) + "%";
  }

  function safeName(n) { n = String(n || "received.bin").replace(/[\\/\u0000-\u001f\u007f:*?"<>|]+/g, "_").replace(/^\.+/, "").slice(0, 200); return n || "received.bin"; }

  async function tryOpen() {
    const pass = $("pass").value || undefined;
    setPhase(pass ? "decrypting" : "verifying");
    if (pass) msg("Deriving key (PBKDF2) and decrypting…", "warn");
    try {
      const out = await state.session.open(pass);
      const hexs = Array.from(out.sha256, (b) => b.toString(16).padStart(2, "0")).join("");
      // Display SHA-256 of the received file content (what the sender page shows), not of the transfer payload.
      const fileSha = Array.from(await DQ.container.sha256(out.data), (b) => b.toString(16).padStart(2, "0")).join("");
      const blob = new Blob([out.data], { type: out.mime || "application/octet-stream" });
      const url = URL.createObjectURL(blob);
      const name = safeName(out.name);
      $("result").innerHTML = "";
      const a = document.createElement("a"); a.className = "dl"; a.href = url; a.download = name; a.id = "download"; a.textContent = `Save “${name}” (${out.data.length.toLocaleString()} bytes)`;
      const p = document.createElement("div"); p.className = "note"; p.textContent = `SHA-256 of file: ${fileSha}. Compare it with the sender page. Transfer checksum verified (${hexs.slice(0, 16)}…)${out.encrypted ? "; AES-GCM authentication passed" : ""}.`;
      $("result").append(a, p);
      $("passbox").style.display = "none";
      state.result = { name, size: out.data.length, sha256: fileSha, encrypted: out.encrypted };
      state.error = null; state.opened = true;
      setPhase("done");
      msg("Transfer complete. The file is verified and ready to save.", "ok");
    } catch (e) {
      state.error = e.code || e.message;
      if (e.code === "NEED_PASSPHRASE") { $("passbox").style.display = ""; setPhase("needs passphrase"); msg("All data received. This transfer is encrypted: enter the passphrase.", "warn"); $("pass").focus(); }
      else if (e.code === "WRONG_PASSPHRASE") { $("passbox").style.display = ""; setPhase("wrong passphrase"); msg("Wrong passphrase (AES-GCM authentication failed). Try again; no need to rescan.", "err"); }
      else if (e.code === "CHECKSUM_MISMATCH") { setPhase("checksum mismatch"); msg("Checksum mismatch: the reconstructed data does not match the sender's SHA-256. The file was not saved. Press Reset and scan again.", "err"); }
      else { setPhase("error"); msg("Could not open the transfer: " + e.message, "err"); }
    }
  }

  async function onDecoded(texts) {
    const s = state.session;
    s.stats.frames++;
    const wasDone = s.done;
    for (const t of texts) s.addText(t);
    updateStats();
    if (s.done && !wasDone) { stopCamera(); setPhase("verifying"); await tryOpen(); }
    else if (s.meta && !s.done) setPhase("receiving");
  }

  async function scanVideoFrame() {
    const v = $("video");
    if (!state.running || state.session.done) return;
    if (v.readyState >= 2 && v.videoWidth) {
      try { await onDecoded(await decodeSource(v, v.videoWidth, v.videoHeight)); }
      catch (e) { /* a bad frame: ignore */ }
    }
    if (!state.running || state.session.done) return;
    if (v.requestVideoFrameCallback) v.requestVideoFrameCallback(() => scanVideoFrame());
    else requestAnimationFrame(() => scanVideoFrame());
  }

  async function startCamera() {
    msg("", "");
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) { msg("Camera API not available. Pages opened from file:// get camera access in Chrome/Edge/Firefox; some browsers need http://localhost or https.", "err"); return; }
    try {
      await pickDecoder();
      const devId = $("cam").value;
      const constraints = { audio: false, video: devId ? { deviceId: { exact: devId }, width: { ideal: 1280 }, height: { ideal: 720 } } : { facingMode: { ideal: "environment" }, width: { ideal: 1280 }, height: { ideal: 720 } } };
      state.stream = await navigator.mediaDevices.getUserMedia(constraints);
      const v = $("video"); v.srcObject = state.stream; await v.play();
      state.running = true; $("start").disabled = true; $("stop").disabled = false;
      setPhase(state.session.meta ? "receiving" : "scanning");
      listCameras();
      scanVideoFrame();
    } catch (e) { msg("Camera error: " + e.message, "err"); }
  }

  function stopCamera() {
    state.running = false;
    if (state.stream) { state.stream.getTracks().forEach((t) => t.stop()); state.stream = null; }
    const v = $("video"); if (v.srcObject) v.srcObject = null;
    $("start").disabled = false; $("stop").disabled = true;
  }

  async function listCameras() {
    try {
      const devs = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === "videoinput");
      const sel = $("cam"), cur = sel.value;
      sel.innerHTML = '<option value="">default (back camera if any)</option>' + devs.map((d, i) => `<option value="${d.deviceId}">${(d.label || "camera " + (i + 1)).replace(/</g, "&lt;")}</option>`).join("");
      sel.value = cur;
    } catch (e) { /* ignore */ }
  }

  async function decodeFiles(files) {
    await pickDecoder();
    const list = Array.from(files).sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
    setPhase("decoding files");
    for (const f of list) {
      if (state.session.done) break;
      if (f.type.startsWith("video/")) { await decodeVideoFile(f); continue; }
      try {
        const bmp = await createImageBitmap(f);
        await onDecoded(await decodeSource(bmp, bmp.width, bmp.height));
        bmp.close && bmp.close();
      } catch (e) { state.session.stats.frames++; }
    }
    if (!state.session.done) { setPhase(state.session.meta ? "incomplete" : "no Dex_QR codes found"); msg(state.session.meta ? "Not enough frames to rebuild the file yet. Add more frames or scan the live stream." : "No Dex_QR codes were found in those files.", "warn"); }
  }

  function decodeVideoFile(f) {
    return new Promise((resolve) => {
      const v = $("video"); const url = URL.createObjectURL(f);
      v.srcObject = null; v.src = url; v.muted = true; v.playbackRate = 0.5;
      state.running = true;
      const finish = () => { state.running = false; v.pause(); URL.revokeObjectURL(url); v.removeAttribute("src"); resolve(); };
      v.onended = finish; v.onerror = finish;
      v.play().then(() => scanVideoFrame()).catch(finish);
      const poll = setInterval(() => { if (state.session.done) { clearInterval(poll); finish(); } }, 200);
      v.addEventListener("ended", () => clearInterval(poll), { once: true });
    });
  }

  $("start").addEventListener("click", startCamera);
  $("stop").addEventListener("click", () => { stopCamera(); setPhase(state.session.meta ? "paused" : "idle"); });
  $("files").addEventListener("change", (e) => decodeFiles(e.target.files));
  $("decrypt").addEventListener("click", tryOpen);
  $("pass").addEventListener("keydown", (e) => { if (e.key === "Enter") tryOpen(); });
  $("reset").addEventListener("click", () => {
    stopCamera(); state.session = new DQ.ReceiverSession(); state.result = null; state.error = null; state.opened = false;
    $("result").innerHTML = ""; $("passbox").style.display = "none"; $("bar").style.width = "0%"; msg("", "");
    ["r-id", "r-enc", "r-prog", "r-pk"].forEach((id) => ($(id).textContent = "–")); setPhase("idle"); updateStats();
  });
})();
