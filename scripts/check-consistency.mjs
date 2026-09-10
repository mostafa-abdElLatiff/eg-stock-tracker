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
import { readFileSync } from "fs";

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
const ANALYSIS_USER_EMAIL = process.env.ANALYSIS_USER_EMAIL;

// dailyFlag is deliberately excluded - it's a dated log entry ("Sep 3: ..."),
// allowed to describe what was true that day even after the number moved on.
const PROSE_FIELDS = ["why", "buyApproach", "planStatus", "actionNeeded", "stopNote"];

// Every card consistently labels these as "<strong>Support X.XX</strong>"
// (or "Stop-loss X.XX", "Trailing stop X.XX") - matching that exact
// convention instead of loose proximity avoids false positives from the
// word "stop" appearing elsewhere in a sentence (e.g. "stop-loss order").
// The span must be SHORT. Sept 9 2026: a card bolded a whole sentence that
// happened to contain the word "stop" - "<strong>Decide on the 8.10 stop
// before the open - it is 0.48x ATR away and today's low missed it by EGP
// 0.05.</strong>" - and this matched, capturing the trailing "05" from "0.05"
// as if it were a stop level, reporting "labels stop as 5". Bold is used two
// ways on these cards: short level labels ("Stop 39.90") and emphasis on a
// whole sentence. Only the first kind is a level declaration, and a 40-char
// cap is what separates them.
const MAX_LABEL_SPAN = 40;

