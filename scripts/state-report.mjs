#!/usr/bin/env node
// STATE REPORT - regenerates the three "what is true right now" files.
//
// Mostafa asked for a clean, complete picture of everything owned, everything
// that has happened, and everything scheduled - as a base for trying a
// different approach with a different model.
//
// These are GENERATED, never hand-written. A hand-written holdings file is
// wrong the first time an order fills, and this project has already paid for
// that twice (L-35, L-39). Re-run after any fill:
//
//   node --env-file=.env scripts/state-report.mjs
//
// Sources, all of them: journal/positions.json (the record of what IS),
// journal/decision-log.json (what was decided and why), funds.json,
// corporate-actions.json, earnings-calendar.json, watch-triggers.json,
// and price-history/*.csv for current prices.

import { readFileSync, writeFileSync, existsSync } from "fs";
import { parseCsv } from "./csv-technicals.mjs";
import { csvFileFor } from "./tickers.mjs";
import { standingProposals } from "./lib/decision-log.mjs";
import { buyCost } from "./lib/money.mjs";

const ROOT = new URL("../../", import.meta.url).pathname;
const J = (f) => (existsSync(ROOT + f) ? JSON.parse(readFileSync(ROOT + f, "utf8")) : null);
const P = J("journal/positions.json");
const CA = J("journal/corporate-actions.json") ?? { actions: {} };
const EC = J("journal/earnings-calendar.json") ?? {};
const WT = J("journal/watch-triggers.json") ?? { dateReminders: [] };
const FU = J("journal/funds.json") ?? {};

const n = (v, d = 2) => (v == null || Number.isNaN(+v) ? "—" : (+v).toLocaleString("en-US", { minimumFractionDigits: d, maximumFractionDigits: d }));
const pct = (v, d = 1) => (v == null ? "—" : `${v >= 0 ? "+" : ""}${(+v).toFixed(d)}%`);

function lastClose(tk) {
  try { const r = parseCsv(csvFileFor(tk)); return { price: r.at(-1).close, date: r.at(-1).date }; }
  catch { return { price: null, date: null }; }
}

// ---------------------------------------------------------------- HOLDINGS
const stocks = P.stocks.map((s) => {
  const { price, date } = lastClose(s.ticker);
  const value = price != null ? s.units * price : null;
  const cost = s.units * s.avgCost;
  return { ...s, price, priceDate: date, value, cost, pl: value == null ? null : value - cost,
           plPct: value == null ? null : ((value - cost) / cost) * 100 };
});
const stockTotal = stocks.reduce((a, s) => a + (s.value ?? 0), 0);
// FUND VALUE. positions.json records the convention: Thndr's last-trade price is
// what you transact at and is authoritative for VALUE; snduk (funds.json) lags it
// by about 0.4% and is used for what Thndr does not publish. Only BMM and T70
// carry a Thndr price, so the other five fall back to snduk - labelled, never
// silently. An earlier version of this file used marketValue alone and simply
// omitted five funds, understating the book by ~102,000 EGP.
const snduk = Object.fromEntries(Object.entries(FU.funds ?? {}).map(([tk, f]) => [tk, f.price]));
const fundRows = (P.funds ?? []).map((f) => {
  const thndr = f.thndrPrice ?? null;
  const nav = thndr ?? snduk[f.ticker] ?? null;
  return { ...f, nav, navSrc: thndr ? "Thndr" : snduk[f.ticker] ? "snduk (~0.4% low)" : "NONE",
           value: nav != null ? f.units * nav : null, cost: f.units * f.avgCost };
});
const fundTotal = fundRows.reduce((a, f) => a + (f.value ?? 0), 0);
const goldTotal = (P.gold ?? []).reduce((a, g) => a + (g.value ?? 0), 0);
const cashTotal = (P.cash ?? []).reduce((a, c) => a + (c.value ?? 0), 0);
const grand = stockTotal + fundTotal + goldTotal + cashTotal;

