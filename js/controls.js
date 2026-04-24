// Wires up panel buttons + joystick + free-rotate slider.

import { state, markClean, markDirty, syncActiveRoom } from "./state.js";
import {
  bringForward,
  clearSnapshot,
  confirmRemoveObject,
  DEFAULT_ADJUSTMENTS,
  duplicateObject,
  findObject,
  flipHorizontal,
  flipVertical,
  isObjectModifiedSinceSnapshot,
  moveObject,
  revertObject,
  rotateObject,
  scaleObject,
  sendBackward,
  toggleVisibility,
  setAdjustment,
  setRotation,
  snapshotObject,
} from "./objects.js";
import { api } from "./api.js";
import {
  render,
  zoomIn,
  zoomOut,
  resetView,
  getCanvasCenterWorld,
  setAfterRenderHook,
} from "./canvas.js";
import { setMode, refreshForSelection, getMode } from "./panel.js";
import { initJoystick } from "./joystick.js";


// Joystick movement: how many CSS pixels per frame at full deflection.
const JOY_MAX_PX_PER_FRAME = 6;
// D-pad single-click step distance (CSS pixels in world space).
const DPAD_STEP_PX = 16;


export function initControls() {
  document.getElementById("save-btn").addEventListener("click", _saveRoom);
  document.getElementById("reset-btn")?.addEventListener("click", _resetRoom);
  setAfterRenderHook(_syncRevertEnabled);

  document.getElementById("edit-btn").addEventListener("click", () => {
    if (state.selectedId) {
      snapshotObject(state.selectedId);
      _syncSliderFromObject();
      setMode("edit");
    }
  });
  document.getElementById("duplicate-btn")?.addEventListener("click", () => {
    if (!state.selectedId) return;
    const { x, y } = getCanvasCenterWorld();
    const copy = duplicateObject(state.selectedId, x, y);
    if (copy) {
      refreshForSelection();
      render();
    }
  });
  document.getElementById("done-btn").addEventListener("click", () => {
    if (state.selectedId) clearSnapshot(state.selectedId);
    // Exiting edit mode also deactivates any sub-tool so the handle
    // overlay doesn't linger on the scene.
    state.editSubTool = null;
    const shearBtn = document.getElementById("subtool-shear-btn");
    const warpBtn  = document.getElementById("subtool-warp-btn");
    if (shearBtn) shearBtn.classList.remove("active");
    if (warpBtn)  warpBtn.classList.remove("active");
    setMode("selected");
    // Redraw the scene without handles / dashed bbox. Persistence is
    // left to the SAVE pill in the panel header so DONE doesn't
    // silently push every half-formed edit to the server — keeps
    // the Reset / Revert affordances meaningful.
    render();
  });

  document.querySelector(".panel").addEventListener("click", _onPanelClick);

  _initJoystick();
  _initRotationSlider();
  _initPalette();
  _initZoomButtons();
  _initRenameButton();
  _initSubTools();
  setInterval(_updateSaveLabel, 400);
}


// ---------- Per-instance deform sub-tools (shear / warp) ----------

// Greys out Revert when the current selection hasn't been modified
// since it entered edit mode (or has no snapshot at all) — nothing
// to revert. Called from every path that mutates the selected object
// in edit mode so the button reflects live state.
function _objectModifiedSinceSnapshot(obj) {
  return obj ? isObjectModifiedSinceSnapshot(obj.id) : false;
}


export function _syncRevertEnabled() {
  const btn = document.getElementById("subtool-revert-btn");
  if (!btn) return;
  const obj = state.selectedId ? findObject(state.selectedId) : null;
  btn.disabled = !_objectModifiedSinceSnapshot(obj);
}


