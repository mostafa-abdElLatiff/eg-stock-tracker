// Estimating a position's value between manual confirmations.
//
// Three mechanisms, tried in priority order, because "price" doesn't mean
// the same thing for every ticker here:
//
// 1. Shares/units x live price (stocks, funds, gold - whenever every buy/
//    sell for this ticker has a share count recorded): the most accurate
//    method, since it's a direct valuation, not a scaled guess - doesn't
//    depend on when you last happened to confirm a value.
//
// 2. Price-ratio (same asset types, when share data is missing or partial):
//    we know the value you confirmed and the market price at that moment,
//    so scaling by how much the price has moved since gives a close
//    estimate. Requires price_at_valuation to be set, which only happens
//    if market_prices had this ticker at the time you last confirmed a
//    value.
//
// 3. Interest accrual (Clouds only): not a market price at all - it's cash
//    accruing daily interest at a roughly known rate. No lookup involved,
//    just compounding from the date you last confirmed a value.
//
// Everything else (C2O, T70, or any ticker with none of the above) falls
// back to the last confirmed value, unchanged, clearly NOT labeled as an
// estimate.

import { netShares, hasCompleteShareData } from "./portfolio.js";

// Thndr's advertised Clouds rate as of when this was written - it moves
// with CBE policy, so revisit this if it's been a while. There's no public
// feed for it, so this has to be a maintained constant, not a fetched value.
export const CLOUDS_ANNUAL_RATE = 0.195;

export function estimateValue(ticker, position, marketPrices, today = new Date()) {
  const confirmed = position.currentValue || 0;
  const lastValued = position.lastValued ? new Date(position.lastValued) : null;
  const marketPrice = marketPrices[ticker];

  if (ticker === "Clouds") {
    if (!lastValued) return { value: confirmed, kind: "confirmed" };
    const days = Math.max(0, Math.floor((today - lastValued) / 86400000));
    const dailyRate = Math.pow(1 + CLOUDS_ANNUAL_RATE, 1 / 365) - 1;
    const value = confirmed * Math.pow(1 + dailyRate, days);
    return { value, kind: "accrual", days, annualRate: CLOUDS_ANNUAL_RATE };
  }

  const txns = position.transactions || [];
  if (marketPrice && hasCompleteShareData(txns)) {
    const shares = netShares(txns);
    if (shares > 0) {
      return {
        value: shares * marketPrice.price,
        kind: "shares",
        shares,
        source: marketPrice.source,
      };
    }
  }

  const priceAtValuation = position.priceAtValuation;
  if (marketPrice && priceAtValuation) {
    const ratio = marketPrice.price / priceAtValuation;
    return {
      value: confirmed * ratio,
      kind: "price-ratio",
      asOfPrice: marketPrice.updated_at,
      source: marketPrice.source,
    };
  }

  return { value: confirmed, kind: "confirmed" };
}
