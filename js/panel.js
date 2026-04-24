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
    mode.style.overflowX = "";
    const natural = wrap.scrollHeight;
    const available = mode.clientHeight;
    if (natural <= 0 || available <= 0) return;
    const scale = Math.min(1, available / natural);
    if (scale >= 0.999) return; // already fits
    wrap.style.transformOrigin = "top left";
    wrap.style.transform = `scale(${scale})`;
    // Width compensation: set wrap layout width to (100 / scale)% so
    // after the transform visually shrinks it back to 100 % of the
    // mode, its children (which flex-anchor to the wrap's left and
    // right edges) land exactly at the mode's left and right edges.
    // Without this the scaled content leaves big dead bars on both
    // sides. Height is shrunk to the scaled visual so flex above
    // sees the correct occupied height and DONE stays on-screen.
    wrap.style.width = `${100 / scale}%`;
    wrap.style.height = `${natural * scale}px`;
    // Wider-than-mode layout width would otherwise trigger a
    // horizontal scrollbar; clip it.
    mode.style.overflowX = "hidden";
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


// Build a small offset stack of thumbnails next to the sel-thumb slot
// when a multi-selection is active. Reuses the existing #sel-thumb
// element as the topmost thumb; the 1–2 additional behind-thumbs live
// in a sibling `.sel-thumb-stack` container that sits just before the
// single img so CSS can lay them out. Removed again by
// _clearStackThumbs when the selection drops back to one item.
function _renderStackThumbs(thumbEl, objs) {
  if (!thumbEl) return;
  // Place up to 3 thumbs visually stacked (front img = primary).
  const picks = [];
  // Primary at front
  const primary = objs.find((o) => o.id === state.selectedId) || objs[0];
  picks.push(primary);
  for (const o of objs) {
    if (picks.length >= 3) break;
    if (!picks.includes(o)) picks.push(o);
  }
  thumbEl.src = assetUrl(primary.url);
  thumbEl.hidden = false;
  let stack = thumbEl.parentNode.querySelector(".sel-thumb-stack");
  if (!stack) {
    stack = document.createElement("div");
    stack.className = "sel-thumb-stack";
    thumbEl.parentNode.insertBefore(stack, thumbEl);
  }
  stack.innerHTML = "";
  // Behind thumbs in reverse so the last-rendered sits furthest back.
  for (let i = picks.length - 1; i >= 1; i--) {
    const im = document.createElement("img");
    im.className = "sel-thumb sel-thumb-behind";
    im.alt = "";
    im.src = assetUrl(picks[i].url);
    im.style.setProperty("--i", String(i));
    stack.appendChild(im);
  }
}

function _clearStackThumbs(thumbEl) {
  if (!thumbEl) return;
  const stack = thumbEl.parentNode.querySelector(".sel-thumb-stack");
  if (stack) stack.remove();
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
  const multi = state.selectedIds.size > 1;
  if (multi) {
    // Multi-select header: no single name / tags makes sense, so
    // show the count and a short preview of the first few items.
    const ids = [...state.selectedIds];
    const objs = ids.map(findObject).filter(Boolean);
    if (nameEl) nameEl.textContent = `${objs.length} items selected`;
    if (tagsEl) {
      tagsEl.textContent = objs
        .slice(0, 3)
        .map((o) => itemDisplayName(o.name || o.asset_id))
        .join(" · ") + (objs.length > 3 ? ` · +${objs.length - 3}` : "");
    }
    _renderStackThumbs(thumbEl, objs);
  } else {
    _clearStackThumbs(thumbEl);
    if (nameEl) nameEl.textContent = itemDisplayName(obj.name || obj.asset_id);
    if (tagsEl) {
      const name = obj.name || obj.asset_id;
      tagsEl.textContent = obj.tags.filter((t) => t !== name).map(toLabel).join(" · ");
    }
    if (thumbEl) {
      thumbEl.hidden = false;
      thumbEl.src = assetUrl(obj.url);
    }
  }
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
  // Mark the body when a multi-selection is active so CSS can hide
  // affordances that only make sense on a single item (advanced edit,
  // rename, per-instance shear / warp handles).
  document.body.classList.toggle("sel-is-multi", state.selectedIds.size > 1);
}
