#!/usr/bin/env node
// Pushes analysis JSON (the same shape you'd paste into the "AI analysis"
// box in the app) directly into Supabase, so the website can be the single
// source of truth instead of a manual copy-paste-into-a-textarea step every
// time. Same trust model as refresh-prices.mjs: service role key, local/
// scripted use only, never shipped to the browser.
//
// Usage: node scripts/update-analysis.mjs path/to/payload.json
//   SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set (e.g. via
//   `node --env-file=.env scripts/update-analysis.mjs payload.json`).
//   ANALYSIS_USER_EMAIL must also be set, so the script knows whose
//   analysis_notes rows to write - this account's data is per-user.

import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "fs";

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const ANALYSIS_USER_EMAIL = process.env.ANALYSIS_USER_EMAIL;

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  console.error("Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY env vars.");
  process.exit(1);
}
if (!ANALYSIS_USER_EMAIL) {
  console.error("Missing ANALYSIS_USER_EMAIL env var - whose analysis_notes should this write to?");
  process.exit(1);
}

const payloadPath = process.argv[2];
if (!payloadPath) {
  console.error("Usage: node scripts/update-analysis.mjs path/to/payload.json");
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

async function main() {
  const { data: users, error: userErr } = await supabase.auth.admin.listUsers();
  if (userErr) {
    console.error("Failed to look up user:", userErr.message);
    process.exit(1);
  }
  const user = users.users.find((u) => u.email === ANALYSIS_USER_EMAIL);
  if (!user) {
    console.error(`No auth user found for ${ANALYSIS_USER_EMAIL} - sign in to the app at least once first.`);
    process.exit(1);
  }

  const parsed = JSON.parse(readFileSync(payloadPath, "utf8"));
  const rows = Object.entries(parsed).map(([ticker, val]) => {
    const isChart = val && typeof val === "object";
    return {
      user_id: user.id,
      ticker: ticker.trim(),
      summary: isChart ? String(val.summary || val.pattern || val.trendLabel || ticker) : String(val),
      chart_data: isChart ? val : null,
      refreshed_at: new Date().toISOString(),
    };
  });

  const { error } = await supabase.from("analysis_notes").upsert(rows);
  if (error) {
    console.error("Supabase write failed:", error.message);
    process.exit(1);
  }
  console.log(`Updated ${rows.length} analysis_notes rows:`, rows.map((r) => r.ticker).join(", "));
}

main();
