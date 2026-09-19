// EXIT PLAN — the one definition of what to sell at each target, and what
// happens to the stop afterwards.
//
// ONE JOB. Browser-safe on purpose: no fs, no node built-ins, so src/ and
// scripts/ import the SAME function rather than keeping two versions that
// drift. analysis-chart.js used to define its own `targetPlan` and the server
// had no equivalent at all, which is how an untested stop rule came to be
// running in the browser where nothing could see it.
//
// ---------------------------------------------------------------------------
// WHY THE STOP NO LONGER MOVES — measured 2026-09-19
//
// The old browser version emitted a `newStop` column:
//
//   newStop: i === 0 ? (avgCost ?? data.support ?? data.stop) : targets[i-1]
//
// i.e. move to BREAKEVEN after target 1, then trail to the previous target.
// Neither had ever been tested. Both were tested across 219 heavy-volume
// breakouts on 45 EGX tickers over a 60-session horizon:
//
//   policy                 avg return   % positive   worst decile   stopped out
//   hold, no stop              7.45%        55.3%       -18.60%            -
//   FIXED stop (stopFor)       4.34%        29.2%        -7.85%        68.9%
//   ratchet to broken level    4.25%        29.2%        -7.74%        70.8%
//   trail under 20-day low     3.77%        32.4%        -7.20%        86.8%
//   MOVE TO BREAKEVEN          2.95%        17.8%        -7.10%        82.2%
//
// Breakeven was the WORST of six. It parks the stop exactly where price
// routinely returns after a partial sale, converting winners into scratches:
// only 17.8% of positions finished positive against 29.2% leaving the stop
// alone. Trailing to the previous target is the same mistake one rung up.
//
// So: the stop set by stopFor() stays where it is. It moves only when the
// MARKET moves - a new level forming below, not a target being reached. This
// also matches the L-26 finding that every tested exit rule loses to holding.
//
// The popular advice (Capital.com, FXOpen, EBC all recommend "move to
// breakeven" and "trail by 1 ATR") is what we measured and rejected. Regime
// caveat, same as L-26: 2016-2026 on the EGX is one long devaluation bull
// market, which punishes systematic selling almost by construction.

import { sellFractionOnBreak } from "./volume.mjs";

/**
 * Default sell sizing by rung count. A CONVENTION, not a measured result -
 * unlike sellFractionOnBreak() in ./volume.mjs, which is graded by volume and
 * was measured over 780 level breaks (L-27). When a card carries a real
 * volume read at the moment of the break, that function is the better answer
 * and this is the fallback for a plan written in advance.
 */
const PCT_BY_COUNT = { 1: [70], 2: [35, 50], 3: [25, 30, 30], 4: [20, 20, 25, 20] };

/**
 * @param {{targets?:number[], sellPcts?:number[], stop?:number|null, entry?:number|null}} data
 * @param {{rows?:Array}} [opts] pass `rows` to size rung 1 by MEASURED volume
 * @returns {Array<{price, sellPct, stopAfter, stopNote, sizing, rMultiple}>}
 */
export function exitPlan(data, opts = {}) {
  const targets = data?.targets || [];
  const n = targets.length;
  if (!n) return [];
  // sellPcts is a per-ticker override for when the default ladder does not fit
  // - e.g. MASR: target 1 cut to 20% (RSI 75, already extended) with the freed
  // 15% moved to the trailing remainder rather than target 2.
  const pcts = data.sellPcts || PCT_BY_COUNT[n] || targets.map(() => Math.round(100 / n));
  const stop = data.stop ?? null;
  // Rung 1 prefers the MEASURED rule over the convention. sellFractionOnBreak()
  // is graded by the volume the level broke on and was measured over 780 breaks
  // (L-27); PCT_BY_COUNT is a convention with no evidence behind it. Two sell-
  // sizing rules existed side by side until 2026-09-20 - this is which one wins.
  const graded = opts.rows ? sellFractionOnBreak(opts.rows) : null;
  // R-multiple: how far each rung sits in units of the INITIAL RISK. The
  // professional framing (FOREX.com, Metriclan) sizes targets as 1R/2R/3R
  // rather than as raw prices, because a rung under 1R cannot pay for the stop.
  const entry = data.entry ?? null;
  const R = entry && stop && stop < entry ? entry - stop : null;
  return targets.map((price, i) => ({
    price,
    sellPct: i === 0 && graded ? Math.round(graded.fraction * 100) : pcts[i],
    sizing: i === 0 && graded ? `measured: ${graded.label} (${graded.ratio?.toFixed(2)}x volume)` : "convention by rung count",
    rMultiple: R ? +((price - entry) / R).toFixed(2) : null,
    stopAfter: stop,
    stopNote: i === 0
      ? "Stop unchanged. Moving it to breakeven here was measured as the worst of six policies - 82.2% stopped out, 17.8% positive."
      : "Stop unchanged. Trailing to the previous target stops you out more often than it protects.",
  }));
}

/** Shares to sell at a rung, given a holding. Rounds down - never oversell. */
export function sharesAtRung(rung, units) {
  return Math.floor((units * rung.sellPct) / 100);
}
