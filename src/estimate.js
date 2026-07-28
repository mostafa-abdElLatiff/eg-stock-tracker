// Estimating a position's value between manual confirmations.
//
// Two totally different mechanisms, because "price" doesn't mean the same
// thing for every ticker here:
//
// 1. Price-ratio (stocks, funds, gold): we know the value you confirmed and
//    the market price at that moment, so scaling by how much the price has
//    moved since gives an exact estimate for stocks (it's algebraically the
//    same as shares x new_price) and a very close one for the snduk-sourced
//    funds (their NAV *is* this price). Requires price_at_valuation to be
//    set, which only happens if market_prices had this ticker at the time
//    you last confirmed a value.
//
// 2. Interest accrual (Clouds only): not a market price at all - it's cash
//    accruing daily interest at a roughly known rate. No lookup involved,
//    just compounding from the date you last confirmed a value.
//
// Everything else (C2O, T70, or any ticker with neither) falls back to the
// last confirmed value, unchanged, clearly NOT labeled as an estimate.

// Thndr's advertised Clouds rate as of when this was written - it moves
// with CBE policy, so revisit this if it's been a while. There's no public
// feed for it, so this has to be a maintained constant, not a fetched value.
export const CLOUDS_ANNUAL_RATE = 0.195;

export function estimateValue(ticker, position, marketPrices, today = new Date()) {
  const confirmed = position.currentValue || 0;
  const lastValued = position.lastValued ? new Date(position.lastValued) : null;

  if (ticker === "Clouds") {
    if (!lastValued) return { value: confirmed, kind: "confirmed" };
    const days = Math.max(0, Math.floor((today - lastValued) / 86400000));
    const dailyRate = Math.pow(1 + CLOUDS_ANNUAL_RATE, 1 / 365) - 1;
    const value = confirmed * Math.pow(1 + dailyRate, days);
    return { value, kind: "accrual", days, annualRate: CLOUDS_ANNUAL_RATE };
  }

  const marketPrice = marketPrices[ticker];
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
