#!/usr/bin/env node
// REFRESH CARD OHLC - repoint every card's chart arrays at the CSVs.
//
// ONE JOB: keep chart_data.{closes,highs,lows,volumes} equal to the last
// WINDOW_BARS of price-history. It touches nothing else on the card.
//
// WHY. The arrays are what the WEBSITE plots and what dump-levels.mjs derives
// lastClose from, so a stale array means the site shows one price and every
// script shows another. On 2026-09-19 all 26 stock cards were four sessions
// behind: the site had ETEL at 127.31 against a real 133.00, TALM at 18.90
// against 22.20. Nothing failed - the chart simply ended early, which is
// invisible unless you know what the last bar should be.
//
// Usage: node --env-file=.env scripts/refresh-card-ohlc.mjs [--dry-run]
import { createClient } from "@supabase/supabase-js";
import { parseCsv } from "./csv-technicals.mjs";
import { csvFileFor } from "./tickers.mjs";
import { WINDOW_BARS } from "./price-levels.mjs";

const DRY = process.argv.includes("--dry-run");
const s = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
const { data: users } = await s.auth.admin.listUsers();
const u = users.users.find((x) => x.email === process.env.ANALYSIS_USER_EMAIL);
const { data: notes } = await s.from("analysis_notes").select("ticker,chart_data,summary").eq("user_id", u.id);

const rows = [];
for (const n of notes) {
  const d = n.chart_data;
  if (!d || typeof d === "string" || !Array.isArray(d.closes)) continue;  // text notes, index cards
  let bars;
  try { bars = parseCsv(csvFileFor(n.ticker)); } catch { console.log(`  ! ${n.ticker}: no CSV, skipped`); continue; }
  const w = bars.slice(-WINDOW_BARS);
  const was = d.closes[d.closes.length - 1], now = w[w.length - 1].close;
  if (was === now && d.closes.length === w.length) continue;
  console.log(`  ${n.ticker.padEnd(6)} last bar ${String(was).padStart(8)} -> ${String(now).padStart(8)}   ${d.closes.length} -> ${w.length} bars   (${w[w.length-1].date})`);
  rows.push({ user_id: u.id, ticker: n.ticker, summary: n.summary,
    chart_data: { ...d, closes: w.map(r=>r.close), highs: w.map(r=>r.high), lows: w.map(r=>r.low), volumes: w.map(r=>r.volume), lastUpdated: w[w.length-1].date },
    refreshed_at: new Date().toISOString() });
}
if (DRY) { console.log(`\n[dry-run] ${rows.length} cards would be refreshed.`); process.exit(0); }
if (rows.length) {
  const { error } = await s.from("analysis_notes").upsert(rows, { onConflict: "user_id,ticker" });
  if (error) { console.error(error); process.exit(1); }
}
console.log(`\nRefreshed ${rows.length} cards.`);
