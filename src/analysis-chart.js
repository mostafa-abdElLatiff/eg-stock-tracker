// Renders the technical-analysis chart (HLC bars + volume + support/resistance/
// stop/target lines) and the exit-ladder plan for a single ticker's analysis_notes
// row. The chart itself is a real financial-charting library (lightweight-charts,
// the same engine TradingView's own embeds use) instead of a hand-rolled SVG -
// the old approach had labels overlapping and was genuinely hard to read. A
// library handles price-axis layout, non-overlapping labels, and zoom/crosshair
// correctly instead of me re-deriving that logic by hand.

import { createChart, ColorType, AreaSeries, LineSeries } from "lightweight-charts";

export function computeSMA(arr, n) {
  if (arr.length < n) return null;
  const slice = arr.slice(-n);
  return slice.reduce((a, b) => a + b, 0) / n;
}

// chart_data stores closes/highs/lows as plain arrays with no per-point date -
// only the END date (lastUpdated) is real. Reconstruct the real EGX trading-day
// sequence (Sun-Thu, no Fri/Sat) working backward from that known real date, so
// the x-axis shows genuine calendar dates rather than an arbitrary index. This
// is a labeling reconstruction, not fabricated price data - the actual OHLC
// values are untouched, only which calendar date each one is plotted under.
function reconstructDates(n, endDateStr) {
  const dates = [];
  let d = endDateStr ? new Date(endDateStr + "T00:00:00Z") : new Date();
  while (dates.length < n) {
    const day = d.getUTCDay(); // 0=Sun ... 6=Sat, EGX trades Sun-Thu
    if (day !== 5 && day !== 6) dates.unshift(d.toISOString().slice(0, 10));
    d = new Date(d.getTime() - 86400000);
  }
  return dates;
}

// Mounts a real interactive chart into `container` (a plain <div>) for one
// ticker's chart_data. Returns the chart instance so the caller can call
// .remove() on it before the next re-render (otherwise old chart instances
// leak - lightweight-charts doesn't garbage-collect itself when its DOM node
// is discarded from innerHTML).
export function mountChart(container, data) {
  const closes = data.closes;
  const n = closes.length;
  const dates = reconstructDates(n, data.lastUpdated);

  const styles = getComputedStyle(document.documentElement);
  const tok = (name) => styles.getPropertyValue(name).trim();
  const good = tok("--good") || "#0ca30c", bad = tok("--bad") || "#d95926";
  const muted = tok("--text-muted") || "#898781";
  const grid = tok("--gridline") || "#2c2c2a", support = tok("--support") || "#5b9bd5";
  const resistance = tok("--resistance") || "#e0a458", sma = tok("--sma") || "#6b6a63";

  const chart = createChart(container, {
    autoSize: true,
    layout: { background: { type: ColorType.Solid, color: "transparent" }, textColor: muted, fontSize: 11 },
    grid: { vertLines: { color: grid }, horzLines: { color: grid } },
    rightPriceScale: { borderColor: grid },
    timeScale: { borderColor: grid, timeVisible: false },
    crosshair: { mode: 0 },
  });

  // A plain area/line series (just the close, one continuous line) reads far
  // more clearly than an OHLC bar chart at a glance - this project has no
  // reliable Open data anyway, so a bar chart's main advantage (seeing each
  // day's open-to-close direction) never applied here. Color the line by the
  // net move over the visible window so "is this stock up or down this
  // month" is visible instantly.
  const trendColor = closes[closes.length - 1] >= closes[0] ? good : bad;

  // The price scale only auto-fits the series' own data by default, so a
  // resistance/target level sitting above the recent high (the normal case -
  // targets are usually above the current price) gets drawn outside the
  // visible pane with no label at all, not just a crowded one. Extend the
  // autoscale range to include every support/resistance/stop/target level.
  const levels = [data.support, data.resistance, data.stop, ...(data.targets || [])].filter((v) => v != null);
  const priceSeries = chart.addSeries(AreaSeries, {
    lineColor: trendColor, lineWidth: 2,
    topColor: trendColor + "33", bottomColor: trendColor + "00",
    priceFormat: { type: "price", precision: 2, minMove: 0.01 },
    autoscaleInfoProvider: (original) => {
      const res = original();
      if (!res || !levels.length) return res;
      const lo = Math.min(res.priceRange.minValue, ...levels);
      const hi = Math.max(res.priceRange.maxValue, ...levels);
      return { ...res, priceRange: { minValue: lo, maxValue: hi } };
    },
  });
  priceSeries.setData(closes.map((c, i) => ({ time: dates[i], value: c })));

  const sma10 = closes.map((_, i) => (i < 9 ? null : computeSMA(closes.slice(0, i + 1), 10)));
  const smaPoints = sma10.map((v, i) => (v == null ? null : { time: dates[i], value: v })).filter(Boolean);
  if (smaPoints.length) {
    const smaSeries = chart.addSeries(LineSeries, { color: sma, lineWidth: 1, lineStyle: 2, title: "10-day avg", priceLineVisible: false, lastValueVisible: false });
    smaSeries.setData(smaPoints);
  }

  // Price-line labels don't auto-avoid each other - when two real levels sit
  // within ~0.4% of one another (e.g. a target that IS the resistance level,
  // a common, intentional pattern - "clearing resistance = target 1"), merge
  // them into one labeled line instead of drawing two that visually collide.
  const placed = []; // {price, line}
  const priceLine = (price, color, title, dashed) => {
    const near = placed.find((p) => Math.abs(p.price - price) / price < 0.004);
    if (near) {
      near.line.applyOptions({ title: `${near.title} / ${title}` });
      near.title = `${near.title} / ${title}`;
      return;
    }
    const line = priceSeries.createPriceLine({ price, color, lineWidth: dashed ? 1 : 2, lineStyle: dashed ? 2 : 0, axisLabelVisible: true, title });
    placed.push({ price, line, title });
  };
  if (data.support != null) priceLine(data.support, support, "Support", true);
  if (data.resistance != null) priceLine(data.resistance, resistance, "Resistance", true);
  if (data.stop != null) priceLine(data.stop, bad, data.trailing ? "Trailing stop" : "Stop-loss", false);
  (data.targets || []).forEach((t, idx) => priceLine(t, good, `T${idx + 1}`, true));

  chart.timeScale().fitContent();
  return chart;
}

