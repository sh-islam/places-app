// Admin-only: advanced image editor. Erase / crop / shear / perspective
// warp. Operates on an off-screen canvas at the source image's native
// resolution. All edits are bundled — only the "Save Image" button
// pushes bytes to the server (/api/catalog/overwrite). Revert restores
// the last-saved canvas.
//
// While this mode is active, canvas.js render() is a no-op (we check
// mode there) and we commandeer #room-canvas to draw a centred preview
// of the work canvas plus an HTML overlay for per-tool handles.

import { state, markDirty } from "./state.js";
import { api } from "./api.js";
import { findObject } from "./objects.js";
import { loadImage } from "./images.js";
import { assetUrl } from "./config.js";


const DEFAULT_BRUSH = 50;
const EDGE_MARGIN = 16;      // px of breathing room around the image in scene area

let _sceneCanvas = null;
let _overlayEl = null;
let _workCanvas = null;      // current edited state (off-screen)
let _baseCanvas = null;      // last-saved state (for Revert)
let _sourceObjId = null;
let _sourceUrl = null;
let _dirty = false;
let _toolHandle = null;      // {render?, refresh?, destroy}
let _renderFit = null;       // {scale, offsetX, offsetY, renderedW, renderedH}
// Editor-only scene chrome: solid bg fill vs checkerboard transparency.
// Enabled by default at hue 0 → near-black (hsl(0, 30%, 6%)).
let _bgEnabled = true;
let _bgHue = 0;
// Save-as-copy form refs (resolved during initAdvancedEdit).
let _copyForm = null;
let _copyCatInput = null;
let _copySubInput = null;
let _copyCatChipsEl = null;
let _copySubChipsEl = null;
let _copyNameInput = null;
let _statusEl = null;


export function initAdvancedEdit() {
  _sceneCanvas = document.getElementById("room-canvas");
  document.getElementById("advanced-btn")
    ?.addEventListener("click", () => {
      if (state.isAdmin && state.selectedId) _enter();
    });
  document.getElementById("adv-back-btn")?.addEventListener("click", _back);
  document.getElementById("adv-revert-btn")?.addEventListener("click", _revert);
  document.getElementById("adv-save-btn")?.addEventListener("click", _save);
  document.getElementById("adv-save-copy-btn")?.addEventListener("click", _openCopyForm);
  document.getElementById("adv-copy-cancel")?.addEventListener("click", _closeCopyForm);
  document.getElementById("adv-copy-confirm")?.addEventListener("click", _saveCopy);

  _copyForm        = document.getElementById("adv-copy-form");
  _copyCatInput    = document.getElementById("adv-copy-cat");
  _copySubInput    = document.getElementById("adv-copy-sub");
  _copyCatChipsEl  = document.getElementById("adv-copy-cat-chips");
  _copySubChipsEl  = document.getElementById("adv-copy-sub-chips");
  _copyNameInput   = document.getElementById("adv-copy-name");
  _statusEl        = document.getElementById("adv-status");

  for (const btn of document.querySelectorAll(".adv-tool-btn")) {
    btn.addEventListener("click", () => _setTool(btn.dataset.tool));
  }
  const bgToggle = document.getElementById("adv-bg-toggle");
  const bgHue    = document.getElementById("adv-bg-hue");
  if (bgToggle) bgToggle.addEventListener("change", () => {
    _bgEnabled = bgToggle.checked;
    _rerender();
  });
  if (bgHue) bgHue.addEventListener("input", () => {
    _bgHue = Number(bgHue.value);
    _rerender();
  });
  window.addEventListener("resize", () => { if (_isActive()) _rerender(); });

  // Observe the advanced-edit mode div — if a nav-home / logout / any
  // other flow deactivates the mode while we still hold state, tear
  // down cleanly so the overlay and canvases don't leak.
  const advMode = document.querySelector('[data-mode="advanced-edit"]');
  if (advMode) {
    new MutationObserver(() => {
      if (!advMode.classList.contains("active") && _sourceUrl) {
        _cleanupState();
        import("./canvas.js").then((m) => m.render());
      }
    }).observe(advMode, { attributes: true, attributeFilter: ["class"] });
  }
}


function _isActive() {
  return !!document.querySelector('[data-mode="advanced-edit"]')
    ?.classList.contains("active");
}


async function _enter() {
  const obj = findObject(state.selectedId);
  if (!obj) return;
  _sourceObjId = obj.id;
  _sourceUrl = obj.url;

  const img = await loadImage(obj.url).catch(() => null);
  if (!img) { alert("Couldn't load the image to edit."); return; }

  _workCanvas = _mkCanvas(img.naturalWidth, img.naturalHeight);
  _workCanvas.getContext("2d").drawImage(img, 0, 0);
  _baseCanvas = _mkCanvas(img.naturalWidth, img.naturalHeight);
  _baseCanvas.getContext("2d").drawImage(img, 0, 0);
  _dirty = false;

  _ensureOverlay();
  // Hide the scene's own UI (zoom +/−/reload, background picker, room
  // dots) so they don't overlap the editor view. Dropped via a body
  // class so mobile and desktop layouts both inherit the change.
  document.body.classList.add("adv-editing");
  const { setMode } = await import("./panel.js");
  setMode("advanced-edit");
  _setTool(null);
  _setStatus("", null);
  _closeCopyForm();
  _rerender();
  _updateSaveButton();
}


