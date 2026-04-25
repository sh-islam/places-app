// Renders the catalog drawer: search, category + subcategory filters, items.
// Items support both tap-to-add (mobile) and drag-to-canvas (desktop).

import { state } from "./state.js";
import { toLabel, itemDisplayName } from "./labels.js";
import { addCatalogItemAtCenter } from "./canvas.js";
import { closeDrawer } from "./drawer.js";
import { assetUrl } from "./config.js";
import { api } from "./api.js";


let listEl = null;
let searchEl = null;
let categoryEl = null;
let subcategoryEl = null;

// Sort state. Persists across catalog re-renders in this session.
// "name" = alphabetical by item.name; "time" = by file mtime (newest
// uploads/edits either first or last depending on direction).
let _sortMode = "name";   // "name" | "time"
let _sortDir  = "asc";    // "asc" | "desc" (↓ / ↑)


export function initCatalog(els) {
  listEl = els.list;
  searchEl = els.search;
  categoryEl = els.category;
  subcategoryEl = els.subcategory;

  _populateCategoryDropdown();
  _populateSubcategoryDropdown();

  searchEl.addEventListener("input", renderCatalog);
  categoryEl.addEventListener("change", () => {
    _populateSubcategoryDropdown();
    renderCatalog();
  });
  subcategoryEl.addEventListener("change", renderCatalog);

  // Sort controls (in the drawer header). Clicking a mode button picks
  // that mode; the direction button toggles ↓ (asc) / ↑ (desc).
  document.getElementById("catalog-sort-name")
    ?.addEventListener("click", () => _setSortMode("name"));
  document.getElementById("catalog-sort-time")
    ?.addEventListener("click", () => _setSortMode("time"));
  document.getElementById("catalog-sort-dir")
    ?.addEventListener("click", _toggleSortDir);
  _syncSortButtons();

  renderCatalog();
}


function _setSortMode(mode) {
  _sortMode = mode;
  // Default direction so the arrow reads ↓ in both modes — i.e. the
  // "natural" expectation for each: A→Z for alpha (asc) and
  // newest-first for time (desc). Users can still flip with the
  // direction button after switching modes.
  _sortDir = mode === "time" ? "desc" : "asc";
  _syncSortButtons();
  renderCatalog();
}


function _toggleSortDir() {
  _sortDir = _sortDir === "asc" ? "desc" : "asc";
  _syncSortButtons();
  renderCatalog();
}


function _syncSortButtons() {
  const nameBtn = document.getElementById("catalog-sort-name");
  const timeBtn = document.getElementById("catalog-sort-time");
  const dirBtn  = document.getElementById("catalog-sort-dir");
  if (nameBtn) nameBtn.classList.toggle("active", _sortMode === "name");
  if (timeBtn) timeBtn.classList.toggle("active", _sortMode === "time");
  if (dirBtn) {
    // Arrow convention is per-mode, matching what "feels natural" for
    // each sort: ↓ on alpha = A→Z (the default you'd reach for), ↓ on
    // time = newest-first (the default you'd reach for). Swapping to ↑
    // means the opposite direction. The underlying _sortDir semantics
    // don't change — only the icon.
    const downIsAsc = _sortMode !== "time";
    const down = downIsAsc ? _sortDir === "asc" : _sortDir === "desc";
    dirBtn.textContent = down ? "↓" : "↑";
    if (_sortMode === "time") {
      dirBtn.title = _sortDir === "desc"
        ? "Newest first. Click to flip."
        : "Oldest first. Click to flip.";
    } else {
      dirBtn.title = _sortDir === "asc"
        ? "A→Z. Click to flip."
        : "Z→A. Click to flip.";
    }
  }
}


function _sortItems(items) {
  const sign = _sortDir === "asc" ? 1 : -1;
  return items.slice().sort((a, b) => {
    if (_sortMode === "time") {
      return sign * ((a.mtime || 0) - (b.mtime || 0));
    }
    return sign * a.name.localeCompare(b.name);
  });
}


