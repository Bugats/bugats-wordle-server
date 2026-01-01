# VĀRDU ZONA — server modularized

This folder contains a modular split of your original `server.js`.

## Files
- `server.js` (tiny entrypoint)
- `src/base.js` — imports + constants + state + helpers + Express/HTTP/Socket.IO init (no listen)
- `src/routes.js` — HTTP endpoints + helper functions used elsewhere (exports them)
- `src/sockets.js` — Socket.IO handlers (includes /wheel namespace + main connection handlers)
- `src/index.js` — imports base/routes/sockets and starts the server

## Render / start script
If your `package.json` already runs `node server.js`, you don't need to change it.
If it runs a different entry, point it to this new `server.js`.

## Replace steps
1) Put these files into your repo (keep your existing `package.json`, `words.txt`, `data/*` etc).
2) Ensure `"type": "module"` is present in `package.json` (because your original server is ESM imports).
3) Deploy.

If anything fails on deploy, send the Render logs and I will patch the split version.