function extractLabeledNumbers(text, keyword) {
  if (!text) return [];
  const clean = text.replace(/,/g, "");
  const re = new RegExp(`<strong>([^<]*${keyword}[^<]*?(\\d+\\.?\\d*))</strong>`, "gi");
  const results = [];
  let m;
  while ((m = re.exec(clean))) {
    if (m[1].length > MAX_LABEL_SPAN) continue;
    results.push(parseFloat(m[2]));
  }
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

// Catches the second recurring bug class (first caught live on ADIB, Sept 7
// 2026): a ticker gets a real buy transaction logged (the user tells us
// they bought it, or a transaction row exists) but chart_data.kind stays
// "opportunity" - so the card keeps presenting a held position as a
// prospective entry. Any ticker with a logged buy and kind:"opportunity"
// is flagged, even if the transaction's shares/date details are still
// incomplete - the kind tag shouldn't wait on that.
// Catches a third instance of the same bug shape (found live on ADIB, Sept
// 7 2026): when a ticker flips from opportunity to held (or back), the
// score field for its OLD state doesn't get cleared, and the card's score
// badge picks verdictScore over holdingScore whenever both are present
// (see analysis-chart.js's pill logic) - so a held stock kept showing its
// stale opportunity score. verdictScore is opportunity-only, holdingScore
// is held-only; a ticker should never carry both, or the wrong one showing.
function checkScoreFieldMismatches(rows) {
  const issues = [];
  for (const row of rows) {
    const d = row.chart_data;
    if (!d || typeof d === "string") continue;
    // "rejected" (added Sept 8 2026) keeps its verdictScore on purpose - it's
    // the documented evidence for why the ticker was avoided, and it's never
    // rendered (excluded from both sections in main.js) so it can't shadow
    // anything in the card pill. Only "opportunity" vs. everything-else
    // (held) needs the mutual-exclusivity check below.
    if (d.kind === "rejected") {
      if (d.holdingScore != null) issues.push(`${row.ticker}: kind is "rejected" but holdingScore (${d.holdingScore}) is set - rejected tickers were never held, clear it`);
      continue;
    }
    const isOpportunity = d.kind === "opportunity";
    if (isOpportunity && d.holdingScore != null) {
      issues.push(`${row.ticker}: kind is "opportunity" but holdingScore (${d.holdingScore}) is still set - clear it`);
    }
    if (!isOpportunity && d.verdictScore != null) {
      issues.push(`${row.ticker}: held (kind !== "opportunity") but verdictScore (${d.verdictScore}) is still set - clear it, it'll shadow holdingScore in the card's pill`);
    }
  }
  return issues;
}

// Catches the "checked" claim going stale (user request, Sept 8 2026,
// after repeatedly catching sections left old inside an otherwise-updated
// card): every ticker should carry a sectionChecks date per section
// (technicals/pattern/fundamentals/outlook) that's no older than
// lastUpdated - a section can be "checked, no change needed" without being
// rewritten, but it can't go unverified while the rest of the card moves
// on. Missing entirely is flagged the same as stale.
// Index/fund trackers (EGX30/EGX33/EGX70EWI/EGX100EWI) aren't individual
// stocks - they don't get the same per-section research depth (no real
// fundamentals workup, e.g.), so the sectionChecks convention doesn't
// apply to them the same way. Excluded here, not just in ad-hoc scripts.
const NON_STOCK_TICKERS = new Set(["EGX30", "EGX33", "EGX70EWI", "EGX100EWI"]);

// Catches EMPTY narrative fields on a card that claims to be checked. Found
// Sept 8 2026 on HRHO/ISPH/GBCO/PHDC/ARCC: cards created by the EGX100
// screening batches had levels, fundamentals and scores written but left
// `pattern`, `short`, `medium` and `volumeRead` as empty strings - and then
// stamped sectionChecks anyway.
//
// checkSectionChecks below could never catch it, because it asks whether a
// section HAS content via `!!(d.pattern || d.patternLabel)` - so a blank
// `pattern` sitting beside a populated `patternLabel` counts as present. The
// section got a check-date while its main prose field was empty. This is the
// absence-of-text sibling of the staleness checks: not old, simply missing.
function checkEmptyNarrative(rows) {
  const issues = [];
  const EXPECTED = ["pattern", "trendLabel", "short", "medium", "long", "why", "buyApproach"];
  for (const row of rows) {
    if (NON_STOCK_TICKERS.has(row.ticker)) continue;
    const d = row.chart_data;
    if (!d || typeof d === "string" || !d.closes || d.kind === "rejected") continue;
    for (const f of EXPECTED) {
      if (d[f] == null || String(d[f]).trim() === "") {
        issues.push(`${row.ticker}: ${f} is empty, but the card is stamped as checked`);
      }
    }
  }
  return issues;
}

function checkSectionChecks(rows) {
  const issues = [];
  const SECTIONS = ["technicals", "pattern", "fundamentals", "outlook"];
  for (const row of rows) {
    if (NON_STOCK_TICKERS.has(row.ticker)) continue;
    const d = row.chart_data;
    if (!d || typeof d === "string" || !d.closes || !d.lastUpdated) continue;
    // "rejected" tickers are frozen research, not actively maintained - they
    // don't need a fresh check-date every time the rest of the board moves.
    if (d.kind === "rejected") continue;
    // Only expect a section's check-date if the card actually has that
    // section's content - an opportunity with no fundamentals text yet
    // shouldn't be dinged for a missing fundamentals check-date.
    const hasContent = {
      technicals: d.support != null || d.resistance != null || d.stop != null,
      pattern: !!(d.pattern || d.patternLabel),
      fundamentals: !!(d.finPosition || d.cashFlow || d.profitability || d.valuation || d.newsRecent || d.qualityOfEarnings || d.capexTrend || d.dividendInfo || d.ownershipInfo),
      outlook: !!(d.short || d.medium || d.long),
    };
    for (const section of SECTIONS) {
      if (!hasContent[section]) continue;
      const checked = d.sectionChecks?.[section];
      if (!checked) {
        issues.push(`${row.ticker}: ${section} section has content but no sectionChecks.${section} date`);
      } else if (checked < d.lastUpdated) {
        issues.push(`${row.ticker}: sectionChecks.${section} (${checked}) is older than lastUpdated (${d.lastUpdated}) - re-verify and bump it`);
      }
    }
  }
  return issues;
}

// Catches a structural staleness class missed by every other check: a
// stock breaks out and keeps running, but "resistance" never gets updated
// even though price is now well above it (ETEL, Sept 8 2026 - caught by
// the user, not by this script, which is exactly the gap this closes).
// Real breakouts do run past resistance before anyone relabels it, so this
// only fires once the gap is real (>0.5%) and clearly stale, not a same-day
// intraday tag.
function checkStructuralStaleness(rows) {
  const issues = [];
  for (const row of rows) {
    const d = row.chart_data;
    if (!d || typeof d === "string" || !d.closes) continue;
    if (d.kind === "rejected") continue; // frozen research, price moves on without it
    const last = d.closes[d.closes.length - 1];
    if (d.resistance != null && last > d.resistance * 1.005) {
      issues.push(`${row.ticker}: resistance (${d.resistance}) is below the current close (${last}) - price already broke it, relabel (flip to support / clear if no real ceiling found) instead of leaving it stale`);
    }
    if (d.support != null && last < d.support * 0.995) {
      issues.push(`${row.ticker}: support (${d.support}) is above the current close (${last}) - price already broke below it, re-evaluate (stop may need triggering, or support needs revising down)`);
    }
  }
  return issues;
}

// Catches the fourth instance of this project's recurring bug shape, found by
// the user on ETEL (Sept 8 2026): the OHLC array gets refreshed but prose that
// quotes the latest price keeps citing the old one. ETEL simultaneously showed
// 120.12 (real close), 120.40 (a mid-session Mubasher print mistaken for the
// close) and 120.80 (the PREVIOUS day's close, still quoted in why/planStatus).
//
// Deliberately narrow. An earlier draft also matched a bare "at <number>",
// which flagged 20 citations of which most were legitimate stops, targets and
// named levels - useless. These four phrasings can only mean the latest price.
// <strong>...</strong> spans are stripped first: those are labelled levels and
// are already covered by checkField() above.
const PRICE_CITATIONS = [
  /\bclosed?\s+(?:at\s+)?(\d+\.\d{1,2})\b/gi,
  /\btrading\s+(?:at\s+)?(\d+\.\d{1,2})\b/gi,
  /\bcurrent(?:ly)?\s+(?:price\s+(?:of\s+)?)?(\d+\.\d{1,2})\b/gi,
  /\btoday'?s\s+(\d+\.\d{1,2})\b/gi,
];

// Sept 9 2026 - why this check passed a card that was visibly wrong.
//
// ETEL's planStatus read: Today's close was <strong>120.12</strong> ... while
// the real close was 125.99. The check below stripped every <strong> span
// before matching, so the emphasised price was deleted from the text and there
// was nothing left for the regex to catch. The strip exists to skip LABELLED
// levels ("<strong>Support 118.50</strong>"), which checkField already covers -
// but it was written as "strip all bold" and silently swallowed the exact class
// of citation this check is for. Emphasis is how a card marks its most
// important number, so blanket-stripping bold blinded the check to the numbers
// that matter most.
//
// Fix: strip a <strong> span only when it actually names a level.
const LEVEL_LABEL = /\b(support|resistance|stop|target|t[123])\b/i;
function stripLabelledLevels(raw) {
  return raw.replace(/<strong>(.*?)<\/strong>/gi, (m, inner) =>
    LEVEL_LABEL.test(inner) ? " " : inner);
}

// Widened Sept 9 2026 from four fields to the full set of present-tense fields.
// The old list omitted dailyFlag and volumeRead - the two fields whose entire
// job is to describe the latest session, and therefore the two most likely to
// be left describing the previous one.
const PRICE_CITATION_FIELDS = [
  "why", "buyApproach", "planStatus", "actionNeeded",
  "dailyFlag", "volumeRead", "pattern", "atrNote", "stopNote", "valuation",
];

function checkStalePriceCitations(rows) {
  const issues = [];
  for (const row of rows) {
    const d = row.chart_data;
    if (!d || typeof d === "string" || !d.closes || d.kind === "rejected") continue;
    const lastClose = d.closes[d.closes.length - 1];
    if (lastClose == null) continue;
    for (const field of PRICE_CITATION_FIELDS) {
      const raw = d[field];
      if (typeof raw !== "string") continue;
      const text = stripLabelledLevels(raw);
      for (const re of PRICE_CITATIONS) {
        re.lastIndex = 0;
        let m;
        while ((m = re.exec(text))) {
          const n = parseFloat(m[1]);
          const diff = Math.abs(n - lastClose) / lastClose;
          // Two real false-positive classes, both found on the first run:
          //  - "today's 41.95 low" / "...high" - a qualified intraday extreme,
          //    not the close (ORHD).
          //  - "closed 7.50 flat on Sept 6" - an explicitly dated historical
          //    reference, legitimately not today's price (RAYA).
          const after = text.slice(m.index + m[0].length, m.index + m[0].length + 40);
          const before = text.slice(Math.max(0, m.index - 40), m.index);
          if (/^\s*(low|high)\b/i.test(after)) continue;
          if (/\bon\s+(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)/i.test(after)) continue;
          //  - "A year ago this closed 25.00 vs 25.92 today" (HRHO) - an
          //    explicit historical comparison, correctly not today's price.
          if (/\b(a year ago|twelve months ago|12 months ago|last year|back in)\b[^.]*$/i.test(before)) continue;
          //  - "Sept 8 had spiked to 126.00 and given it all back to close at
          //    120.12" (ETEL) - the sentence already names WHICH session, so
          //    the price is correctly not today's. The existing guard above
          //    only handles the date coming AFTER the number ("closed 7.50 on
          //    Sept 6"); this handles it coming before.
          //    Split on ". " and not ".", or the decimal point inside "126.00"
          //    starts a new "sentence" and hides the date that precedes it -
          //    which is exactly what happened on the first run of this guard.
          const priorText = text.slice(0, m.index);
          const breakAt = Math.max(priorText.lastIndexOf(". "), priorText.lastIndexOf("? "), priorText.lastIndexOf("! "));
          const sentenceSoFar = priorText.slice(breakAt + 1);
          if (/\b(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sept?|Oct|Nov|Dec)\.?\s+\d{1,2}\b/i.test(sentenceSoFar)) continue;
          // >0.3% rules out rounding; <15% rules out a deliberate reference to
          // a distant level that happens to match one of these phrasings.
          if (diff > 0.003 && diff < 0.15) {
            issues.push(`${row.ticker}: ${field} says "${m[0].trim()}" but the latest close is ${lastClose} (${(diff * 100).toFixed(1)}% off)`);
          }
        }
      }
    }
  }
  return issues;
}

// Catches the fifth and hardest instance of this project's recurring bug: the
// NARRATIVE fields going stale. Found by the user on ETEL (Sept 8 2026), whose
// `pattern` still described "a peak of 118.97 (Aug 18), then a tight sideways
// range 116.00-116.50" while price was 120.12 after spiking to 126.40.
//
// What makes this class different, and why no earlier check caught it: every
// number in that text was HISTORICALLY ACCURATE. Nothing in it was wrong - it
// simply described a period that had ended three weeks earlier. Comparing
// numbers to fields cannot detect that, so this instead asks a different
// question: does the narrative still describe where the price actually is?
//
// The other 17 narrative fields on a card were previously validated by nothing
// at all, while sectionChecks stamped them "checked".
const NARRATIVE_FIELDS = ["pattern", "trendLabel", "short", "medium", "long", "volumeRead"];

function checkStaleNarrative(rows) {
  const issues = [];
  for (const row of rows) {
    const d = row.chart_data;
    if (!d || typeof d === "string" || !d.closes || d.kind === "rejected") continue;
    const last = d.closes[d.closes.length - 1];
    if (last == null) continue;
    for (const field of NARRATIVE_FIELDS) {
      const raw = d[field];
      if (typeof raw !== "string") continue;
      const text = raw.replace(/<[^>]+>/g, " ");
      const re = /(\d+\.\d{1,2})\s*(?:-|–|to)\s*(\d+\.\d{1,2})/g;
      let m;
      while ((m = re.exec(text))) {
        const lo = Math.min(+m[1], +m[2]), hi = Math.max(+m[1], +m[2]);
        // Skip ranges that plainly are not prices for this ticker - volume
        // figures in millions (EFID's "2.3-2.98") sit nowhere near the price.
        if (hi < last * 0.25 || lo > last * 4) continue;
        // Skip ranges that are plainly a metric, not a price. A P/E range like
        // "6.67-9.61" can sit inside the price band by coincidence (ORWE,
        // Sept 8) and is not a claim about where price is trading.
        const near = text.slice(Math.max(0, m.index - 30), m.index);
        if (/\b(P\/E|PEG|P\/B|P\/S|ratio|yield|RSI|ATR|margin|growth|multiple|EPS|ROE|ROIC)\b[^.]{0,25}$/i.test(near)) continue;
        // Skip ranges the text itself frames as historical context rather than
        // as a description of where price is now.
        const before = text.slice(Math.max(0, m.index - 120), m.index);
        if (/\b(\d+-month context|7-month|a year ago|back in|earlier this year|historic(al)?|previously|used to|before the breakout|pre-breakout)\b/i.test(before)) continue;
        // A range that no longer brackets the price (3% tolerance) means the
        // narrative is describing a regime price has since left.
        if (hi < last * 0.97 || lo > last * 1.03) {
          issues.push(`${row.ticker}: ${field} describes the range ${lo}-${hi}, but price is now ${last} - narrative describes a regime price has left`);
        }
      }
    }
  }
  return issues;
}

// Catches the defect the user surfaced on CLHO (Sept 8 2026): an exit ladder
// whose first rung price can never reach. CLHO's target 1 was 18.73; the stock
// peaked at 18.45 and rolled over, so no partial sale ever fired and the
// position round-tripped -8.4% from its high with no protection.
//
// Scanning the rest found it was systemic - 5 of 12 held positions had the same
// defect. The cause was consistent: ANALYST 12-month price targets had been used
// as technical rungs (ORHD 58.55, COMI 180.53, RAYA 11.20). Those express a
// valuation view, not a price a swing position will trade through. They belong
// in fundamentalTarget, which is context and never a rung.
//
// Rule enforced here: target 1 must sit at or inside the 90-day high. If price
// has not reached it in the recent regime, it is decoration rather than a plan.
function checkUnreachableTargets(rows) {
  const issues = [];
  for (const row of rows) {
    const d = row.chart_data;
    if (!d || typeof d === "string" || !d.closes || !d.highs || d.kind === "rejected") continue;
    if (!Array.isArray(d.targets) || !d.targets.length) continue;
    const last = d.closes[d.closes.length - 1];
    const hi90 = Math.max(...d.highs.slice(-90));
    const t1 = d.targets[0];
    // A rung derived by Fibonacci extension legitimately sits above the 90-day
    // high - that is the whole point of an extension, and it is the documented
    // fallback for a stock at its highs with nothing overhead to observe. So the
    // 90-day test applies only to rungs claiming to be OBSERVED swing highs.
    // Every rung still has to be within reach: >20% away cannot fire on a normal
    // move regardless of how it was derived.
    const basis = Array.isArray(d.targetBasis) ? d.targetBasis.find((b) => b.price === t1) : null;
    const isFib = basis?.method === "fib";
    if (t1 <= last) {
      issues.push(`${row.ticker}: target 1 (${t1}) is at or BELOW the current close (${last}) - it is a support/achieved level, not an exit`);
    } else if (!isFib && t1 > hi90 * 1.02) {
      const gap = ((t1 - hi90) / hi90 * 100).toFixed(1);
      issues.push(`${row.ticker}: target 1 (${t1}) claims to be an observed level but is ${gap}% above the 90-day high (${hi90}) - unreachable. Use a real swing high, or a Fibonacci extension with method:"fib" recorded in targetBasis.`);
    } else if ((t1 - last) / last > 0.20) {
      issues.push(`${row.ticker}: target 1 (${t1}) is ${(((t1 - last) / last) * 100).toFixed(1)}% above spot - too far to fire on a normal move, whatever its basis`);
    }
    if (Array.isArray(d.targets) && d.targets.length && !Array.isArray(d.targetBasis)) {
      issues.push(`${row.ticker}: has targets but no targetBasis - every rung must record WHY that price (swing high or Fibonacci extension), never an invented number`);
    }
  }
  return issues;
}

// Sept 9 2026: this only ever looked at buys, so once CLHO was fully sold and
// correctly re-tagged "opportunity", the old buy rows kept flagging it forever.
// A ticker's state is the NET of its transactions, not the existence of a buy -
// and the check has to work in both directions, or re-tagging an exited
// position is permanently "wrong".
async function checkKindMismatches(supabase, userId, chartByTicker) {
  const { data: txns, error } = await supabase
    .from("transactions").select("ticker, type, shares").eq("user_id", userId);
  if (error) {
    console.error(error.message);
    process.exit(1);
  }
  const net = {}, complete = {}, hasBuy = {};
  for (const t of txns) {
    const n = Number(t.shares);
    const known = Number.isFinite(n) && n > 0;
    complete[t.ticker] = (complete[t.ticker] ?? true) && known;
    if (t.type !== "sell") hasBuy[t.ticker] = true;
    if (known) net[t.ticker] = (net[t.ticker] ?? 0) + (t.type === "sell" ? -n : n);
  }
  const issues = [];
  for (const ticker of Object.keys(hasBuy)) {
    const d = chartByTicker[ticker];
    if (!d) continue;
    // "Has a buy" is enough to prove it should not be tagged opportunity...
    if (d.kind === "opportunity" && complete[ticker] && (net[ticker] ?? 0) > 0) {
      issues.push(`${ticker}: net ${net[ticker]} shares held but chart_data.kind is still "opportunity" - should be flipped to held`);
    }
    // ...but "is fully exited" is a claim about a NET, and several historical
    // ledger rows have unknown share counts (imported before quantities were
    // recorded). Asserting an exit from an incomplete ledger produced a false
    // "MASR is fully exited" on a 1,596-unit position. Stay silent instead.
    if (d.kind !== "opportunity" && d.kind !== "rejected" && complete[ticker] && (net[ticker] ?? 0) <= 0) {
      issues.push(`${ticker}: net position is ${net[ticker] ?? 0} (fully exited) but the card still renders as held - set kind:"opportunity"`);
    }
  }
  return issues;
}

// ---------------------------------------------------------------------------
// Check 10: a present-tense field still narrating an EARLIER session.
//
// The failure this catches (Sept 9 2026, 11 of 12 held cards): dailyFlag opens
// "Sept 8: 42.21 (-1.72%)..." on a card stamped lastUpdated 2026-09-09. Every
// number in it is historically accurate - checkStaleNarrative cannot see it,
// because the described range often still brackets the price - but the field
// is answering "what happened today?" with yesterday.
//
// Only fields whose contract IS the current session are checked. `pattern` and
// `why` legitimately cite older dates as context, so they are excluded here and
// covered by checkStaleNarrative instead.
//
// `lastUpdated` means "the session this card's data reflects", NOT "when I last
// touched it" - those two came apart on Sept 9 2026, when five watchlist cards
// were reviewed and corrected on the 9th while their price CSVs still ended on
// the 8th. Stamping them 09-09 made every correctly-written "Sept 8:" opener
// look stale. The review date lives in `sectionChecks`; the data date lives
// here. Keep them distinct or this check inverts into noise.
const TODAY_FIELDS = ["dailyFlag", "volumeRead", "planStatus", "actionNeeded"];
const MONTHS = { jan:1, feb:2, mar:3, apr:4, may:5, jun:6, jul:7, aug:8, sep:9, sept:9, oct:10, nov:11, dec:12 };

function checkBackdatedSessionFields(rows) {
  const issues = [];
  for (const row of rows) {
    const d = row.chart_data;
    if (!d || typeof d === "string" || d.kind === "rejected" || !d.lastUpdated) continue;
    const stamped = new Date(`${d.lastUpdated}T00:00:00Z`);
    if (Number.isNaN(+stamped)) continue;
    const year = stamped.getUTCFullYear();
    for (const field of TODAY_FIELDS) {
      const raw = d[field];
      if (typeof raw !== "string" || !raw.trim()) continue;
      // Only the OPENING of the field is checked. These fields answer "what
      // happened this session", and that answer is always the first clause -
      // "Sept 9: 41.75 (-1.21%)...". Later in the same field, a backward
      // reference is normal and correct ("the Sept 8 spike to 132.85 failed",
      // "50 bought Sept 7 at 52.05"). Scanning the whole field flagged 23
      // items of which most were legitimate history; scanning the lead flags
      // only the case this check is actually for.
      const lead = raw.replace(/<[^>]+>/g, " ").trimStart().slice(0, 60);
      const m = /\b(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sept?|Oct|Nov|Dec)\.?\s+(\d{1,2})\b/i.exec(lead);
      if (!m) continue;
      // A fill date in the opening clause is provenance, not a stale session:
      // "Holding 140 units at 30.84 (50 bought Sept 3 at 30.00...)". Skip when
      // a transaction verb introduces it, or when it sits inside parentheses.
      const leadBefore = lead.slice(0, m.index);
      if (/\b(bought|sold|purchased|placed|filled|added|acquired|exited|since|from|on)\s*$/i.test(leadBefore)) continue;
      if (leadBefore.lastIndexOf("(") > leadBefore.lastIndexOf(")")) continue;
      const ref = new Date(Date.UTC(year, MONTHS[m[1].toLowerCase()] - 1, +m[2]));
      const daysBehind = (stamped - ref) / 86400000;
      // 1-30 days behind: stale. Beyond 30 it reads as deliberate history,
      // and negative means a future date or a typo.
      if (daysBehind < 1 || daysBehind > 30) continue;
      issues.push(`${row.ticker}: ${field} opens by narrating "${m[0]}" but the card is stamped ${d.lastUpdated} (${daysBehind}d behind)`);
    }
  }
  return issues;
}

// ---------------------------------------------------------------------------
// Check 11: two fields on one card naming DIFFERENT values for the same level.
//
// Found on ORHD (Sept 9 2026): stopNote said the stop was widened to 39.90,
// while actionNeeded in the same card still said "Stop 40.80 ... is the level
// to use". Both were bold, both were confident, and a reader has no way to tell
// which is operative. Every prior check compares prose to a structured field
// one at a time, so a card could disagree with itself indefinitely.
const LEVEL_KINDS = ["support", "resistance", "stop"];

function checkInternalLevelContradictions(rows) {
  const issues = [];
  for (const row of rows) {
    const d = row.chart_data;
    if (!d || typeof d === "string" || d.kind === "rejected") continue;
    for (const kind of LEVEL_KINDS) {
      const seen = new Map(); // value -> [fields]
      for (const [field, raw] of Object.entries(d)) {
        if (typeof raw !== "string") continue;
        // corporateActions exists precisely to say "these levels are about to
        // become void" and quotes the superseded numbers on purpose. Reading
        // it as a contradiction inverts its meaning.
        if (field === "corporateActions") continue;
        const text = raw.replace(/<[^>]+>/g, " ");
        const re = new RegExp(`\\b${kind}\\s+(\\d+(?:\\.\\d{1,2})?)\\b`, "gi");
        let m;
        while ((m = re.exec(text))) {
          // "stop ... 11.4% below" is a distance, not a level.
          if (/^\s*%/.test(text.slice(m.index + m[0].length))) continue;
          // "the old stop 40.80", "previously 41.50" - explicitly superseded.
          const before = text.slice(Math.max(0, m.index - 24), m.index);
          if (/\b(old|former|previous(ly)?|superseded|was|prior)\b[^.]{0,20}$/i.test(before)) continue;
          const v = parseFloat(m[1]);
          if (!seen.has(v)) seen.set(v, []);
          if (!seen.get(v).includes(field)) seen.get(v).push(field);
        }
      }
      if (seen.size > 1) {
        const parts = [...seen.entries()].map(([v, f]) => `${v} (${f.join(", ")})`);
        issues.push(`${row.ticker}: card names ${seen.size} different ${kind} values - ${parts.join(" vs ")}`);
      }
    }
  }
  return issues;
}

// ---------------------------------------------------------------------------
// Check 12: an entry ladder every rung of which is already below the price.
//
// ETEL, Sept 9 2026: rungs at 114 / 116 / 118.50 while the stock closed at
// 125.99. Presented as "where to buy", it was a plan that could only fire after
// a 9% fall - i.e. not a plan at all, just an un-refreshed one. This is the
// entry-side twin of checkUnreachableTargets.
function checkStaleEntryLadder(rows) {
  const issues = [];
  for (const row of rows) {
    const d = row.chart_data;
    if (!d || typeof d === "string" || d.kind === "rejected") continue;
    if (!Array.isArray(d.entryLadder) || !d.entryLadder.length) continue;
    if (!Array.isArray(d.closes) || !d.closes.length) continue;
    const last = d.closes[d.closes.length - 1];
    const highest = Math.max(...d.entryLadder.map((r) => r.price ?? 0));
    const gapPct = ((last - highest) / last) * 100;
    // 8%, not 5%. A pullback ladder legitimately sits below spot - "buy the
    // retest at 119.50" is a plan, not staleness. Past ~8% the highest rung is
    // beyond any normal retracement and the ladder was built for a price the
    // stock has left.
    if (gapPct > 8) {
      issues.push(`${row.ticker}: every entryLadder rung is below spot - highest is ${highest} vs close ${last} (${gapPct.toFixed(1)}% below)`);
    }
  }
  return issues;
}

// ---------------------------------------------------------------------------
// Check 13: a volumes array that is mostly zeros.
//
// ETEL carried 246 volume bars of which 2 were non-zero, so the card's volume
// panel was blank for the whole year while every other field claimed to be
// current. The user's standing instruction is to read the volume panel on every
// chart - a silently empty array defeats that instruction rather than failing
// visibly.
function checkEmptyVolumeSeries(rows) {
  const issues = [];
  for (const row of rows) {
    const d = row.chart_data;
    if (!d || typeof d === "string" || d.kind === "rejected") continue;
    if (!Array.isArray(d.volumes) || d.volumes.length < 20) continue;
    const nonZero = d.volumes.filter((v) => v > 0).length;
    if (nonZero < d.volumes.length * 0.5) {
      issues.push(`${row.ticker}: volumes array is ${d.volumes.length} long but only ${nonZero} bars are non-zero`);
    }
  }
  return issues;
}

// ---------------------------------------------------------------------------
// Check 14: an exit target at or below what the position actually cost.
//
// Caught by Mostafa on 2026-09-10: I recommended a sell limit on COMI at its
// target 1 of 141.00 against an average cost of 141.39. Selling there realises
// a LOSS of 11 EGP after fees. PHAR's target 1 (135.31 vs 138.96 cost) has the
// same defect.
//
// The cause is structural rather than careless: buildLadder derives rungs from
// swing highs and Fibonacci extensions - pure price structure - and has no idea
// what the position cost. That is correct for identifying where price may go,
// and wrong for calling it an "exit". A rung below cost is a level, not a
// target. Thndr fees (3.00 flat + 0.175%) are included, because on a small
// tranche they are the difference between a thin gain and a loss.
const THNDR_FEE = (value) => 3.0 + 0.00175 * value;

function checkTargetsBelowCost(rows, positions) {
  const issues = [];
  if (!positions) return issues;
  const byTicker = Object.fromEntries(positions.stocks.map((p) => [p.ticker, p]));
  for (const row of rows) {
    const d = row.chart_data;
    if (!d || typeof d === "string" || !Array.isArray(d.targets) || !d.targets.length) continue;
    const pos = byTicker[row.ticker];
    if (!pos || !pos.units || !pos.avgCost) continue;
    const t1 = d.targets[0];
    const units = Math.round(pos.units * 0.25);
    const gross = units * t1;
    const net = gross - THNDR_FEE(gross) - units * pos.avgCost;
    if (t1 <= pos.avgCost) {
      issues.push(`${row.ticker}: target 1 (${t1}) is at or BELOW the average cost of ${pos.avgCost} - selling a 25% tranche there realises ${net.toFixed(0)} EGP. It is a price level, not an exit.`);
    } else if (net <= 0) {
      issues.push(`${row.ticker}: target 1 (${t1}) is above the ${pos.avgCost} cost but Thndr fees erase it - a 25% tranche nets ${net.toFixed(0)} EGP.`);
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
  const chartByTicker = {};
  for (const row of rows) chartByTicker[row.ticker] = row.chart_data;

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

  const kindIssues = await checkKindMismatches(supabase, user.id, chartByTicker);
  if (kindIssues.length) {
    totalIssues += kindIssues.length;
    console.log(`\n=== kind mismatches ===`);
    kindIssues.forEach((i) => console.log(" -", i));
  }

  const scoreIssues = checkScoreFieldMismatches(rows);
  if (scoreIssues.length) {
    totalIssues += scoreIssues.length;
    console.log(`\n=== stale score fields ===`);
    scoreIssues.forEach((i) => console.log(" -", i));
  }

  const sectionIssues = checkSectionChecks(rows);
  if (sectionIssues.length) {
    totalIssues += sectionIssues.length;
    console.log(`\n=== missing/stale sectionChecks ===`);
    sectionIssues.forEach((i) => console.log(" -", i));
  }

  const structuralIssues = checkStructuralStaleness(rows);
  if (structuralIssues.length) {
    totalIssues += structuralIssues.length;
    console.log(`\n=== structural staleness (price broke support/resistance, level never updated) ===`);
    structuralIssues.forEach((i) => console.log(" -", i));
  }

  const priceIssues = checkStalePriceCitations(rows);
  if (priceIssues.length) {
    totalIssues += priceIssues.length;
    console.log(`\n=== stale price citations (prose quotes an old price) ===`);
    priceIssues.forEach((i) => console.log(" -", i));
  }

  const emptyIssues = checkEmptyNarrative(rows);
  if (emptyIssues.length) {
    totalIssues += emptyIssues.length;
    console.log(`\n=== empty narrative fields (card stamped checked, prose blank) ===`);
    emptyIssues.forEach((i) => console.log(" -", i));
  }

  const targetIssues = checkUnreachableTargets(rows);
  if (targetIssues.length) {
    totalIssues += targetIssues.length;
    console.log(`\n=== unreachable exit targets (ladder cannot fire) ===`);
    targetIssues.forEach((i) => console.log(" -", i));
  }

  const narrativeIssues = checkStaleNarrative(rows);
  if (narrativeIssues.length) {
    totalIssues += narrativeIssues.length;
    console.log(`\n=== stale narrative (pattern/outlook describes a regime price has left) ===`);
    narrativeIssues.forEach((i) => console.log(" -", i));
  }

  let positions = null;
  try { positions = JSON.parse(readFileSync(new URL("../../journal/positions.json", import.meta.url), "utf8")); }
  catch { /* positions file is optional - the other 13 checks do not need it */ }
  const belowCostIssues = checkTargetsBelowCost(rows, positions);
  if (belowCostIssues.length) {
    totalIssues += belowCostIssues.length;
    console.log(`\n=== exit targets at or below cost (a level, not an exit) ===`);
    belowCostIssues.forEach((i) => console.log(" -", i));
  }

  const backdatedIssues = checkBackdatedSessionFields(rows);
  if (backdatedIssues.length) {
    totalIssues += backdatedIssues.length;
    console.log(`\n=== backdated session fields (dailyFlag/volumeRead describing an earlier session) ===`);
    backdatedIssues.forEach((i) => console.log(" -", i));
  }

  const contradictionIssues = checkInternalLevelContradictions(rows);
  if (contradictionIssues.length) {
    totalIssues += contradictionIssues.length;
    console.log(`\n=== internal level contradictions (one card, two values for the same level) ===`);
    contradictionIssues.forEach((i) => console.log(" -", i));
  }

  const entryLadderIssues = checkStaleEntryLadder(rows);
  if (entryLadderIssues.length) {
    totalIssues += entryLadderIssues.length;
    console.log(`\n=== stale entry ladders (every rung already below spot) ===`);
    entryLadderIssues.forEach((i) => console.log(" -", i));
  }

  const volumeSeriesIssues = checkEmptyVolumeSeries(rows);
  if (volumeSeriesIssues.length) {
    totalIssues += volumeSeriesIssues.length;
    console.log(`\n=== empty volume series (chart volume panel is blank) ===`);
    volumeSeriesIssues.forEach((i) => console.log(" -", i));
  }

  if (totalIssues === 0) {
    console.log("Clean - no stale prose/field mismatches found.");
  } else {
    console.log(`\n${totalIssues} potential issue(s) found - review before considering the refresh done.`);
    process.exit(1);
  }
}

main();
