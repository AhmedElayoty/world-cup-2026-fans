#!/usr/bin/env node
/*
  usage-report.mjs — READ-ONLY usage snapshot for the app. Reads the shared textdb
  stores and prints how many people use the app. Writes NOTHING. No secrets.
  Runs on GitHub Actions (this sandbox can't reach textdb directly).

  Counts:
    visitors        unique devices in the anonymous counter (capriole_wc26_analytics)
    visits          total sessions (a.views) + active in last 24h / 7d
    countries       top countries by device
    accounts        registered users (capriole_wc26_accounts)
    push subs       devices with notifications enabled (capriole_wc26_push_subs)
    predictors      distinct users who made >=1 prediction (capriole_wc26_predictions)
    chatters        distinct non-bot chat authors (capriole_wc26_room_8842)
*/
const K = {
  analytics: "capriole_wc26_analytics",
  accounts:  "capriole_wc26_accounts",
  subs:      "capriole_wc26_push_subs",
  preds:     "capriole_wc26_predictions",
  chat:      "capriole_wc26_room_8842",
};
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function read(key, fb) {
  for (let i = 1; i <= 3; i++) {
    try {
      const r = await fetch("https://textdb.online/" + key + "?t=" + Date.now() + "_" + i, { headers: { "cache-control": "no-cache" } });
      if (!r.ok) throw new Error("HTTP " + r.status);
      const t = (await r.text()).trim();
      return t ? JSON.parse(t) : fb;
    } catch (e) { if (i === 3) { console.log("  (" + key + " read failed: " + e.message + ")"); return fb; } await sleep(1500 * i); }
  }
  return fb;
}
const count = v => Array.isArray(v) ? v.length : (v && typeof v === "object" ? Object.keys(v).length : 0);
const BOT = /^(goalbot|brkbot|champbot|funbot|adminbot)/i;
const now = Date.now(), DAY = 86400000;

(async () => {
  const [an, accts, subs, preds, chat] = await Promise.all([
    read(K.analytics, {}), read(K.accounts, {}), read(K.subs, []), read(K.preds, {}), read(K.chat, []),
  ]);

  // ---- visitors (anonymous counter) ----
  const v = (an && an.v && typeof an.v === "object") ? an.v : {};
  const devices = Object.values(v);
  const uniqueDevices = devices.length;
  const totalVisits = Number(an && an.views) || 0;
  const active24h = devices.filter(d => d && (now - (+d.l || 0)) < DAY).length;
  const active7d  = devices.filter(d => d && (now - (+d.l || 0)) < 7 * DAY).length;
  const byCountry = {};
  devices.forEach(d => { const c = (d && d.c) || "Unknown"; byCountry[c] = (byCountry[c] || 0) + 1; });
  const topCountries = Object.entries(byCountry).sort((a, b) => b[1] - a[1]).slice(0, 10);

  // ---- accounts / subs / predictors / chatters ----
  const accounts = count(accts);
  const subCount = Array.isArray(subs) ? subs.filter(s => s && s.endpoint).length : 0;
  const subNations = {};
  if (Array.isArray(subs)) subs.forEach(s => { if (s && s.endpoint) { const n = (s.nat || "—"); subNations[n] = (subNations[n] || 0) + 1; } });
  const topSubNations = Object.entries(subNations).sort((a, b) => b[1] - a[1]).slice(0, 6);

  let predictors = 0;
  if (preds && typeof preds === "object") {
    predictors = Object.values(preds).filter(u => u && u.preds && Object.values(u.preds).some(p => p && (p.h !== undefined || p.pens))).length;
  }

  const chatUids = new Set();
  if (Array.isArray(chat)) chat.forEach(m => { if (m && m.uid && !BOT.test(m.uid)) chatUids.add(m.uid); });

  // ---- print ----
  const L = "─".repeat(48);
  console.log("\n" + L + "\n  APP USAGE SNAPSHOT  ·  " + new Date(now).toISOString() + "\n" + L);
  console.log("  Unique visitors (devices):  " + uniqueDevices);
  console.log("  Total visits (sessions):    " + totalVisits);
  console.log("  Active last 24h:            " + active24h);
  console.log("  Active last 7d:             " + active7d);
  console.log("  Registered accounts:        " + accounts);
  console.log("  Push-notification subs:     " + subCount);
  console.log("  Made >=1 prediction:        " + predictors);
  console.log("  Distinct chat authors:      " + chatUids.size);
  console.log(L);
  console.log("  Top countries (by device):");
  topCountries.forEach(([c, n]) => console.log("    " + String(n).padStart(5) + "  " + c));
  if (topSubNations.length) {
    console.log(L + "\n  Push subscribers by nation:");
    topSubNations.forEach(([n, c]) => console.log("    " + String(c).padStart(5) + "  " + n));
  }
  console.log(L + "\n");
})().catch(e => { console.error("ERROR: " + (e && e.message)); process.exit(1); });