// Splits each target into a partial-sell % and where the stop moves to once
// it's hit, same ladder-sizing convention as the Artifact (1 target -> sell
// 70% and trail the rest; 2 -> 35/50; 3 -> 25/30/30; 4 -> 20/20/25/20).
export function targetPlan(data, avgCost) {
  const targets = data.targets || [];
  const n = targets.length;
  const pctByN = { 1: [70], 2: [35, 50], 3: [25, 30, 30], 4: [20, 20, 25, 20] };
  const pcts = pctByN[n] || targets.map(() => Math.round(100 / n));
  return targets.map((price, i) => ({
    price,
    sellPct: pcts[i],
    newStop: i === 0 ? (avgCost != null ? avgCost : data.support) : targets[i - 1],
  }));
}


// A one-time reference block, not per-card - the fundamental/technical
// indicators used across every ticker's card mean the same thing everywhere,
// so this is written once and rendered collapsed above the analysis cards
// rather than repeated 20+ times.
export function buildFundamentalsGlossary() {
  const terms = [
    ["P/E (Price-to-Earnings)", "Share price divided by annual earnings per share. Roughly: how many years of current profit it'd take to earn back the price you paid. Lower usually means cheaper, but only means anything next to the sector average - a low P/E bank and a low P/E tech stock aren't directly comparable."],
    ["PEG (P/E ÷ growth rate)", "Takes the P/E and divides it by the company's earnings growth rate, so a stock that looks expensive on P/E alone can still look cheap if it's growing fast enough. Rule of thumb: under 1 is cheap for its growth, over 2 is expensive for its growth. Needs a real growth-rate figure to compute - flagged as unavailable when one can't be sourced, rather than guessed."],
    ["ROE (Return on Equity)", "Net income divided by shareholder equity - how much profit the company generates from the money shareholders have put in. Higher is generally better, but very high ROE can also mean high debt doing the work (see Debt/Equity below), not just efficient operations."],
    ["Debt/Equity", "Total debt divided by shareholder equity. Higher means more of the company is funded by borrowing rather than owners' capital - more fragile in a downturn, but not automatically bad (banks structurally run high D/E; it's the trend and the sector norm that matter more than the raw number)."],
    ["Current Ratio / Quick Ratio", "Both measure whether a company can cover its near-term bills. Current Ratio = current assets ÷ current liabilities. Quick Ratio does the same but excludes inventory, since inventory isn't always quick to turn into cash - a stricter test. Think of both as \"financial flexibility to make decisions,\" not just \"can it avoid bankruptcy.\""],
    ["Free Cash Flow (FCF)", "Cash left over from operations after paying for the capital spending (CapEx) needed to run the business. This is real cash, harder to dress up than reported accounting profit. Negative FCF for several years running - even with a healthy reported profit - is a real warning sign: it means growth or dividends are being funded by debt or share issuance, not the business itself."],
    ["Quality of earnings", "Is profit growth coming from the actual core business, or from one-off items - selling an asset, a non-cash revaluation gain, or interest income sitting on a big cash pile? A company can show rising headline profit purely from interest income while the underlying business goes nowhere. This project always tries to separate the two before trusting a profitability number."],
    ["CapEx trend (5-year)", "Is capital spending increasing, flat, or declining, and is there a real, named forward project pipeline behind it? Between two similarly-priced stocks, the one actually investing in future capacity is the stronger long-term hold, all else equal."],
    ["Dividend yield / history", "Annual dividend per share as a % of the current price, plus whether that payment has been growing, flat, or cut over recent years. A rising, sustained dividend is a real signal of financial health; a high yield propped up by a shrinking or erratic payout is not the same thing."],
    ["Shareholder equity / book value trend", "Is the company's retained, owned capital actually growing period over period? Growing equity means real value is being built and kept in the business, not just paid out or eroded by losses."],
    ["Ownership / insider concentration", "How much of the company a small number of large shareholders control. Cuts both ways: high concentration can mean real skin in the game from people who know the business best, or it can mean a thin free float with weak liquidity - context (who the holder is) matters more than the raw %."],
    ["RSI-14 (Relative Strength Index)", "A 0-100 momentum gauge computed from the last 14 sessions' up-days vs. down-days. Above ~70 usually means recently overbought (extended, due for a pause or pullback); below ~30 usually means recently oversold. This project's entry screen generally wants RSI in the 40-65 zone - not chasing a name that's already run hot."],
    ["Verdict score (Opportunities only)", "A 0-100 score, this project's own composite of \"how attractive is this as an entry RIGHT NOW\" - not \"how good is the company.\" Rough bands: 90+ act-now/clean entry, 60-89 passes the screens but no catalyst yet (or a real caveat), 30-59 wait for confirmation, under 30 avoid. Opportunities are sorted by this score, best first."],
  ];
  const rows = terms
    .map(([term, def]) => `<div style="margin-bottom:10px"><strong>${term}</strong><p class="body-text" style="margin:2px 0 0">${def}</p></div>`)
    .join("");
  return `
    <details style="margin:10px 0 18px">
      <summary style="cursor:pointer; font-size:0.85rem; color:var(--text-secondary)">What do these numbers mean? (fundamentals + technical glossary)</summary>
      <div style="margin-top:10px">${rows}</div>
    </details>
  `;
}

