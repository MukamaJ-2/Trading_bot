import { Candle } from "./types";
import { config } from "./config";

/**
 * Alpaca market-data-only adapter. Unlike Coinbase, Alpaca's data API requires an API
 * key/secret even for read-only market data - this module never places, previews, or
 * cancels an order, and there is no code path here that could. Keys come only from
 * ALPACA_API_KEY_ID / ALPACA_API_SECRET_KEY (local .env or GitHub Actions secrets) -
 * never hardcoded, never logged, never requested in chat.
 */
const TIMEFRAME: Record<string, string> = {
  "1m": "1Min",
  "5m": "5Min",
  "15m": "15Min",
  "1h": "1Hour",
  "6h": "6Hour",
  "1d": "1Day",
};

const INTERVAL_SECONDS: Record<string, number> = {
  "1m": 60,
  "5m": 300,
  "15m": 900,
  "1h": 3600,
  "6h": 21600,
  "1d": 86400,
};

const MAX_REQUESTS = 20;
const PAGE_LIMIT = 1000;

interface AlpacaBar {
  t: string; // RFC3339 timestamp, start of the bar
  o: number;
  h: number;
  l: number;
  c: number;
  v: number;
}

function isCryptoSymbol(symbol: string): boolean {
  return symbol.includes("/");
}

function authHeaders(): Record<string, string> {
  if (!config.alpacaKeyId || !config.alpacaSecretKey) {
    throw new Error(
      "MARKET_DATA_PROVIDER=alpaca requires ALPACA_API_KEY_ID and ALPACA_API_SECRET_KEY " +
        "(local .env, or GitHub Actions secrets - never pasted into chat or committed to the repo)."
    );
  }
  return {
    "APCA-API-KEY-ID": config.alpacaKeyId,
    "APCA-API-SECRET-KEY": config.alpacaSecretKey,
  };
}

async function fetchPage(url: string): Promise<Response> {
  const headers = authHeaders(); // throws its own clear error if keys are missing
  let response: Response;
  try {
    response = await fetch(url, { headers });
  } catch (err) {
    throw new Error(`Failed to reach Alpaca market data (${url}): ${(err as Error).message}`);
  }
  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(`Alpaca market data request failed with status ${response.status}: ${body}`);
  }
  return response;
}

async function fetchStockBars(
  symbol: string,
  timeframe: string,
  startIso: string,
  endIso: string,
  limit: number
): Promise<AlpacaBar[]> {
  const bars: AlpacaBar[] = [];
  let pageToken: string | undefined;
  let requests = 0;

  while (bars.length < limit && requests < MAX_REQUESTS) {
    requests++;
    const url =
      `${config.alpacaDataBaseUrl}/v2/stocks/${encodeURIComponent(symbol)}/bars` +
      `?timeframe=${timeframe}&start=${startIso}&end=${endIso}&limit=${PAGE_LIMIT}&adjustment=raw` +
      (pageToken ? `&page_token=${encodeURIComponent(pageToken)}` : "");

    const response = await fetchPage(url);
    const json = (await response.json()) as { bars?: AlpacaBar[]; next_page_token?: string | null };
    bars.push(...(json.bars || []));
    pageToken = json.next_page_token || undefined;
    if (!pageToken) break;
  }

  return bars;
}

async function fetchCryptoBars(
  symbol: string,
  timeframe: string,
  startIso: string,
  endIso: string,
  limit: number
): Promise<AlpacaBar[]> {
  const bars: AlpacaBar[] = [];
  let pageToken: string | undefined;
  let requests = 0;

  while (bars.length < limit && requests < MAX_REQUESTS) {
    requests++;
    const url =
      `${config.alpacaDataBaseUrl}/v1beta3/crypto/us/bars` +
      `?symbols=${encodeURIComponent(symbol)}&timeframe=${timeframe}&start=${startIso}&end=${endIso}&limit=${PAGE_LIMIT}` +
      (pageToken ? `&page_token=${encodeURIComponent(pageToken)}` : "");

    const response = await fetchPage(url);
    const json = (await response.json()) as {
      bars?: Record<string, AlpacaBar[]>;
      next_page_token?: string | null;
    };
    bars.push(...((json.bars && json.bars[symbol]) || []));
    pageToken = json.next_page_token || undefined;
    if (!pageToken) break;
  }

  return bars;
}

/**
 * Fetches real candles from Alpaca's market data API (read-only - no order endpoint is
 * ever called). Symbols containing "/" (e.g. "BTC/USD") use the crypto bars endpoint;
 * anything else (e.g. "AAPL") uses the stock bars endpoint. Never falls back to
 * generated/fixture data - throws a clear error instead, including when the required
 * API keys are missing.
 */
export async function fetchAlpacaCandles(
  symbol: string,
  interval: string,
  limit: number
): Promise<Candle[]> {
  const timeframe = TIMEFRAME[interval];
  const intervalSeconds = INTERVAL_SECONDS[interval];
  if (!timeframe || !intervalSeconds) {
    throw new Error(`Unsupported interval "${interval}". Supported: ${Object.keys(TIMEFRAME).join(", ")}.`);
  }

  const crypto = isCryptoSymbol(symbol);
  // Stocks only trade a few hours a day on weekdays, so look back further than the raw
  // candle count would suggest in order to actually collect `limit` real bars.
  const lookbackMultiplier = crypto ? 1.2 : 6;
  const endMs = Date.now();
  const startMs = endMs - limit * intervalSeconds * 1000 * lookbackMultiplier;

  const bars = crypto
    ? await fetchCryptoBars(symbol, timeframe, new Date(startMs).toISOString(), new Date(endMs).toISOString(), limit)
    : await fetchStockBars(symbol, timeframe, new Date(startMs).toISOString(), new Date(endMs).toISOString(), limit);

  if (bars.length === 0) {
    throw new Error(`No candle data returned by Alpaca for ${symbol} ${interval}. Refusing to fabricate candles.`);
  }

  const ascending = [...bars].sort((a, b) => new Date(a.t).getTime() - new Date(b.t).getTime());
  const trimmed = ascending.slice(Math.max(0, ascending.length - limit));

  return trimmed.map((bar) => {
    const openTime = new Date(bar.t).getTime();
    return {
      openTime,
      open: bar.o,
      high: bar.h,
      low: bar.l,
      close: bar.c,
      volume: bar.v,
      closeTime: openTime + intervalSeconds * 1000 - 1,
    };
  });
}
