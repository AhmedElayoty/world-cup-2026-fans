// Pull the FIFA live Men's World Ranking and publish {countryCode: rank} to the app's data store.
// Runs on GitHub Actions 3x/day (see .github/workflows/fifa-rank.yml). PC-independent.
// No secrets: the textdb key is public-by-design (the SAME key ships in the app's client-side JS).
// Self-verifying: writes, then reads back and confirms it persisted; exits non-zero on any failure
// so a bad run shows red in the Actions tab. Never writes a partial/empty ranking.
const API   = "https://api.fifa.com/api/v3/fifarankings/rankings/live?gender=1&sportType=football&language=en";
const KEY   = "capriole_wc26_fifarank";
const READ  = "https://textdb.online/" + KEY;
const WRITE = "https://api.textdb.online/update/";
// 48 World Cup teams (ESPN abbreviation === FIFA IdCountry) — for a coverage report only.
const WC = ["ARG","FRA","ESP","ENG","BRA","MAR","POR","NED","GER","BEL","COL","MEX","CRO","USA","SEN","JPN","URU","SUI","AUT","KOR","AUS","IRN","TUR","NOR","ECU","EGY","CIV","ALG","CAN","SWE","SCO","PAN","PAR","COD","CZE","QAT","TUN","UZB","KSA","IRQ","RSA","BIH","CPV","GHA","JOR","NZL","CUW","HAI"];

const fail  = (m) => { console.log(`::error::FIFA rank update: ${m}`); process.exit(1); };
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function fetchTO(url, opts = {}, tries = 3) {
  let last;
  for (let i = 1; i <= tries; i++) {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 20000);
    try {
      const r = await fetch(url, { ...opts, signal: ctl.signal });
      clearTimeout(timer);
      if (!r.ok) throw new Error("HTTP " + r.status);
      return r;
    } catch (e) {
      clearTimeout(timer);
      last = e;
      console.log(`  attempt ${i}/${tries} failed: ${e.message}`);
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

  // 2) build { code: rank }
  const map = {};
  for (const t of results) { if (t && t.IdCountry && Number.isInteger(t.Rank)) map[t.IdCountry] = t.Rank; }
  const n = Object.keys(map).length;
  if (n < 100) fail(`parsed only ${n} usable codes; refusing to write`);
  const missing = WC.filter(c => !(c in map));

  // 3) write to the data store
  const value = JSON.stringify(map);
  let wr;
  try {
    wr = await fetch(WRITE, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: "key=" + encodeURIComponent(KEY) + "&value=" + encodeURIComponent(value) });
  } catch (e) { fail("textdb write threw: " + e.message); }
  if (!wr.ok) fail("textdb write HTTP " + wr.status);

  // 4) read back and confirm it persisted (one retry for write-consistency lag)
  const anchors = ["ARG", "EGY", "USA", "BRA"];
  let ok = false;
  for (let i = 0; i < 2 && !ok; i++) {
    await sleep(i === 0 ? 1500 : 3000);
    try {
      const back = JSON.parse(await (await fetch(READ + "?cb=" + Date.now() + i)).text());
      ok = back && Object.keys(back).length >= 100 && anchors.every(c => back[c] === map[c]);
    } catch (_) { ok = false; }
  }
  if (!ok) fail("read-back verification failed (the data store did not persist the new ranking)");

  console.log(`::notice::FIFA ranks updated · ${n} teams written + verified · WC coverage ${WC.length - missing.length}/${WC.length}${missing.length ? " · MISSING " + missing.join(",") : ""}`);
  console.log(`spot-check: ARG=${map.ARG} EGY=${map.EGY} USA=${map.USA} MEX=${map.MEX} NZL=${map.NZL} HAI=${map.HAI}`);
})().catch(e => fail("unexpected error: " + (e && e.message)));
