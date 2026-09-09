import { createClient } from "@supabase/supabase-js";
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
const { data: users } = await supabase.auth.admin.listUsers();
const user = users.users.find(u => u.email === process.env.ANALYSIS_USER_EMAIL);
const { data: rows } = await supabase.from("analysis_notes").select("ticker, chart_data").eq("user_id", user.id);
const IDX = new Set(["EGX30","EGX33","EGX70EWI","EGX100EWI"]);
const HELD = ["MASR","ORHD","CLHO","ETEL","TMGH","RAYA","ORAS","EFID","EFIH","ADIB","COMI","PHAR"];
const out = [];
for (const r of rows) {
  const d = r.chart_data;
  if (!d || typeof d === "string" || !d.closes) continue;
  if (IDX.has(r.ticker) || d.kind === "rejected") continue;
  out.push({ t: r.ticker, held: HELD.includes(r.ticker), bars: d.closes.length,
    last: d.closes[d.closes.length-1], lastUpdated: d.lastUpdated,
    hasTP: !!d.targetProbability, hasVol: !!d.volumes });
}
out.sort((a,b)=> (b.held-a.held) || a.t.localeCompare(b.t));
console.log("ticker held bars lastClose lastUpdated hasTargetProb hasVol");
out.forEach(o=>console.log(`${o.t.padEnd(6)} ${o.held?"H":"-"}    ${String(o.bars).padStart(4)} ${String(o.last).padStart(9)} ${o.lastUpdated} ${o.hasTP?"Y":"n"} ${o.hasVol?"Y":"n"}`));
console.log(`\ntotal ${out.length}`);
