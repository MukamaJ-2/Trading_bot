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

/** Exponential moving average over a raw numeric series (prices, or another indicator's series). */
function emaSeries(values: number[], period: number): (number | null)[] {
  const k = 2 / (period + 1);
  const result: (number | null)[] = new Array(values.length).fill(null);
  let prevEma: number | null = null;
  for (let i = 0; i < values.length; i++) {
    if (i < period - 1) continue;
    if (prevEma === null) {
      const seedWindow = values.slice(i - period + 1, i + 1);
      prevEma = seedWindow.reduce((a, b) => a + b, 0) / period;
    } else {
      prevEma = values[i] * k + prevEma * (1 - k);
    }
    result[i] = prevEma;
  }
  return result;
}

/** Wilder's RSI over a close-price series. */
function computeRSISeries(closes: number[], period: number): (number | null)[] {
  const rsi: (number | null)[] = new Array(closes.length).fill(null);
  if (closes.length < period + 1) return rsi;

  let gains = 0;
  let losses = 0;
  for (let i = 1; i <= period; i++) {
    const change = closes[i] - closes[i - 1];
    if (change >= 0) gains += change;
    else losses += -change;
  }
  let avgGain = gains / period;
  let avgLoss = losses / period;
  rsi[period] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);

  for (let i = period + 1; i < closes.length; i++) {
    const change = closes[i] - closes[i - 1];
    const gain = change > 0 ? change : 0;
    const loss = change < 0 ? -change : 0;
    avgGain = (avgGain * (period - 1) + gain) / period;
    avgLoss = (avgLoss * (period - 1) + loss) / period;
    rsi[i] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
  }
  return rsi;
}

export interface ConfirmationParams {
  trendPeriod: number;
  volumeLookback: number;
  volumeMultiplier: number;
  macdFastPeriod: number;
  macdSlowPeriod: number;
  macdSignalPeriod: number;
  rsiPeriod: number;
  rsiOversold: number;
  rsiOverbought: number;
  fibLookback: number;
  fibLevel: number;
  bollingerPeriod: number;
  bollingerStdDev: number;
}

function holdSignal(latest: Candle, reason: string, fastMA: number | null = null, slowMA: number | null = null): StrategySignal {
  return { action: "HOLD", reason, fastMA, slowMA, price: latest.close, candleTime: latest.closeTime };
}

/**
 * Strategy 1 - MA crossover, confirmed by trend + volume (see module doc for the full rule set).
 * A raw fast/slow crossover only becomes a real BUY/SELL if price is also on the right side of
 * the trend MA and volume is a real spike, not noise. `candles` must be in ascending time order
 * and end at the most recent completed candle.
 */
