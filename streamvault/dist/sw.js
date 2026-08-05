const CACHE = "sv-msg5t72q";
const APP_SHELL = ['/app'];

self.addEventListener("install", e => {
  // Precache is best-effort: a single missing shell asset must not break install.
  e.waitUntil(
    caches.open(CACHE)
      .then(cache => Promise.allSettled(APP_SHELL.map(asset => cache.add(asset))))
      .then(() => self.skipWaiting())
  );
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

  // Never cache auth or content-session routes (network-only, no store).
  if (url.pathname === "/content" || url.pathname.startsWith("/content/") || url.pathname === "/player" || url.pathname.startsWith("/player/")) return;

  if (url.pathname.startsWith("/api/auth") ||
      url.pathname.startsWith("/api/content-session")) return;

  // Never cache any other API call (network-first, no cache).
  if (url.pathname.startsWith("/api")) return;

  // Never cache media / stream / proxy / analytics / health.
  if (url.pathname.startsWith("/stalker") ||
      url.pathname.startsWith("/stream") ||
      url.pathname.startsWith("/proxy") ||
      url.pathname.startsWith("/img") ||
      url.pathname.startsWith("/analytics") ||
      url.pathname.startsWith("/health")) return;

  // Only cache same-origin static assets.
  if (url.origin !== location.origin) return;

  // Network-first for /Videos/ (never cache media).
  if (url.pathname.startsWith("/Videos/")) {
    e.respondWith(fetch(e.request).then(res => {
      if (res.ok) { const c = res.clone(); caches.open(CACHE).then(cache => cache.put(e.request, c)); }
      return res;
    }).catch(() => caches.match(e.request).then(cached => cached || new Response("", { status: 504, statusText: "Offline" }))));
    return;
  }

  // Stale-while-revalidate for /Images/.
  if (url.pathname.startsWith("/Images/")) {
    e.respondWith(caches.match(e.request).then(cached => {
      const fetchPromise = fetch(e.request).then(res => {
        if (res.ok) { const c = res.clone(); caches.open(CACHE).then(cache => cache.put(e.request, c)); }
        return res;
      }).catch(() => cached || new Response("", { status: 504, statusText: "Offline" }));
      return cached || fetchPromise;
    }));
    return;
  }

  // Network-first for HTML, cache-first for assets.
  if (e.request.destination === "document" || url.pathname === "/") {
    e.respondWith(fetch(e.request).then(res => {
      if (res.ok) { const c = res.clone(); caches.open(CACHE).then(cache => cache.put(e.request, c)); }
      return res;
    }).catch(async () => {
      const cached = await caches.match(e.request);
      if (cached) return cached;
      if (url.pathname === "/app" || url.pathname.startsWith("/app/")) return caches.match("/app");
      return new Response("", { status: 503, statusText: "Offline" });
    }));
  } else if (e.request.destination === "script" || e.request.destination === "style" ||
             e.request.destination === "image" || e.request.destination === "font") {
    e.respondWith(caches.match(e.request).then(r => r || fetch(e.request).then(res => {
      if (res.ok) { const c = res.clone(); caches.open(CACHE).then(cache => cache.put(e.request, c)); }
      return res;
    }).catch(() => new Response("", { status: 503, statusText: "Offline" }))));
  }
  // Everything else — let the browser handle normally.
});
