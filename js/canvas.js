// Canvas rendering, hit-testing, and pointer interaction.

import { state, markDirty } from "./state.js";
import { getCachedImage, loadImage } from "./images.js";
import {
  addObject,
  clearSnapshot,
  createFromCatalog,
  DEFAULT_ADJUSTMENTS,
  filterStringFor,
  findObject,
  moveObject,
  objectsByLayerAsc,
  revertObject,
  snapshotObject,
} from "./objects.js";
import { getMode, refreshForSelection, setMode } from "./panel.js";
import { nextRoom, prevRoom } from "./rooms.js";
import { warpImage } from "./homography.js";
import { isAnimatedGifObj, syncGifLayer } from "./gif_layer.js";


let canvas = null;
let ctx = null;

// Either an object-drag or a pan-drag (when zoomed). Mutually exclusive.
let drag = null;          // { id, offsetX, offsetY, moved }
let pan = null;           // { startClientX, startClientY, startPanX, startPanY }
let swipe = null;         // { startX, startY } for room-switching swipe (touch)
let subDrag = null;       // { handleId, obj, startShear, startWarp, startWorld }
const DRAG_THRESHOLD = 4; // px before we count it as a drag
// Double-tap / long-press → enter edit mode. These are the windows.
const DOUBLE_TAP_MS = 350;
const LONG_PRESS_MS = 500;
// Long-press state: timer handle + "fired" flag so the corresponding
// pointerup doesn't also run its normal tap-select logic.
let _longPressTimer = null;
let _longPressFired = false;
// Double-tap state: the id + time of the last successful tap-select.
let _lastTap = null;
// New items are normalized so they render with the same visual *area* —
// target × target square pixels, regardless of aspect ratio. Fraction is
// of the WORLD's smaller dimension so the target is device-independent.
const PLACE_TARGET_FRAC = 0.25;

// Zoom limits. The user can never zoom out past 1 (canvas would underfill).
const MIN_ZOOM = 1;
const MAX_ZOOM = 4;
const ZOOM_STEP = 1.25;

// ---- World-space canvas ----
// Every object's `position` and `scale` are stored in WORLD units, not
// CSS pixels. Rendering fits the world into the current canvas rect
// (contain-style, with letterbox bands on whatever axis is mismatched),
// so a flower at (500, 500) looks the same on desktop as on mobile
// regardless of how big the scene area is.
const WORLD_W = 1000;
const WORLD_H = 1000;

function _fitMetrics(rect) {
  const r = rect || canvas.getBoundingClientRect();
  const fit = Math.min(r.width / WORLD_W, r.height / WORLD_H);
  const offsetX = (r.width  - WORLD_W * fit) / 2;
  const offsetY = (r.height - WORLD_H * fit) / 2;
  return { fit, offsetX, offsetY, rect: r };
}

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
  _syncZoomButtons();
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
  // aspect ratio or absolute image size. Target is expressed in WORLD units
  // so initial size is device-independent.
  const target = Math.min(WORLD_W, WORLD_H) * PLACE_TARGET_FRAC;
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
  _syncZoomButtons();
  render();
}

function _setZoom(nextZoom) {
  const z = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, nextZoom));
  state.view.zoom = z;
  _clampPan();
  _syncZoomButtons();
  render();
}

// Zoom that keeps a given screen point (sx, sy) anchored — i.e. the
// world coord under the cursor stays under the cursor after zoom.
// Used by wheel + pinch.
function _setZoomAt(nextZoom, sx, sy) {
  const z = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, nextZoom));
  if (z === state.view.zoom) return;
  const rect = canvas.getBoundingClientRect();
  const world = _screenToWorld(sx, sy);
  const { fit, offsetX, offsetY } = _fitMetrics(rect);
  const cx = rect.width / 2, cy = rect.height / 2;
  const slX = offsetX + fit * world.x;
  const slY = offsetY + fit * world.y;
  state.view.zoom = z;
  state.view.panX = sx - cx - z * (slX - cx);
  state.view.panY = sy - cy - z * (slY - cy);
  _clampPan();
  _syncZoomButtons();
  render();
}

