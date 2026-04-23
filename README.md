# places-app-web

Static frontend for [Places](https://github.com/sh-islam/) — a canvas-based
room-decoration app. This repo holds only HTML / CSS / JS / icons; the
backend (Flask + Docker) lives privately on a personal server and is
reached cross-origin via Tailscale Funnel.

## Local dev

Any static file server will do — e.g. from this folder:

```bash
python -m http.server 8000
```

Then open <http://localhost:8000/login.html>. For API calls to reach the
backend, the browser needs to accept the backend origin — see
`js/config.js` for the URL.

## Deploy

Pushes to `main` trigger `.github/workflows/pages.yml`, which publishes
the repo contents to GitHub Pages.