function _populateCategoryDropdown() {
  // Reset to the "all" option before repopulating (important when called
  // again after an admin uploads a new category).
  categoryEl.innerHTML = '<option value="">All categories</option>';
  const cats = Object.keys(state.categories || {}).sort();
  for (const cat of cats) {
    const opt = document.createElement("option");
    opt.value = cat;
    opt.textContent = toLabel(cat);
    categoryEl.appendChild(opt);
  }
}


// Full rebuild after state.categories/state.catalog changes (e.g. admin upload).
export function rebuildCatalog() {
  if (!listEl) return;
  _populateCategoryDropdown();
  _populateSubcategoryDropdown();
  renderCatalog();
}


function _populateSubcategoryDropdown() {
  subcategoryEl.innerHTML = '<option value="">All subcategories</option>';
  const chosenCat = categoryEl.value;
  if (!chosenCat) return;
  const subs = (state.categories[chosenCat] || []).slice().sort();
  for (const sub of subs) {
    const opt = document.createElement("option");
    opt.value = sub;
    opt.textContent = toLabel(sub);
    subcategoryEl.appendChild(opt);
  }
}


export function renderCatalog() {
  const query = (searchEl.value || "").trim().toLowerCase();
  const category = categoryEl.value || "";
  const subcategory = subcategoryEl.value || "";
  const filtered = state.catalog.filter((item) =>
    _matches(item, query, category, subcategory)
  );
  const sorted = _sortItems(filtered);

  listEl.innerHTML = "";
  for (const item of sorted) {
    listEl.appendChild(_buildItemCard(item));
  }
}


function _matches(item, query, category, subcategory) {
  if (category && item.category !== category) return false;
  if (subcategory && item.subcategory !== subcategory) return false;
  if (!query) return true;
  if (item.name.toLowerCase().includes(query)) return true;
  return item.tags.some((t) => t.toLowerCase().includes(query));
}


function _buildItemCard(item) {
  const card = document.createElement("div");
  card.className = "catalog-item";
  card.draggable = true;
  card.dataset.assetId = item.asset_id;
  card.title = `Tap to add — tags: ${item.tags.map(toLabel).join(", ")}`;

  const img = document.createElement("img");
  img.src = assetUrl(item.url);
  img.alt = item.name;
  card.appendChild(img);

  const name = document.createElement("div");
  name.className = "name";
  name.textContent = itemDisplayName(item.name);
  card.appendChild(name);

  const tags = document.createElement("div");
  tags.className = "tags";
  tags.textContent = `${toLabel(item.category)} · ${toLabel(item.subcategory)}`;
  card.appendChild(tags);

  // Admin-only delete icon. Visible via CSS when body.is-admin is set.
  if (state.isAdmin) {
    const del = document.createElement("button");
    del.className = "catalog-item-del";
    del.type = "button";
    del.title = "Delete this item from the catalog";
    del.textContent = "×"; // ×
    del.addEventListener("click", async (e) => {
      e.stopPropagation(); // don't also fire the card's tap-to-add
      const warn =
        `"${itemDisplayName(item.name)}" will be deleted from the server ` +
        `(moved to the Deleted/ folder — you can restore manually). Continue?`;
      if (!window.confirm(warn)) return;
      try {
        await api.deleteCatalogItem(item.url);
        // Full refresh so filters + tiles reflect the removal.
        const fresh = await api.catalog();
        state.catalog = fresh.items;
        state.categories = fresh.categories;
        rebuildCatalog();
      } catch (err) {
        alert(`Delete failed: ${err.message}`);
      }
    });
    card.appendChild(del);
  }

  // Desktop drag-and-drop
  card.addEventListener("dragstart", (e) => {
    e.dataTransfer.setData("text/asset-id", item.asset_id);
    e.dataTransfer.effectAllowed = "copy";
  });

  // Mobile-friendly tap-to-add
  card.addEventListener("click", () => {
    addCatalogItemAtCenter(item);
    closeDrawer();
  });

  return card;
}
