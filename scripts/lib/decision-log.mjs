// DECISION LOG — every number that changes an order, with how it was reached.
//
// ONE JOB: append. Never rewrite, never delete. The log is the record of what
// was decided, on what evidence, on what date.
//
// ---------------------------------------------------------------------------
// WHY
//
// Mostafa, 2026-09-20: "remember that I told you to log each number and how you
// calculated or reached it". `full-analysis.json` already carries a `how` for
// every COMPUTED number, but it is regenerated each run - it is a snapshot of
// what the rules say today, not a record of what was decided and why.
//
// A stop that moved from 775.08 to 797.58 needs both: the derivation (22-day
// high 890.00 minus 3 x ATR 30.81) AND the fact that it was a rule change
// rather than a market move, that it was raised deliberately, who asked, and
// what it replaced. Regenerating tomorrow's analysis must not erase that.
//
// This is append-only precisely because the previous format for this was chat,
// and chat gets summarised. Three stop values for ORHD in one week survived as
// numbers; the reasons did not.
//
// USE IT whenever a number changes something Mostafa will act on: a stop, a
// limit, a target, a position size, a gate verdict that flips.

import { readFileSync, writeFileSync, existsSync } from "fs";

const ROOT = new URL("../../../", import.meta.url).pathname;
const FILE = `${ROOT}journal/decision-log.json`;

function load() {
  if (!existsSync(FILE)) {
    return {
      _what: "Append-only record of every number that changed an order, and how it was reached. Written by lib/decision-log.mjs. NEVER hand-edit, never delete an entry - a superseded decision is corrected by appending a new one that references it.",
      _readBy: "Read this before changing any resting order. CLAUDE.md requires it.",
      entries: [],
    };
  }
  return JSON.parse(readFileSync(FILE, "utf8"));
}

/**
 * @param {object} d
 * @param {string} d.ticker
 * @param {string} d.field        what changed - "stop", "buyLimit", "targets", "size"
 * @param {*}      d.from         the previous value
 * @param {*}      d.to           the new value
 * @param {string} d.how          the arithmetic, with every input named
 * @param {string} d.why          why it was changed NOW - market move, rule fix, request
 * @param {string} [d.trigger]    who or what initiated it
 * @param {object} [d.evidence]   supporting measurements
 * @param {string} [d.status]     "proposed" until Mostafa places it, then "placed"
 */
export function logDecision(d) {
  if (!d.ticker || !d.field || !d.how || !d.why) {
    throw new Error("logDecision: ticker, field, how and why are all required - a number without its derivation is what this file exists to prevent");
  }
  const log = load();
  const entry = {
    at: new Date().toISOString(),
    dataAsOf: d.dataAsOf ?? null,
    ticker: d.ticker, field: d.field,
    from: d.from ?? null, to: d.to ?? null,
    how: d.how, why: d.why,
    trigger: d.trigger ?? "analysis",
    status: d.status ?? "proposed",
    evidence: d.evidence ?? null,
    supersedes: d.supersedes ?? null,
  };
  log.entries.push(entry);
  writeFileSync(FILE, JSON.stringify(log, null, 2) + "\n");
  return entry;
}

/** Every decision for a ticker, newest last. Read before changing its orders. */
export function decisionsFor(ticker) {
  return load().entries.filter((e) => e.ticker === ticker?.toUpperCase());
}

/** The current standing decision for one field, or null. */
export function latestDecision(ticker, field) {
  const all = decisionsFor(ticker).filter((e) => e.field === field);
  return all.length ? all[all.length - 1] : null;
}

/**
 * Proposals still awaiting placement at the broker.
 *
 * A superseded entry must NEVER appear here. On 2026-09-20 a first listing of
 * this filtered on status === "proposed" alone and surfaced a corrected ORAS
 * target ladder as if it were still standing - i.e. the append-only log was
 * about to hand back the very entry its correction existed to retract. An
 * entry is superseded when a LATER entry for the same ticker+field references
 * its timestamp, or simply supersedes it by being later and not itself
 * proposed.
 */
export function standingProposals(ticker = null) {
  const all = load().entries;
  const superseded = new Set(all.map((e) => e.supersedes).filter(Boolean));
  const out = [];
  for (let i = 0; i < all.length; i++) {
    const e = all[i];
    if (e.status !== "proposed") continue;
    if (superseded.has(e.at)) continue;
    if (ticker && e.ticker !== ticker.toUpperCase()) continue;
    // A later entry for the same ticker+field replaces this one regardless of
    // whether it bothered to set `supersedes`.
    if (all.slice(i + 1).some((x) => x.ticker === e.ticker && x.field === e.field)) continue;
    out.push(e);
  }
  return out;
}

/** Mark a proposed decision as actually placed at the broker. */
export function markPlaced(ticker, field, note = "") {
  const log = load();
  for (let i = log.entries.length - 1; i >= 0; i--) {
    const e = log.entries[i];
    if (e.ticker === ticker.toUpperCase() && e.field === field && e.status === "proposed") {
      e.status = "placed"; e.placedAt = new Date().toISOString();
      if (note) e.placedNote = note;
      writeFileSync(FILE, JSON.stringify(log, null, 2) + "\n");
      return e;
    }
  }
  return null;
}
