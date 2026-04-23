// Entry point. Loads data, wires modules together, kicks off first render.

import { state, markDirty } from "./state.js";
import { api } from "./api.js";
import { preloadAll } from "./images.js";
import { initCanvas, render } from "./canvas.js";
import { initCatalog } from "./catalog.js";
import { initControls } from "./controls.js";
import { initDrawer } from "./drawer.js";
import { initBackgrounds } from "./backgrounds.js";
import { initRooms, attachSceneSwipe } from "./rooms.js";
import { initInventory } from "./inventory.js";
import { initSettings, applyStoredTheme } from "./settings.js";
import { setMode, refreshForSelection } from "./panel.js";


async function boot() {
  let me;
  try {
    me = await api.me();
  } catch (err) {
    // No session → kick to the login page. This matters for the GH Pages
    // build: there's no server-side redirect on 401, so we handle it here.
    window.location.href = "login.html";
    return;
  }
  state.username = me.username;
  state.isAdmin = Boolean(me.is_admin);

  const brandUserEl = document.getElementById("brand-user");
  if (brandUserEl) brandUserEl.textContent = me.username;
  document.title = `Places — ${me.username}`;

  const prefs = await api.getPrefs().catch(() => null);
  applyStoredTheme(prefs);

  async function refreshCatalog() {
    const c = await api.catalog();
    state.catalog = c.items;
    state.categories = c.categories;
    // Rebuild the catalog drawer filters + tiles so the new item shows up.
    const { rebuildCatalog } = await import("./catalog.js");
    if (rebuildCatalog) rebuildCatalog();
  }

  const cat = await api.catalog();
  state.catalog = cat.items;
  state.categories = cat.categories;

  const roomNameEl = document.getElementById("room-name");

  function updateRoomName() {
    roomNameEl.textContent = state.room.name || "Untitled";
  }

  await initRooms({
    dotsContainer: document.getElementById("room-dots"),
    onRoomChange: () => { render(); updateRoomName(); },
    onPanelReset: () => { setMode("empty"); refreshForSelection(); },
  });

  // Editable room name — save on blur or Enter
  roomNameEl.addEventListener("blur", () => {
    const name = roomNameEl.textContent.trim() || "Untitled";
    roomNameEl.textContent = name;
    if (state.room.name !== name) {
      state.room.name = name;
      markDirty();
    }
  });
  roomNameEl.addEventListener("keydown", (e) => {
    if (e.key === "Enter") { e.preventDefault(); roomNameEl.blur(); }
  });

  updateRoomName();

  await preloadAll(state.room.objects.map((o) => o.url));

  initCatalog({
    list: document.getElementById("catalog-list"),
    search: document.getElementById("catalog-search"),
    category: document.getElementById("catalog-category"),
    subcategory: document.getElementById("catalog-subcategory"),
  });

  initDrawer({
    drawer: document.getElementById("catalog-drawer"),
    backdrop: document.getElementById("drawer-backdrop"),
    openTriggers: [document.querySelector('[data-nav="catalog"]')],
    closeTriggers: [document.getElementById("catalog-close")],
  });

  initInventory({
    drawer: document.getElementById("inventory-drawer"),
    toggle: document.getElementById("inventory-btn"),
    list: document.getElementById("inventory-list"),
    sortAscBtn: document.getElementById("inv-sort-asc"),
    sortDescBtn: document.getElementById("inv-sort-desc"),
    deleteRoomBtn: document.getElementById("inv-delete-room"),
    closeBtn: document.getElementById("inventory-close"),
    backdrop: document.getElementById("drawer-backdrop"),
    onChange: render,
    onPanelReset: refreshForSelection,
  });

  initSettings({
    drawer: document.getElementById("settings-drawer"),
    toggle: document.querySelector('[data-nav="settings"]'),
    body: document.getElementById("settings-body"),
    closeBtn: document.getElementById("settings-close"),
    backdrop: document.getElementById("drawer-backdrop"),
    onCatalogChange: refreshCatalog,
  });

  initControls();

  // Bottom nav: home is just "close any drawer", logout submits the hidden form.
  document.querySelector(".bottom-nav")
    .addEventListener("click", _onNavClick);

  initCanvas(document.getElementById("room-canvas"));
  attachSceneSwipe(document.querySelector(".scene"));

  await initBackgrounds({
    button: document.getElementById("bg-picker-btn"),
    popover: document.getElementById("bg-popover"),
    list: document.getElementById("bg-list"),
    onChange: render,
  });

  // Toggle UI overlays
  const scene = document.querySelector(".scene");
  const hideBtn = document.getElementById("hide-ui-btn");
  const hideBtnLabel = hideBtn.querySelector(".home-tool-label");
  const hideBtnIcon = hideBtn.querySelector(".home-tool-icon");
  hideBtn.addEventListener("click", () => {
    scene.classList.toggle("ui-hidden");
    const hidden = scene.classList.contains("ui-hidden");
    hideBtnLabel.textContent = hidden ? "Show canvas UI" : "Hide canvas UI";
    hideBtnIcon.classList.toggle("eye-closed", hidden);
    hideBtn.classList.toggle("active", hidden);
  });

  // Screenshot: capture canvas and download
  document.getElementById("screenshot-btn").addEventListener("click", () => {
    const c = document.getElementById("room-canvas");
    c.toBlob((blob) => {
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = `room_${Date.now()}.png`;
      a.click();
      URL.revokeObjectURL(a.href);
    });
  });

  setMode("empty");
  render();
}


function _onNavClick(evt) {
  const btn = evt.target.closest("button[data-nav]");
  if (!btn) return;
  const nav = btn.dataset.nav;
  if (nav === "home") {
    state.selectedId = null;
    setMode("empty");
    render();
  } else if (nav === "logout") {
    api.logout().finally(() => { window.location.href = "login.html"; });
  }
}


boot().catch((err) => {
  console.error("Boot failed:", err);
  alert("Failed to start the app — check the console.");
});
