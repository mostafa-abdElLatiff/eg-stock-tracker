// CORPORATE ACTIONS — the one check for "is this ticker about to divide?"
//
// ONE JOB: answer whether a resting order on this name would be hit by
// arithmetic rather than by the market.
//
// WHY. L-21: a bonus issue divides the price. A resting STOP fires on the
// mechanical move; a resting BUY LIMIT fills on it. EFID's 1-for-2 was found
// only because Mostafa asked about a dividend, and positions.json had carried
// the identical ORHD caveat since 09-09 without it ever becoming a check. On
// 2026-09-19 I twice called a deliberately-absent stop a "gap" because nothing
// in code knew why it was absent.
//
// THE SPLIT, AND WHY IT IS THE RIGHT ONE. Mubasher's announcements tab 403s
// automated fetches, so DETECTION stays manual - a browser, once a week, into
// journal/corporate-actions.json. But ENFORCEMENT does not need automation to
// be automatic: everything that proposes a stop or a buy limit calls this, so
// a known action can no longer be forgotten at the moment it matters. Half the
// job automated is not half the value - it is nearly all of it, because the
// failure mode was never "we did not know", it was "we knew and did not check".

import { readFileSync } from "fs";

const ROOT = new URL("../../../", import.meta.url).pathname;
let CACHE = null;
function load() {
  if (CACHE) return CACHE;
  try { CACHE = JSON.parse(readFileSync(`${ROOT}journal/corporate-actions.json`, "utf8")); }
  catch { CACHE = { actions: {}, _checkedThrough: null }; }
  return CACHE;
}

/**
 * @returns {{open:boolean, action?:object, blocksStop?:boolean, blocksBuy?:boolean, why?:string}}
 */
export function hasOpenCorporateAction(ticker) {
  const a = load().actions?.[ticker?.toUpperCase()];
  if (!a) return { open: false };
  return {
    open: true, action: a,
    blocksStop: a.blocksStop !== false,
    blocksBuy: a.blocksBuy === true,
    why: `${a.type} (${a.status}${a.ratio ? ", " + a.ratio : ""}) filed ${a.filed}. ${a.detail}` +
         (a.reviewDate ? ` Review ${a.reviewDate}.` : "") +
         (a.cancelBuyBefore ? ` Cancel any resting buy before ${a.cancelBuyBefore}.` : ""),
  };
}

/**
 * Gate a proposed stop. Returns the stop, or null with the reason.
 * Callers must NOT place a stop when this returns null.
 */
export function stopAllowed(ticker, stop) {
  const c = hasOpenCorporateAction(ticker);
  if (!c.open || !c.blocksStop) return { stop, blocked: false };
  return { stop: null, blocked: true,
    why: `No stop while a corporate action is pending — it would fire on the price division, not on a thesis break. ${c.why}` };
}

/** How stale is the manual sweep? Surfaced so it cannot rot unnoticed. */
export function lastChecked() {
  const d = load()._checkedThrough;
  if (!d) return { date: null, staleDays: null };
  return { date: d, staleDays: Math.floor((Date.now() - new Date(d)) / 86400000) };
}
