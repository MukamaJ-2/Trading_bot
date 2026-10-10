import { useState } from "react";
import type { FormEvent } from "react";
import { api } from "../api";
import { fmtPrice } from "../lib/format";

interface SignalRow {
  rank: number;
  ticker: string;
  company: string;
  crossover_type: "Bullish" | "Bearish";
  crossover_date: string;
  close: number;
  sma_short: number;
  sma_long: number;
}

interface SignalsResponse {
  results: SignalRow[];
  scanned: number;
  skipped: { symbol: string; reason: string }[];
  errors: { symbol: string; error: string }[];
  universe_source: string;
}

export function SignalsTab() {
  const [shortP, setShortP] = useState(6);
  const [longP, setLongP] = useState(30);
  const [lookback, setLookback] = useState(120);
  const [maxStocks, setMaxStocks] = useState(100);
  const [data, setData] = useState<SignalsResponse | null>(null);
  const [cols, setCols] = useState({ s: 6, l: 30 });
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const generate = async (e: FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setError(null);
    try {
      const q = new URLSearchParams({
        short: String(shortP),
        long: String(longP),
        lookback_days: String(lookback),
        max_stocks: String(maxStocks),
      });
      setData(await api.get<SignalsResponse>(`/api/signals?${q}`));
      setCols({ s: shortP, l: longP });
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <section>
      <header className="page-head">
        <h1>Signals</h1>
        <p className="muted">
          Nifty 100 SMA crossover scanner on daily candles. Stocks with the most recent crossover are ranked first.
        </p>
      </header>

      <form className="panel form-row" onSubmit={generate}>
        <label>
          Short SMA
          <input type="number" min={1} value={shortP} onChange={(e) => setShortP(Number(e.target.value))} />
        </label>
        <label>
          Long SMA
          <input type="number" min={2} value={longP} onChange={(e) => setLongP(Number(e.target.value))} />
        </label>
        <label>
          Lookback Days
          <input type="number" min={10} max={2000} value={lookback} onChange={(e) => setLookback(Number(e.target.value))} />
        </label>
        <label>
          Max Stocks
          <input type="number" min={1} max={100} value={maxStocks} onChange={(e) => setMaxStocks(Number(e.target.value))} />
        </label>
        <button className="btn primary" disabled={loading}>
          {loading ? "Generating..." : "Generate Signals"}
        </button>
      </form>
      <p className="hint">
        Lookback Days is calendar days of history to fetch. It must cover more trading days than the Long SMA
        (about 1.5x as many calendar days).
      </p>

      {error && <div className="alert error">{error}</div>}
      {loading && <div className="state">Fetching candles and calculating crossovers...</div>}
      {data && !loading && (
        <div className="panel">
          <div className="panel-head">
            <h2>Crossover Signals</h2>
            <span className="muted small">
              {data.results.length} signals · {data.scanned} stocks scanned
              {data.universe_source === "bundled-fallback" && " · using bundled Nifty 100 list"}
            </span>
          </div>
          {data.results.length === 0 ? (
            <div className="state">No crossovers found in this lookback window.</div>
          ) : (
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Rank</th><th>Ticker</th><th>Company</th><th>Crossover Type</th><th>Crossover Date</th>
                    <th className="num">Close</th><th className="num">SMA {cols.s}</th><th className="num">SMA {cols.l}</th>
                  </tr>
                </thead>
                <tbody>
                  {data.results.map((r) => (
                    <tr key={r.ticker}>
                      <td>{r.rank}</td>
                      <td className="symbol">{r.ticker}</td>
                      <td className="muted">{r.company}</td>
                      <td><span className={`badge ${r.crossover_type === "Bullish" ? "good" : "bad"}`}>{r.crossover_type}</span></td>
                      <td className="mono">{r.crossover_date}</td>
                      <td className="num">{fmtPrice(r.close)}</td>
                      <td className="num">{fmtPrice(r.sma_short)}</td>
                      <td className="num">{fmtPrice(r.sma_long)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {(data.skipped.length > 0 || data.errors.length > 0) && (
            <p className="hint">
              Skipped {data.skipped.length} and failed {data.errors.length} stocks
              {data.skipped[0] && ` (e.g. ${data.skipped[0].symbol}: ${data.skipped[0].reason})`}.
            </p>
          )}
        </div>
      )}
    </section>
  );
}
