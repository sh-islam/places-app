// Inventory drawer: lists the current room's objects and lets the user
// remove, bring-to-front, or center any item.

import { state } from "./state.js";
import {
  bringForward,
  confirmRemoveObject,
  findObject,
  moveObject,
  toggleVisibility,
} from "./objects.js";
import { itemDisplayName } from "./labels.js";
import { deleteActiveRoom } from "./rooms.js";
import { assetUrl } from "./config.js";


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
  row.className = "inv-item" + (obj.hidden ? " inv-hidden" : "");
  row.dataset.id = obj.id;

  const img = document.createElement("img");
  img.src = assetUrl(obj.url);
  img.alt = "";
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

  // Bare row click: select the item on canvas (same effect as tapping
  // it directly — glow + selected-mode panel) and drop the drawer.
  state.selectedId = id;
  if (refreshPanel) refreshPanel();
  if (renderScene) renderScene();
  _setOpen(false, backdropEl);
}


function _centerObject(obj) {
  const canvas = document.getElementById("room-canvas");
  const rect = canvas.getBoundingClientRect();
  // Convert the canvas centre (screen) to world coords so the item lands in
  // the visible middle even when the user is zoomed/panned.
  const v = state.view;
  const cx = (rect.width  / 2 - v.panX) / v.zoom;
  const cy = (rect.height / 2 - v.panY) / v.zoom;
  moveObject(obj.id, cx, cy);
}
