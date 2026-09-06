import { Candle } from "./types";
import { config } from "./config";

/**
 * Fetches real candles from Binance's public klines endpoint (no API key required).
 * Never falls back to generated/fixture data — throws a clear error instead.
 */
export async function fetchCandles(
  symbol: string,
  interval: string,
  limit: number
): Promise<Candle[]> {
  const url = `${config.binanceBaseUrl}/api/v3/klines?symbol=${encodeURIComponent(
    symbol
  )}&interval=${encodeURIComponent(interval)}&limit=${limit}`;

  let response: Response;
  try {
    response = await fetch(url);
  } catch (err) {
    throw new Error(
      `Failed to reach Binance public market data endpoint (${url}): ${
        (err as Error).message
      }`
    );
  }

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(
      `Binance klines request failed with status ${response.status}: ${body}`
    );
  }

  const raw = (await response.json()) as unknown[];
  if (!Array.isArray(raw) || raw.length === 0) {
    throw new Error(
      `Binance returned no candle data for ${symbol} ${interval}. Refusing to fabricate candles.`
    );
  }

  return raw.map((row) => {
    const r = row as [
      number,
      string,
      string,
      string,
      string,
      string,
      number,
      string,
      number,
      string,
      string,
      string
    ];
    return {
      openTime: r[0],
      open: Number(r[1]),
      high: Number(r[2]),
      low: Number(r[3]),
      close: Number(r[4]),
      volume: Number(r[5]),
      closeTime: r[6],
    };
  });
}