function _initSubTools() {
  const shearBtn  = document.getElementById("subtool-shear-btn");
  const warpBtn   = document.getElementById("subtool-warp-btn");
  const resetBtn  = document.getElementById("subtool-reset-btn");
  const revertBtn = document.getElementById("subtool-revert-btn");
  if (!shearBtn || !warpBtn || !resetBtn || !revertBtn) return;

  function sync() {
    shearBtn.classList.toggle("active", state.editSubTool === "shear");
    warpBtn.classList.toggle("active",  state.editSubTool === "warp");
  }

  shearBtn.addEventListener("click", () => {
    state.editSubTool = state.editSubTool === "shear" ? null : "shear";
    sync();
    render();
  });
  warpBtn.addEventListener("click", () => {
    state.editSubTool = state.editSubTool === "warp" ? null : "warp";
    sync();
    render();
  });

  // Reset: scoped to whichever sub-tool is active AND also zeros the
  // rotation so "Reset" feels like a full transform reset rather than
  // a no-op when no sub-tool is active. Scale and position are left
  // alone (use Revert for a full-object wipe).
  resetBtn.addEventListener("click", () => {
    const id = state.selectedId;
    const obj = id ? findObject(id) : null;
    if (!obj) return;
    if (obj.rotation_z !== 0) {
      obj.rotation_z = 0;
      markDirty();
    }
    if (state.editSubTool === "shear" && obj.shear) {
      delete obj.shear;
      markDirty();
    } else if (state.editSubTool === "warp" && obj.warp) {
      delete obj.warp;
      markDirty();
    }
    _syncSliderFromObject();
    _syncRevertEnabled();
    render();
  });

  // Revert to original: wipes shear + warp + puts rotation/scale/
  // adjustments back to the pre-edit snapshot — same thing the tap-
  // to-switch flow does. Warns before doing it so the user doesn't
  // lose work by accident.
  revertBtn.addEventListener("click", () => {
    const id = state.selectedId;
    const obj = id ? findObject(id) : null;
    if (!obj) return;
    if (!_objectModifiedSinceSnapshot(obj)) return;
    if (!window.confirm(
      "Revert all changes? This resets the item back to how it looked " +
      "when you opened EDIT (or the catalog image if never edited)."
    )) return;
    revertObject(id);
    _syncSliderFromObject();
    _syncRevertEnabled();
    render();
  });

  _syncRevertEnabled();
}


// ---------- Rename catalog item (admin) ----------

