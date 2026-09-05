import { supabase, hasSupabaseConfig } from "./supabase.js";
import * as store from "./storage.js";
import { summarizePositions, suggestSplit, netShares, netInvested, hasCompleteShareData } from "./portfolio.js";
import { estimateValue, CLOUDS_ANNUAL_RATE } from "./estimate.js";
import { buildAnalysisCard, buildFundamentalsGlossary, mountChart } from "./analysis-chart.js";

const REFRESH_SCHEDULE_NOTE =
  "10:00, 13:00 and 15:00 Cairo time, Sunday–Thursday (EGX trading days). Fund NAVs (BAL/BMM/BRE) only actually change once a day regardless of how often this runs — funds are priced end-of-day, not intraday.";

const app = document.getElementById("app");

const fmtEGP = (n) =>
  `${Math.round(n).toLocaleString()} EGP`;
const fmtPct = (n) => `${n.toFixed(1)}%`;

let state = {
  user: null,
  positions: {},
  targets: {},
  marketPrices: {},
  analysisNotes: {},
  loading: true,
  error: null,
};

async function refresh() {
  state.loading = true;
  render();
  try {
    state.user = await store.getUser();
    const { positions, targets } = await store.loadPortfolio();
    state.positions = positions;
    state.targets = targets;
    state.marketPrices = await store.getMarketPrices();
    if (state.user && supabase) {
      const { data } = await supabase
        .from("analysis_notes")
        .select("*")
        .eq("user_id", state.user.id);
      state.analysisNotes = Object.fromEntries((data || []).map((n) => [n.ticker, n]));
    } else {
      state.analysisNotes = {};
    }
  } catch (e) {
    state.error = e.message;
  }
  state.loading = false;
  render();
}

function estimatedPositions() {
  const estimates = {};
  const effective = {};
  for (const [ticker, pos] of Object.entries(state.positions)) {
    const est = estimateValue(ticker, pos, state.marketPrices);
    estimates[ticker] = est;
    effective[ticker] = { ...pos, currentValue: est.value };
  }
  return { effective, estimates };
}

// Real chart instances (lightweight-charts), keyed by ticker - a plain
// innerHTML re-render discards their DOM nodes without telling the library,
// so they must be explicitly .remove()'d before mounting new ones each
// render or they leak (and pile up invisible redraw work) on every action.
let activeCharts = {};

function mountCharts() {
  for (const chart of Object.values(activeCharts)) {
    try {
      chart.remove();
    } catch {
      // already gone - fine
    }
  }
  activeCharts = {};
  document.querySelectorAll("[data-chart-ticker]").forEach((el) => {
    const ticker = el.dataset.chartTicker;
    const chartData = state.analysisNotes[ticker]?.chart_data;
    if (!chartData || !chartData.closes) return;
    try {
      activeCharts[ticker] = mountChart(el, chartData);
    } catch (e) {
      el.innerHTML = `<p class="muted">Chart failed to load: ${e.message}</p>`;
    }
  });
}

function render() {
  const { effective, estimates } = estimatedPositions();
  const summary = summarizePositions(effective, state.targets);

  app.innerHTML = `
    <div class="wrap">
      ${renderHeader()}
      ${state.error ? `<p class="error">${state.error}</p>` : ""}
      ${state.loading ? `<p class="muted">Loading…</p>` : ""}
      ${renderStats(summary)}
      ${renderPositionsTable(summary, estimates)}
      ${renderAddTransactionForm()}
      ${renderUpdateValueForm()}
      ${renderScreenshotUpload()}
      ${renderSplitTool()}
      ${renderTargetsEditor()}
      ${renderMarketPrices()}
      ${renderAnalysisNotes()}
      ${!state.user ? renderVisitorTools() : ""}
    </div>
  `;
  wireEvents();
  mountCharts();
}

function renderHeader() {
  const badge = state.user
    ? `<span class="pill">${state.user.email}</span> <button class="secondary" id="sign-out">Sign out</button>`
    : `<span class="pill local">Visitor mode — data stays on this device</span>`;
  return `
    <header class="app-header">
      <div>
        <h1>EGX Portfolio Tracker</h1>
        <p class="subtitle">Egyptian market only — funds, stocks, gold</p>
      </div>
      <div>
        ${badge}
        ${!state.user && hasSupabaseConfig ? `
          <form class="inline" id="signin-form" style="display:inline-flex">
            <input type="email" id="signin-email" placeholder="you@email.com" required />
            <button type="submit">Sign in</button>
          </form>` : ""}
      </div>
    </header>
  `;
}

