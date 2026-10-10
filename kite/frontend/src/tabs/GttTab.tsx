import { useEffect } from "react";
import { buildCandidate } from "../lib/gtt";
import { fmtPrice } from "../lib/format";
import { useAlgo } from "../live/AlgoContext";

const STATUS_CLASS: Record<string, string> = {
  ready: "info",
  success: "good",
  clear: "good",
  planned_after_buy: "info",
  failed: "bad",
  blocked: "bad",
  invalid: "bad",
  already_active: "warn",
  waiting: "warn",
  waiting_for_ltp: "warn",
  not_available: "muted",
  not_placed: "muted",
  checking: "muted",
};

const Badge = ({ value }: { value: string | null | undefined }) =>
  value ? <span className={`badge ${STATUS_CLASS[value] ?? "muted"}`}>{value}</span> : <span className="muted">—</span>;

const show = (v: unknown) => (v === null || v === undefined || v === "" ? "—" : String(v));

export function GttTab() {
  const { output, loading, livePrice, gttResults, gttChecking, gttError, running, checkGttState } = useAlgo();
  const results = output?.results ?? [];

  // Read-only status refresh whenever the tab is opened.
  useEffect(() => {
    if (!running) checkGttState();
  }, []);

  return (
    <section>
      <header className="page-head">
        <h1>GTT Order Placement</h1>
        <p className="muted">
          Simulation only: buy GTTs are stored as local DUMMY- records and never sent to Kite. Use Run Live on the
          Algo Signals tab to create them.
        </p>
      </header>

      {gttError && <div className="alert error">{gttError}</div>}

      <div className="panel">
        <div className="panel-head">
          <div>
            <h2>Kite GTT Placement</h2>
            <p className="muted small">
              Read-only status from Algo Signals · Qty 1 · Buy GTT at breakout candle low · Stoploss 5% below buy ·
              State from Kite orders, positions, holdings, and GTTs
            </p>
          </div>
          {(gttChecking || running) && <span className="muted small">{running ? "Running..." : "Checking..."}</span>}
        </div>
        {loading ? (
          <div className="state">Loading scanner cache...</div>
        ) : results.length === 0 ? (
          <div className="state">No Algo Signals rows, so there are no GTT candidates.</div>
        ) : (
          <div className="table-wrap">
            <table className="dense">
              <thead>
                <tr>
                  <th>Rank</th><th>Symbol</th><th className="num">Qty</th><th className="num">Buy</th>
                  <th className="num">Stoploss</th><th className="num">Last Price</th><th>Account State</th>
                  <th>Buy Status</th><th>Buy Trigger</th><th>Day Buy Order</th><th className="num">Position Qty</th>
                  <th>Stoploss Status</th><th>Stoploss Trigger</th><th>Message</th>
                </tr>
              </thead>
              <tbody>
                {results.map((r, i) => {
                  const ltp = livePrice(r);
                  const cand = buildCandidate(r, ltp);
                  const res = gttResults[r.symbol];
                  const buy = res?.buy_price ?? cand.buy_price;
                  const sl = res?.stoploss ?? cand.stoploss;
                  const pending = gttChecking || running;
                  return (
                    <tr key={r.symbol}>
                      <td>{i + 1}</td>
                      <td className="symbol">{r.symbol}</td>
                      <td className="num">1</td>
                      <td className="num">{buy === null ? <span className="muted">Unavailable</span> : fmtPrice(buy)}</td>
                      <td className="num">{sl === null ? <span className="muted">Unavailable</span> : fmtPrice(sl)}</td>
                      <td className="num">{ltp === null ? <span className="muted">Waiting</span> : fmtPrice(ltp)}</td>
                      <td><Badge value={res?.account_state ?? (pending ? "checking" : null)} /></td>
                      <td><Badge value={res?.buy_status ?? (pending ? "checking" : "not_placed")} /></td>
                      <td className="mono">{show(res?.buy_trigger_id ?? res?.active_buy_trigger_id)}</td>
                      <td className="mono">
                        {res?.day_buy_order_id ? `${res.day_buy_order_id} (${res.day_buy_order_status})` : "—"}
                      </td>
                      <td className="num">{show(res?.position_quantity)}</td>
                      <td><Badge value={res?.stoploss_status ?? (sl === null ? "not_available" : "planned_after_buy")} /></td>
                      <td className="mono">{show(res?.stoploss_trigger_id ?? res?.active_stoploss_trigger_id)}</td>
                      <td className="message">{res?.message ?? (pending ? "Checking state..." : "—")}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </section>
  );
}
