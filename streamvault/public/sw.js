const CACHE = "sv-v1";
const PRECACHE = ["/", "/favicon.svg"];

self.addEventListener("install", e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(PRECACHE)));
  self.skipWaiting();
});

self.addEventListener("activate", e => {
  e.waitUntil(caches.keys().then(keys => Promise.all(
    keys.filter(k => k !== CACHE).map(k => caches.delete(k))
  )));
  self.clients.claim();
});

self.addEventListener("fetch", e => {
  const url = new URL(e.request.url);
  // Don't cache API/stream requests
  if (url.pathname.startsWith("/stalker") || url.pathname.startsWith("/stream") ||
      url.pathname.startsWith("/proxy") || url.pathname.startsWith("/api")) return;
  // Cache-first for static assets, network-first for HTML
  if (e.request.destination === "document") {
    e.respondWith(fetch(e.request).catch(() => caches.match("/")));
  } else {
    e.respondWith(caches.match(e.request).then(r => r || fetch(e.request).then(res => {
      if (res.ok) { const clone = res.clone(); caches.open(CACHE).then(c => c.put(e.request, clone)); }
      return res;
    })));
  }
});
