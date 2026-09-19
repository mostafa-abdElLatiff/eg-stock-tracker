#!/usr/bin/env node
// ATTEST SECTIONS — bump sectionChecks dates, but ONLY where there is evidence.
//
// ONE JOB: mark a card section as re-verified on the date it was actually
// re-verified, and leave the rest flagged.
//
// WHY THIS IS NOT "bump every date". sectionChecks exists so staleness is
// visible on the site. Bumping a date without doing the review is worse than
// leaving it stale - it converts an honest "nobody has looked at this" into a
// false "someone checked". webapp/CLAUDE.md: "'Checked' is a distinct claim
// from 'updated'."
//
// THE EVIDENCE IS THE NUMBERS FILE. A section is attested only when the latest
// journal/analyses/<date>-full-analysis.json actually contains the derivation:
//
//   technicals   <- the run computed price, RSI, ATR, levels, stop and targets
//   fundamentals <- the run resolved latestVsPrior() and ran the two-gate test
//
// pattern and outlook are PROSE about what the chart means and where it goes.
// No script produces those, so no script may attest them. They stay flagged
// until a session reads them against the new price action. On 2026-09-19 that
// left 2 sections x 26 cards honestly outstanding, and that is the correct
// output, not a failure.
//
// Usage: node --env-file=.env scripts/attest-sections.mjs [--dry-run]
import { createClient } from "@supabase/supabase-js";
import { readFileSync, readdirSync } from "fs";

const ROOT = new URL("../../", import.meta.url).pathname;
const DRY = process.argv.includes("--dry-run");

const files = readdirSync(`${ROOT}journal/analyses`).filter((f) => f.endsWith("-full-analysis.json")).sort();
if (!files.length) { console.error("No full-analysis.json - run scripts/full-analysis.mjs first."); process.exit(1); }
const run = JSON.parse(readFileSync(`${ROOT}journal/analyses/${files[files.length - 1]}`, "utf8"));
const asOf = run.dataAsOf;
const evidence = {};
for (const r of run.results) {
  evidence[r.ticker] = {
    technicals: !!(r.price && r.rsi && r.atr && (r.stop || r.stopBlocked) && Array.isArray(r.targets)),
    fundamentals: !!(r.fundamentals && !r.fundamentals._missing && r.fundamentals.gate),
  };
}

const s = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
const { data: users } = await s.auth.admin.listUsers();
const u = users.users.find((x) => x.email === process.env.ANALYSIS_USER_EMAIL);
const { data: notes } = await s.from("analysis_notes").select("ticker,chart_data,summary").eq("user_id", u.id);

const rows = [], attested = [], outstanding = [];
for (const n of notes) {
  const d = n.chart_data;
  if (!d || typeof d === "string") continue;
  const ev = evidence[n.ticker];
  const sc = { ...(d.sectionChecks || {}) };
  let touched = false;
  for (const sec of ["technicals", "fundamentals"]) {
    if (ev?.[sec] && sc[sec] !== asOf) { sc[sec] = asOf; touched = true; attested.push(`${n.ticker}.${sec}`); }
  }
  for (const sec of ["pattern", "outlook"]) {
    if (d[sec === "pattern" ? "pattern" : "long"] && sc[sec] && sc[sec] < (d.lastUpdated ?? asOf)) outstanding.push(`${n.ticker}.${sec}`);
  }
  if (touched) rows.push({ user_id: u.id, ticker: n.ticker, summary: n.summary,
    chart_data: { ...d, sectionChecks: sc }, refreshed_at: new Date().toISOString() });
}
console.log(`Evidence from ${files[files.length - 1]} (data as of ${asOf}).\n`);
console.log(`ATTESTED (${attested.length}) - the numbers file carries the derivation:`);
console.log("  " + attested.join(", ") || "  none");
console.log(`\nSTILL OUTSTANDING (${outstanding.length}) - prose, needs a session to read it:`);
console.log("  " + (outstanding.join(", ") || "none"));
if (DRY) { console.log(`\n[dry-run] ${rows.length} cards would be updated.`); process.exit(0); }
if (rows.length) {
  const { error } = await s.from("analysis_notes").upsert(rows, { onConflict: "user_id,ticker" });
  if (error) { console.error(error); process.exit(1); }
}
console.log(`\nUpdated ${rows.length} cards.`);