function renderStats(summary) {
  return `
    <div class="stat-row">
      <div class="stat-tile">
        <div class="stat-label">Total value</div>
        <div class="stat-value">${fmtEGP(summary.totalValue)}</div>
      </div>
      <div class="stat-tile">
        <div class="stat-label">Invested</div>
        <div class="stat-value">${fmtEGP(summary.totalInvested)}</div>
      </div>
      <div class="stat-tile">
        <div class="stat-label">Gain</div>
        <div class="stat-value ${summary.totalGain >= 0 ? "pos" : "neg"}">
          ${summary.totalGain >= 0 ? "+" : ""}${fmtEGP(summary.totalGain)} (${summary.totalGainPct.toFixed(1)}%)
        </div>
      </div>
    </div>
  `;
}

function estimateLabel(ticker, est) {
  if (est.kind === "price-ratio") {
    const noteExtra =
      ticker === "Gold"
        ? " — global spot converted to EGP; Thndr's local Egyptian gold price can differ from this"
        : "";
    return `<div class="muted">estimated from ${est.source} price change${noteExtra}</div>`;
  }
  if (est.kind === "accrual") {
    return `<div class="muted">estimated: ${est.days}d compounding at ~${(CLOUDS_ANNUAL_RATE * 100).toFixed(1)}%/yr — not a market price, Clouds is interest-accruing cash, not a traded instrument</div>`;
  }
  return `<div class="muted">as of your last confirmed value${state.positions[ticker]?.lastValued ? ` (${state.positions[ticker].lastValued})` : ""}</div>`;
}

function renderPositionsTable(summary, estimates) {
  if (!summary.rows.length) {
    return `<div class="card"><h2>Positions</h2><p class="card-note">No positions yet — add a purchase below to get started.</p></div>`;
  }
  const rows = summary.rows
    .map((r) => {
      const est = estimates[r.ticker] || { kind: "confirmed" };
      const txns = state.positions[r.ticker]?.transactions || [];
      const avgCost = hasCompleteShareData(txns)
        ? netInvested(txns) / netShares(txns)
        : null;
      return `
        <tr>
          <td class="tick">${r.ticker}${estimateLabel(r.ticker, est)}</td>
          <td class="num">${Math.round(r.invested).toLocaleString()}</td>
          <td class="num">${Math.round(r.value).toLocaleString()}</td>
          <td class="num ${r.gain >= 0 ? "pos" : "neg"}">${r.gain >= 0 ? "+" : ""}${Math.round(r.gain).toLocaleString()}</td>
          <td class="num ${r.gainPct >= 0 ? "pos" : "neg"}">${fmtPct(r.gainPct)}</td>
          <td class="num">${avgCost != null ? avgCost.toFixed(2) : "—"}</td>
          <td class="num">${fmtPct(r.mixPct)}</td>
          <td class="num">${fmtPct(r.targetPct)}</td>
        </tr>`;
    })
    .join("");
  return `
    <div class="card">
      <h2>Positions</h2>
      <p class="card-note">"Value" below is an estimate where possible (see the note under each ticker), refreshed on this schedule: ${REFRESH_SCHEDULE_NOTE}. "Avg cost" is (total invested) ÷ (net shares/units held) — only shown once every buy/sell for that ticker has a share count.</p>
      <table>
        <thead><tr><th>Ticker</th><th class="num">Invested</th><th class="num">Value</th><th class="num">Gain</th><th class="num">Gain %</th><th class="num">Avg cost</th><th class="num">Mix %</th><th class="num">Target %</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </div>
  `;
}

function tickerOptions() {
  const tickers = new Set([...Object.keys(state.positions), ...Object.keys(state.targets)]);
  return [...tickers].sort().map((t) => `<option value="${t}">${t}</option>`).join("");
}

// Mutual funds are priced/held in "units" (NAV-based); everything else
// tradeable on the exchange (stocks, gold by the gram) uses "shares". Clouds
// is cash, not held in either unit, so it's excluded from the ticker list
// and the field is just left blank for it (see schema.sql's comment).
const FUND_TICKERS = ["BAL", "BMM", "BRE", "C2O", "T70"];
function sharesLabel(ticker) {
  if (!ticker) return "Shares/Units";
  return FUND_TICKERS.includes(ticker.trim()) ? "Units" : "Shares";
}

