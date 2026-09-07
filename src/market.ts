import { Candle } from "./types";
import { config } from "./config";
import { fetchCoinbaseCandles } from "./marketCoinbase";
import { fetchAlpacaCandles } from "./marketAlpaca";

/**
 * Dispatches to the configured market data provider. Coinbase is the default (needs no
 * API key at all); Alpaca is opt-in via MARKET_DATA_PROVIDER=alpaca. Both are read-only -
 * neither this module nor either provider ever calls an order-placement endpoint.
 */
export async function fetchCandles(symbol: string, interval: string, limit: number): Promise<Candle[]> {
  switch (config.marketDataProvider) {
    case "alpaca":
      return fetchAlpacaCandles(symbol, interval, limit);
    case "coinbase":
      return fetchCoinbaseCandles(symbol, interval, limit);
    default:
      throw new Error(
        `Unknown MARKET_DATA_PROVIDER "${config.marketDataProvider}". Supported: coinbase, alpaca.`
      );
  }
}
