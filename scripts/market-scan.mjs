#!/usr/bin/env node
// Scores the whole liquid EGX on TWO separate questions, because they are not
// the same question and conflating them is how this project got CLHO wrong.
//
//   QUALITY  - is this a good business to own?      (fundamentals only)
//   ENTRY    - is this a good price to pay today?   (valuation + technical)
//
// A great company at a terrible price scores high on one and low on the other.
// The webapp already learned this distinction the hard way: holdingScore said
// CLHO was 82 while its H1 profit fell 34%, because holdingScore deliberately
// ignores fundamentals. Here they are two explicit columns, never blended.
//
// THE ONE METRIC THAT DOES THE MOST WORK is cash conversion - free cash flow
// against reported net income, over every year available. It is what separates
// PHAR (five straight years of profit, five straight years of negative FCF) and
// SODIC (net income +70.9% on operating cash flow of -3,656M) from businesses
// whose earnings are real. Nothing else in the fundamental stack catches that.
//
// Usage: node market-scan.mjs [--sector "Finance"] [--top 10] [--json out.json]

import { readFileSync, writeFileSync } from "fs";
import { fairValue } from "./fair-value.mjs";

const ROOT = new URL("../../", import.meta.url).pathname;
const JOB = process.env.CLAUDE_JOB_DIR;
const fun = JSON.parse(readFileSync(`${ROOT}journal/fundamentals.json`, "utf8")).data;
const fin = JSON.parse(readFileSync(`${ROOT}journal/financials.json`, "utf8")).data;
const uni = Object.fromEntries(JSON.parse(readFileSync(`${JOB}/tmp/universe.json`, "utf8")).map((r) => [r.name, r]));

const KE = 0.25;                      // cost of equity at rf 18% + beta 1 x ERP 7%
const BANKS = new Set(["COMI","ADIB","HRHO","EXPA","QNBE","CIEB","SAUD","FAIT","ADCI","HDBK","CANA","ATLC"]);
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const cagr = (newV, oldV, yrs) => (oldV > 0 && newV > 0 && yrs > 0) ? Math.pow(newV / oldV, 1 / yrs) - 1 : null;
const median = (a) => { const s=[...a].sort((x,y)=>x-y); const h=s.length>>1;
  return s.length ? (s.length%2 ? s[h] : (s[h-1]+s[h])/2) : null; };

