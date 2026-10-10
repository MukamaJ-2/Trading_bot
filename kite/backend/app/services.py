"""Builders for /api/scanner-data and /api/signals."""

from __future__ import annotations

import json
import threading
from datetime import date, datetime
from typing import Any

from . import config
from .market_data import candles, instruments
from .sma import latest_crossover
from .universe import load_universe


class ScannerDataCache:
    """Daily candles for the whole universe, built once a day (or on refresh)."""

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._data: dict | None = None
        self._file = config.CACHE_DIR / "scanner_data.json"

    def _fresh(self, data: dict | None) -> bool:
        return bool(data) and data["metadata"].get("trading_date") == date.today().isoformat() \
            and data["metadata"].get("demo") == config.DEMO_MODE

    def get(self, kite: Any, force: bool = False) -> dict:
        with self._lock:
            if not force and not self._fresh(self._data) and self._file.exists():
                try:
                    self._data = json.loads(self._file.read_text())
                except ValueError:
                    self._data = None
            if force or not self._fresh(self._data):
                self._data = self._build(kite, force)
                self._file.write_text(json.dumps(self._data))
            return self._data

    def _build(self, kite: Any, force: bool) -> dict:
        universe = load_universe(force=force)
        stocks, missing, errors = [], [], []
        for c in universe.constituents:
            inst = instruments.get(kite, c.symbol)
            if inst is None:
                missing.append(c.symbol)
                continue
            try:
                bars = candles.daily(kite, inst.instrument_token, config.SCANNER_HISTORY_DAYS, force=force)
            except Exception as exc:
                errors.append({"symbol": c.symbol, "error": str(exc)})
                continue
            stocks.append(
                {
                    "symbol": c.symbol,
                    "company_name": c.company_name,
                    "instrument_token": inst.instrument_token,
                    "tick_size": float(inst.tick_size),
                    "is_nifty50": c.nifty50,
                    "is_nifty100": c.nifty100,
                    "candles": bars,
                }
            )
        return {
            "metadata": {
                "generated_at": datetime.now().isoformat(timespec="seconds"),
                "trading_date": date.today().isoformat(),
                "interval": "day",
                "history_days": config.SCANNER_HISTORY_DAYS,
                "universe": "NIFTY 100",
                "universe_source": universe.source,
                "universe_count": len(universe.constituents),
                "stocks_count": len(stocks),
                "unmapped_symbols": missing,
                "errors": errors,
                "demo": config.DEMO_MODE,
            },
            "stocks": stocks,
        }


scanner_cache = ScannerDataCache()


def sma_signals(kite: Any, short: int, long: int, lookback_days: int, max_stocks: int) -> dict:
    universe = load_universe()
    rows, skipped, errors = [], [], []
    for c in universe.constituents[:max_stocks]:
        inst = instruments.get(kite, c.symbol)
        if inst is None:
            skipped.append({"symbol": c.symbol, "reason": "No NSE instrument token"})
            continue
        try:
            bars = candles.daily(kite, inst.instrument_token, lookback_days)
        except Exception as exc:
            errors.append({"symbol": c.symbol, "error": str(exc)})
            continue
        if len(bars) < long + 1:
            skipped.append({"symbol": c.symbol, "reason": f"Only {len(bars)} candles; need {long + 1}"})
            continue
        x = latest_crossover(bars, short, long)
        if x:
            rows.append({"ticker": c.symbol, "company": c.company_name, **x})

    rows.sort(key=lambda r: r["ticker"])
    rows.sort(key=lambda r: r["crossover_date"], reverse=True)  # most recent first
    for i, r in enumerate(rows, 1):
        r["rank"] = i
    return {
        "params": {"short": short, "long": long, "lookback_days": lookback_days, "max_stocks": max_stocks},
        "universe_source": universe.source,
        "scanned": min(max_stocks, len(universe.constituents)),
        "results": rows,
        "skipped": skipped,
        "errors": errors,
    }