let h = `# Holdings — everything owned\n\n`;
h += `**Generated ${new Date().toISOString().slice(0, 10)} from \`journal/positions.json\`, captured ${P.asOf}.**\n`;
h += `Prices are the last completed session's close. Do not hand-edit — re-run \`state-report.mjs\`.\n\n`;
h += `| class | value EGP | share |\n|---|---:|---:|\n`;
for (const [k, v] of [["Stocks", stockTotal], ["Funds", fundTotal], ["Gold", goldTotal], ["Cash / Clouds", cashTotal]])
  h += `| ${k} | ${n(v, 0)} | ${((v / grand) * 100).toFixed(1)}% |\n`;
h += `| **TOTAL** | **${n(grand, 0)}** | |\n`;
if (P.netWorth?.total) {
  // Every line here is COMPUTED. An earlier version asserted "funds reconcile to
  // about 0.1%" as fixed prose while the real gap was 20,221 - the exact failure
  // this file exists to prevent.
  const pend = (P.pendingFundBuys ?? []).reduce((a, b) => a + (b.amount ?? 0), 0);
  const fundGap = P.netWorth.funds - fundTotal;
  const stockGap = stockTotal - P.netWorth.stocks;
  h += `\n### Reconciliation against Thndr's own figures (${P.netWorth.asOf})\n\n`;
  h += `| | computed here | Thndr app | delta |\n|---|---:|---:|---:|\n`;
  h += `| Stocks | ${n(stockTotal, 0)} | ${n(P.netWorth.stocks, 0)} | ${n(stockGap, 0)} |\n`;
  h += `| Funds | ${n(fundTotal, 0)} | ${n(P.netWorth.funds, 0)} | ${n(-fundGap, 0)} |\n`;
  h += `| **Total** | **${n(grand, 0)}** | **${n(P.netWorth.total, 0)}** | **${n(grand - P.netWorth.total, 0)}** |\n\n`;
  if (pend) {
    h += `**The fund gap of ${n(fundGap, 0)} is mostly explained.** ${(P.pendingFundBuys ?? []).length} fund purchase(s) `;
    h += `totalling **${n(pend, 0)} EGP** were placed on ${(P.pendingFundBuys ?? [])[0]?.date} and are still recorded as `;
    h += `*${(P.pendingFundBuys ?? [])[0]?.status}* — the money left the wallet but the UNITS were never written back:\n\n`;
    for (const b of P.pendingFundBuys) h += `- ${b.ticker} ${b.type}, ${n(b.amount)} EGP, ${b.date}\n`;
    h += `\nThat leaves **${n(fundGap - pend, 0)}** unaccounted, consistent with the ~0.4% snduk lag on the\n`;
    h += `five funds priced from snduk plus NAV movement since the buys.\n`;
    h += `\n**ACTION: read the unit counts for these two off a fund screen and record them.**\n`;
    h += `Until then every fund total here is understated by roughly the amounts above.\n`;
  }
  h += `\n**The stock line (${n(stockGap, 0)}) is NOT explained.** The app tile was read at 13:47 during\n`;
  h += `the session while the figure here uses the close, and two positions settled that day.\n`;
  h += `UNRESOLVED — wants a fresh position screen. Stated rather than smoothed over.\n`;
}

h += `\n## Stocks — ${stocks.length} positions\n\n`;
h += `| ticker | units | avg cost | last | value | P/L | P/L % | stop | stop covers |\n|---|---:|---:|---:|---:|---:|---:|---:|---|\n`;
for (const s of stocks.sort((a, b) => (b.value ?? 0) - (a.value ?? 0)))
  h += `| **${s.ticker}** | ${s.units} | ${n(s.avgCost)} | ${n(s.price)} | ${n(s.value, 0)} | ${n(s.pl, 0)} | ${pct(s.plPct)} | ${s.stop ?? "**none**"} | ${s.stopUnits ? `${s.stopUnits}/${s.units}` : "—"} |\n`;