function _ensureOverlay() {
  if (_overlayEl) return;
  const host = document.querySelector(".scene-inner") || _sceneCanvas.parentElement;
  _overlayEl = document.createElement("div");
  _overlayEl.className = "adv-overlay";
  host.appendChild(_overlayEl);
}


async function _back() {
  if (_dirty && !confirm("Discard unsaved edits?")) return;
  _cleanupState();
  const { setMode } = await import("./panel.js");
  setMode("edit");
  const { render } = await import("./canvas.js");
  render();
}


function _cleanupState() {
  if (_toolHandle?.destroy) _toolHandle.destroy();
  _toolHandle = null;
  if (_overlayEl) { _overlayEl.remove(); _overlayEl = null; }
  _workCanvas = null;
  _baseCanvas = null;
  _sourceObjId = null;
  _sourceUrl = null;
  _dirty = false;
  _renderFit = null;
  document.body.classList.remove("adv-editing");
  for (const btn of document.querySelectorAll(".adv-tool-btn")) {
    btn.classList.remove("active");
  }
  const controls = document.getElementById("adv-tool-controls");
  if (controls) controls.innerHTML = "";
  _closeCopyForm();
  _setStatus("", null);
  _updateSaveButton();
}


function _revert() {
  if (!_baseCanvas) return;
  const ctx = _workCanvas.getContext("2d");
  if (_workCanvas.width !== _baseCanvas.width
      || _workCanvas.height !== _baseCanvas.height) {
    _workCanvas.width = _baseCanvas.width;
    _workCanvas.height = _baseCanvas.height;
  }
  ctx.clearRect(0, 0, _workCanvas.width, _workCanvas.height);
  ctx.drawImage(_baseCanvas, 0, 0);
  _dirty = false;
  _updateSaveButton();
  if (_toolHandle?.refresh) _toolHandle.refresh();
  _rerender();
}


async function _save() {
  if (!_dirty || !_sourceUrl) return;
  const btn = document.getElementById("adv-save-btn");
  btn.disabled = true;
  btn.textContent = "Saving...";
  _setStatus("Saving...", null);
  try {
    const dataUrl = _workCanvas.toDataURL("image/png");
    const res = await api.overwriteCatalogItem(_sourceUrl, dataUrl);

    // Base := current work
    _baseCanvas = _mkCanvas(_workCanvas.width, _workCanvas.height);
    _baseCanvas.getContext("2d").drawImage(_workCanvas, 0, 0);
    _dirty = false;

    // Bust image cache: drop the old Image, fetch fresh bytes with a
    // version query, re-install under the original /catalog/ url so
    // scene rendering picks up the new bytes.
    state.imageCache.delete(_sourceUrl);
    try {
      const freshImg = await _loadFresh(_sourceUrl, res.v || Date.now());
      state.imageCache.set(_sourceUrl, freshImg);
    } catch (e) {
      console.warn("post-save reload failed; next page load will get it", e);
    }

    // Alpha mask + content bbox caches are keyed by url too — kill them
    // so hit-testing uses the new image's mask.
    const { invalidateAlphaCache } = await import("./canvas.js");
    if (invalidateAlphaCache) invalidateAlphaCache(_sourceUrl);

    // The room objects reference this image by url; dimensions may have
    // changed (crop / shear / warp). Mark the room dirty so the scene
    // save flushes whatever layout was in flight.
    markDirty();
    _setStatus(`Overwritten ${_sourceUrl}`, "ok");
  } catch (err) {
    _setStatus(`Save failed: ${err.message}`, "err");
  } finally {
    btn.textContent = "Save Image";
    _updateSaveButton();
  }
}


// ---------- Save as copy ----------

function _openCopyForm() {
  if (!_workCanvas || !_sourceUrl) return;
  _copyForm.hidden = false;
  const [curCat, curSub, curName] = _parseUrl(_sourceUrl);
  _copyCatInput.value = curCat;
  _copySubInput.value = curSub;
  _renderCopyCatChips();
  _renderCopySubChips();
  _copyNameInput.value = _nextFreeCopyName(curName, curCat, curSub);
  _copyNameInput.focus();
  _copyNameInput.select();
}


function _closeCopyForm() {
  if (!_copyForm) return;
  _copyForm.hidden = true;
}


async function _saveCopy() {
  if (!_workCanvas) return;
  const cat  = _slug(_copyCatInput.value);
  const sub  = _slug(_copySubInput.value);
  const name = _slug(_copyNameInput.value);
  if (!cat || !sub || !name) {
    _setStatus("Category, subcategory and name are all required.", "err");
    return;
  }

  const confirmBtn = document.getElementById("adv-copy-confirm");
  confirmBtn.disabled = true;
  confirmBtn.textContent = "Saving...";
  _setStatus("Saving copy...", null);
  try {
    // Canvas → Blob (avoid the base64 round-trip of toDataURL on big
    // images). /api/catalog/upload expects a multipart image field.
    const blob = await new Promise((res) =>
      _workCanvas.toBlob((b) => res(b), "image/png"));
    if (!blob) throw new Error("toBlob failed");
    // overwrite stays off so the backend auto-bumps to _N+1 if the
    // frontend guess happened to collide (another admin just uploaded).
    const res = await api.uploadCatalogItem({
      image: blob, category: cat, subcategory: sub, name, overwrite: false,
    });

    // Refresh catalog state so the new item appears in the drawer.
    const c = await api.catalog();
    state.catalog = c.items;
    state.categories = c.categories;
    const { rebuildCatalog } = await import("./catalog.js");
    rebuildCatalog();

    _closeCopyForm();
    _setStatus(`Copy saved to ${res.url}`, "ok");
  } catch (err) {
    _setStatus(`Copy failed: ${err.message}`, "err");
  } finally {
    confirmBtn.disabled = false;
    confirmBtn.textContent = "Save Copy";
  }
}


