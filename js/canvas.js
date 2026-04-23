// Canvas rendering, hit-testing, and pointer interaction.

import { state } from "./state.js";
import { getCachedImage, loadImage } from "./images.js";
import {
  addObject,
  createFromCatalog,
  filterStringFor,
  findObject,
  moveObject,
  objectsByLayerAsc,
} from "./objects.js";
import { getMode, refreshForSelection, setMode } from "./panel.js";
import { nextRoom, prevRoom } from "./rooms.js";


let canvas = null;
let ctx = null;

// Either an object-drag or a pan-drag (when zoomed). Mutually exclusive.
let drag = null;          // { id, offsetX, offsetY, moved }
let pan = null;           // { startClientX, startClientY, startPanX, startPanY }
let swipe = null;         // { startX, startY } for room-switching swipe (touch)
const DRAG_THRESHOLD = 4; // px before we count it as a drag
// New items are normalized so they render with the same visual *area* —
// target × target square pixels, regardless of aspect ratio. A wide-short
// image ends up shorter but wider than a portrait one, but their bulk
// matches. Fraction is of the canvas's smaller dimension.
const PLACE_TARGET_FRAC = 0.25;

// Zoom limits. The user can never zoom out past 1 (canvas would underfill).
const MIN_ZOOM = 1;
const MAX_ZOOM = 4;
const ZOOM_STEP = 1.25;

// Hit-testing uses the image's alpha channel so transparent pixels don't count.
// Cache the per-image alpha mask the first time we need it.
const ALPHA_MIN = 16; // 0-255 threshold to consider a pixel "solid"
// Cache entry: { w, h, data: Uint8ClampedArray, bbox: {w, h} }
// bbox is the non-transparent bounding box — used to ignore transparent
// padding when computing a placement scale.
const _alphaCache = new Map();


export function initCanvas(canvasEl) {
  canvas = canvasEl;
  ctx = canvas.getContext("2d");
  _resizeCanvasToBacking();
  window.addEventListener("resize", () => {
    _resizeCanvasToBacking();
    render();
  });
  _wirePointer();
  _wireDropFromCatalog();
}


// Add an item from the catalog at the centre of the visible viewport.
export async function addCatalogItemAtCenter(item) {
  const rect = canvas.getBoundingClientRect();
  const { x, y } = _screenToWorld(rect.width / 2, rect.height / 2);
  await _placeCatalogItem(item, x, y);
}


async function _placeCatalogItem(item, worldX, worldY) {
  // Wait for the image so we can compute a sane initial scale.
  let initialScale = 1;
  try {
    const img = await loadImage(item.url);
    initialScale = _initialScaleForImage(img, item.url);
  } catch (err) {
    console.warn("image load failed; placing at scale 1", err);
  }
  const obj = createFromCatalog(item, worldX, worldY, initialScale);
  addObject(obj);
  refreshForSelection();
  render();
}


function _initialScaleForImage(img, url) {
  // Scale by the geometric mean of the non-transparent content bbox so every
  // new item lands with roughly the same rendered AREA regardless of source
  // aspect ratio or absolute image size. This keeps extreme-landscape images
  // (man_bald_ripped at 1407x768) from looking tiny next to near-square ones.
  const rect = canvas.getBoundingClientRect();
  const target = Math.min(rect.width, rect.height) * PLACE_TARGET_FRAC;
  const cache = _buildAlphaCache(url, img);
  const cw = cache?.bbox?.w || img.naturalWidth;
  const ch = cache?.bbox?.h || img.naturalHeight;
  const sourceChar = Math.sqrt(cw * ch);
  return target / sourceChar;
}


// ---------- Sizing ----------

function _resizeCanvasToBacking() {
  const rect = canvas.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;
  canvas.width  = Math.floor(rect.width  * dpr);
  canvas.height = Math.floor(rect.height * dpr);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
}


// ---------- View (zoom + pan) ----------

export function zoomIn()  { _setZoom(state.view.zoom * ZOOM_STEP); }
export function zoomOut() { _setZoom(state.view.zoom / ZOOM_STEP); }
export function resetView() {
  state.view.zoom = 1;
  state.view.panX = 0;
  state.view.panY = 0;
  render();
}

