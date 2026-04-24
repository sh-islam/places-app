// Login page: intercept the form submit, POST to the backend as JSON,
// navigate to the app on success, show an inline error on failure.
// Works same-origin (Flask) and cross-origin (GH Pages → Tailscale Funnel).

import { BACKEND_BASE } from "./config.js";
import { authToken } from "./api.js";


const form = document.getElementById("login-form");
const errorEl = document.getElementById("login-error");


// Reveal the login card on first paint — no splash runs at the start.
document.body.classList.add("login-ready");


// Block casual image-save paths on login.html too (Places icon, etc.).
document.addEventListener("contextmenu", (e) => {
  if (e.target instanceof HTMLImageElement) e.preventDefault();
});
document.addEventListener("dragstart", (e) => {
  if (e.target instanceof HTMLImageElement) e.preventDefault();
});


// Both Safari and Chrome skip the font-display:swap repaint for
// autofilled inputs — once the field is painted with the fallback
// font, the autofilled text stays in that font until the user
// clicks the field. The :-webkit-autofill CSS rule sets
// font-family !important, but inline-style swaps can't beat it, and
// programmatic focus is off-limits (we don't want autofocus or to
// pop the iOS keyboard). The clean fix: hide the inputs until the
// pixel font has actually loaded, so they paint in Press Start 2P
// from the first frame whether autofilled or not. 1.5s safety cap
// in case the font CDN is unreachable.
if (document.fonts && document.fonts.load) {
  for (const input of form.querySelectorAll("input")) {
    input.style.visibility = "hidden";
  }
  Promise.race([
    document.fonts.load('12px "Press Start 2P"'),
    new Promise((r) => setTimeout(r, 1500)),
  ]).finally(() => {
    for (const input of form.querySelectorAll("input")) {
      input.style.visibility = "";
    }
  });
}


// ---- Splash played AFTER a successful sign-in ----
//
// Called once the backend accepts the credentials. Enlarged icon +
// "Places" title + typewriter slogan ("A space you can call your
// own."), short pause, then fade out while we navigate into the app.
async function playWelcomeSplash() {
  const splash = document.getElementById("splash-overlay");
  const textEl = document.getElementById("splash-text");
  const card   = document.querySelector(".login-card");
  const slogan = "A space you can call your own.";

  // Hide the login card entirely + mark it inert so iOS can't re-focus
  // a password field behind the splash and pop the keyboard back up.
  if (card) {
    card.setAttribute("inert", "");
    card.style.display = "none";
  }
  splash.hidden = false;

  // Typewriter: one char every ~55ms so the whole line lands in ~1.6s.
  for (let i = 1; i <= slogan.length; i++) {
    textEl.textContent = slogan.slice(0, i);
    await new Promise((r) => setTimeout(r, 55));
  }
  await new Promise((r) => setTimeout(r, 900));
  splash.classList.add("closing");
  await new Promise((r) => setTimeout(r, 500));
}

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
    if (data.token) authToken.set(data.token);

    // Dismiss the on-screen keyboard before the welcome splash plays
    // — blurring the focused input tells iOS / Android to slide it
    // away, and we also shove focus onto body as a fallback for
    // browsers that ignore blur alone.
    if (document.activeElement && document.activeElement.blur) {
      document.activeElement.blur();
    }
    document.body.setAttribute("tabindex", "-1");
    document.body.focus();

    // Wait for the iOS keyboard to finish sliding down before opening
    // the splash. While the keyboard is animating, position:fixed
    // elements on iOS Safari are positioned relative to the SHRUNKEN
    // visual viewport, so a centered splash icon lands too high. As
    // the keyboard finishes hiding the viewport expands and the icon
    // visibly jumps. Logout doesn't have this problem because no
    // input was focused. ~350ms covers iOS's keyboard slide animation.
    await new Promise((r) => setTimeout(r, 350));

    await playWelcomeSplash();

    const next = data.token
      ? `index.html#t=${encodeURIComponent(data.token)}`
      : "index.html";
    window.location.href = next;
  } catch (err) {
    errorEl.textContent = `Network error: ${err.message}`;
    errorEl.hidden = false;
  }
});
