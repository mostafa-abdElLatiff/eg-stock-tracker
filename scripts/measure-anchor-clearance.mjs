#!/usr/bin/env node
// Reproduces the CLEARANCE_REFUSE / CLEARANCE_WARN thresholds in stop-rule.mjs.
// Run:  node measure-anchor-clearance.mjs
//
// HOW MUCH ROOM MUST AN ENTRY HAVE ABOVE THE LEVEL ITS STOP IS ANCHORED TO?
//
// The EFIH defect, generalised. I set the entry at 23.55 with the stop anchored
// to the 23.50 shelf - 0.05 of clearance, 0.08 ATR. One ordinary down-day put
// price below 23.50, which flipped it from support to resistance and stranded
// the stop ABOVE the new nearest support. The stop was fine; the ANCHOR was not.
//
// Question: for an entry sitting C ATR above a strength>=5 level, how often does
// price close BELOW that level within 10 sessions - i.e. how often does the
// anchor stop being support?
const P = "./";
const { parseCsv, computeATR } = await import(P + "csv-technicals.mjs");
const { csvFileFor, csvPrefix } = await import(P + "tickers.mjs");
const { priceLevels } = await import(P + "price-levels.mjs");

const HORIZON = 10;
const BUCKETS = [[0, 0.25], [0.25, 0.5], [0.5, 1], [1, 2], [2, 99]];
const res = BUCKETS.map((b) => ({ b, n: 0, broke: 0 }));

for (const t of Object.keys(csvPrefix)) {
  let rows; try { rows = parseCsv(csvFileFor(t)); } catch { continue; }
  if (rows.length < 400) continue;
  const c = rows.map((r) => r.close);
  let levels = [], atr = null;
  for (let i = 300; i < c.length - HORIZON; i++) {
    if ((i - 300) % 40 === 0) {
      try { levels = priceLevels(rows.slice(0, i + 1)).levels.filter((l) => l.strength >= 5); } catch { levels = []; }
      atr = computeATR(rows.slice(0, i + 1), 14);
    }
    if (!atr || !levels.length) continue;
    // nearest strength>=5 level BELOW the close - the one a stop would anchor to
    const anchor = levels.filter((l) => l.price < c[i]).sort((a, b) => b.price - a.price)[0];
    if (!anchor) continue;
    const clearance = (c[i] - anchor.price) / atr;
    const bucket = res.find((r) => clearance >= r.b[0] && clearance < r.b[1]);
    if (!bucket) continue;
    bucket.n++;
    // did price CLOSE below the anchor inside the horizon? then it is no longer support
    for (let j = 1; j <= HORIZON; j++) if (c[i + j] < anchor.price) { bucket.broke++; break; }
  }
}
console.log(`How often the anchor level stops being support within ${HORIZON} sessions,`);
console.log(`by how far the entry sat above it (in ATR):\n`);
console.log("clearance (ATR)      n       anchor lost");
for (const r of res) {
  if (r.n < 30) { console.log(`  ${r.b[0]}-${r.b[1] === 99 ? "+" : r.b[1]}`.padEnd(20) + `${String(r.n).padStart(6)}   UNMEASURED (n<30)`); continue; }
  console.log(`  ${r.b[0]}-${r.b[1] === 99 ? "+" : r.b[1]}`.padEnd(20) + `${String(r.n).padStart(6)}   ${((r.broke / r.n) * 100).toFixed(1)}%`);
}
console.log(`\nEFIH on 2026-09-19: entry 23.55, anchor 23.50, ATR 0.64 -> clearance ${((23.55-23.50)/0.64).toFixed(2)} ATR.`);
