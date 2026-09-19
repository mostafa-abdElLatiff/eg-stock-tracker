#!/usr/bin/env node
// FULL ANALYSIS — every number for every name, each carrying its own derivation.
//
// ONE JOB: assemble. It computes nothing itself. Every value comes from a
// function in the catalogue (journal/FUNCTIONS.md); this file only chooses
// which ones to call and records what it called. If a number you want is not
// here, add the FUNCTION first, document it in FUNCTIONS.md, then call it.
//
// WHY: analysis numbers used to live in chat. Chat gets summarised and the
// derivation is the first thing lost - "ORHD stop 39.45" survives, "1.0 ATR
// below the strength-5 level at 40.54, measured over 247 bars" does not. Then
// the number cannot be checked, reproduced, or safely revised. Every value
// below ships with a `how` string naming the function and its inputs.
//
// Usage:
//   node --env-file=.env scripts/full-analysis.mjs            # all groups
//   node --env-file=.env scripts/full-analysis.mjs ORHD TMGH  # named tickers
//
// Writes journal/analyses/<date>-full-analysis.json and .md

import { readFileSync, writeFileSync, mkdirSync } from "fs";
import { parseCsv, rsiWilder, computeATR } from "./csv-technicals.mjs";
import { priceLevels, WINDOW_BARS } from "./price-levels.mjs";
import { stopFor, hitRate, ATR_BELOW, MIN_STRENGTH } from "./stop-rule.mjs";
import { buildLadder } from "./build-ladder.mjs";
import { csvFileFor } from "./tickers.mjs";
import { relativeVolume, VOLUME_WINDOW, sellFractionOnBreak } from "./lib/volume.mjs";
import { riskFor, gainFor, buyCost, thndrFee } from "./lib/money.mjs";
import { latestVsPrior } from "./lib/fundamentals.mjs";

const ROOT = new URL("../../", import.meta.url).pathname;
const POS = JSON.parse(readFileSync(`${ROOT}journal/positions.json`, "utf8"));

const HELD = Object.fromEntries(POS.stocks.map((s) => [s.ticker, s]));
const ORDERS = Object.fromEntries(POS.openBuyOrders.map((o) => [o.ticker, o]));

// Planned entries not yet resting. Kept here rather than in positions.json
// because positions.json is a record of what IS, not what is proposed.
const PLANNED = { ENGC: { price: 39.73, units: 164 }, EXPA: { price: 15.16, units: 0 } };

const GROUPS = {
  held: ["ORHD", "ETEL", "TMGH", "ADIB", "RAYA", "EFID", "ORAS"],
  order: ["TAQA", "EFIH", "FWRY", "COMI", "ABUK"],
  planned: ["ENGC", "EXPA"],
  opportunity: ["POUL", "EEII", "MTIE", "ISPH", "GBCO", "ARCC"],
};

/** A number plus how it was obtained. The whole point of this file. */
const v = (value, how) => (value == null ? null : { value: +(+value).toFixed(4), how });