function computeMaCrossoverSignal(
  candles: Candle[],
  fastPeriod: number,
  slowPeriod: number,
  confirmation: ConfirmationParams
): StrategySignal {
  const latest = candles[candles.length - 1];
  const minCandles = Math.max(slowPeriod, confirmation.trendPeriod, confirmation.volumeLookback) + 1;

  if (candles.length < minCandles) {
    return holdSignal(latest, `Not enough candles for the MA strategy's confirmation filters yet (need ${minCandles}, have ${candles.length}).`);
  }

  const previousCandles = candles.slice(0, candles.length - 1);
  const fastMA = simpleMovingAverage(candles, fastPeriod);
  const slowMA = simpleMovingAverage(candles, slowPeriod);
  const prevFastMA = simpleMovingAverage(previousCandles, fastPeriod);
  const prevSlowMA = simpleMovingAverage(previousCandles, slowPeriod);

  if (fastMA === null || slowMA === null || prevFastMA === null || prevSlowMA === null) {
    return holdSignal(latest, "Not enough candle history to compute both moving averages.", fastMA, slowMA);
  }

  const wasBelow = prevFastMA <= prevSlowMA;
  const isAbove = fastMA > slowMA;
  const wasAbove = prevFastMA >= prevSlowMA;
  const isBelow = fastMA < slowMA;
  const crossoverAction: "BUY" | "SELL" | null = wasBelow && isAbove ? "BUY" : wasAbove && isBelow ? "SELL" : null;

  if (!crossoverAction) {
    return holdSignal(latest, `No fresh crossover. Fast MA ${fastMA.toFixed(2)} vs slow MA ${slowMA.toFixed(2)}.`, fastMA, slowMA);
  }

  const trendMA = simpleMovingAverage(candles, confirmation.trendPeriod);
  if (trendMA === null) {
    return holdSignal(
      latest,
      `${crossoverAction} crossover found, but not enough candles for the ${confirmation.trendPeriod}-period trend filter.`,
      fastMA,
      slowMA
    );
  }

  const trendAligned = crossoverAction === "BUY" ? latest.close > trendMA : latest.close < trendMA;
  if (!trendAligned) {
    return holdSignal(
      latest,
      `${crossoverAction} crossover found (fast ${fastMA.toFixed(2)} / slow ${slowMA.toFixed(
        2
      )}), but rejected by the trend filter: price ${latest.close.toFixed(2)} is ${
        crossoverAction === "BUY" ? "not above" : "not below"
      } the ${confirmation.trendPeriod}-period trend MA (${trendMA.toFixed(2)}).`,
      fastMA,
      slowMA
    );
  }

  const avgVolume = averageVolume(previousCandles, confirmation.volumeLookback);
  if (avgVolume === null || avgVolume === 0) {
    return holdSignal(
      latest,
      `${crossoverAction} crossover found and trend-aligned, but not enough volume history for the ${confirmation.volumeLookback}-candle volume filter.`,
      fastMA,
      slowMA
    );
  }

  const volumeRatio = latest.volume / avgVolume;
  if (volumeRatio < confirmation.volumeMultiplier) {
    return holdSignal(
      latest,
      `${crossoverAction} crossover found and trend-aligned, but rejected by the volume filter: volume ${latest.volume.toFixed(
        2
      )} is only ${volumeRatio.toFixed(2)}x the ${confirmation.volumeLookback}-candle average (need ${
        confirmation.volumeMultiplier
      }x).`,
      fastMA,
      slowMA
    );
  }

  return {
    action: crossoverAction,
    reason: `MA ${crossoverAction} crossover confirmed: fast MA (${fastMA.toFixed(2)}) crossed ${
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

/**
 * Strategy 2 - MACD line crossing its signal line, confirmed by trend + volume the same way as
 * the MA crossover strategy. Catches trend shifts the 9/21 MA crossover is too slow (or too
 * strict) to see.
 */
function computeMacdCrossoverSignal(candles: Candle[], confirmation: ConfirmationParams): StrategySignal {
  const latest = candles[candles.length - 1];
  const { macdFastPeriod, macdSlowPeriod, macdSignalPeriod, trendPeriod, volumeLookback, volumeMultiplier } = confirmation;
  const minCandles = macdSlowPeriod + macdSignalPeriod + Math.max(trendPeriod, volumeLookback) + 2;

  if (candles.length < minCandles) {
    return holdSignal(latest, `Not enough candles for the MACD strategy yet (need ~${minCandles}, have ${candles.length}).`);
  }

  const closes = candles.map((c) => c.close);
  const fastEma = emaSeries(closes, macdFastPeriod);
  const slowEma = emaSeries(closes, macdSlowPeriod);
  const macdLine: (number | null)[] = closes.map((_, i) =>
    fastEma[i] !== null && slowEma[i] !== null ? (fastEma[i] as number) - (slowEma[i] as number) : null
  );

  const compactMacd: number[] = [];
  macdLine.forEach((v) => {
    if (v !== null) compactMacd.push(v);
  });

  if (compactMacd.length < macdSignalPeriod + 1) {
    return holdSignal(latest, "Not enough MACD history yet for the signal line.");
  }

  const signalCompact = emaSeries(compactMacd, macdSignalPeriod);
  const lastPos = compactMacd.length - 1;
  const prevPos = lastPos - 1;

  const macdNow = compactMacd[lastPos];
  const macdPrev = compactMacd[prevPos];
  const signalNow = signalCompact[lastPos];
  const signalPrev = signalCompact[prevPos];

  if (signalNow === null || signalPrev === null) {
    return holdSignal(latest, "Not enough MACD signal-line history yet.");
  }

  const wasBelow = macdPrev <= signalPrev;
  const isAbove = macdNow > signalNow;
  const wasAbove = macdPrev >= signalPrev;
  const isBelow = macdNow < signalNow;
  const crossoverAction: "BUY" | "SELL" | null = wasBelow && isAbove ? "BUY" : wasAbove && isBelow ? "SELL" : null;

  if (!crossoverAction) {
    return holdSignal(latest, `No fresh MACD crossover. MACD ${macdNow.toFixed(2)} vs signal ${signalNow.toFixed(2)}.`);
  }

  const trendMA = simpleMovingAverage(candles, trendPeriod);
  if (trendMA === null) {
    return holdSignal(latest, `MACD ${crossoverAction} crossover found, but not enough candles for the trend filter.`);
  }

  const trendAligned = crossoverAction === "BUY" ? latest.close > trendMA : latest.close < trendMA;
  if (!trendAligned) {
    return holdSignal(
      latest,
      `MACD ${crossoverAction} crossover found, but rejected by the trend filter: price ${latest.close.toFixed(
        2
      )} vs trend MA ${trendMA.toFixed(2)}.`
    );
  }

  const previousCandles = candles.slice(0, candles.length - 1);
  const avgVolume = averageVolume(previousCandles, volumeLookback);
  if (avgVolume === null || avgVolume === 0) {
    return holdSignal(latest, `MACD ${crossoverAction} crossover found and trend-aligned, but not enough volume history.`);
  }

  const volumeRatio = latest.volume / avgVolume;
  if (volumeRatio < volumeMultiplier) {
    return holdSignal(
      latest,
      `MACD ${crossoverAction} crossover found and trend-aligned, but rejected by the volume filter (${volumeRatio.toFixed(
        2
      )}x < ${volumeMultiplier}x required).`
    );
  }

  return {
    action: crossoverAction,
    reason: `MACD ${crossoverAction} crossover confirmed: MACD (${macdNow.toFixed(2)}) crossed ${
      crossoverAction === "BUY" ? "above" : "below"
    } its signal line (${signalNow.toFixed(2)}), price is ${
      crossoverAction === "BUY" ? "above" : "below"
    } the ${trendPeriod}-period trend MA, and volume is ${volumeRatio.toFixed(2)}x the recent average (>= ${volumeMultiplier}x required).`,
    fastMA: null,
    slowMA: null,
    price: latest.close,
    candleTime: latest.closeTime,
  };
}

/**
 * Strategy 3 - RSI mean-reversion: a real reversal out of oversold/overbought territory,
 * confirmed by volume (no trend filter here - a reversal signal is, by definition, expected to
 * go against the recent trend).
 */
function computeRsiReversalSignal(candles: Candle[], confirmation: ConfirmationParams): StrategySignal {
  const latest = candles[candles.length - 1];
  const { rsiPeriod, rsiOversold, rsiOverbought, volumeLookback, volumeMultiplier } = confirmation;
  const minCandles = rsiPeriod + Math.max(volumeLookback, 1) + 2;

  if (candles.length < minCandles) {
    return holdSignal(latest, `Not enough candles for the RSI strategy yet (need ~${minCandles}, have ${candles.length}).`);
  }

  const closes = candles.map((c) => c.close);
  const rsiSeries = computeRSISeries(closes, rsiPeriod);
  const rsiNow = rsiSeries[rsiSeries.length - 1];
  const rsiPrev = rsiSeries[rsiSeries.length - 2];

  if (rsiNow === null || rsiPrev === null) {
    return holdSignal(latest, "Not enough RSI history yet.");
  }

  const crossedUpFromOversold = rsiPrev < rsiOversold && rsiNow >= rsiOversold;
  const crossedDownFromOverbought = rsiPrev > rsiOverbought && rsiNow <= rsiOverbought;
  const reversalAction: "BUY" | "SELL" | null = crossedUpFromOversold ? "BUY" : crossedDownFromOverbought ? "SELL" : null;

  if (!reversalAction) {
    return holdSignal(
      latest,
      `No fresh RSI reversal. RSI is ${rsiNow.toFixed(1)} (oversold < ${rsiOversold}, overbought > ${rsiOverbought}).`
    );
  }

  const previousCandles = candles.slice(0, candles.length - 1);
  const avgVolume = averageVolume(previousCandles, volumeLookback);
  if (avgVolume === null || avgVolume === 0) {
    return holdSignal(latest, `RSI ${reversalAction} reversal found (RSI ${rsiNow.toFixed(1)}), but not enough volume history.`);
  }

  const volumeRatio = latest.volume / avgVolume;
  if (volumeRatio < volumeMultiplier) {
    return holdSignal(
      latest,
      `RSI ${reversalAction} reversal found (RSI ${rsiNow.toFixed(1)}), but rejected by the volume filter (${volumeRatio.toFixed(
        2
      )}x < ${volumeMultiplier}x required).`
    );
  }

  return {
    action: reversalAction,
    reason: `RSI ${reversalAction} reversal confirmed: RSI crossed ${
      reversalAction === "BUY" ? "up out of oversold" : "down out of overbought"
    } (${rsiPrev.toFixed(1)} -> ${rsiNow.toFixed(1)}), and volume is ${volumeRatio.toFixed(2)}x the recent average (>= ${volumeMultiplier}x required).`,
    fastMA: null,
    slowMA: null,
    price: latest.close,
    candleTime: latest.closeTime,
  };
}

/**
 * Strategy 4 - Fibonacci retracement bounce/rejection. Finds the swing high and swing low over
 * the lookback window (excluding the current candle, so there's no lookahead), determines
 * whether that window is an up-move or a down-move by which extreme came first, and watches
 * for price touching the golden-ratio retracement level and closing back on the trend side -
 * the classic "buy the dip / sell the rally" continuation setup. Confirmed by volume.
 */
function computeFibonacciSignal(candles: Candle[], confirmation: ConfirmationParams): StrategySignal {
  const latest = candles[candles.length - 1];
  const { fibLookback, fibLevel, volumeLookback, volumeMultiplier } = confirmation;
  const minCandles = fibLookback + Math.max(volumeLookback, 1) + 2;

  if (candles.length < minCandles) {
    return holdSignal(latest, `Not enough candles for the Fibonacci strategy yet (need ~${minCandles}, have ${candles.length}).`);
  }

  const previous = candles[candles.length - 2];
  const window = candles.slice(candles.length - 1 - fibLookback, candles.length - 1);

  let swingHighIdx = 0;
  let swingLowIdx = 0;
  for (let i = 1; i < window.length; i++) {
    if (window[i].high > window[swingHighIdx].high) swingHighIdx = i;
    if (window[i].low < window[swingLowIdx].low) swingLowIdx = i;
  }
  const swingHigh = window[swingHighIdx].high;
  const swingLow = window[swingLowIdx].low;
  const range = swingHigh - swingLow;

  if (range <= 0 || swingHighIdx === swingLowIdx) {
    return holdSignal(latest, "Fibonacci strategy: no real price range in the lookback window.");
  }

  const previousCandles = candles.slice(0, candles.length - 1);
  const avgVolume = averageVolume(previousCandles, volumeLookback);
  const volumeRatio = avgVolume && avgVolume > 0 ? latest.volume / avgVolume : null;

  if (swingLowIdx < swingHighIdx) {
    // Up-move (low came first): watching for a pullback bounce off support.
    const supportLevel = swingHigh - range * fibLevel;
    const touchedAndBounced = previous.low <= supportLevel && latest.close > supportLevel;
    if (!touchedAndBounced) {
      return holdSignal(
        latest,
        `No fresh Fibonacci bounce. Up-move support at ${(fibLevel * 100).toFixed(1)}% retracement is ${supportLevel.toFixed(
          2
        )}, price ${latest.close.toFixed(2)}.`
      );
    }
    if (volumeRatio === null) {
      return holdSignal(latest, `Fibonacci BUY bounce found (support ${supportLevel.toFixed(2)}), but not enough volume history.`);
    }
    if (volumeRatio < volumeMultiplier) {
      return holdSignal(
        latest,
        `Fibonacci BUY bounce found (support ${supportLevel.toFixed(2)}), but rejected by the volume filter (${volumeRatio.toFixed(
          2
        )}x < ${volumeMultiplier}x required).`
      );
    }
    return {
      action: "BUY",
      reason: `Fibonacci BUY bounce confirmed: price touched the ${(fibLevel * 100).toFixed(
        1
      )}% retracement support (${supportLevel.toFixed(2)}) of the recent ${swingLow.toFixed(2)} -> ${swingHigh.toFixed(
        2
      )} up-move and closed back above it, with volume ${volumeRatio.toFixed(2)}x the recent average.`,
      fastMA: null,
      slowMA: null,
      price: latest.close,
      candleTime: latest.closeTime,
    };
  }

  // Down-move (high came first): watching for a bounce rejection at resistance.
  const resistanceLevel = swingLow + range * fibLevel;
  const touchedAndRejected = previous.high >= resistanceLevel && latest.close < resistanceLevel;
  if (!touchedAndRejected) {
    return holdSignal(
      latest,
      `No fresh Fibonacci rejection. Down-move resistance at ${(fibLevel * 100).toFixed(1)}% retracement is ${resistanceLevel.toFixed(
        2
      )}, price ${latest.close.toFixed(2)}.`
    );
  }
  if (volumeRatio === null) {
    return holdSignal(latest, `Fibonacci SELL rejection found (resistance ${resistanceLevel.toFixed(2)}), but not enough volume history.`);
  }
  if (volumeRatio < volumeMultiplier) {
    return holdSignal(
      latest,
      `Fibonacci SELL rejection found (resistance ${resistanceLevel.toFixed(2)}), but rejected by the volume filter (${volumeRatio.toFixed(
        2
      )}x < ${volumeMultiplier}x required).`
    );
  }
  return {
    action: "SELL",
    reason: `Fibonacci SELL rejection confirmed: price touched the ${(fibLevel * 100).toFixed(
      1
    )}% retracement resistance (${resistanceLevel.toFixed(2)}) of the recent ${swingHigh.toFixed(2)} -> ${swingLow.toFixed(
      2
    )} down-move and closed back below it, with volume ${volumeRatio.toFixed(2)}x the recent average.`,
    fastMA: null,
    slowMA: null,
    price: latest.close,
    candleTime: latest.closeTime,
  };
}

/**
 * Strategy 5 - Bollinger Bands mean-reversion: price touching the lower/upper band (mean +/-
 * `bollingerStdDev` standard deviations over `bollingerPeriod` candles) on the prior candle and
 * closing back inside the band on this one - a real reversion, not a break. Confirmed by
 * volume only, same reasoning as the RSI strategy.
 */
function computeBollingerBandSignal(candles: Candle[], confirmation: ConfirmationParams): StrategySignal {
  const latest = candles[candles.length - 1];
  const { bollingerPeriod, bollingerStdDev, volumeLookback, volumeMultiplier } = confirmation;
  const minCandles = bollingerPeriod + Math.max(volumeLookback, 1) + 2;

  if (candles.length < minCandles) {
    return holdSignal(latest, `Not enough candles for the Bollinger Bands strategy yet (need ~${minCandles}, have ${candles.length}).`);
  }

  const window = candles.slice(candles.length - 1 - bollingerPeriod, candles.length - 1);
  const closes = window.map((c) => c.close);
  const mean = closes.reduce((a, b) => a + b, 0) / closes.length;
  const variance = closes.reduce((a, b) => a + (b - mean) ** 2, 0) / closes.length;
  const stdDev = Math.sqrt(variance);
  const upperBand = mean + bollingerStdDev * stdDev;
  const lowerBand = mean - bollingerStdDev * stdDev;

  const previous = candles[candles.length - 2];
  const touchedLower = previous.low <= lowerBand && latest.close > lowerBand;
  const touchedUpper = previous.high >= upperBand && latest.close < upperBand;
  const reversalAction: "BUY" | "SELL" | null = touchedLower ? "BUY" : touchedUpper ? "SELL" : null;

  if (!reversalAction) {
    return holdSignal(
      latest,
      `No fresh Bollinger Band reversal. Bands are ${lowerBand.toFixed(2)} - ${upperBand.toFixed(2)}, price ${latest.close.toFixed(2)}.`
    );
  }

  const previousCandles = candles.slice(0, candles.length - 1);
  const avgVolume = averageVolume(previousCandles, volumeLookback);
  if (avgVolume === null || avgVolume === 0) {
    return holdSignal(latest, `Bollinger ${reversalAction} reversal found, but not enough volume history.`);
  }
  const volumeRatio = latest.volume / avgVolume;
  if (volumeRatio < volumeMultiplier) {
    return holdSignal(
      latest,
      `Bollinger ${reversalAction} reversal found, but rejected by the volume filter (${volumeRatio.toFixed(2)}x < ${volumeMultiplier}x required).`
    );
  }

  return {
    action: reversalAction,
    reason: `Bollinger Band ${reversalAction} reversal confirmed: price touched the ${
      reversalAction === "BUY" ? "lower" : "upper"
    } band (${(reversalAction === "BUY" ? lowerBand : upperBand).toFixed(2)}) and closed back ${
      reversalAction === "BUY" ? "above" : "below"
    } it, with volume ${volumeRatio.toFixed(2)}x the recent average.`,
    fastMA: null,
    slowMA: null,
    price: latest.close,
    candleTime: latest.closeTime,
  };
}

/**
 * Evaluates five independent, confirmed strategies in order - MA crossover, MACD crossover,
 * RSI mean-reversion, Fibonacci retracement, Bollinger Bands - and returns the first real
 * BUY/SELL any of them produces. Each strategy requires its own trend/volume confirmation
 * before it counts as a signal (see the individual functions above), so this stays "fewer,
 * higher-conviction trades" while giving the bot more real ways to find one, instead of only
 * ever waiting on a single 9/21 MA crossover. If all five come back HOLD, the combined reason
 * reports why each one did. `candles` must be in ascending time order and end at the most
 * recent completed candle.
 */
export function computeSignal(
  candles: Candle[],
  fastPeriod: number,
  slowPeriod: number,
  confirmation: ConfirmationParams
): StrategySignal {
  const maSignal = computeMaCrossoverSignal(candles, fastPeriod, slowPeriod, confirmation);
  if (maSignal.action !== "HOLD") return maSignal;

  const macdSignal = computeMacdCrossoverSignal(candles, confirmation);
  if (macdSignal.action !== "HOLD") return macdSignal;

  const rsiSignal = computeRsiReversalSignal(candles, confirmation);
  if (rsiSignal.action !== "HOLD") return rsiSignal;

  const fibSignal = computeFibonacciSignal(candles, confirmation);
  if (fibSignal.action !== "HOLD") return fibSignal;

  const bollingerSignal = computeBollingerBandSignal(candles, confirmation);
  if (bollingerSignal.action !== "HOLD") return bollingerSignal;

  return {
    action: "HOLD",
    reason: `No confirmed signal from any strategy. MA: ${maSignal.reason} | MACD: ${macdSignal.reason} | RSI: ${rsiSignal.reason} | Fibonacci: ${fibSignal.reason} | Bollinger: ${bollingerSignal.reason}`,
    fastMA: maSignal.fastMA,
    slowMA: maSignal.slowMA,
    price: maSignal.price,
    candleTime: maSignal.candleTime,
  };
}
