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
    currentValues[row.ticker] = { value: row.value, lastValued: row.last_valued };
  }
  const targets = {};
  for (const row of targetRows || []) {
    targets[row.ticker] = row.target_pct;
  }
  const txns = (transactions || []).map((t) => ({
    ticker: t.ticker,
    type: t.type,
    amount: t.amount,
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
  }
  return { positions, targets };
}

// ── Writing ──

export async function addTransaction(ticker, type, amount, date) {
  const user = await getUser();
  const txn = { ticker, type, amount, date };
  if (user) {
    const { error } = await supabase.from("transactions").insert({
      user_id: user.id,
      ticker,
      type,
      amount,
      txn_date: date,
    });
    if (error) throw error;
  } else {
    const data = readLocal();
    data.transactions.push(txn);
    writeLocal(data);
  }
}

export async function setCurrentValue(ticker, value, date) {
  const user = await getUser();
  if (user) {
    const { error } = await supabase.from("current_values").upsert({
      user_id: user.id,
      ticker,
      value,
      last_valued: date,
    });
    if (error) throw error;
  } else {
    const data = readLocal();
    data.currentValues[ticker] = { value, lastValued: date };
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