function _setZoom(nextZoom) {
  const z = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, nextZoom));
  const rect = canvas.getBoundingClientRect();
  const cx = rect.width / 2;
  const cy = rect.height / 2;
  const { x: wx, y: wy } = _screenToWorld(cx, cy);
  state.view.zoom = z;
  state.view.panX = cx - wx * z;
  state.view.panY = cy - wy * z;
  _clampPan(rect);
  render();
}

function _clampPan(rect) {
  const v = state.view;
  const minPanX = rect.width  - rect.width  * v.zoom;
  const minPanY = rect.height - rect.height * v.zoom;
  v.panX = Math.max(minPanX, Math.min(0, v.panX));
  v.panY = Math.max(minPanY, Math.min(0, v.panY));
}

function _screenToWorld(sx, sy) {
  const v = state.view;
  return { x: (sx - v.panX) / v.zoom, y: (sy - v.panY) / v.zoom };
}


// ---------- Render ----------

export function render() {
  if (!ctx) return;
  const rect = canvas.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, rect.width, rect.height);
  ctx.translate(state.view.panX, state.view.panY);
  ctx.scale(state.view.zoom, state.view.zoom);
  _drawBackground(rect);
  for (const obj of objectsByLayerAsc()) {
    _drawObject(obj);
  }
}


function _drawBackground(rect) {
  const url = state.room.background;
  if (!url) return;
  const img = getCachedImage(url);
  if (!img) {
    loadImage(url).then(render).catch(() => {});
    return;
  }
  const cw = rect.width;
  const ch = rect.height;
  const iw = img.naturalWidth;
  const ih = img.naturalHeight;
  const scale = Math.max(cw / iw, ch / ih);
  const dw = iw * scale;
  const dh = ih * scale;
  const dx = (cw - dw) / 2;
  const dy = (ch - dh) / 2;
  ctx.drawImage(img, dx, dy, dw, dh);
}

function _drawObject(obj) {
  if (obj.hidden) return;
  const img = getCachedImage(obj.url);
  if (!img) {
    loadImage(obj.url).then(render).catch(() => {});
    _drawPlaceholderBox(obj);
    return;
  }
  const w = img.naturalWidth;
  const h = img.naturalHeight;
  ctx.save();
  ctx.filter = filterStringFor(obj);
  ctx.translate(obj.position.x, obj.position.y);
  ctx.rotate((obj.rotation_z * Math.PI) / 180);
  ctx.scale(obj.scale.x, obj.scale.y);
  ctx.drawImage(img, -w / 2, -h / 2, w, h);
  ctx.restore();
}

function _drawPlaceholderBox(obj) {
  ctx.save();
  ctx.translate(obj.position.x, obj.position.y);
  ctx.fillStyle = "rgba(255,255,255,0.05)";
  ctx.fillRect(-40, -30, 80, 60);
  ctx.restore();
}


// ---------- Alpha mask (lazy per image) ----------

// Build (and cache) the alpha mask + non-transparent bounding box for a URL.
// Returns the cache entry, or null if we can't read the image's pixels
// (e.g. CORS-tainted canvas).
function _buildAlphaCache(url, img) {
  const cached = _alphaCache.get(url);
  if (cached !== undefined) return cached;   // explicit null cached for failures
  const w = img.naturalWidth;
  const h = img.naturalHeight;
  const off = document.createElement("canvas");
  off.width = w;
  off.height = h;
  const octx = off.getContext("2d");
  octx.drawImage(img, 0, 0);
  let data;
  try {
    data = octx.getImageData(0, 0, w, h).data;
  } catch (err) {
    _alphaCache.set(url, null);
    return null;
  }
  const mask = new Uint8ClampedArray(w * h);
  let minX = w, minY = h, maxX = -1, maxY = -1;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const a = data[(y * w + x) * 4 + 3];
      mask[y * w + x] = a;
      if (a > ALPHA_MIN) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  const bbox = (maxX < 0)
    ? { w, h }                                      // fully transparent — fall back
    : { w: maxX - minX + 1, h: maxY - minY + 1 };
  const entry = { w, h, data: mask, bbox };
  _alphaCache.set(url, entry);
  return entry;
}


