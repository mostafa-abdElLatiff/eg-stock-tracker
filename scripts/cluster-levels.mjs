#!/usr/bin/env node
// Clustering swing pivots into price levels - the correct way.
//
// THE BUG THIS REPLACES. price-levels.mjs merged a pivot into the running
// cluster if it sat within tol of the LAST price added. That is single-linkage
// clustering and it CHAINS: each pivot is within tol of its predecessor, so a
// dense series merges end to end without bound. Found 2026-09-14 on AMOC with
// 2,425 bars - 333 of 334 pivots collapsed into one "level" spanning 2.47 to
// 14, and the level table came back empty. On 249 sparse bars the same code
// produced sane output, which is why it survived. It was always fragile; more
// data only revealed it.
//
// WHY NOT JUST ANCHOR ON THE CLUSTER FLOOR. Tried that first. It bounds width,
// but it is greedy and order-dependent: it fragments levels that genuinely
// belong together, and it moved EVERY level on every name (MASR 5.76 became
// 5.72/5.91/6.21). Trading one wrong answer for a different wrong answer.
//
// WHAT THIS DOES INSTEAD - complete-linkage agglomerative clustering:
//   1. every pivot starts as its own cluster
//   2. repeatedly merge the ADJACENT pair with the smallest gap, but only if
//      the merged cluster's total width stays <= tol
//   3. stop when no legal merge remains
// Merging closest-first makes it order-independent, and the width cap makes
// chaining impossible by construction. A "level" can never be wider than tol,
// which is what "these prices are the same level" is supposed to mean.

/** @param pivots [{price,date,kind}] @param tol max total width of one level */
export function clusterPivots(pivots, tol) {
  if (!pivots.length) return [];
  const sorted = [...pivots].sort((a, b) => a.price - b.price);
  // each pivot its own cluster
  let cl = sorted.map((p) => ({ prices: [p.price], dates: [p.date], kinds: [p.kind],
                                lo: p.price, hi: p.price }));
  for (;;) {
    let best = -1, bestGap = Infinity;
    for (let i = 0; i < cl.length - 1; i++) {
      const merged = cl[i + 1].hi - cl[i].lo;          // width if these two join
      if (merged > tol) continue;                       // illegal - would exceed a level's width
      const gap = cl[i + 1].lo - cl[i].hi;              // how far apart they are now
      if (gap < bestGap) { bestGap = gap; best = i; }
    }
    if (best < 0) break;                                // nothing left that can legally merge
    const a = cl[best], b = cl[best + 1];
    cl.splice(best, 2, { prices: a.prices.concat(b.prices), dates: a.dates.concat(b.dates),
                         kinds: a.kinds.concat(b.kinds), lo: a.lo, hi: b.hi });
  }
  return cl;
}

/** Every invariant the old code silently violated. Throws on the first failure. */
export function assertValid(clusters, tol, label = "") {
  for (const c of clusters) {
    const w = Math.max(...c.prices) - Math.min(...c.prices);
    if (w > tol + 1e-9) throw new Error(`${label}: cluster width ${w.toFixed(3)} exceeds tol ${tol.toFixed(3)}`);
    if (c.prices.length !== c.dates.length || c.prices.length !== c.kinds.length)
      throw new Error(`${label}: cluster arrays out of step`);
  }
  for (let i = 0; i < clusters.length - 1; i++)
    if (clusters[i].hi > clusters[i + 1].lo + 1e-9) throw new Error(`${label}: clusters overlap`);
  return true;
}
