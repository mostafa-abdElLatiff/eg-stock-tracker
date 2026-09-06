#!/usr/bin/env node
// Catches exactly the bug that shipped twice in one week (Sept 6 2026):
// support/resistance/stop/avgCost get updated as structured fields, but the
// prose that explains them (why/buyApproach/planStatus/actionNeeded) keeps
// describing the old number. Run this after EVERY analysis_notes write -
// not optional, not "when I remember" - before considering the task done.
//
// Usage: node --env-file=.env scripts/check-consistency.mjs
// Exits non-zero if it finds anything, so it can gate a workflow if needed.

import { createClient } from "@supabase/supabase-js";

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
const ANALYSIS_USER_EMAIL = process.env.ANALYSIS_USER_EMAIL;

// dailyFlag is deliberately excluded - it's a dated log entry ("Sep 3: ..."),
// allowed to describe what was true that day even after the number moved on.
const PROSE_FIELDS = ["why", "buyApproach", "planStatus", "actionNeeded", "stopNote"];

// Every card consistently labels these as "<strong>Support X.XX</strong>"
// (or "Stop-loss X.XX", "Trailing stop X.XX") - matching that exact
// convention instead of loose proximity avoids false positives from the
// word "stop" appearing elsewhere in a sentence (e.g. "stop-loss order").
function extractLabeledNumbers(text, keyword) {
  if (!text) return [];
  const clean = text.replace(/,/g, "");
  const re = new RegExp(`<strong>[^<]*${keyword}[^<]*?(\\d+\\.?\\d*)</strong>`, "gi");
  const results = [];
  let m;
  while ((m = re.exec(clean))) results.push(parseFloat(m[1]));
  return results;
}

function checkField(ticker, fieldName, text, level, value, tolerancePct = 3) {
  const issues = [];
  const mentions = extractLabeledNumbers(text, level);
  for (const num of mentions) {
    if (Math.abs(num - value) / value > tolerancePct / 100) {
      issues.push(`${fieldName}: labels ${level} as ${num}, but current ${level} field is ${value}`);
    }
  }
  return issues;
}

async function main() {
  const { data: users } = await supabase.auth.admin.listUsers();
  const user = users.users.find((u) => u.email === ANALYSIS_USER_EMAIL);
  if (!user) {
    console.error(`No auth user for ${ANALYSIS_USER_EMAIL}`);
    process.exit(1);
  }

  const { data: rows, error } = await supabase.from("analysis_notes").select("ticker, chart_data").eq("user_id", user.id);
  if (error) {
    console.error(error.message);
    process.exit(1);
  }

  let totalIssues = 0;
  for (const row of rows) {
    const d = row.chart_data;
    if (!d || typeof d === "string" || !d.closes) continue;
    const issues = [];

    for (const fieldName of PROSE_FIELDS) {
      const text = d[fieldName];
      if (!text) continue;
      if (d.support != null) issues.push(...checkField(row.ticker, fieldName, text, "support", d.support));
      if (d.resistance != null) issues.push(...checkField(row.ticker, fieldName, text, "resistance", d.resistance));
      if (d.stop != null) issues.push(...checkField(row.ticker, fieldName, text, "stop", d.stop));
    }

    if (issues.length) {
      totalIssues += issues.length;
      console.log(`\n=== ${row.ticker} ===`);
      issues.forEach((i) => console.log(" -", i));
    }
  }

  if (totalIssues === 0) {
    console.log("Clean - no stale prose/field mismatches found.");
  } else {
    console.log(`\n${totalIssues} potential issue(s) found - review before considering the refresh done.`);
    process.exit(1);
  }
}

main();
