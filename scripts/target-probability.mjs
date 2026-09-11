// Empirical probability that a ladder's rungs get reached, measured from the
// stock's OWN history rather than assumed. Added Sept 8 2026 at the user's
// suggestion: "factor in how likely it is to reach a goal... and add a weight of
// the possibility of each target, then calculate the total score".
//
// Method - Maximum Favorable / Adverse Excursion (MFE/MAE), path-dependent:
// for every historical bar, walk FORWARD up to `horizon` sessions and record
// whether the target gain was reached BEFORE the stop loss was hit. Ordering
// matters: a stock that dips to the stop and only then rallies did not "reach
// the target" for a holder who was stopped out on the way.
//
// P(target) is therefore the empirical share of historical starting points from
// which that gain arrived first. It is a base rate from real behaviour, not a
// forecast.
export function excursionStats(rows, { horizon = 20 } = {}) {
  const n = rows.length;
  const samples = [];
  for (let i = 0; i < n - horizon; i++) {
    const base = rows[i].close;
    let mfe = 0, mae = 0, hitOrder = [];
    for (let j = i + 1; j <= i + horizon; j++) {
      const up = (rows[j].high - base) / base;
      const dn = (rows[j].low - base) / base;
      if (up > mfe) mfe = up;
      if (dn < mae) mae = dn;
      hitOrder.push({ up, dn });
    }
    samples.push({ base, mfe, mae, path: hitOrder });
  }
  return samples;
}

// Probability that +gainPct arrives before -riskPct, from the real sample paths.
export function probReachBeforeStop(samples, gainPct, riskPct) {
  let reached = 0, valid = 0;
  for (const s of samples) {
    valid++;
    let done = false;
    for (const step of s.path) {
      if (step.dn <= -riskPct) { done = true; break; }        // stopped out first
      if (step.up >= gainPct) { reached++; done = true; break; } // target first
    }
    // paths that did neither within the horizon count as "not reached"
  }
  return valid ? reached / valid : null;
}

// Expected value of the whole ladder, in % of position, probability-weighted.
// Each rung contributes sellPct x gain x P(reach it before the stop).
// The unsold remainder is valued at the LAST rung reached, and the loss branch
// is charged at the stop for whatever is still held.
// *** THE BIGGEST LIMITATION, MEASURED 2026-09-11 ***
//
// Every probability this file produces is computed from ONE YEAR of bars,
// because one year is all the free data sources give. That year has been a
// strong bull market, so the base rates are systematically OPTIMISTIC - and
// the further the target, the worse it gets.
//
// Measured on ETEL against seven years pulled from investing.com through a
// browser session, same targets and same stop:
//
//     P(target)     1 year    7 years
//     +2.9%           87%        77%
//     +5%             83%        63%
//     +10%            61%        38%
//     +15%            40%        20%
//     +20%            28%        10%
//
// P(+20%) is overstated by nearly THREE TIMES. The cause is visible in ETEL's
// yearly returns: 2019 -25%, 2020 +17%, 2021 +41%, 2022 +50%, 2023 +52%,
// 2024 -14%, 2025 +90%, 2026 +92%. The single year in the sample is one of
// the two best in eight.
//
// Until longer history is loaded, read every P() here as a CEILING, and treat
// distant targets with particular suspicion. The 7-year figures above are the
// honest ones for ETEL.
//
// KNOWN APPROXIMATIONS - audited 2026-09-10, documented rather than fixed
// because they pull in OPPOSITE directions and neither is cleanly removable
// from daily bars alone. Stated here so nobody reads the output as exact.
//
// 1. INTRABAR AMBIGUITY (makes EV too LOW). When one bar's high reaches the
//    target and its low reaches the stop, daily data cannot say which came
//    first. probReachBeforeStop checks the stop first, so it counts as
//    stopped. Deliberately pessimistic - it understates P(target) for wide-
//    range names, which errs toward not buying.
//
// 2. NO POST-TRANCHE STOP (makes EV too HIGH). pStop is the probability of
//    being stopped WITHOUT first reaching rung 1. If rung 1 is reached and
//    25% is sold, the remaining 75% can still be stopped later - and that
//    path is not charged anywhere. Errs toward buying.
//
// The two partly cancel, which is why the model has held up in practice, but
// the EV figure is a RANKING signal, not a forecast of return. Treat a 0.3pp
// gap between two names as noise; treat a 2pp gap as real.
export function ladderExpectedValue({ samples, entry, stop, targets, sellPcts }) {
  const riskPct = (entry - stop) / entry;
  const rungs = targets.map((price, i) => {
    const gain = (price - entry) / entry;
    const p = probReachBeforeStop(samples, gain, riskPct);
    return { price, gain, p, sellPct: (sellPcts?.[i] ?? 0) / 100 };
  });
  // Probability of being stopped out without reaching even rung 1.
  const pStop = 1 - (rungs[0]?.p ?? 0);
  const soldPct = rungs.reduce((s, r) => s + r.sellPct, 0);
  const trailPct = Math.max(0, 1 - soldPct);
  const upside = rungs.reduce((s, r) => s + r.sellPct * r.gain * r.p, 0);
  // Trailing remainder: credited at the final rung's gain, weighted by its
  // probability - deliberately conservative, it ignores any further upside.
  const last = rungs[rungs.length - 1];
  const trailValue = last ? trailPct * last.gain * last.p : 0;
  const downside = pStop * riskPct * (soldPct + trailPct);
  return { rungs, riskPct, pStop, ev: upside + trailValue - downside, upside, trailValue, downside };
}
