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

// ANCHOR CLEARANCE - how far the entry must sit ABOVE the level the stop is
// anchored to, measured in ATR.
//
// A stop is only as good as its anchor, and a level is only support while price
// is above it. On 2026-09-19 EFIH was entered at 23.55 with the stop anchored to
// the 23.50 shelf - 0.05 of room, 0.08 ATR. One ordinary down-day closed below
// 23.50, which flipped it to RESISTANCE and left the 22.86 stop stranded above
// the new nearest support at 22.80. The stop was computed correctly; the anchor
// was not durable.
//
// MEASURED across 71,750 setups, 47 tickers, 10 years - how often the anchor
// stops being support within 10 sessions, by clearance:
//     0.00-0.25 ATR  ->  61.6% lost   (n=6,196)
//     0.25-0.50 ATR  ->  53.4% lost   (n=6,307)
//     0.50-1.00 ATR  ->  44.3% lost   (n=10,891)
//     1.00-2.00 ATR  ->  25.7% lost   (n=13,196)
//     2.00+     ATR  ->   3.9% lost   (n=35,160)
//
// EFIH sat at 0.08 ATR. Losing the anchor was the ODDS-ON outcome, not bad luck.
//
// The trade-off is real and must be stated rather than hidden: clearance and
// stop-tightness are the same axis. A 2.9%-risk stop looked attractive PRECISELY
// because it hugged the level, and hugging the level is what made it fragile.
export const CLEARANCE_REFUSE = 0.5;  // below this the anchor fails more often than not
export const CLEARANCE_WARN = 1.0;    // below this it still fails over 40% of the time

/**
 * How durable is the level this stop is anchored to?
 * @returns {{atr:number, verdict:"ok"|"thin"|"fragile", lossRate:number, why:string}}
 */
export function anchorClearance(entry, level, atr) {
  if (!(atr > 0) || level == null || entry == null) {
    return { atr: null, verdict: "unknown", lossRate: null, why: "need entry, anchor level and ATR" };
  }
  const c = (entry - level) / atr;
  const lossRate = c < 0.25 ? 61.6 : c < 0.5 ? 53.4 : c < 1 ? 44.3 : c < 2 ? 25.7 : 3.9;
  const verdict = c < CLEARANCE_REFUSE ? "fragile" : c < CLEARANCE_WARN ? "thin" : "ok";
  return { atr: +c.toFixed(2), verdict, lossRate,
    why: `entry ${entry} sits ${c.toFixed(2)} ATR above the ${level} anchor; historically that anchor stops being support within 10 sessions ${lossRate}% of the time` };
}

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

  const stop = +(level.price - atr * atrBelow).toFixed(2);
  // Anchored to the ENTRY when one is supplied (rule 8), else to spot.
  const clearance = anchorClearance(opts.entry ?? last, level.price, atr);
  return { level, stop, basis, clearance };
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
