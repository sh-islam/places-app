// Settings drawer. Non-admin users just see an empty-state message. Admins
// get a catalog upload form: browse-or-paste an image, pick category and
// subcategory, optionally rename (helpful on mobiles where pasted images
// get auto-generated filenames), submit.

import { state } from "./state.js";
import { api } from "./api.js";


let drawerEl = null;
let backdropEl = null;
let bodyEl = null;
let onCatalogUpdated = null;


export function initSettings({
  drawer,
  toggle,
  body,
  closeBtn,
  backdrop,
  onCatalogChange,
}) {
  drawerEl = drawer;
  backdropEl = backdrop;
  bodyEl = body;
  onCatalogUpdated = onCatalogChange;

  toggle.addEventListener("click", () => _setOpen(true));
  closeBtn.addEventListener("click", () => _setOpen(false));
  backdrop.addEventListener("click", () => _setOpen(false));

  _render();
}


function _setOpen(open) {
  drawerEl.classList.toggle("open", open);
  backdropEl.classList.toggle("open", open);
  drawerEl.setAttribute("aria-hidden", open ? "false" : "true");
  if (open) _render(); // refresh category dropdowns etc. each time it opens
}


function _render() {
  let html = _themeHTML();
  if (state.isAdmin) html += _adminFormHTML();
  bodyEl.innerHTML = html;
  _wireThemePicker();
  if (state.isAdmin) _wireAdminForm();
}


/* ---- Theme picker ---- */

// Theme prefs — loaded from server, applied to CSS variables.
let _prefs = { theme: "default", hue: 230, saturation: 100, brightness: 100, contrast: 100, opacity: 65 };
let _saveTimer = null;

function _themeHTML() {
  const p = _prefs;
  return `
    <div class="theme-section">
      <span class="theme-label">Theme</span>
      <div class="theme-grid">
        <button class="theme-swatch${p.theme === "default" ? " active" : ""}" data-theme="default">
          <span class="theme-swatch-color" style="background:#0d0f12"></span>
          <span class="theme-swatch-name">Default</span>
        </button>
        <button class="theme-swatch${p.theme === "glass" ? " active" : ""}" data-theme="glass">
          <span class="theme-swatch-color theme-swatch-glass"></span>
          <span class="theme-swatch-name">Glass</span>
        </button>
      </div>

      <div class="theme-sliders">
        <div class="theme-slider-row">
          <label class="theme-slider-label">Hue</label>
          <input id="theme-hue" type="range" min="0" max="360" step="1" value="${p.hue}" class="theme-range hue-range"/>
        </div>
        <div class="theme-slider-row">
          <label class="theme-slider-label">Saturation</label>
          <input id="theme-saturation" type="range" min="0" max="100" step="1" value="${p.saturation}" class="theme-range"/>
        </div>
        <div class="theme-slider-row">
          <label class="theme-slider-label">Brightness</label>
          <input id="theme-brightness" type="range" min="30" max="150" step="1" value="${p.brightness}" class="theme-range"/>
        </div>
        <div class="theme-slider-row">
          <label class="theme-slider-label">Contrast</label>
          <input id="theme-contrast" type="range" min="50" max="200" step="1" value="${p.contrast}" class="theme-range"/>
        </div>
        <div class="theme-slider-row">
          <label class="theme-slider-label">Opacity</label>
          <input id="theme-opacity" type="range" min="20" max="100" step="1" value="${p.opacity}" class="theme-range"/>
        </div>
      </div>
    </div>
  `;
}

