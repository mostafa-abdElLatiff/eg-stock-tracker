#!/usr/bin/env node
// FUNDAMENTALS — the one reader for company financials.
//
// ONE JOB: given a ticker, return its financials or say precisely why not.
// Nothing else may open journal/financials.json directly.
//
// ---------------------------------------------------------------------------
// WHY THIS FILE EXISTS — the same mistake, three times
//
// 2026-09-16  "ORAS has zero usable quarters" — said as a fact about the
//             COMPANY. It was a fact about our database. Mostafa sent four
//             sources; the first had a full income statement. (L-28)
// 2026-09-17  Named EXPA/POUL/EEII/HELI as having "no fundamentals in our data
//             at all". Mostafa: "why can't you do it again?" They were fetched
//             in minutes. (L-29)
// 2026-09-19  Wrote full-analysis.mjs to read ONLY journal/financials.json,
//             where ORAS is absent — its data had gone into a one-off
//             journal/oras-financials.json on the 17th and was never merged.
//             Relayed the tool's miss as "ORAS still has no fundamentals",
//             two days after fixing exactly that. Mostafa caught it again.
//
// The first two were carelessness. The third was ARCHITECTURE: four stores
// existed (financials.json, fundamentals.json, fundamentals-fetched.json, and
// per-ticker <tk>-financials.json orphans), each tool read one, so every tool
// inherited a different set of holes. A new reader re-opened a closed gap.
//
// The defence is structural, not a reminder to be careful:
//   - ONE reader, which consults every store.
//   - A miss returns status "not_fetched" with the stores checked and where to
//     go next. It NEVER returns null, because null reads like "no data exists"
//     and that is the sentence that has now been wrong three times.
//   - coverage() lists holes so they are closed, not narrated.

import { readFileSync, readdirSync, existsSync } from "fs";
import { pathToFileURL } from "url";

const ROOT = new URL("../../../", import.meta.url).pathname;
const J = (p) => JSON.parse(readFileSync(ROOT + p, "utf8"));

/** Every place a fundamental may hide. Add here, never in a caller. */
const STORES = [
  { name: "journal/financials.json", load: () => J("journal/financials.json").data },
  {
    name: "journal/<ticker>-financials.json",
    load: () => Object.fromEntries(
      readdirSync(ROOT + "journal")
        .filter((f) => /-financials\.json$/.test(f))
        .map((f) => [f.split("-")[0].toUpperCase(), { _orphan: `journal/${f}`, ...J(`journal/${f}`) }])),
  },
];

let CACHE = null;
function all() {
  if (CACHE) return CACHE;
  CACHE = {};
  for (const s of STORES) {
    let d; try { d = s.load(); } catch { continue; }
    for (const [tk, rec] of Object.entries(d ?? {})) {
      // First store wins: the canonical file is authoritative when both hold a
      // ticker, so merging an orphan in does not change an existing answer.
      if (!CACHE[tk]) CACHE[tk] = { ...rec, _store: rec._orphan ?? s.name };
    }
  }
  return CACHE;
}

/** USD/EGP spot, for tickers that report in dollars (ORAS does). */
function usdEgp() {
  try { return J("journal/usd-egp.json").spot; } catch { return null; }
}

/**
 * THE fundamentals lookup.
 * @returns {{status:"ok", ...}|{status:"not_fetched", checked:string[], next:string}}
 *          Never null - see the header for why.
 */
// PERMANENT GAP REGISTER. A hole that has already been investigated must not be
// re-reported as a discovery. ORAS's missing financials were raised FOUR times,
// twice in one day, because the investigation lived only in chat. See
// journal/data-gaps.json for the reasoning; this reads it.
let _gaps = null;
function gapFor(tk) {
  if (_gaps === null) {
    try { _gaps = JSON.parse(readFileSync(new URL("../../../journal/data-gaps.json", import.meta.url), "utf8")).gaps; }
    catch { _gaps = []; }
  }
  return _gaps.find((g) => g.ticker === tk?.toUpperCase() && g.field === "financials") ?? null;
}

/**
 * EVERY ticker from EVERY store, merged - the map form of fundamentalsFor().
 *
 * Added 2026-09-19. Three scripts (fair-value.mjs, fair-value-board.mjs,
 * market-scan.mjs) each opened journal/financials.json directly because there
 * was no exported way to get the whole map. That single file is one of TWO
 * stores, so all three silently missed every orphan-file ticker - which is how
 * ORAS looked absent four separate times while its data sat in
 * journal/oras-financials.json. Rule 1: if the function does not exist, write
 * it once and document it, so nobody re-derives a third copy.
 */
export function allFundamentals() {
  return all();
}

export function fundamentalsFor(tk) {
  const rec = all()[tk?.toUpperCase()];
  if (!rec) {
    const known = gapFor(tk);
    if (known) {
      return {
        status: "unavailable",
        ticker: tk.toUpperCase(),
        alreadyInvestigated: true,
        firstRecorded: known.firstRecorded,
        lastChecked: known.lastChecked,
        why: known.whyItIsMissing,
        attempts: known.attempts,
        next: known.whatWouldFixIt,
        consequence: known.consequence,
        doNot: "This gap is ON RECORD in journal/data-gaps.json. Do not re-report it as newly found, and do not say it has been fixed unless journal/financials.json actually contains the ticker.",
      };
    }
    return {
      status: "not_fetched",
      ticker: tk,
      checked: STORES.map((s) => s.name),
      next: `node bot/fetch-financials.mjs ${tk}  (or read stockanalysis.com / stockastic.app by hand). ` +
            `THIS IS A HOLE IN OUR DATABASE, NOT A FACT ABOUT THE COMPANY - do not report it as one.`,
    };
  }
  return { status: "ok", ticker: tk.toUpperCase(), store: rec._store, currency: rec._currency?.startsWith("USD") ? "USD" : "EGP", ...rec };
}

