#!/usr/bin/env node
/*
  week-status.mjs — READ-ONLY. Prints, for each tournament week (Mon-Sun, UAE):
  date range, matches total/finished/live/upcoming, and the computed Prediction
  Champion. Also prints the current week, what lastCompletedWeek() would show
  (the banner), and locates South Africa vs Canada (date, week, status).
  Mirrors the app's own week + scoring logic. Writes nothing, no secrets.
*/
const ESPN = "https://site.api.espn.com/apis/site/v2/sports/soccer/fifa.world";
const SEASON_RANGE = ESPN + "/scoreboard?dates=20260611-20260719&limit=300";
const PRED_KEY = "capriole_wc26_predictions";
const GROUP_TYPE = 13802;
const FINAL_AFTER = "2026-07-19T10:00:00Z";

const sleep = ms => new Promise(r => setTimeout(r, ms));
async function getJSON(u, fb) {
  for (let i = 1; i <= 3; i++) {
    try { const r = await fetch(u, { headers: { "cache-control": "no-cache" } }); if (!r.ok) throw new Error("HTTP " + r.status); return await r.json(); }
    catch (e) { if (i === 3) { console.log("  (" + u.slice(0, 60) + " failed: " + e.message + ")"); return fb; } await sleep(1500 * i); }
  }
  return fb;
}
async function readKey(key, fb) {
  for (let i = 1; i <= 3; i++) {
    try { const r = await fetch("https://textdb.online/" + key + "?t=" + Date.now() + "_" + i, { headers: { "cache-control": "no-cache" } }); if (!r.ok) throw new Error("HTTP " + r.status); const t = (await r.text()).trim(); return t ? JSON.parse(t) : fb; }
    catch (e) { if (i === 3) { console.log("  (" + key + " read failed: " + e.message + ")"); return fb; } await sleep(1500 * i); }
  }
  return fb;
}

// ---- week + scoring logic (mirrors the app / push-send.mjs) ----
const _fmtUAE = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Dubai", year: "numeric", month: "2-digit", day: "2-digit" });
const _lbl = new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Dubai", weekday: "short", day: "2-digit", month: "short" });
function fixedYMD(d) { const p = {}; for (const x of _fmtUAE.formatToParts(d)) p[x.type] = x.value; return p.year + p.month + p.day; }
function uaeDateUTC(d) { const k = fixedYMD(d); return new Date(Date.UTC(+k.slice(0, 4), +k.slice(4, 6) - 1, +k.slice(6, 8))); }
function weekStartKey(d) { const t = uaeDateUTC(d); t.setUTCDate(t.getUTCDate() - ((t.getUTCDay() + 6) % 7)); return t.toISOString().slice(0, 10).replace(/-/g, ""); }
const isKO = e => !!(e && e.season && e.season.type && e.season.type !== GROUP_TYPE);
const isFinal = e => isKO(e) && new Date(e.date) >= new Date(FINAL_AFTER);
const PH = /\b(group|place|winner|runner|loser|tbd|1st|2nd|3rd|third|to be|qualif|seed)\b/i;
const hasPred = p => !!(p && (p.h !== undefined || p.pens));
function HA(e) { const c = e.competitions && e.competitions[0]; if (!c) return {}; return { H: (c.competitors || []).find(x => x.homeAway === "home"), A: (c.competitors || []).find(x => x.homeAway === "away") }; }
function nm(c) { return (c && c.team && c.team.displayName) || ""; }
function realMatch(e) { const { H, A } = HA(e); return !!(nm(H) && nm(A) && ![nm(H), nm(A)].some(n => PH.test(n))); }
function scorePred(p, H, A, e) {
  if (!hasPred(p) || !H || !A) return 0;
  const h = +H.score, a = +A.score; if (!isFinite(h) || !isFinite(a)) return 0;
  const EXACT = isFinal(e) ? 10 : 3, RESULT = isFinal(e) ? 4 : 1;
  if (!isKO(e)) { if (p.h === h && p.a === a) return EXACT; if (Math.sign(p.h - p.a) === Math.sign(h - a)) return RESULT; return 0; }
  const so = (H.shootoutScore != null && A.shootoutScore != null && (+H.shootoutScore !== 0 || +A.shootoutScore !== 0));
  const winner = so ? (+H.shootoutScore > +A.shootoutScore ? "home" : "away") : (h > a ? "home" : a > h ? "away" : (H.winner ? "home" : A.winner ? "away" : null));
  if (p.pens) { if (!winner) return 0; if (p.w === winner) return so ? EXACT : RESULT; return 0; }
  if (p.h === h && p.a === a && !so) return EXACT;
  const pw = p.h > p.a ? "home" : p.a > p.h ? "away" : null;
  if (pw && pw === winner) return RESULT; return 0;
}
function weekChampion(weekEvents, all) {
  const scores = Object.entries(all).map(([uid, u]) => {
    let pts = 0; weekEvents.forEach(e => { const { H, A } = HA(e); const p = (u.preds || {})[e.id]; if (hasPred(p)) pts += scorePred(p, H, A, e); });
    return { name: u.name || "?", pts };
  }).filter(x => x.pts > 0).sort((a, b) => b.pts - a.pts);
  return scores;
}

