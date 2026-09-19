#!/usr/bin/env node
// An INDEPENDENT intrinsic-value estimate, from several models, reporting the
// SPREAD between them rather than a single number.
//
// WHY THIS EXISTS. webapp/CLAUDE.md has carried this as an open, acknowledged
// gap since Sept 4: "this project relays SOURCED fair-value targets (named
// analyst/research house) rather than computing an independent intrinsic-value
// model... Don't claim to have computed intrinsic value when only relaying
// someone else's target." This is the computing half, so the distinction can
// finally be made honestly.
//
// WHY THE SPREAD IS THE POINT. A subscription tool shows one Fair Value number,
// an average across its models. An average of twelve models that agree and an
// average of twelve that range from -20% to +90% look identical on screen, and
// the second one is nearly worthless. Every model's output is printed here, plus
// the dispersion, and the dispersion is converted into an explicit confidence
// band you can compare against InvestingPro's own Low/Med/High rating.
//
// THE EGYPT PROBLEM, STATED UP FRONT. EGP nominal rates are ~18-20% (Mostafa's
// own Thndr cash earns 17.29% instant / 20.33% monthly - a real, observed EGP
// risk-free proxy, not a guess). A DCF discounts at that rate, so terminal value
// is dominated by (r - g) and BOTH must be nominal. Mixing a nominal discount
// rate with a real growth rate is the single most common way to get an Egyptian
// DCF badly wrong - it understates value by a factor, not a few percent. Every
// rate below is nominal EGP. Because (r - g) is small relative to r, the answer
// is genuinely sensitive: --sensitivity prints the grid instead of pretending a
// point estimate is precise.
//
// WHAT THIS IS NOT. It is not a forecast. Every model is an arithmetic
// consequence of the assumptions printed alongside it. Change the assumptions
// and the number changes; that is a property of valuation, not a defect here.
//
// Usage: node fair-value.mjs TICKER [--rf 0.18] [--erp 0.07] [--g 0.12] [--sensitivity]

import { readFileSync } from "fs";
import { pathToFileURL } from "url";
import { fundamentalsFor } from "./lib/fundamentals.mjs";

const ROOT = new URL("../../", import.meta.url).pathname;
const arg = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i > 0 ? parseFloat(process.argv[i + 1]) : d; };

// ---- Egypt nominal assumptions. Documented, overridable, never buried.
const RF    = arg("rf", 0.18);    // EGP nominal risk-free. Anchored to real observed
                                  // EGP cash yields (17.29-20.33%) and T-bill levels.
const ERP   = arg("erp", 0.07);   // Egypt equity risk premium incl. country risk.
const GT    = arg("g", 0.12);     // Terminal NOMINAL growth. Long-run EGP inflation +
                                  // real growth. Must be < WACC and is the single most
                                  // sensitive input in the whole model.
const TAX   = arg("tax", 0.225);  // Egypt corporate tax.
const KD    = arg("kd", 0.20);    // Pre-tax cost of debt, EGP.
const YEARS = 5;

const M = 1e6; // statements are reported in millions

const median = (a) => { const s = [...a].sort((x, y) => x - y); const h = s.length >> 1;
  return s.length % 2 ? s[h] : (s[h - 1] + s[h]) / 2; };
const mean = (a) => a.reduce((x, y) => x + y, 0) / a.length;
const cagr = (last, first, yrs) => (first > 0 && last > 0) ? Math.pow(last / first, 1 / yrs) - 1 : null;

