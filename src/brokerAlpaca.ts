import { config } from "./config";

/**
 * Alpaca PAPER trading broker adapter. This is the one module in the entire codebase
 * that can submit a real order - and it can only ever submit to Alpaca's paper
 * simulator, never live trading.
 *
 * PAPER_BASE_URL is a hardcoded constant, not read from an environment variable, on
 * purpose: there is no .env setting, no repo secret, and no code path anywhere that can
 * point this adapter at https://api.alpaca.markets (Alpaca's live trading host). Paper
 * and live are entirely separate hosts on Alpaca's side, so pointing at the paper host
 * is what makes every order here a paper order, by construction - not a runtime check
 * that could be bypassed by misconfiguration.
 */
const PAPER_BASE_URL = "https://paper-api.alpaca.markets";
export const PAPER_BASE_URL_FOR_DISPLAY = PAPER_BASE_URL;

export interface AlpacaAccount {
  id: string;
  status: string;
  currency: string;
  cash: string;
  buying_power: string;
  portfolio_value: string;
}

export interface AlpacaPosition {
  symbol: string;
  qty: string;
  side: "long" | "short";
  market_value: string;
  unrealized_pl: string;
}

export interface AlpacaOrder {
  id: string;
  symbol: string;
  qty: string;
  side: "buy" | "sell";
  type: string;
  time_in_force: string;
  status: string;
  created_at: string;
}

function authHeaders(): Record<string, string> {
  if (!config.alpacaKeyId || !config.alpacaSecretKey) {
    throw new Error(
      "Alpaca broker requires ALPACA_API_KEY_ID and ALPACA_API_SECRET_KEY " +
        "(local .env, or GitHub Actions secrets - never pasted into chat or committed to the repo)."
    );
  }
  return {
    "APCA-API-KEY-ID": config.alpacaKeyId,
    "APCA-API-SECRET-KEY": config.alpacaSecretKey,
    "Content-Type": "application/json",
  };
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const url = `${PAPER_BASE_URL}${path}`;
  let response: Response;
  try {
    response = await fetch(url, { ...init, headers: { ...authHeaders(), ...(init?.headers || {}) } });
  } catch (err) {
    throw new Error(`Failed to reach Alpaca paper API (${url}): ${(err as Error).message}`);
  }
  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(`Alpaca paper API request failed with status ${response.status}: ${body}`);
  }
  return (await response.json()) as T;
}

/** Confirms this really is the paper endpoint. Belt-and-braces alongside the hardcoded URL. */
export function assertPaperMode(): void {
  if (!PAPER_BASE_URL.includes("paper-api.alpaca.markets")) {
    // This can only happen if the constant above is edited - fail loudly rather than
    // silently risk a live order.
    throw new Error("Refusing to continue: Alpaca broker base URL is not the paper endpoint.");
  }
}

export async function getAccount(): Promise<AlpacaAccount> {
  assertPaperMode();
  return request<AlpacaAccount>("/v2/account");
}

export async function getPositions(): Promise<AlpacaPosition[]> {
  assertPaperMode();
  return request<AlpacaPosition[]>("/v2/positions");
}

export async function getPositionQty(symbol: string): Promise<number> {
  const positions = await getPositions();
  const match = positions.find((p) => p.symbol === symbol.replace("/", ""));
  if (!match) return 0;
  return match.side === "long" ? Number(match.qty) : -Number(match.qty);
}

export async function getOpenOrders(): Promise<AlpacaOrder[]> {
  assertPaperMode();
  return request<AlpacaOrder[]>("/v2/orders?status=open&limit=50");
}

/**
 * Submits a real (paper) market order. Only ever called after the strategy signal has
 * passed risk and memory checks - this function itself does not re-check those, callers
 * must.
 */
export async function submitOrder(symbol: string, side: "buy" | "sell", qty: number): Promise<AlpacaOrder> {
  assertPaperMode();
  const isCrypto = symbol.includes("/");
  return request<AlpacaOrder>("/v2/orders", {
    method: "POST",
    body: JSON.stringify({
      symbol,
      qty: String(qty),
      side,
      type: "market",
      time_in_force: isCrypto ? "gtc" : "day",
    }),
  });
}