(async () => {
  const sb = await getJSON(SEASON_RANGE, {});
  const events = ((sb && sb.events) || []).filter(realMatch);
  const all = await readKey(PRED_KEY, {});
  const now = new Date();
  const curWk = weekStartKey(now);

  const byWeek = {};
  events.forEach(e => { const w = weekStartKey(new Date(e.date)); (byWeek[w] = byWeek[w] || []).push(e); });
  const stOf = e => (e.status && e.status.type && e.status.type.state) || "?";

  const L = "─".repeat(60);
  console.log("\n" + L + "\n  WEEK STATUS  ·  now=" + now.toISOString() + "  ·  current week key=" + curWk + "\n" + L);

  const weeks = Object.keys(byWeek).sort();
  for (const w of weeks) {
    const ds = byWeek[w].slice().sort((a, b) => new Date(a.date) - new Date(b.date));
    const post = ds.filter(e => stOf(e) === "post").length;
    const live = ds.filter(e => stOf(e) === "in").length;
    const pre = ds.filter(e => stOf(e) === "pre").length;
    const range = _lbl.format(new Date(ds[0].date)) + "  →  " + _lbl.format(new Date(ds[ds.length - 1].date));
    const complete = post === ds.length;
    const tag = w === curWk ? "  ◀ CURRENT" : (complete ? "  ✓ complete" : "  … in progress");
    const champ = weekChampion(ds, all);
    console.log("\n  WEEK " + w + tag + "\n    " + range);
    console.log("    matches: " + ds.length + "  · finished " + post + " · live " + live + " · upcoming " + pre);
    console.log("    champion (so far): " + (champ.length ? champ[0].name + " — " + champ[0].pts + " pts" + (champ[1] ? "   (2nd " + champ[1].name + " " + champ[1].pts + ")" : "") : "(nobody scored yet)"));
  }

  // lastCompletedWeek = latest past week fully finished — this is what the banner shows
  const lcw = weeks.filter(w => w < curWk && byWeek[w].every(e => stOf(e) === "post")).sort().pop();
  console.log("\n" + L);
  console.log("  BANNER shows champion of: " + (lcw ? lcw + "  (" + _lbl.format(new Date(byWeek[lcw][0].date)) + " → " + _lbl.format(new Date(byWeek[lcw][byWeek[lcw].length - 1].date)) + ")" : "(none)"));
  if (lcw) { const c = weekChampion(byWeek[lcw], all); console.log("    → " + (c.length ? c[0].name + " (" + c[0].pts + " pts)" : "nobody scored")); }
  // why not last week?
  const pastWeeks = weeks.filter(w => w < curWk).sort();
  const lastPast = pastWeeks[pastWeeks.length - 1];
  if (lastPast && lastPast !== lcw) {
    const unfinished = byWeek[lastPast].filter(e => stOf(e) !== "post");
    console.log("  NOTE: the most recent past week (" + lastPast + ") is NOT shown because " + unfinished.length + " of its matches aren't 'post':");
    unfinished.forEach(e => { const { H, A } = HA(e); console.log("        - " + nm(H) + " v " + nm(A) + "  [" + stOf(e) + "]  " + _lbl.format(new Date(e.date))); });
  }

  // locate South Africa vs Canada
  console.log("\n" + L + "\n  SOUTH AFRICA vs CANADA:");
  const sac = events.filter(e => { const { H, A } = HA(e); const s = new Set([nm(H), nm(A)]); return s.has("South Africa") && s.has("Canada"); });
  if (!sac.length) console.log("    (not found in the feed)");
  sac.forEach(e => { const { H, A } = HA(e); console.log("    " + nm(H) + " " + (H && H.score != null ? H.score : "-") + "-" + (A && A.score != null ? A.score : "-") + " " + nm(A) + "  · " + stOf(e) + " · " + _lbl.format(new Date(e.date)) + " · week " + weekStartKey(new Date(e.date)) + (weekStartKey(new Date(e.date)) === curWk ? " (CURRENT week)" : "")); });
  console.log(L + "\n");
})().catch(e => { console.error("ERROR: " + (e && e.message)); process.exit(1); });
