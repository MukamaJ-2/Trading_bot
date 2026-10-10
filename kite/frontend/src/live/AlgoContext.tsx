// Shared state for Algo Signals and GTT Placement: one scanner run, one OHLC
// snapshot, one tick subscription, and the GTT status rows derived from them.

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import { api, ApiError } from "../api";
import { buildCandidate, EXCLUDED_STATES } from "../lib/gtt";
import type { GttCandidate, GttResult } from "../lib/gtt";
import { runScanner } from "../lib/scanner";
import type { ScanOutput, ScanResult, ScannerData } from "../lib/scanner";
import { useTicks } from "./useTicks";

type Snapshot = Record<string, number>;

interface AlgoState {
  output: ScanOutput | null;
  metadata: Record<string, unknown> | null;
  loading: boolean;
  error: string | null;
  tickStatus: string;
  livePrice: (r: ScanResult) => number | null; // websocket LTP, else OHLC snapshot LTP
  gttResults: Record<string, GttResult>;
  gttChecking: boolean;
  gttError: string | null;
  running: boolean;
  runLive: () => Promise<void>;
  checkGttState: () => Promise<void>;
}

const Ctx = createContext<AlgoState | null>(null);

export const useAlgo = () => {
  const v = useContext(Ctx);
  if (!v) throw new Error("useAlgo must be used inside AlgoProvider");
  return v;
};

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

export function AlgoProvider({ children }: { children: ReactNode }) {
  const [output, setOutput] = useState<ScanOutput | null>(null);
  const [metadata, setMetadata] = useState<Record<string, unknown> | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [snapshot, setSnapshot] = useState<Snapshot>({});
  const [gttResults, setGttResults] = useState<Record<string, GttResult>>({});
  const [gttChecking, setGttChecking] = useState(false);
  const [gttError, setGttError] = useState<string | null>(null);
  const [running, setRunning] = useState(false);

  const tokens = useMemo(() => (output?.results ?? []).map((r) => r.instrumentToken), [output]);
  const ticks = useTicks(tokens);

  // Refs so async flows always read the latest prices, and stale responses are dropped.
  const pricesRef = useRef(ticks.prices);
  pricesRef.current = ticks.prices;
  const snapshotRef = useRef(snapshot);
  snapshotRef.current = snapshot;
  const outputRef = useRef(output);
  outputRef.current = output;
  const gttSeq = useRef(0);

  const priceOf = useCallback(
    (r: ScanResult, snap: Snapshot = snapshotRef.current): number | null =>
      pricesRef.current[r.instrumentToken] ?? snap[r.symbol] ?? null,
    [],
  );

  const loadScanner = useCallback(async (): Promise<ScanOutput> => {
    setLoading(true);
    setError(null);
    try {
      const data = await api.get<ScannerData>("/api/scanner-data");
      const out = runScanner(data);
      setMetadata(data.metadata);
      setOutput(out);
      return out;
    } catch (e) {
      setError(message(e));
      throw e;
    } finally {
      setLoading(false);
    }
  }, []);

  const loadSnapshot = useCallback(async (results: ScanResult[]): Promise<Snapshot> => {
    if (!results.length) {
      setSnapshot({});
      return {};
    }
    const symbols = results.map((r) => r.symbol).join(",");
    const raw = await api.get<Record<string, { last_price: number | null }>>(
      `/api/ohlc?symbols=${encodeURIComponent(symbols)}`,
    );
    const snap: Snapshot = {};
    for (const [sym, q] of Object.entries(raw)) if (typeof q.last_price === "number") snap[sym] = q.last_price;
    setSnapshot(snap);
    return snap;
  }, []);

  const stateFor = useCallback(async (candidates: GttCandidate[]) => {
    const res = await api.post<{ results: GttResult[] }>("/api/algo-orders/gtt-state", { orders: candidates });
    return Object.fromEntries(res.results.map((r) => [r.symbol, r]));
  }, []);

  /** Read-only status check for the current Algo Signals rows. */
  const checkGttState = useCallback(async () => {
    const results = outputRef.current?.results ?? [];
    const seq = ++gttSeq.current;
    if (!results.length) {
      setGttResults({});
      return;
    }
    setGttChecking(true);
    try {
      const byS = await stateFor(results.map((r) => buildCandidate(r, priceOf(r))));
      if (seq === gttSeq.current) setGttResults(byS);
    } catch (e) {
      if (seq === gttSeq.current) setGttError(message(e));
    } finally {
      if (seq === gttSeq.current) setGttChecking(false);
    }
  }, [priceOf, stateFor]);

  // Initial load: scanner, then OHLC snapshot, then a read-only GTT status check.
  useEffect(() => {
    (async () => {
      try {
        const out = await loadScanner();
        await loadSnapshot(out.results).catch(() => ({}));
        await checkGttState();
      } catch {
        /* error already shown */
      }
    })();
  }, [loadScanner, loadSnapshot, checkGttState]);

  /** Run Live: rescan, check state, create DUMMY buy GTTs for ready rows. No real orders. */
  const runLive = useCallback(async () => {
    setRunning(true);
    setGttError(null);
    const seq = ++gttSeq.current;
    try {
      try {
        await api.post("/api/scanner-data/refresh");
      } catch (e) {
        if (!(e instanceof ApiError && e.status === 404)) throw e;
      }
      const out = await loadScanner();
      const snap = await loadSnapshot(out.results);
      const candidates = out.results.map((r) => buildCandidate(r, priceOf(r, snap)));
      setGttResults({});
      if (!candidates.length) return;

      const state = await stateFor(candidates);
      const ready = candidates.filter((c) => {
        const s = state[c.symbol];
        return (
          c.buy_price !== null &&
          c.stoploss !== null &&
          c.last_price !== null &&
          s?.buy_status === "ready" &&
          !EXCLUDED_STATES.has(s.account_state)
        );
      });
      let placed: Record<string, GttResult> = {};
      if (ready.length) {
        const res = await api.post<{ results: GttResult[] }>("/api/algo-orders/live-gtt", {
          orders: ready,
          confirm_live: true, // authorizes dummy simulation only
        });
        placed = Object.fromEntries(res.results.map((r) => [r.symbol, r]));
      }
      if (seq === gttSeq.current) setGttResults({ ...state, ...placed });
    } catch (e) {
      setGttError(message(e));
    } finally {
      setRunning(false);
    }
  }, [loadScanner, loadSnapshot, priceOf, stateFor]);

  const value: AlgoState = {
    output,
    metadata,
    loading,
    error,
    tickStatus: ticks.status,
    livePrice: (r) => ticks.prices[r.instrumentToken] ?? snapshot[r.symbol] ?? null,
    gttResults,
    gttChecking,
    gttError,
    running,
    runLive,
    checkGttState,
  };
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}
