// Pure portfolio math - no I/O here, so it's identical logic whether the
// data came from Supabase (logged in) or localStorage (visitor).
// Mirrors track.py's calculations exactly - keep the two in sync.

export function netInvested(transactions) {
  return transactions.reduce(
    (total, t) => total + (t.type === "buy" ? t.amount : -t.amount),
    0
  );
}

export function netShares(transactions) {
  return transactions.reduce(
    (total, t) => total + (t.type === "buy" ? t.shares || 0 : -(t.shares || 0)),
    0
  );
}

// True only if every transaction for this position has a share count -
// a partial mix of "some buys have shares, some don't" makes the total
// unreliable, so estimate.js should fall back to the price-ratio method
// rather than trust an incomplete share count.
export function hasCompleteShareData(transactions) {
  return transactions.length > 0 && transactions.every((t) => t.shares != null && t.shares > 0);
}

// positions: { [ticker]: { transactions: [...], currentValue: number } }
export function summarizePositions(positions, targets) {
  const totalValue = Object.values(positions).reduce(
    (sum, p) => sum + (p.currentValue || 0),
    0
  );
  const totalInvested = Object.values(positions).reduce(
    (sum, p) => sum + netInvested(p.transactions || []),
    0
  );

  const rows = Object.entries(positions)
    .map(([ticker, p]) => {
      const invested = netInvested(p.transactions || []);
      const value = p.currentValue || 0;
      const gain = value - invested;
      const gainPct = invested ? (gain / invested) * 100 : 0;
      const mixPct = totalValue ? (value / totalValue) * 100 : 0;
      const targetPct = (targets[ticker] || 0) * 100;
      return { ticker, invested, value, gain, gainPct, mixPct, targetPct };
    })
    .sort((a, b) => b.value - a.value);

  return {
    rows,
    totalValue,
    totalInvested,
    totalGain: totalValue - totalInvested,
    totalGainPct: totalInvested
      ? ((totalValue - totalInvested) / totalInvested) * 100
      : 0,
  };
}

// Gap-fill rebalancing, same algorithm as track.py's `invest` command:
// fill every underweight position toward target first; if the new money
// can't cover every gap, scale all gaps down proportionally; any leftover
// after all gaps are filled splits pro-rata by target weight.
export function suggestSplit(positions, targets, amount) {
  const currentTotal = Object.values(positions).reduce(
    (sum, p) => sum + (p.currentValue || 0),
    0
  );
  const newTotal = currentTotal + amount;

  const ideal = {};
  const gap = {};
  let totalGap = 0;
  for (const [ticker, weight] of Object.entries(targets)) {
    ideal[ticker] = weight * newTotal;
    const current = positions[ticker]?.currentValue || 0;
    gap[ticker] = Math.max(0, ideal[ticker] - current);
    totalGap += gap[ticker];
  }

  const alloc = {};
  if (totalGap <= amount) {
    const leftover = amount - totalGap;
    for (const [ticker, weight] of Object.entries(targets)) {
      alloc[ticker] = gap[ticker] + leftover * weight;
    }
  } else {
    const scale = totalGap ? amount / totalGap : 0;
    for (const ticker of Object.keys(targets)) {
      alloc[ticker] = gap[ticker] * scale;
    }
  }
  return alloc;
}
