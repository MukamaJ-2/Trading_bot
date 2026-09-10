import { Candle, LedgerRow } from "./types";
import { config } from "./config";
import { fetchCandles } from "./market";
import { computeSignal, ConfirmationParams } from "./strategy";
import { appendLedgerRow, appendLearning, hasAnyMemory, readLearnings, readLedgerRows } from "./memory";
import { applyMemoryFilter } from "./adaptiveFilter";

const CONFIRMATION: ConfirmationParams = {
  trendPeriod: config.trendPeriod,
  volumeLookback: config.volumeLookback,
  volumeMultiplier: config.volumeMultiplier,
  macdFastPeriod: config.macdFastPeriod,
  macdSlowPeriod: config.macdSlowPeriod,
  macdSignalPeriod: config.macdSignalPeriod,
  rsiPeriod: config.rsiPeriod,
  rsiOversold: config.rsiOversold,
  rsiOverbought: config.rsiOverbought,
};

export interface CrossoverEvent {
  index: number;
  timestamp: number;
  action: "BUY" | "SELL";
  entryPrice: number;
}

export interface ReplayTrade extends CrossoverEvent {
  exitIndex: number;
  exitPrice: number;
  pnlPct: number;
  outcome: "WIN" | "LOSS";
}

export interface ReplaySummary {
  totalSetups: number;
  wins: number;
  losses: number;
  winRate: number;
  avgPnlPct: number;
  bestTrade: ReplayTrade | null;
  worstTrade: ReplayTrade | null;
  maxDrawdownPct: number;
}

function log(label: string, message: string): void {
  console.log(`[${new Date().toISOString()}] [${label}] ${message}`);
}

/**
 * Finds every real confirmed BUY/SELL signal in the given candle series, using the exact
 * same trend + volume confirmed-signal logic as live scan/broker-preview (single source of
 * truth - the backtest baseline never diverges from what live trading would have done).
 */
export function detectCrossovers(
  candles: Candle[],
  fastPeriod: number,
  slowPeriod: number
): CrossoverEvent[] {
  const events: CrossoverEvent[] = [];

  for (let i = 0; i < candles.length; i++) {
    const window = candles.slice(0, i + 1);
    const signal = computeSignal(window, fastPeriod, slowPeriod, CONFIRMATION);

    if (signal.action === "BUY" || signal.action === "SELL") {
      events.push({ index: i, timestamp: candles[i].closeTime, action: signal.action, entryPrice: candles[i].close });
    }
  }

  return events;
}

/**
 * Computes the real forward outcome of each crossover event, `lookahead` candles later.
 * A BUY setup wins if price is higher after `lookahead` candles; a SELL setup wins if
 * price is lower (i.e. the bearish signal correctly anticipated further downside).
 */
export function evaluateOutcomes(
  candles: Candle[],
  events: CrossoverEvent[],
  lookahead: number
): ReplayTrade[] {
  const trades: ReplayTrade[] = [];

  for (const event of events) {
    const exitIndex = event.index + lookahead;
    if (exitIndex >= candles.length) continue; // not enough forward data yet - skip, don't fabricate

    const exitPrice = candles[exitIndex].close;
    const rawPct = ((exitPrice - event.entryPrice) / event.entryPrice) * 100;
    const pnlPct = event.action === "BUY" ? rawPct : -rawPct;

    trades.push({
      ...event,
      exitIndex,
      exitPrice,
      pnlPct,
      outcome: pnlPct > 0 ? "WIN" : "LOSS",
    });
  }

  return trades;
}

