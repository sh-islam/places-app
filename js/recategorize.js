// Admin-only: move a catalog item to a different category / subcategory.
// Lives inside selected-mode as two dropdowns + a Go button. On submit,
// backend moves the file on disk and retargets every saved room's URL;
// this module mirrors those changes in local state and refreshes the UI.

import { state } from "./state.js";
import { api } from "./api.js";
import { findObject } from "./objects.js";
import { render } from "./canvas.js";
import { refreshForSelection } from "./panel.js";


let _selCat = null;
let _selSub = null;
let _selMoveBtn = null;


export function initRecategorize() {
  _selCat = document.getElementById("sel-cat");
  _selSub = document.getElementById("sel-sub");
  _selMoveBtn = document.getElementById("sel-move-btn");
  if (!_selCat || !_selSub || !_selMoveBtn) return;

  _selCat.addEventListener("change", () => {
    _populateSub(_selCat.value);
    _syncMoveEnabled();
  });
  _selSub.addEventListener("change", _syncMoveEnabled);
  _selMoveBtn.addEventListener("click", _doMove);
}


// Called from panel._refreshSelectedView() whenever the selected item changes
// so the dropdowns reflect the current asset's category/subcategory.
export function refreshRecategorize() {
  if (!_selCat || !state.isAdmin) return;
  const obj = state.selectedId ? findObject(state.selectedId) : null;
  if (!obj) return;

  const [curCat, curSub] = _parseCatSub(obj.url);
  const cats = Object.keys(state.categories || {}).sort();
  _selCat.innerHTML = cats
    .map((c) => `<option value="${c}">${_label(c)}</option>`)
    .join("");
  if (cats.includes(curCat)) _selCat.value = curCat;
  _populateSub(_selCat.value, curSub);
  _syncMoveEnabled();
}


function _populateSub(cat, preselected) {
  const subs = (state.categories && state.categories[cat]) || [];
  _selSub.innerHTML = subs
    .map((s) => `<option value="${s}">${_label(s)}</option>`)
    .join("");
  if (preselected && subs.includes(preselected)) _selSub.value = preselected;
}


// Disabled when the dropdowns still point at the item's current home.
function _syncMoveEnabled() {
  const obj = state.selectedId ? findObject(state.selectedId) : null;
  if (!obj) { _selMoveBtn.disabled = true; return; }
  const [curCat, curSub] = _parseCatSub(obj.url);
  _selMoveBtn.disabled =
    (_selCat.value === curCat && _selSub.value === curSub);
}


async function _doMove() {
  if (!state.isAdmin) return;
  const obj = state.selectedId ? findObject(state.selectedId) : null;
  if (!obj) return;

  const oldUrl = obj.url;
  const newCat = _selCat.value;
  const newSub = _selSub.value;

  _selMoveBtn.disabled = true;
  try {
    const res = await api.moveCatalogItem(oldUrl, newCat, newSub);
    const newUrl = res.url;

    // Mirror the backend's room sweep in local state so the canvas + panel
    // reflect the move without a full reload.
    for (const room of state.rooms || []) {
      for (const o of room.objects || []) {
        if (o.url === oldUrl) {
          o.url = newUrl;
          o.asset_id = res.asset_id;
          o.tags = [newCat, newSub, res.name];
        }
      }
    }

    // Pull fresh catalog so the item appears under its new cat/sub.
    const c = await api.catalog();
    state.catalog = c.items;
    state.categories = c.categories;
    const { rebuildCatalog } = await import("./catalog.js");
    rebuildCatalog();

    refreshForSelection();
    render();
  } catch (err) {
    alert(`Move failed: ${err.message}`);
    _syncMoveEnabled();
  }
}


function _parseCatSub(url) {
  const parts = (url || "").replace(/^\/catalog\//, "").split("/");
  return [parts[0], parts[1]];
}


function _label(s) {
  return s.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}
