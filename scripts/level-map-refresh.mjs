#!/usr/bin/env node
// Re-derive support/resistance for EVERY held and opportunity ticker from the
// level map, and report what CHANGES against what is stored.
//
// WHY. `price-levels.mjs` was built for one ticker at a time and got used that
// way - ENGC, EXPA and ORAS were re-examined with it on Sept 11 and two of six
// resting orders changed as a result. Nothing had applied it to the other 25
// names, so most cards still carried levels derived from bare 5-bar pivots:
// a level touched once ranked the same as one defended eleven times, and
// nothing said what sat behind a level if it broke.
//
// WHAT IT PICKS, AND WHY THAT RULE.
//   support    = the nearest CONFIRMED level below the close. "Confirmed"
//                means strength >= 4 (roughly: touched 4+ times, or touched
//                twice and flipped polarity, or touched twice on heavy
//                volume). A single-touch pivot is a price the stock happened
//                to turn at once; it is not a level anyone defends, and
//                writing it into `support` invites a stop underneath it.
//                If nothing below qualifies, support is reported as a VOID -
//                the card should say so rather than name a number.
//   resistance = the nearest level above the close, confirmed by the same
//                test, falling back to the nearest unconfirmed one because a
//                weak ceiling is still where the last sellers were.
//
// Everything is computed from the full ~247-bar year in price-history/, never
// from a short window - see the SCEM/ARCC correction in webapp/CLAUDE.md for
// what scoring off 21 bars does.
//
// Usage: node level-map-refresh.mjs [--json out.json]

import { readFileSync, readdirSync, writeFileSync } from "fs";
import { parseCsv } from "./csv-technicals.mjs";
import { priceLevels } from "./price-levels.mjs";

const ROOT = new URL("../../", import.meta.url).pathname;

// CSV filename prefix per ticker. Shares the ticker set with audit-orders.mjs
// but covers opportunities too, which that script does not need.
const FILE = {
  ORHD: "Orascom Hotels", MASR: "Madinet Nasr", ETEL: "Telecom Egypt", COMI: "Commercial Int",
  TMGH: "T M G", EFIH: "E-finance", ADIB: "Abu Dhabi", PHAR: "EIPICO", RAYA: "Raya Holding",
  EFID: "Edita", ORAS: "Orascom Construction", PHDC: "Palm Hills", ABUK: "Abu Qir",
  ISPH: "Ibnsina", JUFO: "Juhayna", TAQA: "TAQA", SCEM: "Sinai Cement", ARCC: "Arabian Cement",
  ORWE: "Oriental Weavers", CLHO: "Cleopatra", FWRY: "Fawry", GBCO: "GB AUTO",
  HRHO: "EFG Hermes", RACC: "Raya Contact", TALM: "Taaleem",
};

// A level nobody defended more than once is not a level. Strength >= 3 means
// three or more touches, OR two touches that flipped polarity, OR a touch on
// heavy volume - and it excludes exactly the single-touch pivots that produced
// ENGC's 40.18 stop sitting in a 21% gap. Tested at 4 as well: only ETEL moves
// (120 -> 113.45), and 3 is the value that keeps this script agreeing with
// audit-orders.mjs, which already treats ETEL's 120 as the level protecting
// the live 114 stop. Two tools disagreeing about one stock's floor is worse
// than either threshold.
const CONFIRMED = parseInt(process.env.CONFIRMED ?? "3", 10);