function _getAlphaMask(obj) {
  const img = getCachedImage(obj.url);
  if (!img) return null;
  return _buildAlphaCache(obj.url, img);
}


// ---------- Hit test ----------

function _hitTest(px, py) {
  const sorted = objectsByLayerAsc().slice().reverse();
  for (const obj of sorted) {
    if (_pointInsideObject(px, py, obj)) return obj;
  }
  return null;
}

function _pointInsideObject(px, py, obj) {
  const img = getCachedImage(obj.url);
  if (!img) return false;
  // Transform world point into the object's local (unrotated, unscaled) space.
  const dx = px - obj.position.x;
  const dy = py - obj.position.y;
  const rad = -(obj.rotation_z * Math.PI) / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  const lx = (dx * cos - dy * sin) / obj.scale.x;
  const ly = (dx * sin + dy * cos) / obj.scale.y;
  const halfW = img.naturalWidth / 2;
  const halfH = img.naturalHeight / 2;
  if (Math.abs(lx) > halfW || Math.abs(ly) > halfH) return false;
  // Inside the bounding box — check the image's actual alpha at that pixel.
  const mask = _getAlphaMask(obj);
  if (!mask) return true; // fallback: treat as opaque
  const ix = Math.floor(lx + halfW);
  const iy = Math.floor(ly + halfH);
  if (ix < 0 || iy < 0 || ix >= mask.w || iy >= mask.h) return false;
  return mask.data[iy * mask.w + ix] > ALPHA_MIN;
}


// ---------- Pointer interaction ----------

function _wirePointer() {
  canvas.addEventListener("pointerdown", _onPointerDown);
  canvas.addEventListener("pointermove", _onPointerMove);
  canvas.addEventListener("pointerup", _onPointerUp);
  canvas.addEventListener("pointercancel", _onPointerUp);
  canvas.addEventListener("pointerleave", _onPointerUp);
  _wirePinchZoom();
}

function _screenCoords(evt) {
  const rect = canvas.getBoundingClientRect();
  return { x: evt.clientX - rect.left, y: evt.clientY - rect.top };
}

function _onPointerDown(evt) {
  const screen = _screenCoords(evt);
  const world = _screenToWorld(screen.x, screen.y);
  const zoomed = state.view.zoom > 1;
  const editing = getMode() === "edit";

  // Edit mode: the item being edited always drags, zoomed or not. Dragging
  // anywhere else pans when zoomed (so the user can reposition their view
  // mid-edit) or does nothing when not zoomed.
  if (editing) {
    const edited = state.selectedId ? findObject(state.selectedId) : null;
    if (edited && _pointInsideObject(world.x, world.y, edited)) {
      drag = {
        id: edited.id,
        offsetX: world.x - edited.position.x,
        offsetY: world.y - edited.position.y,
        startX: world.x,
        startY: world.y,
        moved: false,
      };
      canvas.setPointerCapture(evt.pointerId);
      return;
    }
    if (zoomed) {
      pan = _startPan(evt);
      canvas.setPointerCapture(evt.pointerId);
    }
    return;
  }

  // Not editing, zoomed: drag pans, tap selects (resolved in _onPointerUp).
  if (zoomed) {
    pan = _startPan(evt);
    canvas.setPointerCapture(evt.pointerId);
    return;
  }

  // Not editing, not zoomed: defer to pointerup to distinguish tap vs swipe.
  swipe = { startX: evt.clientX, startY: evt.clientY };
}


function _startPan(evt) {
  return {
    startClientX: evt.clientX,
    startClientY: evt.clientY,
    startPanX: state.view.panX,
    startPanY: state.view.panY,
    moved: false,
  };
}

function _onPointerMove(evt) {
  if (pan) {
    const dx = evt.clientX - pan.startClientX;
    const dy = evt.clientY - pan.startClientY;
    // Ignore tiny finger jitter so a fat-fingered tap doesn't nudge the pan.
    if (!pan.moved && Math.hypot(dx, dy) < DRAG_THRESHOLD) return;
    pan.moved = true;
    state.view.panX = pan.startPanX + dx;
    state.view.panY = pan.startPanY + dy;
    _clampPan(canvas.getBoundingClientRect());
    render();
    return;
  }
  if (!drag) return;
  const screen = _screenCoords(evt);
  const world = _screenToWorld(screen.x, screen.y);
  if (!drag.moved) {
    if (Math.hypot(world.x - drag.startX, world.y - drag.startY) < DRAG_THRESHOLD) return;
    drag.moved = true;
  }
  moveObject(drag.id, world.x - drag.offsetX, world.y - drag.offsetY);
  render();
}

