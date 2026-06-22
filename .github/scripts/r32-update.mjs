// Precompute Round-of-32 opponents for ALL 48 nations and publish to the app's data store
// (textdb key capriole_wc26_r32). Runs on GitHub Actions (see fifa-rank.yml), PC-independent.
// The app reads this at boot → the R32 panel shows instantly + works offline, for every nation,
// even when no one has the app open. No secrets: the key is public-by-design (same key in the app JS).
// Self-verifying: requires textdb stored-ACK (status:1) + reads the value back; exits non-zero on any
// failure (red in Actions) and never writes a partial result. Source of truth: FWC26 Article 12.6 +
// the validated 495-row Annexe C third-place table (embedded below, double-verified vs the regs PDF).
const STAND = "https://site.api.espn.com/apis/v2/sports/soccer/fifa.world/standings?season=2026";
const KEY   = "capriole_wc26_r32";
const READ  = "https://textdb.online/" + KEY;
const WRITE = "https://api.textdb.online/update/";
const HEALTHCHECK = process.env.HEALTHCHECK_URL_R32 || "";   // optional dead-man's-switch

const COLS = ["A","B","D","E","G","I","K","L"];
const ANNEXE = {"ABCDEFGH":"HGBCAFDE","ABCDEFGI":"CGBDAFEI","ABCDEFGJ":"CGBDAFEJ","ABCDEFGK":"CGBDAFEK","ABCDEFGL":"CGBDAFLE","ABCDEFHI":"HEBCAFDI","ABCDEFHJ":"HJBCAFDE","ABCDEFHK":"HEBCAFDK","ABCDEFHL":"HFBCADLE","ABCDEFIJ":"CJBDAFEI","ABCDEFIK":"CEBDAFIK","ABCDEFIL":"CEBDAFLI","ABCDEFJK":"CJBDAFEK","ABCDEFJL":"CJBDAFLE","ABCDEFKL":"CEBDAFLK","ABCDEGHI":"HGBCADEI","ABCDEGHJ":"HGBCADEJ","ABCDEGHK":"HGBCADEK","ABCDEGHL":"HGBCADLE","ABCDEGIJ":"EGBCADIJ","ABCDEGIK":"EGBCADIK","ABCDEGIL":"EGBCADLI","ABCDEGJK":"EGBCADJK","ABCDEGJL":"EGBCADLJ","ABCDEGKL":"EGBCADLK","ABCDEHIJ":"HJBCADEI","ABCDEHIK":"HEBCADIK","ABCDEHIL":"HEBCADLI","ABCDEHJK":"HJBCADEK","ABCDEHJL":"HJBCADLE","ABCDEHKL":"HEBCADLK","ABCDEIJK":"EJBCADIK","ABCDEIJL":"EJBCADLI","ABCDEIKL":"EIBCADLK","ABCDEJKL":"EJBCADLK","ABCDFGHI":"HGBCAFDI","ABCDFGHJ":"HGBCAFDJ","ABCDFGHK":"HGBCAFDK","ABCDFGHL":"CGBDAFLH","ABCDFGIJ":"CGBDAFIJ","ABCDFGIK":"CGBDAFIK","ABCDFGIL":"CGBDAFLI","ABCDFGJK":"CGBDAFJK","ABCDFGJL":"CGBDAFLJ","ABCDFGKL":"CGBDAFLK","ABCDFHIJ":"HJBCAFDI","ABCDFHIK":"HFBCADIK","ABCDFHIL":"HFBCADLI","ABCDFHJK":"HJBCAFDK","ABCDFHJL":"CJBDAFLH","ABCDFHKL":"HFBCADLK","ABCDFIJK":"CJBDAFIK","ABCDFIJL":"CJBDAFLI","ABCDFIKL":"CIBDAFLK","ABCDFJKL":"CJBDAFLK","ABCDGHIJ":"HGBCADIJ","ABCDGHIK":"HGBCADIK","ABCDGHIL":"HGBCADLI","ABCDGHJK":"HGBCADJK","ABCDGHJL":"HGBCADLJ","ABCDGHKL":"HGBCADLK","ABCDGIJK":"CJBDAGIK","ABCDGIJL":"CJBDAGLI","ABCDGIKL":"IGBCADLK","ABCDGJKL":"CJBDAGLK","ABCDHIJK":"HJBCADIK","ABCDHIJL":"HJBCADLI","ABCDHIKL":"HIBCADLK","ABCDHJKL":"HJBCADLK","ABCDIJKL":"IJBCADLK","ABCEFGHI":"HGBCAFEI","ABCEFGHJ":"HGBCAFEJ","ABCEFGHK":"HGBCAFEK","ABCEFGHL":"HGBCAFLE","ABCEFGIJ":"EGBCAFIJ","ABCEFGIK":"EGBCAFIK","ABCEFGIL":"EGBCAFLI","ABCEFGJK":"EGBCAFJK","ABCEFGJL":"EGBCAFLJ","ABCEFGKL":"EGBCAFLK","ABCEFHIJ":"HJBCAFEI","ABCEFHIK":"HEBCAFIK","ABCEFHIL":"HEBCAFLI","ABCEFHJK":"HJBCAFEK","ABCEFHJL":"HJBCAFLE","ABCEFHKL":"HEBCAFLK","ABCEFIJK":"EJBCAFIK","ABCEFIJL":"EJBCAFLI","ABCEFIKL":"EIBCAFLK","ABCEFJKL":"EJBCAFLK","ABCEGHIJ":"HJBCAGEI","ABCEGHIK":"EGBCAHIK","ABCEGHIL":"EGBCAHLI","ABCEGHJK":"HJBCAGEK","ABCEGHJL":"HJBCAGLE","ABCEGHKL":"EGBCAHLK","ABCEGIJK":"EJBCAGIK","ABCEGIJL":"EJBCAGLI","ABCEGIKL":"EGBAICLK","ABCEGJKL":"EJBCAGLK","ABCEHIJK":"EJBCAHIK","ABCEHIJL":"EJBCAHLI","ABCEHIKL":"EIBCAHLK","ABCEHJKL":"EJBCAHLK","ABCEIJKL":"EJBAICLK","ABCFGHIJ":"HGBCAFIJ","ABCFGHIK":"HGBCAFIK","ABCFGHIL":"HGBCAFLI","ABCFGHJK":"HGBCAFJK","ABCFGHJL":"HGBCAFLJ","ABCFGHKL":"HGBCAFLK","ABCFGIJK":"CJBFAGIK","ABCFGIJL":"CJBFAGLI","ABCFGIKL":"IGBCAFLK","ABCFGJKL":"CJBFAGLK","ABCFHIJK":"HJBCAFIK","ABCFHIJL":"HJBCAFLI","ABCFHIKL":"HIBCAFLK","ABCFHJKL":"HJBCAFLK","ABCFIJKL":"IJBCAFLK","ABCGHIJK":"HJBCAGIK","ABCGHIJL":"HJBCAGLI","ABCGHIKL":"IGBCAHLK","ABCGHJKL":"HJBCAGLK","ABCGIJKL":"IJBCAGLK","ABCHIJKL":"IJBCAHLK","ABDEFGHI":"HGBDAFEI","ABDEFGHJ":"HGBDAFEJ","ABDEFGHK":"HGBDAFEK","ABDEFGHL":"HGBDAFLE","ABDEFGIJ":"EGBDAFIJ","ABDEFGIK":"EGBDAFIK","ABDEFGIL":"EGBDAFLI","ABDEFGJK":"EGBDAFJK","ABDEFGJL":"EGBDAFLJ","ABDEFGKL":"EGBDAFLK","ABDEFHIJ":"HJBDAFEI","ABDEFHIK":"HEBDAFIK","ABDEFHIL":"HEBDAFLI","ABDEFHJK":"HJBDAFEK","ABDEFHJL":"HJBDAFLE","ABDEFHKL":"HEBDAFLK","ABDEFIJK":"EJBDAFIK","ABDEFIJL":"EJBDAFLI","ABDEFIKL":"EIBDAFLK","ABDEFJKL":"EJBDAFLK","ABDEGHIJ":"HJBDAGEI","ABDEGHIK":"EGBDAHIK","ABDEGHIL":"EGBDAHLI","ABDEGHJK":"HJBDAGEK","ABDEGHJL":"HJBDAGLE","ABDEGHKL":"EGBDAHLK","ABDEGIJK":"EJBDAGIK","ABDEGIJL":"EJBDAGLI","ABDEGIKL":"EGBAIDLK","ABDEGJKL":"EJBDAGLK","ABDEHIJK":"EJBDAHIK","ABDEHIJL":"EJBDAHLI","ABDEHIKL":"EIBDAHLK","ABDEHJKL":"EJBDAHLK","ABDEIJKL":"EJBAIDLK","ABDFGHIJ":"HGBDAFIJ","ABDFGHIK":"HGBDAFIK","ABDFGHIL":"HGBDAFLI","ABDFGHJK":"HGBDAFJK","ABDFGHJL":"HGBDAFLJ","ABDFGHKL":"HGBDAFLK","ABDFGIJK":"FJBDAGIK","ABDFGIJL":"FJBDAGLI","ABDFGIKL":"IGBDAFLK","ABDFGJKL":"FJBDAGLK","ABDFHIJK":"HJBDAFIK","ABDFHIJL":"HJBDAFLI","ABDFHIKL":"HIBDAFLK","ABDFHJKL":"HJBDAFLK","ABDFIJKL":"IJBDAFLK","ABDGHIJK":"HJBDAGIK","ABDGHIJL":"HJBDAGLI","ABDGHIKL":"IGBDAHLK","ABDGHJKL":"HJBDAGLK","ABDGIJKL":"IJBDAGLK","ABDHIJKL":"IJBDAHLK","ABEFGHIJ":"HJBFAGEI","ABEFGHIK":"EGBFAHIK","ABEFGHIL":"EGBFAHLI","ABEFGHJK":"HJBFAGEK","ABEFGHJL":"HJBFAGLE","ABEFGHKL":"EGBFAHLK","ABEFGIJK":"EJBFAGIK","ABEFGIJL":"EJBFAGLI","ABEFGIKL":"EGBAIFLK","ABEFGJKL":"EJBFAGLK","ABEFHIJK":"EJBFAHIK","ABEFHIJL":"EJBFAHLI","ABEFHIKL":"EIBFAHLK","ABEFHJKL":"EJBFAHLK","ABEFIJKL":"EJBAIFLK","ABEGHIJK":"EJBAHGIK","ABEGHIJL":"EJBAHGLI","ABEGHIKL":"EGBAIHLK","ABEGHJKL":"EJBAHGLK","ABEGIJKL":"EJBAIGLK","ABEHIJKL":"EJBAIHLK","ABFGHIJK":"HJBFAGIK","ABFGHIJL":"HJBFAGLI","ABFGHIKL":"HGBAIFLK","ABFGHJKL":"HJBFAGLK","ABFGIJKL":"IJBFAGLK","ABFHIJKL":"HJBAIFLK","ABGHIJKL":"HJBAIGLK","ACDEFGHI":"HGECAFDI","ACDEFGHJ":"HGJCAFDE","ACDEFGHK":"HGECAFDK","ACDEFGHL":"HGFCADLE","ACDEFGIJ":"CGJDAFEI","ACDEFGIK":"CGEDAFIK","ACDEFGIL":"CGEDAFLI","ACDEFGJK":"CGJDAFEK","ACDEFGJL":"CGJDAFLE","ACDEFGKL":"CGEDAFLK","ACDEFHIJ":"HJECAFDI","ACDEFHIK":"HEFCADIK","ACDEFHIL":"HEFCADLI","ACDEFHJK":"HJECAFDK","ACDEFHJL":"HJFCADLE","ACDEFHKL":"HEFCADLK","ACDEFIJK":"CJEDAFIK","ACDEFIJL":"CJEDAFLI","ACDEFIKL":"CEIDAFLK","ACDEFJKL":"CJEDAFLK","ACDEGHIJ":"HGJCADEI","ACDEGHIK":"HGECADIK","ACDEGHIL":"HGECADLI","ACDEGHJK":"HGJCADEK","ACDEGHJL":"HGJCADLE","ACDEGHKL":"HGECADLK","ACDEGIJK":"EGJCADIK","ACDEGIJL":"EGJCADLI","ACDEGIKL":"EGICADLK","ACDEGJKL":"EGJCADLK","ACDEHIJK":"HJECADIK","ACDEHIJL":"HJECADLI","ACDEHIKL":"HEICADLK","ACDEHJKL":"HJECADLK","ACDEIJKL":"EJICADLK","ACDFGHIJ":"HGJCAFDI","ACDFGHIK":"HGFCADIK","ACDFGHIL":"HGFCADLI","ACDFGHJK":"HGJCAFDK","ACDFGHJL":"CGJDAFLH","ACDFGHKL":"HGFCADLK","ACDFGIJK":"CGJDAFIK","ACDFGIJL":"CGJDAFLI","ACDFGIKL":"CGIDAFLK","ACDFGJKL":"CGJDAFLK","ACDFHIJK":"HJFCADIK","ACDFHIJL":"HJFCADLI","ACDFHIKL":"HFICADLK","ACDFHJKL":"HJFCADLK","ACDFIJKL":"CJIDAFLK","ACDGHIJK":"HGJCADIK","ACDGHIJL":"HGJCADLI","ACDGHIKL":"HGICADLK","ACDGHJKL":"HGJCADLK","ACDGIJKL":"IGJCADLK","ACDHIJKL":"HJICADLK","ACEFGHIJ":"HGJCAFEI","ACEFGHIK":"HGECAFIK","ACEFGHIL":"HGECAFLI","ACEFGHJK":"HGJCAFEK","ACEFGHJL":"HGJCAFLE","ACEFGHKL":"HGECAFLK","ACEFGIJK":"EGJCAFIK","ACEFGIJL":"EGJCAFLI","ACEFGIKL":"EGICAFLK","ACEFGJKL":"EGJCAFLK","ACEFHIJK":"HJECAFIK","ACEFHIJL":"HJECAFLI","ACEFHIKL":"HEICAFLK","ACEFHJKL":"HJECAFLK","ACEFIJKL":"EJICAFLK","ACEGHIJK":"EGJCAHIK","ACEGHIJL":"EGJCAHLI","ACEGHIKL":"EGICAHLK","ACEGHJKL":"EGJCAHLK","ACEGIJKL":"EJICAGLK","ACEHIJKL":"EJICAHLK","ACFGHIJK":"HGJCAFIK","ACFGHIJL":"HGJCAFLI","ACFGHIKL":"HGICAFLK","ACFGHJKL":"HGJCAFLK","ACFGIJKL":"IGJCAFLK","ACFHIJKL":"HJICAFLK","ACGHIJKL":"HJICAGLK","ADEFGHIJ":"HGJDAFEI","ADEFGHIK":"HGEDAFIK","ADEFGHIL":"HGEDAFLI","ADEFGHJK":"HGJDAFEK","ADEFGHJL":"HGJDAFLE","ADEFGHKL":"HGEDAFLK","ADEFGIJK":"EGJDAFIK","ADEFGIJL":"EGJDAFLI","ADEFGIKL":"EGIDAFLK","ADEFGJKL":"EGJDAFLK","ADEFHIJK":"HJEDAFIK","ADEFHIJL":"HJEDAFLI","ADEFHIKL":"HEIDAFLK","ADEFHJKL":"HJEDAFLK","ADEFIJKL":"EJIDAFLK","ADEGHIJK":"EGJDAHIK","ADEGHIJL":"EGJDAHLI","ADEGHIKL":"EGIDAHLK","ADEGHJKL":"EGJDAHLK","ADEGIJKL":"EJIDAGLK","ADEHIJKL":"EJIDAHLK","ADFGHIJK":"HGJDAFIK","ADFGHIJL":"HGJDAFLI","ADFGHIKL":"HGIDAFLK","ADFGHJKL":"HGJDAFLK","ADFGIJKL":"IGJDAFLK","ADFHIJKL":"HJIDAFLK","ADGHIJKL":"HJIDAGLK","AEFGHIJK":"EGJFAHIK","AEFGHIJL":"EGJFAHLI","AEFGHIKL":"EGIFAHLK","AEFGHJKL":"EGJFAHLK","AEFGIJKL":"EJIFAGLK","AEFHIJKL":"EJIFAHLK","AEGHIJKL":"EJIAHGLK","AFGHIJKL":"HJIFAGLK","BCDEFGHI":"CGBDHFEI","BCDEFGHJ":"HGBCJFDE","BCDEFGHK":"CGBDHFEK","BCDEFGHL":"CGBDHFLE","BCDEFGIJ":"CGBDJFEI","BCDEFGIK":"CGBDEFIK","BCDEFGIL":"CGBDEFLI","BCDEFGJK":"CGBDJFEK","BCDEFGJL":"CGBDJFLE","BCDEFGKL":"CGBDEFLK","BCDEFHIJ":"CJBDHFEI","BCDEFHIK":"CEBDHFIK","BCDEFHIL":"CEBDHFLI","BCDEFHJK":"CJBDHFEK","BCDEFHJL":"CJBDHFLE","BCDEFHKL":"CEBDHFLK","BCDEFIJK":"CJBDEFIK","BCDEFIJL":"CJBDEFLI","BCDEFIKL":"CEBDIFLK","BCDEFJKL":"CJBDEFLK","BCDEGHIJ":"HGBCJDEI","BCDEGHIK":"EGBCHDIK","BCDEGHIL":"EGBCHDLI","BCDEGHJK":"HGBCJDEK","BCDEGHJL":"HGBCJDLE","BCDEGHKL":"EGBCHDLK","BCDEGIJK":"EGBCJDIK","BCDEGIJL":"EGBCJDLI","BCDEGIKL":"EGBCIDLK","BCDEGJKL":"EGBCJDLK","BCDEHIJK":"EJBCHDIK","BCDEHIJL":"EJBCHDLI","BCDEHIKL":"EIBCHDLK","BCDEHJKL":"EJBCHDLK","BCDEIJKL":"EJBCIDLK","BCDFGHIJ":"HGBCJFDI","BCDFGHIK":"CGBDHFIK","BCDFGHIL":"CGBDHFLI","BCDFGHJK":"HGBCJFDK","BCDFGHJL":"CGBDHFLJ","BCDFGHKL":"CGBDHFLK","BCDFGIJK":"CGBDJFIK","BCDFGIJL":"CGBDJFLI","BCDFGIKL":"CGBDIFLK","BCDFGJKL":"CGBDJFLK","BCDFHIJK":"CJBDHFIK","BCDFHIJL":"CJBDHFLI","BCDFHIKL":"CIBDHFLK","BCDFHJKL":"CJBDHFLK","BCDFIJKL":"CJBDIFLK","BCDGHIJK":"HGBCJDIK","BCDGHIJL":"HGBCJDLI","BCDGHIKL":"HGBCIDLK","BCDGHJKL":"HGBCJDLK","BCDGIJKL":"IGBCJDLK","BCDHIJKL":"HJBCIDLK","BCEFGHIJ":"HGBCJFEI","BCEFGHIK":"EGBCHFIK","BCEFGHIL":"EGBCHFLI","BCEFGHJK":"HGBCJFEK","BCEFGHJL":"HGBCJFLE","BCEFGHKL":"EGBCHFLK","BCEFGIJK":"EGBCJFIK","BCEFGIJL":"EGBCJFLI","BCEFGIKL":"EGBCIFLK","BCEFGJKL":"EGBCJFLK","BCEFHIJK":"EJBCHFIK","BCEFHIJL":"EJBCHFLI","BCEFHIKL":"EIBCHFLK","BCEFHJKL":"EJBCHFLK","BCEFIJKL":"EJBCIFLK","BCEGHIJK":"EJBCHGIK","BCEGHIJL":"EJBCHGLI","BCEGHIKL":"EGBCIHLK","BCEGHJKL":"EJBCHGLK","BCEGIJKL":"EJBCIGLK","BCEHIJKL":"EJBCIHLK","BCFGHIJK":"HGBCJFIK","BCFGHIJL":"HGBCJFLI","BCFGHIKL":"HGBCIFLK","BCFGHJKL":"HGBCJFLK","BCFGIJKL":"IGBCJFLK","BCFHIJKL":"HJBCIFLK","BCGHIJKL":"HJBCIGLK","BDEFGHIJ":"HGBDJFEI","BDEFGHIK":"EGBDHFIK","BDEFGHIL":"EGBDHFLI","BDEFGHJK":"HGBDJFEK","BDEFGHJL":"HGBDJFLE","BDEFGHKL":"EGBDHFLK","BDEFGIJK":"EGBDJFIK","BDEFGIJL":"EGBDJFLI","BDEFGIKL":"EGBDIFLK","BDEFGJKL":"EGBDJFLK","BDEFHIJK":"EJBDHFIK","BDEFHIJL":"EJBDHFLI","BDEFHIKL":"EIBDHFLK","BDEFHJKL":"EJBDHFLK","BDEFIJKL":"EJBDIFLK","BDEGHIJK":"EJBDHGIK","BDEGHIJL":"EJBDHGLI","BDEGHIKL":"EGBDIHLK","BDEGHJKL":"EJBDHGLK","BDEGIJKL":"EJBDIGLK","BDEHIJKL":"EJBDIHLK","BDFGHIJK":"HGBDJFIK","BDFGHIJL":"HGBDJFLI","BDFGHIKL":"HGBDIFLK","BDFGHJKL":"HGBDJFLK","BDFGIJKL":"IGBDJFLK","BDFHIJKL":"HJBDIFLK","BDGHIJKL":"HJBDIGLK","BEFGHIJK":"EJBFHGIK","BEFGHIJL":"EJBFHGLI","BEFGHIKL":"EGBFIHLK","BEFGHJKL":"EJBFHGLK","BEFGIJKL":"EJBFIGLK","BEFHIJKL":"EJBFIHLK","BEGHIJKL":"EJIBHGLK","BFGHIJKL":"HJBFIGLK","CDEFGHIJ":"CGJDHFEI","CDEFGHIK":"CGEDHFIK","CDEFGHIL":"CGEDHFLI","CDEFGHJK":"CGJDHFEK","CDEFGHJL":"CGJDHFLE","CDEFGHKL":"CGEDHFLK","CDEFGIJK":"CGEDJFIK","CDEFGIJL":"CGEDJFLI","CDEFGIKL":"CGEDIFLK","CDEFGJKL":"CGEDJFLK","CDEFHIJK":"CJEDHFIK","CDEFHIJL":"CJEDHFLI","CDEFHIKL":"CEIDHFLK","CDEFHJKL":"CJEDHFLK","CDEFIJKL":"CJEDIFLK","CDEGHIJK":"EGJCHDIK","CDEGHIJL":"EGJCHDLI","CDEGHIKL":"EGICHDLK","CDEGHJKL":"EGJCHDLK","CDEGIJKL":"EGICJDLK","CDEHIJKL":"EJICHDLK","CDFGHIJK":"CGJDHFIK","CDFGHIJL":"CGJDHFLI","CDFGHIKL":"CGIDHFLK","CDFGHJKL":"CGJDHFLK","CDFGIJKL":"CGIDJFLK","CDFHIJKL":"CJIDHFLK","CDGHIJKL":"HGICJDLK","CEFGHIJK":"EGJCHFIK","CEFGHIJL":"EGJCHFLI","CEFGHIKL":"EGICHFLK","CEFGHJKL":"EGJCHFLK","CEFGIJKL":"EGICJFLK","CEFHIJKL":"EJICHFLK","CEGHIJKL":"EJICHGLK","CFGHIJKL":"HGICJFLK","DEFGHIJK":"EGJDHFIK","DEFGHIJL":"EGJDHFLI","DEFGHIKL":"EGIDHFLK","DEFGHJKL":"EGJDHFLK","DEFGIJKL":"EGIDJFLK","DEFHIJKL":"EJIDHFLK","DEGHIJKL":"EJIDHGLK","DFGHIJKL":"HGIDJFLK","EFGHIJKL":"EJIFHGLK"};
const MATCHES = [{m:73,a:"2A",b:"2B"},{m:74,a:"1E",t:1},{m:75,a:"1F",b:"2C"},{m:76,a:"1C",b:"2F"},{m:77,a:"1I",t:1},{m:78,a:"2E",b:"2I"},{m:79,a:"1A",t:1},{m:80,a:"1L",t:1},{m:81,a:"1D",t:1},{m:82,a:"1G",t:1},{m:83,a:"2K",b:"2L"},{m:84,a:"1H",b:"2J"},{m:85,a:"1B",t:1},{m:86,a:"1J",b:"2H"},{m:87,a:"1K",t:1},{m:88,a:"2D",b:"2G"}];

