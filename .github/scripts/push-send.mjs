#!/usr/bin/env node
/*
  push-send.mjs - Web Push sender for the "World Cup Fans 2026" app.
  =============================================================================
  Runs in GitHub Actions (FREE - public repo). Reads the app's textdb stores +
  the ESPN public API and sends rich, bilingual Web Push notifications, each
  de-duplicated by id (capriole_wc26_push_sent) so it goes out exactly once.

  NOTIFICATION TYPES
    chat            a teammate posted in chat ("{name} sent a message")     [per-user, skips sender]
    predict_reminder  match 60-240 min away and THIS user has not predicted it [per-user]
    match_30min     kick-off in ~30 min (last call to predict)               [broadcast]
    match_5min      kick-off in ~5 min                                       [broadcast]
    lineups         starting XI / formation just published before kick-off    [broadcast]
    final_score     full time, ~5 min after the final whistle                [broadcast]
    prediction_result points for THIS user's prediction after full time       [per-user]
    goal            a goal was scored, delayed >=1 min after ESPN confirms    [broadcast]
    red_card        a red-card key event appears, old cards skipped           [broadcast]
    shootout_start  a live knockout match reaches penalties                   [broadcast]
    nation_qualified  the user's nation reached the next stage               [per-user, by nation]
    nation_opponent the user's nation's knockout opponent is confirmed        [per-user, by nation]
    nation_eliminated the user's nation is eliminated                         [per-user, by nation]
    egypt_celebration Egypt celebration push for Egypt subscribers            [per-user, by nation]
    week_open       next week's predictions just opened                      [broadcast]
    knockout_open   a knockout match's teams are now confirmed -> predictable [broadcast]
    weekly_champion the morning Prediction Champion (10:00 UAE)              [broadcast]

  ENV     VAPID_PRIVATE_KEY (required)   PUSH_TEST=true   HEALTHCHECK_URL_PUSH
  FLAGS   --dry                 compute + print, never send/write
          --preview <name|all>  fire ONE sample of EVERY type to matching subs (ignores dedup, no writes)
          --lang en|ar          language for --preview (default en)
          --test                send a single "test" notification to all subs

  textdb keys: capriole_wc26_{push_subs,push_sent,push_broadcast,push_pending_goals,push_event_states,
               predictions,accounts,room_8842,r32}
*/
import webpush from "web-push";

const VAPID_PUBLIC  = "BI4pbMHsPCfia1nngQUbb_LpBT6BjrULPMbQ-p5qfSNrGrbuBzr2vrMm3MuluKZ-oiA-OuOQ0TmrVDTpSRg2p2I";
const VAPID_SUBJECT = "https://ahmedelayoty.github.io/world-cup-2026-fans/";
const VAPID_PRIVATE = process.env.VAPID_PRIVATE_KEY || "";

const K = {
  subs:    "capriole_wc26_push_subs",
  sent:    "capriole_wc26_push_sent",
  bcast:   "capriole_wc26_push_broadcast",
  pending: "capriole_wc26_push_pending_goals",
  eventStates: "capriole_wc26_push_event_states",
  preds:   "capriole_wc26_predictions",
  accts:   "capriole_wc26_accounts",
  chat:    "capriole_wc26_room_8842",
  celebrate: "capriole_wc26_celebrate"
};

const argv = process.argv.slice(2);
const DRY  = argv.includes("--dry");
const TEST = argv.includes("--test") || process.env.PUSH_TEST === "true";
const PREVIEW = argv.includes("--preview") ? (argv[argv.indexOf("--preview") + 1] || "all") : null;
const PLANG = argv.includes("--lang") ? (argv[argv.indexOf("--lang") + 1] || "en") : "en";
const ONLY = argv.includes("--only") ? (argv[argv.indexOf("--only") + 1] || "").split(",").map(s => s.trim()).filter(Boolean) : null;   // --preview subset
const GOAL_DELAY_MS = 1 * 60000;
const GOAL_STALE_MS = 10 * 60000;
const FIRST_OBSERVED_LIVE_GRACE_MS = 15 * 60000;
const CHAT_STALE_MS = 60 * 60000;

// ---------- textdb + ESPN helpers ----------
const RD = k => "https://textdb.online/" + k + "?t=" + Date.now();
const WR = "https://api.textdb.online/update/";
async function readKey(key, fb) {
  try { const r = await fetch(RD(key), { headers: { "cache-control": "no-cache" } }); if (!r.ok) return fb;
    const t = (await r.text()).trim(); if (!t) return fb; return JSON.parse(t); } catch (_) { return fb; }
}
async function writeKey(key, val) {
  const r = await fetch(WR, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: "key=" + encodeURIComponent(key) + "&value=" + encodeURIComponent(JSON.stringify(val)) });
  if (!r.ok) throw new Error("textdb write HTTP " + r.status);
}
const ESPN = "https://site.api.espn.com/apis/site/v2/sports/soccer/fifa.world";
const SEASON_RANGE = ESPN + "/scoreboard?dates=20260611-20260719&limit=200";
const STANDINGS_URL = "https://site.api.espn.com/apis/v2/sports/soccer/fifa.world/standings?season=2026";
async function getJSON(u) { try { const r = await fetch(u, { headers: { "cache-control": "no-cache" } }); if (!r.ok) return null; return await r.json(); } catch (_) { return null; } }

