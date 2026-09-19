#!/usr/bin/env node
// VOLUME — the one definition of "is this volume unusual?".
//
// ONE JOB: turn a bar's raw volume into a comparable ratio against that same
// bar's recent normal. Nothing else in the repo may average volume inline.
//
// ---------------------------------------------------------------------------
// WHY THIS FILE EXISTS
//
// On 2026-09-19 three different implementations existed, with three windows,
// and two of them were wrong:
//
//   scan-board.mjs:63   rows.slice(-10)    / 10   <- INCLUDED the current bar
//   daily-brief.mjs:81  rows.slice(-11,-1) / 10   <- correct, excluded it
//   spike-news.mjs      full-file mean            <- 2.34M vs 4.10M for ORHD
//
// scan-board's bug is subtle and self-concealing: putting today's bar inside
// its own baseline means a 3x volume day lifts its own denominator, so the
// ratio it reports is systematically too LOW - it under-reports exactly the
// days it exists to catch. spike-news averaged the whole 2,429-bar file, so
// ordinary recent sessions scored ~1.75x and read as spikes.
//
// ---------------------------------------------------------------------------
// WHY 20 SESSIONS
//
// Two independent lines of evidence, and they agree.
//
// MEASURED (2026-09-19, this repo): 45 tickers with 400+ bars, every bar in
// ten years tested. Signal = an up day on >=1.5x volume. Scored on the mean
// 20-session forward return, against the same-window unconditional baseline:
//
//     window   signals   avg fwd   baseline   EDGE
//        5d     13,724     3.54%      2.87%   +0.68pp
//       10d     12,944     3.59%      2.88%   +0.71pp
//       20d     12,324     3.90%      2.85%   +1.04pp
//       30d     12,203     3.92%      2.77%   +1.16pp   <- peak
//       60d     11,777     3.59%      2.69%   +0.89pp
//      120d     11,425     3.45%      2.57%   +0.89pp
//      247d     10,871     3.12%      2.49%   +0.63pp
//
// The edge decays in BOTH directions. Too short and one quiet week makes the
// next ordinary day look like a spike; too long and you are comparing today
// against a company of a different size and liquidity. A full year (+0.63pp)
// is no better than five days (+0.68pp).
//
// CONVENTION: StockCharts' RVOL, TrendSpider, TradingSim and Plus500 all
// describe 10-20 sessions as the standard baseline, with 20 specifically
// called the one that "balances responsiveness with stability". StockCharts'
// own default is a 50-period SMA with 20 the common alternative.
//
// 20 is chosen over the measured peak of 30 deliberately. The gap is 0.12pp -
// inside the noise of a 12,000-sample test - and 20 is what TradingView and
// every screener Mostafa reads will show, so our "1.6x volume" means the same
// thing as theirs. Do not reinvent a private standard for a 0.12pp gain that
// makes every number incomparable with the rest of the market.
//
// SPIKE_WINDOW is deliberately longer. Judging a 2019 bar is a different job
// from judging today: there the baseline must be stable across a decade of
// changing liquidity, not responsive to last month. 60 keeps a decade of
// spikes comparable with each other.

/** Sessions used for the "is today unusual?" baseline. See the note above. */
export const VOLUME_WINDOW = 20;

/** Sessions used when ranking spikes across many years of history. */
export const SPIKE_WINDOW = 60;

/** A move on this much volume or more counts as participation, not drift. */
export const HEAVY = 1.5;

/**
 * Mean volume over the `window` bars ENDING JUST BEFORE `i` - the bar itself
 * is never in its own baseline.
 * @param {Array<{volume:number}>} rows chronological bars
 * @param {number} i index of the bar being judged (default: the last one)
 * @param {number} window sessions to average
 * @returns {number|null} null when there is too little history to be honest
 */
export function baselineVolume(rows, i = rows.length - 1, window = VOLUME_WINDOW) {
  const start = Math.max(0, i - window);
  const n = i - start;
  if (n < Math.min(10, window)) return null;
  return rows.slice(start, i).reduce((a, r) => a + r.volume, 0) / n;
}

/**
 * How many times its own recent normal a bar traded. THE volume number.
 * @returns {number|null} null when the baseline is unavailable or zero
 */
export function relativeVolume(rows, i = rows.length - 1, window = VOLUME_WINDOW) {
  const base = baselineVolume(rows, i, window);
  if (!base) return null;
  return rows[i].volume / base;
}

/** Does this bar clear the participation bar? Used by the breakout rule. */
export function isHeavy(rows, i = rows.length - 1, window = VOLUME_WINDOW) {
  const r = relativeVolume(rows, i, window);
  return r == null ? null : r >= HEAVY;
}

/**
 * The L-27 graded partial-sale size on a level break, keyed off participation.
 * Measured over 780 level breaks 2026-09-17: heavy breaks run 1.32pp further
 * over 20 sessions - real, but small enough that "sell nothing" over-reads it.
 * @returns {{fraction:number, label:string, ratio:number|null}}
 */
export function sellFractionOnBreak(rows, i = rows.length - 1) {
  const r = relativeVolume(rows, i);
  if (r == null) return { fraction: 1 / 3, label: "unknown volume - default third", ratio: null };
  if (r >= HEAVY) return { fraction: 1 / 6, label: "heavy - it may keep running", ratio: r };
  if (r >= 0.8) return { fraction: 1 / 3, label: "normal", ratio: r };
  return { fraction: 1 / 2, label: "thin - the break lacks buyers", ratio: r };
}
