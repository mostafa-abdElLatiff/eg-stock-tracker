#!/usr/bin/env node
// THE stop rule. One definition, imported everywhere.
//
// WHY THIS FILE EXISTS. Until 2026-09-14 no shared stop function existed:
// each session's script derived stops inline with whatever constants got typed
// that day. On 14 Sept a fresh all-names pass silently moved every held stop,
// because it re-picked the multiplier (0.5 -> 1.0 ATR) and the level-selection
// rule (nearest -> strongest within 20%) rather than reading what the previous
// rule had been. TMGH's risk went 199 -> 518 EGP with no change in price or
// structure. A stop must only move when the MARKET moves. Constants live here,
// named, with their evidence, so changing one is a visible edit to a tracked
// file instead of a keystroke inside a throwaway script.
//
// THE TWO CONSTANTS, AND WHY THEY ARE WHAT THEY ARE
//
// ATR_BELOW = 1.0
//   A level is a ZONE, not a price: priceLevels clusters pivots with a width
//   cap of 0.75x ATR, so a cluster's own half-width reaches 0.375 ATR. A stop
//   half an ATR under the cluster CENTRE therefore sits only ~0.125 ATR clear
//   of the zone's lower edge - inside the level's own noise. Measured over 20
//   sessions on 2026-09-14, the 0.5x stops were being hit 58-74% of the time
//   (TMGH 74%, RAYA 72%, EFID 65%); at 1.0x that falls to 40-65%. A stop that
//   fires three times in four inside a month is a scheduled exit, not
//   protection. This also matches the maker/volume finding of the same day:
//   orders parked just under an obvious level are the ones that get swept.
//
// MIN_STRENGTH = 5
//   Anchor to a level the market has actually defended. Strength counts
//   touches (capped at 5), +2 for a support/resistance polarity flip, and up
//   to +2 for volume transacted there. Below 5 the "level" is often a single
//   pivot - TMGH's 95.17 had 3 touches and no flip, and anchoring to it put
//   the stop 2.6x closer than the genuine floor at 91.66 (4 touches, flipped).
//
// RELEVANCE = 0.20
//   Same bound level-map-refresh.mjs already uses. A "floor" 30% below spot
//   is not protecting this position, and anchoring to it produces a stop so
//   wide it is indistinguishable from having none. When nothing qualifies
//   inside the bound, fall back to the NEAREST level and say so - never
//   silently reach past the bound for a strong-but-distant level, which is
//   how ADIB drew a 24.64 floor against a 51.40 price.

export const ATR_BELOW = 1.0;
export const MIN_STRENGTH = 5;
export const RELEVANCE = 0.20;

/**
 * @param {{last:number, atr:number, levels:Array}} map  output of priceLevels()
 * @returns {{level:object, stop:number, basis:string}|null}
 */
export function stopFor(map, opts = {}) {
  const atrBelow = opts.atrBelow ?? ATR_BELOW;
  const minStrength = opts.minStrength ?? MIN_STRENGTH;
  const relevance = opts.relevance ?? RELEVANCE;
  const { last, atr, levels } = map;

  const below = levels.filter((l) => l.price < last).sort((a, b) => b.price - a.price);
  if (!below.length) return null;

  const inBound = below.filter((l) => (last - l.price) / last <= relevance);
  const strong = inBound.find((l) => l.strength >= minStrength);
  // Degrade in one direction only: weaker level, never a more distant one.
  const level = strong ?? inBound.find((l) => l.strength >= 4) ?? inBound[0] ?? below[0];
  const basis = strong ? `strength ${level.strength} floor`
    : inBound.length ? `WEAK floor (strength ${level.strength}) - nothing at ${minStrength}+ within ${relevance * 100}%`
    : `NO floor within ${relevance * 100}% - nearest level is ${((last - level.price) / last * 100).toFixed(1)}% away`;

  return { level, stop: +(level.price - atr * atrBelow).toFixed(2), basis };
}

/** A stop is only useful if it is reached less often than the target. */
export function hitRate(rows, spot, price, horizon = 20) {
  const d = (price - spot) / spot;
  let n = 0, k = 0;
  for (let i = 0; i < rows.length - horizon; i++) {
    const t = rows[i].close * (1 + d);
    n++;
    for (let j = i + 1; j <= i + horizon; j++) {
      if (d < 0 ? rows[j].low <= t : rows[j].high >= t) { k++; break; }
    }
  }
  return n ? (k / n) * 100 : null;
}
