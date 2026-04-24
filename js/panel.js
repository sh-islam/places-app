// Switches the bottom panel between modes: empty / selected / edit.

import { state } from "./state.js";
import { findObject } from "./objects.js";
import { toLabel, itemDisplayName } from "./labels.js";
import { assetUrl } from "./config.js";


let currentMode = "empty";


export function setMode(mode) {
  currentMode = mode;
  for (const el of document.querySelectorAll(".mode")) {
    el.classList.toggle("active", el.dataset.mode === mode);
  }
  if (mode === "selected") _refreshSelectedView();
  if (mode === "edit") _fitEditModeToPanel();
}


// Keep the edit panel's entire UI visible without scrolling: measure
// the wrapped content's natural height, compare to the available
// height inside .mode[data-mode="edit"], and apply a transform:
// scale() that shrinks it to fit. Scale is also reflected in the
// wrapper's explicit height so flex layout above doesn't report the
// un-scaled size and push DONE below the panel. Runs on entering
// edit mode, on window resize, and on orientation change. Scroll
// (overflow-y: auto on .mode) is kept as a last-resort fallback so
// DONE is always reachable even if the scale math mispredicts.
let _fitRaf = 0;
function _fitEditModeToPanel() {
  cancelAnimationFrame(_fitRaf);
  _fitRaf = requestAnimationFrame(() => {
    const mode = document.querySelector('.mode[data-mode="edit"]');
    const wrap = mode && mode.querySelector(".edit-scale-wrap");
    if (!mode || !wrap) return;
    // Reset before measuring — otherwise the previous transform
    // skews the natural-height reading.
    wrap.style.transform = "";
    wrap.style.transformOrigin = "";
    wrap.style.height = "";
    wrap.style.width = "";
    const natural = wrap.scrollHeight;
    const available = mode.clientHeight;
    if (natural <= 0 || available <= 0) return;
    const scale = Math.min(1, available / natural);
    if (scale >= 0.999) return; // already fits
    wrap.style.transformOrigin = "top center";
    wrap.style.transform = `scale(${scale})`;
    // Shrink the wrapper's layout height to match the scaled visual
    // so the mode container doesn't report the pre-scaled height and
    // start scrolling anyway. Horizontal shrink is accepted as-is —
    // content centres via transform-origin so the visual is balanced.
    wrap.style.height = `${natural * scale}px`;
  });
}


// Recompute on resize / orientation-change so the fit holds as the
// visual viewport changes (e.g. iOS bottom bar appearing/hiding).
window.addEventListener("resize", () => {
  if (currentMode === "edit") _fitEditModeToPanel();
});


export function getMode() {
  return currentMode;
}


export function refreshForSelection() {
  // Called after the user clicks/taps something or deselects.
  if (state.selectedId == null) {
    setMode("empty");
    return;
  }
  if (currentMode !== "edit") setMode("selected");
  else _refreshSelectedView(); // keep edit-mode showing latest details
}


function _refreshSelectedView() {
  const obj = state.selectedId ? findObject(state.selectedId) : null;
  if (!obj) return;
  const nameEl = document.getElementById("sel-name");
  const tagsEl = document.getElementById("sel-tags");
  const thumbEl = document.getElementById("sel-thumb");
  if (nameEl) nameEl.textContent = itemDisplayName(obj.name || obj.asset_id);
  if (tagsEl) {
    const name = obj.name || obj.asset_id;
    tagsEl.textContent = obj.tags.filter((t) => t !== name).map(toLabel).join(" · ");
  }
  if (thumbEl) thumbEl.src = assetUrl(obj.url);
  const visBtn = document.getElementById("visibility-btn");
  if (visBtn) {
    visBtn.textContent = "👁";
    visBtn.classList.toggle("eye-closed", !!obj.hidden);
  }
  // Mark the body when the selection is an animated GIF so CSS can
  // hide tools that would flatten the animation (Shear / Warp fall
  // back to canvas = frame 0; Advanced editor overwrites as PNG and
  // the backend refuses .gif targets anyway).
  const isGif = typeof obj.url === "string"
    && obj.url.toLowerCase().endsWith(".gif");
  document.body.classList.toggle("sel-is-gif", isGif);
}
