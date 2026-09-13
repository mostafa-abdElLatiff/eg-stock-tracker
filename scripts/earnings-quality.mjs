#!/usr/bin/env node
// Two earnings checks the project was missing, both found on 2026-09-11 when
// Mostafa challenged a claim that ORHD's profit was falling.
//
// FAILURE 1 - THE DIVERGENCE TEST ONLY LOOKED AT ONE WINDOW.
// `revenueUpProfitDown` compared a single quarter to the same quarter a year
// earlier. ORHD on that basis: revenue +64.3%, net income +11.0% - passes.
// On a TRAILING TWELVE MONTH basis the same data says revenue +22.2%, net
// income -4.4% - the exact pattern that forced the RACC retraction. One
// strong quarter can mask a year of decline, and the card said "No
// revenue-up/profit-down divergence" while sitting on it.
//
// FAILURE 2 - MARGIN TREND WAS STORED BUT NEVER ACTED ON.
// ORHD's card literally carried `"marginTrend": "compressing"`. Nothing read
// it. Its net margin has gone 31.7% -> 14.8% across five quarters, more than
// a halving, and that produced no alert anywhere. A company growing revenue
// fast while margins collapse is converting sales into progressively less
// profit, which is a different and often worse story than slowing growth.
//
// Both windows are reported, never just the flattering one.
//
// Usage: node --env-file=.env scripts/earnings-quality.mjs [TICKER ...]

/** Sum a metric over a window of quarters, returning null if any is missing. */
const sum = (qs, key) => {
  const vals = qs.map((q) => q[key]);
  return vals.every((v) => Number.isFinite(v)) ? vals.reduce((a, b) => a + b, 0) : null;
};

export function earningsQuality(quarterly) {
  // quarterlyHistory is stored newest-first.
  const q = (quarterly || []).filter((x) => Number.isFinite(x.revenue) && Number.isFinite(x.netIncome));
  if (q.length < 8) return { ok: false, reason: `only ${q.length} usable quarters, need 8` };

  const cur4 = q.slice(0, 4), prior4 = q.slice(4, 8);
  const cr = sum(cur4, "revenue"), cn = sum(cur4, "netIncome");
  const pr = sum(prior4, "revenue"), pn = sum(prior4, "netIncome");
  if ([cr, cn, pr, pn].some((v) => v == null)) return { ok: false, reason: "incomplete quarters" };

  const ttmRev = (cr / pr - 1) * 100;
  const ttmNi = (cn / pn - 1) * 100;
  const qRev = (q[0].revenue / q[4].revenue - 1) * 100;
  const qNi = (q[0].netIncome / q[4].netIncome - 1) * 100;

  const margins = q.slice(0, 6).map((x) => ({ q: x.quarter, m: (x.netIncome / x.revenue) * 100 }));
  const newest = margins[0].m, oldest = margins[margins.length - 1].m;
  const marginChange = newest - oldest;

  // GROSS margin, where the data has it. Added 2026-09-11 after this check
  // flagged ABUK and EGAL for a falling TTM NET income while both had gross
  // margins EXPANDING - ABUK 47.9% -> 54.4%, MFPC 50.3% -> 63.8%.
  //
  // Net income is the noisy line for an Egyptian exporter: it carries FX
  // translation on USD receivables, and one-off swings (MFPC posted a -5,259
  // quarter in Q4 2024 that distorts every trailing figure touching it).
  // Gross margin shows what the business actually earns on what it sells,
  // before any of that. When the two disagree, gross is the truer read of
  // operations and the net flag is downgraded rather than dropped.
  const gq = q.slice(0, 6).filter((x) => Number.isFinite(x.grossProfit) && x.revenue);
  const grossMargins = gq.map((x) => ({ q: x.quarter, m: (x.grossProfit / x.revenue) * 100 }));
  const grossChange = grossMargins.length >= 4
    ? grossMargins[0].m - grossMargins[grossMargins.length - 1].m : null;

  const flags = [];
  // The gate that ORHD slipped through.
  if (ttmRev > 0 && ttmNi < 0) flags.push({ sev: 0, code: "TTM_DIVERGENCE",
    text: `TTM revenue ${ttmRev >= 0 ? "+" : ""}${ttmRev.toFixed(1)}% while TTM net income ${ttmNi.toFixed(1)}% - the RACC pattern over a full year` });
  // The single-quarter version, kept because it is the earlier warning.
  if (qRev > 0 && qNi < 0) flags.push({ sev: 0, code: "QUARTER_DIVERGENCE",
    text: `latest quarter revenue +${qRev.toFixed(1)}% but net income ${qNi.toFixed(1)}% YoY` });
  // Profit growing, but far slower than sales - a softer version of the same thing.
  if (ttmRev > 10 && ttmNi > 0 && ttmNi < ttmRev / 2) flags.push({ sev: 1, code: "PROFIT_LAGGING",
    text: `TTM revenue +${ttmRev.toFixed(1)}% but net income only +${ttmNi.toFixed(1)}% - less than half the growth rate` });
  // The one that was stored and ignored.
  if (marginChange <= -5) flags.push({ sev: marginChange <= -10 ? 0 : 1, code: "MARGIN_COMPRESSION",
    text: `net margin ${oldest.toFixed(1)}% -> ${newest.toFixed(1)}% over ${margins.length} quarters (${marginChange.toFixed(1)} points)` });

  // Gross margin is the operational read. It can rescue a net-income flag, and
  // it can also raise one of its own that net income is masking.
  if (grossChange != null) {
    const gNew = grossMargins[0].m, gOld = grossMargins[grossMargins.length - 1].m;
    if (grossChange <= -5) {
      flags.push({ sev: grossChange <= -10 ? 0 : 1, code: "GROSS_MARGIN_COMPRESSION",
        text: `GROSS margin ${gOld.toFixed(1)}% -> ${gNew.toFixed(1)}% (${grossChange.toFixed(1)} points) - the business is earning less on what it sells, before any FX or one-offs` });
    } else if (grossChange >= 3) {
      // Downgrade the net-income flags this contradicts, and say why.
      for (const fl of flags) {
        if (fl.code === "TTM_DIVERGENCE" || fl.code === "MARGIN_COMPRESSION" || fl.code === "PROFIT_LAGGING") {
          fl.sev = Math.min(fl.sev + 1, 2);
          fl.text += ` - BUT gross margin is EXPANDING (${gOld.toFixed(1)}% -> ${gNew.toFixed(1)}%), so this is most likely FX translation or a one-off, not the operating business`;
        }
      }
      flags.push({ sev: 2, code: "GROSS_MARGIN_EXPANDING",
        text: `GROSS margin ${gOld.toFixed(1)}% -> ${gNew.toFixed(1)}% (+${grossChange.toFixed(1)} points) - operations improving` });
    }
  }

  return { ok: true, ttmRev, ttmNi, qRev, qNi, margins, marginChange,
           grossMargins, grossChange, flags,
           latest: q[0].quarter, oldestUsed: q[7].quarter };
}

