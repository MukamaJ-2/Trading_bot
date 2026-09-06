import { Candle, StrategySignal } from "./types";

export function simpleMovingAverage(candles: Candle[], period: number): number | null {
  if (candles.length < period) return null;
  const window = candles.slice(candles.length - period);
  const sum = window.reduce((acc, c) => acc + c.close, 0);
  return sum / period;
}

/**
 * Evaluates the fast/slow MA crossover on the two most recent completed candles.
 * `candles` must be in ascending time order and end at the most recent completed candle.
 */
export function computeSignal(
  candles: Candle[],
  fastPeriod: number,
  slowPeriod: number
): StrategySignal {
  const latest = candles[candles.length - 1];

  if (candles.length < slowPeriod + 1) {
    return {
      action: "HOLD",
      reason: `Not enough candles for a ${slowPeriod}-period slow MA yet (have ${candles.length}).`,
      fastMA: null,
      slowMA: null,
      price: latest.close,
      candleTime: latest.closeTime,
    };
  }

  const previousCandles = candles.slice(0, candles.length - 1);
  const fastMA = simpleMovingAverage(candles, fastPeriod);
  const slowMA = simpleMovingAverage(candles, slowPeriod);
  const prevFastMA = simpleMovingAverage(previousCandles, fastPeriod);
  const prevSlowMA = simpleMovingAverage(previousCandles, slowPeriod);

  if (fastMA === null || slowMA === null || prevFastMA === null || prevSlowMA === null) {
    return {
      action: "HOLD",
      reason: "Not enough candle history to compute both moving averages.",
      fastMA,
      slowMA,
      price: latest.close,
      candleTime: latest.closeTime,
    };
  }

  const wasBelow = prevFastMA <= prevSlowMA;
  const isAbove = fastMA > slowMA;
  const wasAbove = prevFastMA >= prevSlowMA;
  const isBelow = fastMA < slowMA;

  if (wasBelow && isAbove) {
    return {
      action: "BUY",
      reason: `Fast MA (${fastMA.toFixed(2)}) crossed above slow MA (${slowMA.toFixed(2)}) - bullish crossover.`,
      fastMA,
      slowMA,
      price: latest.close,
      candleTime: latest.closeTime,
    };
  }

  if (wasAbove && isBelow) {
    return {
      action: "SELL",
      reason: `Fast MA (${fastMA.toFixed(2)}) crossed below slow MA (${slowMA.toFixed(2)}) - bearish crossover.`,
      fastMA,
      slowMA,
      price: latest.close,
      candleTime: latest.closeTime,
    };
  }

  return {
    action: "HOLD",
    reason: `No fresh crossover. Fast MA ${fastMA.toFixed(2)} vs slow MA ${slowMA.toFixed(2)}.`,
    fastMA,
    slowMA,
    price: latest.close,
    candleTime: latest.closeTime,
  };
}