function fundamentals(tk, last) {
  // Reads through lib/fundamentals.mjs, which consults EVERY store. Opening
  // journal/financials.json directly here is what made ORAS look absent on
  // 2026-09-19 when its data had been sitting in an orphan file for two days.
  const f = latestVsPrior(tk, last);
  if (f.status !== "ok") return { _missing: f.next, _checked: f.checked };
  const src = `${f.store} (${f.periods[0]} vs ${f.periods[1]}, ${f.currency})`;
  return {
    period: f.periods[0], store: f.store, currency: f.currency,
    revenueGrowth: v(f.revenueGrowth, `latest vs prior comparable period from ${src}`),
    netIncomeGrowth: v(f.netIncomeGrowth, `latest vs prior comparable period from ${src}`),
    netMargin: v(f.netMargin, `netIncome / revenue, ${src}`),
    netMarginPrior: v(f.netMarginPrior, `netIncome / revenue for ${f.periods[1]}`),
    marginDeltaPP: v(f.marginDeltaPP, "net margin now minus prior, percentage POINTS"),
    grossMargin: v(f.grossMargin, `grossProfit / revenue, ${src}`),
    operatingMargin: v(f.operatingMargin, `operatingIncome / revenue, ${src}`),
    roe: v(f.roe, `netIncome / totalEquity, ${src}`),
    debtToEquity: v(f.debtToEquity, `totalDebt / totalEquity, ${src}`),
    netCash: v(f.netCash, "cashAndST - totalDebt; negative means net debt"),
    freeCashFlow: v(f.freeCashFlow, `freeCashFlow, ${src}`),
    fcfConversion: v(f.fcfConversion, "freeCashFlow / netIncome - below ~60% means profit is not turning into cash"),
    peRatio: v(f.peRatio, f.peHow ?? "no EPS available"),
    gate: gateVerdict(f.revenueGrowth, f.netIncomeGrowth, f.marginDeltaPP),
  };
}

/** The second of the two gates. EV is blind to the business - the RACC lesson. */
function gateVerdict(revG, niG, dPP) {
  const fails = [];
  if (revG > 0 && niG < 0) fails.push("RACC pattern: revenue growing while net income falls");
  if (revG > 0 && niG >= 0 && niG < revG / 2) fails.push(`profit lagging: net income +${niG.toFixed(1)}% against revenue +${revG.toFixed(1)}%`);
  if (dPP <= -2) fails.push(`margin compression ${dPP.toFixed(1)} percentage points`);
  return { pass: fails.length === 0, fails, how: "revenue vs net income direction, and net-margin change in percentage points, on the latest full period" };
}

