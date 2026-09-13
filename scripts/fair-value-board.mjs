#!/usr/bin/env node
// Runs fair-value.mjs across every held name, every opportunity, and anything
// else asked for - then ranks by margin of safety and, just as importantly, by
// how much the models AGREE.
//
// A big discount from a tight cluster of models is a finding. The same discount
// from models spanning 10 to 24 is a coin toss wearing a number. Both are
// printed; neither is hidden behind an average.
//
// Usage: node fair-value-board.mjs [TICKER...]

import { readFileSync } from "fs";
import { fairValue } from "./fair-value.mjs";

const ROOT = new URL("../../", import.meta.url).pathname;
const stored = JSON.parse(readFileSync(`${ROOT}journal/stored-levels.json`, "utf8"));
const fin = JSON.parse(readFileSync(`${ROOT}journal/financials.json`, "utf8")).data;

let tickers = process.argv.slice(2).filter((a) => !a.startsWith("--")).map((t) => t.toUpperCase());
if (!tickers.length) tickers = Object.keys(stored).filter((t) => fin[t] && !t.startsWith("EGX"));

const rows = [];
for (const t of tickers) {
  try {
    const r = fairValue(t);
    const px = stored[t]?.lastClose ?? null;
    if (!px || !r.median) continue;
    rows.push({ t, kind: stored[t]?.kind ?? "held", px, fv: r.median,
      mos: (r.median - px) / px * 100, lo: r.lo, hi: r.hi, band: r.band,
      n: Object.keys(r.models).length, wacc: r.wacc });
  } catch (e) { console.log(`  ${t}: skipped - ${e.message}`); }
}
rows.sort((a, b) => b.mos - a.mos);

console.log(`\nINDEPENDENT FAIR VALUE - all models at today's real EGP rates (risk-free 18%)`);
console.log(`Margin of safety is vs the Sept 10 close. "agree" is the spread across models as a share of the median.\n`);
console.log(`  ticker  kind         close      fair value   margin    model range        agree   models`);
for (const r of rows) {
  const flag = r.mos > 0 ? " " : " ";
  console.log(`  ${r.t.padEnd(7)} ${r.kind.padEnd(12)} ${r.px.toFixed(2).padStart(8)} ${r.fv.toFixed(2).padStart(13)} ${((r.mos>=0?"+":"")+r.mos.toFixed(0)+"%").padStart(8)}   ${(r.lo.toFixed(2)+" - "+r.hi.toFixed(2)).padStart(16)}   ${r.band.padEnd(6)}  ${r.n}`);
}
const cheap = rows.filter((r) => r.mos > 0);
const tight = rows.filter((r) => r.mos > 0 && r.band === "Low");
console.log(`\n${cheap.length} of ${rows.length} screen cheap at an 18% hurdle; ${tight.length} of those with models that actually agree.`);
console.log(`At a 17-20% risk-free rate a stock must clear a very high bar, so a thin count here is the expected result, not a bug.`);
