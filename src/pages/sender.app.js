/* Dex_QR sender page logic. Original code, MIT License. */
(function () {
  "use strict";
  const DQ = window.DexQR;
  const $ = (id) => document.getElementById(id);
  const MAX_FILE = 32 * 1024 * 1024;
  const state = {
    session: null, playing: false, sent: 0, due: 0, qrSize: 0, raf: 0, ecl: "M", text: "",
    prepared: null, preparing: false, fpsSamples: [], actualFps: 0, wakeLock: null, focusMode: false,
  };
  window.__dexqrSender = state; // read-only hook for automated tests

  function msg(text, cls) {
    const m = $("msg"); m.textContent = text || ""; m.className = "msg" + (text ? " show " + cls : "");
    m.setAttribute("role", cls === "err" ? "alert" : "status");
  }
  function fmtTime(s) { if (!isFinite(s)) return "–"; s = Math.ceil(s); return s < 90 ? s + " s" : Math.floor(s / 60) + " min " + (s % 60) + " s"; }
  function hex(b) { return Array.from(b, (x) => x.toString(16).padStart(2, "0")).join(""); }
  function clampInput(id, lo, hi, dflt) {
    const el = $(id); let v = Math.round(Number(el.value));
    if (!Number.isFinite(v) || el.value.trim() === "") v = dflt;
    v = Math.max(lo, Math.min(hi, v));
    if (String(v) !== el.value) el.value = String(v);
    return v;
  }
  const fps = () => clampInput("fps", 1, 30, 8);

  $("pass").addEventListener("input", () => {
    const p = $("pass").value, el = $("strength");
    if (!p) { el.textContent = ""; el.className = "strength"; return; }
    const s = DQ.container.estimateStrength(p);
    // Warnings never quote the passphrase: this screen may be filmed.
    el.textContent = `Strength estimate: ${s.label} (about ${s.bits} bits of guessing). ` + (s.warnings[0] ? s.warnings[0] + " " : "") + (s.bits < 60 ? "Too weak against an offline guessing attack on a recorded stream." : "OK if it was chosen at random.");
    el.className = "strength " + s.label;
  });

  function drawText(text) {
    const qr = DQ.render.makeQr(text, state.ecl);
    const quiet = 4, n = qr.size + 2 * quiet;
    let px = clampInput("px", 0, 20, 0);
    if (!px) {
      const stage = $("stage");
      const reserve = state.focusMode || document.fullscreenElement ? 56 : 40;   // room for the stage bar
      const avail = Math.max(200, Math.min(stage.clientWidth - 16, (state.focusMode || document.fullscreenElement ? stage.clientHeight : window.innerHeight) - reserve));
      px = Math.max(2, Math.floor(avail / n));
    }
    const c = $("qr");
    if (c.width !== n * px) { c.width = n * px; c.height = n * px; }
    const g = c.getContext("2d");
    g.fillStyle = "#fff"; g.fillRect(0, 0, c.width, c.height);
    g.fillStyle = "#000";
    for (let y = 0; y < qr.size; y++) for (let x = 0; x < qr.size; x++) if (qr.getModule(x, y)) g.fillRect((x + quiet) * px, (y + quiet) * px, px, px);
    state.qrSize = qr.size; state.qrVersion = qr.version; state.modulePx = px; state.text = text;
  }
  function redraw() {
    if (!state.text) return;
    drawText(state.text);
    $("s-qr").textContent = `version ${state.qrVersion} (${state.qrSize}×${state.qrSize} modules), EC ${state.ecl}, ${state.modulePx} px/module`;
  }

  function updateStats() {
    const s = state.session; if (!s) return;
    const f = fps();
    const need = Math.ceil((Math.ceil(s.K * 1.05) + 1) / s.dataFrameShare);   // key-check frames take 1 in 32
    const pct = Math.min(100, (100 * state.sent) / need);
    $("s-sent").textContent = String(state.sent) + (state.playing && state.actualFps ? ` (${state.actualFps.toFixed(1)} fps actual)` : "");
    $("bar").style.width = pct.toFixed(1) + "%";
    $("barwrap").setAttribute("aria-valuenow", pct.toFixed(0));
    const left = Math.max(0, need - state.sent);
    $("s-eta").textContent = `${fmtTime(left / f)} left with no missed frames; ${fmtTime(left / 0.7 / f)} if 30% are missed (total ≈ ${fmtTime(need / f)} / ${fmtTime(need / 0.7 / f)})`;
    $("stage-info").textContent = `frame ${state.sent} · ${f} fps`;
  }

  function showNext(ts) {
    drawText(state.session.nextFrame());
    state.sent++;
    if (ts !== undefined) {
      const w = state.fpsSamples; w.push(ts);
      while (w.length > 2 && ts - w[0] > 2000) w.shift();
      state.actualFps = w.length > 1 ? (1000 * (w.length - 1)) / (w[w.length - 1] - w[0]) : 0;
    }
    updateStats();
  }

  /* Frame clock: frames are due every 1000/fps ms on an absolute schedule (due += interval), so the
   * average rate matches the setting even when the interval is not a whole number of display
   * refreshes (8 fps on a 60 Hz screen alternates 7 and 8 refreshes). The old "ts - last >= interval"
   * test rounded every frame up to whole refreshes: 8 fps ran at 7.5 fps. After a stall (hidden tab,
   * slow device) the schedule restarts instead of bursting to catch up. */
  function loop(ts) {
    if (!state.playing) return;
    const interval = 1000 / fps();
    if (!state.due || ts - state.due > 4 * interval) state.due = ts;
    if (ts >= state.due - 2) {
      state.due += interval;
      showNext(ts);
    }
    state.raf = requestAnimationFrame(loop);
  }

  function setPlaying(on) {
    if (!state.session) return;
    if (on === state.playing) return;
    state.playing = on;
    $("play").textContent = on ? "Pause" : "Play";
    $("play").setAttribute("aria-pressed", String(on));
    $("stage-play").textContent = on ? "Pause" : "Play";
    $("qr").setAttribute("aria-label", on ? "Animated QR code stream, playing" : "Animated QR code stream, paused");
    cancelAnimationFrame(state.raf);
    if (on) { state.due = 0; state.fpsSamples = []; state.actualFps = 0; state.raf = requestAnimationFrame(loop); }
    wake(on);
    updateStats();
  }

  async function wake(on) {
    try {
      if (on && !state.wakeLock && navigator.wakeLock) { state.wakeLock = await navigator.wakeLock.request("screen"); state.wakeLock.addEventListener("release", () => { state.wakeLock = null; }); }
      else if (!on && state.wakeLock) { const l = state.wakeLock; state.wakeLock = null; await l.release(); }
    } catch (e) { /* best effort: the screen may still dim on browsers without the Wake Lock API */ }
  }

  function settingsKey() { const f = $("file").files[0]; return [f ? f.name + ":" + f.size + ":" + f.lastModified : "", $("pass").value, $("bs").value, $("zip").checked, $("kc").checked, $("kdf").value].join("\u0000"); }
  function checkStale() {
    if (!state.session || state.preparing) return;
    const stale = settingsKey() !== state.prepared;
    $("prepare").classList.toggle("attn", stale);
    $("prepare").textContent = stale ? "Prepare (apply changes)" : "Prepare";
    if (stale) msg("Settings changed. The stream on screen still uses the previous file, passphrase, key stretching, compression, key check and density; press Prepare to apply.", "warn");
    else if ($("msg").classList.contains("warn") && /Settings changed/.test($("msg").textContent)) msg("", "");
  }

  function describeCompression(c) {
    if (!c) return "–";
    if (c.used) return `${c.algorithm}: ${c.innerLength.toLocaleString()} → ${c.compressedLength.toLocaleString()} bytes (−${(100 * (1 - c.compressedLength / c.innerLength)).toFixed(0)}%)`;
    if (c.reason === "off") return "off";
    if (c.reason === "unavailable") return "not available in this browser (no CompressionStream); sent uncompressed";
    return "skipped: the file does not shrink (already compressed?)";
  }

  function describeKdf(tuned, n) {
    if (!tuned) return ", standard";
    const c = state.calibration;
    if (!c || !c.measured) return ", standard: this device could not be timed";
    const x = (n / DQ.container.DEFAULT_ITERATIONS).toFixed(1);
    return `, tuned to this device: about ${(c.estimatedMs / 1000).toFixed(1)} s here, ${x}× the standard 600,000` + (c.capped ? ", at the 8,000,000 cap" : c.floored ? ", the minimum" : "");
  }

  async function prepare() {
    const f = $("file").files[0];
    if (!f) { msg("Pick a file first.", "warn"); $("file").focus(); return; }
    if (f.size > MAX_FILE) { msg("Files over 32 MiB are not supported (a QR stream that long is impractical).", "err"); return; }
    setPlaying(false);
    state.preparing = true; $("prepare").disabled = true; $("play").disabled = true;
    msg($("pass").value ? "Preparing the key…" : "Preparing…", "warn");
    try {
      // Key stretching (cycle 4): measure this device once per page load, then derive with that count.
      let iterations = DQ.container.DEFAULT_ITERATIONS;
      const tuned = !!$("pass").value && $("kdf").value === "auto";
      if (tuned) {
        if (!state.calibration) { msg("Measuring this device's PBKDF2 speed…", "warn"); state.calibration = await DQ.container.calibrateIterations(); }
        iterations = state.calibration.iterations;
      }
      if ($("pass").value) msg(`Deriving key (PBKDF2, ${iterations.toLocaleString("en-US")} iterations)…`, "warn");
      const key = settingsKey();
      const data = new Uint8Array(await f.arrayBuffer());
      const sha = await DQ.container.sha256(data);
      state.ecl = $("ecl").value;
      const startSeed = crypto.getRandomValues(new Uint32Array(1))[0];
      state.session = await DQ.SenderSession.create({ name: f.name, mime: f.type, data, blockSize: Number($("bs").value), passphrase: $("pass").value || undefined, iterations, startSeed, compress: $("zip").checked, keyCheck: $("kc").checked });
      state.prepared = key;
      state.sent = 0; state.fileSha = hex(sha);
      const s = state.session;
      $("s-file").textContent = `${f.name} (${f.size.toLocaleString()} bytes)`;
      $("s-sha").textContent = state.fileSha;
      $("s-enc").textContent = s.encrypted ? `yes (AES-256-GCM, PBKDF2-SHA-256 × ${iterations.toLocaleString("en-US")}${describeKdf(tuned, iterations)})` + (s.keyFrameText ? "; early passphrase check on (1 key-check frame in 32)" : "; early passphrase check off") : "no — anyone who sees the stream can read the file";
      $("s-zip").textContent = describeCompression(s.compression);
      $("s-id").textContent = DQ.packet.hex(s.fileId);
      $("s-k").textContent = `${s.K} × ${s.blockSize} bytes`;
      drawText(s.textForSeed(s.nextSeed));   // preview a data packet so the QR line shows the data-frame size
      redraw();
      $("qr").setAttribute("aria-label", "Animated QR code stream, paused");
      updateStats();
      $("play").disabled = false; $("fs").disabled = false;
      msg("✓ Ready. Press Play and point the receiver's camera at the code.", "ok");
    } catch (e) { msg("✗ Could not prepare: " + e.message, "err"); $("play").disabled = !state.session; }
    state.preparing = false; $("prepare").disabled = false;
    checkStale();
  }

  /* Full screen, with an in-page fallback ("focus mode") where the Fullscreen API is missing or refused (iPhone Safari). */
  async function enterFull() {
    if (!state.session) return;
    const st = $("stage");
    try {
      if (!st.requestFullscreen) throw new Error("no Fullscreen API");
      await st.requestFullscreen();
    } catch (e) { state.focusMode = true; st.classList.add("focus"); document.body.classList.add("noscroll"); }
    $("stagebar").hidden = false;
    $("stage-exit").focus();
    redraw();
  }
  function exitFull() {
    if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
    if (state.focusMode) { state.focusMode = false; $("stage").classList.remove("focus"); document.body.classList.remove("noscroll"); }
    $("stagebar").hidden = true;
    redraw();
    $("fs").focus();
  }
  document.addEventListener("fullscreenchange", () => { if (!document.fullscreenElement && !state.focusMode) $("stagebar").hidden = true; redraw(); });

  $("prepare").addEventListener("click", prepare);
  $("play").addEventListener("click", () => setPlaying(!state.playing));
  $("stage-play").addEventListener("click", () => setPlaying(!state.playing));
  $("fs").addEventListener("click", enterFull);
  $("stage-exit").addEventListener("click", exitFull);
  ["file", "bs", "zip", "kc", "kdf"].forEach((id) => $(id).addEventListener("change", checkStale));
  $("pass").addEventListener("input", checkStale);
  // Rendering-only settings apply live: they change how a packet is drawn, not the stream.
  $("ecl").addEventListener("change", () => { state.ecl = $("ecl").value; redraw(); });
  $("px").addEventListener("change", redraw);
  $("fps").addEventListener("change", () => { fps(); state.due = 0; updateStats(); });
  let rz = 0;
  window.addEventListener("resize", () => { cancelAnimationFrame(rz); rz = requestAnimationFrame(redraw); });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && state.focusMode) { exitFull(); return; }
    const t = e.target, tag = t && t.tagName;
    if (e.ctrlKey || e.metaKey || e.altKey || tag === "INPUT" || tag === "SELECT" || tag === "TEXTAREA" || (tag === "BUTTON" && (e.key === " " || e.key === "Enter"))) return;
    if (e.key === " " || e.key === "k" || e.key === "K") { if (state.session) { e.preventDefault(); setPlaying(!state.playing); } }
    else if (e.key === "f" || e.key === "F") { if (state.session) { e.preventDefault(); if (document.fullscreenElement || state.focusMode) exitFull(); else enterFull(); } }
  });
  document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible" && state.playing) wake(true); });

  // Test hook: render the next frame synchronously and return its PNG data URL (used by headless tests only).
  state.renderNextForTest = () => { showNext(); return $("qr").toDataURL("image/png"); };
})();
