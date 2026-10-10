// GTT candidate construction (display side). The backend repeats the tick rounding
// with exact decimals and is the authority for every value it stores.

import type { ScanResult } from "./scanner";

export type BuyStatus =
  | "ready"
  | "success"
  | "failed"
  | "blocked"
  | "already_active"
  | "planned_after_buy"
  | "waiting_for_ltp"
  | "not_available"
  | "not_placed"
  | "checking";

export interface GttCandidate {
  symbol: string;
  quantity: number;
  buy_price: number | null;
  stoploss: number | null;
  last_price: number | null;
}

export interface GttResult {
  symbol: string;
  quantity: number;
  buy_price: number | null;
  stoploss: number | null;
  tick_size: number | null;
  last_price: number | null;
  account_state: string;
  position_quantity: number;
  active_buy_trigger_id: string | number | null;
  active_stoploss_trigger_id: string | number | null;
  day_buy_order_id: string | null;
  day_buy_order_status: string | null;
  buy_status: BuyStatus;
  buy_trigger_id: string | number | null;
  stoploss_status: string;
  stoploss_trigger_id: string | number | null;
  message: string;
}

/** Account states the frontend never sends to live-gtt (the backend re-checks anyway). */
export const EXCLUDED_STATES = new Set(["blocked", "already_active", "position_exists", "day_buy_order_exists"]);

function decimals(n: number): number {
  const s = String(n);
  if (s.includes("e-")) return Number(s.split("e-")[1]);
  return s.includes(".") ? s.split(".")[1].length : 0;
}

/**
 * Rounds price to the nearest multiple of tick (half up) using scaled integers, so
 * 0.05 ticks never pick up binary floating-point noise. `factorPct` lets the stoploss
 * (95% of the buy price) be computed exactly from the already-rounded buy price.
 */
export function roundToTick(price: number, tick: number, factorPct = 100): number | null {
  if (!(price > 0) || !(tick > 0)) return null;
  const places = Math.max(decimals(tick), decimals(price));
  const scale = 10 ** places;
  const priceInt = Math.round(price * scale);
  const tickInt = Math.round(tick * scale);
  const num = priceInt * factorPct;
  const den = tickInt * 100;
  const steps = Math.floor((2 * num + den) / (2 * den));
  return Number(((steps * tickInt) / scale).toFixed(decimals(tick)));
}

export function buildCandidate(r: ScanResult, lastPrice: number | null): GttCandidate {
  const tick = r.tickSize ?? 0.05;
  const buy = Number.isFinite(r.breakoutLow) ? roundToTick(r.breakoutLow, tick) : null;
  const stoploss = buy !== null ? roundToTick(buy, tick, 95) : null;
  return { symbol: r.symbol, quantity: 1, buy_price: buy, stoploss, last_price: lastPrice };
}
