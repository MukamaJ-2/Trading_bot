import { Candle } from "./types";

/**
 * Pure, full-series indicator functions for the daily backtest lab and daily bot. Every
 * function returns one value per input bar (null until enough history exists), so the value
 * at index i only ever uses data up to and including bar i - no look-ahead.
 */

export type Series = (number | null)[];

export function sma(values: number[], period: number): Series {
  const out: Series = new Array(values.length).fill(null);
  let sum = 0;
  for (let i = 0; i < values.length; i++) {
    sum += values[i];
    if (i >= period) sum -= values[i - period];
    if (i >= period - 1) out[i] = sum / period;
  }
  return out;
}

/**
 * EMA seeded the same way as TradingView's ta.ema: the first value is the plain average of
 * the first `period` bars, then the standard 2/(period+1) recursion.
 */
export function ema(values: number[], period: number): Series {
  const out: Series = new Array(values.length).fill(null);
  const k = 2 / (period + 1);
  let prev: number | null = null;
  for (let i = 0; i < values.length; i++) {
    if (i < period - 1) continue;
    if (prev === null) {
      let sum = 0;
      for (let j = i - period + 1; j <= i; j++) sum += values[j];
      prev = sum / period;
    } else {
      prev = values[i] * k + prev * (1 - k);
    }
    out[i] = prev;
  }
  return out;
}

/** Wilder's ATR (RMA of true range), matching TradingView's ta.atr. */
export function atr(candles: Candle[], period: number): Series {
  const out: Series = new Array(candles.length).fill(null);
  let prev: number | null = null;
  let seed = 0;
  for (let i = 0; i < candles.length; i++) {
    const c = candles[i];
    const tr =
      i === 0
        ? c.high - c.low
        : Math.max(
            c.high - c.low,
            Math.abs(c.high - candles[i - 1].close),
            Math.abs(c.low - candles[i - 1].close)
          );
    if (i < period - 1) {
      seed += tr;
      continue;
    }
    if (prev === null) {
      prev = (seed + tr) / period;
    } else {
      prev = (prev * (period - 1) + tr) / period;
    }
    out[i] = prev;
  }
  return out;
}

/**
 * Supertrend direction per bar: 1 = uptrend, -1 = downtrend, null = not enough history.
 * Same band-ratcheting logic as TradingView's ta.supertrend.
 */
export function supertrendDirection(candles: Candle[], period: number, multiplier: number): Series {
  const atrs = atr(candles, period);
  const out: Series = new Array(candles.length).fill(null);
  let upper = 0;
  let lower = 0;
  let dir = 0;
  for (let i = 0; i < candles.length; i++) {
    const a = atrs[i];
    if (a === null) continue;
    const c = candles[i];
    const mid = (c.high + c.low) / 2;
    const basicUpper = mid + multiplier * a;
    const basicLower = mid - multiplier * a;
    if (dir === 0) {
      upper = basicUpper;
      lower = basicLower;
      dir = c.close > basicUpper ? 1 : -1;
      out[i] = dir;
      continue;
    }
    const prevClose = candles[i - 1].close;
    const newLower = basicLower > lower || prevClose < lower ? basicLower : lower;
    const newUpper = basicUpper < upper || prevClose > upper ? basicUpper : upper;
    if (dir === -1 && c.close > upper) dir = 1;
    else if (dir === 1 && c.close < lower) dir = -1;
    upper = newUpper;
    lower = newLower;
    out[i] = dir;
  }
  return out;
}

/** Highest high of the `period` bars BEFORE bar i (excludes bar i itself). */
export function priorHighest(candles: Candle[], period: number): Series {
  const out: Series = new Array(candles.length).fill(null);
  for (let i = period; i < candles.length; i++) {
    let h = -Infinity;
    for (let j = i - period; j < i; j++) h = Math.max(h, candles[j].high);
    out[i] = h;
  }
  return out;
}

/** Lowest low of the `period` bars BEFORE bar i (excludes bar i itself). */
export function priorLowest(candles: Candle[], period: number): Series {
  const out: Series = new Array(candles.length).fill(null);
  for (let i = period; i < candles.length; i++) {
    let l = Infinity;
    for (let j = i - period; j < i; j++) l = Math.min(l, candles[j].low);
    out[i] = l;
  }
  return out;
}

/** Wilder's RSI. */
export function rsi(values: number[], period: number): Series {
  const out: Series = new Array(values.length).fill(null);
  if (values.length < period + 1) return out;
  let gain = 0;
  let loss = 0;
  for (let i = 1; i <= period; i++) {
    const d = values[i] - values[i - 1];
    if (d >= 0) gain += d;
    else loss -= d;
  }
  let avgGain = gain / period;
  let avgLoss = loss / period;
  out[period] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
  for (let i = period + 1; i < values.length; i++) {
    const d = values[i] - values[i - 1];
    avgGain = (avgGain * (period - 1) + Math.max(d, 0)) / period;
    avgLoss = (avgLoss * (period - 1) + Math.max(-d, 0)) / period;
    out[i] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
  }
  return out;
}
