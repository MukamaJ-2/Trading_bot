import { MemoryDecision, StrategyAction } from "./types";
import { findPriorLoss, hasMatchingLearning } from "./memory";

/**
 * Checks a candidate BUY/SELL action against real recorded memory before it is allowed
 * through. HOLD/SKIP candidates pass through untouched - memory only ever downgrades a
 * live BUY/SELL to SKIP, it never upgrades a HOLD into a trade.
 */
export function applyMemoryFilter(
  symbol: string,
  action: StrategyAction | "SKIP",
  candidateReason: string
): MemoryDecision {
  if (action !== "BUY" && action !== "SELL") {
    return { action, reason: candidateReason, memoryApplied: false };
  }

  const priorLoss = findPriorLoss(symbol, action);
  if (priorLoss) {
    return {
      action: "SKIP",
      reason: `Memory blocked this trade: ${symbol} lost on a similar ${action} crossover setup before (recorded ${priorLoss.timestamp}, PnL ${priorLoss.pnl}%).`,
      memoryApplied: true,
    };
  }

  if (hasMatchingLearning(symbol, action)) {
    return {
      action: "SKIP",
      reason: `Memory blocked this trade: learnings.md warns about this exact ${symbol} ${action} setup.`,
      memoryApplied: true,
    };
  }

  return {
    action,
    reason: `${candidateReason} No matching prior loss found in memory.`,
    memoryApplied: false,
  };
}