function _initRenameButton() {
  const btn = document.getElementById("rename-btn");
  if (!btn) return;
  btn.addEventListener("click", async () => {
    if (!state.isAdmin) return;
    const id = state.selectedId;
    const obj = id ? findObject(id) : null;
    if (!obj) return;
    const current = (obj.name || "");
    const input = window.prompt(
      "New name (lowercase, spaces become underscores):",
      current
    );
    if (!input) return;
    const newName = input.trim().toLowerCase().replace(/\s+/g, "_").replace(/[^a-z0-9_]/g, "");
    if (!newName || newName === current) return;
    const oldUrl = obj.url;
    try {
      const { url: newUrl, name, asset_id } =
        await api.renameCatalogItem(oldUrl, newName);
      // Mirror the backend's room sweep in local state so the canvas +
      // panel reflect the rename without a full reload. Backend has
      // already written the same changes to every user's saved rooms.
      const parts = newUrl.replace(/^\/catalog\//, "").split("/");
      const [category, subcategory] = parts;
      for (const room of state.rooms) {
        for (const o of room.objects || []) {
          if (o.url === oldUrl) {
            o.url = newUrl;
            o.name = name;
            o.asset_id = asset_id;
            o.tags = [category, subcategory, name];
          }
        }
      }
      // Refresh the catalog listing so the renamed tile appears under its
      // new name.
      const c = await api.catalog();
      state.catalog = c.items;
      state.categories = c.categories;
      const { rebuildCatalog } = await import("./catalog.js");
      rebuildCatalog();
      refreshForSelection();
      render();
    } catch (err) {
      alert(`Rename failed: ${err.message}`);
    }
  });
}


// ---------- Palette sub-mode (4 sliders: hue / sat / bright / contrast) ----------

const ADJUST_SLIDERS = [
  { id: "adj-hue",      key: "hue",        sliderToValue: (v) => v,       valueToSlider: (v) => v,       unit: "°" },
  { id: "adj-sat",      key: "saturation", sliderToValue: (v) => v / 100, valueToSlider: (v) => v * 100, unit: "%" },
  { id: "adj-bright",   key: "brightness", sliderToValue: (v) => v / 100, valueToSlider: (v) => v * 100, unit: "%" },
  { id: "adj-contrast", key: "contrast",   sliderToValue: (v) => v / 100, valueToSlider: (v) => v * 100, unit: "%" },
];


function _initPalette() {
  // Entry/exit: edit mode's 🎨 button opens palette; palette's back button returns.
  document.getElementById("palette-btn").addEventListener("click", () => {
    if (!state.selectedId) return;
    _syncPaletteControls();
    setMode("palette");
  });
  document.getElementById("palette-back").addEventListener("click", () => setMode("edit"));

  document.getElementById("palette-reset").addEventListener("click", () => {
    const id = state.selectedId;
    if (!id) return;
    setAdjustment(id, "hue", 0);
    setAdjustment(id, "saturation", 1);
    setAdjustment(id, "brightness", 1);
    setAdjustment(id, "contrast", 1);
    _syncPaletteControls();
    render();
  });

  _initAdjustSliders();
}


function _initAdjustSliders() {
  for (const cfg of ADJUST_SLIDERS) {
    const slider = document.getElementById(cfg.id);
    const readout = document.getElementById(`${cfg.id}-readout`);
    if (!slider) continue;
    slider.addEventListener("input", () => {
      if (state.selectedIds.size === 0) return;
      const raw = Number(slider.value);
      const value = cfg.sliderToValue(raw);
      // Apply the colour/tone adjustment to every selected object
      // so the palette is a batch operation too.
      for (const id of state.selectedIds) setAdjustment(id, cfg.key, value);
      readout.textContent = `${Math.round(raw)}${cfg.unit}`;
      _applySliderFill(slider);
      render();
    });
    _applySliderFill(slider);
  }
}


function _applySliderFill(slider) {
  const min = Number(slider.min) || 0;
  const max = Number(slider.max) || 100;
  const pct = ((Number(slider.value) - min) / (max - min)) * 100;
  slider.style.setProperty("--pct", `${pct}%`);
}


// Pull the selected object's current adjustments into the sliders. Called
// when entering palette mode and after Reset.
function _syncPaletteControls() {
  const obj = state.selectedId ? findObject(state.selectedId) : null;
  if (!obj) return;
  const adj = obj.adjustments || DEFAULT_ADJUSTMENTS;
  for (const cfg of ADJUST_SLIDERS) {
    const slider = document.getElementById(cfg.id);
    const readout = document.getElementById(`${cfg.id}-readout`);
    if (!slider) continue;
    const raw = Math.round(cfg.valueToSlider(adj[cfg.key]));
    slider.value = String(raw);
    readout.textContent = `${raw}${cfg.unit}`;
    _applySliderFill(slider);
  }
}


// ---------- Zoom buttons (scene overlay) ----------

function _initZoomButtons() {
  document.getElementById("zoom-in-btn").addEventListener("click", zoomIn);
  document.getElementById("zoom-out-btn").addEventListener("click", zoomOut);
  document.getElementById("zoom-reset-btn").addEventListener("click", resetView);
}


// ---------- Joystick ----------

function _initJoystick() {
  initJoystick({
    base: document.getElementById("joystick"),
    knob: document.getElementById("joystick-knob"),
    onMove: (vx, vy) => {
      // Scene is locked unless the user is actively editing an item.
      if (getMode() !== "edit") return;
      const id = state.selectedId;
      if (!id) return;
      const obj = findObject(id);
      if (!obj) return;
      moveObject(
        id,
        obj.position.x + vx * JOY_MAX_PX_PER_FRAME,
        obj.position.y + vy * JOY_MAX_PX_PER_FRAME
      );
      render();
    },
  });
}


// ---------- Rotation slider ----------

function _initRotationSlider() {
  const slider = document.getElementById("rotate-slider");
  const readout = document.getElementById("rotate-readout");

  function applySliderFill() {
    const pct = (slider.value / slider.max) * 100;
    slider.style.setProperty("--pct", `${pct}%`);
  }

  slider.addEventListener("input", () => {
    if (state.selectedIds.size === 0) return;
    const deg = Number(slider.value);
    // Rotate every selected object to the same angle. Using a direct
    // setRotation (not delta) so dragging the slider feels like a
    // uniform re-aim of the whole group.
    for (const id of state.selectedIds) setRotation(id, deg);
    readout.textContent = `${Math.round(deg)}°`;
    applySliderFill();
    render();
  });

  applySliderFill();
}


function _syncSliderFromObject() {
  const obj = state.selectedId ? findObject(state.selectedId) : null;
  const slider = document.getElementById("rotate-slider");
  const readout = document.getElementById("rotate-readout");
  if (!obj || !slider) return;
  slider.value = String(Math.round(obj.rotation_z) % 360);
  readout.textContent = `${Math.round(obj.rotation_z)}°`;
  const pct = (slider.value / slider.max) * 100;
  slider.style.setProperty("--pct", `${pct}%`);
}


// ---------- Click delegation ----------

function _nudgeSelected(id, btn) {
  const dx = Number(btn.dataset.dx) || 0;
  const dy = Number(btn.dataset.dy) || 0;
  const obj = findObject(id);
  if (!obj) return;
  moveObject(id, obj.position.x + dx * DPAD_STEP_PX, obj.position.y + dy * DPAD_STEP_PX);
}


function _onPanelClick(evt) {
  const id = state.selectedId;
  if (!id) return;

  const actionBtn = evt.target.closest("button[data-action]");
  if (!actionBtn) return;

  // Transformative actions (rotate/scale/flip/nudge) apply to every
  // id in the multi-selection so batch-edit behaves as advertised.
  // Single-target actions (delete, layer ↑↓, visibility toggle,
  // undo-to-snapshot) stay scoped to the primary selection to keep
  // their semantics clean.
  const ids = state.selectedIds.size > 0 ? [...state.selectedIds] : [id];
  const forAll = (fn) => { for (const i of ids) fn(i); };

  switch (actionBtn.dataset.action) {
    case "rotate-left":  forAll((i) => rotateObject(i, -90)); _syncSliderFromObject(); break;
    case "rotate-right": forAll((i) => rotateObject(i,  90)); _syncSliderFromObject(); break;
    case "flip-h":       forAll(flipHorizontal); break;
    case "flip-v":       forAll(flipVertical); break;
    case "scale-up":     forAll((i) => scaleObject(i, 1.15)); break;
    case "scale-down":   forAll((i) => scaleObject(i, 1 / 1.15)); break;
    case "layer-up":     bringForward(id); break;
    case "layer-down":   sendBackward(id); break;
    case "toggle-visibility": toggleVisibility(id); refreshForSelection(); break;
    case "delete":       confirmRemoveObject(id); break;
    case "nudge":        forAll((i) => _nudgeSelected(i, actionBtn)); break;
    case "undo":         revertObject(id); _syncSliderFromObject(); break;
  }
  render();
  refreshForSelection();
}


// ---------- Save ----------

async function _saveRoom() {
  const btn = document.getElementById("save-btn");
  btn.textContent = "...";
  try {
    await api.saveRoom(state.activeIndex, state.room);
    markClean();
    btn.textContent = "SAVED";
  } catch (err) {
    btn.textContent = "FAIL";
    console.error(err);
  }
}


// ---------- Reset ----------
//
// Discards any unsaved changes on the active room by re-fetching its
// server copy and swapping it in. Any in-flight edit mode is closed
// so the canvas / panel doesn't keep dangling state (selected id,
// shear handles, etc.) from the discarded version. Save won't fire
// afterwards because markClean() clears dirty + hides the pill.
async function _resetRoom() {
  if (!state.dirty) return;
  if (!window.confirm("Discard all unsaved changes to this room?")) return;
  const btn = document.getElementById("reset-btn");
  const savedLabel = btn?.textContent;
  if (btn) btn.textContent = "...";
  try {
    const fresh = await api.getRoom(state.activeIndex);
    state.rooms[state.activeIndex] = fresh;
    syncActiveRoom();
    state.selectedId = null;
    state.editSubTool = null;
    markClean();
    refreshForSelection();
    render();
  } catch (err) {
    console.error("reset failed", err);
    if (btn) btn.textContent = "FAIL";
    return;
  }
  if (btn) btn.textContent = savedLabel || "RESET";
}


function _updateSaveLabel() {
  const btn = document.getElementById("save-btn");
  if (!btn) return;
  if (state.dirty) btn.textContent = "SAVE";
}
