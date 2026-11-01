/* Dex_QR sender page logic. Original code, MIT License. */
(function () {
  "use strict";
  const DQ = window.DexQR;
  const $ = (id) => document.getElementById(id);
  const state = { session: null, playing: false, sent: 0, last: 0, qrSize: 0, raf: 0, file: null, ecl: "M" };
  window.__dexqrSender = state; // read-only hook for automated tests

  function msg(text, cls) { const m = $("msg"); m.textContent = text || ""; m.className = "msg" + (text ? " show " + cls : ""); }
  function fmtTime(s) { if (!isFinite(s)) return "–"; s = Math.ceil(s); return s < 90 ? s + " s" : Math.floor(s / 60) + " min " + (s % 60) + " s"; }
  function hex(b) { return Array.from(b, (x) => x.toString(16).padStart(2, "0")).join(""); }

  $("pass").addEventListener("input", () => {
    const p = $("pass").value, el = $("strength");
    if (!p) { el.textContent = ""; el.className = "strength"; return; }
    const s = DQ.container.estimateStrength(p);
    el.textContent = `Rough strength estimate: ${s.label} (~${s.bits} bits). ` + (s.bits < 60 ? "Too weak against an offline guessing attack on a recorded stream." : "OK if it is truly random.");
    el.className = "strength " + s.label;
  });

  function drawText(text) {
    const qr = DQ.render.makeQr(text, state.ecl);
    const quiet = 4, n = qr.size + 2 * quiet;
    let px = Number($("px").value) | 0;
    if (!px) {
      const stage = $("stage");
      const avail = Math.max(200, Math.min(stage.clientWidth - 16, window.innerHeight - 40));
      px = Math.max(2, Math.floor(avail / n));
    }
    const c = $("qr");
    if (c.width !== n * px) { c.width = n * px; c.height = n * px; }
    const g = c.getContext("2d");
    g.fillStyle = "#fff"; g.fillRect(0, 0, c.width, c.height);
    g.fillStyle = "#000";
    for (let y = 0; y < qr.size; y++) for (let x = 0; x < qr.size; x++) if (qr.getModule(x, y)) g.fillRect((x + quiet) * px, (y + quiet) * px, px, px);
    state.qrSize = qr.size; state.qrVersion = qr.version; state.modulePx = px;
  }

  function updateStats() {
    const s = state.session; if (!s) return;
    const fps = Math.max(1, Number($("fps").value) || 8);
    const need = Math.ceil(s.K * 1.05) + 1;
    $("s-sent").textContent = String(state.sent);
    $("bar").style.width = Math.min(100, (100 * state.sent) / need).toFixed(1) + "%";
    const left = Math.max(0, need - state.sent);
    $("s-eta").textContent = `${fmtTime(left / fps)} left with no missed frames; ${fmtTime(left / 0.7 / fps)} if 30% are missed (total ≈ ${fmtTime(need / fps)} / ${fmtTime(need / 0.7 / fps)})`;
  }

  function showNext() {
    drawText(state.session.nextText());
    state.sent++;
    updateStats();
  }

  function loop(ts) {
    if (!state.playing) return;
    const interval = 1000 / Math.max(1, Math.min(60, Number($("fps").value) || 8));
    if (ts - state.last >= interval - 1) { state.last = ts; showNext(); }
    state.raf = requestAnimationFrame(loop);
  }

  $("prepare").addEventListener("click", async () => {
    const f = $("file").files[0];
    if (!f) { msg("Pick a file first.", "warn"); return; }
    if (f.size > 32 * 1024 * 1024) { msg("Files over 32 MiB are not supported (a QR stream that long is impractical).", "err"); return; }
    state.playing = false; $("play").textContent = "Play";
    $("prepare").disabled = true;
    msg($("pass").value ? "Deriving key (PBKDF2, 600,000 iterations)…" : "Preparing…", "warn");
    try {
      const data = new Uint8Array(await f.arrayBuffer());
      const sha = await DQ.container.sha256(data);
      state.ecl = $("ecl").value;
      const startSeed = crypto.getRandomValues(new Uint32Array(1))[0];
      state.session = await DQ.SenderSession.create({ name: f.name, mime: f.type, data, blockSize: Number($("bs").value), passphrase: $("pass").value || undefined, startSeed });
      state.sent = 0; state.fileSha = hex(sha);
      const s = state.session;
      $("s-file").textContent = `${f.name} (${f.size.toLocaleString()} bytes)`;
      $("s-sha").textContent = state.fileSha;
      $("s-enc").textContent = s.encrypted ? "yes (AES-256-GCM, PBKDF2-SHA-256 × 600,000)" : "no — anyone who sees the stream can read the file";
      $("s-id").textContent = DQ.packet.hex(s.fileId);
      $("s-k").textContent = `${s.K} × ${s.blockSize} bytes`;
      drawText(s.textForSeed(s.nextSeed));
      $("s-qr").textContent = `version ${state.qrVersion} (${state.qrSize}×${state.qrSize} modules), EC ${state.ecl}, ${state.modulePx} px/module`;
      updateStats();
      $("play").disabled = false; $("fs").disabled = false;
      msg("Ready. Press Play and point the receiver's camera at the code.", "ok");
    } catch (e) { msg("Could not prepare: " + e.message, "err"); }
    $("prepare").disabled = false;
  });

  $("play").addEventListener("click", () => {
    if (!state.session) return;
    state.playing = !state.playing;
    $("play").textContent = state.playing ? "Pause" : "Play";
    if (state.playing) { state.last = 0; state.raf = requestAnimationFrame(loop); }
  });

  $("fs").addEventListener("click", () => { const st = $("stage"); if (st.requestFullscreen) st.requestFullscreen(); });

  // Test hook: render the next frame synchronously and return its PNG data URL (used by headless tests only).
  state.renderNextForTest = () => { showNext(); return $("qr").toDataURL("image/png"); };
})();
