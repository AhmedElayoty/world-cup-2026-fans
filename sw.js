/* WCup 2026 Fans · service worker.
   NETWORK-FIRST for the app shell (HTML) so a new deploy ALWAYS shows when online;
   cache is only a fallback for offline. Live data (ESPN/textdb/etc.) never cached.
   Static assets (icons/logo/manifest) cache-first. */
const CACHE = "wcfans-v68";   // v68: v2.62 · KNOCKOUTS is now its own top-level nav tab (Matches·Groups·Knockouts·Stats·Predict·Chat = 6 tabs). Groups tab = standings only; the bracket (R32/R16/QF/SF/FINAL chips + poster) moved to the new paneK. Removed the in-Groups GROUPS/KNOCKOUTS sub-toggle (setGroupsView gone). Nav font 11.5→10px so 6 tabs fit ≥320px in EN+AR (AR tab label "الإقصائيات"). Tab persists across reload; R32 hero card + swipe order route to the new tab.
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
  if (url.pathname.endsWith("sw.js")) return;   // never intercept/cache the SW script — lets the page's cache-busted version poll reach the network for fast update detection
  // app shell (navigation / index.html) -> network-first, cache fallback offline.
  // Only the REAL app shell (root or index.html) is stored under the index key. Other pages
  // (e.g. demo.html) are network-first but must NEVER be cached as the app's offline entry,
  // otherwise opening demo.html would poison the installed app's offline slot.
  if (req.mode === "navigate" || url.pathname === "/" || url.pathname.endsWith("/") || url.pathname.endsWith("index.html")) {
    const isShell = url.pathname === "/" || url.pathname.endsWith("/") || url.pathname.endsWith("index.html");
    e.respondWith(
      // bypass the HTTP cache for the shell so a new deploy shows on the NEXT load, not up to 10 min later
      // (GitHub Pages serves HTML with Cache-Control: max-age=600). Offline still falls back to Cache Storage.
      fetch(req.url, { cache: "no-store" }).then(r => { if (isShell) { const cp = r.clone(); caches.open(CACHE).then(c => c.put("./index.html", cp)); } return r; })
                .catch(() => caches.match(isShell ? "./index.html" : req).then(r => r || caches.match("./index.html")))
    );
    return;
  }
  // same-origin static assets -> cache-first (icons, logo, manifest, etc.)
  if (url.origin === self.location.origin) {
    e.respondWith(caches.match(req).then(r => r || fetch(req).then(rp => { if (rp && rp.ok) { const cp = rp.clone(); caches.open(CACHE).then(c => c.put(req, cp)); } return rp; }).catch(() => r)));
  }
});
