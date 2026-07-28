import { supabase, hasSupabaseConfig } from "./supabase.js";
import * as store from "./storage.js";
import { summarizePositions, suggestSplit } from "./portfolio.js";
import { estimateValue, CLOUDS_ANNUAL_RATE } from "./estimate.js";

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
      return `
        <tr>
          <td class="tick">${r.ticker}${estimateLabel(r.ticker, est)}</td>
          <td class="num">${Math.round(r.invested).toLocaleString()}</td>
          <td class="num">${Math.round(r.value).toLocaleString()}</td>
          <td class="num ${r.gain >= 0 ? "pos" : "neg"}">${r.gain >= 0 ? "+" : ""}${Math.round(r.gain).toLocaleString()}</td>
          <td class="num ${r.gainPct >= 0 ? "pos" : "neg"}">${fmtPct(r.gainPct)}</td>
          <td class="num">${fmtPct(r.mixPct)}</td>
          <td class="num">${fmtPct(r.targetPct)}</td>
        </tr>`;
    })
    .join("");
  return `
    <div class="card">
      <h2>Positions</h2>
      <p class="card-note">"Value" below is an estimate where possible (see the note under each ticker), refreshed on this schedule: ${REFRESH_SCHEDULE_NOTE}</p>
      <table>
        <thead><tr><th>Ticker</th><th class="num">Invested</th><th class="num">Value</th><th class="num">Gain</th><th class="num">Gain %</th><th class="num">Mix %</th><th class="num">Target %</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </div>
  `;
}

function tickerOptions() {
  const tickers = new Set([...Object.keys(state.positions), ...Object.keys(state.targets)]);
  return [...tickers].sort().map((t) => `<option value="${t}">${t}</option>`).join("");
}

function renderAddTransactionForm() {
  return `
    <div class="card">
      <h2>Record a purchase or sale</h2>
      <form class="inline" id="txn-form">
        <div class="field"><label>Ticker</label>
          <input list="ticker-list" name="ticker" required placeholder="e.g. COMI" />
          <datalist id="ticker-list">${tickerOptions()}</datalist>
        </div>
        <div class="field"><label>Type</label>
          <select name="type"><option value="buy">Buy</option><option value="sell">Sell</option></select>
        </div>
        <div class="field"><label>Amount (EGP)</label><input type="number" name="amount" min="0" step="0.01" required /></div>
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

function renderAnalysisNotes() {
  if (!state.user) return "";
  const rows = Object.values(state.analysisNotes)
    .map(
      (n) => `
      <div style="margin-bottom:10px">
        <strong class="tick">${n.ticker}</strong> <span class="muted">— refreshed ${new Date(n.refreshed_at).toLocaleDateString()}</span>
        <p style="margin:4px 0 0; font-size:0.85rem">${n.summary}</p>
      </div>`
    )
    .join("");
  return `
    <div class="card">
      <h2>AI analysis (from TheRumble)</h2>
      <p class="card-note">Refreshed on request, not on a timer — ask Claude to re-review TheRumble and paste the result below when you want a fresh read.</p>
      ${rows || `<p class="muted">Nothing recorded yet.</p>`}
      <details style="margin-top:10px">
        <summary style="cursor:pointer; font-size:0.85rem; color:var(--text-secondary)">Paste a refresh</summary>
        <p class="card-note" style="margin-top:8px">Expects JSON like <code>{"ISPH": "summary text...", "COMI": "..."}</code> — one key per ticker.</p>
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

  document.getElementById("txn-form")?.addEventListener("submit", async (e) => {
    e.preventDefault();
    const f = e.target;
    await store.addTransaction(
      f.ticker.value.toUpperCase(),
      f.type.value,
      parseFloat(f.amount.value),
      f.date.value
    );
    f.reset();
    refresh();
  });

  document.getElementById("value-form")?.addEventListener("submit", async (e) => {
    e.preventDefault();
    const f = e.target;
    const ticker = f.ticker.value.toUpperCase();
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
    await store.setTarget(f.ticker.value.toUpperCase(), parseFloat(f.pct.value) / 100);
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
      const rows = Object.entries(parsed).map(([ticker, summary]) => ({
        user_id: state.user.id,
        ticker: ticker.toUpperCase(),
        summary: String(summary),
        refreshed_at: new Date().toISOString(),
      }));
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
      const ticker = document.querySelector(`[data-review-ticker="${i}"]`).value.toUpperCase();
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
