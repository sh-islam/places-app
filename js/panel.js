// Switches the bottom panel between modes: empty / selected / edit.

import { state } from "./state.js";
import { findObject } from "./objects.js";
import { toLabel, itemDisplayName } from "./labels.js";
import { assetUrl } from "./config.js";
import { refreshRecategorize } from "./recategorize.js";


let currentMode = "empty";


export function setMode(mode) {
  currentMode = mode;
  for (const el of document.querySelectorAll(".mode")) {
    el.classList.toggle("active", el.dataset.mode === mode);
  }
  if (mode === "selected") _refreshSelectedView();
}


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
  refreshRecategorize();
}
