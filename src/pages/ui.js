/* Dex_QR shared page chrome (cycle 6): colour theme and reduce-motion toggles. Original code, MIT License.
 * Preferences go to localStorage when the browser allows it on this origin (file:// included in Chrome);
 * otherwise they last until the page is closed. Nothing is sent anywhere. */
(function () {
  "use strict";
  const root = document.documentElement;
  const store = {
    get(k) { try { return localStorage.getItem(k); } catch (e) { return null; } },
    set(k, v) { try { if (v) localStorage.setItem(k, v); else localStorage.removeItem(k); } catch (e) { /* page-only */ } },
  };
  const mq = window.matchMedia ? window.matchMedia("(prefers-reduced-motion: reduce)") : null;
  const listeners = [];
  const UI = {
    /** True when the system asks for reduced motion or the in-page toggle is on. */
    reducedMotion() { return root.getAttribute("data-motion") === "reduce" || !!(mq && mq.matches); },
    onMotionChange(fn) { listeners.push(fn); },
    theme() { return root.getAttribute("data-theme") || "auto"; },
    /** Resolved colour from a CSS variable, for canvas drawing. */
    cssVar(name) { return getComputedStyle(root).getPropertyValue(name).trim(); },
  };
  const fire = () => listeners.forEach((fn) => { try { fn(UI.reducedMotion()); } catch (e) { /* keep others */ } });
  if (mq) { if (mq.addEventListener) mq.addEventListener("change", () => { syncMotion(); fire(); }); }

  const NAMES = { auto: "automatic (follows the system)", light: "light", dark: "dark" };
  const LABELS = { auto: "Auto", light: "Light", dark: "Dark" };
  function syncTheme() {
    const b = document.getElementById("theme"); if (!b) return;
    const t = UI.theme();
    // The accessible name starts with the visible word (WCAG 2.5.3 label in name).
    b.setAttribute("aria-label", LABELS[t] + " colour theme: " + NAMES[t] + ". Press to change.");
    const l = document.getElementById("theme-lbl"); if (l) l.textContent = LABELS[t];
  }
  function syncMotion() {
    const b = document.getElementById("motion"); if (!b) return;
    const own = root.getAttribute("data-motion") === "reduce", sys = !!(mq && mq.matches);
    b.setAttribute("aria-pressed", String(own || sys));
    b.disabled = sys && !own;
    b.title = sys && !own ? "Motion is already reduced by your system setting" : own ? "Motion reduced: press to allow animation" : "Reduce motion";
  }
  function init() {
    const tb = document.getElementById("theme"), mb = document.getElementById("motion");
    if (tb) tb.addEventListener("click", () => {
      const order = ["auto", "light", "dark"], next = order[(order.indexOf(UI.theme()) + 1) % 3];
      if (next === "auto") root.removeAttribute("data-theme"); else root.setAttribute("data-theme", next);
      store.set("dexqr-theme", next === "auto" ? "" : next);
      syncTheme();
      window.dispatchEvent(new CustomEvent("dexqr-theme"));
    });
    if (mb) mb.addEventListener("click", () => {
      const on = root.getAttribute("data-motion") !== "reduce";
      if (on) root.setAttribute("data-motion", "reduce"); else root.removeAttribute("data-motion");
      store.set("dexqr-motion", on ? "reduce" : "");
      syncMotion(); fire();
    });
    syncTheme(); syncMotion();
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init); else init();
  window.DexUI = UI;
})();
