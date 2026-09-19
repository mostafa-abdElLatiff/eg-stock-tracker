#!/usr/bin/env node
// DOES A MOVING AVERAGE CARRY INFORMATION ON EGX? Reproduces L-38.
//
// Written 2026-09-20 because Mostafa asked whether MA20 should be a selling
// point and whether MA50 should be added too. Saved here rather than run in a
// scratch directory - that is L-36, and repeating it in the same session as
// writing it would be absurd. Re-run this to check the answer still holds:
//
//   node measure-ma.mjs
//
// THE ANSWER, as of 2026-09-20: a moving average is CONTEXT, never a TRIGGER.
// The regime read (above/below) is worth ~0.8pp of forward return. The touch
// event carries nothing - the break slightly OUTPERFORMS the hold, and both
// underperform doing nothing. As an exit it buys the best tail on the board and
// pays 17pp of mean return for it.
//
// Third convention to fail on this market after "move to breakeven" and the
// RSI 40-65 screen. Rule 11: check the convention before adopting it.

import { pathToFileURL } from "url";
import { parseCsv, computeATR } from "./csv-technicals.mjs";
import { priceLevels } from "./price-levels.mjs";
import { csvFileFor, csvPrefix } from "./tickers.mjs";

export const PERIODS = [20, 50];
export const HORIZON = 20;   // sessions forward, matches every other test here
export const MAX_HOLD = 250; // cap on the exit simulation

const sma = (c, n, i) => { if (i < n - 1) return null; let s = 0; for (let j = i - n + 1; j <= i; j++) s += c[j]; return s / n; };
const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : null);
const pct = (a, p) => { const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length * p)] ?? null; };

function load() {
  const out = [];
  for (const t of Object.keys(csvPrefix)) {
    try { const rows = parseCsv(csvFileFor(t)); if (rows.length >= 400) out.push([t, rows]); } catch { /* no csv */ }
  }
  if (!out.length) throw new Error("no tickers loaded - refusing to report a measurement on an empty sample");
  return out;
}

/** Regime and touch/break behaviour for each MA period. */
export function regimeAndTouch(data = load()) {
  const res = {};
  for (const P of PERIODS) res[P] = { hold: 0, broke: 0, holdFwd: [], breakFwd: [], above: [], below: [], base: [] };
  for (const [, rows] of data) {
    const c = rows.map((r) => r.close), lo = rows.map((r) => r.low);
    for (const P of PERIODS) {
      const r = res[P];
      for (let i = P + 5; i < c.length - HORIZON; i++) {
        const m = sma(c, P, i), mPrev = sma(c, P, i - 1);
        if (m == null || mPrev == null) continue;
        const fwd = ((c[i + HORIZON] - c[i]) / c[i]) * 100;
        r.base.push(fwd);
        (c[i] > m ? r.above : r.below).push(fwd);
        if (c[i - 1] > mPrev && lo[i] <= m) {
          if (c[i] >= m) { r.hold++; r.holdFwd.push(fwd); } else { r.broke++; r.breakFwd.push(fwd); }
        }
      }
    }
  }
  return res;
}

/** Same entries, different exits. Only the exit rule differs between arms. */
export function exitComparison(data = load()) {
  const arms = { "MA20 close-below": [], "MA50 close-below": [], "1 ATR below support (ours)": [], "hold 60 sessions": [], "no stop at all": [] };
  for (const [, rows] of data) {
    if (rows.length < 700) continue;
    const c = rows.map((r) => r.close), lo = rows.map((r) => r.low);
    for (let i = 300; i < c.length - MAX_HOLD; i += 25) { // stride 25 so trades barely overlap
      const entry = c[i];
      const run = (test) => {
        for (let j = i + 1; j < Math.min(i + MAX_HOLD, c.length); j++) { const e = test(j); if (e != null) return ((e - entry) / entry) * 100; }
        return ((c[Math.min(i + MAX_HOLD, c.length) - 1] - entry) / entry) * 100;
      };
      arms["MA20 close-below"].push(run((j) => { const m = sma(c, 20, j); return m != null && c[j] < m ? c[j] : null; }));
      arms["MA50 close-below"].push(run((j) => { const m = sma(c, 50, j); return m != null && c[j] < m ? c[j] : null; }));
      try {
        const atr = computeATR(rows.slice(0, i + 1), 14);
        const below = priceLevels(rows.slice(0, i + 1)).levels.filter((l) => l.price < entry).sort((a, b) => b.price - a.price);
        const s = below.find((l) => l.strength >= 5) ?? below[0];
        if (s) arms["1 ATR below support (ours)"].push(run((j) => (lo[j] <= s.price - atr ? s.price - atr : null)));
      } catch { /* no level map */ }
      arms["hold 60 sessions"].push(((c[Math.min(i + 60, c.length - 1)] - entry) / entry) * 100);
      arms["no stop at all"].push(((c[Math.min(i + MAX_HOLD, c.length) - 1] - entry) / entry) * 100);
    }
  }
  return arms;
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  const data = load();
  const f = (x) => (x == null ? "  -  " : (x >= 0 ? "+" : "") + x.toFixed(2) + "%");
  console.log(`universe: ${data.length} tickers with >=400 bars, horizon ${HORIZON} sessions\n`);
  const res = regimeAndTouch(data);
  for (const P of PERIODS) {
    const r = res[P], tot = r.hold + r.broke;
    console.log(`--- MA${P} ---`);
    console.log(`  baseline (any bar)   n=${String(r.base.length).padStart(6)}  fwd ${f(mean(r.base))}`);
    console.log(`  price ABOVE          n=${String(r.above.length).padStart(6)}  fwd ${f(mean(r.above))}`);
    console.log(`  price BELOW          n=${String(r.below.length).padStart(6)}  fwd ${f(mean(r.below))}`);
    console.log(`  REGIME SPREAD                       ${f(mean(r.above) - mean(r.below))}`);
    console.log(`  touched from above: HELD ${r.hold} (${((r.hold / tot) * 100).toFixed(1)}%)  BROKE ${r.broke} (${((r.broke / tot) * 100).toFixed(1)}%)`);
    console.log(`    after HOLD         n=${String(r.holdFwd.length).padStart(6)}  fwd ${f(mean(r.holdFwd))}`);
    console.log(`    after BREAK        n=${String(r.breakFwd.length).padStart(6)}  fwd ${f(mean(r.breakFwd))}`);
    console.log(`    TRIGGER EDGE hold-break             ${f(mean(r.holdFwd) - mean(r.breakFwd))}  <- negative means the MA break is NOT a sell signal\n`);
  }
  const arms = exitComparison(data);
  console.log("exit rule".padEnd(30) + "  n     mean    median   worst5%   %losing");
  for (const [k, v] of Object.entries(arms)) {
    console.log(k.padEnd(30) + `  ${String(v.length).padStart(4)}  ${mean(v).toFixed(2).padStart(6)}%  ${pct(v, 0.5).toFixed(2).padStart(6)}%  ${pct(v, 0.05).toFixed(2).padStart(7)}%  ${((v.filter((x) => x < 0).length / v.length) * 100).toFixed(0).padStart(5)}%`);
  }
}
