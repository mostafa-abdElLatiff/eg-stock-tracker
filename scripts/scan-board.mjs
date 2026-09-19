#!/usr/bin/env node
// Board-wide ranking: recomputes technicals, ladder and probability-weighted
// expected value for every ticker with a CSV, using each card's own deliberate
// support/stop where one exists. Entry is SPOT, so this answers "should I buy
// this today", not "was the original entry good". Sorted by EV descending.
//   node --env-file=.env scripts/scan-board.mjs
import { readdirSync } from "fs";
import { csvPrefix, csvFileFor } from "./tickers.mjs";
import { createClient } from "@supabase/supabase-js";
import { parseCsv, sma, computeMACD, computeATR, rsiWilder } from "./csv-technicals.mjs";
import { priceLevels } from "./price-levels.mjs";
import { stopFor } from "./stop-rule.mjs";
import { relativeVolume } from "./lib/volume.mjs";
import { buildLadder } from "./build-ladder.mjs";
import { excursionStats, ladderExpectedValue } from "./target-probability.mjs";

const s = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
const { data: users } = await s.auth.admin.listUsers();
const u = users.users.find(x => x.email === process.env.ANALYSIS_USER_EMAIL);
const { data: notes } = await s.from("analysis_notes").select("ticker,chart_data").eq("user_id", u.id);
const N = Object.fromEntries(notes.map(r=>[r.ticker, r.chart_data||{}]));

const DIR = "../price-history";
// Resolved through THE registry in tickers.mjs, not a private copy. This file
// carried its own map that was missing AMOC, POUL, EXPA, ENGC, MCQE, MFPC,
// PHTV, QNBE and EGAL - nine names whose CSVs were sitting on disk, invisible
// to this script alone. Adding a ticker must mean adding it ONCE.
const MAP = Object.fromEntries(Object.keys(csvPrefix).map((t) => [t, t]));
const HELD = new Set(["ADIB","COMI","EFIH","PHAR","EFID","MASR","ORAS","ORHD","RAYA","TMGH","ETEL"]);
const files = readdirSync(DIR).filter(f=>f.endsWith(".csv"));
const out=[];
for (const tk of Object.keys(MAP)) {
  let rows; try { rows = parseCsv(csvFileFor(tk)); } catch { continue; }
  const closes = rows.map(r=>r.close);
  const last = closes.at(-1), prev = closes.at(-2);
  const atr = computeATR(rows,14), rsi = rsiWilder(closes), macd = computeMACD(closes);
  const ma20=sma(closes,20), ma50=sma(closes,50), ma200=sma(closes,200);
  const { rungs } = buildLadder(rows,{maxRungs:3});
  const card = N[tk] || {};
  // Use the STRUCTURALLY CORRECT stop, not whatever happens to be resting.
  // Flaw found 2026-09-10: this scan ranked MASR at EV 0.84% because it used
  // the live 8.10 stop, which sits 1.5% away and is therefore hit constantly -
  // crushing P(T1) to 43%. With a coherent stop below the 7.79 support the
  // same setup scores 2.10% / 77%. Ranking "is this worth buying" against a
  // badly-placed stop conflates the quality of the setup with the quality of
  // the current order, and understates every name whose stop needs fixing.
  //
  // WHICH stop, though, was a third answer until 2026-09-19. This file derived
  // its own (raw swing low - 0.6 ATR), audit-orders.mjs suggested a second
  // (anchor - 0.5 ATR) and stop-rule.mjs - the file whose header says "One
  // definition, imported everywhere" - computed a third (strength-5 level -
  // 1.0 ATR). ORHD was quoted at 39.89, 39.90 and 39.45 in the same week off
  // the same bars. The EV ranking is only meaningful if every name is scored
  // against the stop we would actually place, so this now calls stopFor().
  // A raw swing low is also strictly worse as an anchor: it counts a price
  // touched once the same as one defended five times and ignores volume.
  const map = priceLevels(rows);
  const floor = stopFor(map);
  let support = floor ? floor.level.price : null;
  let stop = floor ? floor.stop : ((card.stop && card.stop < last) ? card.stop : null);
  const samples = excursionStats(rows,{horizon:20});
  let ev=null;
  if (stop && rungs.length) ev = ladderExpectedValue({samples, entry:last, stop, targets:rungs.map(r=>r.price), sellPcts:[25,30,30]});
  out.push({tk, held:HELD.has(tk), date:rows.at(-1).date, last, chg:+(((last-prev)/prev)*100).toFixed(2),
    rsi:rsi&&+rsi.toFixed(1), atr:+atr.toFixed(2), ma:(last>ma20?"A":"b")+(last>ma50?"A":"b")+(last>ma200?"A":"b"),
    macdH: macd? +(macd.histogram ?? macd.hist ?? 0).toFixed(3):null,
    support, stop, rungs:rungs.map(r=>+r.price.toFixed(2)),
    ev: ev? +(ev.ev*100).toFixed(2):null, risk: ev? +(ev.riskPct*100).toFixed(1):null,
    pT1: ev? Math.round(ev.rungs[0].p*100):null, pStop: ev? Math.round(ev.pStop*100):null,
    up1: ev? +(ev.rungs[0].gain*100).toFixed(1):null,
    volRatio: (()=>{const v=relativeVolume(rows); return v==null?null:+v.toFixed(2);})()});
}
out.sort((a,b)=>(b.ev??-99)-(a.ev??-99));
console.log("tk    H date        last     chg%   rsi  ma   macdH    sup     stop   T1     +T1%  P(T1) P(stp) risk%  EV%   vol×");
for (const o of out) console.log(
 `${o.tk.padEnd(5)} ${o.held?"*":" "} ${o.date} ${String(o.last).padStart(7)} ${String(o.chg).padStart(6)} ${String(o.rsi).padStart(5)} ${o.ma} ${String(o.macdH).padStart(7)} ${String(o.support??"-").padStart(7)} ${String(o.stop??"-").padStart(7)} ${String(o.rungs[0]??"-").padStart(7)} ${String(o.up1??"-").padStart(5)} ${String(o.pT1??"-").padStart(5)} ${String(o.pStop??"-").padStart(6)} ${String(o.risk??"-").padStart(5)} ${String(o.ev??"-").padStart(6)}  ${o.volRatio}`);