function renderAddTransactionForm() {
  return `
    <div class="card">
      <h2>Record a purchase or sale</h2>
      <p class="card-note">Also bumps this position's value by the same amount (buy: +, sell: −) so it doesn't show as a loss until you next confirm the real number — it's a placeholder, not a live price. Enter the share/unit count too (skip for Clouds) and, once every buy for a ticker has one, the Positions table can value it directly as shares × live price and show your average cost.</p>
      <form class="inline" id="txn-form">
        <div class="field"><label>Ticker</label>
          <input list="ticker-list" name="ticker" required placeholder="e.g. COMI" id="txn-ticker" />
          <datalist id="ticker-list">${tickerOptions()}</datalist>
        </div>
        <div class="field"><label>Type</label>
          <select name="type"><option value="buy">Buy</option><option value="sell">Sell</option></select>
        </div>
        <div class="field"><label>Amount (EGP)</label><input type="number" name="amount" min="0" step="0.01" required /></div>
        <div class="field"><label id="txn-shares-label">${sharesLabel()}</label><input type="number" name="shares" min="0" step="0.0001" placeholder="optional" /></div>
        <div class="field"><label>Date</label><input type="date" name="date" value="${today()}" /></div>
        <button type="submit">Save</button>
      </form>
    </div>
  `;
}

function renderUpdateValueForm() {
  return `
    <div class="card">
      <h2>Update current value</h2>
      <p class="card-note">The source of truth — type in what Thndr actually shows. This also resets the baseline the live estimate (shown in the Positions table) scales from, so confirming periodically keeps the estimate accurate.</p>
      <form class="inline" id="value-form">
        <div class="field"><label>Ticker</label>
          <input list="ticker-list" name="ticker" required />
        </div>
        <div class="field"><label>Current value (EGP)</label><input type="number" name="value" min="0" step="0.01" required /></div>
        <div class="field"><label>Date</label><input type="date" name="date" value="${today()}" /></div>
        <button type="submit">Save</button>
      </form>
    </div>
  `;
}

let screenshotReview = null; // { ticker: value } pending confirmation, or null

function renderScreenshotUpload() {
  const reviewRows = screenshotReview
    ? Object.entries(screenshotReview)
        .map(
          ([ticker, value], i) => `
        <div class="field" style="flex-direction:row; align-items:center; gap:6px;">
          <input type="checkbox" checked data-review-include="${i}" />
          <input value="${ticker}" data-review-ticker="${i}" style="width:80px" />
          <input type="number" step="0.01" value="${value}" data-review-value="${i}" style="width:110px" />
        </div>`
        )
        .join("")
    : "";
  return `
    <div class="card">
      <h2>Update values from a screenshot</h2>
      <p class="card-note">Free, no paid API involved: share the screenshot with Claude in a chat ("here's my Thndr dashboard, update my values") — Claude reads it and gives you back JSON like <code>{"COMI": 5300, "BAL": 16101.61}</code>. Paste that below. You review and edit before anything is saved; nothing writes automatically.</p>
      <form id="screenshot-paste-form">
        <textarea name="json" rows="4" placeholder='{"COMI": 5300, "BAL": 16101.61}' style="width:100%; background:var(--page); border:1px solid var(--border); color:var(--text-primary); border-radius:6px; padding:8px; font-family:monospace; font-size:0.8rem;"></textarea>
        <div style="margin-top:8px"><button type="submit">Parse</button></div>
      </form>
      <div id="screenshot-status" class="muted" style="margin-top:8px"></div>
      ${
        screenshotReview
          ? `
        <div style="margin-top:12px">
          <p class="card-note">Review before saving — uncheck or edit anything that looks wrong:</p>
          <div style="display:flex; flex-direction:column; gap:6px;">${reviewRows}</div>
          <button id="screenshot-save" style="margin-top:10px">Save reviewed values</button>
          <button class="secondary" id="screenshot-cancel" style="margin-top:10px">Cancel</button>
        </div>`
          : ""
      }
    </div>
  `;
}

function renderSplitTool() {
  return `
    <div class="card">
      <h2>Split new money</h2>
      <form class="inline" id="split-form">
        <div class="field"><label>Amount (EGP)</label><input type="number" name="amount" min="0" step="1" required /></div>
        <button type="submit">Compute split</button>
      </form>
      <div id="split-result"></div>
    </div>
  `;
}

