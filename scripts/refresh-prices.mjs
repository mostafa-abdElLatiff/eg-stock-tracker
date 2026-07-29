#!/usr/bin/env node
// Refreshes market_prices in Supabase from PUBLIC, credential-free sources.
// No Thndr or TheRumble login involved anywhere in this script - see the
// README for why that's a hard line, not a missing feature.
//
// Sources, verified working while building this (Jul 2026):
//   - BAL/BMM/BRE: snduk.com fund pages - price is embedded server-side in
//     a Next.js RSC payload as `"currentPrice":"X.XXXX"`. Confirmed by
//     fetching the pages directly and finding real, current prices.
//   - COMI/MASR/ETEL/CLHO: EODHD free tier (20 calls/day - this uses 4-5).
//     No live intraday EGX data on this plan - `close` comes back "NA",
//     so this uses `previousClose` (flagged is_estimate) instead. Confirmed
//     live against the real API key, not just assumed from docs.
//   - IBCT: EODHD has no data at all for this one (not even previousClose)
//     - stays unpriced, same as C2O/T70 below.
//   - Gold: GoldAPI.io (EGP) - needs a free API key
//   - C2O, T70: no confirmed public source found yet - left as a manual
//     entry with is_estimate flagged, rather than guessing at an endpoint.
//     If you find a reliable source for these, add a fetcher below.
//   - Clouds: not a market price at all - it's interest-accruing cash, so
//     it's computed from a known annual rate, not fetched from anywhere.

import { createClient } from "@supabase/supabase-js";

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const EODHD_API_KEY = process.env.EODHD_API_KEY;
const GOLDAPI_KEY = process.env.GOLDAPI_KEY;
// Which sources this run should skip - set per-schedule by the workflow
// file. Two cadences, not three: Gold moves during the session and has no
// call cap, so it refreshes every 10 min on its own. Funds AND stocks both
// only get a genuinely new number once a day after close (funds: NAV
// settles after close; stocks: EODHD's free tier has no live intraday EGX
// data at all, see above) - so they share the same post-close schedule.
const SKIP_EODHD = process.env.SKIP_EODHD === "true";
const SKIP_FUNDS = process.env.SKIP_FUNDS === "true";

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  console.error("Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY env vars.");
  process.exit(1);
}

// Service role key bypasses RLS - only ever used here, server-side, never
// shipped to the browser. That's the whole reason it's a GitHub secret and
// not in .env / VITE_ prefixed vars.
const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

const SNDUK_FUNDS = {
  BAL: "beltone-b-alpha-fund",
  BMM: "beltone-meya-100",
  BRE: "beltone-real-estate-fund",
};

const EODHD_STOCKS = {
  COMI: "COMI.EGX",
  MASR: "MASR.EGX",
  ETEL: "ETEL.EGX",
  CLHO: "CLHO.EGX",
  IBCT: "IBCT.EGX",
};

async function fetchSndukPrice(ticker, slug) {
  const url = `https://snduk.com/eg/funds/${slug}?lang=ar`;
  const res = await fetch(url, {
    headers: { "User-Agent": "Mozilla/5.0 (compatible; eg-stock-tracker/1.0)" },
  });
  if (!res.ok) throw new Error(`snduk ${ticker}: HTTP ${res.status}`);
  const html = await res.text();
  // The price is server-rendered inside a Next.js RSC payload, which
  // double-escapes its JSON (backslash-quotes) - hence the optional \\?
  // before every quote below. Confirmed against live pages while building
  // this; if snduk changes their frontend framework this will need updating.
  const match = html.match(/currentPrice\\?":\\?"([\d.]+)\\?".*?lastPriceUpdate\\?":\\?"([\d-]+)\\?"/);
  if (!match) throw new Error(`snduk ${ticker}: price pattern not found - site markup may have changed`);
  return { ticker, price: parseFloat(match[1]), source: "snduk.com", is_estimate: false, asOf: match[2] };
}

async function fetchEodhdStock(ticker, symbol) {
  if (!EODHD_API_KEY) throw new Error(`${ticker}: EODHD_API_KEY not set`);
  const url = `https://eodhd.com/api/real-time/${symbol}?api_token=${EODHD_API_KEY}&fmt=json`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`EODHD ${ticker}: HTTP ${res.status}`);
  const data = await res.json();
  // EODHD's free tier has no live intraday EGX quotes - `close` comes back
  // as the literal string "NA" (confirmed live, Jul 2026), not an error or
  // null. `previousClose` is the real EOD price and IS populated, so fall
  // back to that - it's genuinely all that's available here for free,
  // which is also why stocks refresh on the same post-close cadence as
  // funds now rather than during the session (see the workflow file).
  const live = parseFloat(data.close);
  const prev = parseFloat(data.previousClose);
  if (!Number.isNaN(live)) return { ticker, price: live, source: "EODHD", is_estimate: false };
  if (!Number.isNaN(prev)) return { ticker, price: prev, source: "EODHD", is_estimate: true };
  throw new Error(`EODHD ${ticker}: no usable price in response (close=${JSON.stringify(data.close)}, previousClose=${JSON.stringify(data.previousClose)})`);
}

async function fetchGoldPrice() {
  if (!GOLDAPI_KEY) throw new Error("Gold: GOLDAPI_KEY not set");
  // XAU/EGP, then convert troy-oz -> gram (1 oz = 31.1035g) since Thndr
  // Gold and the position size are naturally thought of in EGP/gram here.
  const res = await fetch("https://www.goldapi.io/api/XAU/EGP", {
    headers: { "x-access-token": GOLDAPI_KEY },
  });
  if (!res.ok) throw new Error(`Gold: HTTP ${res.status}`);
  const data = await res.json();
  if (!data.price) throw new Error("Gold: no price in response");
  const pricePerGram = data.price / 31.1035;
  return { ticker: "Gold", price: Number(pricePerGram.toFixed(2)), source: "GoldAPI.io", is_estimate: false };
}

async function main() {
  const results = [];
  const errors = [];

  const jobs = [
    ...(SKIP_FUNDS
      ? []
      : Object.entries(SNDUK_FUNDS).map(([ticker, slug]) => () => fetchSndukPrice(ticker, slug))),
    ...(SKIP_EODHD
      ? []
      : Object.entries(EODHD_STOCKS).map(([ticker, symbol]) => () => fetchEodhdStock(ticker, symbol))),
    () => fetchGoldPrice(),
  ];

  for (const job of jobs) {
    try {
      results.push(await job());
    } catch (e) {
      errors.push(e.message);
    }
  }

  if (results.length) {
    const rows = results.map((r) => ({
      ticker: r.ticker,
      price: r.price,
      currency: "EGP",
      source: r.source,
      is_estimate: r.is_estimate,
      updated_at: new Date().toISOString(),
    }));
    const { error } = await supabase.from("market_prices").upsert(rows);
    if (error) {
      console.error("Supabase write failed:", error.message);
      process.exit(1);
    }
    console.log(`Updated ${rows.length} prices:`, rows.map((r) => `${r.ticker}=${r.price}`).join(", "));
  }

  if (errors.length) {
    console.warn("Some tickers failed to refresh:\n" + errors.join("\n"));
    // Don't fail the whole job over partial failures (e.g. one API down) -
    // whatever DID succeed is still worth writing.
  }
}

main();