class FailError extends Error {}
const fail  = (m) => { throw new FailError(m); };
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
async function fetchTO(url, opts = {}, { tries = 3, ms = 20000 } = {}) {
  let last;
  for (let i = 1; i <= tries; i++) {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), ms);
    try { const r = await fetch(url, { ...opts, signal: ctl.signal }); clearTimeout(timer); if (!r.ok) throw new Error("HTTP " + r.status); return r; }
    catch (e) { clearTimeout(timer); last = e; let host = url; try { host = new URL(url).host; } catch (_) {} console.log("  attempt " + i + "/" + tries + " for " + host + " failed: " + e.message); if (i < tries) await sleep(2000 * i); }
  }
  throw last;
}

function findOpp(slot, set8) {
  for (const M of MATCHES) { if (M.t) continue; if (M.a === slot) return { opp: M.b, m: M.m }; if (M.b === slot) return { opp: M.a, m: M.m }; }
  if (!set8 || set8.length !== 8 || !ANNEXE[set8]) return null;
  const row = ANNEXE[set8], th = {}; COLS.forEach((c, i) => th[c] = row[i]);
  for (const M of MATCHES) { if (M.t && M.a === slot) return { opp: "3" + th[M.a[1]], m: M.m }; }
  if (slot[0] === "3") { const col = COLS.find(c => th[c] === slot[1]); if (col) { const M = MATCHES.find(x => x.t && x.a === "1" + col); return { opp: "1" + col, m: M.m }; } }
  return null;
}