// Grey out zoom in/out buttons at the respective limits so users get
// a visual cue that they can't go further. Called every time zoom
// changes; cheap enough to run on every _setZoom / wheel frame.
function _syncZoomButtons() {
  const inBtn  = document.getElementById("zoom-in-btn");
  const outBtn = document.getElementById("zoom-out-btn");
  if (inBtn)  inBtn.disabled  = state.view.zoom >= MAX_ZOOM - 1e-6;
  if (outBtn) outBtn.disabled = state.view.zoom <= MIN_ZOOM + 1e-6;
}

function _clampPan() {
  // View-pan lives in SCREEN CSS px. At zoom z the composite is drawn
  // z× its natural size around scene centre; allowed pan is half of
  // that overflow on each axis. At zoom=1 there's no overflow and pan
  // is locked to 0.
  const v = state.view;
  const rect = canvas.getBoundingClientRect();
  const maxPanX = Math.max(0, rect.width  * (v.zoom - 1) / 2);
  const maxPanY = Math.max(0, rect.height * (v.zoom - 1) / 2);
  v.panX = Math.max(-maxPanX, Math.min(maxPanX, v.panX));
  v.panY = Math.max(-maxPanY, Math.min(maxPanY, v.panY));
}

// Post-render hook: controls.js subscribes here to keep the Revert
// button's disabled state in sync with "is the current selection
// modified since its edit-mode snapshot?". A setter sidesteps the
// canvas.js ↔ controls.js import cycle.
let _afterRender = null;
export function setAfterRenderHook(fn) { _afterRender = fn; }


// World coordinate at the centre of the canvas's current view. Used
// by the inventory "centre in canvas" action so an item lands in the
// visible middle regardless of current zoom/pan.
export function getCanvasCenterWorld() {
  const rect = canvas.getBoundingClientRect();
  return _screenToWorld(rect.width / 2, rect.height / 2);
}


function _screenToWorld(sx, sy) {
  // Undo the two-step transform:
  //   1. Outer view (zoom + screen-px pan around scene centre)
  //   2. Fit (world → scene-local)
  const rect = canvas.getBoundingClientRect();
  const cx = rect.width / 2, cy = rect.height / 2;
  const v = state.view;
  // Undo outer view
  const preViewX = (sx - cx - v.panX) / v.zoom + cx;
  const preViewY = (sy - cy - v.panY) / v.zoom + cy;
  // Undo fit
  const { fit, offsetX, offsetY } = _fitMetrics(rect);
  return { x: (preViewX - offsetX) / fit, y: (preViewY - offsetY) / fit };
}


// ---------- Render ----------

export function render() {
  if (!ctx) return;
  // The advanced-edit image editor commandeers #room-canvas to show the
  // edit preview + tool overlays. Skip the scene draw so we don't wipe it.
  // Also hide the GIF overlay so animated items don't float on top of
  // the editor preview; the next normal render unhides it.
  const _gifLayer = document.getElementById("gif-layer");
  if (getMode() === "advanced-edit") {
    if (_gifLayer) _gifLayer.style.display = "none";
    return;
  }
  if (_gifLayer && _gifLayer.style.display === "none") _gifLayer.style.display = "";
  const rect = canvas.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, rect.width, rect.height);
  // Outer view transform: zoom around scene centre + pan in screen
  // pixels. Applies to EVERYTHING drawn after this — both the bg and
  // the items — so hitting the + button scales the entire canvas
  // composite uniformly instead of blowing up the items relative to
  // a stationary bg.
  const cx = rect.width / 2, cy = rect.height / 2;
  ctx.translate(cx + state.view.panX, cy + state.view.panY);
  ctx.scale(state.view.zoom, state.view.zoom);
  ctx.translate(-cx, -cy);

  // Bg: cover-fits the (pre-view) scene rect. Because canvas aspect
  // = world aspect = 1:1, cover = contain; bg fills the square edge
  // to edge on every device.
  _drawBackgroundCoverFit(rect);

  // Items: map world coords (1000×1000) into scene-local via fit.
  // Zoom/pan already handled by the outer transform above.
  const { fit, offsetX, offsetY } = _fitMetrics(rect);
  ctx.translate(offsetX, offsetY);
  ctx.scale(fit, fit);
  for (const obj of objectsByLayerAsc()) {
    // Animated GIFs render through the DOM overlay (canvas drawImage
    // would only paint frame 0). Warped GIFs fall back to canvas — see
    // isAnimatedGifObj for the routing rule.
    if (isAnimatedGifObj(obj)) continue;
    _drawObject(obj);
  }
  // Sub-tool handles for the selected item (shear / warp).
  if (state.editSubTool && state.selectedId) {
    const sel = findObject(state.selectedId);
    if (sel) _drawSubToolOverlay(sel);
  }

  // Mirror canvas transforms onto any DOM-overlay GIFs so they sit
  // exactly where canvas rendering would have placed them.
  syncGifLayer(rect);

  if (_afterRender) _afterRender();
}


