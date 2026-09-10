#!/usr/bin/env node
// Board-wide ranking: recomputes technicals, ladder and probability-weighted
// expected value for every ticker with a CSV, using each card's own deliberate
// support/stop where one exists. Entry is SPOT, so this answers "should I buy
// this today", not "was the original entry good". Sorted by EV descending.
//   node --env-file=.env scripts/scan-board.mjs
import { readdirSync } from "fs";
import { createClient } from "@supabase/supabase-js";
import { parseCsv, sma, computeMACD, computeATR, rsiWilder, findSwings } from "./csv-technicals.mjs";
import { buildLadder } from "./build-ladder.mjs";
import { excursionStats, ladderExpectedValue } from "./target-probability.mjs";

const s = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
const { data: users } = await s.auth.admin.listUsers();
const u = users.users.find(x => x.email === process.env.ANALYSIS_USER_EMAIL);
const { data: notes } = await s.from("analysis_notes").select("ticker,chart_data").eq("user_id", u.id);
const N = Object.fromEntries(notes.map(r=>[r.ticker, r.chart_data||{}]));

const DIR = "../price-history";
const MAP = {
 ADIB:"Abu Dhabi Islamic Bank", ABUK:"Abu Qir Fertilizers", ARCC:"Arabian Cement", CLHO:"Cleopatra Hospital",
 COMI:"Commercial Int Bank", EFIH:"E-finance", HRHO:"EFG Hermes", PHAR:"EIPICO", EAST:"Eastern Tobacco",
 EFID:"Edita Food", EMFD:"Emaar Misr", FWRY:"Fawry", GBCO:"GB AUTO", ISPH:"Ibnsina Pharma", JUFO:"Juhayna Food",
 MASR:"Madinet Nasr", MGHD:"Misr El Gadida", ORAS:"Orascom Construction", ORHD:"Orascom Hotels",
 ORWE:"Oriental Weavers", PHDC:"Palm Hills", RACC:"Raya Contact Center", RAYA:"Raya Holding",
 SCEM:"Sinai Cement", TMGH:"T M G Holding", TAQA:"TAQA Arabia", TALM:"Taaleem", ETEL:"Telecom Egypt",
};
const HELD = new Set(["ADIB","COMI","EFIH","PHAR","EFID","MASR","ORAS","ORHD","RAYA","TMGH","ETEL"]);
const files = readdirSync(DIR).filter(f=>f.endsWith(".csv"));
const out=[];
for (const [tk, frag] of Object.entries(MAP)) {
  const f = files.find(x => x.startsWith(frag)); if (!f) continue;
  const rows = parseCsv(`${DIR}/${f}`);
  const closes = rows.map(r=>r.close);
  const last = closes.at(-1), prev = closes.at(-2);
  const atr = computeATR(rows,14), rsi = rsiWilder(closes), macd = computeMACD(closes);
  const ma20=sma(closes,20), ma50=sma(closes,50), ma200=sma(closes,200);
  const { rungs } = buildLadder(rows,{maxRungs:3});
  const card = N[tk] || {};
  // support: prefer the card's deliberate level if it is still below spot; else recent swing low
  const sw = findSwings(rows,5).lows.slice(-40).map(x=>x.price);
  const computedSup = sw.filter(p=>p<last*0.999).sort((a,b)=>b-a)[0] ?? null;
  let support = (card.support && card.support < last*0.999) ? card.support : computedSup;
  // Use the STRUCTURALLY CORRECT stop, not whatever happens to be resting.
  // Flaw found 2026-09-10: this scan ranked MASR at EV 0.84% because it used
  // the live 8.10 stop, which sits 1.5% away and is therefore hit constantly -
  // crushing P(T1) to 43%. With a coherent stop below the 7.79 support the
  // same setup scores 2.10% / 77%. Ranking "is this worth buying" against a
  // badly-placed stop conflates the quality of the setup with the quality of
  // the current order, and understates every name whose stop needs fixing.
  const structural = support ? +(support - atr * 0.6).toFixed(2) : null;
  let stop = structural ?? ((card.stop && card.stop < last) ? card.stop : null);
  const samples = excursionStats(rows,{horizon:20});
  let ev=null;
  if (stop && rungs.length) ev = ladderExpectedValue({samples, entry:last, stop, targets:rungs.map(r=>r.price), sellPcts:[25,30,30]});
  const vol10 = rows.slice(-10).reduce((a,r)=>a+r.volume,0)/10;
  out.push({tk, held:HELD.has(tk), date:rows.at(-1).date, last, chg:+(((last-prev)/prev)*100).toFixed(2),
    rsi:rsi&&+rsi.toFixed(1), atr:+atr.toFixed(2), ma:(last>ma20?"A":"b")+(last>ma50?"A":"b")+(last>ma200?"A":"b"),
    macdH: macd? +(macd.histogram ?? macd.hist ?? 0).toFixed(3):null,
    support, stop, rungs:rungs.map(r=>+r.price.toFixed(2)),
    ev: ev? +(ev.ev*100).toFixed(2):null, risk: ev? +(ev.riskPct*100).toFixed(1):null,
    pT1: ev? Math.round(ev.rungs[0].p*100):null, pStop: ev? Math.round(ev.pStop*100):null,
    up1: ev? +(ev.rungs[0].gain*100).toFixed(1):null,
    volRatio: +(rows.at(-1).volume/vol10).toFixed(2)});
}
out.sort((a,b)=>(b.ev??-99)-(a.ev??-99));
console.log("tk    H date        last     chg%   rsi  ma   macdH    sup     stop   T1     +T1%  P(T1) P(stp) risk%  EV%   vol×");
for (const o of out) console.log(
 `${o.tk.padEnd(5)} ${o.held?"*":" "} ${o.date} ${String(o.last).padStart(7)} ${String(o.chg).padStart(6)} ${String(o.rsi).padStart(5)} ${o.ma} ${String(o.macdH).padStart(7)} ${String(o.support??"-").padStart(7)} ${String(o.stop??"-").padStart(7)} ${String(o.rungs[0]??"-").padStart(7)} ${String(o.up1??"-").padStart(5)} ${String(o.pT1??"-").padStart(5)} ${String(o.pStop??"-").padStart(6)} ${String(o.risk??"-").padStart(5)} ${String(o.ev??"-").padStart(6)}  ${o.volRatio}`);
