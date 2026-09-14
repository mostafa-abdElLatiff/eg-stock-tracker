#!/usr/bin/env node
// Where buyers and sellers actually transacted - and what is behind each level
// if it breaks.
//
// WHAT THIS ADDS, AND WHY IT WAS MISSING. Levels were being derived from
// `findSwings` alone: a 5-bar pivot is a real reversal point, but on its own it
// says nothing about how much stock changed hands there, how many times the
// level was defended, or what sits beyond it. Three consequences:
//
//   * A level touched once was treated like one defended five times.
//   * A level with almost no volume behind it counted the same as one where a
//     tenth of the year's turnover happened.
//   * "If the stop breaks, then what?" had no answer at all - the ETEL note
//     about an equal-low cluster below 110 was written by hand, once, and
//     nothing computed it for any other name.
//
// METHOD
//  1. Find every swing high and low (5-bar pivots).
//  2. CLUSTER them: two pivots within 0.75x ATR are the same level, because a
//     market does not defend a price to the piaster. Cluster strength is the
//     number of distinct touches.
//  3. VOLUME AT PRICE: split the year into price buckets and total the volume
//     of every bar whose range covers each bucket. Where the most stock traded
//     is where the most holders have a cost basis, and those are the prices
//     people defend or capitulate at.
//  4. POLARITY: a level that was resistance and is now below the price has
//     flipped to support, and vice versa. Flipped levels are the strongest.
//  5. WHAT IS BEHIND IT: for each level, the next one down and up, so a break
//     has a stated destination rather than open air.
//
// Usage: node price-levels.mjs TICKER [--csv path] [--bars 250]

import { readFileSync, readdirSync } from "fs";
import { parseCsv, computeATR, findSwings } from "./csv-technicals.mjs";
import { clusterPivots, assertValid } from "./cluster-levels.mjs";
import { csvFileFor } from "./tickers.mjs";

const ROOT = new URL("../../", import.meta.url).pathname;

export function priceLevels(rows, opts = {}) {
  const atr = computeATR(rows, 14);
  const last = rows[rows.length - 1].close;
  const tol = atr * (opts.tolATR ?? 0.75);
  const { highs, lows } = findSwings(rows, 5);

  // --- cluster pivots into levels
  const pivots = [...highs.map((h) => ({ ...h, kind: "high" })), ...lows.map((l) => ({ ...l, kind: "low" }))]
    .sort((a, b) => a.price - b.price);
  // Complete-linkage clustering, width-capped at tol. The previous inline
  // single-linkage loop CHAINED: it compared each pivot to the last one added,
  // so clusters grew without bound. Measured 2026-09-14, it exceeded its own
  // tolerance on every name tested - MASR 2x, COMI 4x, ARCC 8x, AMOC 20x - so
  // a "level" was often a blob many times wider than one ATR. See cluster-levels.mjs.
  const clusters = clusterPivots(pivots, tol);
  assertValid(clusters, tol, "priceLevels");

  // --- volume at price, over the same window
  const allLow = Math.min(...rows.map((r) => r.low)), allHigh = Math.max(...rows.map((r) => r.high));
  const BUCKETS = 60;
  const step = (allHigh - allLow) / BUCKETS;
  const vol = new Array(BUCKETS).fill(0);
  for (const r of rows) {
    const a = Math.max(0, Math.floor((r.low - allLow) / step));
    const b = Math.min(BUCKETS - 1, Math.floor((r.high - allLow) / step));
    const n = b - a + 1;
    // Spread each bar's volume evenly across the buckets its range covers -
    // daily bars cannot say where within the range the trading happened.
    for (let i = a; i <= b; i++) vol[i] += r.volume / n;
  }
  const totalVol = vol.reduce((x, y) => x + y, 0);
  const volNear = (price) => {
    const i = Math.min(BUCKETS - 1, Math.max(0, Math.floor((price - allLow) / step)));
    const share = (vol[i] + (vol[i - 1] ?? 0) + (vol[i + 1] ?? 0)) / totalVol;
    return share * 100;
  };

  const levels = clusters.map((c) => {
    const price = c.prices.reduce((a, b) => a + b, 0) / c.prices.length;
    const wasHigh = c.kinds.filter((k) => k === "high").length;
    const wasLow = c.kinds.filter((k) => k === "low").length;
    return {
      price: +price.toFixed(2),
      touches: c.prices.length,
      firstSeen: c.dates.slice().sort()[0],
      lastSeen: c.dates.slice().sort().pop(),
      // A level acting as BOTH a ceiling and a floor over time is the strongest
      // kind - the market has agreed on it from both directions.
      flipped: wasHigh > 0 && wasLow > 0,
      role: price < last ? "support" : "resistance",
      volPct: +volNear(price).toFixed(1),
      distPct: +(((price - last) / last) * 100).toFixed(2),
      distATR: +(((price - last) / atr)).toFixed(2),
    };
  }).sort((a, b) => a.price - b.price);

  // strength: touches, a polarity flip, and the volume transacted there
  for (const l of levels) {
    l.strength = Math.min(5, l.touches) + (l.flipped ? 2 : 0) + (l.volPct >= 8 ? 2 : l.volPct >= 4 ? 1 : 0);
  }
  // what is behind each level if it gives way
  levels.forEach((l, i) => {
    l.nextBelow = i > 0 ? levels[i - 1].price : null;
    l.nextAbove = i < levels.length - 1 ? levels[i + 1].price : null;
  });

  return { last, atr, levels, highestVolumePrice: +(allLow + (vol.indexOf(Math.max(...vol)) + 0.5) * step).toFixed(2) };
}

// ---------------------------------------------------------------- CLI
const isMain = process.argv[1] && import.meta.url.endsWith(process.argv[1].split("/").pop());
if (isMain) {
  const ticker = (process.argv[2] || "").toUpperCase();
  const csvArg = process.argv.includes("--csv") ? process.argv[process.argv.indexOf("--csv") + 1] : null;
  // ticker -> file now comes from the ONE registry, tickers.mjs
  const rows = csvArg ? parseCsv(csvArg) : parseCsv(csvFileFor(ticker));
  const { last, atr, levels, highestVolumePrice } = priceLevels(rows);
  console.log(`${ticker || csvArg}  close ${last}  ATR ${atr.toFixed(2)} (${(atr / last * 100).toFixed(1)}%)  ${rows.length} bars`);
  console.log(`Heaviest trading of the year happened around ${highestVolumePrice} - the price most holders have a basis near.\n`);
  console.log("  price    role        away    touches flip  vol%  strength   if it breaks ->");
  for (const l of levels) {
    if (Math.abs(l.distPct) > 30) continue;
    const arrow = l.role === "support" ? `next support ${l.nextBelow ?? "NOTHING - open air"}` : `next resistance ${l.nextAbove ?? "NOTHING - open air"}`;
    console.log(`  ${String(l.price).padStart(7)}  ${l.role.padEnd(11)} ${(l.distPct >= 0 ? "+" : "") + l.distPct + "%"} ${(l.distATR >= 0 ? "+" : "") + l.distATR}x ${String(l.touches).padStart(4)}  ${l.flipped ? "YES " : "  - "} ${String(l.volPct).padStart(5)} ${String(l.strength).padStart(6)}     ${arrow}`);
  }
  console.log(`\nstrength = touches (max 5) + 2 if the level flipped between support and resistance + up to 2 for volume traded there.`);
}
