"""A fake, read-only Kite client for demo mode (KITE_DEMO=true).

It generates deterministic synthetic daily candles for the Nifty 100 universe, and
plants a handful of breakout-and-retest setups so every tab has something to show.
The fake account holds one stock and has one open day BUY order, so the GTT tab can
show blocked states too. None of this is real market data.
"""

from __future__ import annotations

import hashlib
import random
from datetime import date, datetime, timedelta

from .universe import load_universe

HISTORY_TRADING_DAYS = 300

# (symbol, breakout age in candles) for planted breakout-retest setups.
PLANTED_SETUPS = [
    ("SIEMENS", 4),
    ("TRENT", 7),
    ("CIPLA", 11),
    ("HAVELLS", 6),
    ("DLF", 14),
    ("TITAN", 9),
]
DEMO_HOLDING = ("TITAN", 5)
DEMO_DAY_ORDER = "DLF"


def _seed(symbol: str) -> int:
    return int(hashlib.sha256(symbol.encode()).hexdigest()[:12], 16)


def _tick_for(price: float) -> float:
    if price < 250:
        return 0.01
    if price < 1000:
        return 0.05
    if price < 5000:
        return 0.1
    if price < 10000:
        return 0.5
    return 1.0


def _trading_days(n: int) -> list[date]:
    days: list[date] = []
    d = date.today()
    while len(days) < n:
        if d.weekday() < 5:
            days.append(d)
        d -= timedelta(days=1)
    return list(reversed(days))


def _r(x: float, tick: float) -> float:
    return round(round(x / tick) * tick, 2)


def _random_walk(rng: random.Random, n: int, start: float) -> list[dict]:
    out, price = [], start
    for _ in range(n):
        o = price * (1 + rng.gauss(0, 0.004))
        c = o * (1 + rng.gauss(0.0004, 0.014))
        h = max(o, c) * (1 + abs(rng.gauss(0, 0.006)))
        l = min(o, c) * (1 - abs(rng.gauss(0, 0.006)))
        out.append({"open": o, "high": h, "low": l, "close": c, "volume": rng.uniform(0.6, 1.4) * 1_000_000})
        price = c
    return out


