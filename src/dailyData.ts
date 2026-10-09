import * as fs from "fs";
import { Candle } from "./types";
import { fetchCandles } from "./market";

const DAY_MS = 24 * 3600 * 1000;

/** Drops the still-forming candle: signals are only ever computed on CLOSED candles. */
export function closedOnly(candles: Candle[], nowMs = Date.now()): Candle[] {
  return candles.filter((c) => c.closeTime < nowMs);
}

/**
 * Sanity-checks a daily series. Any problem throws - the daily bot treats that as "halt and
 * alert", never as something to paper over.
 */
export function validateDaily(candles: Candle[]): void {
  if (candles.length === 0) throw new Error("No daily candles returned.");
  for (let i = 0; i < candles.length; i++) {
    const c = candles[i];
    const nums = [c.open, c.high, c.low, c.close];
    if (!nums.every((x) => Number.isFinite(x) && x > 0)) {
      throw new Error(`Bad candle at ${new Date(c.openTime).toISOString()}: ${JSON.stringify(c)}`);
    }
    if (c.high < Math.max(c.open, c.close) || c.low > Math.min(c.open, c.close)) {
      throw new Error(`Inconsistent OHLC at ${new Date(c.openTime).toISOString()}.`);
    }
    if (i > 0) {
      const gap = c.openTime - candles[i - 1].openTime;
      if (gap <= 0) throw new Error(`Candles out of order at ${new Date(c.openTime).toISOString()}.`);
    }
  }
}

/** Counts missing calendar days (crypto trades 24/7, so a daily gap means a data problem). */
export function countDailyGaps(candles: Candle[]): number {
  let gaps = 0;
  for (let i = 1; i < candles.length; i++) {
    const missing = Math.round((candles[i].openTime - candles[i - 1].openTime) / DAY_MS) - 1;
    if (missing > 0) gaps += missing;
  }
  return gaps;
}

/** Resamples daily candles into weekly candles starting Monday 00:00 UTC (TradingView's weekly). */
export function toWeekly(daily: Candle[]): Candle[] {
  const weeks = new Map<number, Candle>();
  for (const d of daily) {
    const date = new Date(d.openTime);
    const dow = (date.getUTCDay() + 6) % 7; // Monday = 0
    const weekStart = Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()) - dow * DAY_MS;
    const w = weeks.get(weekStart);
    if (!w) {
      weeks.set(weekStart, { ...d, openTime: weekStart, closeTime: weekStart + 7 * DAY_MS - 1 });
    } else {
      w.high = Math.max(w.high, d.high);
      w.low = Math.min(w.low, d.low);
      w.close = d.close;
      w.volume += d.volume;
    }
  }
  return [...weeks.values()].sort((a, b) => a.openTime - b.openTime);
}

/**
 * Loads OHLC candles from a CSV, e.g. a TradingView "Export chart data" file. Needs a header
 * row with time/open/high/low/close columns (volume optional). `time` may be unix seconds,
 * unix milliseconds, or an ISO date.
 */
export function loadCsvCandles(path: string): Candle[] {
  return parseCsvCandles(fs.readFileSync(path, "utf8"), path);
}

/** Same as loadCsvCandles, for CSV text already in memory (e.g. uploaded through the UI). */
export function parseCsvCandles(text: string, path = "uploaded CSV"): Candle[] {
  const lines = text.split(/\r?\n/).filter((l) => l.trim());
  if (lines.length < 2) throw new Error(`${path} has no data rows.`);
  const header = lines[0].toLowerCase().split(",").map((h) => h.trim().replace(/"/g, ""));
  const col = (name: string) => header.indexOf(name);
  const [ti, oi, hi, li, ci, vi] = ["time", "open", "high", "low", "close", "volume"].map(col);
  if ([ti, oi, hi, li, ci].some((x) => x < 0)) {
    throw new Error(`CSV ${path} needs time,open,high,low,close columns; found: ${header.join(",")}`);
  }
  const candles = lines.slice(1).map((line) => {
    const f = line.split(",").map((x) => x.trim().replace(/"/g, ""));
    const raw = f[ti];
    const asNum = Number(raw);
    const t = Number.isFinite(asNum) ? (asNum < 1e12 ? asNum * 1000 : asNum) : Date.parse(raw);
    if (!Number.isFinite(t)) throw new Error(`Unparseable time "${raw}" in ${path}`);
    return {
      openTime: t,
      open: Number(f[oi]),
      high: Number(f[hi]),
      low: Number(f[li]),
      close: Number(f[ci]),
      volume: vi >= 0 ? Number(f[vi]) || 0 : 0,
      closeTime: t,
    };
  });
  candles.sort((a, b) => a.openTime - b.openTime);
  // Bar length = the most common spacing between rows (daily or weekly exports both work).
  const gaps = candles.slice(1).map((c, i) => c.openTime - candles[i].openTime).sort((a, b) => a - b);
  const barMs = gaps.length ? gaps[Math.floor(gaps.length / 2)] : DAY_MS;
  for (const c of candles) c.closeTime = c.openTime + barMs - 1;
  return candles;
}

export interface LoadOptions {
  symbol: string;
  days: number;
  timeframe: "1d" | "1w";
  csv?: string;
  /** CSV contents, used instead of `csv` (a path) when given. */
  csvText?: string;
}

// Short-lived cache so an interactive session doesn't refetch the same history every click.
const CACHE_MS = 10 * 60 * 1000;
const cache = new Map<string, { at: number; candles: Candle[] }>();

async function fetchDailyCached(symbol: string, days: number): Promise<Candle[]> {
  const key = `${symbol}:${days}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.candles;
  const candles = closedOnly(await fetchCandles(symbol, "1d", days + 1));
  cache.set(key, { at: Date.now(), candles });
  return candles;
}

/** Real daily (or weekly, resampled from daily) CLOSED candles, from the market API or a CSV. */
export async function loadCandles(o: LoadOptions): Promise<Candle[]> {
  let daily: Candle[];
  if (o.csv || o.csvText) {
    const rows = o.csvText !== undefined ? parseCsvCandles(o.csvText) : loadCsvCandles(o.csv as string);
    validateDaily(rows);
    const isDaily = rows.length < 2 || rows[0].closeTime - rows[0].openTime < 2 * DAY_MS;
    return closedOnly(o.timeframe === "1w" && isDaily ? toWeekly(rows) : rows);
  }
  daily = await fetchDailyCached(o.symbol, o.days);
  validateDaily(daily);
  if (o.timeframe === "1w") return closedOnly(toWeekly(daily));
  return daily;
}