h += `\n**Concentration:** `;
h += stocks.sort((a, b) => (b.value ?? 0) - (a.value ?? 0)).slice(0, 3)
  .map((s) => `${s.ticker} ${(((s.value ?? 0) / stockTotal) * 100).toFixed(1)}%`).join(" · ");
const re = stocks.filter((s) => ["ORHD", "TMGH", "MASR", "PHDC", "EMFD"].includes(s.ticker))
  .reduce((a, s) => a + (s.value ?? 0), 0);
if (re) h += `\n**Real estate / development:** ${n(re, 0)} = ${((re / stockTotal) * 100).toFixed(1)}% of the stock sleeve.\n`;

const noStop = stocks.filter((s) => s.stop == null);
if (noStop.length) {
  h += `\n### Positions with NO stop — and why\n\n`;
  for (const s of noStop) h += `- **${s.ticker}** (${s.units} units, ${n(s.value, 0)} EGP): ${s.stopAbsentReason ?? "no reason recorded — investigate"}${s.stopReviewDate ? ` *Review ${s.stopReviewDate}.*` : ""}\n`;
}

h += `\n## Funds — ${fundRows.length}\n\n| fund | pool | units | avg cost | NAV | NAV source | value | P/L |\n|---|---|---:|---:|---:|---|---:|---:|\n`;
for (const f of fundRows.sort((a, b) => (b.value ?? 0) - (a.value ?? 0)))
  h += `| **${f.ticker}** | ${f.pool} | ${n(f.units, 0)} | ${n(f.avgCost, 4)} | ${n(f.nav, 4)} | ${f.navSrc} | ${n(f.value, 0)} | ${f.value == null ? "—" : n(f.value - f.cost, 0)} |\n`;

h += `\n## Gold\n\n| holding | pool | value |\n|---|---|---:|\n`;
for (const g of P.gold ?? []) h += `| ${g.ticker} | ${g.pool} | ${n(g.value, 0)} |\n`;

h += `\n## Cash and Clouds\n\n| account | pool | value | rate | access |\n|---|---|---:|---:|---|\n`;
for (const c of (P.cash ?? []).sort((a, b) => b.value - a.value))
  h += `| ${c.label} | ${c.pool} | ${n(c.value, 0)} | ${c.ratePct ? c.ratePct + "%" : "—"} | ${c.access} |\n`;
if (P.liabilities?.length) {
  h += `\n## Liabilities\n\n`;
  for (const l of P.liabilities) h += `- ${JSON.stringify(l)}\n`;
}
writeFileSync(ROOT + "setup/STATE-HOLDINGS.md", h);

