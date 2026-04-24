// DOM overlay that hosts items as <img> elements stacked over the
// canvas. Every non-warped object (PNG or GIF) is routed here so
// that z-order via CSS z-index honours obj.layer across the whole
// scene — not just among GIFs. Canvas is left with the background
// plus any warped items (4-point perspective warp has no CSS
// equivalent, so those still need the pixel-remap fallback).
//
// Each render() of the canvas calls syncOverlayLayer() with the
// scene rect; the CSS matrix on each <img> mirrors the canvas's
// OuterView * Fit * T(pos) * R * S * Sh chain exactly so positions
// and transforms line up. CSS filter carries hue/sat/brightness/
// contrast and the selected-glow drop-shadow. Hit-testing keeps
// going through the canvas's cached images for alpha accuracy.
//
// Limitations:
//   • Per-instance perspective warp (obj.warp.corners) falls back
//     to canvas rendering (loses animation for GIFs, and sits
//     below the overlay layer — if a warped PNG needs to appear
//     above an overlay item, that one edge case isn't handled).

import { state } from "./state.js";
import { assetUrl } from "./config.js";
import { filterStringFor } from "./objects.js";
import { getCachedImage, loadImage } from "./images.js";
// Cycle note: canvas.js statically imports from this module too. ES
// modules resolve function imports as live bindings, so as long as we
// only CALL render() inside callbacks (never read it at top-level),
// the cycle works — render() is defined by the time any image-load
// promise resolves.
import { render } from "./canvas.js";

let layerEl = null;
const _imgs = new Map(); // obj.id -> HTMLImageElement


export function initGifLayer(el) {
  layerEl = el;
}


export function shouldRenderViaOverlay(obj) {
  // Every non-warped object renders through the DOM overlay so CSS
  // z-index can interleave PNGs and GIFs by obj.layer. Warped items
  // need canvas's pixel-remap pipeline so they stay on canvas (and
  // GIFs with warp lose their animation — known trade-off).
  if (!obj || !obj.url) return false;
  if (obj.warp && obj.warp.corners) return false;
  return true;
}


// Kept for backwards compatibility with any external callers — the
// overlay now serves all non-warped items, not just GIFs.
export const isAnimatedGifObj = shouldRenderViaOverlay;


// Build the CSS matrix(a,b,c,d,e,f) that takes an <img>'s local
// pixel space (top-left origin, going to width × height) to screen
// pixels relative to the gif-layer's box. Mirrors the canvas math:
//
//   screen = OuterView * Fit * T(pos) * R(theta) * S(sx,sy) * Sh(kx,ky) * (lx - w/2, ly - h/2)
//
// The (-w/2, -h/2) shift is the "drawImage(src, -w/2, -h/2, w, h)"
// step on the canvas side; baked into e/f via the centre point.
function _buildMatrix(obj, w, h, rect) {
  const v = state.view;
  const fit = Math.min(rect.width / 1000, rect.height / 1000);
  const offsetX = (rect.width  - 1000 * fit) / 2;
  const offsetY = (rect.height - 1000 * fit) / 2;
  const cx = rect.width / 2;
  const cy = rect.height / 2;

  const sx = (obj.scale && obj.scale.x) || 1;
  const sy = (obj.scale && obj.scale.y) || 1;
  const kx = (obj.shear && obj.shear.kx) || 0;
  const ky = (obj.shear && obj.shear.ky) || 0;
  const theta = (obj.rotation_z || 0) * Math.PI / 180;
  const cos = Math.cos(theta);
  const sin = Math.sin(theta);

  // Linear part: R * S * Sh, then scaled by (zoom * fit).
  // S * Sh = [[sx, sx*kx], [sy*ky, sy]]
  // R * S * Sh:
  //   [[cos*sx - sin*sy*ky,   cos*sx*kx - sin*sy],
  //    [sin*sx + cos*sy*ky,   sin*sx*kx + cos*sy]]
  const k = v.zoom * fit;
  const a = k * (cos * sx - sin * sy * ky);
  const b = k * (sin * sx + cos * sy * ky);
  const c = k * (cos * sx * kx - sin * sy);
  const d = k * (sin * sx * kx + cos * sy);

  // Where the image's centre lands on screen.
  const slX = offsetX + fit * obj.position.x;
  const slY = offsetY + fit * obj.position.y;
  const screenX = v.zoom * (slX - cx) + cx + v.panX;
  const screenY = v.zoom * (slY - cy) + cy + v.panY;

  // Solve so matrix * (w/2, h/2) + (e, f) = (screenX, screenY).
  const e = screenX - a * (w / 2) - c * (h / 2);
  const f = screenY - b * (w / 2) - d * (h / 2);

  return `matrix(${a}, ${b}, ${c}, ${d}, ${e}, ${f})`;
}


// Composite the user's colour adjustments with an optional selection
// drop-shadow. drop-shadow follows the alpha silhouette so transparent
// GIF regions don't get a rectangular halo, matching canvas shadowBlur.
function _composeFilter(obj, selected) {
  const base = filterStringFor(obj);
  const baseStr = base === "none" ? "" : base;
  const glow = selected ? "drop-shadow(0 0 12px rgba(80, 150, 255, 0.93))" : "";
  const out = [baseStr, glow].filter(Boolean).join(" ");
  return out || "none";
}


// Run after every canvas render. Adds/updates/removes <img> elements
// so the overlay matches the current set of overlay-eligible objects.
export function syncOverlayLayer(rect) {
  if (!layerEl) return;
  const seen = new Set();

  const sorted = [...state.room.objects].sort((a, b) => a.layer - b.layer);
  for (const obj of sorted) {
    if (obj.hidden) continue;
    if (!shouldRenderViaOverlay(obj)) continue;

    let img = _imgs.get(obj.id);
    if (!img) {
      img = document.createElement("img");
      img.src = assetUrl(obj.url);
      img.alt = "";
      img.draggable = false;
      img.crossOrigin = "anonymous";
      layerEl.appendChild(img);
      _imgs.set(obj.id, img);
    } else if (img.parentNode !== layerEl) {
      layerEl.appendChild(img);
    }

    if (img.dataset.url !== obj.url) {
      img.src = assetUrl(obj.url);
      img.dataset.url = obj.url;
    }

    const cached = getCachedImage(obj.url);
    if (!cached) {
      img.style.visibility = "hidden";
      loadImage(obj.url).then(render).catch(() => {});
      continue;
    }
    const w = cached.naturalWidth;
    const h = cached.naturalHeight;
    if (!w || !h) {
      img.style.visibility = "hidden";
      continue;
    }
    img.style.visibility = "";
    img.style.width  = w + "px";
    img.style.height = h + "px";
    img.style.transform = _buildMatrix(obj, w, h, rect);
    img.style.filter = _composeFilter(obj, obj.id === state.selectedId);
    // Z-index = layer so CSS can honour obj.layer across the whole
    // scene — PNGs and GIFs interleave correctly instead of all
    // overlay items sitting above all canvas items.
    img.style.zIndex = String(obj.layer);

    seen.add(obj.id);
  }

  for (const [id, img] of _imgs) {
    if (!seen.has(id)) {
      img.remove();
      _imgs.delete(id);
    }
  }
}


// Backwards-compatible export name for canvas.js's existing import.
export const syncGifLayer = syncOverlayLayer;