export function fairValue(ticker, opts = {}) {
  const notesPre = [];
// READS THROUGH THE REGISTRY. Opening journal/financials.json directly here is
// what made ORAS look absent on 2026-09-19 - four times, twice in one day -
// while its data sat in journal/oras-financials.json, fetched 2026-09-17 and
// carrying a gate verdict of PASSES. lib/fundamentals.mjs consults EVERY store;
// the raw file is only one of them. CLAUDE.md rule 1 and rule 6 both.
  const _f = fundamentalsFor(ticker);
  const fin = _f.status === "ok" ? _f : null;
  const fun = JSON.parse(readFileSync(`${ROOT}journal/fundamentals.json`, "utf8")).data[ticker];
  if (!fin) throw new Error(`No financials for ${ticker} - run bot/fetch-financials.mjs ${ticker}`);

  // CURRENCY GUARD. M below assumes statements in EGP millions. ORAS reports in
  // USD (dual-listed, EGX + Nasdaq Dubai). Without this guard the model read
  // $6.07bn of revenue as 6.07bn EGP and produced an EPV of 8.58 against an 879
  // price - a -99% "fair value" that is a unit error, not a valuation. The ORAS
  // financials file warned about exactly this: "Getting this wrong would have
  // made every valuation read nonsense."
  //
  // REFUSING is deliberate. An FX conversion here would need the rate at each
  // statement date, not just spot, and a wrong number that looks plausible is
  // worse than no number. journal/usd-egp.json holds spot 52.12 @ 2026-09-17 and
  // month-ends back to 2022 if someone wants to build that properly.
  if (fin.currency && fin.currency !== "EGP") {
    throw new Error(
      `${ticker} reports in ${fin.currency}, not EGP, and this model assumes EGP millions. ` +
      `Refusing rather than printing a number that is wrong by the FX rate. ` +
      `To fix: convert the statements in ${fin.store} to EGP at the rate for each period ` +
      `(journal/usd-egp.json has month-ends back to 2022), or add per-period FX handling here.`);
  }
  const rf = opts.rf ?? RF, erp = opts.erp ?? ERP, gt = opts.g ?? GT;

  const shares = fun?.sharesOut;
  if (!shares) throw new Error(`No share count for ${ticker}`);

  // ---- Beta must be sanity-bounded before it touches the cost of equity.
  // Measured beta on a thinly-traded EGX name is not a risk estimate, it is a
  // liquidity artefact: the cache holds TAQA at 7.66 (which would imply a 71.6%
  // cost of equity and collapsed every TAQA model to near zero), ORWE at -0.03
  // and LCSW at -0.36. Negative and extreme betas come from stocks that barely
  // move with the index because they barely trade. Clamp to a plausible equity
  // range and say so, rather than letting one bad field silently decide a
  // valuation.
  const rawBeta = fun?.beta;
  const BETA_MIN = 0.4, BETA_MAX = 2.0;
  let beta = rawBeta;
  if (!Number.isFinite(beta) || beta < BETA_MIN || beta > BETA_MAX) {
    // Fall back to NEUTRAL, not to the nearest bound. Clamping 7.66 to 2.0 would
    // still be reading it as "very high risk" when the number is noise from thin
    // trading, not a risk measurement. An unusable beta means we have no beta.
    beta = 1.0;
    notesPre.push(`beta ${rawBeta ?? "missing"} is not a usable equity beta (plausible range ${BETA_MIN}-${BETA_MAX}) - thin EGX trading produces spurious and even negative betas. Fell back to 1.0 (neutral) rather than the boundary, because an unusable number is absence of information, not evidence of risk.`);
  }

  // --- capital structure (latest period), in EGP
  const debt   = (fin.totalDebt?.[0] ?? 0) * M;
  const cashST = (fin.cashAndST?.[0] ?? fin.cash?.[0] ?? 0) * M;
  const equityBV = (fin.totalEquity?.[0] ?? 0) * M;
  const netDebt = debt - cashST;

  const ke = rf + beta * erp;
  const kdAfterTax = (opts.kd ?? KD) * (1 - (opts.tax ?? TAX));
  // Weight on MARKET equity. This matters more than it looks: fundamentals.json
  // has marketCap null for several names, and falling back to BOOK equity on a
  // stock trading at 7x book understates the equity weight, which drags WACC
  // toward the cheaper cost of debt and silently inflates every model that
  // discounts by it. Derive it from price x shares when the cache lacks it.
  const price = opts.price ?? (() => { try {
    return JSON.parse(readFileSync(`${ROOT}journal/stored-levels.json`, "utf8"))[ticker]?.lastClose ?? null;
  } catch { return null; } })();
  const mktEquity = fun?.marketCap ?? (price ? price * shares : equityBV);
  const wacc = (mktEquity * ke + debt * kdAfterTax) / (mktEquity + debt);

  const models = {};
  const relative = {};
  const notes = [...notesPre];

  // ---- Banks and investment banks get EQUITY-SIDE MODELS ONLY.
  // Two reasons, both fatal to the others. (1) A bank's operating cash flow is
  // dominated by changes in loans and deposits, not by operations - COMI's TTM
  // OCF is -96.3B and ADIB's -68.6B. FCF is not owner earnings there. (2) An
  // enterprise-value model subtracts net debt, but for a bank deposits ARE the
  // raw material, not a liability to net off; subtracting them destroys the
  // answer. Residual income, justified P/B and DDM work directly on equity and
  // are the standard bank-valuation tools.
  //
  // The list is explicit and NOT taken from the sector field, because that field
  // is wrong here in a way that would silently corrupt results: TradingView
  // labels MASR, PHDC, TMGH and ELKA "Finance" when they are real-estate
  // developers. Gating on the label would have stripped the cash-flow models
  // from four names that genuinely need them.
  const BANKS = new Set(["COMI", "ADIB", "HRHO", "EXPA", "QNBE", "CIEB", "SAUD", "FAIT", "ADCI", "HDBK", "CANA"]);
  const isBank = BANKS.has(ticker);
  if (isBank) notes.push("bank/financial: cash-flow and enterprise-value models skipped - OCF is driven by loan and deposit flows, and net debt is meaningless when deposits are the raw material");

  // ---------- 1. DCF on normalised free cash flow
  // FCF is lumpy for capex-heavy businesses, so a single year is a bad base.
  // Normalise over the available history rather than anchoring on the newest
  // figure, which is exactly how a one-off working-capital swing becomes a
  // permanent valuation.
  const fcfHist = (fin.freeCashFlow ?? []).filter(Number.isFinite);
  if (!isBank && fcfHist.length >= 3) {
    const base = mean(fcfHist.slice(0, Math.min(4, fcfHist.length))) * M;
    if (base > 0) {
      const gHi = Math.min(cagr(fin.revenue[0], fin.revenue[fin.revenue.length - 1], fin.revenue.length - 1) ?? gt, 0.35);
      let pv = 0, f = base;
      for (let t = 1; t <= YEARS; t++) {
        // fade from the historical revenue CAGR down to terminal growth
        const g = gHi + (gt - gHi) * (t / YEARS);
        f *= (1 + g);
        pv += f / Math.pow(1 + wacc, t);
      }
      const tv = (f * (1 + gt)) / (wacc - gt);
      pv += tv / Math.pow(1 + wacc, YEARS);
      models["DCF (normalised FCF)"] = (pv - netDebt) / shares;
      notes.push(`DCF base FCF ${(base / 1e9).toFixed(2)}B (avg of ${Math.min(4, fcfHist.length)} periods), fade ${(gHi * 100).toFixed(0)}%->${(gt * 100).toFixed(0)}%`);
    } else notes.push("DCF skipped: normalised FCF is negative - no positive cash to discount");
  }

  // ---------- 2. Earnings Power Value (Greenwald): no growth at all.
  // A deliberate floor - what the business is worth if it never grows again.
  const ebit = (fin.operatingIncome?.[0] ?? 0) * M;
  if (!isBank && ebit > 0) {
    const epv = (ebit * (1 - (opts.tax ?? TAX)) / wacc - netDebt) / shares;
    // A negative EPV is arithmetically real - it says the no-growth enterprise
    // value does not cover net debt, so the equity is a leveraged option rather
    // than a claim on visible earnings. GBCO is the live case: net debt 35.9B
    // against a 32.9B market cap. Report it loudly; do not average it into a
    // median where it reads as just another low number.
    if (epv > 0) models["EPV (zero growth)"] = epv;
    else notes.push(`EPV is NEGATIVE (${epv.toFixed(2)}): at zero growth the business does not cover its net debt of ${(netDebt/1e9).toFixed(1)}B. Excluded from the median - it is a leverage warning, not a price.`);
  }

  // ---------- 3. Residual income / justified book value
  // BVPS + PV of the excess return over cost of equity. Best-suited model when
  // earnings are real but cash flow is lumpy.
  const roe = (fun?.roe ?? 0) / 100;
  const bvps = equityBV / shares;
  // Book value may NOT compound at ROE x retention in perpetuity. EFID's ROE is
  // 62%, so a 60% retention implies 37% growth forever - above its own cost of
  // equity, which is impossible and made the first version of this model return
  // 97 EGP on a 31 EGP stock. Growth used anywhere in a perpetuity is capped at
  // terminal growth; near-term book growth is capped there too.
  const gSustain = Math.min(roe * 0.6, gt);
  if (roe > 0 && bvps > 0) {
    // Excess returns decay. A 62% ROE is not a permanent feature of the world -
    // competition erodes it. Fade ROE linearly to the cost of equity over
    // FADE years, after which residual income is zero by construction and there
    // is no explosive terminal term at all.
    const FADE = 10;
    let pv = 0, bv = bvps;
    for (let t = 1; t <= FADE; t++) {
      const roeT = roe + (ke - roe) * (t / FADE);
      pv += ((roeT - ke) * bv) / Math.pow(1 + ke, t);
      bv *= (1 + gSustain);
    }
    models["Residual income (ROE fades to Ke)"] = bvps + pv;
  }

  // ---------- 4. Justified P/B from sustainable growth
  if (roe > 0 && bvps > 0 && ke - gSustain > 0.02) {
    models["Justified P/B"] = bvps * (roe - gSustain) / (ke - gSustain);
  } else if (roe > 0) {
    notes.push("Justified P/B skipped: (Ke - g) below 2pts, the Gordon form is degenerate there");
  }

  // ---------- 5 & 6. Relative multiples against the sector's own median.
  // Uses THIS market's peers, not a global average - an EGX food company is not
  // priced off a US food company.
  const all = JSON.parse(readFileSync(`${ROOT}journal/fundamentals.json`, "utf8")).data;
  const peers = Object.entries(all).filter(([k, v]) => v.sector && v.sector === fun?.sector && k !== ticker);
  // These go in a SEPARATE block. They are not intrinsic value - they say what
  // the market currently pays for comparable businesses, which is a different
  // claim and travels with the market's own mistakes. EGX sector peer sets are
  // also tiny and wildly dispersed (EFID's nine Consumer Non-Durables peers run
  // from 13x to 172x), so each one carries its peer count and spread.
  const peerROE = peers.map(([, v]) => v.roe).filter(Number.isFinite);
  const peerPE = peers.map(([, v]) => v.pe).filter((x) => Number.isFinite(x) && x > 0 && x < 100);
  const eps = fin.eps?.[0];
  if (peerPE.length >= 4 && Number.isFinite(eps) && eps > 0) {
    const m = median(peerPE);
    relative[`Sector P/E x EPS (${peerPE.length} peers, med ${m.toFixed(1)}x, range ${Math.min(...peerPE).toFixed(0)}-${Math.max(...peerPE).toFixed(0)}x)`] = eps * m;
  } else notes.push(`Sector P/E skipped: only ${peerPE.length} peers with a usable P/E - too few to take a median from`);
  const peerPB = peers.map(([, v]) => v.pb).filter((x) => Number.isFinite(x) && x > 0 && x < 15);
  if (peerPB.length >= 4 && bvps > 0) {
    const m = median(peerPB);
    relative[`Sector P/B x BVPS (${peerPB.length} peers, med ${m.toFixed(1)}x)`] = bvps * m;
    if (peerROE.length >= 4) {
      const relRoe = roe * 100 / median(peerROE);
      notes.push(`this company earns ${relRoe.toFixed(1)}x the sector's median ROE (${(roe*100).toFixed(1)}% vs ${median(peerROE).toFixed(1)}%) - a raw sector P/B ignores that, which is what Justified P/B corrects for`);
    }
  }

  // ---------- 7. Dividend discount, only where the dividend is real
  // A dividend discount model values the DIVIDEND, and only approximates the
  // business when the payout is high enough for the two to be the same thing.
  // TAQA pays out 1.7% of earnings; its DDM returned 0.03 EGP against a 15.85
  // price and dragged the median to -92%. Below a real payout this is reported
  // as context, never blended into the median.
  const divPaid = Math.abs(fin.dividendsPaid?.[0] ?? 0) * M;
  const niNow = (fin.netIncome?.[0] ?? 0) * M;
  const payout = niNow > 0 ? divPaid / niNow : 0;
  if (divPaid > 0) {
    const dps = divPaid / shares;
    const gDiv = Math.min(gt, ke - 0.03);
    const ddm = dps * (1 + gDiv) / (ke - gDiv);
    if (payout >= 0.25) models[`Dividend discount (payout ${(payout*100).toFixed(0)}%)`] = ddm;
    else { relative[`Dividend discount (payout only ${(payout*100).toFixed(0)}% - values the dividend, not the business)`] = ddm; }
  }

  const vals = Object.values(models).filter((v) => Number.isFinite(v) && v > 0);
  const med = vals.length ? median(vals) : null;
  const lo = Math.min(...vals), hi = Math.max(...vals);
  // Dispersion as a share of the median - the honest confidence signal.
  // Dispersion is meaningless with fewer than three surviving models. CCAP
  // returned ONE model and therefore a spread of exactly 0%, which printed as
  // "confidence Low" - i.e. maximum confidence - on the single most contested
  // name on the board. A lone model is the LEAST reliable case, not the most.
  const disp = (med && vals.length >= 2) ? (hi - lo) / med : null;
  const band = vals.length < 3
    ? (vals.length === 0 ? "n/a" : "Unverified")     // too few models to cross-check
    : disp < 0.5 ? "Low" : disp < 1.2 ? "Medium" : "High";

  return { ticker, models, relative, median: med, lo, hi, dispersion: disp, band, wacc, ke, beta,
           netDebt, shares, bvps, notes, rf, erp, gt };
}

