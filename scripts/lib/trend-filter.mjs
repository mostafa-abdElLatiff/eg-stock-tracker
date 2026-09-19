// TREND FILTER - the higher-timeframe veto, and the "is this dip buyable" rule.
//
// ONE JOB EACH. Nothing here ranks anything; these are GATES. Three separate
// backtests (2026-09-19) showed no ranking beats equal-weighting the board, so
// this module deliberately returns booleans, not scores.
//
// ---------------------------------------------------------------------------
// WHY - MEASURED, not adopted on authority
//
// From Ahmed Nashy's EGX technical-analysis course, tested against our own ten
// years of bars before anything was written here (CLAUDE.md rule 11).
//
// 1. WEEKLY VETO. Forward return vs the all-bars baseline, 23,351 samples:
//
//      signal                          +20d     +60d    +120d      n
//      daily uptrend, no weekly check  -0.17pp  -0.24pp -0.29pp   7,932
//      daily uptrend + WEEKLY UP       +0.21pp  +1.62pp +2.91pp   5,244
//      daily uptrend but WEEKLY DOWN   -0.91pp  -3.87pp -6.52pp   2,688
//
//    A daily uptrend on its own is worth NOTHING. The same daily uptrend is
//    worth +2.91pp confirmed by the weekly and -6.52pp contradicted by it - a
//    9.4pp spread at the horizon Mostafa actually holds. This is the single
//    largest measured effect found in the whole course.
//
//    It is a TIMING gate, not a stock picker: when the composite built from it
//    was used to RANK names cross-sectionally it performed worse than not
//    ranking at all. Use it to exclude, never to order.
//
// 2. DIP-BUYABLE RULE. His claim, which measured out: if the rally leg into a
//    pullback failed to push RSI above 70, the pullback is not the one to buy -
//    wait for a breakout instead. Related finding that corrects US, not him:
//    our own "avoid RSI > 70, it is overextended" screen was backwards. Forward
//    20d, uptrends only: RSI 40-65 returned 2.88% (n=36,103) while RSI > 70
//    returned 3.69% (n=8,154). We were filtering out the better band. The win
//    RATE is lower up there (50%/42% vs 53%), so it is a real trade-off, not a
//    free lunch - but the hard exclusion was costing us.
//
// CAVEAT worth keeping: 2016-2026 on the EGX is one long devaluation bull
// market. Every number above is measured inside that regime.

import { rsiWilder } from "../csv-technicals.mjs";

// Weekly lookbacks. 21 and 55 rather than 20/50 because that is what the
// measurement above used; changing them invalidates the numbers in this header.
export const WEEKLY_FAST = 21;
export const WEEKLY_SLOW = 55;
// The rally-strength floor. 70 is Wilder's conventional overbought line and the
// level the dip-buyable test was measured against.
export const RALLY_RSI_FLOOR = 70;
// How far back to look for the rally peak that precedes the current pullback.
export const RALLY_LOOKBACK = 25;

/**
 * Daily bars -> weekly bars. EGX trades Sun-Thu, so weeks are bucketed on the
 * Sunday that opens them. Volume sums; high/low extend; close is the last close.
 */
export function toWeekly(rows) {
  const out = [];
  let cur = null;
  for (const r of rows) {
    const d = new Date(r.date + "T00:00:00Z");
    const wk = new Date(d);
    wk.setUTCDate(d.getUTCDate() - (d.getUTCDay() % 7));
    const key = wk.toISOString().slice(0, 10);
    if (!cur || cur.date !== key) {
      cur = { date: key, open: r.open, high: r.high, low: r.low, close: r.close, volume: r.volume };
      out.push(cur);
    } else {
      cur.high = Math.max(cur.high, r.high);
      cur.low = Math.min(cur.low, r.low);
      cur.close = r.close;
      cur.volume += r.volume;
    }
  }
  return out;
}

/**
 * THE VETO. Is the weekly picture up? Returns `null` when there is not enough
 * history to say - callers must treat null as "unknown", never as "yes".
 */
export function weeklyTrend(rows) {
  const w = toWeekly(rows);
  if (w.length < WEEKLY_SLOW + 5) {
    return { up: null, why: `only ${w.length} weekly bars, need ${WEEKLY_SLOW + 5} - UNKNOWN, do not treat as a pass` };
  }
  const c = w.map((r) => r.close);
  const fast = c.slice(-WEEKLY_FAST).reduce((a, b) => a + b, 0) / WEEKLY_FAST;
  const slow = c.slice(-WEEKLY_SLOW).reduce((a, b) => a + b, 0) / WEEKLY_SLOW;
  const px = c[c.length - 1];
  const up = px > fast && fast > slow;
  return {
    up, close: px, fast, slow, weeks: w.length,
    why: up
      ? `weekly ${px.toFixed(2)} > MA${WEEKLY_FAST} ${fast.toFixed(2)} > MA${WEEKLY_SLOW} ${slow.toFixed(2)}`
      : `weekly ${px.toFixed(2)} vs MA${WEEKLY_FAST} ${fast.toFixed(2)} / MA${WEEKLY_SLOW} ${slow.toFixed(2)} - NOT confirmed`,
  };
}

/**
 * Was the rally leg into this pullback strong enough that the dip is worth
 * buying? Measured: if RSI never cleared 70 on the way up, wait for a breakout
 * instead of buying the dip.
 */
export function dipBuyable(rows) {
  const closes = rows.map((r) => r.close);
  if (closes.length < 220) return { buyable: null, why: "need ~220 bars for a stable Wilder RSI series" };
  let peak = 0;
  for (let i = closes.length - RALLY_LOOKBACK; i < closes.length; i++) {
    const v = rsiWilder(closes.slice(0, i + 1));
    if (v != null && v > peak) peak = v;
  }
  const buyable = peak >= RALLY_RSI_FLOOR;
  return {
    buyable, peak,
    why: buyable
      ? `rally cleared RSI ${RALLY_RSI_FLOOR} (peak ${peak.toFixed(1)}) - a pullback here is buyable`
      : `rally peaked at RSI ${peak.toFixed(1)}, never cleared ${RALLY_RSI_FLOOR} - do NOT buy this dip, wait for a breakout`,
  };
}