// ---- Sub-tool overlay drawing (shear / warp handles) ----
function _drawSubToolOverlay(obj) {
  const img = getCachedImage(obj.url);
  if (!img) return;
  const w = img.naturalWidth;
  const h = img.naturalHeight;
  // Drawn in SCREEN space so handles stay constant size regardless of
  // object scale or scene zoom. We save + reset to CSS-px transform,
  // draw, then restore.
  ctx.save();
  const dpr = window.devicePixelRatio || 1;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

  if (state.editSubTool === "shear") {
    const nw = _worldToScreen(_objLocalToWorld(obj, -w / 2, -h / 2));
    const ne = _worldToScreen(_objLocalToWorld(obj,  w / 2, -h / 2));
    const se = _worldToScreen(_objLocalToWorld(obj,  w / 2,  h / 2));
    const sw = _worldToScreen(_objLocalToWorld(obj, -w / 2,  h / 2));
    const topMid   = _worldToScreen(_objLocalToWorld(obj, 0, -h / 2));
    const rightMid = _worldToScreen(_objLocalToWorld(obj,  w / 2, 0));
    _drawDashedQuad([nw, ne, se, sw]);
    _drawHandle(topMid);
    _drawHandle(rightMid);
  } else if (state.editSubTool === "warp") {
    const corners = obj.warp?.corners || [[0, 0], [w, 0], [w, h], [0, h]];
    const pts = corners.map(([cx, cy]) =>
      _worldToScreen(_objLocalToWorld(obj, cx - w / 2, cy - h / 2)));
    _drawDashedQuad(pts);
    for (const p of pts) _drawHandle(p);
  }

  ctx.restore();
}


function _objLocalToWorld(obj, lx, ly) {
  // Transform order matches _drawObject: scale → shear → rotate → translate.
  let x = lx * (obj.scale?.x || 1);
  let y = ly * (obj.scale?.y || 1);
  const sh = obj.shear;
  if (sh && (sh.kx || sh.ky)) {
    const nx = x + (sh.kx || 0) * y;
    const ny = (sh.ky || 0) * x + y;
    x = nx; y = ny;
  }
  const theta = (obj.rotation_z || 0) * Math.PI / 180;
  const c = Math.cos(theta), s = Math.sin(theta);
  return {
    x: obj.position.x + x * c - y * s,
    y: obj.position.y + x * s + y * c,
  };
}


function _worldToScreen(p) {
  const rect = canvas.getBoundingClientRect();
  const { fit, offsetX, offsetY } = _fitMetrics(rect);
  const cx = rect.width / 2, cy = rect.height / 2;
  const v = state.view;
  // Apply fit (world → scene-local) then outer view
  // (zoom around scene centre + screen-px pan).
  const slX = offsetX + fit * p.x;
  const slY = offsetY + fit * p.y;
  return {
    x: v.zoom * (slX - cx) + cx + v.panX,
    y: v.zoom * (slY - cy) + cy + v.panY,
  };
}


function _drawHandle(p) {
  ctx.beginPath();
  ctx.arc(p.x, p.y, 9, 0, Math.PI * 2);
  ctx.fillStyle = "rgba(255, 255, 255, 0.95)";
  ctx.strokeStyle = "#3a7afe";
  ctx.lineWidth = 2;
  ctx.fill();
  ctx.stroke();
}


function _drawDashedQuad(pts) {
  ctx.save();
  ctx.setLineDash([5, 4]);
  ctx.strokeStyle = "#3a7afe";
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.moveTo(pts[0].x, pts[0].y);
  for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y);
  ctx.closePath();
  ctx.stroke();
  ctx.restore();
}


