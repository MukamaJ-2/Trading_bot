"""Instrument master and daily candles from Kite, with simple caching."""

from __future__ import annotations

import threading
import time
from dataclasses import dataclass
from datetime import date, datetime, timedelta
from decimal import Decimal
from typing import Any

from . import config


@dataclass(frozen=True)
class Instrument:
    symbol: str
    instrument_token: int
    name: str
    tick_size: Decimal


class InstrumentMaster:
    """NSE instrument tokens and tick sizes, refreshed once a day."""

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._by_symbol: dict[str, Instrument] = {}
        self._by_token: dict[int, Instrument] = {}
        self._loaded_on: date | None = None

    def _ensure(self, kite: Any) -> None:
        with self._lock:
            if self._loaded_on == date.today() and self._by_symbol:
                return
            by_symbol: dict[str, Instrument] = {}
            for row in kite.instruments("NSE"):
                if row.get("segment") not in (None, "NSE") or row.get("instrument_type") not in (None, "EQ"):
                    continue
                inst = Instrument(
                    symbol=row["tradingsymbol"],
                    instrument_token=int(row["instrument_token"]),
                    name=row.get("name") or row["tradingsymbol"],
                    # str() first so 0.05 becomes Decimal("0.05"), not a binary float.
                    tick_size=Decimal(str(row.get("tick_size") or "0.05")),
                )
                by_symbol[inst.symbol] = inst
            self._by_symbol = by_symbol
            self._by_token = {i.instrument_token: i for i in by_symbol.values()}
            self._loaded_on = date.today()

    def get(self, kite: Any, symbol: str) -> Instrument | None:
        self._ensure(kite)
        return self._by_symbol.get(symbol)

    def by_token(self, kite: Any, token: int) -> Instrument | None:
        self._ensure(kite)
        return self._by_token.get(token)


class CandleStore:
    """Daily candles per instrument, cached for the day, rate-limited fetches."""

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._cache: dict[int, tuple[date, int, list[dict]]] = {}
        self._last_call = 0.0

    def _throttle(self) -> None:
        if config.DEMO_MODE:
            return
        wait = config.HISTORICAL_MIN_INTERVAL_SEC - (time.monotonic() - self._last_call)
        if wait > 0:
            time.sleep(wait)
        self._last_call = time.monotonic()

    def daily(self, kite: Any, token: int, days: int, force: bool = False) -> list[dict]:
        """Candles covering the last `days` calendar days, oldest first."""
        with self._lock:
            cached = self._cache.get(token)
            if not force and cached and cached[0] == date.today() and cached[1] >= days:
                cutoff = date.today() - timedelta(days=days)
                return [c for c in cached[2] if c["date"] >= cutoff.isoformat()]

            self._throttle()
            to_date = datetime.now()
            from_date = to_date - timedelta(days=days)
            raw = kite.historical_data(token, from_date, to_date, "day")
            candles = [normalize_candle(c) for c in raw]
            candles.sort(key=lambda c: c["date"])
            self._cache[token] = (date.today(), days, candles)
            return candles


def normalize_candle(c: dict) -> dict:
    d = c["date"]
    if isinstance(d, (datetime, date)):
        d = d.strftime("%Y-%m-%d")
    else:
        d = str(d)[:10]
    return {
        "date": d,
        "open": float(c["open"]),
        "high": float(c["high"]),
        "low": float(c["low"]),
        "close": float(c["close"]),
        "volume": float(c["volume"]),
    }


instruments = InstrumentMaster()
candles = CandleStore()