/**
 * Latest period vs the comparable prior one, normalised across store shapes.
 * @returns {{status:"ok",...}|{status:"not_fetched",...}}
 */
export function latestVsPrior(tk, price = null) {
  const f = fundamentalsFor(tk);
  if (f.status !== "ok") return f;

  let cur, prev, periods, currency = f.currency;
  if (Array.isArray(f.revenue)) {                         // canonical array shape
    periods = [f.periods[0], f.periods[1]];
    cur = { revenue: f.revenue[0], netIncome: f.netIncome[0], grossProfit: f.grossProfit?.[0], operatingIncome: f.operatingIncome?.[0], eps: f.eps?.[0], equity: f.totalEquity?.[0], debt: f.totalDebt?.[0], cash: f.cashAndST?.[0], fcf: f.freeCashFlow?.[0] };
    prev = { revenue: f.revenue[1], netIncome: f.netIncome[1] };
  } else if (f.ttm) {                                     // TTM-snapshot shape (ORAS)
    const keys = Object.keys(f.ttm).filter((k) => !k.startsWith("_"));
    const a = f.ttm[keys[keys.length - 1]], b = f.ttm[keys[0]];   // newest vs 4 quarters back
    periods = [`TTM ${keys[keys.length - 1]}`, `TTM ${keys[0]}`];
    const M = 1e6;                                         // stored in units, not millions
    cur = { revenue: a.revenue / M, netIncome: a.netProfit / M, grossProfit: a.grossProfit / M, operatingIncome: a.operatingProfit / M, eps: a.eps,
            equity: null, debt: null, cash: null, fcf: null };
    prev = { revenue: b.revenue / M, netIncome: b.netProfit / M };
  } else {
    return { status: "not_fetched", ticker: tk, checked: [f.store], next: `record in ${f.store} is present but in an unrecognised shape - extend latestVsPrior()` };
  }

  // P/E must respect the reporting currency. ORAS reports USD against an EGP
  // price: 879 / 2.07 reads as a P/E of 425 instead of ~8. The oras file warns
  // about exactly this - "getting this wrong would make every valuation read
  // nonsense" - so it is handled here, once, rather than in each caller.
  let pe = null, peHow = null;
  if (price && cur.eps) {
    if (currency === "USD") {
      const fx = usdEgp();
      pe = fx ? (price / fx) / cur.eps : null;
      peHow = fx ? `price ${price} EGP / USDEGP ${fx} = ${(price / fx).toFixed(2)} USD, / EPS ${cur.eps} USD` : "USD reporter but no FX available";
    } else { pe = price / cur.eps; peHow = `price ${price} / EPS ${cur.eps}`; }
  }

  const pct = (x, y) => ((x - y) / Math.abs(y)) * 100;
  const nm = (o) => (o.netIncome / o.revenue) * 100;
  return { status: "ok", ticker: tk.toUpperCase(), store: f.store, currency, periods,
           revenueGrowth: pct(cur.revenue, prev.revenue), netIncomeGrowth: pct(cur.netIncome, prev.netIncome),
           netMargin: nm(cur), netMarginPrior: nm(prev), marginDeltaPP: nm(cur) - nm(prev),
           grossMargin: cur.grossProfit != null ? (cur.grossProfit / cur.revenue) * 100 : null,
           operatingMargin: cur.operatingIncome != null ? (cur.operatingIncome / cur.revenue) * 100 : null,
           roe: cur.equity ? (cur.netIncome / cur.equity) * 100 : null,
           debtToEquity: cur.equity ? (cur.debt / cur.equity) * 100 : null,
           netCash: cur.cash != null ? cur.cash - cur.debt : null,
           freeCashFlow: cur.fcf, fcfConversion: cur.fcf != null && cur.netIncome ? (cur.fcf / cur.netIncome) * 100 : null,
           peRatio: pe, peHow, raw: cur };
}

/** Which tracked tickers have no fundamentals. Close these; do not narrate them. */
export function coverage(tickers) {
  const have = [], missing = [];
  for (const tk of tickers) (fundamentalsFor(tk).status === "ok" ? have : missing).push(tk);
  return { have, missing, pct: (have.length / tickers.length) * 100 };
}

// Run-directly check. Was `import.meta.url.endsWith(argv[1].split("/").pop())`, which is a
// SUFFIX match on the basename - so any caller named levels.mjs made
// price-levels.mjs think it was the entry point and run its CLI, throwing on an
// empty ticker. Found 2026-09-19 when a scratch script called levels.mjs blew up
// inside priceLevels(). pathToFileURL comparison is exact.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const tk = (process.argv[2] || "").toUpperCase();
  console.log(JSON.stringify(tk ? latestVsPrior(tk, parseFloat(process.argv[3]) || null) : coverage(Object.keys(all())), null, 2));
}
