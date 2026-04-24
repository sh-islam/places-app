// Pure-ish helpers to create and manipulate room objects.

import { state, markDirty } from "./state.js";
import { itemDisplayName } from "./labels.js";

let _idCounter = 1;

function nextId() {
  return `obj_${Date.now()}_${_idCounter++}`;
}

function topLayer() {
  if (state.room.objects.length === 0) return 1;
  return Math.max(...state.room.objects.map((o) => o.layer)) + 1;
}

// Default per-object colour adjustments. Values match CSS/canvas filter
// semantics directly: hue in degrees, the rest as multiplicative factors
// where 1.0 means "unchanged".
export const DEFAULT_ADJUSTMENTS = { hue: 0, saturation: 1, brightness: 1, contrast: 1 };

export function createFromCatalog(catalogItem, x, y, initialScale = 1) {
  return {
    id: nextId(),
    asset_id: catalogItem.asset_id,
    name: catalogItem.name,
    type: catalogItem.type || "2D",
    url: catalogItem.url,
    position: { x, y },
    scale: { x: initialScale, y: initialScale },
    rotation_z: 0,
    layer: topLayer(),
    tags: [...(catalogItem.tags || [])],
    adjustments: { ...DEFAULT_ADJUSTMENTS },
  };
}

export function addObject(obj) {
  state.room.objects.push(obj);
  state.selectedId = obj.id;
  markDirty();
}

// Duplicate an existing object: same URL / scale / shear / adjustments /
// etc., new id, placed at a world point the caller chooses (usually
// canvas centre), and promoted to the top layer. The original stays
// put; the duplicate becomes the selected item.
export function duplicateObject(id, x, y) {
  const src = findObject(id);
  if (!src) return null;
  const copy = JSON.parse(JSON.stringify(src));
  copy.id = nextId();
  copy.position = { x, y };
  copy.layer = topLayer();
  state.room.objects.push(copy);
  state.selectedId = copy.id;
  markDirty();
  return copy;
}

export function findObject(id) {
  return state.room.objects.find((o) => o.id === id) || null;
}

export function removeObject(id) {
  const idx = state.room.objects.findIndex((o) => o.id === id);
  if (idx === -1) return;
  state.room.objects.splice(idx, 1);
  if (state.selectedId === id) state.selectedId = null;
  markDirty();
}

// Prompt before removing — delete is destructive and un-undoable.
// Returns true if the object was removed.
export function confirmRemoveObject(id) {
  const obj = findObject(id);
  if (!obj) return false;
  const name = itemDisplayName(obj.name || obj.asset_id);
  if (!window.confirm(`Delete "${name}" from this room?`)) return false;
  removeObject(id);
  return true;
}

// Per-edit snapshots. Keyed by object id; holds the object state at the
// moment the user entered edit mode, so Undo can revert in-place.
const _snapshots = new Map();

export function snapshotObject(id) {
  const o = findObject(id);
  if (!o) return;
  _snapshots.set(id, JSON.parse(JSON.stringify(o)));
}

export function revertObject(id) {
  const snap = _snapshots.get(id);
  const o = findObject(id);
  if (!snap || !o) return;
  o.position = { ...snap.position };
  o.scale = { ...snap.scale };
  o.rotation_z = snap.rotation_z;
  o.layer = snap.layer;
  o.adjustments = { ...(snap.adjustments || DEFAULT_ADJUSTMENTS) };
  // Shear and warp also live per-instance and mutate during edit —
  // include them here so Undo/revert really restores the pre-edit
  // state end-to-end. Snapshot may or may not carry these fields
  // depending on whether the object had them when edit started.
  if (snap.shear) o.shear = { ...snap.shear };
  else delete o.shear;
  if (snap.warp)  o.warp  = JSON.parse(JSON.stringify(snap.warp));
  else delete o.warp;
  markDirty();
}

export function clearSnapshot(id) {
  _snapshots.delete(id);
}


// True iff the current object differs from its pre-edit snapshot
// across any of the fields revertObject restores. No snapshot means
// nothing to compare to (Revert is a no-op for that case), so
// return false.
export function isObjectModifiedSinceSnapshot(id) {
  const snap = _snapshots.get(id);
  const o = findObject(id);
  if (!snap || !o) return false;
  const fields = ["position", "scale", "rotation_z", "layer",
                  "adjustments", "shear", "warp"];
  for (const k of fields) {
    if (JSON.stringify(o[k]) !== JSON.stringify(snap[k])) return true;
  }
  return false;
}


