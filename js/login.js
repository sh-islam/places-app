// Login page: intercept the form submit, POST to the backend as JSON,
// navigate to the app on success, show an inline error on failure.
// Works same-origin (Flask) and cross-origin (GH Pages → Tailscale Funnel).

import { BACKEND_BASE } from "./config.js";
import { authToken } from "./api.js";


const form = document.getElementById("login-form");
const errorEl = document.getElementById("login-error");


// ---- Splash intro (only when the user just signed out) ----
//
// main.js sends us to login.html?from=logout when the nav-bar power
// button fires. We play a quick typewriter sequence — enlarged icon +
// "A space you can call your own" — then fade out as the login card
// fades in. Direct visits (expired session, bookmark) skip it and
// reveal the card immediately.
(async function playSplashIfNeeded() {
  const params = new URLSearchParams(location.search);
  const cameFromLogout = params.get("from") === "logout";
  if (!cameFromLogout) {
    document.body.classList.add("login-ready");
    return;
  }

  const splash  = document.getElementById("splash-overlay");
  const textEl  = document.getElementById("splash-text");
  const slogan  = "A space you can call your own.";

  splash.hidden = false;

  // Typewriter: one char every ~55ms so the whole line lands in ~1.6s.
  for (let i = 1; i <= slogan.length; i++) {
    textEl.textContent = slogan.slice(0, i);
    await new Promise((r) => setTimeout(r, 55));
  }
  // Linger on the finished slogan for a beat.
  await new Promise((r) => setTimeout(r, 1000));

  // Cross-fade: splash fades + shrinks, login card fades in behind it.
  splash.classList.add("closing");
  document.body.classList.add("login-ready");
  await new Promise((r) => setTimeout(r, 500));
  splash.hidden = true;

  // Clean the ?from=logout from the URL so refreshing the page doesn't
  // replay the splash (and so it doesn't get pasted into bookmarks).
  history.replaceState(null, "", location.pathname);
})();

form.addEventListener("submit", async (e) => {
  e.preventDefault();
  errorEl.hidden = true;

  const username = form.querySelector('input[name="username"]').value.trim();
  const password = form.querySelector('input[name="password"]').value;
  if (!username || !password) return;

  try {
    const res = await fetch(`${BACKEND_BASE}/login`, {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username, password }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      errorEl.textContent = data.error || "Sign-in failed.";
      errorEl.hidden = false;
      return;
    }
    // Persist the bearer token so subsequent fetches include it even when
    // the browser refuses cross-site session cookies (iOS Safari / ITP).
    // Belt-and-suspenders: also pass it via URL hash, so even if
    // localStorage gets nuked between pages (some mobile browsers do
    // this unpredictably), index.html's boot can pick it up.
    if (data.token) {
      authToken.set(data.token);
      window.location.href = `index.html#t=${encodeURIComponent(data.token)}`;
    } else {
      window.location.href = "index.html";
    }
  } catch (err) {
    errorEl.textContent = `Network error: ${err.message}`;
    errorEl.hidden = false;
  }
});