export function refreshLevels(ticker) {
  const files = readdirSync(`${ROOT}price-history`);
  const f = files.find((x) => x.startsWith(FILE[ticker] ?? "___"));
  if (!f) return null;
  const rows = parseCsv(`${ROOT}price-history/${f}`);
  const { last, atr, levels, highestVolumePrice } = priceLevels(rows);

  const below = levels.filter((l) => l.price < last).sort((a, b) => b.price - a.price);
  const above = levels.filter((l) => l.price > last).sort((a, b) => a.price - b.price);
  const support = below.find((l) => l.strength >= CONFIRMED) ?? null;
  const resistance = above.find((l) => l.strength >= CONFIRMED) ?? above[0] ?? null;

  return {
    ticker, last, atr, bars: rows.length, asOf: rows[rows.length - 1].date,
    poc: highestVolumePrice,
    support, resistance,
    nearestBelow: below[0] ?? null,          // may be weaker than `support`
    // What is behind the chosen support if it gives way - the question the
    // old pivot-only levels could not answer at all.
    behindSupport: support ? (below.find((l) => l.price < support.price) ?? null) : null,
    allBelow: below, allAbove: above,
  };
}

// ---------------------------------------------------------------- CLI
const isMain = process.argv[1] && import.meta.url.endsWith(process.argv[1].split("/").pop());
if (isMain) {
  const argStore = process.argv[2] && !process.argv[2].startsWith("--") ? process.argv[2] : `${ROOT}journal/stored-levels.json`;
  const stored = JSON.parse(readFileSync(argStore, "utf8"));
  const fmt = (l) => (l ? `${l.price} (${l.touches}t${l.flipped ? ",flip" : ""},${l.volPct}%v,str${l.strength})` : "VOID");
  const pct = (a, b) => (a == null || b == null ? "" : `${(((b - a) / a) * 100).toFixed(1)}%`);

  const report = [];
  for (const ticker of Object.keys(FILE)) {
    const s = stored[ticker];
    if (!s || s.note) continue;
    const r = refreshLevels(ticker);
    if (!r) { console.log(`${ticker}\tNO CSV`); continue; }

    const newSup = r.support ? r.support.price : null;
    const newRes = r.resistance ? r.resistance.price : null;
    const supChanged = s.support == null ? newSup != null : newSup == null || Math.abs(newSup - s.support) > 0.005;
    const resChanged = s.resistance == null ? newRes != null : newRes == null || Math.abs(newRes - s.resistance) > 0.005;

    report.push({ ticker, kind: s.kind, last: r.last, asOf: r.asOf, poc: r.poc, bars: r.bars, atr: r.atr,
      storedSupport: s.support, newSupport: newSup, supChanged, supDeltaPct: pct(s.support, newSup),
      storedResistance: s.resistance, newResistance: newRes, resChanged, resDeltaPct: pct(s.resistance, newRes),
      storedStop: s.stop, support: r.support, resistance: r.resistance,
      behindSupport: r.behindSupport, nearestBelow: r.nearestBelow });

    const mark = (c) => (c ? "CHANGED" : "same   ");
    console.log(`\n${ticker}  [${s.kind}]  close ${r.last}  ATR ${r.atr.toFixed(2)} (${(r.atr / r.last * 100).toFixed(1)}%)  POC ${r.poc}`);
    console.log(`  support     ${mark(supChanged)}  ${s.support ?? "none"}  ->  ${fmt(r.support)}`);
    console.log(`  resistance  ${mark(resChanged)}  ${s.resistance ?? "none"}  ->  ${fmt(r.resistance)}`);
    if (r.support && r.nearestBelow && r.nearestBelow.price !== r.support.price)
      console.log(`  note: a weaker level sits nearer at ${fmt(r.nearestBelow)} - real but not defended`);
    console.log(`  if support breaks -> ${r.behindSupport ? `${r.behindSupport.price} (${pct(r.last, r.behindSupport.price)} away)` : "NOTHING - open air"}`);
    if (s.stop != null && r.support && s.stop > r.support.price)
      console.log(`  WARNING: stored stop ${s.stop} sits ABOVE the support it is meant to protect`);
  }

  const i = process.argv.indexOf("--json");
  if (i > 0) writeFileSync(process.argv[i + 1], JSON.stringify(report, null, 2) + "\n");
  const changed = report.filter((r) => r.supChanged || r.resChanged);
  console.log(`\n${changed.length} of ${report.length} tickers change: ${changed.map((r) => r.ticker).join(", ")}`);
}
