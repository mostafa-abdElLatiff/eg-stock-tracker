#!/usr/bin/env node
// THE ticker registry. One definition, imported everywhere.
//
// WHY. On 2026-09-14 eight scripts each carried their own hardcoded ticker map -
// 14 to 43 entries, and all eight missing the same four tickers. That single
// fact produced four separate bugs this project treated as unrelated one-offs:
//   * price-levels.mjs could not find TALM, RACC or ABUK without --csv
//   * score-recommendations.mjs reported "no CSV for EXPA" while the file existed,
//     so a live buy recommendation silently went ungraded
//   * backfill-eodhd.mjs failed on AMOC/MCQE/POUL/PHTV with "no filename mapping"
//   * audit-orders.mjs silently skipped any position it had no entry for
// A tool that SKIPS what it cannot map is the dangerous kind of wrong: the
// output looks complete. Everything here throws instead.
//
// THREE DISTINCT MAPS, because they are three different things and conflating
// them was part of the confusion:
//   csvPrefix   - the start of the price-history filename
//   company     - the full company name, for news queries
//   eodhd       - the API symbol for EODHD
//
// Usage:  import { csvFileFor, companyFor, eodhdFor, coverage } from "./tickers.mjs";
//         node tickers.mjs            - print a coverage report

import { readdirSync, existsSync } from "fs";

const ROOT = new URL("../../", import.meta.url).pathname;

export const csvPrefix = {
  ABUK:"Abu Qir", ADIB:"Abu Dhabi", AFDI:"Al Ahly Development", AMOC:"Alexandria Mineral Oils",
  ARCC:"Arabian Cement", CAED:"Cairo Educational", CLHO:"Cleopatra", COMI:"Commercial Int",
  EASB:"Egyptian Arabian Themar", EAST:"Eastern Tobacco", EEII:"Arab Engineering", EFID:"Edita",
  EFIH:"E-finance", EMFD:"Emaar Misr", ENGC:"Industrial Engineering", ETEL:"Telecom Egypt",
  EXPA:"Export Development", FWRY:"Fawry", GBCO:"GB AUTO", HELI:"Misr El Gadida",
  HRHO:"EFG Hermes", ISMA:"Ismailia Misr Poultry", ISMQ:"Iron and Steel Mines", ISPH:"Ibnsina",
  JUFO:"Juhayna", KORA:"Korra Energy", MASR:"Madinet Nasr", MCQE:"Misr Cement Qena",
  MFPC:"Misr Fertilizers", MTIE:"MM Group", ORAS:"Orascom Construction", ORHD:"Orascom Hotels",
  ORWE:"Oriental Weavers", PHAR:"EIPICO", PHDC:"Palm Hills", PHTV:"Pyramisa Hotels",
  POUL:"Cairo Poultry", QNBE:"QNB Alahli", RACC:"Raya Contact", RAYA:"Raya Holding",
  SCEM:"Sinai Cement", TALM:"Taaleem", TAQA:"TAQA", TMGH:"T M G",
};

export const company = {
  ABUK:"Abu Qir Fertilizers", ADIB:"Abu Dhabi Islamic Bank Egypt", AMOC:"Alexandria Mineral Oils",
  ARCC:"Arabian Cement", CLHO:"Cleopatra Hospital", COMI:"Commercial International Bank Egypt",
  EAST:"Eastern Tobacco", EFID:"Edita Food", EFIH:"e-finance Egypt", ENGC:"Industrial Engineering Company",
  ETEL:"Telecom Egypt", EXPA:"Export Development Bank Egypt", FWRY:"Fawry", GBCO:"GB Auto",
  HRHO:"EFG Hermes", ISPH:"Ibnsina Pharma", JUFO:"Juhayna Food", MASR:"Madinet Masr",
  MCQE:"Misr Cement Qena", MFPC:"MOPCO Misr Fertilizers", ORAS:"Orascom Construction",
  ORHD:"Orascom Development", ORWE:"Oriental Weavers", PHAR:"EIPICO", PHDC:"Palm Hills Developments",
  PHTV:"Pyramisa Hotels", POUL:"Cairo Poultry", QNBE:"QNB Alahli", RACC:"Raya Contact Center",
  RAYA:"Raya Holding", SCEM:"Sinai Cement", TALM:"Taaleem Management Services", TAQA:"TAQA Arabia",
  TMGH:"Talaat Moustafa Group",
};

export const eodhd = Object.fromEntries(Object.keys(csvPrefix).map((t) => [t, `${t}.EGX`]));

/** Resolve a ticker to its real price-history file. THROWS - never returns null. */
export function csvFileFor(ticker) {
  const t = ticker.toUpperCase();
  const pre = csvPrefix[t];
  if (!pre) throw new Error(`No csvPrefix for ${t} - add it to webapp/scripts/tickers.mjs. Do NOT skip it silently.`);
  const dir = `${ROOT}price-history`;
  const f = readdirSync(dir).find((x) => x.startsWith(pre) && x.endsWith(".csv"));
  if (!f) throw new Error(`csvPrefix "${pre}" for ${t} matches no file in price-history/. Bootstrap it first.`);
  return `${dir}/${f}`;
}
export const companyFor = (t) => company[t.toUpperCase()] ?? null;
export const eodhdFor  = (t) => eodhd[t.toUpperCase()] ?? null;

/** Which tickers have no file, and which files no ticker claims. */
export function coverage() {
  const dir = `${ROOT}price-history`;
  const files = existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith(".csv")) : [];
  const claimed = new Set();
  const missing = [];
  for (const [t, pre] of Object.entries(csvPrefix)) {
    const f = files.find((x) => x.startsWith(pre));
    if (f) claimed.add(f); else missing.push(t);
  }
  return { missing, orphanFiles: files.filter((f) => !claimed.has(f)), total: Object.keys(csvPrefix).length, files: files.length };
}

const isMain = process.argv[1] && import.meta.url.endsWith(process.argv[1].split("/").pop());
if (isMain) {
  const c = coverage();
  console.log(`${c.total} tickers mapped, ${c.files} CSVs on disk`);
  console.log(`\ntickers with NO price history (${c.missing.length}): ${c.missing.join(" ") || "none"}`);
  console.log(`CSVs no ticker claims (${c.orphanFiles.length}):`);
  for (const f of c.orphanFiles) console.log(`   ${f}`);
}