export function summarize(trades: ReplayTrade[]): ReplaySummary {
  if (trades.length === 0) {
    return {
      totalSetups: 0,
      wins: 0,
      losses: 0,
      winRate: 0,
      avgPnlPct: 0,
      bestTrade: null,
      worstTrade: null,
      maxDrawdownPct: 0,
    };
  }

  const wins = trades.filter((t) => t.outcome === "WIN").length;
  const losses = trades.length - wins;
  const avgPnlPct = trades.reduce((acc, t) => acc + t.pnlPct, 0) / trades.length;
  const bestTrade = trades.reduce((a, b) => (b.pnlPct > a.pnlPct ? b : a));
  const worstTrade = trades.reduce((a, b) => (b.pnlPct < a.pnlPct ? b : a));

  let cumulative = 0;
  let peak = 0;
  let maxDrawdownPct = 0;
  for (const t of trades) {
    cumulative += t.pnlPct;
    peak = Math.max(peak, cumulative);
    maxDrawdownPct = Math.min(maxDrawdownPct, cumulative - peak);
  }

  return {
    totalSetups: trades.length,
    wins,
    losses,
    winRate: (wins / trades.length) * 100,
    avgPnlPct,
    bestTrade,
    worstTrade,
    maxDrawdownPct,
  };
}

function printTradeTable(trades: ReplayTrade[]): void {
  console.log("\n  #  | Time                     | Action | Entry      | Exit       | PnL %    | Outcome");
  console.log("  ---|--------------------------|--------|------------|------------|----------|--------");
  trades.forEach((t, i) => {
    const time = new Date(t.timestamp).toISOString();
    console.log(
      `  ${String(i + 1).padStart(2)} | ${time} | ${t.action.padEnd(6)} | ${t.entryPrice
        .toFixed(2)
        .padStart(10)} | ${t.exitPrice.toFixed(2).padStart(10)} | ${t.pnlPct
        .toFixed(2)
        .padStart(7)}% | ${t.outcome}`
    );
  });
  console.log("");
}

function printSummary(summary: ReplaySummary): void {
  console.log("  --- Summary ---");
  console.log(`  Total setups: ${summary.totalSetups}`);
  console.log(`  Wins: ${summary.wins}  Losses: ${summary.losses}`);
  console.log(`  Win rate: ${summary.winRate.toFixed(1)}%`);
  console.log(`  Average PnL: ${summary.avgPnlPct.toFixed(3)}%`);
  if (summary.bestTrade) {
    console.log(`  Best trade: ${summary.bestTrade.action} at ${summary.bestTrade.entryPrice} -> ${summary.bestTrade.pnlPct.toFixed(2)}%`);
  }
  if (summary.worstTrade) {
    console.log(`  Worst trade: ${summary.worstTrade.action} at ${summary.worstTrade.entryPrice} -> ${summary.worstTrade.pnlPct.toFixed(2)}%`);
  }
  console.log(`  Max drawdown (cumulative PnL %): ${summary.maxDrawdownPct.toFixed(3)}%`);

  if (summary.totalSetups === 0) {
    console.log("  No crossover setups occurred in this lookback window - nothing to report.");
  } else if (summary.losses >= 2 && summary.winRate < 40) {
    console.log(
      `  NOTE: repeated weak setups detected - ${summary.losses} losing setups out of ${summary.totalSetups} (win rate ${summary.winRate.toFixed(
        1
      )}%).`
    );
  } else {
    console.log("  No repeated pattern of losses stands out in this lookback window.");
  }
}

/**
 * Records real replay outcomes into memory: every scored trade becomes a ledger row, and
 * every real LOSS becomes a plain-English lesson (deduped per setup - nothing is invented).
 */
function recordRawOutcomesToMemory(trades: ReplayTrade[]): number {
  let lessonsWritten = 0;
  for (const trade of trades) {
    const row: LedgerRow = {
      timestamp: new Date(trade.timestamp).toISOString(),
      symbol: config.symbol,
      action: trade.action,
      price: trade.entryPrice,
      quantity: config.tradeQuantity,
      reason: `replay:raw scored ${trade.action} crossover at ${trade.entryPrice} -> ${trade.exitPrice} after ${config.replayLookaheadCandles} candles.`,
      mode: "replay:raw",
      outcome: trade.outcome,
      pnl: Number(trade.pnlPct.toFixed(4)),
    };
    appendLedgerRow(row);

    if (trade.outcome === "LOSS") {
      const wrote = appendLearning(
        config.symbol,
        trade.action,
        `A real ${trade.action} crossover at ${trade.entryPrice} lost ${Math.abs(trade.pnlPct).toFixed(
          2
        )}% over the next ${config.replayLookaheadCandles} candles (exit ${trade.exitPrice}). Treat repeats of this ${trade.action} setup on ${config.symbol} with caution.`
      );
      if (wrote) lessonsWritten++;
    }
  }
  return lessonsWritten;
}

