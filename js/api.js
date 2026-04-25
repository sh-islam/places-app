// Thin wrappers around our Flask JSON endpoints.
//
// Auth uses two channels, whichever the browser lets through:
//   - Authorization: Bearer <token>  (stateless, survives iOS Safari's
//     cross-site cookie blocking). Stored in localStorage after login.
//   - Session cookie (credentials: "include"), same-origin and where the
//     browser allows cross-site cookies.
//
// All paths get prefixed with BACKEND_BASE from config.js, which is "" in
// same-origin mode and e.g. "https://shad-server.tailnet.ts.net" in prod.

import { BACKEND_BASE } from "./config.js";


const TOKEN_KEY = "placesAuthToken";
export const authToken = {
  get()  { try { return localStorage.getItem(TOKEN_KEY); } catch { return null; } },
  set(t) { try { localStorage.setItem(TOKEN_KEY, t); } catch {} },
  clear()  { try { localStorage.removeItem(TOKEN_KEY); } catch {} },
};


function url(path) {
  return `${BACKEND_BASE}${path}`;
}


function authHeaders(extra) {
  const h = { ...(extra || {}) };
  const t = authToken.get();
  if (t) h["Authorization"] = `Bearer ${t}`;
  return h;
}


async function getJson(path) {
  const res = await fetch(url(path), {
    credentials: "include",
    headers: authHeaders(),
  });
  if (!res.ok) throw new Error(`GET ${path} failed: ${res.status}`);
  return res.json();
}


async function postJson(path, body) {
  const res = await fetch(url(path), {
    method: "POST",
    credentials: "include",
    headers: authHeaders({ "Content-Type": "application/json" }),
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
      headers: authHeaders(),
    });
    if (!res.ok) throw new Error(`DELETE /api/rooms/${index} failed: ${res.status}`);
    return res.json();
  },

  logout: () => postJson("/logout", {}),

  deleteCatalogItem: (itemUrl) => postJson("/api/catalog/delete", { url: itemUrl }),
  renameCatalogItem: (itemUrl, newName) =>
    postJson("/api/catalog/rename", { url: itemUrl, new_name: newName }),
  moveCatalogItem: (itemUrl, newCategory, newSubcategory) =>
    postJson("/api/catalog/move", {
      url: itemUrl,
      new_category: newCategory,
      new_subcategory: newSubcategory,
    }),
  overwriteCatalogItem: (itemUrl, imageBase64) =>
    postJson("/api/catalog/overwrite", {
      url: itemUrl,
      image_base64: imageBase64,
    }),

  uploadCatalogItem: async ({ image, category, subcategory, name, overwrite, sourceUrl }) => {
    const fd = new FormData();
    fd.append("image", image, `${name}.png`);
    fd.append("category", category);
    fd.append("subcategory", subcategory);
    fd.append("name", name);
    if (overwrite) fd.append("overwrite", "1");
    // Tag the upload as a "save as new" copy so the backend's
    // autocommit message says "admin created new: <src> -> <dest>"
    // instead of the plain "admin uploaded: <dest>".
    if (sourceUrl) fd.append("source_url", sourceUrl);
    const res = await fetch(url("/api/catalog/upload"), {
      method: "POST",
      credentials: "include",
      headers: authHeaders(),
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
