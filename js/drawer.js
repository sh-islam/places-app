// Catalog slide-up drawer open/close.

let drawerEl = null;
let backdropEl = null;


export function initDrawer({ drawer, backdrop, openTriggers, closeTriggers }) {
  drawerEl = drawer;
  backdropEl = backdrop;

  for (const el of openTriggers) {
    el.addEventListener("click", openDrawer);
  }
  for (const el of closeTriggers) {
    el.addEventListener("click", closeDrawer);
  }
  backdropEl.addEventListener("click", closeDrawer);
}


export function openDrawer() {
  if (!drawerEl) return;
  drawerEl.classList.add("open");
  drawerEl.setAttribute("aria-hidden", "false");
  backdropEl.classList.add("open");
}


export function closeDrawer() {
  if (!drawerEl) return;
  drawerEl.classList.remove("open");
  drawerEl.setAttribute("aria-hidden", "true");
  backdropEl.classList.remove("open");
}


export function isOpen() {
  return drawerEl?.classList.contains("open");
}
