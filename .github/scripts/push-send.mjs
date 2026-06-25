#!/usr/bin/env node
/*
  push-send.mjs · Web Push sender for the WCup 2026 Fans app.
  -----------------------------------------------------------------------------
  Runs in GitHub Actions (FREE — public repo, unlimited minutes). Reads the push
  subscriptions saved by the app in textdb, then sends:
    (a) KICK-OFF reminders for matches starting in the next ~5–45 min (ESPN), and
    (b) any pending MANUAL BROADCAST (an announcement you drop into textdb),
  de-duplicating by id so each alert goes out exactly once, and pruning any
  subscription the push service reports as gone (404/410).

  ENV
    VAPID_PRIVATE_KEY      required (GitHub Actions secret). The public half +
                           subject are constants below (public keys are public).
    PUSH_TEST=true         send a one-off "test" notification to every subscriber
    HEALTHCHECK_URL_PUSH   optional dead-man's-switch ping on success

  FLAGS
    --dry    compute + print only; never send, never write
    --test   same as PUSH_TEST=true

  textdb keys (shared by both site instances)
    capriole_wc26_push_subs       [{endpoint, keys:{p256dh,auth}, nat, ts, ua}]
    capriole_wc26_push_sent       [{id, ts}]   dedup log, pruned to 3 days
    capriole_wc26_push_broadcast  {id,title,body,url} | null   manual announcement
*/
import webpush from "web-push";

const VAPID_PUBLIC  = "BI4pbMHsPCfia1nngQUbb_LpBT6BjrULPMbQ-p5qfSNrGrbuBzr2vrMm3MuluKZ-oiA-OuOQ0TmrVDTpSRg2p2I";
const VAPID_SUBJECT = "https://ahmedelayoty.github.io/world-cup-2026-fans/";
const VAPID_PRIVATE = process.env.VAPID_PRIVATE_KEY || "";

const SUBS_KEY  = "capriole_wc26_push_subs";
const SENT_KEY  = "capriole_wc26_push_sent";
const BCAST_KEY = "capriole_wc26_push_broadcast";

const DRY  = process.argv.includes("--dry");
const TEST = process.argv.includes("--test") || process.env.PUSH_TEST === "true";

const RD = k => "https://textdb.online/" + k + "?t=" + Date.now();
const WR = "https://api.textdb.online/update/";

async function readKey(key, fallback) {
  try {
    const r = await fetch(RD(key), { headers: { "cache-control": "no-cache" } });
    if (!r.ok) return fallback;
    const t = (await r.text()).trim();
    if (!t) return fallback;
    return JSON.parse(t);
  } catch (_) { return fallback; }
}
async function writeKey(key, value) {
  const r = await fetch(WR, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: "key=" + encodeURIComponent(key) + "&value=" + encodeURIComponent(JSON.stringify(value))
  });
  if (!r.ok) throw new Error("textdb write HTTP " + r.status);
}

const ESPN = d => "https://site.api.espn.com/apis/site/v2/sports/soccer/fifa.world/scoreboard?dates=" + d + "&limit=100";
const ymdUTC = dt => dt.getUTCFullYear() + String(dt.getUTCMonth() + 1).padStart(2, "0") + String(dt.getUTCDate()).padStart(2, "0");

