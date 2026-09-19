#!/usr/bin/env node
// MONEY — the one definition of what a trade costs and what it risks.
//
// ONE JOB per function. Nothing in the repo may write `3.0 + v * 0.00175`
// again, or derive risk as `(last - stop) * units` inline.
//
// ---------------------------------------------------------------------------
// WHY THIS FILE EXISTS
//
// The Thndr fee formula was written out twice - audit-orders.mjs:43 and
// check-consistency.mjs:600 - plus a third time in every throwaway analysis
// script. They happened to agree. That is luck, not design: the fee has
// already been WRONG in this project three separate times ("EGP 2 + 0.1%",
// then "EGP 2 minimum OR 0.1%", then an empirical "+0.29%") before the real
// itemised e-invoice settled it. A formula that has been wrong three times
// and lives in three places will disagree with itself eventually.
//
// Risk was worse than duplicated, it was WRONG. audit-orders computed
// `(last - stop) * units` for a resting BUY order - measuring from today's
// price rather than the price the order would fill at. On 2026-09-19 that
// understated the Sunday book's risk by 87%: 1,098 EGP reported against 2,054
// real, and it let two orders through whose stop sat ABOVE their own entry
// (EFIH stop 22.86 on a 21.69 limit; EXPA 19.52 on a 15.16 limit). See
// riskFor() - it takes an explicit `entry`, and throws rather than return a
// negative number, because a negative risk is not a small error, it is a
// signal that the stop is on the wrong side of the trade.

// ---------------------------------------------------------------------------
// FEES. Itemised from a real Thndr e-invoice 2026-09-08 and reconciled to the
// cent across three fills (ADIB 3,120.00 -> 8.46; ORHD 2,989.00 -> 8.23;
// EFID 2,803.50 -> 7.90).
//   flat 3.00 = Brokerage Order Fees 2.00 + FRA Services 1.00
//   0.175%    = EGX 0.01 + MCDR 0.01 + Risk Insurance 0.005
//                + Trading Damgha 0.05 + Brokerage & Custody 0.10
export const FEE_FLAT = 3.0;
export const FEE_RATE = 0.00175;

/** What Thndr charges on one fill of this value. */
export function thndrFee(value) {
  return FEE_FLAT + Math.abs(value) * FEE_RATE;
}

/**
 * All-in cost as a percentage - the number that makes the flat 3.00 visible.
 * 0.475% on 1,000 · 0.325% on 2,000 · 0.235% on 5,000 · 0.205% on 10,000.
 * This is why tranches under ~2,000 EGP are discouraged.
 */
export function feePct(value) {
  return value ? (thndrFee(value) / value) * 100 : null;
}

/** Cash leaving the account to open a position. */
export function buyCost(entry, units) {
  const gross = entry * units;
  return { gross, fee: thndrFee(gross), total: gross + thndrFee(gross) };
}

/** Cash arriving after closing one. */
export function sellProceeds(exit, units) {
  const gross = exit * units;
  return { gross, fee: thndrFee(gross), net: gross - thndrFee(gross) };
}

// ---------------------------------------------------------------------------
// RISK

/**
 * What this position loses if the stop fills.
 *
 * `entry` is MANDATORY and must be the price the position is (or would be)
 * opened at - the average cost for something held, the LIMIT PRICE for a
 * resting buy order. Never today's spot for an unfilled order.
 *
 * @param {{entry:number, stop:number, units:number, withFees?:boolean}} o
 * @returns {{risk:number, riskPct:number, perUnit:number}}
 * @throws when the stop is not below the entry - see the header note
 */
export function riskFor({ entry, stop, units, withFees = false }) {
  if (!(entry > 0) || !(units > 0)) throw new Error(`riskFor: bad entry/units (${entry}/${units})`);
  if (!(stop < entry)) {
    throw new Error(
      `riskFor: stop ${stop} is not below entry ${entry} - the stop is on the wrong ` +
      `side of the trade. For a resting buy limit, anchor the stop to a level below ` +
      `the LIMIT price, not below spot.`);
  }
  const perUnit = entry - stop;
  let risk = perUnit * units;
  if (withFees) risk += thndrFee(entry * units) + thndrFee(stop * units);
  return { risk, riskPct: (perUnit / entry) * 100, perUnit };
}

/**
 * What it makes at a target. Mirror of riskFor, same entry discipline.
 * @returns {{gain:number, gainPct:number, perUnit:number}}
 */
export function gainFor({ entry, target, units, withFees = false }) {
  if (!(target > entry)) throw new Error(`gainFor: target ${target} is not above entry ${entry}`);
  const perUnit = target - entry;
  let gain = perUnit * units;
  if (withFees) gain -= thndrFee(entry * units) + thndrFee(target * units);
  return { gain, gainPct: (perUnit / entry) * 100, perUnit };
}

/**
 * Reward-to-risk. Reported alongside risk everywhere, because a big number on
 * its own says nothing: ORHD's T1 pays 214 EGP against 1,729 of risk (0.6),
 * which is only visible when the two are divided.
 */
export function rewardToRisk({ entry, stop, target, units = 1 }) {
  const r = riskFor({ entry, stop, units });
  const g = gainFor({ entry, target, units });
  return g.gain / r.risk;
}

/**
 * Units that put a chosen EGP amount at stake - the sizing rule from
 * webapp/CLAUDE.md section C: cap RISK per position, never position value.
 * ORHD is 40% of the stock sleeve but risks 1,729; EFID is 2% and risks 43.
 * Position value alone is the wrong unit.
 */
export function unitsForRisk({ entry, stop, riskBudget }) {
  if (!(stop < entry)) throw new Error(`unitsForRisk: stop ${stop} not below entry ${entry}`);
  return Math.floor(riskBudget / (entry - stop));
}
