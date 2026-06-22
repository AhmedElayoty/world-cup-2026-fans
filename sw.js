/* WCup 2026 Fans · service worker.
   NETWORK-FIRST for the app shell (HTML) so a new deploy ALWAYS shows when online;
   cache is only a fallback for offline. Live data (ESPN/textdb/etc.) never cached.
   Static assets (icons/logo/manifest) cache-first. */
const CACHE = "wcfans-v21";   // v21: v2.17 · Arabic bracket POSTER fully translated + RTL-correct (direction:ltr root, unicode-bidi:plaintext, translate-before-truncate, Cairo font)
const SHELL = ["./", "./index.html", "./manifest.json", "./logo.png", "./trophy.png", "./icon-192-2.png", "./icon-512-2.png", "./icon-180-2.png", "./share-card.png"];

self.addEventListener("install", e => {
  self.skipWaiting();
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL).catch(() => {})));
});
self.addEventListener("activate", e => {
  e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener("fetch", e => {
  const req = e.request;
  if (req.method !== "GET") return;
  let url; try { url = new URL(req.url); } catch (_) { return; }
  // never touch live data / third-party APIs — let them hit the network normally
  if (/espn\.com|textdb\.online|flagcdn\.com|geojs\.io|ipapi\.co|googleapis\.com|gstatic\.com/.test(url.host)) return;
  // app shell (navigation / index.html) -> network-first, cache fallback offline.
  // Only the REAL app shell (root or index.html) is stored under the index key. Other pages
  // (e.g. demo.html) are network-first but must NEVER be cached as the app's offline entry,
  // otherwise opening demo.html would poison the installed app's offline slot.
  if (req.mode === "navigate" || url.pathname === "/" || url.pathname.endsWith("/") || url.pathname.endsWith("index.html")) {
    const isShell = url.pathname === "/" || url.pathname.endsWith("/") || url.pathname.endsWith("index.html");
    e.respondWith(
      fetch(req).then(r => { if (isShell) { const cp = r.clone(); caches.open(CACHE).then(c => c.put("./index.html", cp)); } return r; })
                .catch(() => caches.match(isShell ? "./index.html" : req).then(r => r || caches.match("./index.html")))
    );
    return;
  }
  // same-origin static assets -> cache-first (icons, logo, manifest, etc.)
  if (url.origin === self.location.origin) {
    e.respondWith(caches.match(req).then(r => r || fetch(req).then(rp => { if (rp && rp.ok) { const cp = rp.clone(); caches.open(CACHE).then(c => c.put(req, cp)); } return rp; }).catch(() => r)));
  }
});
