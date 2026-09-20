#!/usr/bin/env node
// "THERE IS NO INDICATOR THAT MAKES ME ENTER OR EXIT" - tested.
//
// From an Ahmed Saeed post Mostafa sent 2026-09-20: price structure plus a
// strong zone plus a reaction candle is enough, and volume/RSI/MA add nothing.
//
// WHAT CANNOT BE TESTED HERE: the reaction candle. Our Open column is the PRIOR
// CLOSE in 96.9-99.9% of bars (see journal/data-gaps.json), so engulfing and
// every other candle-body pattern is uncomputable. That half of his method is
// UNMEASURED, not refuted.
//
// WHAT IS TESTED: the structural half - uptrend + touch of a strong level - and
// then whether adding the indicator he dismisses HELPS or HURTS it.
//
//   node measure-price-action.mjs

import { pathToFileURL } from "url";
import { parseCsv, computeATR } from "./csv-technicals.mjs";
import { priceLevels } from "./price-levels.mjs";
import { csvFileFor, csvPrefix } from "./tickers.mjs";
import { weeklyTrend } from "./lib/trend-filter.mjs";

export const HORIZON = 20;
export const MIN_STRENGTH = 5;

const sma = (c, n, i) => { if (i < n - 1) return null; let s = 0; for (let j = i - n + 1; j <= i; j++) s += c[j]; return s / n; };
const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : null);
const pct = (a, p) => { const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length * p)] ?? null; };

export function run() {
  const arms = {
    "baseline - any bar": [],
    "A. uptrend only (close > MA50)": [],
    "B. at a strong level only": [],
    "C. HIS SETUP: uptrend + strong level": [],
    "D. C + weekly trend up (an indicator)": [],
    "E. C + heavy volume (an indicator)": [],
  };
  let tickers = 0;
  for (const t of Object.keys(csvPrefix)) {
    let rows; try { rows = parseCsv(csvFileFor(t)); } catch { continue; }
    if (rows.length < 400) continue;
    tickers++;
    const c = rows.map((r) => r.close), lo = rows.map((r) => r.low);
    // Level map is rebuilt every 60 bars - rebuilding per bar is too slow and
    // a 60-bar-old map is still only using information available at the time.
    let levels = [], atr = null;
    for (let i = 260; i < c.length - HORIZON; i++) {
      if ((i - 260) % 60 === 0) {
        try { levels = priceLevels(rows.slice(0, i + 1)).levels.filter((l) => l.strength >= MIN_STRENGTH); } catch { levels = []; }
        atr = computeATR(rows.slice(0, i + 1), 14);
      }
      if (!atr) continue;
      const fwd = ((c[i + HORIZON] - c[i]) / c[i]) * 100;
      arms["baseline - any bar"].push(fwd);

      const ma50 = sma(c, 50, i);
      const upTrend = ma50 != null && c[i] > ma50;
      // "at a strong zone": today's low came within 1 ATR of a strength>=5 level
      // that sits at or below price - i.e. price is testing support, not falling
      // through it.
      const atLevel = levels.some((l) => l.price <= c[i] && lo[i] - l.price <= atr && lo[i] >= l.price - atr);

      if (upTrend) arms["A. uptrend only (close > MA50)"].push(fwd);
      if (atLevel) arms["B. at a strong level only"].push(fwd);
      if (upTrend && atLevel) {
        arms["C. HIS SETUP: uptrend + strong level"].push(fwd);
        const w = weeklyTrend(rows.slice(0, i + 1));
        if (w.up === true) arms["D. C + weekly trend up (an indicator)"].push(fwd);
        const av = rows.slice(i - 20, i).reduce((s, r) => s + r.volume, 0) / 20;
        if (av && rows[i].volume / av >= 1.5) arms["E. C + heavy volume (an indicator)"].push(fwd);
      }
    }
  }
  if (!tickers) throw new Error("no tickers loaded - refusing to report on an empty sample");
  return { arms, tickers };
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  const { arms, tickers } = run();
  const base = mean(arms["baseline - any bar"]);
  console.log(`${tickers} tickers, ${HORIZON}-session forward return, levels need strength >= ${MIN_STRENGTH}\n`);
  console.log("setup".padEnd(40) + "     n     mean   vs base   median   worst5%");
  for (const [k, v] of Object.entries(arms)) {
    if (v.length < 30) { console.log(k.padEnd(40) + `  ${String(v.length).padStart(5)}   UNMEASURED (n<30)`); continue; }
    const m = mean(v);
    console.log(k.padEnd(40) + `  ${String(v.length).padStart(5)}  ${m.toFixed(2).padStart(6)}%  ${(m - base >= 0 ? "+" : "") + (m - base).toFixed(2)}pp`.padEnd(70 - 40 + 26) + `  ${pct(v, 0.5).toFixed(2).padStart(6)}%  ${pct(v, 0.05).toFixed(2).padStart(7)}%`);
  }
}
