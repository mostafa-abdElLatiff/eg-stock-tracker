#!/usr/bin/env node
// SYNC CARD PROSE - make the labelled numbers in prose match the structured fields.
//
// ONE JOB: rewrite "<strong>Support 40.18</strong>" to name the CURRENT support
// when the structured field has moved. It edits ONLY the number inside a short
// <strong> level label - the same span check-consistency.mjs reads - and never
// touches argument, reasoning or any other text.
//
// WHY. webapp/CLAUDE.md: "after changing any structured price field, grep that
// same ticker's why/buyApproach/planStatus/actionNeeded for the OLD number and
// rewrite it in the same pass - never treat the structured field and the
// sentence describing it as separate edits." On 2026-09-19 a bulk card
// correction updated 26 cards' support/stop/targets and left every sentence
// describing them untouched: check-consistency went 135 -> 180. The rule was
// written down and still broken, which is why this is a script rather than a
// reminder.
//
// dailyFlag is deliberately excluded - it is a dated log entry ("Sep 17: ...")
// and is allowed to describe what was true that day.
//
// Usage: node --env-file=.env scripts/sync-card-prose.mjs [--dry-run]
import { createClient } from "@supabase/supabase-js";

const DRY = process.argv.includes("--dry-run");
const FIELDS = ["why", "buyApproach", "planStatus", "actionNeeded", "pattern", "levelNote", "short", "medium", "long", "stopNote"];
const LEVELS = [["support", "support"], ["resistance", "resistance"], ["stop", "stop"]];
const MAX_LABEL_SPAN = 40;

const s = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
const { data: users } = await s.auth.admin.listUsers();
const u = users.users.find((x) => x.email === process.env.ANALYSIS_USER_EMAIL);
const { data: notes } = await s.from("analysis_notes").select("ticker,chart_data,summary").eq("user_id", u.id);

const rows = [], log = [];
for (const n of notes) {
  const d = n.chart_data;
  if (!d || typeof d === "string") continue;
  const next = { ...d };
  let touched = false;
  for (const f of FIELDS) {
    if (typeof next[f] !== "string") continue;
    let text = next[f];
    for (const [key, field] of LEVELS) {
      const value = d[field];
      if (value == null) continue;
      const re = new RegExp(`<strong>([^<]*${key}[^<]*?)(\\d+\\.?\\d*)</strong>`, "gi");
      text = text.replace(re, (whole, lead, num) => {
        if ((lead + num).length > MAX_LABEL_SPAN) return whole;
        const old = parseFloat(num.replace(/,/g, ""));
        if (!(Math.abs(old - value) / value > 0.03)) return whole;
        log.push(`  ${n.ticker.padEnd(6)} ${f}: ${key} ${old} -> ${value}`);
        return `<strong>${lead}${value}</strong>`;
      });
    }
    if (text !== next[f]) { next[f] = text; touched = true; }
  }
  if (touched) rows.push({ user_id: u.id, ticker: n.ticker, summary: n.summary, chart_data: next, refreshed_at: new Date().toISOString() });
}
console.log(log.join("\n"));
if (DRY) { console.log(`\n[dry-run] ${rows.length} cards, ${log.length} labels would change.`); process.exit(0); }
if (rows.length) {
  const { error } = await s.from("analysis_notes").upsert(rows, { onConflict: "user_id,ticker" });
  if (error) { console.error(error); process.exit(1); }
}
console.log(`\nSynced ${rows.length} cards, ${log.length} labels.`);