function _applyTheme() {
  const frame = document.querySelector(".phone-frame");
  if (!frame) return;
  const p = _prefs;
  const isGlass = p.theme === "glass";
  frame.classList.toggle("theme-glass", isGlass);

  const h = p.hue;
  const s = p.saturation || 100;
  const b = p.brightness / 100;
  const c = (p.contrast || 100) / 100;
  // Opacity slider is piecewise-mapped so it covers the full range:
  //   0%  -> fully transparent (heavy glass, can see right through)
  //   50% -> the per-element designed alpha (classic glass look)
  //   100% -> fully opaque (solid, matches Default theme)
  // The 50% midpoint pins "designed glass" so the slider has meaningful
  // range in both directions instead of bottoming out at the designed alpha.
  const o = p.opacity / 100;
  const opacify = (a) => (o <= 0.5)
    ? a * (o / 0.5)                       // 0% .. 50%: transparent → designed
    : a + (1 - a) * ((o - 0.5) / 0.5);    // 50% .. 100%: designed → solid

  // Accent tracks hue + saturation in every theme.
  frame.style.setProperty("--accent", `hsl(${h}, ${Math.round(s * 0.7)}%, 60%)`);

  // Body halo: only the CORE tracks the theme hue, mid+far stay
  // near-black. Brighter/more-saturated core than the last pass so the
  // glow is actually visible as a professional halo behind the phone.
  const glowSat = Math.max(20, Math.round(s * 0.35));
  document.body.style.setProperty("--body-bg-core", `hsl(${h}, ${glowSat}%, 22%)`);
  document.body.style.setProperty("--body-bg-mid",  `hsl(${h}, ${Math.round(glowSat * 0.4)}%, 9%)`);
  document.body.style.setProperty("--body-bg-far", "#07080a");

  if (isGlass) {
    const sat = Math.round(s * 0.3);
    const satHi = Math.round(s * 0.4);
    const satLo = Math.round(s * 0.2);
    const cl = (base) => Math.min(100, Math.max(0, Math.round((base - 10) * c + 10) * b));
    const bg = (l, a) => `hsla(${h}, ${sat}%, ${cl(l)}%, ${opacify(a)})`;
    frame.style.setProperty("--bg-panel",   bg(8,  0.7));
    frame.style.setProperty("--bg-nav",     bg(5,  0.75));
    frame.style.setProperty("--bg-surface", bg(11, 0.75));
    frame.style.setProperty("--bg-card",    bg(16, 0.55));
    frame.style.setProperty("--bg-input",   bg(6,  0.65));
    const borderL = Math.min(100, Math.round(50 * c));
    frame.style.setProperty("--border",        `hsla(${h}, ${satHi}%, ${borderL}%, ${opacify(0.25)})`);
    frame.style.setProperty("--border-accent", `hsla(${h}, ${satHi}%, ${Math.min(100, borderL + 5)}%, ${opacify(0.35)})`);
    frame.style.setProperty("--btn-bg",        `hsla(${h}, ${satLo}%, 90%, ${opacify(0.06 * c)})`);
    frame.style.setProperty("--btn-hover",     `hsla(${h}, ${satLo}%, 90%, ${opacify(0.10 * c)})`);
    frame.style.setProperty("--frame-border",  `hsla(${h}, ${satHi}%, ${borderL}%, ${opacify(0.30)})`);
    frame.style.setProperty("--scene-border",  `hsl(${h}, ${sat}%, ${cl(8)}%)`);
  } else {
    // Default theme is always fully solid. Reset inline styles so :root
    // vars take effect, and visually disable the opacity slider.
    const vars = ["--bg-panel","--bg-nav","--bg-surface","--bg-card","--bg-input",
      "--border","--border-accent","--btn-bg","--btn-hover","--frame-border","--scene-border"];
    vars.forEach((v) => frame.style.removeProperty(v));
  }

  // The opacity slider only has an effect in Glass theme; disable it in
  // Default so the UI makes it obvious moving it does nothing.
  const opacitySlider = document.getElementById("theme-opacity");
  if (opacitySlider) opacitySlider.disabled = !isGlass;
}

function _persistPrefs() {
  clearTimeout(_saveTimer);
  _saveTimer = setTimeout(() => {
    api.savePrefs(_prefs).catch((e) => console.warn("prefs save failed", e));
  }, 500);
}

