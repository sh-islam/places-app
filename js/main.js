// Entry point. Loads data, wires modules together, kicks off first render.

import { state, markDirty } from "./state.js";
import { api, authToken } from "./api.js";
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
import { initRecategorize } from "./recategorize.js";
import { initAdvancedEdit } from "./advanced_edit.js";
import { initGifLayer } from "./gif_layer.js";


// Block the casual image-save paths (right-click Save Image, long-
// press menu on iOS, drag-into-new-tab-to-save). Native drag already
// suppressed via CSS -webkit-user-drag: none; this kills the context
// menu entry too. Doesn't stop screenshots or devtools — nothing can.
document.addEventListener("contextmenu", (e) => {
  if (e.target instanceof HTMLImageElement
      || e.target instanceof HTMLCanvasElement) {
    e.preventDefault();
  }
});
document.addEventListener("dragstart", (e) => {
  if (e.target instanceof HTMLImageElement) e.preventDefault();
});


async function boot() {
  // If login.js tacked a token onto the URL hash (#t=...), adopt it and
  // clean the URL. This is the safety net for mobile browsers that
  // occasionally drop localStorage entries across a same-origin navigation.
  const hashToken = (location.hash.match(/[#&]t=([^&]+)/) || [])[1];
  if (hashToken) {
    authToken.set(decodeURIComponent(hashToken));
    history.replaceState(null, "", location.pathname + location.search);
  }

  let me;
  try {
    me = await api.me();
  } catch (err) {
    // No valid session/token → kick to the login page. This matters for
    // the GH Pages build: there's no server-side redirect on 401, so we
    // handle it here. Stale token cleared so the next login writes a fresh one.
    authToken.clear();
    window.location.href = "login.html";
    return;
  }
  state.username = me.username;
  state.isAdmin = Boolean(me.is_admin);
  state.isSuperadmin = Boolean(me.is_superadmin);
  // CSS toggles admin-only UI affordances (delete icon on tiles, rename
  // button in Selected panel) via body.is-admin / body.is-superadmin.
  document.body.classList.toggle("is-admin",      state.isAdmin);
  document.body.classList.toggle("is-superadmin", state.isSuperadmin);

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
  initRecategorize();
  initAdvancedEdit();

  // Bottom nav: home is just "close any drawer", logout submits the hidden form.
  document.querySelector(".bottom-nav")
    .addEventListener("click", _onNavClick);

  initCanvas(document.getElementById("room-canvas"));
  initGifLayer(document.getElementById("gif-layer"));
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

  // Screenshot: capture canvas + any DOM-overlay GIFs into a single
  // PNG/JPG. Composites by cloning the live canvas, then drawing each
  // GIF <img>'s current frame on top under the same CSS matrix the
  // overlay uses so positions line up. If any GIFs are on canvas the
  // user gets a choice of format (JPG = smaller, white bg; PNG =
  // lossless, transparent). Animated GIF export is not supported
  // (would need a multi-frame encoder library) — noted in prompt.
  document.getElementById("screenshot-btn").addEventListener("click", async () => {
    const srcCanvas = document.getElementById("room-canvas");
    const gifLayer = document.getElementById("gif-layer");
    const overlayImgs = gifLayer
      ? Array.from(gifLayer.querySelectorAll("img"))
        .filter((im) => im.style.visibility !== "hidden" && im.naturalWidth > 0)
      : [];

    let format = "png";
    if (overlayImgs.length > 0) {
      const wantsJpg = window.confirm(
        "This scene has animated GIFs. Animated GIF export isn't supported; " +
        "the snapshot will be a still image.\n\n" +
        "OK = JPG (smaller, white background)\n" +
        "Cancel = PNG (lossless, transparent)"
      );
      format = wantsJpg ? "jpg" : "png";
    }

    // Compose onto an offscreen canvas sized to the live backing store.
    const dpr = window.devicePixelRatio || 1;
    const out = document.createElement("canvas");
    out.width = srcCanvas.width;
    out.height = srcCanvas.height;
    const octx = out.getContext("2d");
    if (format === "jpg") {
      // JPG has no alpha — paint a white bg so transparent regions aren't black.
      octx.fillStyle = "#ffffff";
      octx.fillRect(0, 0, out.width, out.height);
    }
    // Copy the live canvas (bg + non-GIF items).
    octx.drawImage(srcCanvas, 0, 0);

    // Draw each GIF's current frame. Parse its CSS transform (matrix(a,b,c,d,e,f),
    // CSS-pixel units) and apply it to the canvas 2D ctx, scaled by dpr so the
    // composite lines up with the backing-store canvas.
    for (const img of overlayImgs) {
      const cs = getComputedStyle(img);
      const m = cs.transform;
      if (!m || m === "none") continue;
      const match = /matrix\(([-0-9eE., ]+)\)/.exec(m);
      if (!match) continue;
      const [a, b, c, d, e, f] = match[1].split(",").map((s) => parseFloat(s));
      octx.save();
      // CSS pixels → backing pixels: all components of the translate AND the
      // linear scale need dpr. The linear (a,b,c,d) are dimensionless ratios
      // in CSS space, but since the source <img> is sized in CSS pixels and
      // we're drawing into backing pixels, scaling them by dpr converts
      // everything into the right coordinate system.
      octx.setTransform(a * dpr, b * dpr, c * dpr, d * dpr, e * dpr, f * dpr);
      octx.drawImage(img, 0, 0, img.naturalWidth, img.naturalHeight);
      octx.restore();
    }

    out.toBlob(
      (blob) => {
        const a = document.createElement("a");
        a.href = URL.createObjectURL(blob);
        a.download = `room_${Date.now()}.${format === "jpg" ? "jpg" : "png"}`;
        a.click();
        URL.revokeObjectURL(a.href);
      },
      format === "jpg" ? "image/jpeg" : "image/png",
      1.0,
    );
  });

  // Lock / unlock all items — when unlocked, any item can be dragged
  // directly on the canvas without entering edit mode. Session-scope
  // only (resets to "locked" on reload) so the default safe behaviour
  // is always the norm on fresh sessions.
  const lockBtn = document.getElementById("lock-toggle-btn");
  const lockIcon  = lockBtn.querySelector(".home-tool-icon");
  const lockLabel = lockBtn.querySelector(".home-tool-label");
  function syncLockBtn() {
    if (state.itemsUnlocked) {
      lockIcon.textContent = "🔓";
      lockLabel.textContent = "Lock canvas";
      lockBtn.classList.add("active");
    } else {
      lockIcon.textContent = "🔒";
      lockLabel.textContent = "Unlock canvas";
      lockBtn.classList.remove("active");
    }
  }
  lockBtn.addEventListener("click", () => {
    state.itemsUnlocked = !state.itemsUnlocked;
    syncLockBtn();
  });
  syncLockBtn();

  setMode("empty");
  render();

  // Desktop-only 10-second intro glow pulse. Mobile (<768px) is
  // untouched — its layout is final and we explicitly don't want any
  // boot-time animation competing with the phone-frame itself.
  if (window.matchMedia("(min-width: 768px)").matches) {
    document.body.classList.add("intro-pulse");
    setTimeout(() => document.body.classList.remove("intro-pulse"), 10000);
  }
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
    _playGoodbyeSplashAndLogout();
  }
}


async function _playGoodbyeSplashAndLogout() {
  const splash = document.getElementById("splash-overlay");
  const textEl = document.getElementById("splash-text");
  if (!splash || !textEl) {
    // Safety fallback if the overlay isn't in the DOM for some reason.
    api.logout().finally(() => {
      authToken.clear();
      window.location.href = "login.html";
    });
    return;
  }
  const slogan = "Goodbye. This place will always be yours.";
  splash.hidden = false;

  // Start fetching login.html + its resources the moment the splash
  // opens so by the time we actually navigate, the new page paints
  // instantly. Without this hint the browser kept the old game view
  // painted for a split second after navigation while it fetched the
  // next page — that's the "I can still see my canvas" flash.
  for (const href of ["login.html", "js/login.js", "icon.png"]) {
    const link = document.createElement("link");
    link.rel = "prefetch";
    link.href = href;
    document.head.appendChild(link);
  }

  // Typewriter.
  for (let i = 1; i <= slogan.length; i++) {
    textEl.textContent = slogan.slice(0, i);
    await new Promise((r) => setTimeout(r, 55));
  }
  await new Promise((r) => setTimeout(r, 900));
  // Fire the logout alongside the splash (non-blocking so the user
  // doesn't wait on the network) and navigate immediately. No fade
  // out — a fade would briefly reveal the main app behind the
  // splash, which the user shouldn't see again after saying goodbye.
  api.logout().catch(() => {});
  authToken.clear();
  window.location.href = "login.html";
}


boot().catch((err) => {
  console.error("Boot failed:", err);
  // Include the actual error message + stack in the alert so we don't
  // need the user to paste from the devtools console to diagnose.
  const stackLine = (err?.stack || "").split("\n").slice(0, 3).join("\n");
  alert(
    "Failed to start the app.\n\n" +
    `${err?.name || "Error"}: ${err?.message || err}\n\n` +
    stackLine
  );
});
