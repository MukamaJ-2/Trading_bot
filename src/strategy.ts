import { Candle, StrategySignal } from "./types";

export function simpleMovingAverage(candles: Candle[], period: number): number | null {
  if (candles.length < period) return null;
  const window = candles.slice(candles.length - period);
  const sum = window.reduce((acc, c) => acc + c.close, 0);
  return sum / period;
}

function averageVolume(candles: Candle[], period: number): number | null {
  if (candles.length < period) return null;
  const window = candles.slice(candles.length - period);
  const sum = window.reduce((acc, c) => acc + c.volume, 0);
  return sum / period;
}

export interface ConfirmationParams {
  trendPeriod: number;
  volumeLookback: number;
  volumeMultiplier: number;
}

/**
 * Evaluates the fast/slow MA crossover on the two most recent completed candles, then
 * requires two real confirmations before trusting it as a trade signal (fewer, higher-
 * conviction trades rather than acting on every crossover):
 *
 * 1. Trend alignment: a BUY crossover only counts if price is above the longer-period
 *    trend MA (real uptrend context); a SELL crossover only counts if price is below it.
 * 2. Volume confirmation: the crossover candle's volume must be at least
 *    `volumeMultiplier` times the recent average volume - a real move, not noise.
 *
 * A crossover that fails either confirmation becomes HOLD, with the specific reason
 * stated. `candles` must be in ascending time order and end at the most recent completed
 * candle.
 */
export function computeSignal(
  candles: Candle[],
  fastPeriod: number,
  slowPeriod: number,
  confirmation: ConfirmationParams
): StrategySignal {
  const latest = candles[candles.length - 1];
  const minCandles = Math.max(slowPeriod, confirmation.trendPeriod, confirmation.volumeLookback) + 1;

  if (candles.length < minCandles) {
    return {
      action: "HOLD",
      reason: `Not enough candles for the strategy's confirmation filters yet (need ${minCandles}, have ${candles.length}).`,
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

  const crossoverAction: "BUY" | "SELL" | null = wasBelow && isAbove ? "BUY" : wasAbove && isBelow ? "SELL" : null;

  if (!crossoverAction) {
    return {
      action: "HOLD",
      reason: `No fresh crossover. Fast MA ${fastMA.toFixed(2)} vs slow MA ${slowMA.toFixed(2)}.`,
      fastMA,
      slowMA,
      price: latest.close,
      candleTime: latest.closeTime,
    };
  }

  const trendMA = simpleMovingAverage(candles, confirmation.trendPeriod);
  if (trendMA === null) {
    return {
      action: "HOLD",
      reason: `${crossoverAction} crossover found, but not enough candles for the ${confirmation.trendPeriod}-period trend filter.`,
      fastMA,
      slowMA,
      price: latest.close,
      candleTime: latest.closeTime,
    };
  }

  const trendAligned = crossoverAction === "BUY" ? latest.close > trendMA : latest.close < trendMA;
  if (!trendAligned) {
    return {
      action: "HOLD",
      reason: `${crossoverAction} crossover found (fast ${fastMA.toFixed(2)} / slow ${slowMA.toFixed(
        2
      )}), but rejected by the trend filter: price ${latest.close.toFixed(2)} is ${
        crossoverAction === "BUY" ? "not above" : "not below"
      } the ${confirmation.trendPeriod}-period trend MA (${trendMA.toFixed(2)}).`,
      fastMA,
      slowMA,
      price: latest.close,
      candleTime: latest.closeTime,
    };
  }

  const avgVolume = averageVolume(previousCandles, confirmation.volumeLookback);
  if (avgVolume === null || avgVolume === 0) {
    return {
      action: "HOLD",
      reason: `${crossoverAction} crossover found and trend-aligned, but not enough volume history for the ${confirmation.volumeLookback}-candle volume filter.`,
      fastMA,
      slowMA,
      price: latest.close,
      candleTime: latest.closeTime,
    };
  }

  const volumeRatio = latest.volume / avgVolume;
  if (volumeRatio < confirmation.volumeMultiplier) {
    return {
      action: "HOLD",
      reason: `${crossoverAction} crossover found and trend-aligned, but rejected by the volume filter: volume ${latest.volume.toFixed(
        2
      )} is only ${volumeRatio.toFixed(2)}x the ${confirmation.volumeLookback}-candle average (need ${
        confirmation.volumeMultiplier
      }x).`,
      fastMA,
      slowMA,
      price: latest.close,
      candleTime: latest.closeTime,
    };
  }

  return {
    action: crossoverAction,
    reason: `${crossoverAction} crossover confirmed: fast MA (${fastMA.toFixed(2)}) crossed ${
      crossoverAction === "BUY" ? "above" : "below"
    } slow MA (${slowMA.toFixed(2)}), price is ${
      crossoverAction === "BUY" ? "above" : "below"
    } the ${confirmation.trendPeriod}-period trend MA (${trendMA.toFixed(2)}), and volume is ${volumeRatio.toFixed(
      2
    )}x the recent average (>= ${confirmation.volumeMultiplier}x required).`,
    fastMA,
    slowMA,
    price: latest.close,
    candleTime: latest.closeTime,
  };
}