function _wireThemePicker() {
  bodyEl.querySelectorAll(".theme-swatch").forEach((btn) => {
    btn.addEventListener("click", () => {
      _prefs.theme = btn.dataset.theme;
      _applyTheme();
      _persistPrefs();
      bodyEl.querySelectorAll(".theme-swatch").forEach((b) => b.classList.remove("active"));
      btn.classList.add("active");
    });
  });

  const wire = (id, key) => {
    const el = bodyEl.querySelector(`#theme-${id}`);
    if (!el) return;
    el.addEventListener("input", () => {
      _prefs[key] = Number(el.value);
      _applyTheme();
    });
    el.addEventListener("change", () => _persistPrefs());
  };
  wire("hue", "hue");
  wire("saturation", "saturation");
  wire("brightness", "brightness");
  wire("contrast", "contrast");
  wire("opacity", "opacity");
}

// Called on boot with server prefs
export function applyStoredTheme(prefs) {
  if (prefs) Object.assign(_prefs, prefs);
  _applyTheme();
}


function _adminFormHTML() {
  const cats = Object.keys(state.categories || {});
  const catOptions = cats.map((c) => `<option value="${c}">${_label(c)}</option>`).join("");
  return `
    <form id="upload-form" class="upload-form">
      <div class="upload-preview" id="upload-preview" contenteditable="true"></div>
      <div class="upload-actions">
        <label class="upload-file-label btn-pill">
          Browse
          <input id="upload-file" type="file" accept="image/*" hidden/>
        </label>
      </div>

      <div class="upload-field">
        <span>Category</span>
        <div class="chip-group" id="cat-chips"></div>
        <input id="upload-category" type="hidden" value="${cats[0] || ''}"/>
      </div>

      <div class="upload-field">
        <span>Subcategory</span>
        <div class="chip-group" id="sub-chips"></div>
        <input id="upload-subcategory" type="hidden"/>
      </div>

      <label class="upload-rename">
        <input id="upload-rename-check" type="checkbox"/>
        <span>Rename image?</span>
        <input id="upload-name" type="text" placeholder="e.g. blue_couch" disabled/>
        <span class="upload-hint-text">lowercase, underscores for spaces</span>
      </label>

      <label class="upload-overwrite">
        <input id="upload-overwrite-check" type="checkbox"/>
        <span>Overwrite existing</span>
      </label>

      <button type="submit" class="btn-pill primary" id="upload-submit">Upload</button>
      <p id="upload-status" class="muted small"></p>
    </form>
  `;
}


