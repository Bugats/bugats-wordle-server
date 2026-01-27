const CACHE_VERSION = "vz-pwa-v2";
const CORE_ASSETS = [
  "./",
  "./index.html",
  "./game.html",
  "./style.css",
  "./auth.js",
  "./game.js",
  "./grid-fx.js",
  "./manifest.json",
  "./icon.svg",
  "./icon-maskable.svg",
  "./pwa.js"
];

const STATIC_DESTINATIONS = new Set(["style", "script", "image", "font", "audio"]);

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
    event.respondWith(networkFirst(req));
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

async function cacheFirst(req) {
  const cache = await caches.open(CACHE_VERSION);
  const cached = await cache.match(req);
  if (cached) return cached;
  const res = await fetch(req);
  if (res && res.ok) cache.put(req, res.clone());
  return res;
}
