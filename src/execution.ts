import { ExecutionResult, FinalAction } from "./types";

/**
 * Simulates a paper order. This module has no code path to any real exchange
 * order-placement endpoint — it only ever produces a local, in-memory record.
 */
export function simulatePaperOrder(
  action: FinalAction,
  symbol: string,
  price: number,
  quantity: number
): ExecutionResult {
  const orderPlaced = action === "BUY" || action === "SELL";
  return {
    action,
    mode: "paper",
    symbol,
    price,
    quantity: orderPlaced ? quantity : 0,
    timestamp: new Date().toISOString(),
    orderPlaced,
  };
}