// avgCost prefers the Positions data (real transactions) so it can't drift
// out of sync - avgCostIsLive is false when it fell back to chart_data's
// avgCostOverride instead (e.g. an older transaction is missing its share
// count), in which case the UI says so rather than presenting it as live.
export function buildAnalysisCard(ticker, data, avgCost, avgCostIsLive = true) {
  const last = data.closes[data.closes.length - 1];
  const sma5 = computeSMA(data.closes, 5);
  const sma10 = computeSMA(data.closes, 10);
  const trendVsAvg =
    sma5 != null && sma10 != null
      ? last > sma5 && last > sma10
        ? "above both averages"
        : last < sma5 && last < sma10
        ? "below both averages"
        : "mixed vs. averages"
      : "not enough data for a 10-day average yet";

  const plan = targetPlan(data, avgCost);
  const sumPct = plan.reduce((s, p) => s + (p.sellPct || 0), 0);
  const trailPct = 100 - sumPct;

  let exitRows = "";
  if (avgCost != null) exitRows += row(avgCostIsLive ? "Your avg cost (held)" : "Your avg cost (from notes, not live)", avgCost.toFixed(2), "—", "—");
  if (data.support != null) exitRows += row("Support", data.support.toFixed(2), pct(data.support, last), pct(data.support, avgCost));
  if (data.resistance != null) exitRows += row("Resistance", data.resistance.toFixed(2), pct(data.resistance, last), pct(data.resistance, avgCost));
  if (data.stop != null) {
    exitRows += row(data.trailing ? "Trailing stop (now)" : "Stop-loss (now)", data.stop.toFixed(2), pct(data.stop, last), pct(data.stop, avgCost));
    if (data.stopNote) {
      exitRows += `<tr><td colspan="5" style="font-size:0.76rem; color:var(--accent); padding-top:0; padding-bottom:8px">↳ ${data.stopNote}</td></tr>`;
    }
  }
  plan.forEach((p, i) => {
    exitRows += `<tr><td class="label">Target ${i + 1} — sell ${p.sellPct}%</td><td class="num">${p.price.toFixed(2)}</td><td class="label num">${pct(p.price, last)}</td><td class="label num">${pct(p.price, avgCost)}</td><td class="label">stop → ${p.newStop.toFixed(2)}</td></tr>`;
  });
  if (plan.length) {
    exitRows += `<tr><td class="label">Remainder — trail stop</td><td class="num">${trailPct}%</td><td class="label" colspan="3">under each new swing low</td></tr>`;
  }
  if (data.fundamentalTarget) {
    exitRows += row("Fundamental target (context)", data.fundamentalTarget.toFixed(2), pct(data.fundamentalTarget, last), pct(data.fundamentalTarget, avgCost));
  }

  let entryBlock = "";
  if (data.entryLadder) {
    const entryRows = data.entryLadder
      .map((e) => `<tr><td class="label">${e.label}</td><td class="num">${e.price.toFixed(2)}</td><td class="label">${e.pct}% of next add</td></tr>`)
      .join("");
    entryBlock = `<p class="section-label">Entry ladder — if adding more</p><table class="plan-table"><tbody>${entryRows}</tbody></table>`;
  } else if (data.entryNote) {
    entryBlock = `<p class="section-label">Entry ladder — if adding more</p><p class="entry-note">${data.entryNote}</p>`;
  }

  const rsiColor = data.rsi >= 70 || data.rsi <= 30 ? "var(--bad)" : "inherit";
  const rsiRead = data.rsi >= 70 ? "overbought" : data.rsi <= 30 ? "oversold" : "neutral";

  return `
  <div class="analysis-card">
    <div class="analysis-head">
      <span class="tick">${ticker}</span>
      ${data.verdictScore != null ? `<span class="pill">score ${data.verdictScore}/100</span>` : ""}
      <span class="price">${last.toFixed(2)}</span>
    </div>
    <div class="muted" style="margin-bottom:8px">price is ${trendVsAvg}${data.lastUpdated ? ` · data through ${data.lastUpdated}` : ""}</div>
    ${
      data.actionNeeded
        ? `<div style="border:1px solid var(--bad); border-radius:8px; padding:8px 10px; margin-bottom:10px; background:color-mix(in srgb, var(--bad) 10%, transparent)">
      <strong style="color:var(--bad)">Action needed:</strong> ${data.actionNeeded}
    </div>`
        : data.planStatus
        ? `<div style="border:1px solid var(--border); border-radius:8px; padding:8px 10px; margin-bottom:10px">
      <strong>Plan status:</strong> ${data.planStatus}
    </div>`
        : ""
    }
    ${
      data.orderSuggestion
        ? `<div style="border:1px solid var(--good); border-radius:8px; padding:8px 10px; margin-bottom:10px; background:color-mix(in srgb, var(--good) 10%, transparent)">
      <strong style="color:var(--good)">Open order suggestion:</strong> ${data.orderSuggestion.side === "sell" ? "Sell" : "Buy"} limit
      ${data.orderSuggestion.limitPrice.toFixed(2)}, ${data.orderSuggestion.amount ? `${data.orderSuggestion.amount.toLocaleString()} EGP` : ""}
      ${data.orderSuggestion.note ? `<div class="muted" style="margin-top:2px">${data.orderSuggestion.note}</div>` : ""}
      ${data.orderSuggestion.asOf ? `<div class="muted" style="margin-top:2px; font-size:0.7rem">Suggested ${data.orderSuggestion.asOf} — not placed automatically, enter it yourself in Thndr.</div>` : ""}
    </div>`
        : ""
    }
    ${data.dailyFlag ? `<p class="body-text" style="border-left:2px solid var(--accent);padding-left:8px;margin-bottom:10px"><strong>Latest session:</strong> ${data.dailyFlag}</p>` : ""}
    <div class="chart" id="chart-${ticker}" data-chart-ticker="${ticker}"></div>
    <p class="muted" style="margin:2px 0 8px">Drag to pan, scroll/pinch to zoom. Support/resistance/stop/target levels are labeled directly on the price axis.</p>

    <p class="section-label">Pattern observed</p>
    <p class="body-text"><strong>${data.patternLabel || ""}</strong>${data.patternLabel ? " — " : ""}${data.pattern || ""}</p>
    <table class="plan-table">
      <tbody>
        <tr><td class="label">RSI-14</td><td style="color:${rsiColor}">${data.rsi ?? "—"}</td><td class="label" colspan="2">${data.rsi != null ? rsiRead : ""}</td></tr>
        <tr><td class="label">Trend</td><td colspan="3">${data.trendLabel || ""}</td></tr>
      </tbody>
    </table>
    <p class="body-text"><strong>Buy at support or after breakout?</strong> ${data.buyApproach || ""}</p>

    ${data.why ? `<p class="section-label">Why these exact numbers (technical)</p><p class="body-text">${data.why}</p>` : ""}

    ${data.ictNotes ? `<p class="section-label">ICT-style read (supplementary - see caveats)</p><p class="body-text">${data.ictNotes}</p>` : ""}

    ${
      data.finPosition || data.cashFlow || data.profitability || data.valuation || data.newsRecent || data.qualityOfEarnings || data.capexTrend || data.dividendInfo || data.ownershipInfo
        ? `<p class="section-label">Fundamentals</p>
    <table class="plan-table">
      <tbody>
        ${data.finPosition ? `<tr><td class="label" style="vertical-align:top">Financial position</td><td colspan="3" style="text-align:left">${data.finPosition}</td></tr>` : ""}
        ${data.cashFlow ? `<tr><td class="label" style="vertical-align:top">Cash flow</td><td colspan="3" style="text-align:left">${data.cashFlow}</td></tr>` : ""}
        ${data.qualityOfEarnings ? `<tr><td class="label" style="vertical-align:top">Quality of earnings</td><td colspan="3" style="text-align:left">${data.qualityOfEarnings}</td></tr>` : ""}
        ${data.profitability ? `<tr><td class="label" style="vertical-align:top">Profitability trend</td><td colspan="3" style="text-align:left">${data.profitability}</td></tr>` : ""}
        ${data.capexTrend ? `<tr><td class="label" style="vertical-align:top">CapEx trend</td><td colspan="3" style="text-align:left">${data.capexTrend}</td></tr>` : ""}
        ${data.valuation ? `<tr><td class="label" style="vertical-align:top">Valuation</td><td colspan="3" style="text-align:left">${data.valuation}</td></tr>` : ""}
        ${data.dividendInfo ? `<tr><td class="label" style="vertical-align:top">Dividend</td><td colspan="3" style="text-align:left">${data.dividendInfo}</td></tr>` : ""}
        ${data.ownershipInfo ? `<tr><td class="label" style="vertical-align:top">Ownership</td><td colspan="3" style="text-align:left">${data.ownershipInfo}</td></tr>` : ""}
        ${data.newsRecent ? `<tr><td class="label" style="vertical-align:top">Recent news/results</td><td colspan="3" style="text-align:left">${data.newsRecent}</td></tr>` : ""}
      </tbody>
    </table>`
        : ""
    }

    <p class="section-label">Exit ladder — what you hold</p>
    <table class="plan-table">
      <thead><tr><th>Level</th><th class="num">Price</th><th class="num">vs today</th><th class="num">vs your cost</th><th>Then move stop</th></tr></thead>
      <tbody>${exitRows}</tbody>
    </table>
    ${entryBlock}

    ${
      data.short || data.medium || data.long
        ? `<p class="section-label">Outlook</p>
    <table class="plan-table">
      <tbody>
        <tr><td class="label">Short (1-2 weeks)</td><td colspan="3" style="text-align:left">${data.short || ""}</td></tr>
        <tr><td class="label">Medium (1-2 months)</td><td colspan="3" style="text-align:left">${data.medium || ""}</td></tr>
        <tr><td class="label">Long (fundamental)</td><td colspan="3" style="text-align:left">${data.long || ""}</td></tr>
      </tbody>
    </table>`
        : ""
    }
  </div>`;
}

// base == null covers indices and positions without a complete share count
// (see hasCompleteShareData) - there's no "your cost" to compare against.
function pct(target, base) {
  if (base == null) return "—";
  const p = (100 * (target - base)) / base;
  return `${p >= 0 ? "+" : ""}${p.toFixed(1)}%`;
}
function row(label, price, pctToday, pctCost) {
  return `<tr><td class="label">${label}</td><td class="num">${price}</td><td class="label num">${pctToday || ""}</td><td class="label num">${pctCost || ""}</td><td></td></tr>`;
}
