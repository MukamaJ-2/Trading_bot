import * as fs from "fs";
import { Candle } from "./types";
import { fetchCandles } from "./market";
import { closedOnly, parseCsvCandles, prepareCsvCandles, toWeekly, validateDaily } from "./candles";

export { closedOnly, countDailyGaps, parseCsvCandles, toWeekly, validateDaily } from "./candles";

/** Loads OHLC candles from a CSV file (see parseCsvCandles for the format). */
export function loadCsvCandles(path: string): Candle[] {
  return parseCsvCandles(fs.readFileSync(path, "utf8"), path);
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
  if (o.csv || o.csvText) {
    const rows = o.csvText !== undefined ? parseCsvCandles(o.csvText) : loadCsvCandles(o.csv as string);
    return prepareCsvCandles(rows, o.timeframe);
  }
  const daily = await fetchDailyCached(o.symbol, o.days);
  validateDaily(daily);
  if (o.timeframe === "1w") return closedOnly(toWeekly(daily));
  return daily;
}
