// Renders the technical-analysis chart (HLC bars + volume + support/resistance/
// stop/target lines) and the exit-ladder plan for a single ticker's analysis_notes
// row. Ported from the trade-plan.html Artifact's buildChart()/targetPlan() -
// same math, same fixed Y-scale (targets never distort the price scale - see
// the comment below), just reading from chart_data instead of a hardcoded array.

export function computeSMA(arr, n) {
  if (arr.length < n) return null;
  const slice = arr.slice(-n);
  return slice.reduce((a, b) => a + b, 0) / n;
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

export function buildChartSVG(data) {
  const w = 460, priceH = 170, volH = data.volumes ? 46 : 0, gap = data.volumes ? 8 : 0;
  const padL = 4, padR = 58, padT = 14, padB = 4;
  const h = priceH + gap + volH;
  const closes = data.closes, highs = data.highs || closes, lows = data.lows || closes;

  // Price scale comes ONLY from real near-term price action (highs/lows/support/
  // resistance/stop) - NOT from far-off targets, which would otherwise crush the
  // actual candles into an unreadable sliver at the bottom of the chart.
  const scaleVals = highs.concat(lows);
  if (data.support != null) scaleVals.push(data.support);
  if (data.resistance != null) scaleVals.push(data.resistance);
  if (data.stop != null) scaleVals.push(data.stop);
  const min = Math.min(...scaleVals), max = Math.max(...scaleVals);
  const pad = (max - min) * 0.08 || max * 0.02;
  const scaleMin = min - pad, scaleMax = max + pad;
  const range = scaleMax - scaleMin || 1;
  const n = closes.length;
  const barW = (w - padL - padR) / n;
  const x = (i) => padL + i * barW + barW / 2;
  const y = (v) => padT + (1 - (v - scaleMin) / range) * (priceH - padT - padB);
  const clip = (v) => Math.max(padT, Math.min(priceH - padB, y(v)));

  const sma10Vals = closes.map((_, i) => (i < 9 ? null : computeSMA(closes.slice(0, i + 1), 10)));
  let smaPath = "";
  sma10Vals.forEach((v, i) => {
    if (v === null) return;
    smaPath += `${smaPath === "" ? "M" : "L"} ${x(i).toFixed(1)} ${y(v).toFixed(1)} `;
  });

  let svg = `<svg class="chart" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none">`;

  if (data.support != null) {
    svg += `<line x1="${padL}" y1="${y(data.support).toFixed(1)}" x2="${w - padR}" y2="${y(data.support).toFixed(1)}" stroke="var(--support)" stroke-width="1.3" stroke-dasharray="4 3" />`;
    svg += `<text x="${w - padR + 6}" y="${y(data.support).toFixed(1)}" fill="var(--support)" font-size="9.5" dominant-baseline="middle">${data.support.toFixed(2)}</text>`;
  }
  if (data.resistance != null) {
    svg += `<line x1="${padL}" y1="${y(data.resistance).toFixed(1)}" x2="${w - padR}" y2="${y(data.resistance).toFixed(1)}" stroke="var(--resistance)" stroke-width="1.3" stroke-dasharray="4 3" />`;
    svg += `<text x="${w - padR + 6}" y="${y(data.resistance).toFixed(1)}" fill="var(--resistance)" font-size="9.5" dominant-baseline="middle">${data.resistance.toFixed(2)}</text>`;
  }
  if (data.stop != null) {
    svg += `<line x1="${padL}" y1="${y(data.stop).toFixed(1)}" x2="${w - padR}" y2="${y(data.stop).toFixed(1)}" stroke="var(--bad)" stroke-width="1.5" />`;
    svg += `<text x="${w - padR + 6}" y="${y(data.stop).toFixed(1)}" fill="var(--bad)" font-size="9.5" font-weight="700" dominant-baseline="middle">${data.stop.toFixed(2)}</text>`;
  }
  (data.targets || []).forEach((t, idx) => {
    const trueY = y(t), ty = clip(t);
    const offscreen = trueY < padT;
    svg += `<line x1="${padL}" y1="${ty.toFixed(1)}" x2="${w - padR}" y2="${ty.toFixed(1)}" stroke="var(--good)" stroke-width="1" stroke-dasharray="1 3" opacity="${offscreen ? 0.5 : 0.7}" />`;
    svg += `<text x="${w - padR + 6}" y="${ty.toFixed(1)}" fill="var(--good)" font-size="9.5" dominant-baseline="middle">${offscreen ? "↑ " : ""}T${idx + 1} ${t.toFixed(2)}</text>`;
  });

  svg += `<path d="${smaPath}" fill="none" stroke="var(--sma)" stroke-width="1.2" stroke-dasharray="2 2" />`;

  closes.forEach((c, i) => {
    const cx = x(i);
    const up = i === 0 ? true : c >= closes[i - 1];
    const color = up ? "var(--good)" : "var(--bad)";
    svg += `<line x1="${cx.toFixed(1)}" y1="${y(highs[i]).toFixed(1)}" x2="${cx.toFixed(1)}" y2="${y(lows[i]).toFixed(1)}" stroke="${color}" stroke-width="2" opacity="0.9" />`;
    svg += `<line x1="${cx.toFixed(1)}" y1="${y(c).toFixed(1)}" x2="${(cx + barW * 0.36).toFixed(1)}" y2="${y(c).toFixed(1)}" stroke="${color}" stroke-width="2" opacity="0.9" />`;
  });

  const lastX = x(n - 1), lastY = y(closes[n - 1]);
  svg += `<line x1="${lastX.toFixed(1)}" y1="${lastY.toFixed(1)}" x2="${w - padR}" y2="${lastY.toFixed(1)}" stroke="var(--accent)" stroke-width="1" stroke-dasharray="1 2" opacity="0.6" />`;
  svg += `<circle cx="${lastX.toFixed(1)}" cy="${lastY.toFixed(1)}" r="3.6" fill="var(--accent)" />`;
  svg += `<text x="${w - padR + 6}" y="${lastY.toFixed(1)}" fill="var(--accent)" font-size="10" font-weight="700" dominant-baseline="middle">${closes[n - 1].toFixed(2)}</text>`;

  if (data.volumes) {
    const volTop = priceH + gap;
    const volMax = Math.max(...data.volumes) || 1;
    const vy = (v) => volTop + (1 - v / volMax) * volH;
    svg += `<line x1="${padL}" y1="${volTop.toFixed(1)}" x2="${w - padR}" y2="${volTop.toFixed(1)}" stroke="var(--border)" stroke-width="1" />`;
    data.volumes.forEach((v, i) => {
      const cx = x(i);
      const up = i === 0 ? true : closes[i] >= closes[i - 1];
      const color = up ? "var(--good)" : "var(--bad)";
      svg += `<rect x="${(cx - barW * 0.34).toFixed(1)}" y="${vy(v).toFixed(1)}" width="${(barW * 0.68).toFixed(1)}" height="${(volTop + volH - vy(v)).toFixed(1)}" fill="${color}" opacity="0.55" />`;
    });
    svg += `<text x="${w - padR + 6}" y="${(volTop + 8).toFixed(1)}" fill="var(--text-muted)" font-size="8.5">vol</text>`;
  }

  svg += `</svg>`;
  return svg;
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
    ${buildChartSVG(data)}
    <div class="chart-legend">
      <span><i style="background:var(--text-primary)"></i>Close</span>
      <span><i style="background:var(--sma)"></i>10-day avg</span>
      <span><i style="background:var(--support)"></i>Support</span>
      <span><i style="background:var(--resistance)"></i>Resistance</span>
    </div>

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
