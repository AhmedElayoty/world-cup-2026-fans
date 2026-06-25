/* WCup 2026 Fans · service worker.
   NETWORK-FIRST for the app shell (HTML) so a new deploy ALWAYS shows when online;
   cache is only a fallback for offline. Live data (ESPN/textdb/etc.) never cached.
   Static assets (icons/logo/manifest) cache-first. */
const CACHE = "wcfans-v82";   // v82: v2.76 · "PREDICT NOW" header tidied — removed the ⚽ icon + the "ONE SUBMISSION ·" prefix (now just "CLOSES 30 MIN BEFORE KICK-OFF"); forced the whole secrow to ONE line on phones (.secrow flex-wrap:nowrap+overflow:hidden, .sect white-space:nowrap+flex:0 0 auto, note white-space:nowrap+ellipsis+min-width:0). Verified single line at 320px. Prior v81: v2.75 · FIX style leak — the leaderboard VIEW MORE button reused `.lbmore`, the class the STATS boards use for their subtle "+N more" hint, so restyling it turned the stats hint into a big blue button. Gave the leaderboard toggle its own `.predmore` class + restored `.lbmore` to the original dim stats text. Prior v80: v2.74 · Leaderboard VIEW MORE — (a) restyled to a FULL-WIDTH light-blue button (var(--cyan) tint; was a gold pill); (b) VIEW LESS scrolls back to the top of the leaderboard (offset for the sticky topbar), VIEW MORE stays in place. Prior v79: v2.73 · Leaderboard VIEW MORE fixes — (a) BUG: expanded rows restarted ranks at 1; now keep true rank (11,12,…) via +10 index offset; (b) relabelled "TOP 10 · VIEW N MORE" / "VIEW LESS"; (c) toggle restyled from a dim footnote to a prominent gold pill. Prior v78: v2.72 · (1) Predict leaderboards (weekly + overall) show TOP 10 collapsed with a "VIEW MORE · N MORE"/"VIEW LESS" toggle (lbBoard/lbToggle) — full board still holds EVERYONE, just collapsed presentation, keeps the page short. (2) Knockout "This match will go to penalties" toggle restyled from a faint dashed footnote into a prominent amber chip (rust-tint bg + gold bold text + solid border) so people notice the penalties option. Prior v77: v2.71 · FIX predict ordering (v2.70 only sorted WITHIN sections, so a submitted This-Week match still sat above an un-predicted knockout). Now a GLOBAL split: "⚽ PREDICT NOW" (every open + not-yet-predicted match, group + knockout together, by date) on top, then "✓ YOUR PICKS", then LOCKED/FINISHED. Verified the sole un-predicted match floats to the very top even when it's the latest by date. Prior v76: v2.70 · Predict tab orders the matches you HAVEN'T predicted yet FIRST, predicted (or closed) ones sink to the bottom of each group (this week/next week/knockouts) via _predOrd. Verified a predicted match drops below the un-predicted ones. (Confirmed separately: the knockout-rules popup is already fully Arabic via KO_RULES_AR — no change.) Prior v75: v2.69 · Proactive bug-hunt: guarded predCard + renderLiveSummary + drawHero against null/malformed feed entries (siblings of the v2.67 renderMatches guard) so a bad event can't crash the predict tab / live strip / home hero. Confirmed R32 was the ONLY cache-vs-live flicker (fixed v2.68) and the live-box the ONLY date-rollover bug (fixed v2.66). Prior v74: v2.68 · FIX R32-opponent flicker (Egypt's opponent flipped Cape Verde↔Czechia on refresh): the hero painted the lagging 3x/day server-precompute (stale) before the live recompute, and freeze-while-live HELD that stale value. Now the user's OWN nation always uses a fresh live computation from current standings — computeNatR32 always recomputes, _heroR32Sec computes live when standings loaded, loadR32 no longer lets the server precompute clobber the user's nation. (Cape Verde IS correct: Egypt 1st in G → Annexe-C sends Group H's 3rd to the G-winner.) Prior v73: v2.67 QA hardening (renderMatches null guard).: renderMatches now skips any null/malformed feed entry (list filter + H/A/team guard) so one bad event can't crash the whole match list (theoretical — real ESPN data is well-formed). Also verified this sweep: all 28 knockout timings match ESPN exactly; a live-feed blip keeps last-good matches (no blank); predict week-boundary renders clean. Prior v72: v2.66 · FIX LIVE NOW strip vanishing at UAE midnight: _liveNow was filtered to today's date, so a match still playing past midnight (scheduled "yesterday") dropped out while live. Now the live set spans today + the prior UAE day and is gated on state==="in" only (never date). Verified live against 2 cross-midnight matches (BIH-QAT, SUI-CAN). Prior v71: v2.65 QA pass + syncKnockout Arrowhead fix + Egypt-qualified celebration. FIX: syncKnockout maps ESPN knockout RESULTS to BRACKET nodes by venue exact-OR-contains (was missing "GEHA Field at Arrowhead Stadium" vs our "Arrowhead Stadium" → R32 node 87 + QF node 100 now map; without it those results + R16/QF placement would have broken). NEW: Egypt celebration ALSO fires once when Egypt is in ESPN's officially-confirmed R32 (checkCelebration → confirmedTeams().has("Egypt"), id "egyR32", deduped). Verified: scorer 14/14 (group/KO/penalties/final 10-4), R16 fill, allDone disappearance, all KO fixtures map (0 unmapped).
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