function _updateSubDrag(world) {
  const obj = subDrag.obj;
  const img = getCachedImage(obj.url);
  if (!img) return;
  const w = img.naturalWidth;
  const h = img.naturalHeight;

  // World drag delta → object-local delta (inverse-rotate only; scale
  // isn't inverted here since we convert to image pixels below).
  const dw = { x: world.x - subDrag.startWorld.x, y: world.y - subDrag.startWorld.y };
  const theta = -(obj.rotation_z || 0) * Math.PI / 180;
  const cos = Math.cos(theta), sin = Math.sin(theta);
  const dLocal = { x: dw.x * cos - dw.y * sin, y: dw.x * sin + dw.y * cos };
  const sx = obj.scale?.x || 1;
  const sy = obj.scale?.y || 1;
  const dImage = { x: dLocal.x / sx, y: dLocal.y / sy };

  if (state.editSubTool === "shear") {
    if (subDrag.handleId === "shear-top") {
      // Top-middle image-local (0, -h/2). Shear sends it to (kx*-h/2, -h/2).
      // Drag's horizontal image-pixel delta dImage.x is how much the handle
      // should shift in x. Solve for new kx: -new*h/2 = -old*h/2 + dImage.x
      // ⇒ new = old - 2*dImage.x/h.
      obj.shear = {
        kx: subDrag.startShear.kx - (2 * dImage.x) / h,
        ky: subDrag.startShear.ky,
      };
    } else if (subDrag.handleId === "shear-right") {
      // Right-middle (w/2, 0) → (w/2, ky*w/2). New ky = old + 2*dImage.y/w.
      obj.shear = {
        kx: subDrag.startShear.kx,
        ky: subDrag.startShear.ky + (2 * dImage.y) / w,
      };
    }
    markDirty();
  } else if (state.editSubTool === "warp") {
    const idx = Number(subDrag.handleId.split("-")[1]);
    const start = subDrag.startWarp?.corners
      || [[0, 0], [w, 0], [w, h], [0, h]];
    const newCorners = start.map((c, i) =>
      i === idx ? [c[0] + dImage.x, c[1] + dImage.y] : [c[0], c[1]]
    );
    obj.warp = { corners: newCorners };
    // The warp cache keys on obj.id and compares signatures — old
    // entries for THIS obj get overwritten automatically in
    // _getWarpedCanvas on the next render. No explicit eviction needed.
    markDirty();
  }
}


function _hitHandle(obj, screenX, screenY) {
  const img = getCachedImage(obj.url);
  if (!img) return null;
  const w = img.naturalWidth;
  const h = img.naturalHeight;
  const hitRadius = 14;
  const tests = [];
  if (state.editSubTool === "shear") {
    tests.push({ id: "shear-top",   p: _worldToScreen(_objLocalToWorld(obj, 0, -h / 2)) });
    tests.push({ id: "shear-right", p: _worldToScreen(_objLocalToWorld(obj, w / 2, 0)) });
  } else if (state.editSubTool === "warp") {
    const corners = obj.warp?.corners || [[0, 0], [w, 0], [w, h], [0, h]];
    corners.forEach(([cx, cy], i) => {
      tests.push({
        id: "warp-" + i,
        p: _worldToScreen(_objLocalToWorld(obj, cx - w / 2, cy - h / 2)),
      });
    });
  }
  for (const { id, p } of tests) {
    const dx = screenX - p.x;
    const dy = screenY - p.y;
    if (dx * dx + dy * dy <= hitRadius * hitRadius) return id;
  }
  return null;
}


// Clear the cached alpha-mask + content bbox for a catalog URL. Call
// after /api/catalog/overwrite so the next render uses the fresh image's
// mask for hit-testing (otherwise old erased regions would still seem
// "hit-solid").
export function invalidateAlphaCache(url) {
  _alphaCache.delete(url);
}


