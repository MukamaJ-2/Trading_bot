import { RiskDecision, StrategyAction } from "./types";

export interface RiskParams {
  quantity: number;
  maxPosition: number;
  currentPosition: number;
}

/**
 * Approves or rejects a strategy signal. HOLD always passes through unchanged.
 * BUY/SELL is rejected (SKIP) if it would push the position beyond maxPosition.
 */
export function evaluateRisk(action: StrategyAction, params: RiskParams): RiskDecision {
  if (action === "HOLD") {
    return { action: "HOLD", reason: "No trade signal to evaluate." };
  }

  if (params.quantity <= 0) {
    return {
      action: "SKIP",
      reason: `Configured trade quantity (${params.quantity}) must be greater than zero.`,
    };
  }

  const projectedPosition =
    action === "BUY"
      ? params.currentPosition + params.quantity
      : params.currentPosition - params.quantity;

  if (Math.abs(projectedPosition) > params.maxPosition + 1e-9) {
    return {
      action: "SKIP",
      reason: `Proposed ${action} of ${params.quantity} would move position to ${projectedPosition.toFixed(
        6
      )}, exceeding max position ${params.maxPosition}.`,
    };
  }

  return {
    action,
    reason: `Risk check passed: ${action} ${params.quantity} keeps position within max ${params.maxPosition}.`,
  };
}