// Pick the first `<currentName>_<N>` (starting at N=2) that isn't in
// the catalog for this cat/sub. Backend does its own collision bump,
// but we prefill a best guess so the admin doesn't have to edit the name.
function _nextFreeCopyName(currentName, cat, sub) {
  const prefix = `/catalog/${cat}/${sub}/`;
  const existing = new Set(
    (state.catalog || [])
      .filter((it) => (it.url || "").startsWith(prefix))
      .map((it) => it.url.slice(prefix.length).replace(/\.[^.]+$/, ""))
  );
  let n = 2;
  while (existing.has(`${currentName}_${n}`)) n++;
  return `${currentName}_${n}`;
}


function _renderCopyCatChips() {
  const cats = Object.keys(state.categories || {}).sort();
  _buildCopyChips(_copyCatChipsEl, cats, _copyCatInput, (v) => {
    _copySubInput.value = "";
    _renderCopySubChips();
  });
}


function _renderCopySubChips() {
  const cat = _copyCatInput.value;
  const subs = (state.categories && state.categories[cat]) || [];
  _buildCopyChips(_copySubChipsEl, subs, _copySubInput);
}


// Inline chip builder (same idea as settings/upload + recategorize, but
// these chips don't need the "+ New" escape hatch — admins can always
// edit the name/cat/sub freely via the hidden inputs via the chip they
// pick. Kept intentionally small so there's no cross-module coupling.)
function _buildCopyChips(container, items, hiddenInput, onSelect) {
  container.innerHTML = "";
  items.forEach((val) => {
    const chip = document.createElement("button");
    chip.type = "button";
    chip.className = "chip" + (hiddenInput.value === val ? " active" : "");
    chip.textContent = _label(val);
    chip.addEventListener("click", () => {
      hiddenInput.value = val;
      container.querySelectorAll(".chip").forEach((c) => c.classList.remove("active"));
      chip.classList.add("active");
      if (onSelect) onSelect(val);
    });
    container.appendChild(chip);
  });
}


function _parseUrl(url) {
  // "/catalog/<cat>/<sub>/<name>.png" -> [cat, sub, name]
  const parts = (url || "").replace(/^\/catalog\//, "").split("/");
  const cat = parts[0] || "";
  const sub = parts[1] || "";
  const name = (parts[2] || "").replace(/\.[^.]+$/, "");
  return [cat, sub, name];
}


function _slug(s) {
  return (s || "").trim().toLowerCase()
    .replace(/\s+/g, "_")
    .replace(/[^a-z0-9_]/g, "");
}


function _label(s) {
  return s.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}


function _loadFresh(origUrl, version) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error(`reload ${origUrl} failed`));
    img.src = `${assetUrl(origUrl)}?v=${version}`;
  });
}


function _updateSaveButton() {
  const saveBtn = document.getElementById("adv-save-btn");
  if (saveBtn) saveBtn.disabled = !_dirty;
  // Save-as-copy is enabled whenever we've loaded a work canvas — you
  // can save a copy of an untouched image too (useful for duplicating a
  // catalog entry as a starting point).
  const copyBtn = document.getElementById("adv-save-copy-btn");
  if (copyBtn) copyBtn.disabled = !_workCanvas;
}


function _setStatus(msg, kind /* "ok" | "err" | null */) {
  if (!_statusEl) return;
  _statusEl.textContent = msg || "";
  _statusEl.classList.toggle("ok",  kind === "ok");
  _statusEl.classList.toggle("err", kind === "err");
}


function _mkCanvas(w, h) {
  const c = document.createElement("canvas");
  c.width = w; c.height = h;
  return c;
}


function _setTool(name) {
  if (_toolHandle?.destroy) _toolHandle.destroy();
  _toolHandle = null;
  for (const btn of document.querySelectorAll(".adv-tool-btn")) {
    btn.classList.toggle("active", btn.dataset.tool === name);
  }
  const controls = document.getElementById("adv-tool-controls");
  if (controls) controls.innerHTML = "";
  if (_overlayEl) _overlayEl.innerHTML = "";
  if (!name) { _rerender(); return; }
  if (name === "erase")            _toolHandle = _makeEraseTool();
  else if (name === "crop")        _toolHandle = _makeCropTool();
  else if (name === "shear")       _toolHandle = _makeShearTool();
  else if (name === "perspective") _toolHandle = _makePerspectiveTool();
  _rerender();
}


