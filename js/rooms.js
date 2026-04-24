// Multi-room navigation: dots, swipe, and an "add room" affordance.
// Keeps state.rooms + state.activeIndex in sync with the backend.

import { state, syncActiveRoom, markClean } from "./state.js";
import { api } from "./api.js";
import { preloadAll } from "./images.js";
import { normalizeLayers } from "./objects.js";


let dotsEl = null;
let renderScene = null;   // canvas render fn
let refreshPanel = null;  // clears selection + returns to home mode


export async function initRooms({ dotsContainer, onRoomChange, onPanelReset }) {
  dotsEl = dotsContainer;
  renderScene = onRoomChange;
  refreshPanel = onPanelReset;

  dotsEl.addEventListener("click", _onDotClick);
  await _loadRooms();
  _renderDots();
}


export async function switchRoom(index) {
  if (index < 0 || index >= state.rooms.length) return;
  if (index === state.activeIndex) return;
  state.activeIndex = index;
  syncActiveRoom();
  normalizeLayers();
  state.selectedId = null;
  markClean(); // switching is not a "dirty" edit
  await api.setActiveRoom(index).catch((err) => console.warn(err));
  await preloadAll(state.room.objects.map((o) => o.url));
  _renderDots();
  if (refreshPanel) refreshPanel();
  if (renderScene) renderScene();
}


export function nextRoom() { switchRoom(state.activeIndex + 1); }
export function prevRoom() { switchRoom(state.activeIndex - 1); }


export async function addRoom() {
  const data = await api.addRoom();
  state.rooms = data.rooms;
  state.activeIndex = data.active_index;
  syncActiveRoom();
  state.selectedId = null;
  _renderDots();
  if (refreshPanel) refreshPanel();
  if (renderScene) renderScene();
}


// Deletes the currently-active room. If it was the only room, the backend
// replaces it with a fresh empty one so the user is never left room-less.
export async function deleteActiveRoom() {
  const idx = state.activeIndex;
  const data = await api.deleteRoom(idx);
  state.rooms = data.rooms;
  state.activeIndex = data.active_index;
  syncActiveRoom();
  state.selectedId = null;
  markClean();
  _renderDots();
  if (refreshPanel) refreshPanel();
  if (renderScene) renderScene();
}


async function _loadRooms() {
  const data = await api.listRooms();
  state.rooms = data.rooms;
  state.activeIndex = data.active_index;
  syncActiveRoom();
  normalizeLayers();
  _migrateToWorldCoords();
}


// We switched from device-CSS-px canvas coords to a fixed 1000×1000
// world. Old rooms have positions in the old CSS-px space (typically
// 0–500 on the creation device). Detect those and scale positions +
// object scale so the arrangement lands in the new world roughly where
// it was visually. If the max position is already >600, assume the
// room was created under the new system and leave it alone. The
// migrated flag prevents re-migration after a save.
function _migrateToWorldCoords() {
  const NEW_WORLD = 1000;
  for (const room of state.rooms || []) {
    if (room.coords_migrated) continue;
    const objs = room.objects || [];
    if (objs.length === 0) { room.coords_migrated = true; continue; }
    let maxAbs = 0;
    for (const o of objs) {
      if (!o.position) continue;
      maxAbs = Math.max(maxAbs, Math.abs(o.position.x || 0),
                                Math.abs(o.position.y || 0));
    }
    if (maxAbs > 600) { room.coords_migrated = true; continue; }
    // Heuristic scale: assume the old canvas was ~ maxAbs*2 (roughly
    // doubled, since items tend to cluster near centre). Fall back to
    // 400 (typical mobile canvas) if the room's contents don't give us
    // enough signal.
    const assumedOldCanvas = Math.max(400, maxAbs * 2);
    const factor = NEW_WORLD / assumedOldCanvas;
    for (const o of objs) {
      if (o.position) {
        o.position.x = (o.position.x || 0) * factor;
        o.position.y = (o.position.y || 0) * factor;
      }
      if (o.scale) {
        o.scale.x = (o.scale.x || 1) * factor;
        o.scale.y = (o.scale.y || 1) * factor;
      }
    }
    room.coords_migrated = true;
    // markDirty so the next save persists the migration.
    state.dirty = true;
  }
}


function _renderDots() {
  if (!dotsEl) return;
  dotsEl.innerHTML = "";
  for (let i = 0; i < state.rooms.length; i++) {
    const dot = document.createElement("button");
    dot.className = "dot" + (i === state.activeIndex ? " active" : "");
    dot.dataset.index = String(i);
    dot.title = `Room ${i + 1}`;
    dotsEl.appendChild(dot);
  }
  const add = document.createElement("button");
  add.className = "dot dot-add";
  add.dataset.add = "1";
  add.title = "New room";
  add.textContent = "+";
  dotsEl.appendChild(add);
}


function _onDotClick(e) {
  const btn = e.target.closest("button");
  if (!btn) return;
  if (btn.dataset.add) { addRoom(); return; }
  const idx = Number(btn.dataset.index);
  if (!Number.isNaN(idx)) switchRoom(idx);
}


// Horizontal swipe on the scene to step rooms. Only fires if we started on
// empty canvas space (no object selected) and the move is horizontal-dominant.
export function attachSceneSwipe(sceneEl) {
  let sx = 0, sy = 0, tracking = false;
  sceneEl.addEventListener("pointerdown", (e) => {
    if (state.view.zoom > 1) return;          // zoomed -> canvas pan handles it
    if (state.selectedId) return;              // don't hijack object interactions
    if (e.target.closest("button, .zoom-controls, .bg-popover, .bg-picker-btn")) return;
    tracking = true;
    sx = e.clientX; sy = e.clientY;
  });
  sceneEl.addEventListener("pointerup", (e) => {
    if (!tracking) return;
    tracking = false;
    const dx = e.clientX - sx;
    const dy = e.clientY - sy;
    if (Math.abs(dx) < 60) return;             // need a decisive swipe
    if (Math.abs(dx) < Math.abs(dy) * 1.5) return; // must be horizontal-dominant
    if (dx < 0) nextRoom(); else prevRoom();
  });
  sceneEl.addEventListener("pointercancel", () => { tracking = false; });
}