function renderTargetsEditor() {
  const rows = Object.entries(state.targets)
    .map(
      ([ticker, pct]) => `
      <tr>
        <td class="tick">${ticker}</td>
        <td class="num">${(pct * 100).toFixed(1)}%</td>
        <td><button class="secondary" data-remove-target="${ticker}">Remove</button></td>
      </tr>`
    )
    .join("");
  return `
    <div class="card">
      <h2>Target allocation</h2>
      <p class="card-note">Weights don't need to sum to exactly 100% while you're editing, but the split tool assumes they roughly do</p>
      <table><tbody>${rows}</tbody></table>
      <form class="inline" id="target-form" style="margin-top:10px">
        <div class="field"><label>Ticker</label><input name="ticker" required /></div>
        <div class="field"><label>Target %</label><input type="number" name="pct" min="0" max="100" step="0.1" required /></div>
        <button type="submit">Set</button>
      </form>
    </div>
  `;
}

function renderMarketPrices() {
  const rows = Object.values(state.marketPrices)
    .map(
      (p) => `
      <tr>
        <td class="tick">${p.ticker}</td>
        <td class="num">${p.is_estimate ? "~" : ""}${p.price} ${p.currency}</td>
        <td class="muted">${p.source}</td>
        <td class="muted">${new Date(p.updated_at).toLocaleDateString()}</td>
      </tr>`
    )
    .join("");
  return `
    <div class="card">
      <h2>Market prices</h2>
      <p class="card-note">Refreshed ${REFRESH_SCHEDULE_NOTE} Gold here is the global spot price converted to EGP (via GoldAPI.io) — not the same as Thndr's local Egyptian gold price, which can run at a premium or discount to a simple spot conversion. Clouds has no market price at all (see the Positions table for how its estimate works instead).</p>
      ${rows ? `<table><thead><tr><th>Ticker</th><th class="num">Price</th><th>Source</th><th>Updated</th></tr></thead><tbody>${rows}</tbody></table>` : `<p class="muted">No prices synced yet.</p>`}
    </div>
  `;
}

// (total invested) / (net shares) for a ticker, or null if any transaction
// for it is missing a share count — same rule the Positions table uses,
// preferred over anything in the pasted JSON so it can never drift out of
// sync with real transactions. Falls back to chart_data.avgCostOverride
// (clearly labeled as such in the UI) only when the live figure is
// unavailable — e.g. an older transaction is missing its share count.
function avgCostFor(ticker, fallback) {
  const txns = state.positions[ticker]?.transactions || [];
  const live = hasCompleteShareData(txns) ? netInvested(txns) / netShares(txns) : null;
  return { value: live ?? fallback ?? null, isLive: live != null };
}

function renderAnalysisNote(n) {
  if (n.chart_data && n.chart_data.closes) {
    try {
      const avg = avgCostFor(n.ticker, n.chart_data.avgCostOverride);
      return buildAnalysisCard(n.ticker, n.chart_data, avg.value, avg.isLive);
    } catch (e) {
      return `<div class="muted">${n.ticker}: couldn't render chart_data (${e.message}) — showing summary only.</div><p style="font-size:0.85rem">${n.summary}</p>`;
    }
  }
  return `
  <div style="margin-bottom:10px">
    <strong class="tick">${n.ticker}</strong> <span class="muted">— refreshed ${new Date(n.refreshed_at).toLocaleDateString()}</span>
    <p style="margin:4px 0 0; font-size:0.85rem">${n.summary}</p>
  </div>`;
}