// ---------------------------------------------------------------- CLI
// Run-directly check. Was `import.meta.url.endsWith(argv[1].split("/").pop())`, which is a
// SUFFIX match on the basename - so any caller named levels.mjs made
// price-levels.mjs think it was the entry point and run its CLI, throwing on an
// empty ticker. Found 2026-09-19 when a scratch script called levels.mjs blew up
// inside priceLevels(). pathToFileURL comparison is exact.
const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  const ticker = (process.argv[2] || "").toUpperCase();
  const r = fairValue(ticker);
  const px = (() => { try {
    const cd = JSON.parse(readFileSync(`${ROOT}journal/stored-levels.json`, "utf8"))[ticker];
    return cd?.lastClose ?? null; } catch { return null; } })();

  console.log(`\n${ticker}  independent fair value`);
  console.log(`assumptions (all NOMINAL EGP): risk-free ${(r.rf*100).toFixed(1)}%  ERP ${(r.erp*100).toFixed(1)}%  beta ${r.beta}  ->  cost of equity ${(r.ke*100).toFixed(1)}%`);
  console.log(`                               WACC ${(r.wacc*100).toFixed(1)}%   terminal growth ${(r.gt*100).toFixed(1)}%   (r-g) = ${((r.wacc-r.gt)*100).toFixed(1)} pts`);
  console.log(`net debt ${(r.netDebt/1e9).toFixed(2)}B   shares ${(r.shares/1e6).toFixed(0)}M   book value/share ${r.bvps.toFixed(2)}\n`);
  const line = (k, v) => {
    const d = px ? `   ${v > px ? "+" : ""}${((v - px) / px * 100).toFixed(0)}% vs ${px}` : "";
    console.log(`  ${k.padEnd(52)} ${v.toFixed(2).padStart(9)}${d}`);
  };
  console.log("INTRINSIC - what the cash flows and book returns are worth:");
  for (const [k, v] of Object.entries(r.models)) line(k, v);
  if (Object.keys(r.relative).length) {
    console.log("\nRELATIVE - what the market pays for comparable EGX businesses (context, not intrinsic value):");
    for (const [k, v] of Object.entries(r.relative)) line(k, v);
  }
  console.log(`\n  ${"MEDIAN".padEnd(42)} ${r.median.toFixed(2).padStart(9)}${px ? `   ${r.median > px ? "+" : ""}${((r.median - px) / px * 100).toFixed(0)}% vs ${px}` : ""}`);
  console.log(`  range ${r.lo.toFixed(2)} - ${r.hi.toFixed(2)}   dispersion ${(r.dispersion * 100).toFixed(0)}% of median  ->  confidence ${r.band}`);
  for (const n of r.notes) console.log(`  note: ${n}`);

  if (process.argv.includes("--sensitivity")) {
    console.log(`\n  sensitivity of the MEDIAN to the two inputs that actually drive it:`);
    console.log(`   g \\ rf` + [0.16, 0.18, 0.20, 0.22].map((x) => `${(x*100).toFixed(0)}%`.padStart(9)).join(""));
    for (const g of [0.10, 0.12, 0.14]) {
      const row = [0.16, 0.18, 0.20, 0.22].map((rf) => {
        try { return fairValue(ticker, { rf, g }).median.toFixed(2).padStart(9); } catch { return "     n/a"; }
      }).join("");
      console.log(`   ${(g*100).toFixed(0)}%  ` + row);
    }
  }
  console.log(`\nEvery number above is an arithmetic consequence of the printed assumptions, not a forecast.`);
}
