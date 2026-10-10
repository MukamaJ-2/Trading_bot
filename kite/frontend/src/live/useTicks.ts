import { useEffect, useRef, useState } from "react";

export interface TickState {
  prices: Record<number, number>;
  status: string;
}

/**
 * One websocket to /ws/ticks for the given instrument tokens. Reconnects when the
 * token set changes or the connection drops. Shared by Algo Signals and GTT Placement.
 */
export function useTicks(tokens: number[]): TickState {
  const [prices, setPrices] = useState<Record<number, number>>({});
  const [status, setStatus] = useState("No live subscription yet.");
  const key = [...new Set(tokens)].sort((a, b) => a - b).join(",");
  const retry = useRef(0);

  useEffect(() => {
    if (!key) {
      setStatus("No live subscription yet.");
      return;
    }
    let ws: WebSocket | null = null;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let closed = false;

    const open = () => {
      const proto = location.protocol === "https:" ? "wss" : "ws";
      ws = new WebSocket(`${proto}://${location.host}/ws/ticks?tokens=${key}&mode=full`);
      setStatus(`Connecting live ticks for ${key.split(",").length} stocks...`);
      ws.onopen = () => {
        retry.current = 0;
      };
      ws.onmessage = (ev) => {
        try {
          const msg = JSON.parse(ev.data);
          if (msg.type === "ticks") {
            setPrices((prev) => {
              const next = { ...prev };
              for (const t of msg.ticks) {
                if (typeof t.last_price === "number") next[t.instrument_token] = t.last_price;
              }
              return next;
            });
          } else if (msg.type === "status") {
            setStatus(msg.message);
          }
        } catch {
          /* ignore malformed frames */
        }
      };
      ws.onclose = () => {
        if (closed) return;
        const delay = Math.min(30000, 1000 * 2 ** retry.current++);
        setStatus(`Live ticks disconnected. Retrying in ${Math.round(delay / 1000)}s...`);
        timer = setTimeout(open, delay);
      };
    };
    open();
    return () => {
      closed = true;
      clearTimeout(timer);
      ws?.close();
    };
  }, [key]);

  return { prices, status };
}