def _planted(rng: random.Random, n: int, start: float, age: int) -> list[dict]:
    """Random walk, then a 25-candle range, a 4x-volume breakout, a rally and a retest."""
    pre_len = n - 25 - 1 - age
    bars = _random_walk(rng, pre_len, start)
    top = bars[-1]["close"] * 1.02
    for _ in range(25):  # tight range capped below `top`
        c = top * rng.uniform(0.95, 0.985)
        o = top * rng.uniform(0.95, 0.985)
        bars.append({"open": o, "high": max(o, c) * 1.004, "low": min(o, c) * 0.996, "close": c,
                     "volume": rng.uniform(0.8, 1.2) * 1_000_000})
    b_low, b_high = top * 0.99, top * 1.05
    bars.append({"open": top * 0.995, "high": b_high, "low": b_low, "close": top * 1.045,
                 "volume": 4.5 * 1_000_000})
    mid = (b_high + b_low) / 2
    peak = top * rng.uniform(1.08, 1.12)
    up = max(1, age // 2)
    for i in range(age):
        if i < up:
            c = top * 1.045 + (peak / 1.004 - top * 1.045) * (i + 1) / up
        else:
            frac = (i - up + 1) / (age - up)
            c = peak / 1.004 + (mid * (1 + rng.uniform(-0.004, 0.004)) - peak / 1.004) * frac
        o = c * (1 + rng.gauss(0, 0.003))
        h = peak if i == up - 1 else max(o, c) * 1.003
        bars.append({"open": o, "high": h, "low": min(o, c) * 0.997, "close": c,
                     "volume": rng.uniform(0.8, 1.3) * 1_000_000})
    return bars


class DemoKite:
    def __init__(self) -> None:
        self._symbols = [c.symbol for c in load_universe().constituents]
        self._names = {c.symbol: c.company_name for c in load_universe().constituents}
        self._days = _trading_days(HISTORY_TRADING_DAYS)
        self._series: dict[int, list[dict]] = {}
        self._token_of: dict[str, int] = {}
        self._tick: dict[str, float] = {}
        planted = dict(PLANTED_SETUPS)
        for i, sym in enumerate(self._symbols):
            rng = random.Random(_seed(sym))
            start = rng.uniform(150, 4500)
            if sym in planted:
                bars = _planted(rng, HISTORY_TRADING_DAYS, start, planted[sym])
            else:
                bars = _random_walk(rng, HISTORY_TRADING_DAYS, start)
            tick = _tick_for(bars[-1]["close"])
            token = 100_000 + i * 7
            self._token_of[sym] = token
            self._tick[sym] = tick
            self._series[token] = [
                {
                    "date": datetime.combine(d, datetime.min.time()),
                    "open": _r(b["open"], tick),
                    "high": _r(b["high"], tick),
                    "low": _r(b["low"], tick),
                    "close": _r(b["close"], tick),
                    "volume": int(b["volume"]),
                }
                for d, b in zip(self._days, bars)
            ]

    # -- market data ------------------------------------------------------------------

    def profile(self) -> dict:
        return {
            "user_id": "DEMO01",
            "user_name": "Demo Trader",
            "user_shortname": "Demo",
            "email": "demo@example.com",
            "broker": "ZERODHA",
            "products": ["CNC", "NRML", "MIS", "BO", "CO"],
            "exchanges": ["NSE", "BSE", "NFO", "MCX"],
            "order_types": ["MARKET", "LIMIT", "SL", "SL-M"],
        }

    def instruments(self, exchange: str | None = None) -> list[dict]:
        return [
            {
                "instrument_token": self._token_of[s],
                "tradingsymbol": s,
                "name": self._names.get(s, s).upper(),
                "tick_size": self._tick[s],
                "instrument_type": "EQ",
                "segment": "NSE",
                "exchange": "NSE",
            }
            for s in self._symbols
        ]

    def historical_data(self, instrument_token, from_date, to_date, interval, continuous=False, oi=False):
        f = from_date.date() if isinstance(from_date, datetime) else from_date
        t = to_date.date() if isinstance(to_date, datetime) else to_date
        return [c for c in self._series.get(int(instrument_token), []) if f <= c["date"].date() <= t]

    def last_close(self, token: int) -> float:
        return self._series[token][-1]["close"]

    def tick_size(self, token: int) -> float:
        sym = next(s for s, t in self._token_of.items() if t == token)
        return self._tick[sym]

    def ohlc(self, *instruments) -> dict:
        out = {}
        for key in instruments[0] if len(instruments) == 1 and isinstance(instruments[0], list) else instruments:
            sym = key.split(":", 1)[-1]
            token = self._token_of.get(sym)
            if token is None:
                continue
            last = self._series[token][-1]
            out[key] = {
                "instrument_token": token,
                "last_price": last["close"],
                "ohlc": {k: last[k] for k in ("open", "high", "low", "close")},
            }
        return out

    def ltp(self, *instruments) -> dict:
        return {k: {"instrument_token": v["instrument_token"], "last_price": v["last_price"]}
                for k, v in self.ohlc(*instruments).items()}

    def quote(self, *instruments) -> dict:
        return self.ohlc(*instruments)

    # -- fake account (read-only) -------------------------------------------------------

    def get_gtts(self) -> list:
        return []

    def orders(self) -> list:
        return [
            {
                "order_id": "DEMO-ORDER-1",
                "tradingsymbol": DEMO_DAY_ORDER,
                "exchange": "NSE",
                "transaction_type": "BUY",
                "product": "CNC",
                "status": "OPEN",
                "quantity": 1,
                "order_timestamp": datetime.now(),
            }
        ]

    def positions(self) -> dict:
        return {"net": [], "day": []}

    def holdings(self) -> list:
        sym, qty = DEMO_HOLDING
        return [{"tradingsymbol": sym, "exchange": "NSE", "quantity": qty, "t1_quantity": 0}]
