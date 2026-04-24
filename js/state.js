// Shared mutable app state. Plain object; modules import and mutate.

export const state = {
  username: null,
  isAdmin: false,
  isSuperadmin: false,
  catalog: [],            // [{asset_id, name, category, tags, url, type}]
  categories: [],

  // Multi-room: the user owns a list of rooms; the active one is editable.
  // `room` is kept as an alias for rooms[activeIndex] so existing modules can
  // keep using `state.room` unchanged.
  rooms: [],
  activeIndex: 0,
  room: { room_id: "", owner: "", background: null, objects: [] },

  selectedId: null,
  // Multi-select: set of object ids the user has picked via long-press
  // (on canvas or an inventory row). `selectedId` is the "primary"
  // selection (latest single tap or most recently added). All entries
  // in this Set get the selection glow; batch-edit operations in edit
  // mode iterate over every id here.
  selectedIds: new Set(),
  dirty: false,           // unsaved changes?
  imageCache: new Map(),  // url -> HTMLImageElement
  // Canvas view transform. zoom=1 = default; pan offsets in CSS pixels.
  // zoom can only go up (>=1); when zoomed, the canvas can be panned and
  // object selection is disabled so dragging only pans.
  view: { zoom: 1, panX: 0, panY: 0 },
  // When true, any item on the canvas can be dragged directly without
  // entering edit mode. Toggled via the lock button in the home tools.
  // Default false so existing behaviour (edit-mode-required) is the norm.
  itemsUnlocked: false,
  // Inside edit mode, an optional sub-tool can be active: "shear" or
  // "warp". When set, the canvas draws handles on the selected item
  // and pointer events on those handles drive obj.shear / obj.warp.
  editSubTool: null,
};

// Point `state.room` at the currently-active entry. Call whenever `rooms` or
// `activeIndex` change so the rest of the app keeps seeing one consistent room.
export function syncActiveRoom() {
  const r = state.rooms[state.activeIndex];
  if (r) state.room = r;
}

// ---------- Selection helpers ----------

// Clear every id and the single-select primary. Used on room-switch,
// delete, tap-on-empty, etc.
export function clearSelection() {
  state.selectedIds.clear();
  state.selectedId = null;
}

// Replace the selection with a single id. Single-tap on an object on
// the canvas or a click on an inventory row calls this.
export function selectSingle(id) {
  state.selectedIds.clear();
  if (id) state.selectedIds.add(id);
  state.selectedId = id;
}

// Toggle membership in the multi-selection. Long-press on an object
// (canvas or inventory row) calls this. Keeps `selectedId` pointing at
// the latest added id so single-item UI (panel thumb, rename, etc.)
// still has something meaningful to show.
export function toggleSelection(id) {
  if (!id) return;
  if (state.selectedIds.has(id)) {
    state.selectedIds.delete(id);
    if (state.selectedId === id) {
      // pick any remaining id as the primary, or null
      state.selectedId = state.selectedIds.values().next().value || null;
    }
  } else {
    state.selectedIds.add(id);
    state.selectedId = id;
  }
}

// True when more than one object is currently selected.
export function isMultiSelect() {
  return state.selectedIds.size > 1;
}


export function markDirty() {
  state.dirty = true;
  const btn = document.getElementById("save-btn");
  if (btn) { btn.classList.add("unsaved"); btn.textContent = "SAVE"; }
  // The RESET button shadows SAVE: it's only visible while there are
  // unsaved changes. Mirroring the same trigger keeps the two in sync
  // without needing a separate signal source.
  const reset = document.getElementById("reset-btn");
  if (reset) reset.hidden = false;
}

export function markClean() {
  state.dirty = false;
  const btn = document.getElementById("save-btn");
  if (btn) btn.classList.remove("unsaved");
  const reset = document.getElementById("reset-btn");
  if (reset) reset.hidden = true;
}
