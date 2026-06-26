#!/usr/bin/env node
/*
  push-send.mjs - Web Push sender for the "World Cup Fans 2026" app.
  =============================================================================
  Runs in GitHub Actions (FREE - public repo). Reads the app's textdb stores +
  the ESPN public API and sends rich, bilingual Web Push notifications, each
  de-duplicated by id (capriole_wc26_push_sent) so it goes out exactly once.

  NOTIFICATION TYPES
    chat            a teammate posted in chat ("{name} sent a message")     [per-user, skips sender]
    predict_reminder  match ~4h away and THIS user has not predicted it      [per-user]
    match_30min     kick-off in ~30 min (last call to predict)               [broadcast]
    match_5min      kick-off in ~5 min                                       [broadcast]
    lineups         starting XI / formation just published (~1h before)      [broadcast]
    final_score     full time, ~5 min after the final whistle                [broadcast]
    goal            a goal was scored, DELAYED >= 3 min (slow-stream safe)    [broadcast]
    nation_qualified  the user's nation reached the next stage               [per-user, by nation]
    week_open       next week's predictions just opened                      [broadcast]
    knockout_open   a knockout match's teams are now confirmed -> predictable [broadcast]
    weekly_champion the morning Prediction Champion (10:00 UAE)              [broadcast]

  ENV     VAPID_PRIVATE_KEY (required)   PUSH_TEST=true   HEALTHCHECK_URL_PUSH
  FLAGS   --dry                 compute + print, never send/write
          --preview <name|all>  fire ONE sample of EVERY type to matching subs (ignores dedup, no writes)
          --lang en|ar          language for --preview (default en)
          --test                send a single "test" notification to all subs

  textdb keys: capriole_wc26_{push_subs,push_sent,push_broadcast,push_pending_goals,
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
  preds:   "capriole_wc26_predictions",
  accts:   "capriole_wc26_accounts",
  chat:    "capriole_wc26_room_8842"
};

const argv = process.argv.slice(2);
const DRY  = argv.includes("--dry");
const TEST = argv.includes("--test") || process.env.PUSH_TEST === "true";
const PREVIEW = argv.includes("--preview") ? (argv[argv.indexOf("--preview") + 1] || "all") : null;
const PLANG = argv.includes("--lang") ? (argv[argv.indexOf("--lang") + 1] || "en") : "en";
const ONLY = argv.includes("--only") ? (argv[argv.indexOf("--only") + 1] || "").split(",").map(s => s.trim()).filter(Boolean) : null;   // --preview subset
const GOAL_DELAY_MS = 3 * 60000;
const GOAL_STALE_MS = 20 * 60000;
const LIVE_STALE_MS = 10 * 60000;
const CHAT_STALE_MS = 60 * 60000;
const LINEUP_TOO_LATE_MS = 5 * 60000;

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
async function getJSON(u) { try { const r = await fetch(u, { headers: { "cache-control": "no-cache" } }); if (!r.ok) return null; return await r.json(); } catch (_) { return null; } }

// ---------- week / scoring logic (ported from the app) ----------
const _fmtUAE = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Dubai", year: "numeric", month: "2-digit", day: "2-digit" });
function fixedYMD(d) { const p = {}; for (const x of _fmtUAE.formatToParts(d)) p[x.type] = x.value; return p.year + p.month + p.day; }
function uaeDateUTC(d) { const k = fixedYMD(d); return new Date(Date.UTC(+k.slice(0, 4), +k.slice(4, 6) - 1, +k.slice(6, 8))); }
function weekStartKey(d) { const t = uaeDateUTC(d); t.setUTCDate(t.getUTCDate() - ((t.getUTCDay() + 6) % 7)); return t.toISOString().slice(0, 10).replace(/-/g, ""); }
function weekKeyAddDays(key, n) { const t = new Date(Date.UTC(+key.slice(0, 4), +key.slice(4, 6) - 1, +key.slice(6, 8))); t.setUTCDate(t.getUTCDate() + n); return t.toISOString().slice(0, 10).replace(/-/g, ""); }
const GROUP_TYPE = 13802;
const FINAL_AFTER = "2026-07-19T10:00:00Z";
const isKO = e => !!(e && e.season && e.season.type && e.season.type !== GROUP_TYPE);
const isFinal = e => isKO(e) && new Date(e.date) >= new Date(FINAL_AFTER);
const PH = /\b(group|place|winner|runner|loser|tbd|1st|2nd|3rd|third|to be|qualif|seed)\b/i;
const hasPred = p => !!(p && (p.h !== undefined || p.pens));
function koMatchConfirmed(e) {
  if (!isKO(e)) return false;
  const c = e.competitions && e.competitions[0]; if (!c) return false;
  const names = (c.competitors || []).map(x => x.team && x.team.displayName).filter(Boolean);
  return names.length === 2 && names.every(nm => !PH.test(nm));
}
function HA(e) { const c = e.competitions && e.competitions[0]; if (!c) return {}; return { H: (c.competitors || []).find(x => x.homeAway === "home"), A: (c.competitors || []).find(x => x.homeAway === "away") }; }
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
  goal: {
    tag: d => "m-" + d.matchId, renotify: true,
    en: { t: "⚽ GOAL!", b: "{home} {hs}-{as} {away} · {scorer} {min}'" },
    ar: { t: "⚽ جوووون!", b: "{home} {hs}-{as} {away} · {scorer} ف الدقيقة {min}" },
    url: d => goURL("match", d.matchId),
    acts: [{ id: "open_match", en: "View match", ar: "عرض المباراة", url: d => goURL("match", d.matchId) },
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
      final_score:     { home: "Egypt", hs: 2, as: 1, away: "Spain", note: "", matchId: "preview1" },
      knockout_open:   { home: "Brazil", away: "Argentina", matchId: "preview3" },
      nation_qualified:{ nation: "Egypt", stage: "the Round of 16", matchId: "preview2" },
      week_open:       { weekId: "preview" },
      weekly_champion: { champion: "AhmedElayoty", points: 14, weekId: "preview" }
    };
    const order = (ONLY || ["chat", "predict_reminder", "match_30min", "match_5min", "match_live", "lineups", "goal", "final_score", "knockout_open", "nation_qualified", "week_open", "weekly_champion"]);
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

  for (const e of events) {
    try {
      const st = (e.status && e.status.type && e.status.type.state) || "";
      const { H, A } = HA(e); if (!H || !A || !H.team || !A.team) continue;
      const kickoff = Date.parse(e.date); if (!isFinite(kickoff)) continue;
      const home = H.team.displayName, away = A.team.displayName, mins = (kickoff - now) / 60000;
      const real = ![home, away].some(n => PH.test(n));
      let summary = null;
      const getSummary = async () => summary || (summary = await getJSON(ESPN + "/summary?event=" + e.id));

      if (koMatchConfirmed(e) && st === "pre") fire("kc-" + e.id, "knockout_open", { home, away, matchId: e.id }, subs);

      if (st === "pre" && real) {
        if (mins > 25 && mins <= 35) fire("ko30-" + e.id, "match_30min", { home, away, koTime: koTimeUAE(e), matchId: e.id }, subs);
        if (mins > 0 && mins <= 7)  fire("ko5-" + e.id, "match_5min", { home, away, matchId: e.id }, subs);
        if (mins <= 240 && mins > 30) {
          subs.forEach(s => {
            const uid = s && s.uid; if (!uid) return;
            const up = preds[uid] && preds[uid].preds; if (up && hasPred(up[e.id])) return;
            fire("predr-" + e.id + "-" + uid, "predict_reminder", { home, away, koTime: koTimeUAE(e), matchId: e.id }, [s]);
          });
        }
        if (mins * 60000 > LINEUP_TOO_LATE_MS && mins <= 90 && !sentIds.has("lu-" + e.id)) {
          const sum = await getSummary();
          const rosters = (sum && sum.rosters) || [];
          if (rosters.length >= 2 && rosters.every(validLineupRoster)) fire("lu-" + e.id, "lineups", { home, away, matchId: e.id }, subs);
        }
      }

      if (st === "in" && real) {
        if (now - kickoff >= 0 && now - kickoff <= LIVE_STALE_MS) fire("live-" + e.id, "match_live", { home, away, matchId: e.id }, subs);
        else if (now - kickoff > LIVE_STALE_MS && !sentIds.has("live-" + e.id)) { sentIds.add("live-" + e.id); sent.push({ id: "live-" + e.id, ts: now, skip: "stale_live" }); }
      }

      if ((st === "in" || (st === "post" && (now - kickoff) < 4 * 3600000)) && real) {
        const sum = await getSummary();
        for (const g of ((sum && sum.keyEvents) || [])) {
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
      }

      if (st === "post" && (now - kickoff) < 6 * 3600000) {   // only matches that kicked off within the last 6h (stops backfilling old results)
        const desc = (e.status.type.description || "") + " " + (e.status.type.detail || "");
        const so = (H.shootoutScore != null && A.shootoutScore != null && (+H.shootoutScore !== 0 || +A.shootoutScore !== 0));
        const noteVal = so ? "pens" : /extra/i.test(desc) ? "aet" : "none";
        fire("ft-" + e.id, "final_score", { home, away, hs: (H.score != null ? H.score : "-"), as: (A.score != null ? A.score : "-"), noteVal, matchId: e.id }, subs);
        if (isKO(e)) {
          const win = [H, A].find(x => x.winner) || (so ? (+H.shootoutScore > +A.shootoutScore ? H : A) : null);
          if (win && win.team) {
            const wn = win.team.displayName, tid = win.team.id || wn;
            fire("adv-" + e.id + "-" + tid, "nation_qualified", { nation: wn, stage: nextStageName(), matchId: e.id }, subs.filter(s => (s.nat || "") === wn));
          }
        }
      }
    } catch (_) {}
  }

  // GROUP qualification (conservative: ESPN "Advance to Round of 32")
  const standings = await getJSON(ESPN + "/standings?season=2026");
  for (const g of ((standings && standings.children) || [])) {
    for (const ent of (((g.standings || {}).entries) || [])) {
      if (/advance to round of 32/i.test((ent.note && ent.note.description) || "")) {
        const nm = ent.team && ent.team.displayName; if (!nm) continue;
        fire("q-r32-" + nm, "nation_qualified", { nation: nm, stage: "the Round of 32", matchId: "" }, subs.filter(s => (s.nat || "") === nm));
      }
    }
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
  const MILE = /^(kc-|q-r32-|adv-|qual-|champ-|weekopen-|bc-)/;
  const live = sent.filter(s => s && (MILE.test(s.id) ? (now - s.ts) < 40 * 86400000 : (now - s.ts) < 3 * 86400000));
  sent = live.filter(s => MILE.test(s.id)).concat(live.filter(s => !MILE.test(s.id)).slice(-400));
  try { await writeKey(K.sent, sent); } catch (_) {}
  const keepSent = new Set(sent.map(s => s.id)); const pend2 = {}; for (const k in pending) if (!keepSent.has(k) && (now - pending[k]) < 6 * 3600000) pend2[k] = pending[k];
  try { await writeKey(K.pending, pend2); } catch (_) {}
  await ping();
}
async function ping() { const u = process.env.HEALTHCHECK_URL_PUSH; if (!u) return; try { await fetch(u); } catch (_) {} }
main().catch(e => { console.error("ERROR:", e && e.message); process.exit(1); });
