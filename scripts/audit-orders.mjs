#!/usr/bin/env node
// Does every RESTING order sit on a level the market actually defends?
//
// WHY THIS EXISTS. Stops and target limits were placed from ATR arithmetic and
// from swing highs read off a chart - which is how ENGC got a 40.18 stop sitting
// in a gap with nothing between 44.33 and 34.92. `price-levels.mjs` computes
// where stock genuinely changed hands; nothing was comparing the ORDERS AS
// PLACED against that map. This does, and it reports the delta BEFORE anything
// is edited, because an order that is already good enough is not worth a trip
// to the broker.
//
// WHAT MAKES A STOP GOOD. It sits BELOW a real support, far enough that the
// level's ordinary noise does not reach it, and close enough that the loss is
// bounded. Two distinct failures:
//   * IN NOISE - the stop is above support, or within ~0.35x ATR of it. The
//     level gets tested, the stop fills, the level holds, the position is gone.
//   * IN AIR - the nearest support is far below the stop, so the stop is not
//     protected by anything; price gaps through it.
//
// WHAT MAKES A TARGET GOOD. It sits AT or just BELOW a real resistance, because
// that is where the sellers are. A target ABOVE the nearest resistance asks
// price to break a level first; a target far below one leaves money behind.
//
// Reports a VERDICT per order: KEEP (do nothing), or EDIT with the level-based
// price and the cost of the change in EGP.
//
// Usage: node audit-orders.mjs

import { readFileSync, readdirSync } from "fs";
import { parseCsv } from "./csv-technicals.mjs";
import { priceLevels } from "./price-levels.mjs";

const ROOT = new URL("../../", import.meta.url).pathname;
const FILE = {
  ORHD: "Orascom Hotels", MASR: "Madinet Nasr", ETEL: "Telecom Egypt",
  COMI: "Commercial Int", TMGH: "T M G", EFIH: "E-finance", ADIB: "Abu Dhabi",
  PHAR: "EIPICO", RAYA: "Raya Holding", EFID: "Edita", ORAS: "Orascom Construction",
  EXPA: "Export Development Bank", PHDC: "Palm Hills", ABUK: "Abu Qir",
  ISPH: "Ibnsina", JUFO: "Juhayna", MFPC: "Misr Fertilizers", QNBE: "QNB Alahli",
  TAQA: "TAQA", SCEM: "Sinai Cement", ARCC: "Arabian Cement", ORWE: "Oriental Weavers",
};
const FEE = (v) => 3.0 + v * 0.00175;

const pos = JSON.parse(readFileSync(`${ROOT}journal/positions.json`, "utf8"));
const files = readdirSync(`${ROOT}price-history`);

// --- how close is too close? A stop inside this fraction of an ATR below a
// support is inside the level's ordinary daily noise.
const NOISE_ATR = 0.35;

