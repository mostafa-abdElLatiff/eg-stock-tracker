#!/usr/bin/env node
// Turns market-scan.mjs into the four answers actually asked for: the best
// business in each sector, the best ENTRY in each sector, the overall winners,
// and picks by holding horizon.
//
// The horizons are not three flavours of the same list. Each one is decided by
// a different thing, because over different periods different things dominate:
//
//   SHORT   4-12 weeks   (~20-60 EGX sessions, Sun-Thu)
//           Decided by TREND and liquidity. Over two months a business does not
//           change; the tape does. Requires price above both the 50- and 200-day
//           and an RSI with room to run. Quality is a floor here, not a driver -
//           it only has to be not-broken.
//
//   MEDIUM  6-18 months
//           Decided by the VALUATION GAP plus earnings actually arriving to
//           close it. Needs a real margin of safety AND growth, because a gap
//           with no earnings behind it just stays a gap.
//
//   LONG    3-5 years
//           Decided by COMPOUNDING: return on equity sustained above the cost of
//           equity, cash conversion that proves the profits are real, and a
//           balance sheet that survives. Entry price matters least here - it is
//           the one horizon where paying up for quality is defensible.
//
// Usage: node market-report.mjs

import { scan } from "./market-scan.mjs";

const rows = scan();
const ex = scan.excluded ?? [];
const f2 = (x, d = 2) => (x == null ? "  -  " : x.toFixed(d));
const pct = (x) => (x == null ? "   - " : `${x >= 0 ? "+" : ""}${x.toFixed(0)}%`);
const line = (r, extra = "") =>
  `  ${r.t.padEnd(6)} Q${String(r.quality).padStart(3)} E${String(r.entry).padStart(3)}  ${f2(r.px).padStart(8)} ${f2(r.fv).padStart(8)} ${pct(r.mos).padStart(6)} ${String(r.band ?? "-").padEnd(6)} RSI${String(Math.round(r.rsi ?? 0)).padStart(3)}  ${extra}`;

console.log(`EGX FULL-MARKET SCAN - ${rows.length} investable names with real statements`);
console.log(`${ex.length} excluded as un-investable: ${ex.map((e) => e.t).join(" ")}`);
console.log(`Q = business quality /100 (fundamentals only).  E = entry attractiveness /100 (valuation + trend).`);
console.log(`Fair values use today's real EGP rates (risk-free 18%), so margins skew negative by construction.\n`);

// ---------------- by sector
const bySec = {};
for (const r of rows) (bySec[r.sector] ||= []).push(r);
console.log("=".repeat(100));
console.log("BEST BUSINESS AND BEST ENTRY IN EACH SECTOR");
console.log("=".repeat(100));
for (const [sec, list] of Object.entries(bySec).sort((a, b) => b[1].length - a[1].length)) {
  if (list.length < 2) continue;
  const bestQ = [...list].sort((a, b) => b.quality - a.quality)[0];
  const bestE = [...list].sort((a, b) => b.entry - a.entry)[0];
  console.log(`\n${sec}  (${list.length} names)`);
  console.log(line(bestQ, `<- best business`));
  if (bestE.t !== bestQ.t) console.log(line(bestE, `<- best entry`));
  else console.log(`         (same name is both)`);
}

// ---------------- overall
console.log(`\n${"=".repeat(100)}\nOVERALL\n${"=".repeat(100)}`);
const topQ = [...rows].sort((a, b) => b.quality - a.quality).slice(0, 6);
const topE = [...rows].sort((a, b) => b.entry - a.entry).slice(0, 6);
console.log(`\nBEST BUSINESSES on the exchange (quality, ignoring price):`);
topQ.forEach((r) => console.log(line(r, r.sector)));
console.log(`\nBEST ENTRIES right now (price and trend, whatever the business):`);
topE.forEach((r) => console.log(line(r, r.sector)));

// ---------------- horizons
const ok = (r) => r.quality >= 55;
// Rank each horizon by what DECIDES it, not by the blended entry score. Sorting
// the short list by `entry` made it identical to the medium list, because
// marginOfSafety is 35 of those 100 points - i.e. the "technical" list was being
// chosen on valuation. Over 4-12 weeks valuation does essentially nothing.
const technical = (r) => r.parts.trend + r.parts.rsi + r.parts.liquidity;   // 50 pts, no valuation
const short = rows.filter((r) => ok(r) && r.aboveMA50 && r.aboveMA200 && r.rsi >= 45 && r.rsi <= 68)
  .sort((a, b) => technical(b) - technical(a) || b.quality - a.quality).slice(0, 5);
// Medium is the gap AND the earnings that close it - weight both, not quality alone.
const medium = rows.filter((r) => r.mos != null && r.mos > -15 && (r.growth ?? 0) > 0.10 && r.quality >= 60)
  .sort((a, b) => (b.mos / 2 + (b.growth ?? 0) * 100 + b.quality / 2) - (a.mos / 2 + (a.growth ?? 0) * 100 + a.quality / 2)).slice(0, 5);
const long = rows.filter((r) => r.roe > 0.25 && r.qparts.cashConversion >= 14 && r.qparts.balance >= 8)
  .sort((a, b) => b.quality - a.quality).slice(0, 5);

console.log(`\n${"=".repeat(100)}\nBY HOLDING HORIZON\n${"=".repeat(100)}`);
console.log(`\nSHORT TERM - 4 to 12 weeks (~20-60 EGX sessions). Decided by trend, not by the business.`);
console.log(`  Gate: above the 50- AND 200-day, RSI 45-68, quality at least 55 (not broken), investable.`);
  console.log(`  Ranked on trend + RSI + liquidity ONLY - valuation is deliberately excluded at this horizon.`);
short.forEach((r) => console.log(line(r, r.sector)));
console.log(`\nMEDIUM TERM - 6 to 18 months. Decided by the valuation gap AND earnings arriving to close it.`);
console.log(`  Gate: margin of safety better than -15%, earnings CAGR over 10%, quality at least 60.`);
medium.forEach((r) => console.log(line(r, r.sector)));
console.log(`\nLONG TERM - 3 to 5 years. Decided by compounding: ROE above the cost of equity, real cash, sound balance sheet.`);
console.log(`  Gate: ROE over 25%, cash conversion 14+/25, balance sheet 8+/15.`);
long.forEach((r) => console.log(line(r, r.sector)));