function _rerender() {
  if (!_isActive() || !_workCanvas || !_sceneCanvas) return;
  const ctx = _sceneCanvas.getContext("2d");
  const rect = _sceneCanvas.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;
  // #room-canvas's backing-store DPR was already set by canvas.js at init;
  // it's stable across re-renders. We reset the transform to draw in CSS
  // pixels.
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  // Scene background: either a solid hue-tinted fill (default) or the
  // dark fallback + checkerboard that reveals image transparency. At
  // hue=0 the HSL fill reads as near-black; sliding reveals a tint.
  ctx.fillStyle = _bgEnabled ? `hsl(${_bgHue}, 30%, 6%)` : "#0a0a0d";
  ctx.fillRect(0, 0, rect.width, rect.height);

  const availW = rect.width - EDGE_MARGIN * 2;
  const availH = rect.height - EDGE_MARGIN * 2;
  const scale = Math.min(availW / _workCanvas.width, availH / _workCanvas.height);
  const renderedW = _workCanvas.width * scale;
  const renderedH = _workCanvas.height * scale;
  const offsetX = (rect.width - renderedW) / 2;
  const offsetY = (rect.height - renderedH) / 2;
  _renderFit = { scale, offsetX, offsetY, renderedW, renderedH };

  if (!_bgEnabled) {
    _drawCheckerboard(ctx, offsetX, offsetY, renderedW, renderedH);
  }
  ctx.drawImage(_workCanvas, offsetX, offsetY, renderedW, renderedH);

  if (_overlayEl) {
    _overlayEl.style.width  = `${rect.width}px`;
    _overlayEl.style.height = `${rect.height}px`;
  }
  if (_toolHandle?.render) _toolHandle.render();
}


function _drawCheckerboard(ctx, x, y, w, h) {
  const tile = 12;
  ctx.save();
  ctx.beginPath();
  ctx.rect(x, y, w, h);
  ctx.clip();
  ctx.fillStyle = "#2a2a2f";
  ctx.fillRect(x, y, w, h);
  ctx.fillStyle = "#3a3a3f";
  for (let j = 0; j < h; j += tile) {
    const offset = (Math.floor(j / tile) % 2) * tile;
    for (let i = offset; i < w; i += tile * 2) {
      ctx.fillRect(x + i, y + j, tile, tile);
    }
  }
  ctx.restore();
}


// ---- Screen <-> image coordinate helpers ----
// _overlayPos() reads e.clientX/Y and subtracts the overlay's bounding
// rect so we get overlay-relative coords regardless of which child
// element (a handle, an SVG line) the pointer actually hit. e.offsetX
// isn't reliable here because it's relative to the event target.
function _overlayPos(e) {
  const r = _overlayEl.getBoundingClientRect();
  return { x: e.clientX - r.left, y: e.clientY - r.top };
}
function _screenToImage(sx, sy) {
  if (!_renderFit) return null;
  return {
    x: (sx - _renderFit.offsetX) / _renderFit.scale,
    y: (sy - _renderFit.offsetY) / _renderFit.scale,
  };
}
function _imageToScreen(ix, iy) {
  if (!_renderFit) return { x: 0, y: 0 };
  return {
    x: _renderFit.offsetX + ix * _renderFit.scale,
    y: _renderFit.offsetY + iy * _renderFit.scale,
  };
}


// ========================= TOOLS =========================

