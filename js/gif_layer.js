// DOM overlay that hosts animated GIFs as <img> elements layered over
// the canvas. The browser handles GIF frame playback natively when the
// image is in the DOM; canvas drawImage only ever paints the first
// frame, which is why GIF objects are routed here instead of through
// the regular canvas object pass.
//
// Each render() of the canvas calls syncGifLayer() with the same
// per-frame metrics the canvas uses (fit, view zoom/pan, scene rect),
// so the CSS matrix on each <img> mirrors the canvas transform exactly
// — translate, rotate, scale, skew/shear and CSS filter all line up
// pixel-perfect with what canvas-rendered objects would have looked
// like, just with animation preserved.
//
// Limitations:
//   • Per-instance perspective warp (obj.warp.corners) needs pixel
//     remapping that CSS doesn't natively express, so GIFs with warp
//     fall back to canvas rendering (loses animation, gains warp).
//   • Z-order: GIFs always paint above canvas-drawn items, since the
//     overlay is one layer on top. Mixed-layer scenes interleave only
//     within each side (canvas items keep their order, GIFs keep theirs).

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


export function isAnimatedGifObj(obj) {
  // Treat .gif urls as animated by default. Single-frame GIFs would
  // technically work fine on canvas too, but routing them through the
  // overlay is harmless — and the upload path now keeps multi-frame
  // GIFs as .gif while flattening single-frame ones to .png, so a
  // .gif extension here is a strong signal that animation matters.
  // Warped GIFs go back to canvas because CSS can't do 4-point warp.
  if (!obj || !obj.url) return false;
  if (!obj.url.toLowerCase().endsWith(".gif")) return false;
  if (obj.warp && obj.warp.corners) return false;
  return true;
}


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
  const glow = selected ? "drop-shadow(0 0 24px rgba(80, 150, 255, 0.93))" : "";
  const out = [baseStr, glow].filter(Boolean).join(" ");
  return out || "none";
}


// Run after every canvas render. Adds/updates/removes <img> elements
// so the overlay matches the current set of GIF objects.
export function syncGifLayer(rect) {
  if (!layerEl) return;
  const seen = new Set();

  // Walk the same back-to-front order the canvas uses so DOM order
  // approximates layer order within the overlay.
  const sorted = [...state.room.objects].sort((a, b) => a.layer - b.layer);
  for (const obj of sorted) {
    if (obj.hidden) continue;
    if (!isAnimatedGifObj(obj)) continue;

    let img = _imgs.get(obj.id);
    if (!img) {
      img = document.createElement("img");
      img.src = assetUrl(obj.url);
      img.alt = "";
      img.draggable = false;
      // crossOrigin not strictly needed for DOM display, but matches
      // the canvas-side <img> creation in images.js for consistency.
      img.crossOrigin = "anonymous";
      layerEl.appendChild(img);
      _imgs.set(obj.id, img);
    } else if (img.parentNode !== layerEl) {
      // Re-attach if something detached it (e.g. layerEl was rebuilt).
      layerEl.appendChild(img);
    }

    // If the source URL changed (shouldn't happen mid-session for GIFs,
    // but cheap to handle), update src.
    if (img.dataset.url !== obj.url) {
      img.src = assetUrl(obj.url);
      img.dataset.url = obj.url;
    }

    // Use the shared cache for dimensions — populated reliably at boot
    // via preloadAll. Hit-testing also relies on this same cache, so a
    // cache-miss means the GIF can't be selected either; trigger a load
    // and re-render so the next frame can place it correctly.
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
    // Stamp obj.layer as z-index so GIF-vs-GIF ordering within the
    // overlay honours bringForward / sendBackward. (GIFs still paint
    // above all canvas items — see module-level Limitations.)
    img.style.zIndex = String(obj.layer);

    seen.add(obj.id);
  }

  // Drop overlays for objects that are gone (deleted, hidden, route
  // changed to canvas because warp got applied, room switched, etc.).
  for (const [id, img] of _imgs) {
    if (!seen.has(id)) {
      img.remove();
      _imgs.delete(id);
    }
  }
}
