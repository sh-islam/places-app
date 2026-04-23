// Image preloader + cache. One Image object per URL.
//
// The public API accepts server-relative paths ("/catalog/...") that came
// from the JSON catalog/room endpoints. Internally we resolve them against
// BACKEND_BASE so canvas renders work whether the frontend is co-hosted
// with Flask or living on GitHub Pages.

import { state } from "./state.js";
import { assetUrl } from "./config.js";

export function loadImage(url) {
  if (state.imageCache.has(url)) {
    return Promise.resolve(state.imageCache.get(url));
  }
  return new Promise((resolve, reject) => {
    const img = new Image();
    // `anonymous` ensures the canvas isn't tainted when we later call
    // getImageData() for the alpha mask. Requires the server to send an
    // Access-Control-Allow-Origin header on /catalog/* and /backgrounds/*,
    // which flask-cors handles in production, and is a no-op same-origin.
    img.crossOrigin = "anonymous";
    img.onload = () => {
      // Cache under the ORIGINAL url the caller gave us, so obj.url lookups
      // continue to work — only the fetch itself uses the resolved URL.
      state.imageCache.set(url, img);
      resolve(img);
    };
    img.onerror = () => reject(new Error(`Failed to load ${url}`));
    img.src = assetUrl(url);
  });
}

export function getCachedImage(url) {
  return state.imageCache.get(url) || null;
}

export async function preloadAll(urls) {
  await Promise.all(urls.map((u) => loadImage(u).catch(() => null)));
}
