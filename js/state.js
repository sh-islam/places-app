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
};

// Point `state.room` at the currently-active entry. Call whenever `rooms` or
// `activeIndex` change so the rest of the app keeps seeing one consistent room.
export function syncActiveRoom() {
  const r = state.rooms[state.activeIndex];
  if (r) state.room = r;
}

export function markDirty() {
  state.dirty = true;
  const btn = document.getElementById("save-btn");
  if (btn) { btn.classList.add("unsaved"); btn.textContent = "SAVE"; }
}

export function markClean() {
  state.dirty = false;
  const btn = document.getElementById("save-btn");
  if (btn) btn.classList.remove("unsaved");
}
