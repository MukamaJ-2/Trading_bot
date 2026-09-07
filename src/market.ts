import { Candle } from "./types";
import { config } from "./config";

/**
 * Binance's public API blocks all cloud/datacenter IPs (HTTP 451, citing its own
 * terms of service) - that includes GitHub Actions, Vercel, AWS, and every other
 * standard hosting platform, not just this development sandbox. Coinbase Exchange's
 * public candles endpoint has no such restriction and needs no API key.
 */
const GRANULARITY_SECONDS: Record<string, number> = {
  "1m": 60,
  "5m": 300,
  "15m": 900,
  "1h": 3600,
  "6h": 21600,
  "1d": 86400,
};

const MAX_CANDLES_PER_REQUEST = 300;
const MAX_REQUESTS = 20;

interface CoinbaseCandleRow {
  time: number; // unix seconds, start of the candle
  low: number;
  high: number;
  open: number;
  close: number;
  volume: number;
}

async function fetchBatch(
  symbol: string,
  granularity: number,
  startMs: number,
  endMs: number
): Promise<CoinbaseCandleRow[]> {
  const url = `${config.marketDataBaseUrl}/products/${encodeURIComponent(
    symbol
  )}/candles?start=${new Date(startMs).toISOString()}&end=${new Date(
    endMs
  ).toISOString()}&granularity=${granularity}`;

  let response: Response;
  try {
    response = await fetch(url);
  } catch (err) {
    throw new Error(
      `Failed to reach the public market data endpoint (${url}): ${(err as Error).message}`
    );
  }

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(`Market data request failed with status ${response.status}: ${body}`);
  }

  const raw = (await response.json()) as unknown;
  if (!Array.isArray(raw)) {
    throw new Error(
      `Unexpected market data response for ${symbol}. Refusing to fabricate candles.`
    );
  }

  return (raw as number[][]).map((r) => ({
    time: r[0],
    low: r[1],
    high: r[2],
    open: r[3],
    close: r[4],
    volume: r[5],
  }));
}

/**
 * Fetches real candles from Coinbase Exchange's public product-candles endpoint
 * (no API key required), paginating backward in time since the endpoint caps each
 * request at 300 candles. Never falls back to generated/fixture data - throws a
 * clear error instead.
 */
export async function fetchCandles(
  symbol: string,
  interval: string,
  limit: number
): Promise<Candle[]> {
  const granularity = GRANULARITY_SECONDS[interval];
  if (!granularity) {
    throw new Error(
      `Unsupported interval "${interval}". Supported: ${Object.keys(GRANULARITY_SECONDS).join(", ")}.`
    );
  }

  const collected: CoinbaseCandleRow[] = [];
  let windowEndMs = Date.now();
  let requests = 0;

  while (collected.length < limit && requests < MAX_REQUESTS) {
    requests++;
    const batchSize = Math.min(limit - collected.length, MAX_CANDLES_PER_REQUEST);
    const windowStartMs = windowEndMs - batchSize * granularity * 1000;

    const rows = await fetchBatch(symbol, granularity, windowStartMs, windowEndMs);
    if (rows.length === 0) break; // no more history available

    const ascending = [...rows].sort((a, b) => a.time - b.time);
    collected.unshift(...ascending);
    windowEndMs = windowStartMs;

    if (rows.length < batchSize) break; // reached the earliest available data
  }

  if (collected.length === 0) {
    throw new Error(
      `No candle data returned for ${symbol} ${interval}. Refusing to fabricate candles.`
    );
  }

  const trimmed = collected.slice(Math.max(0, collected.length - limit));

  return trimmed.map((row) => ({
    openTime: row.time * 1000,
    open: row.open,
    high: row.high,
    low: row.low,
    close: row.close,
    volume: row.volume,
    closeTime: (row.time + granularity) * 1000 - 1,
  }));
}