function quality(t) {
  const f = fun[t], d = fin[t];
  if (!f || !d) return null;
  const isBank = BANKS.has(t);
  const parts = {}, flags = [];

  // 1. Value creation (0-25). Below the cost of equity a company destroys value
  //    however profitable it looks in absolute terms.
  const roe = (f.roe ?? 0) / 100;
  const spread = roe - KE;
  parts.valueCreation = spread >= 0.25 ? 25 : spread >= 0.15 ? 20 : spread >= 0.05 ? 14 : spread >= 0 ? 7 : 0;
  if (spread < 0) flags.push(`ROE ${(roe*100).toFixed(0)}% is below the ${(KE*100)}% cost of equity - destroys value`);

  // 2. Growth (0-20), from the real net-income series.
  const ni = (d.netIncome ?? []).filter(Number.isFinite);
  const yrs = Math.max(0, ni.length - 2);
  const g = yrs >= 2 ? cagr(ni[1], ni[ni.length - 1], yrs) : null;
  parts.growth = g == null ? 6 : g >= 0.30 ? 20 : g >= 0.20 ? 16 : g >= 0.10 ? 12 : g >= 0 ? 6 : 0;
  if (g != null && g < 0) flags.push("net income shrinking over the period on file");
  // A multi-year CAGR is blind to the newest turn. ISMQ scored 99 on a 158%/yr
  // CAGR while its TTM earnings were already BELOW the last full year. Compare
  // TTM against the latest fiscal year and dock the score when it has rolled over.
  if (ni.length >= 2 && ni[1] > 0) {
    const ttmVsFy = ni[0] / ni[1] - 1;
    if (ttmVsFy < -0.10) { parts.growth = Math.max(0, parts.growth - 10);
      flags.push(`TTM earnings ${(ttmVsFy*100).toFixed(0)}% BELOW the last full year - the CAGR is backward-looking`); }
    else if (ttmVsFy < 0) { parts.growth = Math.max(0, parts.growth - 4);
      flags.push("TTM earnings slightly below the last full year"); }
  }
  // One-year step changes are cycle, not compounding. Cement and fertiliser
  // margins do this; it should not read as durable growth.
  if (ni.length >= 3 && ni[2] > 0 && ni[1] / ni[2] > 4) {
    parts.growth = Math.max(0, parts.growth - 6);
    flags.push(`earnings jumped ${(ni[1]/ni[2]).toFixed(1)}x in a single year - cyclical margin expansion, not a compounding record`);
  }

  // 3. Cash conversion (0-25) - the decisive one. Banks are exempt: their OCF is
  //    loan and deposit flow, so FCF is not a measure of anything there.
  const fcf = (d.freeCashFlow ?? []).filter(Number.isFinite);
  if (isBank) { parts.cashConversion = 15; flags.push("bank: cash-conversion test not applicable"); }
  else if (fcf.length >= 3) {
    const posYears = fcf.filter((x) => x > 0).length / fcf.length;
    const conv = median(fcf.map((x, i) => (ni[i] > 0 ? x / ni[i] : null)).filter(Number.isFinite)) ?? 0;
    parts.cashConversion = clamp(Math.round(posYears * 13 + clamp(conv, -0.5, 1) * 12), 0, 25);
    if (posYears <= 0.34) flags.push(`free cash flow negative in ${fcf.length - fcf.filter(x=>x>0).length} of ${fcf.length} periods`);
    if (conv < 0.3 && posYears > 0.34) flags.push(`only ${(conv*100).toFixed(0)}% of reported profit converts to cash`);
  } else { parts.cashConversion = 8; flags.push("too little cash-flow history to judge conversion"); }

  // 4. Balance sheet (0-15).
  if (isBank) {
    const eq = d.totalEquity?.[0], ta = d.totalAssets?.[0];
    const cap = eq && ta ? eq / ta : null;
    parts.balance = cap == null ? 8 : cap >= 0.10 ? 15 : cap >= 0.07 ? 11 : cap >= 0.05 ? 7 : 3;
    if (cap != null && cap < 0.07) flags.push(`equity only ${(cap*100).toFixed(1)}% of assets - thin capital`);
  } else {
    const nd = (d.totalDebt?.[0] ?? 0) - (d.cashAndST?.[0] ?? d.cash?.[0] ?? 0);
    const ebitda = (d.operatingIncome?.[0] ?? 0) + (d.dandA?.[0] ?? 0);
    const lev = ebitda > 0 ? nd / ebitda : null;
    parts.balance = lev == null ? 7 : lev <= 0 ? 15 : lev < 1.5 ? 12 : lev < 3 ? 8 : lev < 5 ? 4 : 0;
    if (lev != null && lev >= 3) flags.push(`net debt ${lev.toFixed(1)}x EBITDA`);
  }

  // 5. Consistency (0-15): loss years and margin direction.
  // QUALITY OF EARNINGS: profit that exceeds revenue is not coming from the
  // business. CSAG reports net income of 1,134M on revenue of 165M - roughly
  // seven times - so essentially all of it is associates, investment income or
  // revaluation. webapp/CLAUDE.md already demands this test be applied by hand
  // ("is profit growth coming from the CORE business, or from one-offs");
  // this is it in code.
  const revNow = d.revenue?.[0], niNow = ni[0];
  if (revNow > 0 && niNow > 0 && niNow / revNow > 1) {
    parts.valueCreation = Math.max(0, parts.valueCreation - 10);
    flags.push(`net income is ${(niNow/revNow).toFixed(1)}x REVENUE - the earnings are not operating, they are investment or revaluation income`);
  } else if (revNow > 0 && niNow > 0 && niNow / revNow > 0.5) {
    flags.push(`net margin ${(niNow/revNow*100).toFixed(0)}% - unusually high, check for non-operating income`);
  }

  const losses = ni.filter((x) => x < 0).length;
  const rev = (d.revenue ?? []).filter(Number.isFinite);
  let marginTrend = null;
  if (rev.length >= 3 && ni.length >= 3) marginTrend = (ni[0]/rev[0]) - (ni[2]/rev[2]);
  parts.consistency = clamp(15 - losses * 6 + (marginTrend != null && marginTrend < -0.05 ? -4 : 0), 0, 15);
  if (losses) flags.push(`${losses} loss-making period(s) on file`);
  if (marginTrend != null && marginTrend < -0.05) flags.push("net margin compressing materially");

  const score = Object.values(parts).reduce((a, b) => a + b, 0);
  return { score, parts, flags, isBank, roe, growth: g };
}

