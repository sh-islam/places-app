// Backend URL. This is the GitHub Pages build — the backend lives on
// shad-server and is exposed publicly over HTTPS via Tailscale Funnel.
export const BACKEND_BASE = "https://shad-server.elf-tarpon.ts.net";


// Prefix a server-relative asset path (e.g. "/catalog/foo.png") with the
// backend origin so it loads cross-origin from GitHub Pages. Same-origin
// deploys leave the path unchanged.
export function assetUrl(path) {
  if (!path) return path;
  if (/^https?:\/\//i.test(path)) return path; // already absolute
  return `${BACKEND_BASE}${path}`;
}
