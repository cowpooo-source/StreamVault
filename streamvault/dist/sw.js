const CACHE = "sv-mpags7tw";

self.addEventListener("install", () => {
  self.skipWaiting();
});

self.addEventListener("activate", e => {
  e.waitUntil(caches.keys().then(keys => Promise.all(
    keys.filter(k => k !== CACHE).map(k => caches.delete(k))
  )));
  self.clients.claim();
});

self.addEventListener("fetch", e => {
  // Only cache GET requests
  if (e.request.method !== "GET") return;

  const url = new URL(e.request.url);

  // Never cache API, stream, proxy, or analytics requests
  if (url.pathname.startsWith("/stalker") ||
      url.pathname.startsWith("/stream") ||
      url.pathname.startsWith("/proxy") ||
      url.pathname.startsWith("/img") ||
      url.pathname.startsWith("/api") ||
      url.pathname.startsWith("/health") ||
      url.pathname.startsWith("/analytics")) return;

  // Only cache same-origin static assets (js, css, images, fonts)
  if (url.origin !== location.origin) return;

  // Network-first for HTML, cache-first for assets
  if (e.request.destination === "document" || url.pathname === "/") {
    e.respondWith(fetch(e.request).then(res => {
      if (res.ok) { const c = res.clone(); caches.open(CACHE).then(cache => cache.put(e.request, c)); }
      return res;
    }).catch(() => caches.match("/") || caches.match(e.request)));
  } else if (e.request.destination === "script" || e.request.destination === "style" ||
             e.request.destination === "image" || e.request.destination === "font") {
    e.respondWith(caches.match(e.request).then(r => r || fetch(e.request).then(res => {
      if (res.ok) { const c = res.clone(); caches.open(CACHE).then(cache => cache.put(e.request, c)); }
      return res;
    })));
  }
  // Everything else — let the browser handle normally (no respondWith)
});
