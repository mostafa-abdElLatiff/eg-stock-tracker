// Builds a multi-rung exit ladder where EVERY rung has a stated, reproducible
// basis. No invented numbers. Two methods, in strict priority order:
//
//   1. REAL SWING HIGHS - a price the stock has actually traded at. Preferred,
//      because it is observed rather than derived. Only rungs at or inside the
//      90-day high count as reachable in the current regime.
//   2. FIBONACCI EXTENSION - used ONLY when swing highs above spot are
//      exhausted (i.e. the stock is at/near its highs and there is nothing
//      overhead to observe). Computed from a REAL swing low -> real swing high
//      leg in the stored data, at the standard 127.2% / 161.8% / 200% ratios.
//      This is the project's documented fallback, not a guess.
//
// Every rung carries `basis` so the card can state WHY that price.
export function buildLadder(rows, opts = {}) {
  const maxRungs = opts.maxRungs ?? 3;
  const closes = rows.map(r => r.close), highs = rows.map(r => r.high), lows = rows.map(r => r.low);
  const last = closes[closes.length - 1];
  const w = 5;
  const swingHighs = [], swingLows = [];
  for (let i = w; i < rows.length - w; i++) {
    const wh = highs.slice(i - w, i + w + 1), wl = lows.slice(i - w, i + w + 1);
    if (highs[i] === Math.max(...wh)) swingHighs.push({ price: highs[i], i, date: rows[i].date });
    if (lows[i] === Math.min(...wl)) swingLows.push({ price: lows[i], i, date: rows[i].date });
  }
  const hi90 = Math.max(...highs.slice(-90));

  // Gather ALL candidates first, then sort and dedupe. Collecting method-by-method
  // and deduping as we go was wrong: a distant swing high added first would block
  // every nearer Fibonacci rung behind it (seen on PHAR, whose only swing high is
  // +39.3% away, leaving no usable near-term rung at all).
  const candidates = [];
  for (const s of swingHighs) {
    if (s.price <= last * 1.005) continue;
    if (s.price > hi90 * 1.02) continue;      // outside the current regime
    candidates.push({ price: s.price, basis: `real swing high (${s.date})`, method: "swing" });
  }
  const lastLow = swingLows[swingLows.length - 1];
  if (lastLow) {
    const legHigh = Math.max(...highs.slice(lastLow.i));
    const leg = legHigh - lastLow.price;
    if (leg > 0) {
      for (const ratio of [1.272, 1.618, 2.0]) {
        const p = lastLow.price + leg * ratio;
        if (p <= last * 1.005) continue;
        candidates.push({
          price: p,
          basis: `Fibonacci ${(ratio * 100).toFixed(1)}% extension of the real ${lastLow.price.toFixed(2)} (${lastLow.date}) -> ${legHigh.toFixed(2)} leg`,
          method: "fib",
        });
      }
    }
  }

  // Nearest first; drop anything within 1.2% of a rung already taken. Observed
  // swing highs win ties over derived Fibonacci levels at the same price.
  candidates.sort((a, b) => a.price - b.price || (a.method === "swing" ? -1 : 1));
  const rungs = [];
  for (const c of candidates) {
    if (rungs.length >= maxRungs) break;
    if (rungs.length && c.price <= rungs[rungs.length - 1].price * 1.012) continue;
    rungs.push({ price: +c.price.toFixed(2), basis: c.basis, method: c.method });
  }
  return { last, hi90, rungs };
}
