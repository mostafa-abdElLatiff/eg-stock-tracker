// Storage abstraction: same interface whether the user is logged in
// (Supabase, synced across devices) or a visitor (browser localStorage
// only, never leaves the device). The UI layer never talks to Supabase
// or localStorage directly - only through these functions.

import { supabase } from "./supabase.js";

const LOCAL_KEY = "eg-stock-portfolio-v1";

function readLocal() {
  try {
    const raw = localStorage.getItem(LOCAL_KEY);
    return raw
      ? JSON.parse(raw)
      : { transactions: [], currentValues: {}, targets: {} };
  } catch {
    return { transactions: [], currentValues: {}, targets: {} };
  }
}

function writeLocal(data) {
  localStorage.setItem(LOCAL_KEY, JSON.stringify(data));
}

export async function getUser() {
  if (!supabase) return null;
  const { data } = await supabase.auth.getUser();
  return data?.user ?? null;
}

export async function signInWithEmail(email) {
  if (!supabase) throw new Error("Supabase isn't configured on this deploy.");
  const { error } = await supabase.auth.signInWithOtp({
    email,
    options: { emailRedirectTo: window.location.origin },
  });
  if (error) throw error;
}

export async function signOut() {
  if (supabase) await supabase.auth.signOut();
}

// ── Reading ──

export async function loadPortfolio() {
  const user = await getUser();
  if (user) return loadPortfolioRemote(user.id);
  return loadPortfolioLocal();
}

function loadPortfolioLocal() {
  const { transactions, currentValues, targets } = readLocal();
  return buildPositions(transactions, currentValues, targets);
}

async function loadPortfolioRemote(userId) {
  const [{ data: transactions }, { data: values }, { data: targetRows }] =
    await Promise.all([
      supabase.from("transactions").select("*").eq("user_id", userId),
      supabase.from("current_values").select("*").eq("user_id", userId),
      supabase.from("targets").select("*").eq("user_id", userId),
    ]);

  const currentValues = {};
  for (const row of values || []) {
    currentValues[row.ticker] = {
      value: row.value,
      lastValued: row.last_valued,
      priceAtValuation: row.price_at_valuation,
    };
  }
  const targets = {};
  for (const row of targetRows || []) {
    targets[row.ticker] = row.target_pct;
  }
  const txns = (transactions || []).map((t) => ({
    ticker: t.ticker,
    type: t.type,
    amount: t.amount,
    shares: t.shares,
    date: t.txn_date,
  }));

  return buildPositions(txns, currentValues, targets);
}

function buildPositions(transactions, currentValues, targets) {
  const positions = {};
  for (const t of transactions) {
    if (!positions[t.ticker]) positions[t.ticker] = { transactions: [], currentValue: 0 };
    positions[t.ticker].transactions.push(t);
  }
  for (const [ticker, v] of Object.entries(currentValues)) {
    if (!positions[ticker]) positions[ticker] = { transactions: [], currentValue: 0 };
    positions[ticker].currentValue = v.value;
    positions[ticker].lastValued = v.lastValued;
    positions[ticker].priceAtValuation = v.priceAtValuation ?? null;
  }
  return { positions, targets };
}

// ── Writing ──

// Recording a transaction also bumps the position's current value by the
// same amount (buy: +amount, sell: -amount, floored at 0) - treats new
// money as "invested at face value, no gain yet" until you next confirm
// the real number. This is the same behavior track.py (the CLI tool) has
// always had; the webapp was missing it, which is what produced the
// "buy shows up as a 100% loss" bug.
//
// marketPriceForTicker: pass state.marketPrices[ticker] if available, so
// the new value's baseline price is fresh (today's price), not stale. If
// omitted, price_at_valuation is cleared rather than left stale - a wrong
// baseline paired with a freshly-bumped value would make later price-ratio
// estimates wrong, so "no estimate, just the confirmed number" is safer.
//
// shares: optional. When you know it (Thndr shows this for stock/fund/gold
// buys), estimate.js can then value the position as (net shares) x (live
// price) - more accurate than the price-ratio-since-last-confirmation
// fallback, since it doesn't depend on when you last happened to update a
// value. Leave null for Clouds (cash, no share concept).
export async function addTransaction(ticker, type, amount, date, marketPriceForTicker = null, shares = null) {
  const user = await getUser();
  const txn = { ticker, type, amount, shares, date };
  const signedAmount = type === "buy" ? amount : -amount;
  const priceAtValuation = marketPriceForTicker?.price ?? null;

  if (user) {
    const { error: txnError } = await supabase.from("transactions").insert({
      user_id: user.id,
      ticker,
      type,
      amount,
      shares,
      txn_date: date,
    });
    if (txnError) throw txnError;

    const { data: existing } = await supabase
      .from("current_values")
      .select("value")
      .eq("user_id", user.id)
      .eq("ticker", ticker)
      .maybeSingle();
    const newValue = Math.max(0, (existing?.value || 0) + signedAmount);

    const { error: valueError } = await supabase.from("current_values").upsert({
      user_id: user.id,
      ticker,
      value: newValue,
      last_valued: date,
      price_at_valuation: priceAtValuation,
    });
    if (valueError) throw valueError;
  } else {
    const data = readLocal();
    data.transactions.push(txn);
    const existing = data.currentValues[ticker]?.value || 0;
    data.currentValues[ticker] = {
      value: Math.max(0, existing + signedAmount),
      lastValued: date,
      priceAtValuation,
    };
    writeLocal(data);
  }
}

// marketPriceForTicker: the current entry from market_prices for this
// ticker, if any (pass state.marketPrices[ticker] from the caller). Stored
// alongside the value so estimate.js can later scale proportionally to
// price movement since this exact confirmation.
export async function setCurrentValue(ticker, value, date, marketPriceForTicker = null) {
  const user = await getUser();
  const priceAtValuation = marketPriceForTicker?.price ?? null;
  if (user) {
    const { error } = await supabase.from("current_values").upsert({
      user_id: user.id,
      ticker,
      value,
      last_valued: date,
      price_at_valuation: priceAtValuation,
    });
    if (error) throw error;
  } else {
    const data = readLocal();
    data.currentValues[ticker] = { value, lastValued: date, priceAtValuation };
    writeLocal(data);
  }
}

export async function setTarget(ticker, targetPct, role = null) {
  const user = await getUser();
  if (user) {
    const { error } = await supabase
      .from("targets")
      .upsert({ user_id: user.id, ticker, target_pct: targetPct, role });
    if (error) throw error;
  } else {
    const data = readLocal();
    data.targets[ticker] = targetPct;
    writeLocal(data);
  }
}

export async function removeTarget(ticker) {
  const user = await getUser();
  if (user) {
    const { error } = await supabase
      .from("targets")
      .delete()
      .eq("user_id", user.id)
      .eq("ticker", ticker);
    if (error) throw error;
  } else {
    const data = readLocal();
    delete data.targets[ticker];
    writeLocal(data);
  }
}

// ── Public market prices (read-only, works for everyone incl. visitors) ──

export async function getMarketPrices() {
  if (!supabase) return {};
  const { data, error } = await supabase.from("market_prices").select("*");
  if (error || !data) return {};
  const prices = {};
  for (const row of data) {
    prices[row.ticker] = row;
  }
  return prices;
}

// ── Visitor data portability ──

export function exportLocalData() {
  return JSON.stringify(readLocal(), null, 2);
}

export function importLocalData(json) {
  const parsed = JSON.parse(json);
  if (!parsed.transactions || !parsed.currentValues || !parsed.targets) {
    throw new Error("That file doesn't look like an exported portfolio.");
  }
  writeLocal(parsed);
}