async function upcomingMatches() {
  const now = new Date();
  const days = [ymdUTC(now), ymdUTC(new Date(now.getTime() + 864e5))];   // today + tomorrow (UTC) so a late-night kick-off isn't missed
  const seen = {}, events = [];
  for (const d of days) {
    try {
      const r = await fetch(ESPN(d), { headers: { "cache-control": "no-cache" } });
      if (!r.ok) continue;
      const j = await r.json();
      for (const e of (j.events || [])) if (e && e.id && !seen[e.id]) { seen[e.id] = 1; events.push(e); }
    } catch (_) {}
  }
  return events;
}
function matchLabel(e) {
  try {
    const c = e.competitions[0];
    const H = c.competitors.find(x => x.homeAway === "home"), A = c.competitors.find(x => x.homeAway === "away");
    const hn = (H && H.team && (H.team.displayName || H.team.shortDisplayName)) || "TBD";
    const an = (A && A.team && (A.team.displayName || A.team.shortDisplayName)) || "TBD";
    return hn + " vs " + an;
  } catch (_) { return e.shortName || e.name || "Match"; }
}
const koUAE = e => { try { return new Date(e.date).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", timeZone: "Asia/Dubai" }); } catch (_) { return ""; } };

async function main() {
  if (!VAPID_PRIVATE && !DRY) { console.error("FATAL: VAPID_PRIVATE_KEY is not set."); process.exit(1); }
  if (VAPID_PRIVATE) webpush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC, VAPID_PRIVATE);

  let subs = await readKey(SUBS_KEY, []);
  if (!Array.isArray(subs)) subs = [];
  console.log("subscribers:", subs.length);

  let sent = await readKey(SENT_KEY, []);
  if (!Array.isArray(sent)) sent = [];
  const sentIds = new Set(sent.map(s => s && s.id));

  const now = Date.now();
  const notifs = [];   // {id, payload}

  if (TEST) notifs.push({ id: "test-" + now, payload: { title: "🔔 Test alert", body: "Notifications are working. Enjoy the World Cup!", url: "./index.html", tag: "test" } });

  // (a) manual broadcast
  const bcast = await readKey(BCAST_KEY, null);
  if (bcast && bcast.id && bcast.title && !sentIds.has("bc-" + bcast.id))
    notifs.push({ id: "bc-" + bcast.id, payload: { title: String(bcast.title), body: String(bcast.body || ""), url: bcast.url || "./index.html", tag: "bc-" + bcast.id } });

  // (b) kick-off reminders: matches starting in the next 5–45 min
  for (const e of await upcomingMatches()) {
    try {
      if (((e.status && e.status.type && e.status.type.state) || "") !== "pre") continue;
      const mins = (new Date(e.date).getTime() - now) / 60000;
      if (mins > 5 && mins <= 45) {
        const id = "ko-" + e.id;
        if (sentIds.has(id)) continue;
        const ko = koUAE(e);
        notifs.push({ id, payload: { title: "⚽ Kicks off soon", body: matchLabel(e) + (ko ? (" · " + ko + " UAE") : "") + " · in " + Math.round(mins) + " min", url: "./index.html", tag: id } });
      }
    } catch (_) {}
  }

  console.log("notifications to send:", notifs.map(n => n.id));
  if (DRY) { notifs.forEach(n => console.log("  DRY:", n.id, JSON.stringify(n.payload))); console.log("(dry run — nothing sent)"); return; }
  if (!notifs.length) { console.log("nothing to send"); return ping(); }
  if (!subs.length) { console.log("no subscribers yet"); return ping(); }

  const dead = new Set();
  for (const n of notifs) {
    let ok = 0, fail = 0;
    await Promise.all(subs.map(async s => {
      if (!s || !s.endpoint || !s.keys) return;
      try { await webpush.sendNotification({ endpoint: s.endpoint, keys: s.keys }, JSON.stringify(n.payload), { TTL: 3600 }); ok++; }
      catch (err) { fail++; const code = err && err.statusCode; if (code === 404 || code === 410) dead.add(s.endpoint); }
    }));
    console.log("sent", n.id, "ok=" + ok, "fail=" + fail);
    sent.push({ id: n.id, ts: now });
  }

  if (dead.size) {
    const before = subs.length;
    subs = subs.filter(s => s && !dead.has(s.endpoint));
    console.log("pruned dead subs:", before - subs.length);
    try { await writeKey(SUBS_KEY, subs); } catch (e) { console.error("subs writeback failed:", e.message); }
  }

  const cutoff = now - 3 * 864e5;
  sent = sent.filter(s => s && s.ts >= cutoff).slice(-300);
  try { await writeKey(SENT_KEY, sent); } catch (e) { console.error("sent writeback failed:", e.message); }

  return ping();
}

async function ping() {
  const u = process.env.HEALTHCHECK_URL_PUSH;
  if (!u) return;
  try { await fetch(u, { method: "GET" }); } catch (_) {}
}

main().catch(e => { console.error("ERROR:", e && e.message); process.exit(1); });