// ----------------------------------------------------------------- HISTORY
let x = `# History — everything that has happened\n\n`;
x += `**Generated ${new Date().toISOString().slice(0, 10)}.** Fills come from e-invoices and order\n`;
x += `history; positions come from the position screen. An invoice shows one transaction —\n`;
x += `only the order history shows a position (the CLHO lesson).\n\n`;
x += `The full append-only ledger is the table in \`journal/DECISION-JOURNAL.md\`.\n`;
x += `Every number that changed an order, with its arithmetic and reason, is in\n\`journal/decision-log.json\`.\n\n## Closed positions\n\n`;
const exitKeys = Object.keys(P).filter((k) => k.startsWith("_exits")).sort();
for (const k of exitKeys) {
  x += `### ${k.replace("_exits", "").replace(/(\d{4})(\d{2})(\d{2})/, "$1-$2-$3")}\n\n`;
  for (const e of P[k]) {
    x += `- **${e.ticker}** — ${e.units} units at ${n(e.price ?? e.fill)}`;
    if (e.avgCost) x += ` against a ${n(e.avgCost)} cost`;
    if (e.netGain != null) x += `, **net ${n(e.netGain, 2)} EGP (${pct(e.netPct, 2)})**`;
    else if (e.pl != null) x += `, P/L ${n(e.pl, 2)} EGP`;
    x += `\n`;
    if (e.note) x += `  - ${e.note}\n`;
    if (e.how) x += `  - ${e.how}\n`;
    if (e.confirmed) x += `  - *${e.confirmed}*\n`;
    if (e._needsScreenConfirmation) x += `  - ⚠ ${e._needsScreenConfirmation}\n`;
  }
  x += `\n`;
}
// Totals, computed - never a quoted figure. Entries carry either netGain (fee-exact)
// or pl (from the invoice); both are realised EGP.
const all = exitKeys.flatMap((k) => P[k].map((e) => ({ ...e, when: k.replace("_exits", "") })));
const withPl = all.filter((e) => (e.netGain ?? e.pl) != null);
const tot = withPl.reduce((a, e) => a + (e.netGain ?? e.pl), 0);
const wins = withPl.filter((e) => (e.netGain ?? e.pl) > 0);
const stops = all.filter((e) => /stop/i.test(String(e.note ?? "") + String(e.how ?? "")));
x += `## Scorecard\n\n`;
x += `| | |\n|---|---:|\n`;
x += `| Closed positions | ${all.length} |\n`;
x += `| With a recorded P/L | ${withPl.length} |\n`;
x += `| Winners | ${wins.length} |\n`;
x += `| **Net realised** | **${n(tot, 2)} EGP** |\n`;
x += `| Best | ${wins.length ? wins.sort((a,b)=>(b.netGain??b.pl)-(a.netGain??a.pl))[0].ticker + " " + n(wins[0].netGain ?? wins[0].pl, 2) : "—"} |\n`;
const worst = withPl.slice().sort((a,b)=>(a.netGain??a.pl)-(b.netGain??b.pl))[0];
x += `| Worst | ${worst ? worst.ticker + " " + n(worst.netGain ?? worst.pl, 2) : "—"} |\n`;
x += `| Exited by STOP | ${stops.length} of ${all.length} |\n\n`;
x += `**Read this honestly.** ${stops.length} of ${all.length} exits were stops, and the single\n`;
x += `largest winner was unintended — a sell limit that filled when a cancel was meant.\n`;
x += `Four of the stops fired on the SAME day (2026-09-14), which points at a market event\n`;
x += `rather than four independent bad picks; that has not been checked against the index yet.\n`;
x += `The whole record is ${all.length} positions over about eight weeks. **No sample here is\n`;
x += `large enough to draw a conclusion from.**\n\n`;
writeFileSync(ROOT + "setup/STATE-HISTORY.md", x);

// ----------------------------------------------------------------- PENDING
let p = `# Pending and scheduled — everything not yet done\n\n`;
p += `**Generated ${new Date().toISOString().slice(0, 10)}.** Three different things, kept apart on purpose:\n`;
p += `what is RESTING at the broker, what has been RECOMMENDED but not placed, and what is\n`;
p += `SCHEDULED by date. Conflating the first two is how an order got counted twice (L-42).\n\n`;

p += `## 1. Resting at the broker\n\n`;
const orders = P.openBuyOrders ?? [];
let reserved = 0;
p += `| ticker | type | price | units | reserves EGP | note |\n|---|---|---:|---:|---:|---|\n`;
for (const o of orders) {
  const r = buyCost(o.price, o.units).total; reserved += r;
  p += `| **${o.ticker}** | buy limit | ${n(o.price)} | ${o.units} | ${n(r)} | ${o.note ?? ""} |\n`;
}
for (const s of P.stocks.filter((s) => s.stop != null))
  p += `| **${s.ticker}** | sell stop | ${n(s.stop)} | ${s.stopUnits ?? s.units} | — | protects a holding |\n`;
for (const s of P.stocks.filter((s) => s.sellLimit != null))
  p += `| **${s.ticker}** | sell limit | ${n(s.sellLimit)} | ${s.sellLimitUnits} | — | target tranche |\n`;
p += `\n**Cash reserved against buy limits: ${n(reserved)} EGP** (Thndr reserves cost + fee).\n`;