function _wireAdminForm() {
  const fileInput = bodyEl.querySelector("#upload-file");
  const preview = bodyEl.querySelector("#upload-preview");
  const catInput = bodyEl.querySelector("#upload-category");
  const renameChk = bodyEl.querySelector("#upload-rename-check");
  const nameInput = bodyEl.querySelector("#upload-name");
  const form = bodyEl.querySelector("#upload-form");
  const status = bodyEl.querySelector("#upload-status");

  let pickedBlob = null;
  let pickedFilename = null;

  function showPreview(file) {
    const url = URL.createObjectURL(file);
    preview.innerHTML = `<img src="${url}" alt="upload preview"/>`;
  }
  function pick(file, fallbackName) {
    pickedBlob = file;
    pickedFilename = fallbackName || file.name || "image";
    showPreview(file);
  }

  fileInput.addEventListener("change", () => {
    const f = fileInput.files[0];
    if (f) pick(f, f.name);
  });

  // Paste — the preview area is contenteditable so it handles both
  // Ctrl+V on desktop and long-press → Paste on mobile (no HTTPS needed).
  preview.addEventListener("paste", (e) => {
    const items = e.clipboardData?.items || [];
    for (const item of items) {
      if (item.type.startsWith("image/")) {
        const blob = item.getAsFile();
        if (blob) {
          e.preventDefault();
          pick(blob, blob.name || `pasted_${Date.now()}.png`);
          return;
        }
      }
    }
  });
  // Clear any accidentally typed or pasted text
  preview.addEventListener("input", () => {
    if (!pickedBlob) preview.innerHTML = "";
  });

  // Document-level paste — so Ctrl+V works anywhere when drawer is open
  document.addEventListener("paste", (e) => {
    if (!drawerEl.classList.contains("open")) return;
    const items = e.clipboardData?.items || [];
    for (const item of items) {
      if (item.type.startsWith("image/")) {
        const blob = item.getAsFile();
        if (blob) {
          e.preventDefault();
          pick(blob, blob.name || `pasted_${Date.now()}.png`);
          return;
        }
      }
    }
  });

  const catChips = bodyEl.querySelector("#cat-chips");
  const subChips = bodyEl.querySelector("#sub-chips");
  const subInput = bodyEl.querySelector("#upload-subcategory");

  function buildChips(container, items, hiddenInput, onSelect) {
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
    // "+ New" chip
    const add = document.createElement("button");
    add.type = "button";
    add.className = "chip chip-new";
    add.textContent = "+ New";
    add.addEventListener("click", () => {
      // Replace + New chip with inline input
      const inp = document.createElement("input");
      inp.type = "text";
      inp.className = "chip-input";
      inp.placeholder = "new name";
      container.replaceChild(inp, add);
      inp.focus();
      function commit() {
        const v = inp.value.trim().toLowerCase().replace(/\s+/g, "_").replace(/[^a-z0-9_]/g, "");
        if (v) {
          hiddenInput.value = v;
          if (onSelect) onSelect(v);
          // Add to state so it persists in this session
          if (container === catChips && !(v in (state.categories || {}))) {
            state.categories = state.categories || {};
            state.categories[v] = [];
          } else if (container === subChips) {
            const cat = catInput.value;
            if (cat && state.categories?.[cat] && !state.categories[cat].includes(v)) {
              state.categories[cat].push(v);
            }
          }
        }
        // Rebuild chips with new item included
        if (container === catChips) renderCatChips();
        else renderSubChips();
      }
      inp.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); commit(); } });
      inp.addEventListener("blur", commit);
    });
    container.appendChild(add);
  }

  function renderCatChips() {
    const cats = Object.keys(state.categories || {});
    buildChips(catChips, cats, catInput, () => renderSubChips());
  }
  function renderSubChips() {
    const subs = (state.categories && state.categories[catInput.value]) || [];
    subInput.value = "";
    buildChips(subChips, subs, subInput);
  }
  renderCatChips();
  renderSubChips();

  renameChk.addEventListener("change", () => { nameInput.disabled = !renameChk.checked; });
  nameInput.addEventListener("input", () => {
    nameInput.value = nameInput.value.toLowerCase().replace(/\s+/g, "_").replace(/[^a-z0-9_]/g, "");
  });

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    if (!pickedBlob) { status.textContent = "Pick or paste an image first."; return; }
    const category = catInput.value.trim();
    const subcategory = bodyEl.querySelector("#upload-subcategory").value.trim();
    if (!category || !subcategory) { status.textContent = "Category + subcategory required."; return; }

    let name = (pickedFilename || "image").replace(/\.[^.]*$/, ""); // strip extension
    if (renameChk.checked && nameInput.value.trim()) name = nameInput.value.trim();

    status.textContent = "Uploading...";
    try {
      const overwrite = bodyEl.querySelector("#upload-overwrite-check").checked;
      const data = await api.uploadCatalogItem({
        image: pickedBlob,
        category,
        subcategory,
        name,
        overwrite,
      });
      const msg = `✓ "${data.name}" uploaded to ${_label(data.category)} → ${_label(data.subcategory)}`;
      // Reset the picked blob so a new selection is needed for next upload.
      pickedBlob = null;
      pickedFilename = null;
      fileInput.value = "";
      preview.innerHTML = "";
      if (onCatalogUpdated) await onCatalogUpdated();
      // Refresh category dropdowns in case a new one was created.
      _render();
      // Restore status after re-render
      const newStatus = bodyEl.querySelector("#upload-status");
      if (newStatus) newStatus.textContent = msg;
    } catch (err) {
      status.textContent = `Failed: ${err.message}`;
    }
  });
}


function _label(s) {
  return s.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}
