import { readFileSync } from "fs";

export function parseCsv(path) {
  const raw = readFileSync(path, "utf8").replace(/^﻿/, "");
  const lines = raw.trim().split(/\r?\n/).slice(1);
  const rows = lines.map(line => {
    // Robust quoted-CSV split: match each "..."; field boundaries are exact.
    const fields = [];
    let cur = "";
    let inQuotes = false;
    for (let i = 0; i < line.length; i++) {
      const c = line[i];
      if (c === '"') { inQuotes = !inQuotes; continue; }
      if (c === "," && !inQuotes) { fields.push(cur); cur = ""; continue; }
      cur += c;
    }
    fields.push(cur);
    const [date, price, open, high, low, vol, chg] = fields;
    const [m, d, y] = date.split("/");
    const iso = `${y}-${m.padStart(2,"0")}-${d.padStart(2,"0")}`;
    const volNum = vol.endsWith("M") ? parseFloat(vol) * 1e6 : vol.endsWith("K") ? parseFloat(vol) * 1e3 : parseFloat(vol) || 0;
    return { date: iso, close: parseFloat(price), open: parseFloat(open), high: parseFloat(high), low: parseFloat(low), volume: volNum };
  });
  rows.sort((a, b) => a.date.localeCompare(b.date)); // oldest first
  return rows;
}

export function sma(arr, n) {
  if (arr.length < n) return null;
  return arr.slice(-n).reduce((a, b) => a + b, 0) / n;
}

export function emaSeries(arr, n) {
  if (arr.length < n) return [];
  const k = 2 / (n + 1);
  const out = new Array(arr.length).fill(null);
  let prev = arr.slice(0, n).reduce((a, b) => a + b, 0) / n;
  out[n - 1] = prev;
  for (let i = n; i < arr.length; i++) {
    prev = arr[i] * k + prev * (1 - k);
    out[i] = prev;
  }
  return out;
}

export function computeMACD(closes) {
  if (closes.length < 26) return null;
  const ema12 = emaSeries(closes, 12);
  const ema26 = emaSeries(closes, 26);
  const macdLine = [];
  for (let i = 0; i < closes.length; i++) {
    if (ema12[i] != null && ema26[i] != null) macdLine.push(ema12[i] - ema26[i]);
  }
  if (macdLine.length < 9) return { macd: macdLine[macdLine.length-1], signal: null, histogram: null, histogramPrev: null };
  const signalSeries = emaSeries(macdLine, 9);
  const signal = signalSeries[signalSeries.length - 1];
  const signalPrev = signalSeries[signalSeries.length - 2];
  const macd = macdLine[macdLine.length - 1];
  const macdPrev = macdLine[macdLine.length - 2];
  return {
    macd, signal,
    histogram: macd - signal,
    histogramPrev: macdPrev - signalPrev,
    crossed: (macdPrev - signalPrev < 0 && macd - signal > 0) ? "bullish" : (macdPrev - signalPrev > 0 && macd - signal < 0) ? "bearish" : null,
  };
}

export function computeOBV(rows) {
  let obv = 0;
  const series = [0];
  for (let i = 1; i < rows.length; i++) {
    if (rows[i].close > rows[i - 1].close) obv += rows[i].volume;
    else if (rows[i].close < rows[i - 1].close) obv -= rows[i].volume;
    series.push(obv);
  }
  return series;
}

export function computeATR(rows, n = 14) {
  if (rows.length < n + 1) return null;
  const trs = [];
  for (let i = 1; i < rows.length; i++) {
    const h = rows[i].high, l = rows[i].low, pc = rows[i - 1].close;
    trs.push(Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc)));
  }
  return trs.slice(-n).reduce((a, b) => a + b, 0) / n;
}

// Real swing high/low detection: a local extremum vs its N neighbors on
// each side (not just the single max/min of the window, which degenerates
// to the 52-week-high/low bug this whole pass exists to fix).
export function findSwings(rows, lookback = 3) {
  const highs = [], lows = [];
  for (let i = lookback; i < rows.length - lookback; i++) {
    const windowH = rows.slice(i - lookback, i + lookback + 1).map(r => r.high);
    const windowL = rows.slice(i - lookback, i + lookback + 1).map(r => r.low);
    if (rows[i].high === Math.max(...windowH)) highs.push({ date: rows[i].date, price: rows[i].high });
    if (rows[i].low === Math.min(...windowL)) lows.push({ date: rows[i].date, price: rows[i].low });
  }
  return { highs, lows };
}

// Wilder's smoothed RSI - the actual standard used by TradingView and
// investing.com. Added Sept 8 2026 after an independent re-derivation found
// every stored `rsi` in this project had been computed with a crude
// average-of-the-last-14-changes instead, drifting up to 19 points off on
// 14 of 24 tickers (validated against investing.com's own PHDC RSI(14)
// reading of 49.18: Wilder gave 47.3, the crude version gave 34.2).
// RSI feeds both scoring rubrics, so a wrong RSI silently corrupts scores -
// always use this, never re-roll a simple-average version.
export function rsiWilder(closes, period = 14) {
  if (!closes || closes.length < period + 1) return null;
  let gain = 0, loss = 0;
  for (let i = 1; i <= period; i++) {
    const d = closes[i] - closes[i - 1];
    if (d > 0) gain += d; else loss -= d;
  }
  let avgGain = gain / period, avgLoss = loss / period;
  for (let i = period + 1; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    avgGain = (avgGain * (period - 1) + (d > 0 ? d : 0)) / period;
    avgLoss = (avgLoss * (period - 1) + (d < 0 ? -d : 0)) / period;
  }
  if (avgLoss === 0) return 100;
  return 100 - 100 / (1 + avgGain / avgLoss);
}

// The RSI-health component of holdingScore, per CLAUDE.md's rubric.
// *** THE 40-65 BAND IS MEASURED WRONG. CORRECTED 2026-09-19. ***
//
// This rubric scored RSI 40-65 highest and anything over 70 lowest, on the
// belief that a high RSI means "overextended, wait for a pullback". Measured
// over our own ten years, uptrends only, forward 20 sessions:
//
//   RSI 40-65 (scored 15 here)   2.88%   53% positive   n=36,103
//   RSI 70-80 (scored  4 here)   3.64%   50% positive   n= 5,410
//   RSI 80+   (scored  4 here)   3.77%   42% positive   n= 2,744
//
// The band this function rewarded returns LESS than the band it punished. Two
// real opportunities (EMFD, MFPC) were rejected on that rule alone.
//
// The honest correction is not to flip it - the win RATE up there really is
// lower (42-50% vs 53%), so high RSI is higher return with less consistency.
// What was wrong was treating >70 as a DISQUALIFIER. It is now flat above 40.
//
// ALSO: nothing in this repo imports this function. It was decoration carrying
// a wrong rule, which is the worst combination - see CLAUDE.md rule 3. The
// executable version of the "is this dip buyable" question now lives in
// lib/trend-filter.mjs dipBuyable(), which is measured and IS imported.
export function rsiHealthPoints(rsi) {
  if (rsi == null) return 0;
  if (rsi >= 40) return 15;                      // no upper penalty - measured above
  if (rsi >= 35) return 9;
  return 4;                                       // genuinely weak, below 35
}
