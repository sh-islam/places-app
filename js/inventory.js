// Inventory drawer: lists the current room's objects and lets the user
// remove, bring-to-front, or center any item.

import { state, selectSingle, toggleSelection } from "./state.js";
import {
  bringForward,
  confirmRemoveObject,
  filterStringFor,
  findObject,
  moveObject,
  toggleVisibility,
} from "./objects.js";
import { itemDisplayName } from "./labels.js";
import { deleteActiveRoom } from "./rooms.js";
import { assetUrl } from "./config.js";
import { getCanvasCenterWorld } from "./canvas.js";


let drawerEl = null;
let toggleBtn = null;
let listEl = null;
let backdropEl = null;
let renderScene = null;
let refreshPanel = null;
let sortOrder = "asc";  // "asc" | "desc"


export function initInventory({
  drawer,
  toggle,
  list,
  sortAscBtn,
  sortDescBtn,
  deleteRoomBtn,
  closeBtn,
  backdrop,
  onChange,
  onPanelReset,
}) {
  drawerEl = drawer;
  toggleBtn = toggle;
  listEl = list;
  backdropEl = backdrop;
  renderScene = onChange;
  refreshPanel = onPanelReset;

  toggle.addEventListener("click", () => _setOpen(!_isOpen(), backdrop));
  closeBtn.addEventListener("click", () => _setOpen(false, backdrop));
  backdrop.addEventListener("click", () => _setOpen(false, backdrop));

  sortAscBtn.addEventListener("click",  () => { sortOrder = "asc";  _renderList(); });
  sortDescBtn.addEventListener("click", () => { sortOrder = "desc"; _renderList(); });
  deleteRoomBtn.addEventListener("click", () => _onDeleteRoom(backdrop));

  listEl.addEventListener("click", _onListClick);
  // Long-press → toggle multi-select (same cadence as canvas).
  listEl.addEventListener("pointerdown", _onListPointerDown);
  listEl.addEventListener("pointerup", _cancelInvLongPress);
  listEl.addEventListener("pointerleave", _cancelInvLongPress);
  listEl.addEventListener("pointercancel", _cancelInvLongPress);
  listEl.addEventListener("pointermove", _cancelInvLongPress);
}


async function _onDeleteRoom(backdrop) {
  const n = state.room.objects.length;
  const roomNum = state.activeIndex + 1;
  const msg = n === 0
    ? `Delete Room ${roomNum}?`
    : `Delete Room ${roomNum}? This removes ${n} item${n === 1 ? "" : "s"}. This can't be undone.`;
  if (!window.confirm(msg)) return;
  await deleteActiveRoom();
  _renderList();
  _setOpen(false, backdrop);
}


function _isOpen() { return drawerEl.classList.contains("open"); }

function _setOpen(open, backdrop) {
  drawerEl.classList.toggle("open", open);
  backdrop.classList.toggle("open", open);
  drawerEl.setAttribute("aria-hidden", open ? "false" : "true");
  if (open) _renderList();
}


function _sortedObjects() {
  const arr = [...state.room.objects];
  arr.sort((a, b) => {
    const an = itemDisplayName(a.name || a.asset_id).toLowerCase();
    const bn = itemDisplayName(b.name || b.asset_id).toLowerCase();
    return an.localeCompare(bn);
  });
  if (sortOrder === "desc") arr.reverse();
  return arr;
}


function _renderList() {
  listEl.innerHTML = "";
  const objs = _sortedObjects();
  if (objs.length === 0) {
    const empty = document.createElement("p");
    empty.className = "muted small";
    empty.textContent = "Room is empty. Open the catalog to add items.";
    listEl.appendChild(empty);
    return;
  }
  for (const obj of objs) listEl.appendChild(_buildRow(obj));
}