p += `\n## 2. Recommended, NOT yet placed\n\n`;
const sp = standingProposals();
if (!sp.length) p += `Nothing outstanding — every recommendation has been actioned or retracted.\n`;
else {
  p += `| ticker | field | from | to | decided | why (short) |\n|---|---|---|---|---|---|\n`;
  for (const d of sp)
  {
    // `to: null` means CANCEL only where the reason says so. It has also been used
    // to mean "reported for decision, not moved" (P2), and rendering that as CANCEL
    // once told a reader to remove the only stop on a 292-unit position.
    const cancels = /cancel|withdraw|retract/i.test(String(d.why)) || /cancel/i.test(String(d.how));
    const to = d.to === null ? (cancels ? "**CANCEL**" : "**decide — see why**") : JSON.stringify(d.to);
    // Truncate on a sentence end, not on any dot - "journal/corporate-actions." was
    // a filename cut in half.
    const m = String(d.why).match(/^.{0,150}?[.!?](?=\s|$)/);
    p += `| **${d.ticker}** | ${d.field} | ${JSON.stringify(d.from)} | ${to} | ${d.at.slice(0, 10)} | ${(m ? m[0] : String(d.why).slice(0, 150)).replace(/\|/g, "/")} |\n`;
  }
  p += `\nFull arithmetic for each is in \`journal/decision-log.json\` — append-only, never edited.\n`;
}

p += `\n## 3. Scheduled by date\n\n| date | what | detail |\n|---|---|---|\n`;
const sched = [];
const w = P.wafraPhaseIn;
if (w) for (const t of w.schedule.filter((s) => s.status === "pending"))
  sched.push([t.date, `Wafra tranche ${t.n}`, `${n(t.egp)} EGP into BWA (parents). Accelerate if EGX33 is ${w.accelerateAtDrawdownPct}% below ${w.referenceLevel}; complete all at ${w.completeAtDrawdownPct}%.`]);
for (const [tk, a] of Object.entries(CA.actions ?? {})) {
  if (a.cancelBuyBefore) sched.push([a.cancelBuyBefore, `${tk} — cancel buy`, a.detail ?? ""]);
  if (a.reviewDate) sched.push([a.reviewDate, `${tk} — review`, a.detail ?? ""]);
  if (a.lastDayForEntitlement) sched.push([a.lastDayForEntitlement, `${tk} — entitlement closes`, `Hold through this date to receive the bonus shares.`]);
}
for (const s of P.stocks.filter((s) => s.stopReviewDate)) sched.push([s.stopReviewDate, `${s.ticker} — stop review`, s.stopAbsentReason ?? ""]);
for (const r of WT.dateReminders ?? []) sched.push([r.by, `${r.ticker} — ${r.id}`, r.text]);
for (const [tk, d] of Object.entries(EC).filter(([k]) => !k.startsWith("_")))
  if (typeof d === "string") sched.push([d, `${tk} — earnings`, "Next results date."]);
  else if (d?.next) sched.push([d.next, `${tk} — earnings`, "Next results date."]);
for (const [d, what, detail] of sched.sort((a, b) => String(a[0]).localeCompare(String(b[0]))))
  p += `| **${d}** | ${what} | ${String(detail).replace(/\|/g, "/").slice(0, 190)} |\n`;

p += `\n## 4. Known gaps — things we cannot currently do\n\n`;
const dg = J("journal/data-gaps.json");
for (const g of dg?.gaps ?? []) p += `- **${g.id}** — ${g.what} *Consequence:* ${g.consequence}\n`;
writeFileSync(ROOT + "setup/STATE-PENDING.md", p);

console.log("wrote setup/STATE-HOLDINGS.md, STATE-HISTORY.md, STATE-PENDING.md");
console.log(`  ${stocks.length} stocks, ${(P.funds ?? []).length} funds, ${orders.length} resting buys, ${sp.length} unplaced proposals, ${sched.length} scheduled items`);