function _drawBackgroundCoverFit(rect) {
  const url = state.room.background;
  if (!url) return;
  const img = getCachedImage(url);
  if (!img) {
    loadImage(url).then(render).catch(() => {});
    return;
  }
  // Cover-fit the bg into the scene rect (CSS px). Bg always fills edge
  // to edge; some of the bg may be cropped on aspects different from
  // the bg's natural aspect, but there are never empty bands.
  const iw = img.naturalWidth;
  const ih = img.naturalHeight;
  const scale = Math.max(rect.width / iw, rect.height / ih);
  const dw = iw * scale;
  const dh = ih * scale;
  const dx = (rect.width - dw) / 2;
  const dy = (rect.height - dh) / 2;
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
  // Per-instance perspective warp: when obj.warp.corners is set, we
  // render a pre-computed warped bitmap (cached per-corner-set) in
  // place of the source image. The bitmap's dimensions = quad bbox,
  // so centring its own (w, h) keeps the warp visually anchored on
  // obj.position regardless of how far corners were dragged.
  const warped = obj.warp ? _getWarpedCanvas(obj, img) : null;
  let source = warped ? warped.canvas : img;
  // Hue / sat / brightness / contrast adjustments: baked into an
  // off-screen canvas via per-pixel math and cached, instead of
  // relying on ctx.filter. Some mobile browsers (iOS Safari ≤17.3,
  // some Chromium forks) silently drop ctx.filter + drawImage, which
  // made adjustments invisible on one device while desktop looked
  // right. Pixel baking is consistent across every browser.
  const filterStr = filterStringFor(obj);
  if (filterStr !== "none") {
    source = _getFilteredCanvas(obj, source, filterStr);
  }
  const w = source.naturalWidth || source.width;
  const h = source.naturalHeight || source.height;

  ctx.save();
  ctx.translate(obj.position.x, obj.position.y);
  ctx.rotate((obj.rotation_z * Math.PI) / 180);
  ctx.scale(obj.scale.x, obj.scale.y);

  // Per-instance shear. kx/ky are tan values (small number, typically
  // in [-1, 1]). Canvas 2D transform matrix (a,b,c,d,e,f) where
  //   x' = a*x + c*y + e;  y' = b*x + d*y + f.
  // We want x' = x + kx*y, y' = ky*x + y, so (1, ky, kx, 1, 0, 0).
  const sh = obj.shear;
  if (sh && (sh.kx || sh.ky)) {
    ctx.transform(1, sh.ky || 0, sh.kx || 0, 1, 0, 0);
  }

  // Selected item: soft accent-tinted shadow that hugs the image's
  // alpha silhouette (no outline, transparent PNG regions stay clear).
  if (obj.id === state.selectedId) {
    ctx.shadowColor = "rgba(80, 150, 255, 0.93)";
    ctx.shadowBlur = 54;
  }
  ctx.drawImage(source, -w / 2, -h / 2, w, h);
  ctx.restore();
}


// ---- Per-object perspective-warp bitmap cache ----
// Key = obj.id. Value = { url, sig, result } where sig is a
// rounded-corner signature so sub-pixel jitter doesn't bust the cache
// and each object only ever holds ONE cached bitmap at a time (old
// entry gets overwritten when the signature changes). URL is carried
// so invalidateWarpCache(url) can sweep stale entries when the
// underlying catalog file is overwritten.
const _warpCache = new Map();

function _getWarpedCanvas(obj, img) {
  if (!obj.warp || !obj.warp.corners) return null;
  const sig = obj.warp.corners.flat().map((n) => n.toFixed(1)).join(",");
  const existing = _warpCache.get(obj.id);
  if (existing && existing.sig === sig && existing.url === obj.url) {
    return existing.result;
  }
  const result = warpImage(img, obj.warp.corners);
  _warpCache.set(obj.id, { url: obj.url, sig, result });
  return result;
}

export function invalidateWarpCache(url) {
  for (const [id, entry] of _warpCache) {
    if (entry.url === url) _warpCache.delete(id);
  }
}


// ---- Per-object filter (hue / sat / brightness / contrast) cache ----
// ctx.filter + drawImage is flaky on older mobile Safari and some
// Chromium forks (silently skipped → adjustments don't show). We bake
// the filter into an off-screen canvas via a pure-JS per-pixel pass,
// keyed on obj.id, so every browser gets identical output. Cache
// holds {sourceRef, sig, canvas}; invalidates automatically when the
// source reference OR the filter signature changes.
const _filteredCache = new Map();

function _getFilteredCanvas(obj, source, filterStr) {
  const existing = _filteredCache.get(obj.id);
  if (existing && existing.sourceRef === source && existing.sig === filterStr) {
    return existing.canvas;
  }
  const w = source.naturalWidth || source.width;
  const h = source.naturalHeight || source.height;
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  const cx = c.getContext("2d");
  cx.drawImage(source, 0, 0);
  try {
    const imageData = cx.getImageData(0, 0, w, h);
    _applyFiltersPixels(imageData, obj.adjustments || DEFAULT_ADJUSTMENTS);
    cx.putImageData(imageData, 0, 0);
  } catch (e) {
    // CORS-tainted canvases can't be read; fall back to unfiltered.
    console.warn("pixel filter failed (tainted canvas?)", e);
    return source;
  }
  _filteredCache.set(obj.id, { sourceRef: source, sig: filterStr, canvas: c });
  return c;
}


