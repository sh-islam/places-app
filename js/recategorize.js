// Admin-only: move a catalog item to a different category / subcategory.
// Lives at the bottom of selected-mode as two chip groups + a Go button.
// On submit, backend moves the file on disk and retargets every saved
// room's URL; this module mirrors those changes in local state and
// refreshes the UI.

import { state } from "./state.js";
import { api } from "./api.js";
import { findObject } from "./objects.js";
// panel.js and canvas.js are NOT imported statically — canvas.js imports
// from panel.js, so if recategorize.js also pulled them in statically we'd
// risk a cycle at boot (empty-namespace bindings on Chrome). We resolve
// both lazily inside _doMove() instead, which only runs on user click.


let _catInput = null;
let _subInput = null;
let _catChips = null;
let _subChips = null;
let _selMoveBtn = null;


export function initRecategorize() {
  _catInput = document.getElementById("sel-cat");
  _subInput = document.getElementById("sel-sub");
  _catChips = document.getElementById("sel-cat-chips");
  _subChips = document.getElementById("sel-sub-chips");
  _selMoveBtn = document.getElementById("sel-move-btn");
  if (!_catInput || !_subInput || !_catChips || !_subChips || !_selMoveBtn) {
    return;
  }

  _selMoveBtn.addEventListener("click", _doMove);

  // Repopulate every time selected-mode becomes active so the chips
  // reflect the newly-selected item's current category/subcategory.
  // Using a MutationObserver here keeps panel.js free of any import
  // back to this module (avoids circular-import footguns).
  const selectedMode = document.querySelector('[data-mode="selected"]');
  if (selectedMode) {
    new MutationObserver(() => {
      if (selectedMode.classList.contains("active")) _refresh();
    }).observe(selectedMode, { attributes: true, attributeFilter: ["class"] });
  }
}


function _refresh() {
  if (!state.isAdmin) return;
  const obj = state.selectedId ? findObject(state.selectedId) : null;
  if (!obj) return;

  const [curCat, curSub] = _parseCatSub(obj.url);
  _catInput.value = curCat || "";
  _subInput.value = curSub || "";
  _renderCatChips();
  _renderSubChips();
  _syncMoveEnabled();
}


function _renderCatChips() {
  const cats = Object.keys(state.categories || {}).sort();
  _buildChips(_catChips, cats, _catInput, (v) => {
    // Switching category resets subcategory so we don't carry the old
    // sub across categories (usually invalid there).
    _subInput.value = "";
    _renderSubChips();
    _syncMoveEnabled();
  });
}


function _renderSubChips() {
  const cat = _catInput.value;
  const subs = (state.categories && state.categories[cat]) || [];
  _buildChips(_subChips, subs, _subInput, () => _syncMoveEnabled());
}


// Mirrors the pattern used by settings.js's upload form. Each item is a
// clickable chip; the trailing "+ New" chip replaces itself with an
// input on click so the admin can create a new category/subcategory
// without leaving the panel.
function _buildChips(container, items, hiddenInput, onSelect) {
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

  const add = document.createElement("button");
  add.type = "button";
  add.className = "chip chip-new";
  add.textContent = "+ New";
  add.addEventListener("click", () => {
    const inp = document.createElement("input");
    inp.type = "text";
    inp.className = "chip-input";
    inp.placeholder = "new name";
    container.replaceChild(inp, add);
    inp.focus();

    let committed = false;
    const commit = () => {
      if (committed) return;
      committed = true;
      const v = _slug(inp.value);
      if (!v) {
        // Empty -> just re-render so the + New chip comes back.
        if (container === _catChips) _renderCatChips();
        else _renderSubChips();
        return;
      }
      // Persist in local state so the new cat/sub exists before the
      // backend learns about it (the backend happily auto-creates on
      // move). Then switch the hidden input to the new value.
      if (container === _catChips) {
        state.categories = state.categories || {};
        if (!(v in state.categories)) state.categories[v] = [];
        _catInput.value = v;
        _subInput.value = "";
        _renderCatChips();
        _renderSubChips();
      } else {
        const cat = _catInput.value;
        if (cat) {
          state.categories = state.categories || {};
          state.categories[cat] = state.categories[cat] || [];
          if (!state.categories[cat].includes(v)) state.categories[cat].push(v);
        }
        _subInput.value = v;
        _renderSubChips();
      }
      _syncMoveEnabled();
    };
    inp.addEventListener("keydown", (e) => {
      if (e.key === "Enter") { e.preventDefault(); commit(); }
    });
    inp.addEventListener("blur", commit);
  });
  container.appendChild(add);
}


// Go is enabled whenever the chip selections differ from where the
// item currently lives AND both cat + sub have a value.
function _syncMoveEnabled() {
  const obj = state.selectedId ? findObject(state.selectedId) : null;
  if (!obj || !_catInput.value || !_subInput.value) {
    _selMoveBtn.disabled = true;
    return;
  }
  const [curCat, curSub] = _parseCatSub(obj.url);
  _selMoveBtn.disabled =
    (_catInput.value === curCat && _subInput.value === curSub);
}


async function _doMove() {
  if (!state.isAdmin) return;
  const obj = state.selectedId ? findObject(state.selectedId) : null;
  if (!obj) return;

  const oldUrl = obj.url;
  const newCat = _catInput.value;
  const newSub = _subInput.value;
  if (!newCat || !newSub) return;

  _selMoveBtn.disabled = true;
  try {
    const res = await api.moveCatalogItem(oldUrl, newCat, newSub);
    const newUrl = res.url;

    // Mirror the backend's room sweep in local state so the canvas + panel
    // reflect the move without a full reload.
    for (const room of state.rooms || []) {
      for (const o of room.objects || []) {
        if (o.url === oldUrl) {
          o.url = newUrl;
          o.asset_id = res.asset_id;
          o.tags = [newCat, newSub, res.name];
        }
      }
    }

    // Pull fresh catalog so the item appears under its new cat/sub.
    const c = await api.catalog();
    state.catalog = c.items;
    state.categories = c.categories;
    const { rebuildCatalog } = await import("./catalog.js");
    rebuildCatalog();

    const { refreshForSelection } = await import("./panel.js");
    refreshForSelection();
    const { render } = await import("./canvas.js");
    render();
  } catch (err) {
    alert(`Move failed: ${err.message}`);
    _syncMoveEnabled();
  }
}


function _parseCatSub(url) {
  const parts = (url || "").replace(/^\/catalog\//, "").split("/");
  return [parts[0], parts[1]];
}


function _slug(s) {
  return (s || "").trim().toLowerCase()
    .replace(/\s+/g, "_")
    .replace(/[^a-z0-9_]/g, "");
}


function _label(s) {
  return s.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}
