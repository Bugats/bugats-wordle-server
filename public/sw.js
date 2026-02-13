const CACHE_VERSION = "vz-pwa-v10";
const CORE_ASSETS = [
  "./",
  "./index.html",
  "./game.html",
  "./style.css",
  "./auth.js",
  "./game.js",
  "./phaser-fx.js",
  "./phaser-logo.js",
  "./grid-fx.js",
  "./manifest.json",
  "./icon.svg",
  "./icon-maskable.svg",
  "./pwa.js"
];

const STATIC_DESTINATIONS = new Set(["style", "script", "image", "font", "audio"]);
const NETWORK_FIRST_PATHS = new Set([
  "/",
  "/index.html",
  "/game.html",
  "/style.css",
  "/auth.js",
  "/game.js",
  "/phaser-fx.js",
  "/phaser-logo.js",
  "/grid-fx.js",
  "/manifest.json",
  "/pwa.js"
]);

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(CACHE_VERSION)
      .then((cache) => cache.addAll(CORE_ASSETS))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(keys.filter((key) => key !== CACHE_VERSION).map((key) => caches.delete(key)))
      )
      .then(() => self.clients.claim())
  );
});

self.addEventListener("message", (event) => {
  if (event.data && event.data.type === "SKIP_WAITING") {
    self.skipWaiting();
  }
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;

  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname.startsWith("/socket.io")) return;

  if (req.mode === "navigate") {
    event.respondWith(networkFirstNoCache(req));
    return;
  }

  if (NETWORK_FIRST_PATHS.has(url.pathname)) {
    event.respondWith(networkFirstNoCache(req));
    return;
  }

  if (!req.destination || !STATIC_DESTINATIONS.has(req.destination)) return;
  event.respondWith(cacheFirst(req));
});

async function networkFirst(req) {
  try {
    const res = await fetch(req);
    const cache = await caches.open(CACHE_VERSION);
    cache.put(req, res.clone());
    return res;
  } catch {
    const cache = await caches.open(CACHE_VERSION);
    const cached = await cache.match(req);
    if (cached) return cached;
    return cache.match("./index.html");
  }
}

async function networkFirstNoCache(req) {
  try {
    const freshReq = new Request(req, { cache: "no-store" });
    const res = await fetch(freshReq);
    const cache = await caches.open(CACHE_VERSION);
    cache.put(req, res.clone());
    return res;
  } catch {
    const cache = await caches.open(CACHE_VERSION);
    const cached = await cache.match(req);
    if (cached) return cached;
    return cache.match("./index.html");
  }
}

async function cacheFirst(req) {
  const cache = await caches.open(CACHE_VERSION);
  const cached = await cache.match(req);
  if (cached) return cached;
  const res = await fetch(req);
  if (res && res.ok) cache.put(req, res.clone());
  return res;
}
