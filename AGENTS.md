# AGENTS.md

## Cursor Cloud specific instructions

### Overview

VĀRDU ZONA is a Latvian-language Wordle clone — a single Node.js (ES Modules) Express + Socket.IO server (`server.js`) with no external database (flat JSON file storage: `users.json`, `seasons.json`, `wheel.json`).

### Running the dev server

```
npm run dev          # node --watch server.js — auto-reloads on file changes
```

Server listens on `PORT` env var or **10080** by default. Health check: `GET /health` → `{"ok":true}`.

### Key API routes (no `/api/` prefix)

- `POST /signup` / `POST /login` — returns JWT token in response body
- `GET /start-round` — starts a new word-guessing round (auth required)
- `POST /guess` — body: `{"guess":"WORD"}` (auth required)
- `GET /leaderboard`, `GET /me`, `GET /season/state`, `GET /wheel/state`

Auth: `Authorization: Bearer <token>` header.

### Notes

- There is no linter, test framework, or build step configured in this project. The only scripts are `start` and `dev` in `package.json`.
- Guess rate-limiting is enforced (~1 second between guesses). If you get `"Pārāk ātri"` errors during testing, add a short delay between guess requests.
- The `wheel.js` file is a client-side script (not used by the server). It has a hardcoded API URL pointing to the production Render deployment.
- All env vars have sensible defaults; no secrets or external services are required to run locally.