const out = [];
for (const p of pos.stocks) {
  const f = files.find((x) => x.startsWith(FILE[p.ticker] ?? "___"));
  if (!f) { out.push({ ticker: p.ticker, err: "no CSV" }); continue; }
  const rows = parseCsv(`${ROOT}price-history/${f}`);
  const { last, atr, levels } = priceLevels(rows);

  const sup = levels.filter((l) => l.price < last).sort((a, b) => b.price - a.price);
  const res = levels.filter((l) => l.price > last).sort((a, b) => a.price - b.price);

  const rec = { ticker: p.ticker, units: p.units, avgCost: p.avgCost, last, atr,
                supports: sup.slice(0, 3), resistances: res.slice(0, 3), orders: [] };

  // ---------------------------------------------------------------- the stop
  if (p.stop != null) {
    // The level the stop is meant to protect: the strongest support at or above it,
    // falling back to the nearest support above it.
    const above = sup.filter((l) => l.price >= p.stop);
    const anchor = above.sort((a, b) => b.strength - a.strength || b.price - a.price)[0];
    const below = sup.filter((l) => l.price < p.stop).sort((a, b) => b.price - a.price)[0];

    let verdict, why, suggest = null;
    if (!anchor) {
      verdict = "EDIT"; why = `stop is ABOVE every support - nothing defends it`;
      suggest = sup[0] ? +(sup[0].price - atr * 0.5).toFixed(2) : null;
    } else {
      const gapATR = (anchor.price - p.stop) / atr;
      if (gapATR < NOISE_ATR) {
        verdict = "EDIT";
        why = `only ${gapATR.toFixed(2)}x ATR below the ${anchor.price} support (${anchor.touches} touches${anchor.flipped ? ", flipped" : ""}) - inside its noise`;
        suggest = +(anchor.price - atr * 0.5).toFixed(2);
      } else if (gapATR > 2.0 && below && p.stop - below.price > atr * 0.5) {
        verdict = "EDIT";
        why = `sits ${gapATR.toFixed(1)}x ATR below ${anchor.price} and ${((p.stop - below.price) / atr).toFixed(1)}x ATR above ${below.price} - in open air between two levels`;
        suggest = +(anchor.price - atr * 0.5).toFixed(2);
      } else {
        verdict = "KEEP";
        why = `${gapATR.toFixed(2)}x ATR below the ${anchor.price} support (${anchor.touches} touches${anchor.flipped ? ", flipped" : ""}, ${anchor.volPct}% of year's volume) - clear of its noise`;
      }
    }
    const riskNow = (last - p.stop) * (p.stopUnits ?? p.units);
    const riskNew = suggest != null ? (last - suggest) * (p.stopUnits ?? p.units) : null;
    rec.orders.push({ kind: "stop", price: p.stop, units: p.stopUnits ?? p.units,
                      verdict, why, suggest, riskNow, riskNew,
                      nextBelow: below ? below.price : null });
  } else {
    rec.orders.push({ kind: "stop", price: null, verdict: "N/A",
                      why: p.stopAbsentReason ?? "no stop", suggest: null });
  }

  // ------------------------------------------------------------ the sell limit
  if (p.sellLimit != null) {
    const at = res.filter((l) => l.price <= p.sellLimit).sort((a, b) => b.price - a.price)[0];
    const over = res.filter((l) => l.price > p.sellLimit).sort((a, b) => a.price - b.price)[0];
    let verdict, why, suggest = null;
    if (over && over.price - p.sellLimit < atr * NOISE_ATR) {
      verdict = "EDIT";
      why = `sits ${((over.price - p.sellLimit) / atr).toFixed(2)}x ATR UNDER the ${over.price} resistance - so close it may as well be at it, but it gives up the difference`;
      suggest = +(over.price - 0.05).toFixed(2);
    } else if (at && p.sellLimit - at.price > atr * 1.0) {
      verdict = "EDIT";
      why = `${((p.sellLimit - at.price) / atr).toFixed(1)}x ATR above the ${at.price} resistance - asks price to break a real level before filling`;
      suggest = +(at.price - 0.05).toFixed(2);
    } else {
      verdict = "KEEP";
      why = at ? `just under the ${at.price} resistance - where the sellers are`
               : `no resistance between here and the limit - clear run`;
    }
    rec.orders.push({ kind: "limit", price: p.sellLimit, units: p.sellLimitUnits,
                      verdict, why, suggest });
  }
  out.push(rec);
}

// ------------------------------------------------------------------- report
const money = (n) => (n == null ? "-" : `${n >= 0 ? "" : "-"}${Math.abs(n).toFixed(0)}`);
console.log(`RESTING-ORDER AUDIT against real volume-weighted levels\n`);
for (const r of out) {
  if (r.err) { console.log(`${r.ticker}  ${r.err}\n`); continue; }
  console.log(`${r.ticker}  last ${r.last}  ATR ${r.atr.toFixed(2)} (${(r.atr / r.last * 100).toFixed(1)}%)  avg cost ${r.avgCost}  ${r.units}u`);
  console.log(`   supports:    ${r.supports.map((l) => `${l.price} (${l.touches}t${l.flipped ? ",flip" : ""},${l.volPct}%v,str${l.strength})`).join("  ") || "none"}`);
  console.log(`   resistances: ${r.resistances.map((l) => `${l.price} (${l.touches}t${l.flipped ? ",flip" : ""},${l.volPct}%v,str${l.strength})`).join("  ") || "none"}`);
  for (const o of r.orders) {
    const tag = o.verdict === "KEEP" ? "  KEEP " : o.verdict === "N/A" ? "  n/a  " : "  EDIT ";
    console.log(`  ${tag} ${o.kind.padEnd(5)} ${String(o.price ?? "-").padStart(7)}${o.units ? ` x${o.units}` : ""}  ${o.why}`);
    if (o.suggest != null) {
      const dRisk = o.riskNew != null && o.riskNow != null ? o.riskNew - o.riskNow : null;
      console.log(`         -> ${o.suggest}${dRisk != null ? `   risk ${money(o.riskNow)} -> ${money(o.riskNew)} EGP  (${dRisk >= 0 ? "+" : ""}${dRisk.toFixed(0)})` : ""}`);
    }
  }
  console.log();
}
const edits = out.flatMap((r) => (r.orders ?? []).filter((o) => o.verdict === "EDIT").map((o) => `${r.ticker} ${o.kind}`));
console.log(`${edits.length} order(s) would change: ${edits.join(", ") || "none"}`);
console.log(`Everything else is already sitting where the level map says it should.`);
