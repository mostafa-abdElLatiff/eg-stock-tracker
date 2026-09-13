#!/usr/bin/env node
// Dump the levels currently stored on every analysis_notes card, so
// level-map-refresh.mjs has something to diff against.
//
// Kept as a real script rather than an inline one-off because the refresh is
// a two-step job - snapshot what is stored, then compute what should be -
// and the snapshot half was the part that kept getting re-typed.
//
// Usage: node --env-file=.env scripts/dump-levels.mjs > ../journal/stored-levels.json
import { createClient } from "@supabase/supabase-js";

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
const { data: users } = await supabase.auth.admin.listUsers();
const user = users.users.find((u) => u.email === process.env.ANALYSIS_USER_EMAIL);
if (!user) { console.error(`No auth user for ${process.env.ANALYSIS_USER_EMAIL}`); process.exit(1); }

const { data: rows, error } = await supabase.from("analysis_notes").select("ticker, chart_data").eq("user_id", user.id);
if (error) { console.error(error.message); process.exit(1); }

const out = {};
for (const r of rows) {
  const d = r.chart_data;
  if (!d || typeof d === "string") { out[r.ticker] = { note: "plain text note, not a chart card" }; continue; }
  out[r.ticker] = {
    kind: d.kind ?? "held", support: d.support ?? null, resistance: d.resistance ?? null,
    stop: d.stop ?? null, trailing: d.trailing ?? null, targets: d.targets ?? null,
    fundamentalTarget: d.fundamentalTarget ?? null, verdictScore: d.verdictScore ?? null,
    holdingScore: d.holdingScore ?? null, rsi: d.rsi ?? null, lastUpdated: d.lastUpdated ?? null,
    bars: Array.isArray(d.closes) ? d.closes.length : 0,
    lastClose: Array.isArray(d.closes) ? d.closes[d.closes.length - 1] : null,
    sectionChecks: d.sectionChecks ?? null,
  };
}
console.log(JSON.stringify(out, null, 2));
