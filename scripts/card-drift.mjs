#!/usr/bin/env node
// CARD DRIFT - recompute every card by PROCEDURES.md and diff against what is stored.
//
// ONE JOB: find where journal/stored-levels.json has drifted from what the
// rules now produce. It changes nothing - it reports, because a stop moves only
// when the MARKET moves and a card is rewritten deliberately, never by a script.
//
// Run it in step 5 of the daily run, BEFORE writing any analysis. First run
// (2026-09-19) found 109 deviations across 32 cards, including four whose
// target 1 sat above the 90-day high - unreachable, the CLHO defect that cost
// real money, sitting undetected in live cards.
//
// Usage: node --env-file=.env scripts/card-drift.mjs
import { readFileSync } from "fs";
const R=new URL("../../",import.meta.url).pathname, W=R+"webapp/scripts/";
const {parseCsv,rsiWilder,computeATR}=await import(W+"csv-technicals.mjs");
const {priceLevels}=await import(W+"price-levels.mjs");
const {stopFor}=await import(W+"stop-rule.mjs");
const {buildLadder}=await import(W+"build-ladder.mjs");
const {csvFileFor,csvPrefix}=await import(W+"tickers.mjs");
const {latestVsPrior}=await import(W+"lib/fundamentals.mjs");
const J=p=>JSON.parse(readFileSync(R+p,"utf8"));
const CARD=J("journal/stored-levels.json"), POS=J("journal/positions.json");
const HELD=Object.fromEntries(POS.stocks.map(s=>[s.ticker,s]));
const ORD=Object.fromEntries(POS.openBuyOrders.map(o=>[o.ticker,o]));

const dev=[];
const D=(tk,field,stored,now,note)=>dev.push({tk,field,stored,now,note});
const near=(a,b,tol=0.011)=>a!=null&&b!=null&&Math.abs(a-b)<=tol*Math.max(Math.abs(a),1);

for(const tk of Object.keys(CARD).filter(x=>!x.startsWith("_"))){
 const c=CARD[tk]; if(!c||typeof c!=="object"||c.note) continue;
 let rows; try{rows=parseCsv(csvFileFor(tk));}catch{ D(tk,"CSV",null,null,"no CSV for a ticker that has a card"); continue; }
 const map=priceLevels(rows), last=map.last, asOf=rows.at(-1).date;
 const held=HELD[tk], ord=ORD[tk];
 const entry = held? held.avgCost : ord? ord.price : last;

 if(!near(c.lastClose,last,0.001)) D(tk,"lastClose",c.lastClose,last,`card dated ${c.lastUpdated}, data to ${asOf}`);
 const rsi=rsiWilder(rows.map(r=>r.close));
 if(c.rsi!=null && Math.abs(c.rsi-rsi)>3) D(tk,"rsi",c.rsi,+rsi.toFixed(0),"card RSI vs rsiWilder now");

 // support: card vs the level map's nearest strength>=3 below spot
 const below=map.levels.filter(l=>l.price<last).sort((a,b)=>b.price-a.price);
 const sup=below.find(l=>l.strength>=3);
 if(c.support!=null && sup && !near(c.support,sup.price,0.005))
   D(tk,"support",c.support,sup.price,`now str${sup.strength}`);

 // stop: card vs stopFor anchored to ENTRY (P1 step 3 / P2)
 const f=stopFor({...map,last:entry});
 if(c.stop!=null && f && !near(c.stop,f.stop,0.005))
   D(tk,"stop",c.stop,f.stop,`anchor ${f.level.price} str${f.level.strength}, entry ${entry}`);
 if(f && f.stop>=entry) D(tk,"stop",c.stop,f.stop,"*** STOP AT/ABOVE ENTRY ***");

 // targets: card rungs vs buildLadder, and the P3 reachability test
 const rungs=buildLadder(rows,{maxRungs:3}).rungs.map(r=>+r.price.toFixed(2));
 if(Array.isArray(c.targets)&&c.targets.length){
   const hi90=Math.max(...rows.slice(-90).map(r=>r.high));
   // A rung above the 90-day high is a DEFECT only when real resistance exists
   // below it - then the ladder skipped a level price must trade through.
   // With nothing overhead (ETEL, TALM at all-time highs) an extension is the
   // documented fallback, not an error: check-consistency.mjs says so in its
   // own header, and P3 says the same. Flagging those was a false positive.
   const overhead=map.levels.filter(l=>l.price>last&&l.strength>=3);
   if(c.targets[0]>hi90&&overhead.length)
     D(tk,"target1",c.targets[0],rungs[0]??null,`*** UNREACHABLE: above the 90-day high ${hi90} with real resistance at ${overhead[0].price} ***`);
   else if(c.targets[0]>hi90)
     D(tk,"target1",c.targets[0],rungs[0]??null,`extension above the 90-day high ${hi90} - LEGITIMATE, nothing overhead in the window`);
   else if(rungs.length&&!near(c.targets[0],rungs[0],0.005)) D(tk,"target1",c.targets[0],rungs[0],"ladder moved");
 }
 if(c.fundamentalTarget!=null && Array.isArray(c.targets) && c.targets.includes(c.fundamentalTarget))
   D(tk,"targets",c.fundamentalTarget,null,"*** analyst target used as a technical rung ***");

 // live stop vs the rule
 if(held?.stop!=null && f && !near(held.stop,f.stop,0.005))
   D(tk,"LIVE stop",held.stop,f.stop,"live order vs rule (do NOT move silently)");

 // gate
 const fu=latestVsPrior(tk,last);
 if(fu.status!=="ok") D(tk,"fundamentals",null,null,"not fetched - "+fu.checked.join(" / "));
}
console.log("DEVIATIONS:",dev.length,"\n");
const bad=dev.filter(d=>/\*\*\*/.test(d.note||""));
if(bad.length){console.log("=== CRITICAL ==="); for(const d of bad) console.log(`  ${d.tk.padEnd(6)} ${d.field.padEnd(11)} stored ${String(d.stored).padStart(9)} -> now ${String(d.now).padStart(9)}  ${d.note}`);}
console.log("\n=== ALL ===");
const by={}; for(const d of dev)(by[d.field]=by[d.field]||[]).push(d);
for(const [f,l] of Object.entries(by).sort((a,b)=>b[1].length-a[1].length)){
 console.log(`\n${f}  (${l.length})`);
 for(const d of l) console.log(`  ${d.tk.padEnd(6)} stored ${String(d.stored).padStart(9)} -> now ${String(d.now).padStart(9)}   ${d.note??""}`);
}
