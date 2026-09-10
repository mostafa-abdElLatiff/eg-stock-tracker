#!/usr/bin/env node
// Merges a partial patch into existing chart_data instead of replacing it.
// update-analysis.mjs upserts the whole object, so using it for a small
// correction silently drops every field the payload omits. This exists so a
// one-field fix stays a one-field fix.
//
// Usage: node --env-file=.env scripts/patch-analysis.mjs patch.json
//   patch.json = { "TICKER": { field: value, ... }, ... }  (top-level merge)
import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "fs";

const { SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, ANALYSIS_USER_EMAIL } = process.env;
if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY || !ANALYSIS_USER_EMAIL) {
  console.error("Need SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, ANALYSIS_USER_EMAIL.");
  process.exit(1);
}
const s = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
const { data: users } = await s.auth.admin.listUsers();
const u = users.users.find((x) => x.email === ANALYSIS_USER_EMAIL);
if (!u) { console.error(`No auth user for ${ANALYSIS_USER_EMAIL}`); process.exit(1); }

const patch = JSON.parse(readFileSync(process.argv[2], "utf8"));
const { data: existing } = await s.from("analysis_notes").select("ticker,chart_data,summary").eq("user_id", u.id);
const byTicker = Object.fromEntries(existing.map((r) => [r.ticker, r]));

const rows = [];
for (const [ticker, fields] of Object.entries(patch)) {
  const cur = byTicker[ticker];
  if (!cur) { console.error(`  ! ${ticker}: no existing row, skipped`); continue; }
  const merged = { ...(cur.chart_data || {}), ...fields };
  rows.push({ user_id: u.id, ticker, summary: cur.summary, chart_data: merged,
              refreshed_at: new Date().toISOString() });
  console.log(`  ${ticker}: ${Object.keys(fields).length} field(s)`);
}
const { error } = await s.from("analysis_notes").upsert(rows, { onConflict: "user_id,ticker" });
if (error) { console.error("write failed:", error.message); process.exit(1); }
console.log(`Patched ${rows.length} rows.`);
