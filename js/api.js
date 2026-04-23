// Thin wrappers around our Flask JSON endpoints.
//
// Every request uses `credentials: "include"` so the Flask session cookie
// rides along with cross-origin calls (GitHub Pages frontend → Tailscale-
// Funnel backend). Same-origin deploys are unaffected — "include" is a
// superset of "same-origin".
//
// All paths get prefixed with BACKEND_BASE from config.js, which is "" in
// same-origin mode and e.g. "https://shad-server.tailnet.ts.net" in prod.

import { BACKEND_BASE } from "./config.js";


function url(path) {
  return `${BACKEND_BASE}${path}`;
}


async function getJson(path) {
  const res = await fetch(url(path), { credentials: "include" });
  if (!res.ok) throw new Error(`GET ${path} failed: ${res.status}`);
  return res.json();
}


async function postJson(path, body) {
  const res = await fetch(url(path), {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`POST ${path} failed: ${res.status}`);
  return res.json();
}


export const api = {
  me: () => getJson("/api/me"),
  catalog: () => getJson("/api/catalog"),
  backgrounds: () => getJson("/api/backgrounds"),

  getPrefs: () => getJson("/api/prefs"),
  savePrefs: (prefs) => postJson("/api/prefs", prefs),

  listRooms: () => getJson("/api/rooms"),
  addRoom: () => postJson("/api/rooms", {}),
  getRoom: (index) => getJson(`/api/rooms/${index}`),
  saveRoom: (index, room) => postJson(`/api/rooms/${index}`, room),
  setActiveRoom: (index) => postJson("/api/rooms/active", { index }),
  deleteRoom: async (index) => {
    const res = await fetch(url(`/api/rooms/${index}`), {
      method: "DELETE",
      credentials: "include",
    });
    if (!res.ok) throw new Error(`DELETE /api/rooms/${index} failed: ${res.status}`);
    return res.json();
  },

  logout: () => postJson("/logout", {}),

  deleteCatalogItem: (itemUrl) => postJson("/api/catalog/delete", { url: itemUrl }),
  renameCatalogItem: (itemUrl, newName) =>
    postJson("/api/catalog/rename", { url: itemUrl, new_name: newName }),

  uploadCatalogItem: async ({ image, category, subcategory, name, overwrite }) => {
    const fd = new FormData();
    fd.append("image", image, `${name}.png`);
    fd.append("category", category);
    fd.append("subcategory", subcategory);
    fd.append("name", name);
    if (overwrite) fd.append("overwrite", "1");
    const res = await fetch(url("/api/catalog/upload"), {
      method: "POST",
      credentials: "include",
      body: fd,
    });
    if (!res.ok) {
      let msg = `${res.status}`;
      try { msg = (await res.json()).error || msg; } catch {}
      throw new Error(msg);
    }
    return res.json();
  },
};