function entry(t, q) {
  const f = fun[t], m = uni[t];
  const parts = {}, flags = [];
  let fv = null, band = null, mos = null;
  const px = m?.close ?? null;
  try {
    const r = fairValue(t, { price: px });
    fv = r.median; band = r.band;
    if (fv && px) mos = (fv - px) / px * 100;
    if (mos != null && mos > 200) { flags.push(`margin of safety +${mos.toFixed(0)}% is not credible - treating as a data error`); mos = null; fv = null; }
  } catch (e) { flags.push("no valuation: " + e.message.slice(0, 40)); }

  // 1. Margin of safety (0-35)
  parts.marginOfSafety = mos == null ? 0 : mos >= 30 ? 35 : mos >= 15 ? 28 : mos >= 0 ? 20 : mos >= -20 ? 10 : mos >= -40 ? 4 : 0;
  // 2. Do the models agree (0-15) - a big discount nobody agrees on is a coin toss
  parts.agreement = band === "Low" ? 15 : band === "Medium" ? 9 : band === "High" ? 3 : 0;
  // 3. Trend (0-25) from real moving averages
  const c = m?.close, s50 = m?.SMA50, s200 = m?.SMA200;
  if (c && s50 && s200) {
    parts.trend = c > s50 && s50 > s200 ? 25 : c > s200 ? 17 : c > s50 ? 12 : 5;
    if (c < s200) flags.push("below the 200-day");
  } else parts.trend = 8;
  // 4. RSI band (0-10) - the project's own 40-65 entry screen
  const rsi = m?.RSI;
  parts.rsi = rsi == null ? 4 : (rsi >= 40 && rsi <= 65) ? 10 : (rsi >= 35 && rsi < 40) || (rsi > 65 && rsi <= 70) ? 6 : 2;
  if (rsi != null && rsi > 70) flags.push(`RSI ${rsi.toFixed(0)} - extended`);
  // 5. Liquidity and float (0-15)
  const liq = (m?.average_volume_10d_calc ?? 0) * (m?.close ?? 0);
  const fl = (f?.float && f?.sharesOut) ? f.float / f.sharesOut : null;
  parts.liquidity = clamp((liq >= 20e6 ? 9 : liq >= 5e6 ? 7 : liq >= 1e6 ? 4 : 1) + (fl == null ? 3 : fl >= 0.25 ? 6 : fl >= 0.15 ? 4 : fl >= 0.08 ? 2 : 0), 0, 15);
  if (fl != null && fl < 0.10) flags.push(`float only ${(fl*100).toFixed(0)}%`);

  return { score: Object.values(parts).reduce((a,b)=>a+b,0), parts, flags, fv, band, mos, px, rsi,
           aboveMA50: c && s50 ? c > s50 : null, aboveMA200: c && s200 ? c > s200 : null };
}

// A name you cannot actually buy or sell is not an opportunity, however it
// scores. MEGM came top-10 on fundamentals with a 0.7% free float and an RSI of
// exactly 100 - a series of limit-up days on a share count that barely trades.
// These are exclusions, not penalties, because a small deduction still leaves
// them ranked above real businesses.
function investable(t) {
  const f = fun[t], m = uni[t];
  const fl = (f?.float && f?.sharesOut) ? f.float / f.sharesOut : null;
  const liq = (m?.average_volume_10d_calc ?? 0) * (m?.close ?? 0);
  // Float is NOT an exclusion. stockanalysis's EGX float figures are not
  // reliable: they put SWDY (Elsewedy Electric, an EGX30 mega-cap) at 1.4% and
  // ABUK at 6.2%, both of which trade tens of millions of EGP a day. Gating on
  // the field dropped five real banks and two of this portfolio's own tracked
  // names. It stays as a soft deduction inside the liquidity component, where a
  // wrong value costs a few points instead of deleting the company.
  // TURNOVER is the honest test, and it is measured, not reported.
  if (liq < 2e6) return `turnover ${(liq/1e6).toFixed(1)}M EGP/day - too illiquid to enter or exit`;
  if ((m?.RSI ?? 0) > 85) return `RSI ${m.RSI.toFixed(0)} - a limit-up run, not a price`;
  return null;
}

export function scan() {
  const out = [], excluded = [];
  for (const t of Object.keys(fin)) {
    if (!uni[t]) continue;
    const bar = investable(t);
    if (bar) { excluded.push({ t, reason: bar }); continue; }
    const q = quality(t); if (!q) continue;
    const e = entry(t, q);
    out.push({ t, sector: fun[t]?.sector ?? "?", name: fun[t]?.description ?? "",
               quality: q.score, entry: e.score, ...e, qparts: q.parts, qflags: q.flags,
               isBank: q.isBank, roe: q.roe, growth: q.growth });
  }
  scan.excluded = excluded;
  return out;
}

const isMain = process.argv[1] && import.meta.url.endsWith(process.argv[1].split("/").pop());
if (isMain) {
  const rows = scan();
  const i = process.argv.indexOf("--json");
  if (i > 0) writeFileSync(process.argv[i + 1], JSON.stringify(rows, null, 1));
  rows.sort((a, b) => (b.quality + b.entry) - (a.quality + a.entry));
  console.log(`${rows.length} names scored.\n`);
  console.log(`  tkr     QUAL  ENTRY   price    fair   margin  agree   RSI  sector`);
  for (const r of rows.slice(0, parseInt(process.argv[process.argv.indexOf("--top")+1] ?? "30", 10))) {
    console.log(`  ${r.t.padEnd(7)} ${String(r.quality).padStart(4)} ${String(r.entry).padStart(6)} ${(r.px??0).toFixed(2).padStart(8)} ${(r.fv??0).toFixed(2).padStart(8)} ${((r.mos>=0?"+":"")+(r.mos??0).toFixed(0)+"%").padStart(8)} ${String(r.band??"-").padEnd(7)} ${(r.rsi??0).toFixed(0).padStart(4)}  ${String(r.sector).slice(0,22)}`);
  }
}
