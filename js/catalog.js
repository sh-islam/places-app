// Renders the catalog drawer: search, category + subcategory filters, items.
// Items support both tap-to-add (mobile) and drag-to-canvas (desktop).

import { state } from "./state.js";
import { toLabel, itemDisplayName } from "./labels.js";
import { addCatalogItemAtCenter } from "./canvas.js";
import { closeDrawer } from "./drawer.js";
import { assetUrl } from "./config.js";


let listEl = null;
let searchEl = null;
let categoryEl = null;
let subcategoryEl = null;


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

  renderCatalog();
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

  listEl.innerHTML = "";
  for (const item of filtered) {
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
