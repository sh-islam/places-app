// Login page: intercept the form submit, POST to the backend as JSON,
// navigate to the app on success, show an inline error on failure.
// Works same-origin (Flask) and cross-origin (GH Pages → Tailscale Funnel).

import { BACKEND_BASE } from "./config.js";
import { authToken } from "./api.js";


const form = document.getElementById("login-form");
const errorEl = document.getElementById("login-error");

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