// --- CLI. Guarded so the module can be IMPORTED without side effects: this
// used to open a Supabase connection at import time, so any script that wanted
// `earningsQuality()` had to carry database credentials it never used.
const isMain = process.argv[1] && import.meta.url.endsWith(process.argv[1].split("/").pop());
if (!isMain) { /* imported - export only */ } else {
const { createClient } = await import("@supabase/supabase-js");
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
const { data: users } = await supabase.auth.admin.listUsers();
const user = users.users.find((u) => u.email === process.env.ANALYSIS_USER_EMAIL);
const { data: notes } = await supabase.from("analysis_notes").select("ticker, chart_data").eq("user_id", user.id);
const only = process.argv.slice(2).filter((a) => !a.startsWith("--")).map((s) => s.toUpperCase());

// Which names are HELD is portfolio data and must not live in this public
// repo - the daily-brief workflow's own header states the private/public line:
// positions, P/L and invoices stay on the private side. Passed in instead, so
// this file carries none of it. The exported earningsQuality() never used it.
//   HELD_TICKERS=ORHD,MASR,... node --env-file=.env scripts/earnings-quality.mjs
const HELD = new Set((process.env.HELD_TICKERS || "").split(",").map((s) => s.trim().toUpperCase()).filter(Boolean));
const rows = notes.filter((n) => n.chart_data?.quarterlyHistory)
                  .filter((n) => !only.length || only.includes(n.ticker));

const out = [];
for (const n of rows) {
  const r = earningsQuality(n.chart_data.quarterlyHistory);
  out.push({ ticker: n.ticker, held: HELD.has(n.ticker), ...r });
}
out.sort((a, b) => (b.flags?.length ?? 0) - (a.flags?.length ?? 0) || (a.ttmNi ?? 0) - (b.ttmNi ?? 0));

const f = (n) => (Number.isFinite(n) ? `${n >= 0 ? "+" : ""}${n.toFixed(1)}%` : "-");
console.log("tk     H  latest    TTM rev   TTM ni    Qtr rev   Qtr ni    margin trend        flags");
for (const r of out) {
  if (!r.ok) { console.log(`${r.ticker.padEnd(6)} ${r.held ? "*" : " "}  ${r.reason}`); continue; }
  const mt = `${r.margins[r.margins.length - 1].m.toFixed(1)}->${r.margins[0].m.toFixed(1)}%`;
  console.log(`${r.ticker.padEnd(6)} ${r.held ? "*" : " "}  ${r.latest.padEnd(9)} ${f(r.ttmRev).padStart(8)} ${f(r.ttmNi).padStart(8)} ${f(r.qRev).padStart(9)} ${f(r.qNi).padStart(8)}   ${mt.padEnd(16)}  ${r.flags.map((x) => x.code).join(", ")}`);
}
console.log();
for (const r of out) {
  if (!r.ok || !r.flags.length) continue;
  console.log(`${r.ticker}${r.held ? " (HELD)" : ""}:`);
  for (const fl of r.flags) console.log(`  ${fl.sev === 0 ? "!!" : " !"} ${fl.text}`);
}
}