// ---------- week / scoring logic (ported from the app) ----------
const _fmtUAE = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Dubai", year: "numeric", month: "2-digit", day: "2-digit" });
function fixedYMD(d) { const p = {}; for (const x of _fmtUAE.formatToParts(d)) p[x.type] = x.value; return p.year + p.month + p.day; }
function uaeDateUTC(d) { const k = fixedYMD(d); return new Date(Date.UTC(+k.slice(0, 4), +k.slice(4, 6) - 1, +k.slice(6, 8))); }
function weekStartKey(d) { const t = uaeDateUTC(d); t.setUTCDate(t.getUTCDate() - ((t.getUTCDay() + 6) % 7)); return t.toISOString().slice(0, 10).replace(/-/g, ""); }
function weekKeyAddDays(key, n) { const t = new Date(Date.UTC(+key.slice(0, 4), +key.slice(4, 6) - 1, +key.slice(6, 8))); t.setUTCDate(t.getUTCDate() + n); return t.toISOString().slice(0, 10).replace(/-/g, ""); }
const GROUP_TYPE = 13802;
const FINAL_AFTER = "2026-07-19T10:00:00Z";
const CELEB_EGY = "Egypt";
const CELEB_OPP = "iran";
const CELEB_SINCE = Date.parse("2026-06-23T00:00:00Z");
const isKO = e => !!(e && e.season && e.season.type && e.season.type !== GROUP_TYPE);
const isFinal = e => isKO(e) && new Date(e.date) >= new Date(FINAL_AFTER);
const PH = /\b(group|place|winner|runner|loser|tbd|1st|2nd|3rd|third|to be|qualif|seed)\b/i;
const hasPred = p => !!(p && (p.h !== undefined || p.pens));
const EVENT_STALE_MS = 10 * 60000;
function HA(e) { const c = e.competitions && e.competitions[0]; if (!c) return {}; return { H: (c.competitors || []).find(x => x.homeAway === "home"), A: (c.competitors || []).find(x => x.homeAway === "away") }; }
function teamName(c) { return (c && c.team && (c.team.displayName || c.team.shortDisplayName || c.team.name || c.team.abbreviation)) || ""; }
function teamId(c) { return (c && c.team && (c.team.id || c.team.displayName || c.team.abbreviation)) || teamName(c); }
function sameNation(a, b) { return String(a || "").trim() === String(b || "").trim(); }
function slugId(v) { return String(v || "team").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 64) || "team"; }
function realMatch(e) { const { H, A } = HA(e); const home = teamName(H), away = teamName(A); return !!(home && away && ![home, away].some(n => PH.test(n))); }
function statNumber(ent, name) { const s = ((ent && ent.stats) || []).find(x => x && x.name === name); const n = Number(s && (s.value ?? s.displayValue)); return Number.isFinite(n) ? n : null; }
function koMatchConfirmed(e) {
  if (!isKO(e)) return false;
  const c = e.competitions && e.competitions[0]; if (!c) return false;
  const names = (c.competitors || []).map(teamName).filter(Boolean);
  return names.length === 2 && names.every(nm => !PH.test(nm));
}
function standingsEntries(standings) {
  const rows = [];
  for (const g of ((standings && standings.children) || [])) for (const ent of (((g.standings || {}).entries) || [])) {
    const nm = ent && ent.team && ent.team.displayName;
    if (nm) rows.push({ group: g.name || "", ent, name: nm, id: (ent.team && ent.team.id) || nm });
  }
  return rows;
}
function confirmedKnockoutTeams(events) {
  const set = new Set();
  for (const e of events || []) {
    if (!koMatchConfirmed(e)) continue;
    const c = e.competitions && e.competitions[0];
    for (const comp of ((c && c.competitors) || [])) {
      const nm = teamName(comp);
      if (nm && !PH.test(nm)) set.add(nm);
    }
  }
  return set;
}
function groupStageComplete(events) {
  const group = (events || []).filter(e => e && e.season && e.season.type === GROUP_TYPE && realMatch(e));
  return group.length >= 72 && group.every(e => e.status && e.status.type && e.status.type.state === "post");
}
function keyEventText(k) { return [k && k.type && k.type.type, k && k.type && k.type.text, k && k.text].filter(Boolean).join(" ").toLowerCase(); }
function isRedCardEvent(k) { if (!k || k.shootout === true) return false; const t = keyEventText(k); return k.redCard === true || /\bred[- ]card\b/.test(t); }
function isShootoutSignal(e, keyEvents) {
  if (!isKO(e)) return false;
  const t = [e && e.status && e.status.type && e.status.type.description, e && e.status && e.status.type && e.status.type.detail, e && e.status && e.status.type && e.status.type.shortDetail].filter(Boolean).join(" ");
  return /penalt|shootout/i.test(t) || (keyEvents || []).some(k => k && k.shootout === true);
}
function keyEventPlayer(k, fallback) { return (k && k.participants && k.participants[0] && k.participants[0].athlete && k.participants[0].athlete.displayName) || fallback || "Player"; }
function keyEventMinute(k) { return ((k && k.clock && k.clock.displayValue) || "").replace("'", ""); }
function egyptResult(e) {
  const c = e && e.competitions && e.competitions[0], comps = (c && c.competitors) || [];
  const egy = comps.find(x => teamName(x) === CELEB_EGY || (x.team && x.team.abbreviation === "EGY")); if (!egy) return null;
  const opp = comps.find(x => x !== egy); if (!opp) return null;
  const es = +egy.score, os = +opp.score; if (!Number.isFinite(es) || !Number.isFinite(os)) return null;
  let res = es > os ? "win" : es < os ? "loss" : "draw";
  if (es === os && egy.shootoutScore != null && opp.shootoutScore != null) res = +egy.shootoutScore > +opp.shootoutScore ? "win" : "loss";
  return { res, oppName: teamName(opp) };
}
function egyptSettledAdvanceByStandings(standings) {
  for (const g of ((standings && standings.children) || [])) {
    const entries = ((g.standings || {}).entries) || [];
    const egypt = entries.find(ent => ent && ent.team && ent.team.displayName === CELEB_EGY);
    if (!egypt) continue;
    const settled = entries.length >= 4 && entries.every(ent => (statNumber(ent, "gamesPlayed") || 0) >= 3);
    return settled && /advance to round of 32/i.test((egypt.note && egypt.note.description) || "");
  }
  return false;
}
function egyptCelebrationTrigger(e, egyptQualified) {
  const r = egyptResult(e); if (!r) return false;
  if (r.res === "win") return true;
  if (!isKO(e) && r.oppName.toLowerCase().includes(CELEB_OPP)) {
    if (r.res === "draw") return true;
    if (r.res === "loss") return !!egyptQualified;
  }
  return false;
}
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
const koTimeUAE = e => { try { return new Date(e.date).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", timeZone: "Asia/Dubai" }); } catch (_) { return ""; } };
const nextStageName = () => "the next round";
function rosterList(r) { if (!r) return []; if (Array.isArray(r.roster)) return r.roster; if (Array.isArray(r.entries)) return r.entries; return []; }
function validLineupRoster(r) {
  const roster = rosterList(r);
  const formation = r && (r.formation || r.formationDisplay || r.displayFormation);
  const starters = roster.filter(p => p && (p.starter === true || p.formationPlace != null || p.formation_place != null));
  return !!formation && starters.length >= 11;
}
function goalScore(g, H, A) {
  return { hs: (g.homeScore ?? g.homeTeamScore ?? H.score ?? "-"), as: (g.awayScore ?? g.awayTeamScore ?? A.score ?? "-") };
}
function cleanObject(v) {
  return v && typeof v === "object" && !Array.isArray(v) ? v : {};
}
function pruneEventStates(eventStates, now) {
  const out = {};
  for (const [id, rec] of Object.entries(cleanObject(eventStates))) {
    const ts = Number(rec && rec.ts) || 0;
    const kickoff = Number(rec && rec.kickoff) || 0;
    const ref = kickoff || ts;
    if (ref && (now - ref) < 7 * 86400000 && (ref - now) < 60 * 86400000) {
      out[id] = { state: String((rec && rec.state) || ""), ts, kickoff };
    }
  }
  return out;
}

// ---------- NOTIFICATION CATALOG (bilingual) ----------
const FLAG = iso => "https://flagcdn.com/w128/" + iso + ".png";
const ISO = { Egypt: "eg" };  // flag icon used only for nation_qualified; unknown -> app icon
function sub(str, d) { return String(str).replace(/\{(\w+)\}/g, (_, k) => (d[k] != null ? d[k] : "")); }
const goURL = (go, m) => "./index.html?go=" + go + (m ? "&m=" + encodeURIComponent(m) : "");

const CAT = {
  chat: {
    tag: () => "chat", renotify: false,
    en: { t: "💬 {name}", b: "{preview}" },
    ar: { t: "💬 {name}", b: "{preview}" },
    url: () => goURL("chat"),
    acts: [{ id: "open_chat", en: "Reply", ar: "رد", url: () => goURL("chat") }]
  },
  predict_reminder: {
    tag: d => "predr-" + d.matchId, renotify: false,
    en: { t: "🎯 Predict!", b: "{home} v {away} kicks off {koTime}. Lock your score before it closes ⚽" },
    ar: { t: "🎯 متنساش تتوقّع", b: "{home} ضد {away} هيلعبوا {koTime}. سجّل توقّعك قبل ما يقفل ⚽" },
    url: d => goURL("predict", d.matchId),
    acts: [{ id: "predict_match", en: "Predict now", ar: "توقّع الآن", url: d => goURL("predict", d.matchId) }]
  },
  match_30min: {
    tag: d => "m-" + d.matchId, renotify: false,
    en: { t: "⏰ 30 min", b: "{home} v {away} at {koTime}. Last call to predict ⚽" },
    ar: { t: "⏰ فاضل 30 دقيقة", b: "{home} ضد {away} الساعة {koTime}. آخر فرصة تتوقّع ⚽" },
    url: d => goURL("predict", d.matchId),
    acts: [{ id: "predict_match", en: "Predict", ar: "توقّع", url: d => goURL("predict", d.matchId) },
           { id: "open_match", en: "View match", ar: "عرض المباراة", url: d => goURL("match", d.matchId) }]
  },
  match_5min: {
    tag: d => "m-" + d.matchId, renotify: true,
    en: { t: "🔥 5 min!", b: "{home} v {away}. Whistle about to blow, get in here ⚽" },
    ar: { t: "🔥 فاضل 5 دقايق!", b: "{home} ضد {away}. الماتش هيبدأ، يلا بينا ⚽" },
    url: d => goURL("match", d.matchId),
    acts: [{ id: "open_match", en: "View match", ar: "عرض المباراة", url: d => goURL("match", d.matchId) },
           { id: "open_chat", en: "Chat", ar: "الدردشة", url: () => goURL("chat") }]
  },
  match_live: {
    tag: d => "m-" + d.matchId, renotify: true,
    en: { t: "LIVE NOW", b: "{home} v {away} has started." },
    ar: { t: "LIVE NOW", b: "{home} v {away} has started." },
    url: d => goURL("match", d.matchId),
    acts: [{ id: "open_match", en: "View match", ar: "View match", url: d => goURL("match", d.matchId) },
           { id: "open_chat", en: "Chat", ar: "Chat", url: () => goURL("chat") }]
  },
  lineups: {
    tag: d => "m-" + d.matchId, renotify: false,
    en: { t: "📋 Line-ups", b: "{home} v {away}. Starting XI and formations just dropped 👀" },
    ar: { t: "📋 التشكيلة نزلت", b: "{home} ضد {away}. التشكيلة الأساسية والخطة بانت دلوقتي 👀" },
    url: d => goURL("match", d.matchId),
    acts: [{ id: "open_match", en: "View match", ar: "عرض المباراة", url: d => goURL("match", d.matchId) }]
  },
  final_score: {
    tag: d => "m-" + d.matchId, renotify: true,
    en: { t: "🏁 Full time", b: "{home} {hs}-{as} {away}{note}. See how your prediction did 🎯" },
    ar: { t: "🏁 خلصت الماتش", b: "{home} {hs}-{as} {away}{note}. شوف توقّعك جاب كام 🎯" },
    url: d => goURL("match", d.matchId),
    acts: [{ id: "open_match", en: "View match", ar: "عرض المباراة", url: d => goURL("match", d.matchId) },
           { id: "open_leaderboard", en: "Leaderboard", ar: "الترتيب", url: () => goURL("leaderboard") }]
  },
  prediction_result: {
    tag: d => "predres-" + d.matchId, renotify: false,
    en: { t: "Prediction points", b: "You scored {points} {pointWord} for {home} {hs}-{as} {away}." },
    ar: { t: "نقاط توقعك", b: "حصلت على {points} نقطة في {home} {hs}-{as} {away}." },
    url: () => goURL("leaderboard"),
    acts: [{ id: "open_match", en: "View match", ar: "المباراة", url: d => goURL("match", d.matchId) },
           { id: "open_leaderboard", en: "Leaderboard", ar: "الترتيب", url: () => goURL("leaderboard") }]
  },
  goal: {
    tag: d => "m-" + d.matchId, renotify: true,
    en: { t: "⚽ GOAL!", b: "{home} {hs}-{as} {away} · {scorer} {min}'" },
    ar: { t: "⚽ جوووون!", b: "{home} {hs}-{as} {away} · {scorer} ف الدقيقة {min}" },
    url: d => goURL("match", d.matchId),
    acts: [{ id: "open_match", en: "View match", ar: "عرض المباراة", url: d => goURL("match", d.matchId) },
           { id: "open_chat", en: "Chat", ar: "الدردشة", url: () => goURL("chat") }]
  },
  red_card: {
    tag: d => "m-" + d.matchId, renotify: true,
    en: { t: "Red card", b: "{player} sent off for {team} · {minute}" },
    ar: { t: "بطاقة حمراء", b: "{player} طُرد مع {team} · {minuteAr}" },
    url: d => goURL("match", d.matchId),
    acts: [{ id: "open_match", en: "View match", ar: "المباراة", url: d => goURL("match", d.matchId) },
           { id: "open_chat", en: "Chat", ar: "الدردشة", url: () => goURL("chat") }]
  },
  shootout_start: {
    tag: d => "m-" + d.matchId, renotify: true,
    en: { t: "Penalty shootout", b: "{home} v {away} is going to penalties." },
    ar: { t: "ركلات الترجيح", b: "{home} ضد {away} وصلت إلى ركلات الترجيح." },
    url: d => goURL("match", d.matchId),
    acts: [{ id: "open_match", en: "View match", ar: "المباراة", url: d => goURL("match", d.matchId) },
           { id: "open_chat", en: "Chat", ar: "الدردشة", url: () => goURL("chat") }]
  },
  nation_qualified: {
    tag: d => "qual-" + d.nation, renotify: true,
    icon: d => FLAG(ISO[d.nation] || ""),
    en: { t: "🎉 Qualified!", b: "{nation} have qualified for {stage}. Let's gooo ⚽🔥" },
    ar: { t: "🎉 تأهّل!", b: "{nation} وصل إلى {stage}. يلا يا أبطال ⚽🔥" },
    egypt: { en: { t: "🦅 Egypt! 🇪🇬", b: "Egypt have qualified for {stage}. Yallaaa! ⚽🔥" },
             ar: { t: "🦅 مصر تأهّلت!", b: "مبروك لرجالة مصر · يا حبيبتي يا مصر ⚽🔥" } },
    url: () => goURL("match"),
    acts: [{ id: "open_match", en: "See the bracket", ar: "شوف المخطّط", url: () => goURL("match") }]
  },
  nation_opponent: {
    tag: d => "opp-" + d.matchId + "-" + d.nation, renotify: true,
    en: { t: "Opponent confirmed", b: "{nation} will face {opponent}. Make your prediction." },
    ar: { t: "تأكد الخصم", b: "{nation} سيواجه {opponent}. سجل توقعك." },
    url: d => goURL("predict", d.matchId),
    acts: [{ id: "predict_match", en: "Predict", ar: "توقع", url: d => goURL("predict", d.matchId) },
           { id: "open_match", en: "View match", ar: "المباراة", url: d => goURL("match", d.matchId) }]
  },
  nation_eliminated: {
    tag: d => "elim-" + d.nation, renotify: true,
    en: { t: "Eliminated", b: "{summary}" },
    ar: { t: "وداع البطولة", b: "{summaryAr}" },
    url: () => goURL("match"),
    acts: [{ id: "open_match", en: "See bracket", ar: "المخطط", url: () => goURL("match") }]
  },
  egypt_celebration: {
    tag: d => "egy-" + (d.matchId || d.kind || "celebration"), renotify: true,
    en: { t: "Celebrate Egypt", b: "Open the app for Egypt's celebration." },
    ar: { t: "احتفل بمصر", b: "افتح التطبيق لتشغيل احتفال مصر." },
    url: d => goURL("match", d.matchId),
    acts: [{ id: "open_match", en: "Celebrate", ar: "احتفل", url: d => goURL("match", d.matchId) }]
  },
  week_open: {
    tag: d => "weekopen-" + d.weekId, renotify: false,
    en: { t: "🎯 New week!", b: "Next week's matches are open. Get your picks in early and climb the table ⚽" },
    ar: { t: "🎯 أسبوع جديد!", b: "ماتشات الأسبوع الجاي فتحت. سجّل بدري وطلّع نفسك فوق ⚽" },
    url: () => goURL("predict"),
    acts: [{ id: "open_predict", en: "Predict now", ar: "توقّع الآن", url: () => goURL("predict") }]
  },
  knockout_open: {
    tag: d => "predm-" + d.matchId, renotify: true,
    en: { t: "🎯 New match", b: "It's official: {home} v {away}. Make your call ⚽" },
    ar: { t: "🎯 ماتش جديد للتوقّع", b: "بقت رسمي: {home} ضد {away}. توقّع النتيجة ⚽" },
    url: d => goURL("predict", d.matchId),
    acts: [{ id: "predict_match", en: "Predict now", ar: "توقّع الآن", url: d => goURL("predict", d.matchId) }]
  },
  weekly_champion: {
    tag: d => "champ-" + d.weekId, renotify: true,
    en: { t: "👑 Champion!", b: "{champion} tops the week with {points} pts 🏆" },
    ar: { t: "👑 البرنس!", b: "{champion} برنس التوقّعات · {points} نقطة 🏆" },
    url: () => goURL("leaderboard"),
    acts: [{ id: "open_leaderboard", en: "Leaderboard", ar: "الترتيب", url: () => goURL("leaderboard") }]
  },
  test: {
    tag: () => "test", renotify: true,
    en: { t: "🔔 Test alert", b: "Notifications are working. Enjoy the World Cup!" },
    ar: { t: "🔔 تجربة التنبيهات", b: "التنبيهات تعمل. استمتع بكأس العالم!" },
    url: () => goURL("match"), acts: []
  }
};

function buildPayload(type, d, lang) {
  const c = CAT[type]; if (!c) return null;
  const L = (lang === "ar") ? "ar" : "en";
  let copy = c[L];
  if (type === "nation_qualified" && d.nation === "Egypt" && c.egypt) copy = c.egypt[L];
  const actionUrls = {}; const actions = [];
  (c.acts || []).forEach(a => { actionUrls[a.id] = a.url(d); actions.push({ action: a.id, title: a[L] }); });
  const p = { title: sub(copy.t, d), body: sub(copy.b, d), tag: c.tag(d), renotify: !!c.renotify, url: c.url(d), actions, actionUrls };
  if (c.icon) { const ic = c.icon(d); if (ic && ic.indexOf("//") > 0 && !ic.endsWith("/.png")) p.icon = ic; }  // real flag URL only
  return p;
}

// ---------- sending ----------
let _vapidReady = false;
function vapid() { if (!_vapidReady && VAPID_PRIVATE) { webpush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC, VAPID_PRIVATE); _vapidReady = true; } }
async function sendTo(list, payload) {
  vapid(); let ok = 0, fail = 0; const dead = new Set();
  await Promise.all(list.map(async s => {
    if (!s || !s.endpoint || !s.keys) return;
    try { await webpush.sendNotification({ endpoint: s.endpoint, keys: s.keys }, JSON.stringify(payload), { TTL: 3600 }); ok++; }
    catch (err) { fail++; const code = err && err.statusCode; if (code === 404 || code === 410) dead.add(s.endpoint); }
  }));
  return { ok, fail, dead };
}
const langOf = s => (s && s.lang === "ar") ? "ar" : "en";
function applyNote(d, lang) {
  if (!d || d.noteVal === undefined) return d || {};
  const N = { none: { en: "", ar: "" }, aet: { en: " · after extra time", ar: " · بعد الوقت الإضافي" }, pens: { en: " · on penalties", ar: " · بركلات الترجيح" } };
  return Object.assign({}, d, { note: (N[d.noteVal] || N.none)[lang === "ar" ? "ar" : "en"] });
}

// =====================================================================
async function main() {
  if (!VAPID_PRIVATE && !DRY) { console.error("FATAL: VAPID_PRIVATE_KEY not set."); process.exit(1); }
  let subs = await readKey(K.subs, []); if (!Array.isArray(subs)) subs = [];
  console.log("subscribers:", subs.length);

  // ---------- PREVIEW: fire one sample of EVERY type ----------
  if (PREVIEW) {
    const targets = PREVIEW === "all" ? subs : subs.filter(s => s && (s.name || "").toLowerCase() === PREVIEW.toLowerCase());
    console.log("preview targets:", targets.length, "lang:", PLANG);
    const SAMPLE = {
      chat:            { name: "Maged", preview: "Yalla Egypt, who's watching tonight? 🔥" },
      predict_reminder:{ home: "Egypt", away: "Spain", koTime: "20:00", matchId: "preview1" },
      match_30min:     { home: "Egypt", away: "Spain", koTime: "20:00", matchId: "preview1" },
      match_5min:      { home: "Egypt", away: "Spain", matchId: "preview1" },
      match_live:      { home: "Egypt", away: "Spain", matchId: "preview1" },
      lineups:         { home: "Egypt", away: "Spain", matchId: "preview1" },
      goal:            { scorer: "Mohamed Salah", min: 67, home: "Egypt", hs: 2, as: 1, away: "Spain", matchId: "preview1" },
      red_card:        { player: "Mohamed Salah", team: "Egypt", minute: "72'", minuteAr: "الدقيقة 72", matchId: "preview1" },
      shootout_start:  { home: "Egypt", away: "Spain", matchId: "preview1" },
      final_score:     { home: "Egypt", hs: 2, as: 1, away: "Spain", note: "", matchId: "preview1" },
      prediction_result:{ home: "Egypt", hs: 2, as: 1, away: "Spain", points: 3, pointWord: "pts", matchId: "preview1" },
      knockout_open:   { home: "Brazil", away: "Argentina", matchId: "preview3" },
      nation_qualified:{ nation: "Egypt", stage: "the Round of 16", matchId: "preview2" },
      nation_opponent: { nation: "Egypt", opponent: "Spain", home: "Egypt", away: "Spain", matchId: "preview2" },
      nation_eliminated:{ nation: "Spain", summary: "Spain's World Cup run is over after Egypt 2-1 Spain.", summaryAr: "Spain ودّع كأس العالم بعد Egypt 2-1 Spain.", matchId: "preview2" },
      egypt_celebration:{ kind: "match", matchId: "preview2" },
      week_open:       { weekId: "preview" },
      weekly_champion: { champion: "AhmedElayoty", points: 14, weekId: "preview" }
    };
    const order = (ONLY || ["chat", "predict_reminder", "match_30min", "match_5min", "match_live", "lineups", "goal", "red_card", "shootout_start", "final_score", "prediction_result", "knockout_open", "nation_qualified", "nation_opponent", "nation_eliminated", "egypt_celebration", "week_open", "weekly_champion"]);
    for (const type of order) {
      const p = buildPayload(type, SAMPLE[type], PLANG);
      console.log("  " + type + " -> " + p.title + " | " + p.body);
      if (!DRY && targets.length) { const r = await sendTo(targets, p); console.log("     sent ok=" + r.ok + " fail=" + r.fail); }
    }
    console.log("PREVIEW done (" + order.length + " notifications, lang=" + PLANG + ").");
    return;
  }

  // ---------- normal run ----------
  let sent = await readKey(K.sent, []); if (!Array.isArray(sent)) sent = [];
  const sentIds = new Set(sent.map(s => s && s.id));
  let pending = await readKey(K.pending, {}); if (!pending || typeof pending !== "object") pending = {};
  const now = Date.now();
  const queue = [];
  const fire = (id, type, data, recipients) => { if (!sentIds.has(id) && recipients && recipients.length) queue.push({ id, type, data, recipients }); };

  if (TEST) fire("test-" + now, "test", {}, subs);

  const bcast = await readKey(K.bcast, null);
  if (bcast && bcast.id && bcast.title && !sentIds.has("bc-" + bcast.id))
    queue.push({ id: "bc-" + bcast.id, raw: { title: bcast.title, body: bcast.body || "", tag: "bc-" + bcast.id, renotify: true, url: bcast.url || "./index.html", actions: [], actionUrls: {} }, recipients: subs });

  const sb = await getJSON(SEASON_RANGE);
  const events = (sb && sb.events) || [];
  const accts = (await readKey(K.accts, {})) || {};
  const preds = (await readKey(K.preds, {})) || {};
  let eventStates = cleanObject(await readKey(K.eventStates, {}));

  for (const e of events) {
    try {
      const st = (e.status && e.status.type && e.status.type.state) || "";
      const { H, A } = HA(e); if (!H || !A || !H.team || !A.team) continue;
      const kickoff = Date.parse(e.date); if (!isFinite(kickoff)) continue;
      const home = H.team.displayName, away = A.team.displayName, mins = (kickoff - now) / 60000;
      const real = ![home, away].some(n => PH.test(n));
      const hadEventState = Object.prototype.hasOwnProperty.call(eventStates, e.id);
      const prevEventState = hadEventState && eventStates[e.id] ? eventStates[e.id].state : "";
      eventStates[e.id] = { state: st, ts: now, kickoff };
      let summary = null;
      const getSummary = async () => summary || (summary = await getJSON(ESPN + "/summary?event=" + e.id));

      if (koMatchConfirmed(e) && st === "pre") {
        fire("kc-" + e.id, "knockout_open", { home, away, matchId: e.id }, subs);
        const comps = ((e.competitions && e.competitions[0] && e.competitions[0].competitors) || []);
        for (const comp of comps) {
          const nation = teamName(comp), opponent = teamName(comps.find(x => x !== comp));
          if (!nation || !opponent) continue;
          fire("opp-" + e.id + "-" + slugId(teamId(comp)), "nation_opponent", { nation, opponent, home, away, matchId: e.id }, subs.filter(s => sameNation(s && s.nat, nation)));
        }
      }

      if (st === "pre" && real) {
        if (mins > 25 && mins <= 35) fire("ko30-" + e.id, "match_30min", { home, away, koTime: koTimeUAE(e), matchId: e.id }, subs);
        if (mins > 0 && mins <= 7)  fire("ko5-" + e.id, "match_5min", { home, away, matchId: e.id }, subs);
        if (mins <= 240 && mins > 60) {
          subs.forEach(s => {
            const uid = s && s.uid; if (!uid) return;
            const up = preds[uid] && preds[uid].preds; if (up && hasPred(up[e.id])) return;
            fire("predr-" + e.id + "-" + uid, "predict_reminder", { home, away, koTime: koTimeUAE(e), matchId: e.id }, [s]);
          });
        }
        if (mins > 0 && mins <= 90 && !sentIds.has("lu-" + e.id)) {
          const sum = await getSummary();
          const rosters = (sum && sum.rosters) || [];
          if (rosters.length >= 2 && rosters.every(validLineupRoster)) fire("lu-" + e.id, "lineups", { home, away, matchId: e.id }, subs);
        }
      }

      if (st === "in" && real) {
        const liveAge = now - kickoff;
        const transitionedLive = hadEventState && prevEventState !== "in";
        const firstObservedNearKickoff = !hadEventState && liveAge >= -2 * 60000 && liveAge <= FIRST_OBSERVED_LIVE_GRACE_MS;
        if (transitionedLive || firstObservedNearKickoff) fire("live-" + e.id, "match_live", { home, away, matchId: e.id }, subs);
      }

      if ((st === "in" || (st === "post" && (now - kickoff) < 4 * 3600000)) && real) {
        const sum = await getSummary();
        const keyEvents = (sum && sum.keyEvents) || [];
        if (st === "in" && isShootoutSignal(e, keyEvents)) fire("shootout-" + e.id, "shootout_start", { home, away, matchId: e.id }, subs);
        for (const g of keyEvents) {
          if (!g || g.scoringPlay !== true || g.shootout === true) continue;
          const gid = "goal-" + e.id + "-" + g.id; if (sentIds.has(gid)) continue;
          const wall = g.wallclock ? Date.parse(g.wallclock) : NaN;
          const effective = isFinite(wall) ? wall : (pending[gid] || (pending[gid] = now));
          const age = now - effective;
          if (age >= GOAL_DELAY_MS && age <= GOAL_STALE_MS) {
            const scorer = (g.participants && g.participants[0] && g.participants[0].athlete && g.participants[0].athlete.displayName) || "Goal";
            const min = (g.clock && g.clock.displayValue ? g.clock.displayValue : "").replace("'", "");
            fire(gid, "goal", { scorer, min, home, away, ...goalScore(g, H, A), matchId: e.id }, subs);
          } else if (age > GOAL_STALE_MS) { sentIds.add(gid); sent.push({ id: gid, ts: now, skip: "stale_goal" }); }
        }
        for (const g of keyEvents) {
          if (!isRedCardEvent(g)) continue;
          const rid = "red-" + e.id + "-" + (g.id || slugId(g.text || keyEventText(g))); if (sentIds.has(rid)) continue;
          const wall = g.wallclock ? Date.parse(g.wallclock) : NaN;
          const effective = isFinite(wall) ? wall : (pending[rid] || (pending[rid] = now));
          const age = now - effective;
          if (age >= -2 * 60000 && age <= EVENT_STALE_MS) {
            const min = keyEventMinute(g);
            fire(rid, "red_card", { player: keyEventPlayer(g, "Player"), team: (g.team && g.team.displayName) || "their team", minute: min ? min + "'" : "now", minuteAr: min ? "الدقيقة " + min : "الآن", matchId: e.id }, subs);
          } else if (age > EVENT_STALE_MS) { sentIds.add(rid); sent.push({ id: rid, ts: now, skip: "stale_red_card" }); }
        }
      }

      if (st === "post" && (now - kickoff) < 6 * 3600000) {   // only matches that kicked off within the last 6h (stops backfilling old results)
        const desc = (e.status.type.description || "") + " " + (e.status.type.detail || "");
        const so = (H.shootoutScore != null && A.shootoutScore != null && (+H.shootoutScore !== 0 || +A.shootoutScore !== 0));
        const noteVal = so ? "pens" : /extra/i.test(desc) ? "aet" : "none";
        fire("ft-" + e.id, "final_score", { home, away, hs: (H.score != null ? H.score : "-"), as: (A.score != null ? A.score : "-"), noteVal, matchId: e.id }, subs);
        subs.forEach(s => {
          const uid = s && s.uid; if (!uid) return;
          const p = preds[uid] && preds[uid].preds && preds[uid].preds[e.id]; if (!hasPred(p)) return;
          const points = scorePred(p, H, A, e);
          fire("predres-" + e.id + "-" + uid, "prediction_result", { home, away, hs: (H.score != null ? H.score : "-"), as: (A.score != null ? A.score : "-"), points, pointWord: points === 1 ? "pt" : "pts", matchId: e.id }, [s]);
        });
        if (isKO(e)) {
          const win = [H, A].find(x => x.winner) || (so ? (+H.shootoutScore > +A.shootoutScore ? H : A) : null);
          if (win && win.team) {
            const wn = win.team.displayName, tid = win.team.id || wn;
            fire("adv-" + e.id + "-" + tid, "nation_qualified", { nation: wn, stage: nextStageName(), matchId: e.id }, subs.filter(s => (s.nat || "") === wn));
            for (const loser of [H, A].filter(x => x && x.team && x !== win)) {
              const ln = teamName(loser); if (!ln || PH.test(ln)) continue;
              fire("elim-" + e.id + "-" + slugId(teamId(loser)), "nation_eliminated", {
                nation: ln,
                summary: ln + "'s World Cup run is over after " + home + " " + (H.score != null ? H.score : "-") + "-" + (A.score != null ? A.score : "-") + " " + away + ".",
                summaryAr: ln + " ودّع كأس العالم بعد " + home + " " + (H.score != null ? H.score : "-") + "-" + (A.score != null ? A.score : "-") + " " + away + ".",
                matchId: e.id
              }, subs.filter(s => sameNation(s && s.nat, ln)));
            }
          }
        }
      }
    } catch (_) {}
  }

  // GROUP qualification / elimination uses the same standings endpoint as the app.
  const standings = await getJSON(STANDINGS_URL);
  const standRows = standingsEntries(standings);
  const koTeams = confirmedKnockoutTeams(events);
  const egyptSubs = subs.filter(s => sameNation(s && s.nat, CELEB_EGY));
  for (const row of standRows) {
    const note = (row.ent.note && row.ent.note.description) || "";
    if (/advance to round of 32/i.test(note)) {
      fire("q-r32-" + row.name, "nation_qualified", { nation: row.name, stage: "the Round of 32", matchId: "" }, subs.filter(s => sameNation(s && s.nat, row.name)));
    }
    if (/eliminated|did not advance|failed to advance/i.test(note)) {
      fire("elim-group-note-" + slugId(row.id || row.name), "nation_eliminated", {
        nation: row.name,
        summary: row.name + "'s World Cup run is over after the group stage.",
        summaryAr: row.name + " ودّع كأس العالم بعد دور المجموعات.",
        matchId: ""
      }, subs.filter(s => sameNation(s && s.nat, row.name)));
    }
  }
  if (groupStageComplete(events) && koTeams.size >= 32) {
    for (const row of standRows) {
      if (koTeams.has(row.name)) continue;
      fire("elim-group-" + slugId(row.id || row.name), "nation_eliminated", {
        nation: row.name,
        summary: row.name + "'s World Cup run is over after the group stage.",
        summaryAr: row.name + " ودّع كأس العالم بعد دور المجموعات.",
        matchId: ""
      }, subs.filter(s => sameNation(s && s.nat, row.name)));
    }
  }
  const egyptPlacedInKnockout = koTeams.has(CELEB_EGY);
  const egyptQualifiedForCelebrationResult = egyptPlacedInKnockout || egyptSettledAdvanceByStandings(standings);
  if (egyptPlacedInKnockout) fire("egy-r32", "egypt_celebration", { kind: "r32", matchId: "" }, egyptSubs);
  for (const e of events) {
    if (!e || !e.status || !e.status.type || e.status.type.state !== "post") continue;
    const kickoff = Date.parse(e.date);
    if (!Number.isFinite(kickoff) || kickoff < CELEB_SINCE) continue;
    if (egyptCelebrationTrigger(e, egyptQualifiedForCelebrationResult)) fire("egy-match-" + e.id, "egypt_celebration", { kind: "match", matchId: e.id }, egyptSubs);
  }
  const celebFlag = await readKey(K.celebrate, null);
  const flagTs = celebFlag && celebFlag.ts ? (Number(celebFlag.ts) || Date.parse(celebFlag.ts)) : 0;
  if (celebFlag && celebFlag.on && celebFlag.id && (!flagTs || now - flagTs <= 6 * 3600000)) {
    fire("egy-manual-" + slugId(celebFlag.id), "egypt_celebration", { kind: "manual", matchId: "" }, egyptSubs);
  }

  // CHAT (recent unsent non-bot messages, to everyone except sender)
  const BOT = /^(goalbot|brkbot|champbot|funbot|adminbot)/i;
  let chat = await readKey(K.chat, []); if (!Array.isArray(chat)) chat = [];
  for (const m of chat.filter(m => m && m.id && m.text && m.ts && (now - m.ts) <= CHAT_STALE_MS && m.uid && !BOT.test(m.uid) && !sentIds.has("chat-" + m.id)).sort((a, b) => a.ts - b.ts).slice(-5))
    fire("chat-" + m.id, "chat", { name: m.name || "Someone", preview: (m.text || "").slice(0, 80) }, subs.filter(s => (s && s.uid) !== m.uid));

  // NEXT WEEK predictions just opened
  const curWk = weekStartKey(new Date()), nextWk = weekKeyAddDays(curWk, 7);
  if (events.some(e => { const { H, A } = HA(e); if (!H || !A || !H.team || !A.team) return false; const real = ![H.team.displayName, A.team.displayName].some(n => PH.test(n)); return real && e.status.type.state === "pre" && weekStartKey(new Date(e.date)) === nextWk && (new Date(e.date) - now) <= 2 * 86400000; }))
    fire("weekopen-" + nextWk, "week_open", { weekId: nextWk }, subs);

  // WEEKLY CHAMPION at ~10:00 UAE (06:00 UTC)
  const nowD = new Date(now);
  if (fixedYMD(nowD) === curWk && nowD.getUTCHours() === 6 && nowD.getUTCMinutes() < 10) {
    const byWeek = {}; events.forEach(e => { const w = weekStartKey(new Date(e.date)); (byWeek[w] = byWeek[w] || []).push(e); });
    const wk = weekKeyAddDays(curWk, -7);
    if (byWeek[wk] && byWeek[wk].length && byWeek[wk].every(e => e.status.type.state === "post") && !sentIds.has("champ-" + wk)) {
      const scores = Object.entries(preds).map(([uid, u]) => { let pts = 0; byWeek[wk].forEach(e => { const { H, A } = HA(e); const p = (u.preds || {})[e.id]; if (hasPred(p)) pts += scorePred(p, H, A, e); }); return { name: u.name || "?", pts }; }).filter(x => x.pts > 0).sort((a, b) => b.pts - a.pts);
      if (scores.length) { const top = scores[0].pts; fire("champ-" + wk, "weekly_champion", { champion: scores.filter(s => s.pts === top).map(s => s.name).join(" & "), points: top, weekId: wk }, subs); }
    }
  }

  // ---------- dispatch ----------
  console.log("queued:", queue.map(q => q.id));
  if (DRY) { queue.forEach(q => { const p = q.raw || buildPayload(q.type, applyNote(q.data, "en"), "en"); console.log("  DRY " + q.id + " -> " + (p && p.title) + " | " + (p && p.body) + "  [" + (q.recipients ? q.recipients.length : 0) + " subs]"); }); console.log("(dry run, nothing sent)"); return; }

  // FIRST-RUN SEED: if there is no history yet (or --seed), record the current state as already-sent and send
  // NOTHING. This stops a cold start from backfilling every match that already finished / nation already qualified.
  const seeding = argv.includes("--seed") || (sent.length === 0 && !TEST);
  if (seeding) {
    queue.forEach(q => sent.push({ id: q.id, ts: now }));
    try { await writeKey(K.sent, sent.slice(-400)); } catch (_) {}
    try { await writeKey(K.pending, pending); } catch (_) {}
    try { await writeKey(K.eventStates, pruneEventStates(eventStates, now)); } catch (_) {}
    console.log("SEEDED " + queue.length + " ids (baseline set, nothing sent). Real alerts start next run.");
    return;
  }

  const deadAll = new Set();
  for (const q of queue) {
    const recips = q.recipients || subs; if (!recips.length) continue;
    const byLang = { en: [], ar: [] }; recips.forEach(s => byLang[langOf(s)].push(s));
    let okT = 0, failT = 0;
    for (const lang of ["en", "ar"]) {
      if (!byLang[lang].length) continue;
      const payload = q.raw || buildPayload(q.type, applyNote(q.data, lang), lang);
      const r = await sendTo(byLang[lang], payload); okT += r.ok; failT += r.fail; r.dead.forEach(x => deadAll.add(x));
    }
    sent.push({ id: q.id, ts: now }); console.log("sent " + q.id + " ok=" + okT + " fail=" + failT);
  }

  if (deadAll.size) { const before = subs.length; subs = subs.filter(s => s && !deadAll.has(s.endpoint)); console.log("pruned dead:", before - subs.length); try { await writeKey(K.subs, subs); } catch (_) {} }
  // Prune the sent-log. One-time MILESTONES (qualified, knockout-confirmed, advance, champion, week-open, broadcast)
  // are kept for the whole tournament so they never re-fire after the 3-day window; high-volume ids (goals, finals,
  // kick-offs, line-ups, chat, reminders) prune after 3 days and cap at 400. This also means a brand-new subscriber
  // never gets the backlog: any id already here is skipped for everyone.
  const MILE = /^(kc-|q-r32-|adv-|qual-|opp-|elim-|egy-|champ-|weekopen-|bc-)/;
  const live = sent.filter(s => s && (MILE.test(s.id) ? (now - s.ts) < 40 * 86400000 : (now - s.ts) < 3 * 86400000));
  sent = live.filter(s => MILE.test(s.id)).concat(live.filter(s => !MILE.test(s.id)).slice(-400));
  try { await writeKey(K.sent, sent); } catch (_) {}
  const keepSent = new Set(sent.map(s => s.id)); const pend2 = {}; for (const k in pending) if (!keepSent.has(k) && (now - pending[k]) < 6 * 3600000) pend2[k] = pending[k];
  try { await writeKey(K.pending, pend2); } catch (_) {}
  try { await writeKey(K.eventStates, pruneEventStates(eventStates, now)); } catch (_) {}
  await ping();
}
async function ping() { const u = process.env.HEALTHCHECK_URL_PUSH; if (!u) return; try { await fetch(u); } catch (_) {} }
main().catch(e => { console.error("ERROR:", e && e.message); process.exit(1); });