// Per-object color adjustments. `key` is one of hue|saturation|brightness|contrast.
// Missing `adjustments` on older/migrated objects is lazily filled with defaults.
export function setAdjustment(id, key, value) {
  const o = findObject(id);
  if (!o) return;
  if (!o.adjustments) o.adjustments = { ...DEFAULT_ADJUSTMENTS };
  o.adjustments[key] = value;
  markDirty();
}


// Build a canvas/ctx.filter string for the object. Returns "none" when the
// adjustments are neutral so we don't pay for a needless filter pass.
export function filterStringFor(obj) {
  const a = obj.adjustments || DEFAULT_ADJUSTMENTS;
  const neutral =
    a.hue === 0 && a.saturation === 1 && a.brightness === 1 && a.contrast === 1;
  if (neutral) return "none";
  return `hue-rotate(${a.hue}deg) saturate(${a.saturation}) brightness(${a.brightness}) contrast(${a.contrast})`;
}


export function moveObject(id, x, y) {
  const o = findObject(id);
  if (!o) return;
  o.position.x = x;
  o.position.y = y;
  markDirty();
}

// Step rotation. deltaDeg can be 90 / -90 (preset) or any number (slider).
export function rotateObject(id, deltaDeg) {
  const o = findObject(id);
  if (!o) return;
  o.rotation_z = _normalizeAngle(o.rotation_z + deltaDeg);
  markDirty();
}

// Free rotation: set absolute angle in degrees.
export function setRotation(id, deg) {
  const o = findObject(id);
  if (!o) return;
  o.rotation_z = _normalizeAngle(deg);
  markDirty();
}

function _normalizeAngle(deg) {
  return ((deg % 360) + 360) % 360;
}

export function scaleObject(id, factor) {
  const o = findObject(id);
  if (!o) return;
  // Preserve flip sign while scaling magnitude. No clamps — any size allowed.
  o.scale.x = _scaleSigned(o.scale.x, factor);
  o.scale.y = _scaleSigned(o.scale.y, factor);
  markDirty();
}

function _scaleSigned(value, factor) {
  const sign = value < 0 ? -1 : 1;
  return Math.abs(value) * factor * sign;
}

export function flipHorizontal(id) {
  const o = findObject(id);
  if (!o) return;
  o.scale.x *= -1;
  markDirty();
}

export function flipVertical(id) {
  const o = findObject(id);
  if (!o) return;
  o.scale.y *= -1;
  markDirty();
}

export function toggleVisibility(id) {
  const o = findObject(id);
  if (!o) return;
  o.hidden = !o.hidden;
  markDirty();
}

export function bringForward(id) {
  const sorted = objectsByLayerAsc();
  const idx = sorted.findIndex((o) => o.id === id);
  if (idx === -1 || idx === sorted.length - 1) return; // already on top
  // Swap layers with the one above
  const cur = sorted[idx];
  const above = sorted[idx + 1];
  const tmp = cur.layer;
  cur.layer = above.layer;
  above.layer = tmp;
  // If they had the same layer, nudge
  if (cur.layer === above.layer) cur.layer++;
  markDirty();
}

export function sendBackward(id) {
  const sorted = objectsByLayerAsc();
  const idx = sorted.findIndex((o) => o.id === id);
  if (idx <= 0) return; // already on bottom
  // Swap layers with the one below
  const cur = sorted[idx];
  const below = sorted[idx - 1];
  const tmp = cur.layer;
  cur.layer = below.layer;
  below.layer = tmp;
  // If they had the same layer, nudge
  if (cur.layer === below.layer) cur.layer--;
  markDirty();
}

// Normalize layers to 1,2,3,... so they stay clean.
export function normalizeLayers() {
  const sorted = [...state.room.objects].sort((a, b) => (a.layer || 0) - (b.layer || 0));
  sorted.forEach((o, i) => { o.layer = i + 1; });
}

export function objectsByLayerAsc() {
  return [...state.room.objects].sort((a, b) => a.layer - b.layer);
}