function analyse(tk, group) {
  const rows = parseCsv(csvFileFor(tk));
  const map = priceLevels(rows);
  const last = map.last;
  const held = HELD[tk], order = ORDERS[tk], planned = PLANNED[tk];

  // The price the position is (or would be) opened at. NEVER spot for an
  // unfilled order - that bug understated the 2026-09-19 book risk by 87%.
  const entry = held ? held.avgCost : order ? order.price : planned ? planned.price : last;
  const entrySrc = held ? "positions.json avgCost (held)" : order ? "positions.json openBuyOrders price (resting limit)" : planned ? "proposed limit, not yet resting" : "spot (watch only)";
  const units = held ? held.units : order ? order.units : planned ? planned.units : 0;

  // Stop is anchored to the ENTRY, not to spot.
  const floor = stopFor({ ...map, last: entry });
  const stop = held?.stop ?? (floor ? floor.stop : null);
  const ladder = buildLadder(rows, { maxRungs: 3 }).rungs.map((r) => +r.price.toFixed(2)).filter((p) => p > entry);

  const out = {
    ticker: tk, group,
    asOf: rows[rows.length - 1].date,
    bars: { value: rows.length, how: `rows in price-history CSV; levels use the last ${WINDOW_BARS} (WINDOW_BARS)` },
    price: v(last, `last close in price-history/*.csv on ${rows[rows.length - 1].date}`),
    entry: v(entry, entrySrc),
    units: { value: units, how: entrySrc },
    rsi: v(rsiWilder(rows.map((r) => r.close)), "rsiWilder() - Wilder smoothing over 14 periods, validated against InvestingPro"),
    atr: v(computeATR(rows, 14), "computeATR(rows,14) - mean True Range of the last 14 bars; TR = max(H-L, |H-prevC|, |L-prevC|)"),
    atrPct: v((computeATR(rows, 14) / last) * 100, `ATR as a percent of price ${last} - how far this stock moves on an ordinary day`),
    relativeVolume: v(relativeVolume(rows), `last bar's volume / mean of the prior ${VOLUME_WINDOW} bars (lib/volume.mjs; window justified there)`),
    sellOnBreak: sellFractionOnBreak(rows),
    stop: stop == null ? null : {
      value: stop,
      how: held?.stop != null
        ? "LIVE stop from positions.json - reported as placed, not recomputed"
        : `stopFor() = level ${floor?.level.price} (strength ${floor?.level.strength}) minus ${ATR_BELOW} x ATR, anchored to ENTRY ${entry}; needs strength >= ${MIN_STRENGTH}`,
      anchor: floor ? { price: floor.level.price, strength: floor.level.strength, touches: floor.level.touches, flipped: floor.level.flipped, basis: floor.basis } : null,
      hitRate20d: v(hitRate(rows, entry, stop), `share of ${rows.length - 20} historical 20-session windows where price fell this far from entry`),
    },
    targets: ladder.map((p) => ({
      price: p,
      how: "buildLadder() - next resistance levels above entry",
      gainPct: v(((p - entry) / entry) * 100, `(${p} - ${entry}) / ${entry}`),
      hitRate20d: v(hitRate(rows, entry, p), "share of historical 20-session windows reaching this far"),
    })),
    fundamentals: fundamentals(tk, last),
  };

  if (units > 0 && stop != null && stop < entry) {
    const r = riskFor({ entry, stop, units });
    const cost = buyCost(entry, units);
    out.money = {
      cost: v(cost.total, `entry ${entry} x ${units} units = ${cost.gross.toFixed(2)}, plus thndrFee() ${cost.fee.toFixed(2)} (3.00 flat + 0.175%)`),
      risk: v(r.risk, `riskFor(): (entry ${entry} - stop ${stop}) x ${units} units - capital at risk against what was PAID`),
      riskPct: v(r.riskPct, `risk per unit ${r.perUnit.toFixed(2)} / entry ${entry}`),
      // Two different questions, and conflating them has caused real confusion:
      // "how much of my cost is exposed" vs "how much do I lose from here".
      riskFromSpot: held && stop < last
        ? v((last - stop) * units, `mark-to-market: (spot ${last} - stop ${stop}) x ${units} units - what a stop fill costs from TODAY, not against cost`)
        : null,
      openPL: held ? v((last - entry) * units, `(spot ${last} - avgCost ${entry}) x ${units} units`) : null,
      gains: ladder.map((p) => v(gainFor({ entry, target: p, units }).gain, `gainFor(): (target ${p} - entry ${entry}) x ${units} units`)),
      rewardToRisk: v(ladder.length ? gainFor({ entry, target: ladder[ladder.length - 1], units }).gain / r.risk : null,
        `gain at the FINAL rung ${ladder[ladder.length - 1]} divided by risk ${r.risk.toFixed(0)}; below 1.0 means risking more than the trade pays`),
    };
  } else if (units > 0) {
    out.money = { _blocked: `no valid stop below entry ${entry} - risk cannot be stated, and an order should not be placed without one` };
  }
  return out;
}

// ---------------------------------------------------------------- run
const argv = process.argv.slice(2).filter((a) => !a.startsWith("--")).map((s) => s.toUpperCase());
const plan = argv.length
  ? argv.map((tk) => [tk, Object.entries(GROUPS).find(([, l]) => l.includes(tk))?.[0] ?? "adhoc"])
  : Object.entries(GROUPS).flatMap(([g, l]) => l.map((tk) => [tk, g]));

const results = [], errors = [];
for (const [tk, g] of plan) {
  try { results.push(analyse(tk, g)); }
  catch (e) { errors.push({ ticker: tk, error: e.message }); }
}