function renderAnalysisNotes() {
  if (!state.user) return "";
  const all = Object.values(state.analysisNotes);
  // Opportunities (candidates not currently held) get their own section, kept
  // apart from things you actually hold or track (positions + indices/funds) -
  // classified by an explicit `kind` on chart_data rather than guessed, so a
  // plain-text note (no chart_data.kind at all) defaults to the holdings side.
  const opportunities = all.filter((n) => n.chart_data?.kind === "opportunity");
  const held = all.filter((n) => n.chart_data?.kind !== "opportunity");

  // Best-to-worst by verdictScore (0-100, higher = more attractive right
  // now) - unscored entries (or plain-text notes) sort last rather than
  // crashing the comparison.
  opportunities.sort((a, b) => (b.chart_data?.verdictScore ?? -1) - (a.chart_data?.verdictScore ?? -1));

  // Held stocks sort by urgency first, then holdingScore - a real
  // actionNeeded item outranks everything (something to actually go do),
  // then a price sitting close to its stop/target (about to become
  // actionable even before actionNeeded is written down), then everything
  // else. Within each of those tiers, best-behaving holdingScore first.
  const urgencyTier = (n) => {
    const d = n.chart_data;
    if (!d) return 0;
    if (d.actionNeeded) return 2;
    const last = d.closes?.[d.closes.length - 1];
    const levels = [d.stop, ...(d.targets || [])].filter((v) => v != null);
    if (last != null && levels.length) {
      const minDistPct = Math.min(...levels.map((l) => Math.abs(l - last) / last)) * 100;
      if (minDistPct < 3) return 1;
    }
    return 0;
  };
  held.sort((a, b) => {
    const tierDiff = urgencyTier(b) - urgencyTier(a);
    if (tierDiff) return tierDiff;
    return (b.chart_data?.holdingScore ?? -1) - (a.chart_data?.holdingScore ?? -1);
  });

  const heldRows = held.map(renderAnalysisNote).join("");
  const oppRows = opportunities.map(renderAnalysisNote).join("");

  return `
    <div class="card">
      <h2>AI analysis</h2>
      <p class="card-note">Refreshed on request, not on a timer — ask Claude for a fresh technical read and paste the result below. Each ticker can be a plain string (quick text note) or an object with chart data (closes/highs/lows/support/resistance/stop/targets/pattern/rsi/...) for a full chart + exit ladder. Add <code>"kind":"opportunity"</code> to a ticker's object to list it under Opportunities instead of your holdings.</p>
      ${buildFundamentalsGlossary()}
      ${heldRows || `<p class="muted">Nothing recorded yet.</p>`}
      ${
        oppRows
          ? `<h3 style="margin:20px 0 4px; font-size:0.95rem">Opportunities — not yet held</h3>
      <p class="card-note">Candidates researched but not owned — screened the same way as everything above, just not in your portfolio.</p>
      ${oppRows}`
          : ""
      }
      <details style="margin-top:10px">
        <summary style="cursor:pointer; font-size:0.85rem; color:var(--text-secondary)">Paste a refresh</summary>
        <p class="card-note" style="margin-top:8px">Expects JSON like <code>{"GOLD": "text summary...", "COMI": {"closes":[...],"highs":[...],"lows":[...],"support":135.35,"resistance":141,"stop":135,"targets":[141,180.53],"pattern":"...","rsi":39,"trendLabel":"Down","buyApproach":"...","why":"...","short":"...","medium":"...","long":"..."}}</code> — one key per ticker, string or object.</p>
        <form id="analysis-form">
          <textarea name="json" rows="6" style="width:100%; background:var(--page); border:1px solid var(--border); color:var(--text-primary); border-radius:6px; padding:8px; font-family:monospace; font-size:0.8rem;"></textarea>
          <div style="margin-top:8px"><button type="submit">Save</button></div>
        </form>
      </details>
    </div>
  `;
}

function renderVisitorTools() {
  return `
    <div class="card">
      <h2>Your data</h2>
      <p class="card-note">Stored only in this browser. Export it to move to another device, or to back it up.</p>
      <button class="secondary" id="export-btn">Export data</button>
      <label class="secondary" style="display:inline-block; padding:8px 14px; border:1px solid var(--border); border-radius:6px; cursor:pointer; margin-left:8px;">
        Import data <input type="file" id="import-input" accept="application/json" style="display:none" />
      </label>
    </div>
  `;
}

function today() {
  return new Date().toISOString().slice(0, 10);
}


