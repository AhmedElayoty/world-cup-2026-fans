// Pull the FIFA live Men's World Ranking and publish {countryCode: rank} to the app's data store.
// Runs on GitHub Actions (see .github/workflows/fifa-rank.yml). PC-independent.
// No secrets: the textdb key is public-by-design (the SAME key ships in the app's client-side JS).
// Self-verifying: requires textdb's stored-ACK (status:1) AND reads the value back; exits non-zero
// on any failure so a bad run shows red in the Actions tab. Never writes a partial/suspect ranking.
const API   = "https://api.fifa.com/api/v3/fifarankings/rankings/live?gender=1&sportType=football&language=en";
const KEY   = "capriole_wc26_fifarank";
const READ  = "https://textdb.online/" + KEY;
const WRITE = "https://api.textdb.online/update/";
const HEALTHCHECK = process.env.HEALTHCHECK_URL || "";   // optional dead-man's-switch; pinged on success when set
// 48 World Cup teams (ESPN abbreviation === FIFA IdCountry) — for a coverage report.
const WC = ["ARG","FRA","ESP","ENG","BRA","MAR","POR","NED","GER","BEL","COL","MEX","CRO","USA","SEN","JPN","URU","SUI","AUT","KOR","AUS","IRN","TUR","NOR","ECU","EGY","CIV","ALG","CAN","SWE","SCO","PAN","PAR","COD","CZE","QAT","TUN","UZB","KSA","IRQ","RSA","BIH","CPV","GHA","JOR","NZL","CUW","HAI"];
// stable top nations: present + unchanged in the read-back proves a full, current ranking persisted.
const ANCHORS = ["ARG", "EGY", "USA", "BRA"];

class FailError extends Error {}
const fail  = (m) => { throw new FailError(m); };
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// fetch with a hard per-attempt timeout + bounded retry; throws on non-2xx or exhausted retries.
async function fetchTO(url, opts = {}, { tries = 3, ms = 20000 } = {}) {
  let last;
  for (let i = 1; i <= tries; i++) {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), ms);
    try {
      const r = await fetch(url, { ...opts, signal: ctl.signal });
      clearTimeout(timer);
      if (!r.ok) throw new Error("HTTP " + r.status);
      return r;
    } catch (e) {
      clearTimeout(timer);
      last = e;
      let host = url; try { host = new URL(url).host; } catch (_) {}
      console.log(`  attempt ${i}/${tries} for ${host} failed: ${e.message}`);
      if (i < tries) await sleep(2000 * i);
    }
  }
  throw last;
}

(async () => {
  // 1) pull the live ranking
  let j;
  try { j = await (await fetchTO(API, { headers: { accept: "application/json" } })).json(); }
  catch (e) { fail("FIFA API unreachable after retries: " + e.message); }
  const results = (j && j.Results) || [];
  if (results.length < 100) fail(`only ${results.length} teams returned (expected ~210); refusing to write a partial ranking`);

  // 2) build { code: rank } — tolerate a string-typed rank, drop anything non-positive-integer
  const map = {};
  for (const t of results) {
    const rk = Number(t && t.Rank);
    if (t && t.IdCountry && Number.isInteger(rk) && rk > 0) map[t.IdCountry] = rk;
  }
  const n = Object.keys(map).length;
  if (n < 100) fail(`parsed only ${n} usable codes; refusing to write`);

  // 3) sanity gates BEFORE writing, so a suspect feed can't overwrite the last good value
  const missingAnchor = ANCHORS.filter(c => !Number.isInteger(map[c]));
  if (missingAnchor.length) fail(`stable anchor team(s) missing from the feed (${missingAnchor.join(",")}); refusing to write a suspect ranking`);
  const missing = WC.filter(c => !(c in map));
  if (missing.length) console.log(`::warning::WC coverage dropped to ${WC.length - missing.length}/${WC.length} · missing ${missing.join(",")} (possible FIFA code drift)`);

  // 4) write, and require textdb's stored-ACK (status:1) — not just an HTTP 200 from a proxy
  const value = JSON.stringify(map);
  let ack;
  try {
    const wr = await fetchTO(WRITE, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: "key=" + encodeURIComponent(KEY) + "&value=" + encodeURIComponent(value) });
    ack = await wr.json();
  } catch (e) { fail("textdb write failed: " + e.message); }
  if (!ack || ack.status !== 1) fail("textdb did not acknowledge the write (status=" + (ack && ack.status) + ")");

  // 5) read back and confirm a full, current ranking is live (one retry for write-consistency lag)
  let ok = false, lastErr = "no attempt";
  for (let i = 0; i < 2 && !ok; i++) {
    await sleep(i === 0 ? 1500 : 3000);
    try {
      const back = JSON.parse(await (await fetchTO(READ + "?cb=" + Date.now() + "_" + i, {}, { tries: 2, ms: 15000 })).text());
      ok = back && Object.keys(back).length >= 100 && ANCHORS.every(c => back[c] === map[c]);
      lastErr = ok ? "" : "value present but anchors did not match this run's data";
    } catch (e) { lastErr = e.message; }
  }
  if (!ok) fail("read-back verification failed (" + lastErr + ")");

  // 6) success
  console.log(`::notice::FIFA ranks updated · ${n} teams written + verified · WC coverage ${WC.length - missing.length}/${WC.length}`);
  console.log(`spot-check: ARG=${map.ARG} EGY=${map.EGY} USA=${map.USA} MEX=${map.MEX} NZL=${map.NZL} HAI=${map.HAI}`);
  if (HEALTHCHECK) {
    try { await fetchTO(HEALTHCHECK, {}, { tries: 2, ms: 10000 }); console.log("  pinged liveness monitor"); }
    catch (e) { console.log("  liveness ping failed (non-fatal): " + e.message); }
  }
})().catch(e => {
  const msg = e instanceof FailError ? e.message : ("unexpected error: " + (e && e.message));
  console.log(`::error::FIFA rank update: ${msg}`);
  process.exitCode = 1;   // let stdout flush naturally instead of a hard process.exit()
});