// ---------- Erase ----------
function _makeEraseTool() {
  let size = DEFAULT_BRUSH;
  let shape = "square";
  let painting = false;

  const controls = document.getElementById("adv-tool-controls");
  controls.innerHTML = `
    <div class="adv-slider-row">
      <label>Brush</label>
      <input type="range" min="10" max="300" step="5" value="${size}" id="erase-size">
      <output id="erase-size-out">${size}px</output>
    </div>
    <div class="adv-shape-toggle">
      <button type="button" class="chip active" data-shape="square">Square</button>
      <button type="button" class="chip" data-shape="circle">Circle</button>
    </div>
  `;
  const sizeInput = controls.querySelector("#erase-size");
  const sizeOut   = controls.querySelector("#erase-size-out");
  sizeInput.addEventListener("input", () => {
    size = Number(sizeInput.value);
    sizeOut.textContent = `${size}px`;
    _syncCursor();
  });
  for (const btn of controls.querySelectorAll("[data-shape]")) {
    btn.addEventListener("click", () => {
      shape = btn.dataset.shape;
      for (const b of controls.querySelectorAll("[data-shape]")) {
        b.classList.toggle("active", b === btn);
      }
      cursor.className = `adv-erase-cursor ${shape}`;
      _syncCursor();
    });
  }

  const cursor = document.createElement("div");
  cursor.className = `adv-erase-cursor ${shape}`;
  _overlayEl.appendChild(cursor);

  let lastEvt = null;

  function _syncCursor() {
    if (!lastEvt) { cursor.style.display = "none"; return; }
    const p = _overlayPos(lastEvt);
    cursor.style.display = "block";
    cursor.style.left = `${p.x}px`;
    cursor.style.top  = `${p.y}px`;
    const px = size * (_renderFit?.scale || 1);
    cursor.style.width  = `${px}px`;
    cursor.style.height = `${px}px`;
  }

  function _paintAt(sx, sy) {
    const pt = _screenToImage(sx, sy);
    if (!pt) return;
    const ctx = _workCanvas.getContext("2d");
    ctx.save();
    ctx.globalCompositeOperation = "destination-out";
    ctx.fillStyle = "#000";
    if (shape === "square") {
      ctx.fillRect(pt.x - size / 2, pt.y - size / 2, size, size);
    } else {
      ctx.beginPath();
      ctx.arc(pt.x, pt.y, size / 2, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();
    _dirty = true;
    _updateSaveButton();
    _rerender();
    _syncCursor();
  }

  function onDown(e) {
    if (e.button !== undefined && e.button !== 0) return;
    e.preventDefault();
    painting = true;
    try { _overlayEl.setPointerCapture(e.pointerId); } catch (_) {}
    const p = _overlayPos(e);
    _paintAt(p.x, p.y);
  }
  function onMove(e) {
    lastEvt = e;
    _syncCursor();
    if (painting) {
      const p = _overlayPos(e);
      _paintAt(p.x, p.y);
    }
  }
  function onUp(e) {
    painting = false;
    try { _overlayEl.releasePointerCapture(e.pointerId); } catch (_) {}
  }
  function onLeave() { lastEvt = null; _syncCursor(); }

  _overlayEl.addEventListener("pointerdown", onDown);
  _overlayEl.addEventListener("pointermove", onMove);
  _overlayEl.addEventListener("pointerup", onUp);
  _overlayEl.addEventListener("pointercancel", onUp);
  _overlayEl.addEventListener("pointerleave", onLeave);

  return {
    destroy() {
      _overlayEl.removeEventListener("pointerdown", onDown);
      _overlayEl.removeEventListener("pointermove", onMove);
      _overlayEl.removeEventListener("pointerup", onUp);
      _overlayEl.removeEventListener("pointercancel", onUp);
      _overlayEl.removeEventListener("pointerleave", onLeave);
      cursor.remove();
    },
  };
}


// ---------- Crop ----------
function _makeCropTool() {
  let rect = { x: 0, y: 0, w: _workCanvas.width, h: _workCanvas.height };

  const rectEl = document.createElement("div");
  rectEl.className = "adv-crop-rect";
  _overlayEl.appendChild(rectEl);

  const handleEls = {};
  const HANDLE_DIRS = ["nw", "n", "ne", "e", "se", "s", "sw", "w"];
  for (const d of HANDLE_DIRS) {
    const h = document.createElement("div");
    h.className = "adv-crop-handle";
    h.dataset.dir = d;
    _overlayEl.appendChild(h);
    handleEls[d] = h;
  }

  const controls = document.getElementById("adv-tool-controls");
  controls.innerHTML = `
    <p class="muted small">Drag the rectangle or its handles. Apply crops to the new bounds.</p>
    <div class="adv-apply-row">
      <button type="button" class="btn-pill" id="crop-reset">Reset</button>
      <button type="button" class="btn-pill primary" id="crop-apply">Apply Crop</button>
    </div>
  `;
  controls.querySelector("#crop-reset").addEventListener("click", () => {
    rect = { x: 0, y: 0, w: _workCanvas.width, h: _workCanvas.height };
    _renderOverlay();
  });
  controls.querySelector("#crop-apply").addEventListener("click", () => {
    if (rect.w < 4 || rect.h < 4) return;
    const newW = Math.max(1, Math.round(rect.w));
    const newH = Math.max(1, Math.round(rect.h));
    const out = _mkCanvas(newW, newH);
    out.getContext("2d").drawImage(
      _workCanvas,
      Math.round(rect.x), Math.round(rect.y), newW, newH,
      0, 0, newW, newH
    );
    _workCanvas = out;
    _dirty = true;
    _updateSaveButton();
    rect = { x: 0, y: 0, w: _workCanvas.width, h: _workCanvas.height };
    _rerender();
  });

  let drag = null;

  function _startDrag(mode, e) {
    e.preventDefault();
    e.stopPropagation();
    try { _overlayEl.setPointerCapture(e.pointerId); } catch (_) {}
    const p = _overlayPos(e);
    drag = { mode, startX: p.x, startY: p.y, rect: { ...rect } };
  }

  rectEl.addEventListener("pointerdown", (e) => _startDrag("move", e));
  for (const [dir, el] of Object.entries(handleEls)) {
    el.addEventListener("pointerdown", (e) => _startDrag(dir, e));
  }

  function onMove(e) {
    if (!drag) return;
    const p = _overlayPos(e);
    const scale = _renderFit?.scale || 1;
    const dix = (p.x - drag.startX) / scale;
    const diy = (p.y - drag.startY) / scale;
    const r = { ...drag.rect };
    if (drag.mode === "move") {
      r.x += dix; r.y += diy;
    } else {
      if (drag.mode.includes("w")) { r.x += dix; r.w -= dix; }
      if (drag.mode.includes("e")) { r.w += dix; }
      if (drag.mode.includes("n")) { r.y += diy; r.h -= diy; }
      if (drag.mode.includes("s")) { r.h += diy; }
    }
    // Clamp to image bounds and minimum size.
    const minSide = 4;
    r.x = Math.max(0, Math.min(r.x, _workCanvas.width - minSide));
    r.y = Math.max(0, Math.min(r.y, _workCanvas.height - minSide));
    r.w = Math.max(minSide, Math.min(r.w, _workCanvas.width - r.x));
    r.h = Math.max(minSide, Math.min(r.h, _workCanvas.height - r.y));
    rect = r;
    _renderOverlay();
  }
  function onUp(e) {
    drag = null;
    try { _overlayEl.releasePointerCapture(e.pointerId); } catch (_) {}
  }
  _overlayEl.addEventListener("pointermove", onMove);
  _overlayEl.addEventListener("pointerup", onUp);
  _overlayEl.addEventListener("pointercancel", onUp);

  function _renderOverlay() {
    if (!_renderFit) return;
    const tl = _imageToScreen(rect.x, rect.y);
    const br = _imageToScreen(rect.x + rect.w, rect.y + rect.h);
    rectEl.style.left = `${tl.x}px`;
    rectEl.style.top  = `${tl.y}px`;
    rectEl.style.width  = `${br.x - tl.x}px`;
    rectEl.style.height = `${br.y - tl.y}px`;
    const mid = (a, b) => (a + b) / 2;
    const pos = {
      nw: [tl.x, tl.y],          n: [mid(tl.x, br.x), tl.y],        ne: [br.x, tl.y],
      w:  [tl.x, mid(tl.y, br.y)],                                   e:  [br.x, mid(tl.y, br.y)],
      sw: [tl.x, br.y],          s: [mid(tl.x, br.x), br.y],        se: [br.x, br.y],
    };
    for (const [k, [x, y]] of Object.entries(pos)) {
      handleEls[k].style.left = `${x}px`;
      handleEls[k].style.top  = `${y}px`;
    }
  }

  return {
    render: _renderOverlay,
    refresh() {
      rect = { x: 0, y: 0, w: _workCanvas.width, h: _workCanvas.height };
      _renderOverlay();
    },
    destroy() {
      _overlayEl.removeEventListener("pointermove", onMove);
      _overlayEl.removeEventListener("pointerup", onUp);
      _overlayEl.removeEventListener("pointercancel", onUp);
      rectEl.remove();
      for (const h of Object.values(handleEls)) h.remove();
    },
  };
}


// ---------- Shear (affine skew) ----------
function _makeShearTool() {
  let degX = 0, degY = 0;

  const controls = document.getElementById("adv-tool-controls");
  controls.innerHTML = `
    <div class="adv-slider-row">
      <label>Skew X</label>
      <input type="range" min="-45" max="45" step="1" value="0" id="shear-x">
      <output id="shear-x-out">0°</output>
    </div>
    <div class="adv-slider-row">
      <label>Skew Y</label>
      <input type="range" min="-45" max="45" step="1" value="0" id="shear-y">
      <output id="shear-y-out">0°</output>
    </div>
    <div class="adv-apply-row">
      <button type="button" class="btn-pill" id="shear-reset">Reset</button>
      <button type="button" class="btn-pill primary" id="shear-apply">Apply Shear</button>
    </div>
  `;
  const xIn  = controls.querySelector("#shear-x");
  const yIn  = controls.querySelector("#shear-y");
  const xOut = controls.querySelector("#shear-x-out");
  const yOut = controls.querySelector("#shear-y-out");
  xIn.addEventListener("input", () => {
    degX = Number(xIn.value);
    xOut.textContent = `${degX}°`;
    _previewRender();
  });
  yIn.addEventListener("input", () => {
    degY = Number(yIn.value);
    yOut.textContent = `${degY}°`;
    _previewRender();
  });
  controls.querySelector("#shear-reset").addEventListener("click", () => {
    degX = 0; degY = 0;
    xIn.value = "0"; yIn.value = "0";
    xOut.textContent = "0°"; yOut.textContent = "0°";
    _previewRender();
  });
  controls.querySelector("#shear-apply").addEventListener("click", () => {
    if (degX === 0 && degY === 0) return;
    const tx = Math.tan(degX * Math.PI / 180);
    const ty = Math.tan(degY * Math.PI / 180);
    const w = _workCanvas.width;
    const h = _workCanvas.height;
    // (x,y) → (x + tx*y, y + ty*x)
    const corners = [[0, 0], [w, 0], [w, h], [0, h]]
      .map(([x, y]) => [x + tx * y, y + ty * x]);
    const minX = Math.min(...corners.map((c) => c[0]));
    const maxX = Math.max(...corners.map((c) => c[0]));
    const minY = Math.min(...corners.map((c) => c[1]));
    const maxY = Math.max(...corners.map((c) => c[1]));
    const newW = Math.max(1, Math.ceil(maxX - minX));
    const newH = Math.max(1, Math.ceil(maxY - minY));
    const out = _mkCanvas(newW, newH);
    const ctx = out.getContext("2d");
    ctx.translate(-minX, -minY);
    // Canvas 2D transform matrix: (a, b, c, d, e, f) where
    //   x' = a*x + c*y + e;  y' = b*x + d*y + f.
    // We want x' = x + tx*y, y' = ty*x + y, so (a,b,c,d,e,f) = (1, ty, tx, 1, 0, 0).
    ctx.transform(1, ty, tx, 1, 0, 0);
    ctx.drawImage(_workCanvas, 0, 0);
    _workCanvas = out;
    degX = 0; degY = 0;
    xIn.value = "0"; yIn.value = "0";
    xOut.textContent = "0°"; yOut.textContent = "0°";
    _dirty = true;
    _updateSaveButton();
    _rerender();
  });

  function _previewRender() {
    if (!_renderFit) { _rerender(); return; }
    const ctx = _sceneCanvas.getContext("2d");
    const rect = _sceneCanvas.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = _bgEnabled ? `hsl(${_bgHue}, 30%, 6%)` : "#0a0a0d";
    ctx.fillRect(0, 0, rect.width, rect.height);
    const fit = _renderFit;
    if (!_bgEnabled) {
      _drawCheckerboard(ctx, fit.offsetX, fit.offsetY, fit.renderedW, fit.renderedH);
    }
    ctx.save();
    ctx.beginPath();
    ctx.rect(fit.offsetX, fit.offsetY, fit.renderedW, fit.renderedH);
    ctx.clip();
    ctx.translate(fit.offsetX, fit.offsetY);
    ctx.scale(fit.scale, fit.scale);
    const tx = Math.tan(degX * Math.PI / 180);
    const ty = Math.tan(degY * Math.PI / 180);
    ctx.transform(1, ty, tx, 1, 0, 0);
    ctx.drawImage(_workCanvas, 0, 0);
    ctx.restore();
  }

  return {
    render: _previewRender,
    destroy() {},
  };
}


// ---------- Perspective warp (4-corner homography) ----------
function _makePerspectiveTool() {
  const w0 = _workCanvas.width;
  const h0 = _workCanvas.height;
  // TL, TR, BR, BL in IMAGE coordinates.
  let corners = [[0, 0], [w0, 0], [w0, h0], [0, h0]];

  const SVG_NS = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("class", "adv-persp-svg");
  const lines = [];
  for (let i = 0; i < 4; i++) {
    const l = document.createElementNS(SVG_NS, "line");
    svg.appendChild(l);
    lines.push(l);
  }
  _overlayEl.appendChild(svg);

  const handleEls = corners.map((_, i) => {
    const h = document.createElement("div");
    h.className = "adv-persp-handle";
    h.dataset.idx = String(i);
    _overlayEl.appendChild(h);
    return h;
  });

  const controls = document.getElementById("adv-tool-controls");
  controls.innerHTML = `
    <p class="muted small">Drag the four corners to warp. Apply resamples at full resolution (may take a moment on big images).</p>
    <div class="adv-apply-row">
      <button type="button" class="btn-pill" id="persp-reset">Reset</button>
      <button type="button" class="btn-pill primary" id="persp-apply">Apply Warp</button>
    </div>
  `;
  controls.querySelector("#persp-reset").addEventListener("click", () => {
    corners = [[0, 0], [w0, 0], [w0, h0], [0, h0]];
    _renderOverlay();
  });
  controls.querySelector("#persp-apply").addEventListener("click", _applyWarp);

  let drag = null;
  function onHandleDown(e) {
    e.preventDefault();
    e.stopPropagation();
    const idx = Number(e.currentTarget.dataset.idx);
    try { _overlayEl.setPointerCapture(e.pointerId); } catch (_) {}
    const p = _overlayPos(e);
    drag = {
      idx,
      startX: p.x, startY: p.y,
      startCorner: [...corners[idx]],
    };
  }
  function onMove(e) {
    if (!drag) return;
    const p = _overlayPos(e);
    const scale = _renderFit?.scale || 1;
    const dix = (p.x - drag.startX) / scale;
    const diy = (p.y - drag.startY) / scale;
    corners[drag.idx] = [drag.startCorner[0] + dix, drag.startCorner[1] + diy];
    _renderOverlay();
  }
  function onUp(e) {
    drag = null;
    try { _overlayEl.releasePointerCapture(e.pointerId); } catch (_) {}
  }
  for (const h of handleEls) h.addEventListener("pointerdown", onHandleDown);
  _overlayEl.addEventListener("pointermove", onMove);
  _overlayEl.addEventListener("pointerup", onUp);
  _overlayEl.addEventListener("pointercancel", onUp);

  function _renderOverlay() {
    if (!_renderFit) return;
    const pts = corners.map(([x, y]) => _imageToScreen(x, y));
    // SVG covers the overlay.
    svg.setAttribute("width",  _overlayEl.clientWidth);
    svg.setAttribute("height", _overlayEl.clientHeight);
    for (let i = 0; i < 4; i++) {
      const a = pts[i];
      const b = pts[(i + 1) % 4];
      lines[i].setAttribute("x1", a.x);
      lines[i].setAttribute("y1", a.y);
      lines[i].setAttribute("x2", b.x);
      lines[i].setAttribute("y2", b.y);
    }
    for (let i = 0; i < 4; i++) {
      handleEls[i].style.left = `${pts[i].x}px`;
      handleEls[i].style.top  = `${pts[i].y}px`;
    }
  }

  async function _applyWarp() {
    // Map source rect (0,0)-(w0,h0) → dest quad `corners`.
    const src = [[0, 0], [w0, 0], [w0, h0], [0, h0]];
    const H = _computeHomography(src, corners);
    if (!H) { alert("Degenerate quad — reset and try again."); return; }
    const xs = corners.map((c) => c[0]);
    const ys = corners.map((c) => c[1]);
    const minX = Math.min(...xs);
    const maxX = Math.max(...xs);
    const minY = Math.min(...ys);
    const maxY = Math.max(...ys);
    const outW = Math.max(1, Math.ceil(maxX - minX));
    const outH = Math.max(1, Math.ceil(maxY - minY));
    if (outW * outH > 16_000_000) {
      if (!confirm(`Warp output is ${outW}×${outH} — this may take a while. Continue?`)) return;
    }
    const Hinv = _invert3x3(H);
    if (!Hinv) { alert("Couldn't invert homography."); return; }

    const srcCtx = _workCanvas.getContext("2d");
    const srcImg = srcCtx.getImageData(0, 0, _workCanvas.width, _workCanvas.height);
    const out = _mkCanvas(outW, outH);
    const outCtx = out.getContext("2d");
    const outImg = outCtx.createImageData(outW, outH);
    const sd = srcImg.data;
    const od = outImg.data;
    const sW = srcImg.width;
    const sH = srcImg.height;

    for (let y = 0; y < outH; y++) {
      for (let x = 0; x < outW; x++) {
        const dx = x + minX;
        const dy = y + minY;
        const wz = Hinv[6] * dx + Hinv[7] * dy + Hinv[8];
        const u = (Hinv[0] * dx + Hinv[1] * dy + Hinv[2]) / wz;
        const v = (Hinv[3] * dx + Hinv[4] * dy + Hinv[5]) / wz;
        if (u < 0 || v < 0 || u >= sW - 1 || v >= sH - 1) continue;
        const x0 = Math.floor(u), y0 = Math.floor(v);
        const x1 = x0 + 1,        y1 = y0 + 1;
        const fx = u - x0,        fy = v - y0;
        const i00 = (y0 * sW + x0) * 4;
        const i10 = (y0 * sW + x1) * 4;
        const i01 = (y1 * sW + x0) * 4;
        const i11 = (y1 * sW + x1) * 4;
        const oi  = (y * outW + x) * 4;
        for (let c = 0; c < 4; c++) {
          const a = sd[i00 + c] * (1 - fx) + sd[i10 + c] * fx;
          const b = sd[i01 + c] * (1 - fx) + sd[i11 + c] * fx;
          od[oi + c] = a * (1 - fy) + b * fy;
        }
      }
    }
    outCtx.putImageData(outImg, 0, 0);
    _workCanvas = out;
    corners = [[0, 0], [_workCanvas.width, 0],
               [_workCanvas.width, _workCanvas.height], [0, _workCanvas.height]];
    _dirty = true;
    _updateSaveButton();
    _rerender();
  }

  return {
    render: _renderOverlay,
    destroy() {
      _overlayEl.removeEventListener("pointermove", onMove);
      _overlayEl.removeEventListener("pointerup", onUp);
      _overlayEl.removeEventListener("pointercancel", onUp);
      svg.remove();
      for (const h of handleEls) h.remove();
    },
  };
}


// ---- Perspective math ----

// Direct Linear Transform: given 4 source points + 4 dest points, returns
// the 9-element row-major 3×3 homography H that maps src_i -> dst_i.
// Sets H[8] = 1 and solves the remaining 8 unknowns with plain Gaussian
// elimination.
function _computeHomography(src, dst) {
  const A = []; // 8 rows × 8 cols
  const b = []; // 8-vector
  for (let i = 0; i < 4; i++) {
    const [x, y] = src[i];
    const [u, v] = dst[i];
    A.push([  x,  y,  1,  0,  0,  0, -x * u, -y * u ]);
    b.push(u);
    A.push([  0,  0,  0,  x,  y,  1, -x * v, -y * v ]);
    b.push(v);
  }
  const sol = _solveLinear(A, b);
  if (!sol) return null;
  return [sol[0], sol[1], sol[2], sol[3], sol[4], sol[5], sol[6], sol[7], 1];
}


function _solveLinear(Ain, bin) {
  const n = Ain.length;
  const A = Ain.map((r) => r.slice());
  const b = bin.slice();
  for (let i = 0; i < n; i++) {
    let maxRow = i;
    for (let k = i + 1; k < n; k++) {
      if (Math.abs(A[k][i]) > Math.abs(A[maxRow][i])) maxRow = k;
    }
    if (Math.abs(A[maxRow][i]) < 1e-10) return null;
    [A[i], A[maxRow]] = [A[maxRow], A[i]];
    [b[i], b[maxRow]] = [b[maxRow], b[i]];
    for (let k = i + 1; k < n; k++) {
      const f = A[k][i] / A[i][i];
      for (let j = i; j < n; j++) A[k][j] -= f * A[i][j];
      b[k] -= f * b[i];
    }
  }
  const x = new Array(n);
  for (let i = n - 1; i >= 0; i--) {
    let s = b[i];
    for (let j = i + 1; j < n; j++) s -= A[i][j] * x[j];
    x[i] = s / A[i][i];
  }
  return x;
}


function _invert3x3(m) {
  const [a, b, c, d, e, f, g, h, i] = m;
  const det = a * (e * i - f * h) - b * (d * i - f * g) + c * (d * h - e * g);
  if (Math.abs(det) < 1e-10) return null;
  return [
    (e * i - f * h) / det, (c * h - b * i) / det, (b * f - c * e) / det,
    (f * g - d * i) / det, (a * i - c * g) / det, (c * d - a * f) / det,
    (d * h - e * g) / det, (b * g - a * h) / det, (a * e - b * d) / det,
  ];
}
