const CACHE = "sv-mr8hpkd6";
const APP_SHELL = ['/', '/index.html', '/landing.html', '/dist/assets/app.css'];

self.addEventListener("install", e => {
  e.waitUntil(caches.open(CACHE).then(cache => cache.addAll(APP_SHELL)));
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

  // Never cache API calls (network-first, no cache)
  if (url.pathname.startsWith("/api")) return;

  // Never cache media / stream / proxy / analytics
  if (url.pathname.startsWith("/stalker") ||
      url.pathname.startsWith("/stream") ||
      url.pathname.startsWith("/proxy") ||
      url.pathname.startsWith("/analytics") ||
      url.pathname.startsWith("/health")) return;

  // Only cache same-origin static assets
  if (url.origin !== location.origin) return;

  // Network-first for /Videos/ (never cache media)
  if (url.pathname.startsWith("/Videos/")) {
    e.respondWith(fetch(e.request).then(res => {
      if (res.ok) { const c = res.clone(); caches.open(CACHE).then(cache => cache.put(e.request, c)); }
      return res;
    }).catch(() => caches.match(e.request)));
    return;
  }

  // Stale-while-revalidate for /Images/
  if (url.pathname.startsWith("/Images/")) {
    e.respondWith(caches.match(e.request).then(cached => {
      const fetchPromise = fetch(e.request).then(res => {
        if (res.ok) { const c = res.clone(); caches.open(CACHE).then(cache => cache.put(e.request, c)); }
        return res;
      });
      return cached || fetchPromise;
    }));
    return;
  }

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
  // Everything else — let the browser handle normally
});