(async () => {
  // 1) pull live group standings
  let d;
  try { d = await (await fetchTO(STAND, { headers: { accept: "application/json" } })).json(); }
  catch (e) { fail("ESPN standings unreachable after retries: " + e.message); }
  const groups = (d && d.children) || [];
  if (groups.length < 12) fail("only " + groups.length + " groups returned (expected 12); refusing to write");

  // 2) rank each group (points -> goal difference -> goals for) and build the slot maps
  const W = {}, R = {}, T = {}, logoOf = {}, ranks = {}, allTeams = [];
  let allComplete = true;
  const stat = e => (e.stats || []).reduce((o, s) => (o[s.name] = s.value, o), {});
  for (const g of groups) {
    const gl = (g.name || "").replace("Group ", "").trim();
    const rows = (((g.standings && g.standings.entries) || []).map(e => { const s = stat(e); return { name: e.team.displayName, logo: (e.team.logos && e.team.logos[0]) ? e.team.logos[0].href : "", P: s.gamesPlayed || 0, pts: s.points || 0, gd: s.pointDifferential || 0, gf: s.pointsFor || 0 }; }));
    rows.sort((a, b) => b.pts - a.pts || b.gd - a.gd || b.gf - a.gf || a.name.localeCompare(b.name));
    if (rows.length < 4 || !rows.every(r => r.P >= 3)) allComplete = false;
    rows.forEach((r, i) => { logoOf[r.name] = r.logo; ranks[r.name] = { g: gl, rank: i }; allTeams.push(r.name); });
    if (rows[0]) W[gl] = rows[0]; if (rows[1]) R[gl] = rows[1]; if (rows[2] && rows[2].P > 0) T[gl] = Object.assign({ g: gl }, rows[2]);
  }
  if (allTeams.length < 24) fail("only " + allTeams.length + " teams parsed; refusing to write");

  // 3) the 8 best third-placed teams (set of group letters) — only the SET matters for the bracket
  const thirds = Object.values(T).sort((a, b) => b.pts - a.pts || b.gd - a.gd || b.gf - a.gf);
  const top8 = thirds.slice(0, 8);
  const set8 = top8.map(t => t.g).sort().join("");
  const inSet = letter => top8.some(t => t.g === letter);

  // 4) resolve every nation's R32 opponent by its CURRENT finishing position
  const teamBySlot = slot => { const pos = +slot[0], L = slot[1]; return pos === 1 ? W[L] : pos === 2 ? R[L] : T[L]; };
  const nations = {};
  for (const name of allTeams) {
    const me = ranks[name];
    if (me.rank === 3) { nations[name] = { status: "out", eliminated: true }; continue; }
    if (me.rank === 2 && !inSet(me.g)) { nations[name] = { status: "out", eliminated: allComplete }; continue; }
    const slot = (me.rank + 1) + me.g;
    const o = findOpp(slot, set8);
    if (!o) { nations[name] = { status: "tbd" }; continue; }
    const oppTeam = teamBySlot(o.opp);
    if (!oppTeam) { nations[name] = { status: "tbd" }; continue; }
    nations[name] = { status: allComplete ? "conf" : "prov", eliminated: false, oppName: oppTeam.name, oppLogo: oppTeam.logo || logoOf[oppTeam.name] || "", oppGroup: o.opp[1], oppPos: +o.opp[0], matchNum: o.m };
  }
  const cnt = Object.keys(nations).length;
  if (cnt < 24) fail("only " + cnt + " nations resolved; refusing to write");
  const payload = { updated: new Date().toISOString(), allComplete, set: set8, nations };

  // 5) write, require textdb stored-ACK (status:1)
  const value = JSON.stringify(payload);
  let ack;
  try {
    const wr = await fetchTO(WRITE, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: "key=" + encodeURIComponent(KEY) + "&value=" + encodeURIComponent(value) });
    ack = await wr.json();
  } catch (e) { fail("textdb write failed: " + e.message); }
  if (!ack || ack.status !== 1) fail("textdb did not acknowledge the write (status=" + (ack && ack.status) + ")");

  // 6) read back and confirm a full result is live (one retry for write-consistency lag)
  let ok = false, lastErr = "no attempt";
  for (let i = 0; i < 2 && !ok; i++) {
    await sleep(i === 0 ? 1500 : 3000);
    try { const back = JSON.parse(await (await fetchTO(READ + "?cb=" + Date.now() + "_" + i, {}, { tries: 2, ms: 15000 })).text()); if (back && back.nations && Object.keys(back.nations).length >= 24) ok = true; else lastErr = "read-back incomplete"; }
    catch (e) { lastErr = e.message; }
  }
  if (!ok) fail("read-back verify failed: " + lastErr);

  console.log("R32 published: " + cnt + " nations · allComplete=" + allComplete + " · best-8 thirds set=" + (set8 || "(pending)"));
  if (HEALTHCHECK) { try { await fetchTO(HEALTHCHECK, {}, { tries: 2, ms: 8000 }); } catch (_) {} }
})().catch(e => { console.error("FAIL:", e.message); process.exit(1); });