// Pixel-pass hue rotation + saturation + brightness + contrast.
// Matches CSS filter ordering: hue-rotate → saturate → brightness →
// contrast. Hue rotation matrix is the CSS-standard luminance-
// preserving formulation.
function _applyFiltersPixels(imageData, adjustments) {
  const a = adjustments;
  const hue = a.hue || 0;
  const sat = a.saturation == null ? 1 : a.saturation;
  const bri = a.brightness == null ? 1 : a.brightness;
  const con = a.contrast   == null ? 1 : a.contrast;

  const d = imageData.data;
  const cosH = Math.cos(hue * Math.PI / 180);
  const sinH = Math.sin(hue * Math.PI / 180);
  const m00 = 0.213 + 0.787 * cosH - 0.213 * sinH;
  const m01 = 0.715 - 0.715 * cosH - 0.715 * sinH;
  const m02 = 0.072 - 0.072 * cosH + 0.928 * sinH;
  const m10 = 0.213 - 0.213 * cosH + 0.143 * sinH;
  const m11 = 0.715 + 0.285 * cosH + 0.140 * sinH;
  const m12 = 0.072 - 0.072 * cosH - 0.283 * sinH;
  const m20 = 0.213 - 0.213 * cosH - 0.787 * sinH;
  const m21 = 0.715 - 0.715 * cosH + 0.715 * sinH;
  const m22 = 0.072 + 0.928 * cosH + 0.072 * sinH;

  for (let i = 0; i < d.length; i += 4) {
    if (d[i + 3] === 0) continue;  // fully transparent
    const r = d[i], g = d[i + 1], b = d[i + 2];
    let nr = r * m00 + g * m01 + b * m02;
    let ng = r * m10 + g * m11 + b * m12;
    let nb = r * m20 + g * m21 + b * m22;
    // Saturate (pull toward luma)
    const luma = 0.2126 * nr + 0.7152 * ng + 0.0722 * nb;
    nr = luma + (nr - luma) * sat;
    ng = luma + (ng - luma) * sat;
    nb = luma + (nb - luma) * sat;
    // Brightness
    nr *= bri; ng *= bri; nb *= bri;
    // Contrast around 128 (CSS contrast model)
    nr = (nr - 128) * con + 128;
    ng = (ng - 128) * con + 128;
    nb = (nb - 128) * con + 128;
    d[i]     = nr < 0 ? 0 : nr > 255 ? 255 : nr;
    d[i + 1] = ng < 0 ? 0 : ng > 255 ? 255 : ng;
    d[i + 2] = nb < 0 ? 0 : nb > 255 ? 255 : nb;
  }
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

function _pointInsideObject(px, py, obj, bboxOnly = false) {
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
  // bboxOnly skips the alpha check so the caller can drag items whose
  // visible pixels are sparse (mostly-white/transparent) without the
  // pointer having to land on a solid pixel. Used by edit mode where
  // the user has already committed to a specific object.
  if (bboxOnly) return true;
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
  _wireWheelZoom();
}

// Desktop wheel-zoom: scrolling while hovering the canvas zooms the
// composite. Anchors to cursor position so the world point under the
// pointer stays put under the pointer. deltaY is mapped through exp()
// so the zoom curve is smooth and proportional regardless of whether
// the browser reports pixels, lines, or pages.
function _wireWheelZoom() {
  canvas.addEventListener("wheel", (e) => {
    e.preventDefault();
    const rect = canvas.getBoundingClientRect();
    const sx = e.clientX - rect.left;
    const sy = e.clientY - rect.top;
    const factor = Math.exp(-e.deltaY * 0.001);
    _setZoomAt(state.view.zoom * factor, sx, sy);
  }, { passive: false });
}

function _screenCoords(evt) {
  const rect = canvas.getBoundingClientRect();
  return { x: evt.clientX - rect.left, y: evt.clientY - rect.top };
}

function _enterEditMode(id) {
  const obj = findObject(id);
  if (!obj) return;
  state.selectedId = id;
  snapshotObject(id);
  setMode("edit");
  refreshForSelection();
  render();
}


function _cancelLongPress() {
  if (_longPressTimer) {
    clearTimeout(_longPressTimer);
    _longPressTimer = null;
  }
}


// Resolve a tap-up to a selection, with double-tap-to-edit as a
// short-circuit: tapping the same object twice within DOUBLE_TAP_MS
// drops into edit mode on that item. Otherwise just sets the
// selection (or clears it on an empty-space tap).
function _handleTapSelect(evt) {
  const screen = _screenCoords(evt);
  const world = _screenToWorld(screen.x, screen.y);
  const hit = _hitTest(world.x, world.y);
  const now = Date.now();
  if (hit && _lastTap && _lastTap.id === hit.id && now - _lastTap.t <= DOUBLE_TAP_MS) {
    _lastTap = null;
    _enterEditMode(hit.id);
    return;
  }
  state.selectedId = hit ? hit.id : null;
  _lastTap = hit ? { id: hit.id, t: now } : null;
  refreshForSelection();
  render();
}


function _onPointerDown(evt) {
  const screen = _screenCoords(evt);
  const world = _screenToWorld(screen.x, screen.y);
  const zoomed = state.view.zoom > 1;
  const editing = getMode() === "edit";

  // Long-press → enter edit mode. Only armed when we're not already
  // editing (re-entering from inside edit mode doesn't make sense)
  // and when the press lands on an actual object. Timer gets
  // cancelled on any meaningful move (see _onPointerMove) or on
  // release (see _onPointerUp). The "_longPressFired" flag tells
  // pointer-up to swallow the release so it doesn't also run the
  // normal tap-select logic right after we just opened edit mode.
  _longPressFired = false;
  _cancelLongPress();
  if (!editing) {
    const hit = _hitTest(world.x, world.y);
    if (hit) {
      const targetId = hit.id;
      _longPressTimer = setTimeout(() => {
        _longPressTimer = null;
        _longPressFired = true;
        _enterEditMode(targetId);
      }, LONG_PRESS_MS);
    }
  }

  // Edit-mode sub-tools (shear / warp): if the pointer lands on a
  // handle of the selected item, start a handle drag and short-circuit
  // the rest of the flow. Misses fall through to the normal paths.
  if (editing && state.editSubTool && state.selectedId) {
    const obj = findObject(state.selectedId);
    if (obj) {
      const handleId = _hitHandle(obj, screen.x, screen.y);
      if (handleId) {
        subDrag = {
          handleId,
          obj,
          startShear: obj.shear
            ? { kx: obj.shear.kx || 0, ky: obj.shear.ky || 0 }
            : { kx: 0, ky: 0 },
          startWarp: obj.warp
            ? { corners: obj.warp.corners.map((c) => [c[0], c[1]]) }
            : null,
          startWorld: world,
        };
        canvas.setPointerCapture(evt.pointerId);
        return;
      }
    }
  }

  // "Unlock all items" (home menu toggle) lets the user drag any item
  // directly without entering edit mode. A press that lands on an item
  // starts a drag + selects it; a press that misses falls through to
  // the normal pan/swipe flow so room-swipe and canvas-pan still work.
  if (state.itemsUnlocked && !editing) {
    const hit = _hitTest(world.x, world.y);
    if (hit) {
      state.selectedId = hit.id;
      refreshForSelection();
      drag = {
        id: hit.id,
        offsetX: world.x - hit.position.x,
        offsetY: world.y - hit.position.y,
        startX: world.x,
        startY: world.y,
        moved: false,
      };
      canvas.setPointerCapture(evt.pointerId);
      render();
      return;
    }
  }

  // Edit mode: the item being edited always drags, zoomed or not. Dragging
  // anywhere else pans when zoomed (so the user can reposition their view
  // mid-edit) or does nothing when not zoomed. Bbox-only hit test here so
  // mostly-transparent / mostly-white images can still be grabbed anywhere
  // inside their rectangle — alpha masks exclude the padding pixels.
  if (editing) {
    const edited = state.selectedId ? findObject(state.selectedId) : null;
    if (edited && _pointInsideObject(world.x, world.y, edited, true)) {
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
  if (subDrag) {
    const screen = _screenCoords(evt);
    const world = _screenToWorld(screen.x, screen.y);
    _updateSubDrag(world);
    render();
    return;
  }
  if (pan) {
    const dx = evt.clientX - pan.startClientX;
    const dy = evt.clientY - pan.startClientY;
    // Ignore tiny finger jitter so a fat-fingered tap doesn't nudge the pan.
    if (!pan.moved && Math.hypot(dx, dy) < DRAG_THRESHOLD) return;
    pan.moved = true;
    _cancelLongPress();
    // Pan lives in SCREEN CSS-px under the new outer-view transform;
    // 1 px of finger drag = 1 px of composite shift.
    state.view.panX = pan.startPanX + dx;
    state.view.panY = pan.startPanY + dy;
    _clampPan();
    render();
    return;
  }
  if (!drag) return;
  const screen = _screenCoords(evt);
  const world = _screenToWorld(screen.x, screen.y);
  if (!drag.moved) {
    if (Math.hypot(world.x - drag.startX, world.y - drag.startY) < DRAG_THRESHOLD) return;
    drag.moved = true;
    _cancelLongPress();
  }
  moveObject(drag.id, world.x - drag.offsetX, world.y - drag.offsetY);
  render();
}

function _onPointerUp(evt) {
  // Long-press may still be pending if the user released before the
  // timer fired; cancel it so a short tap doesn't accidentally enter
  // edit mode after release.
  _cancelLongPress();
  // If the long-press timer already fired we've already entered edit
  // mode on a held item — swallow the corresponding release so the
  // tap-select path below doesn't immediately re-run and re-select.
  if (_longPressFired) {
    _longPressFired = false;
    if (canvas.hasPointerCapture(evt.pointerId)) {
      canvas.releasePointerCapture(evt.pointerId);
    }
    drag = null; pan = null; swipe = null;
    return;
  }
  if (subDrag) {
    if (canvas.hasPointerCapture(evt.pointerId)) {
      canvas.releasePointerCapture(evt.pointerId);
    }
    subDrag = null;
    return;
  }
  // Edit-mode tap on a DIFFERENT object: exit edit, revert the
  // currently-edited object to its pre-edit snapshot, and switch
  // selection. Users asked to be able to jump to another item mid-
  // edit instead of having to DONE out first. Only fires when this
  // pointer didn't drag or pan anything, and only when the tap
  // lands on a real object that isn't the one being edited.
  if (getMode() === "edit" && !drag && (!pan || !pan.moved)) {
    const scr = _screenCoords(evt);
    const wld = _screenToWorld(scr.x, scr.y);
    const hit = _hitTest(wld.x, wld.y);
    if (hit && hit.id !== state.selectedId) {
      if (state.selectedId) {
        revertObject(state.selectedId);
        clearSnapshot(state.selectedId);
      }
      state.selectedId = hit.id;
      state.editSubTool = null;
      const shearBtn = document.getElementById("subtool-shear-btn");
      const warpBtn  = document.getElementById("subtool-warp-btn");
      if (shearBtn) shearBtn.classList.remove("active");
      if (warpBtn)  warpBtn.classList.remove("active");
      setMode("selected");
      refreshForSelection();
      render();
      if ((drag || pan) && canvas.hasPointerCapture(evt.pointerId)) {
        canvas.releasePointerCapture(evt.pointerId);
      }
      drag = null; pan = null; swipe = null;
      return;
    }
  }
  // Tap-without-drag while zoomed → treat as a selection so the user can
  // inspect items at any zoom. Skipped while editing so we don't swap the
  // active edit-target by accident.
  if (pan && !pan.moved && getMode() !== "edit") {
    _handleTapSelect(evt);
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
      // Tap → select object (double-tap same object → edit mode)
      _handleTapSelect(evt);
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
    // Keep the world point under the pinch centre fixed on-screen.
    // Under the outer-view transform:
    //   screen = v.zoom * (slX - cx) + cx + v.panX   (where slX = offsetX + fit * world.x)
    // Solving for panX after the zoom change:
    //   panX = scx - cx - nextZoom * (slX - cx)
    const scx = pinch.cx - rect.left;
    const scy = pinch.cy - rect.top;
    const world = _screenToWorld(scx, scy);
    const { fit, offsetX, offsetY } = _fitMetrics(rect);
    const cx = rect.width / 2, cy = rect.height / 2;
    const slX = offsetX + fit * world.x;
    const slY = offsetY + fit * world.y;
    state.view.zoom = nextZoom;
    state.view.panX = scx - cx - nextZoom * (slX - cx);
    state.view.panY = scy - cy - nextZoom * (slY - cy);
    _clampPan();
    _syncZoomButtons();
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