function wireEvents() {
  document.getElementById("sign-out")?.addEventListener("click", async () => {
    await store.signOut();
    refresh();
  });

  document.getElementById("signin-form")?.addEventListener("submit", async (e) => {
    e.preventDefault();
    const email = e.target.elements["signin-email"].value;
    try {
      await store.signInWithEmail(email);
      alert("Check your email for a sign-in link.");
    } catch (err) {
      state.error = err.message;
      render();
    }
  });

  document.getElementById("txn-ticker")?.addEventListener("input", (e) => {
    const label = document.getElementById("txn-shares-label");
    if (label) label.textContent = sharesLabel(e.target.value);
  });

  document.getElementById("txn-form")?.addEventListener("submit", async (e) => {
    e.preventDefault();
    const f = e.target;
    const ticker = f.ticker.value.trim();
    const shares = f.shares.value ? parseFloat(f.shares.value) : null;
    await store.addTransaction(
      ticker,
      f.type.value,
      parseFloat(f.amount.value),
      f.date.value,
      state.marketPrices[ticker] || null,
      shares
    );
    f.reset();
    refresh();
  });

  document.getElementById("value-form")?.addEventListener("submit", async (e) => {
    e.preventDefault();
    const f = e.target;
    const ticker = f.ticker.value.trim();
    await store.setCurrentValue(
      ticker,
      parseFloat(f.value.value),
      f.date.value,
      state.marketPrices[ticker] || null
    );
    f.reset();
    refresh();
  });

  document.getElementById("target-form")?.addEventListener("submit", async (e) => {
    e.preventDefault();
    const f = e.target;
    await store.setTarget(f.ticker.value.trim(), parseFloat(f.pct.value) / 100);
    f.reset();
    refresh();
  });

  document.querySelectorAll("[data-remove-target]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      await store.removeTarget(btn.dataset.removeTarget);
      refresh();
    });
  });

  document.getElementById("split-form")?.addEventListener("submit", (e) => {
    e.preventDefault();
    const amount = parseFloat(e.target.amount.value);
    const alloc = suggestSplit(state.positions, state.targets, amount);
    const rows = Object.entries(alloc)
      .filter(([, v]) => Math.round(v) > 0)
      .sort((a, b) => b[1] - a[1])
      .map(([ticker, v]) => `<tr><td class="tick">${ticker}</td><td class="num">${Math.round(v).toLocaleString()} EGP</td></tr>`)
      .join("");
    document.getElementById("split-result").innerHTML = `
      <table style="margin-top:10px"><tbody>${rows}</tbody></table>
    `;
  });

  document.getElementById("analysis-form")?.addEventListener("submit", async (e) => {
    e.preventDefault();
    if (!state.user || !supabase) return;
    try {
      const parsed = JSON.parse(e.target.json.value);
      const rows = Object.entries(parsed).map(([ticker, val]) => {
        const isChart = val && typeof val === "object";
        return {
          user_id: state.user.id,
          ticker: ticker.trim(),
          // A plain string is used as-is. An object needs a short text summary
          // too (shown even if chart rendering ever fails) - use its own
          // `summary` field if given, else fall back to the pattern/trend text.
          summary: isChart ? String(val.summary || val.pattern || val.trendLabel || ticker) : String(val),
          chart_data: isChart ? val : null,
          refreshed_at: new Date().toISOString(),
        };
      });
      const { error } = await supabase.from("analysis_notes").upsert(rows);
      if (error) throw error;
      refresh();
    } catch (err) {
      state.error = err.message;
      render();
    }
  });

  document.getElementById("screenshot-paste-form")?.addEventListener("submit", (e) => {
    e.preventDefault();
    const statusEl = document.getElementById("screenshot-status");
    try {
      const parsed = JSON.parse(e.target.json.value);
      if (!Object.keys(parsed).length) {
        statusEl.textContent = "That parsed to an empty object — nothing to review.";
        return;
      }
      screenshotReview = parsed;
      statusEl.textContent = "";
      render();
    } catch (err) {
      statusEl.textContent = `Couldn't parse that as JSON: ${err.message}`;
    }
  });

  document.getElementById("screenshot-save")?.addEventListener("click", async () => {
    const entries = Object.keys(screenshotReview);
    for (let i = 0; i < entries.length; i++) {
      const include = document.querySelector(`[data-review-include="${i}"]`)?.checked;
      if (!include) continue;
      const ticker = document.querySelector(`[data-review-ticker="${i}"]`).value.trim();
      const value = parseFloat(document.querySelector(`[data-review-value="${i}"]`).value);
      if (ticker && !isNaN(value)) {
        await store.setCurrentValue(ticker, value, today(), state.marketPrices[ticker] || null);
      }
    }
    screenshotReview = null;
    refresh();
  });

  document.getElementById("screenshot-cancel")?.addEventListener("click", () => {
    screenshotReview = null;
    render();
  });

  document.getElementById("export-btn")?.addEventListener("click", () => {
    const blob = new Blob([store.exportLocalData()], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `eg-stock-portfolio-${today()}.json`;
    a.click();
  });

  document.getElementById("import-input")?.addEventListener("change", async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    try {
      store.importLocalData(await file.text());
      refresh();
    } catch (err) {
      state.error = err.message;
      render();
    }
  });
}

if (supabase) {
  supabase.auth.onAuthStateChange(() => refresh());
}

refresh();
