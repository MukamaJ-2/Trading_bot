import { useState } from "react";
import { fmtMultiple, fmtPrice, fmtSignedPct, pctClass } from "../lib/format";
import { useAlgo } from "../live/AlgoContext";

export function AlgoSignalsTab() {
  const { output, metadata, loading, error, tickStatus, livePrice, running, runLive, gttError } = useAlgo();
  const [selected, setSelected] = useState<string | null>(null);
  const results = output?.results ?? [];

  return (
    <section>
      <header className="page-head with-action">
        <div>
          <h1>High-volume breakout and retest setups</h1>
          <p className="muted">
            Daily breakouts on 3x average volume that ran higher, then pulled back to within 1% of the breakout
            candle's midpoint.
          </p>
        </div>
        <button className="btn primary" onClick={runLive} disabled={running || loading}>
          {running ? "Running..." : "Run Live"}
        </button>
      </header>

      <div className="summary">
        <div><span className="big">{results.length}</span> triggered breakouts</div>
        <div><span className="big">{output?.scanned ?? 0}</span> stocks scanned</div>
        <div className="tick-status"><span className="dot" /> {tickStatus}</div>
      </div>
      <p className="hint">
        Run Live rescans and creates <strong>simulated</strong> (DUMMY-) buy GTTs only. No order is ever sent to Kite.
        {metadata?.universe_source === "bundled-fallback" && " Using the bundled Nifty 100 list (official CSV unreachable)."}
      </p>

      {error && <div className="alert error">{error}</div>}
      {gttError && <div className="alert error">GTT placement: {gttError}</div>}

      <div className="panel">
        <div className="panel-head">
          <h2>Triggered Breakouts</h2>
          <span className="muted small">Vol 20 · 3x · High 20 · Max age 20 · Midpoint ±1%</span>
        </div>
        {loading ? (
          <div className="state">Loading scanner cache...</div>
        ) : results.length === 0 && !error ? (
          <div className="state">No breakout retest setups match the current parameters.</div>
        ) : (
          <div className="table-wrap">
            <table className="dense">
              <thead>
                <tr>
                  <th>Rank</th><th>Symbol</th><th className="num">Current Price</th><th>Breakout Date</th>
                  <th className="num">Age</th><th className="num">Breakout Vol</th><th className="num">Retest Distance</th>
                  <th className="num">Peak Gains</th><th className="num">Retracement</th>
                </tr>
              </thead>
              <tbody>
                {results.map((r, i) => (
                  <tr
                    key={r.symbol}
                    className={selected === r.symbol ? "selected" : ""}
                    onClick={() => setSelected(r.symbol === selected ? null : r.symbol)}
                  >
                    <td>{i + 1}</td>
                    <td className="symbol" title={r.companyName}>{r.symbol}</td>
                    <td className="num">{fmtPrice(livePrice(r) ?? r.currentPrice)}</td>
                    <td className="mono">{r.breakoutDate}</td>
                    <td className="num">{r.daysSince}</td>
                    <td className="num">{fmtMultiple(r.volMultiple)}</td>
                    <td className={`num ${pctClass(r.distanceFromMidpoint)}`}>{fmtSignedPct(r.distanceFromMidpoint)}</td>
                    <td className={`num ${pctClass(r.returnFromCloseToSubHigh)}`}>{fmtSignedPct(r.returnFromCloseToSubHigh)}</td>
                    <td className="num">{fmtSignedPct(r.retracementHigh)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </section>
  );
}