function _buildRow(obj) {
  const row = document.createElement("div");
  let cls = "inv-item";
  if (obj.hidden) cls += " inv-hidden";
  if (state.selectedIds.has(obj.id)) cls += " inv-selected";
  row.className = cls;
  row.dataset.id = obj.id;

  const img = document.createElement("img");
  img.src = assetUrl(obj.url);
  img.alt = "";
  // Reflect per-instance hue/sat/brightness/contrast so the
  // thumbnail matches what the canvas renders. Skew + perspective
  // warp are intentionally skipped — they'd require a pre-rendered
  // canvas per row and the thumbnail shouldn't carry that cost.
  const f = filterStringFor(obj);
  if (f !== "none") img.style.filter = f;
  row.appendChild(img);

  const name = document.createElement("div");
  name.className = "inv-name";
  name.textContent = itemDisplayName(obj.name || obj.asset_id);
  row.appendChild(name);

  const actions = document.createElement("div");
  actions.className = "inv-actions";
  actions.innerHTML = `
    <button class="btn-icon" data-inv-action="center" title="Center in canvas">⊕</button>
    <button class="btn-icon${obj.hidden ? " eye-closed" : ""}" data-inv-action="visibility" title="Toggle visibility">👁</button>
    <button class="btn-icon" data-inv-action="front"  title="Bring to front">▲</button>
    <button class="btn-icon danger" data-inv-action="remove" title="Remove">🗑</button>
  `;
  row.appendChild(actions);
  return row;
}


function _onListClick(e) {
  // Long-press on this row already toggled the selection; suppress the
  // synthetic click so we don't immediately collapse back to a single
  // selection of the same item.
  if (_invLongPressFired) {
    _invLongPressFired = false;
    return;
  }
  const row = e.target.closest(".inv-item");
  if (!row) return;
  const id = row.dataset.id;
  const obj = findObject(id);
  if (!obj) return;

  // Action-button click: run the action as before. Clicks on the row
  // itself (outside any action button) fall through to the row-select
  // flow below.
  const btn = e.target.closest("button[data-inv-action]");
  if (btn) {
    switch (btn.dataset.invAction) {
      case "center": _centerObject(obj); break;
      case "visibility": toggleVisibility(id); _renderList(); break;
      case "front":  bringForward(id); break;
      case "remove": confirmRemoveObject(id); break;
    }
    _renderList();
    if (refreshPanel) refreshPanel();
    if (renderScene) renderScene();
    return;
  }

  // Bare row click: behave like a tap on the canvas — replace any
  // multi-selection with just this item, refresh the panel, and drop
  // the drawer so the user sees the item highlighted on the canvas.
  // Long-press on the row (see _onListPointerDown) toggles membership
  // in the multi-selection without closing the drawer.
  selectSingle(id);
  if (refreshPanel) refreshPanel();
  if (renderScene) renderScene();
  _setOpen(false, backdropEl);
}


// Long-press handler wired in initInventory(). Toggles the pressed
// row's id in the multi-selection instead of collapsing to a single
// selection, so users can stack picks the same way the canvas does.
const _INV_LONG_PRESS_MS = 500;
let _invLongPressTimer = null;
let _invLongPressFired = false;
let _invLongPressStartId = null;

function _onListPointerDown(e) {
  const row = e.target.closest(".inv-item");
  if (!row) return;
  // Ignore long-press arming on the per-row action buttons so their
  // own click still fires cleanly without being mis-interpreted.
  if (e.target.closest("button[data-inv-action]")) return;
  _invLongPressFired = false;
  _invLongPressStartId = row.dataset.id;
  clearTimeout(_invLongPressTimer);
  _invLongPressTimer = setTimeout(() => {
    _invLongPressTimer = null;
    _invLongPressFired = true;
    toggleSelection(_invLongPressStartId);
    _renderList();
    if (refreshPanel) refreshPanel();
    if (renderScene) renderScene();
  }, _INV_LONG_PRESS_MS);
}

function _cancelInvLongPress() {
  if (_invLongPressTimer) {
    clearTimeout(_invLongPressTimer);
    _invLongPressTimer = null;
  }
}


function _centerObject(obj) {
  // World is a fixed 1000×1000 space mapped into the canvas CSS rect
  // via a fit transform; the old local math mistook canvas CSS pixels
  // for world units so the item landed off-centre. Route through the
  // canvas's own screen→world helper which accounts for the fit,
  // zoom, and pan together.
  const { x, y } = getCanvasCenterWorld();
  moveObject(obj.id, x, y);
}