function _onPointerUp(evt) {
  // Tap-without-drag while zoomed → treat as a selection so the user can
  // inspect items at any zoom. Skipped while editing so we don't swap the
  // active edit-target by accident.
  if (pan && !pan.moved && getMode() !== "edit") {
    const screen = _screenCoords(evt);
    const world = _screenToWorld(screen.x, screen.y);
    const hit = _hitTest(world.x, world.y);
    state.selectedId = hit ? hit.id : null;
    refreshForSelection();
    render();
  }
  if ((drag || pan) && canvas.hasPointerCapture(evt.pointerId)) {
    canvas.releasePointerCapture(evt.pointerId);
  }
  // Not editing, not zoomed: distinguish tap (select) vs swipe (switch room).
  if (swipe) {
    const dx = evt.clientX - swipe.startX;
    const dy = evt.clientY - swipe.startY;
    if (Math.abs(dx) >= 60 && Math.abs(dx) > Math.abs(dy) * 1.5) {
      // Horizontal swipe → switch rooms
      if (dx < 0) nextRoom(); else prevRoom();
    } else {
      // Tap → select object
      const screen = _screenCoords(evt);
      const world = _screenToWorld(screen.x, screen.y);
      const hit = _hitTest(world.x, world.y);
      state.selectedId = hit ? hit.id : null;
      refreshForSelection();
      render();
    }
    swipe = null;
  }
  drag = null;
  pan = null;
}


// ---------- Pinch-to-zoom (touch) ----------

function _wirePinchZoom() {
  let pinch = null; // { dist, zoom, cx, cy }

  canvas.addEventListener("touchstart", (e) => {
    if (e.touches.length === 2) {
      e.preventDefault();
      // Cancel any single-finger interactions
      drag = null; pan = null; swipe = null;
      const t0 = e.touches[0], t1 = e.touches[1];
      pinch = {
        dist: Math.hypot(t1.clientX - t0.clientX, t1.clientY - t0.clientY),
        zoom: state.view.zoom,
        cx: (t0.clientX + t1.clientX) / 2,
        cy: (t0.clientY + t1.clientY) / 2,
      };
    }
  }, { passive: false });

  canvas.addEventListener("touchmove", (e) => {
    if (!pinch || e.touches.length !== 2) return;
    e.preventDefault();
    const t0 = e.touches[0], t1 = e.touches[1];
    const dist = Math.hypot(t1.clientX - t0.clientX, t1.clientY - t0.clientY);
    const scale = dist / pinch.dist;
    const nextZoom = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, pinch.zoom * scale));

    const rect = canvas.getBoundingClientRect();
    const cx = pinch.cx - rect.left;
    const cy = pinch.cy - rect.top;
    const wx = (cx - state.view.panX) / state.view.zoom;
    const wy = (cy - state.view.panY) / state.view.zoom;
    state.view.zoom = nextZoom;
    state.view.panX = cx - wx * nextZoom;
    state.view.panY = cy - wy * nextZoom;
    _clampPan(rect);
    render();
  }, { passive: false });

  canvas.addEventListener("touchend", () => {
    if (pinch) pinch = null;
  });
}


// ---------- Drop from catalog (desktop drag-and-drop) ----------

function _wireDropFromCatalog() {
  canvas.addEventListener("dragover", (e) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = "copy";
  });
  canvas.addEventListener("drop", (e) => {
    e.preventDefault();
    const assetId = e.dataTransfer.getData("text/asset-id");
    if (!assetId) return;
    const item = state.catalog.find((c) => c.asset_id === assetId);
    if (!item) return;
    const screen = _screenCoords(e);
    const world = _screenToWorld(screen.x, screen.y);
    _placeCatalogItem(item, world.x, world.y);
  });
}
