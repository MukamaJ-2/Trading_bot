import * as dotenv from "dotenv";

dotenv.config();

function num(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export const config = {
  symbol: process.env.SYMBOL || "BTC-USD",
  interval: process.env.INTERVAL || "5m",
  fastPeriod: num("FAST_MA_PERIOD", 9),
  slowPeriod: num("SLOW_MA_PERIOD", 21),
  tradeQuantity: num("TRADE_QUANTITY", 0.01),
  maxPosition: num("MAX_POSITION", 0.05),
  stopLossPct: num("STOP_LOSS_PCT", 2),
  takeProfitPct: num("TAKE_PROFIT_PCT", 4),
  maxDailyLossPct: num("MAX_DAILY_LOSS_PCT", 5),
  scanCandleLimit: num("SCAN_CANDLE_LIMIT", 100),
  replayCandleLimit: num("REPLAY_CANDLE_LIMIT", 1000),
  replayLookaheadCandles: num("REPLAY_LOOKAHEAD_CANDLES", 12),
  marketDataBaseUrl: process.env.MARKET_DATA_BASE_URL || "https://api.exchange.coinbase.com",
};