const date = results[0]?.asOf ?? new Date().toISOString().slice(0, 10);
const payload = {
  _what: "Every analysis number, each with the function and inputs that produced it. Regenerate with scripts/full-analysis.mjs - never hand-edit.",
  _catalogue: "journal/FUNCTIONS.md",
  generatedAt: new Date().toISOString(),
  dataAsOf: date,
  constants: {
    WINDOW_BARS: { value: WINDOW_BARS, how: "sessions of history used to build level maps - price-levels.mjs" },
    VOLUME_WINDOW: { value: VOLUME_WINDOW, how: "sessions in the relative-volume baseline - lib/volume.mjs" },
    ATR_BELOW: { value: ATR_BELOW, how: "ATR multiples a stop sits below its anchor level - stop-rule.mjs" },
    MIN_STRENGTH: { value: MIN_STRENGTH, how: "minimum level strength a stop may anchor to - stop-rule.mjs" },
    FEE: { value: "3.00 + 0.175%", how: "itemised Thndr e-invoice 2026-09-08, reconciled to the cent on three fills - lib/money.mjs" },
  },
  results, errors,
};

mkdirSync(`${ROOT}journal/analyses`, { recursive: true });
const base = `${ROOT}journal/analyses/${date}-full-analysis`;
writeFileSync(`${base}.json`, JSON.stringify(payload, null, 2) + "\n");

// --- readable companion
const L = [];
const n = (x, d = 2) => (x?.value == null ? "-" : x.value.toFixed(d));
L.push(`# Full analysis — data as of ${date}`, "");
L.push(`Generated by \`scripts/full-analysis.mjs\`. Every number's derivation is in the JSON beside this file. Function catalogue: \`journal/FUNCTIONS.md\`.`, "");
for (const [g, list] of Object.entries(GROUPS)) {
  const rs = results.filter((r) => r.group === g);
  if (!rs.length) continue;
  L.push(`## ${g}`, "");
  L.push("| ticker | price | entry | units | RSI | ATR% | relVol | stop | risk EGP | risk % | T1 | gain@T1 | R:R | gate |");
  L.push("|---|---|---|---|---|---|---|---|---|---|---|---|---|---|");
  for (const r of rs) {
    const t1 = r.targets[0];
    L.push(`| **${r.ticker}** | ${n(r.price)} | ${n(r.entry)} | ${r.units.value} | ${n(r.rsi, 0)} | ${n(r.atrPct)}% | ${n(r.relativeVolume)}x | ${r.stop ? r.stop.value : "—"} | ${r.money?.risk ? n(r.money.risk, 0) : "—"} | ${r.money?.riskPct ? n(r.money.riskPct, 1) + "%" : "—"} | ${t1 ? t1.price : "—"} | ${r.money?.gains?.[0] ? n(r.money.gains[0], 0) : "—"} | ${r.money?.rewardToRisk ? n(r.money.rewardToRisk, 1) : "—"} | ${r.fundamentals.gate ? (r.fundamentals.gate.pass ? "PASS" : "FAIL") : "no data"} |`);
  }
  L.push("");
  for (const r of rs) {
    const f = r.fundamentals;
    if (f._missing) { L.push(`- **${r.ticker}** — ${f._missing}`); continue; }
    const bits = [`rev ${n(f.revenueGrowth, 1)}%`, `NI ${n(f.netIncomeGrowth, 1)}%`, `margin ${n(f.netMarginPrior, 1)}→${n(f.netMargin, 1)}% (${n(f.marginDeltaPP, 1)}pp)`, `ROE ${n(f.roe, 0)}%`, `D/E ${n(f.debtToEquity, 0)}%`, `FCF ${n(f.freeCashFlow, 0)} (${n(f.fcfConversion, 0)}% of NI)`, `P/E ${n(f.peRatio, 1)}`];
    L.push(`- **${r.ticker}** — ${bits.join(" · ")}${f.gate.pass ? "" : `\n  - ⚠ ${f.gate.fails.join("; ")}`}`);
  }
  L.push("");
}
if (errors.length) { L.push("## Errors", ""); errors.forEach((e) => L.push(`- **${e.ticker}** — ${e.error}`)); }
writeFileSync(`${base}.md`, L.join("\n") + "\n");
console.log(`wrote ${base}.json and ${base}.md — ${results.length} names, ${errors.length} errors`);
for (const e of errors) console.log(`  ERROR ${e.ticker}: ${e.error}`);
