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

  // When the user tabs back to the app (or returns from a minimized
  // browser), re-pull rooms from the server so edits made on another
  // device — hue/sat tweaks, object moves, shear/warp — actually show
  // up. Skips if we have unsaved local changes so we don't stomp them.
  document.addEventListener("visibilitychange", async () => {
    if (document.visibilityState !== "visible") return;
    if (state.dirty) return;  // don't overwrite pending local edits
    try {
      const data = await api.listRooms();
      state.rooms = data.rooms;
      state.activeIndex = data.active_index;
      syncActiveRoom();
      normalizeLayers();
      if (renderScene) renderScene();
    } catch (e) {
      console.warn("visibility-change refresh failed", e);
    }
  });
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
  const migrated = _migrateToWorldCoords();
  if (migrated) {
    // Persist the migration immediately so other devices don't re-run
    // their own migration (and race into a different result). Best-
    // effort — if the save fails the next manual SAVE click still fixes
    // it.
    try {
      for (let i = 0; i < state.rooms.length; i++) {
        await api.saveRoom(i, state.rooms[i]);
      }
      markClean();
    } catch (e) {
      console.warn("auto-save after world-coord migration failed", e);
    }
  }
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
  // Deterministic factor: any two devices migrating the same room data
  // agree on the result. 2.5× maps a legacy ~400-px-wide canvas into
  // the new 1000-unit world; close enough that items land roughly where
  // they were, and user can nudge the rest.
  const FACTOR = 2.5;
  let anyMigrated = false;
  for (const room of state.rooms || []) {
    if (room.coords_migrated) continue;
    const objs = room.objects || [];
    if (objs.length === 0) { room.coords_migrated = true; anyMigrated = true; continue; }
    let maxAbs = 0;
    for (const o of objs) {
      if (!o.position) continue;
      maxAbs = Math.max(maxAbs, Math.abs(o.position.x || 0),
                                Math.abs(o.position.y || 0));
    }
    // Already in world units? Just flag and skip.
    if (maxAbs > 600) { room.coords_migrated = true; anyMigrated = true; continue; }
    for (const o of objs) {
      if (o.position) {
        o.position.x = (o.position.x || 0) * FACTOR;
        o.position.y = (o.position.y || 0) * FACTOR;
      }
      if (o.scale) {
        o.scale.x = (o.scale.x || 1) * FACTOR;
        o.scale.y = (o.scale.y || 1) * FACTOR;
      }
    }
    room.coords_migrated = true;
    anyMigrated = true;
  }
  return anyMigrated;
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