export async function runReplayRaw(): Promise<{ trades: ReplayTrade[]; summary: ReplaySummary }> {
  log("REPLAY", `Fetching ${config.replayCandleLimit} real historical candles for ${config.symbol} (${config.interval})...`);
  const candles = await fetchCandles(config.symbol, config.interval, config.replayCandleLimit);
  log("REPLAY", `Loaded ${candles.length} real candles. Detecting real MA crossover events (no memory used)...`);

  const events = detectCrossovers(candles, config.fastPeriod, config.slowPeriod);
  const trades = evaluateOutcomes(candles, events, config.replayLookaheadCandles);
  const summary = summarize(trades);

  log("REPLAY", `Found ${events.length} crossover events, ${trades.length} with enough forward data to score.`);
  printTradeTable(trades);
  printSummary(summary);

  const lessonsWritten = recordRawOutcomesToMemory(trades);
  log(
    "MEMORY",
    trades.length === 0
      ? "No scored setups to record."
      : `Recorded ${trades.length} real outcome(s) to data/ledger.csv. Wrote ${lessonsWritten} new lesson(s) to data/learnings.md (0 means no new real losses, or they were already recorded).`
  );

  return { trades, summary };
}

export async function runReplayMemory(): Promise<void> {
  if (!hasAnyMemory()) {
    log("MEMORY", "data/ledger.csv has no recorded outcomes yet.");
    log("DECISION", "Not enough real memory exists yet. Run `npm run replay:raw` first, then re-run replay:memory.");
    return;
  }

  log("REPLAY", `Fetching ${config.replayCandleLimit} real historical candles for ${config.symbol} (${config.interval})...`);
  const candles = await fetchCandles(config.symbol, config.interval, config.replayCandleLimit);
  log("MEMORY", `Loaded data/ledger.csv (${readLedgerRows().length} rows).`);
  log("MEMORY", `Loaded data/learnings.md (${readLearnings().split("\n").length} lines).`);

  const events = detectCrossovers(candles, config.fastPeriod, config.slowPeriod);
  log("REPLAY", `Detected ${events.length} real crossover candidate(s). Applying memory before scoring each one...`);

  const takenEvents: CrossoverEvent[] = [];
  let skipped = 0;

  for (const event of events) {
    const decision = applyMemoryFilter(config.symbol, event.action, `${event.action} crossover at ${event.entryPrice}`);
    if (decision.action === "SKIP") {
      skipped++;
      appendLedgerRow({
        timestamp: new Date(event.timestamp).toISOString(),
        symbol: config.symbol,
        action: "SKIP",
        price: event.entryPrice,
        quantity: 0,
        reason: decision.reason,
        mode: "replay:memory",
        outcome: "N/A",
        pnl: "",
      });
    } else {
      takenEvents.push(event);
    }
  }

  const trades = evaluateOutcomes(candles, takenEvents, config.replayLookaheadCandles);
  const summary = summarize(trades);

  log(
    "DECISION",
    skipped > 0
      ? `Memory blocked ${skipped} of ${events.length} setup(s) as repeats of a known bad trade. No paper order was sent for those.`
      : `Memory did not block any setups this run - none matched a real recorded loss or learning yet.`
  );

  console.log(`\n  Setups seen: ${events.length}  |  Skipped by memory: ${skipped}  |  Taken through: ${takenEvents.length}`);
  printTradeTable(trades);
  printSummary(summary);
}
