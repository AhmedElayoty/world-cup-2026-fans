#!/usr/bin/env node
/*
  push-pin.mjs — mark notification ids as ALREADY-SENT in the shared dedup ledger
  (textdb key capriole_wc26_push_sent) so the live push sender (the Cloudflare Worker
  wc26-push-scheduler, and the push-send.mjs fallback) skips them and STOPS re-firing.

  WHY: a one-time milestone (e.g. "Egypt qualified for the Round of 32", id q-r32-Egypt)
  kept re-sending. The condition is permanently true once groups finish, so the only guard
  is this ledger — and at 1-minute cadence the just-written id can be missed due to textdb
  read-after-write lag, so it re-fires. Pinning the id durably (and letting it settle) means
  every later run reads it and skips. The old ~hourly schedule never hit this; 1-min does.

  IDS: env PIN_IDS (comma-separated) or the defaults below.
  SAFE: merge-only — it never removes or rewrites existing entries, requires textdb's
  stored-ACK (status:1), and reads the value back to confirm every id is present.
  NO SECRETS: textdb is keyless (the same key ships in the client JS).
*/
const KEY   = "capriole_wc26_push_sent";
const READ  = "https://textdb.online/" + KEY;
const WRITE = "https://api.textdb.online/update/";
const DEFAULT_IDS = ["q-r32-Egypt", "egy-r32"];   // nation_qualified (R32) + egypt_celebration (r32)
const ENV_IDS = (process.env.PIN_IDS || "").split(",").map(s => s.trim()).filter(Boolean);
const ids = ENV_IDS.length ? ENV_IDS : DEFAULT_IDS;

const sleep = ms => new Promise(r => setTimeout(r, ms));
async function fetchTO(url, opts = {}, { tries = 3, ms = 20000 } = {}) {
  let last;
  for (let i = 1; i <= tries; i++) {
    const ctl = new AbortController(); const timer = setTimeout(() => ctl.abort(), ms);
    try { const r = await fetch(url, { ...opts, signal: ctl.signal }); clearTimeout(timer); if (!r.ok) throw new Error("HTTP " + r.status); return r; }
    catch (e) { clearTimeout(timer); last = e; console.log("  attempt " + i + "/" + tries + " failed: " + e.message); if (i < tries) await sleep(2000 * i); }
  }
  throw last;
}

(async () => {
  // 1) read the current ledger (array of {id, ts, ...})
  let sent;
  try { sent = JSON.parse(((await (await fetchTO(READ + "?t=" + Date.now(), { headers: { "cache-control": "no-cache" } })).text()).trim()) || "[]"); }
  catch (e) { console.error("FATAL: cannot read ledger: " + e.message); process.exit(1); }
  if (!Array.isArray(sent)) { console.error("FATAL: ledger is not an array (" + typeof sent + "); refusing to overwrite"); process.exit(1); }

  // 2) merge-add the pin ids — never remove or alter anything already there
  const have = new Set(sent.map(s => s && s.id));
  const now = Date.now();
  const added = [];
  for (const id of ids) { if (!have.has(id)) { sent.push({ id, ts: now, pin: 1 }); added.push(id); } }
  console.log("ledger entries: " + sent.length + " · pinning: [" + ids.join(", ") + "] · newly added: " + (added.length ? added.join(", ") : "(all already present)"));
  if (!added.length) { console.log("nothing to add — every id is already in the ledger. The sender should already be skipping them; if it isn't, it is ignoring this ledger key."); return; }

  // 3) write back, require textdb stored-ACK (status:1), not just an HTTP 200
  let ack;
  try {
    const wr = await fetchTO(WRITE, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: "key=" + encodeURIComponent(KEY) + "&value=" + encodeURIComponent(JSON.stringify(sent)) });
    ack = await wr.json();
  } catch (e) { console.error("FATAL: textdb write failed: " + e.message); process.exit(1); }
  if (!ack || ack.status !== 1) { console.error("FATAL: textdb did not acknowledge the write (status=" + (ack && ack.status) + ")"); process.exit(1); }

  // 4) read back and confirm every pinned id is present (retry for write-consistency lag)
  let ok = false, lastErr = "no attempt";
  for (let i = 0; i < 3 && !ok; i++) {
    await sleep(i === 0 ? 1500 : 3000);
    try {
      const back = JSON.parse(((await (await fetchTO(READ + "?cb=" + Date.now() + "_" + i, {}, { tries: 2, ms: 15000 })).text()).trim()) || "[]");
      const hb = new Set((Array.isArray(back) ? back : []).map(s => s && s.id));
      ok = ids.every(id => hb.has(id));
      lastErr = ok ? "" : "read-back still missing some ids";
    } catch (e) { lastErr = e.message; }
  }
  if (!ok) { console.error("FATAL: read-back verify failed: " + lastErr); process.exit(1); }
  console.log("PINNED + verified: [" + ids.join(", ") + "] are now in the dedup ledger. Give textdb a few minutes to fully propagate; the sender will then skip them on every run.");
})().catch(e => { console.error("ERROR: " + (e && e.message)); process.exit(1); });
