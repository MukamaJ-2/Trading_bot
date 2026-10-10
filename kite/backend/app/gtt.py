"""GTT Placement workflow: SIMULATION ONLY.

Nothing in this module sends anything to Kite. It reads the real account state
(GTTs, orders, positions, holdings) to avoid duplicates, and stores "dummy" buy GTT
records in a local JSON file. Dummy records never create fills, positions, holdings
or stoploss orders, and never change the real Kite account.

Duplicate prevention runs on the backend: the state check and the dummy-record
creation happen inside one lock (a thread lock plus an OS file lock), so repeated or
concurrent requests, and backend restarts, cannot create a second record for a
symbol that already has an active one.
"""

from __future__ import annotations

import fcntl
import json
import os
import threading
from contextlib import contextmanager
from dataclasses import dataclass, field
from datetime import date, datetime
from decimal import ROUND_HALF_UP, Decimal, InvalidOperation
from pathlib import Path
from typing import Any, Callable, Iterator
from zoneinfo import ZoneInfo

IST = ZoneInfo("Asia/Kolkata")

STOPLOSS_FACTOR = Decimal("0.95")
QUANTITY = 1
EXCHANGE = "NSE"
DELIVERY_PRODUCTS = {"CNC", "MTF"}
INACTIVE_ORDER_STATUSES = {"CANCELLED", "REJECTED"}

MSG_READY = "Ready for buy GTT placement."
MSG_CREATED = "Dummy buy GTT created. No order sent to Kite. Stoploss planned after buy execution."
MSG_GTT_ACTIVE = "Skipped: buy GTT already active."
MSG_DUMMY_ACTIVE = "Skipped: dummy buy GTT already active."
MSG_DAY_ORDER = "Skipped: day BUY order already exists."
MSG_POSITION = "Skipped: existing position/holding quantity is {qty}."
MSG_WAITING = "Waiting for LTP."
MSG_NO_BUY_PRICE = "Buy price is not available for this row."
MSG_TICK = "Trigger price should be a multiple of tick size."
MSG_CREATE_FAILED = "Unable to create dummy GTT record: {reason}"


# -- tick size ----------------------------------------------------------------------


def to_decimal(value: Any) -> Decimal | None:
    if value is None or value == "":
        return None
    try:
        d = Decimal(str(value))
    except (InvalidOperation, ValueError):
        return None
    return d if d.is_finite() else None


def round_to_tick(price: Decimal, tick: Decimal) -> Decimal:
    """Round to the nearest multiple of the tick size, using exact decimal math."""
    steps = (price / tick).quantize(Decimal("1"), rounding=ROUND_HALF_UP)
    return (steps * tick).quantize(tick)


def is_tick_multiple(price: Decimal, tick: Decimal) -> bool:
    return tick > 0 and price > 0 and price % tick == 0


def _num(d: Decimal | None) -> float | None:
    return float(d) if d is not None else None


# -- account state from Kite (read-only) ---------------------------------------------


@dataclass
class AccountSnapshot:
    active_buy_gtts: dict[str, list[tuple[Any, list[Decimal]]]] = field(default_factory=dict)
    active_sell_gtts: dict[str, Any] = field(default_factory=dict)
    day_buy_orders: dict[str, tuple[Any, str]] = field(default_factory=dict)
    position_qty: dict[str, int] = field(default_factory=dict)
    holding_qty: dict[str, int] = field(default_factory=dict)

    @classmethod
    def from_kite(cls, kite: Any, today: date | None = None) -> "AccountSnapshot":
        """Reads gtts, orders, positions and holdings. Only read methods are used."""
        today = today or datetime.now(IST).date()
        snap = cls()

        for g in kite.get_gtts() or []:
            if str(g.get("status", "")).lower() != "active":
                continue
            cond = g.get("condition") or {}
            if cond.get("exchange", EXCHANGE) != EXCHANGE:
                continue
            symbol = cond.get("tradingsymbol")
            orders = g.get("orders") or []
            if not symbol or not orders:
                continue
            triggers = [d for d in (to_decimal(v) for v in cond.get("trigger_values") or []) if d is not None]
            side = str(orders[0].get("transaction_type", "")).upper()
            if side == "BUY":
                snap.active_buy_gtts.setdefault(symbol, []).append((g.get("id"), triggers))
            elif side == "SELL":
                snap.active_sell_gtts.setdefault(symbol, g.get("id"))

        for o in kite.orders() or []:
            if (
                str(o.get("transaction_type", "")).upper() != "BUY"
                or o.get("exchange") != EXCHANGE
                or str(o.get("product", "")).upper() not in DELIVERY_PRODUCTS
                or str(o.get("status", "")).upper() in INACTIVE_ORDER_STATUSES
            ):
                continue
            ts = o.get("order_timestamp")
            if isinstance(ts, str):
                try:
                    ts = datetime.fromisoformat(ts)
                except ValueError:
                    ts = None
            if isinstance(ts, datetime) and ts.date() != today:
                continue
            snap.day_buy_orders.setdefault(o["tradingsymbol"], (o.get("order_id"), o.get("status")))

        positions = kite.positions() or {}
        for p in positions.get("net", []) if isinstance(positions, dict) else []:
            if p.get("exchange") == EXCHANGE and p.get("quantity"):
                sym = p["tradingsymbol"]
                snap.position_qty[sym] = snap.position_qty.get(sym, 0) + int(p["quantity"])

        for h in kite.holdings() or []:
            if h.get("exchange", EXCHANGE) != EXCHANGE:
                continue
            qty = int(h.get("quantity") or 0) + int(h.get("t1_quantity") or 0)
            if qty:
                sym = h["tradingsymbol"]
                snap.holding_qty[sym] = snap.holding_qty.get(sym, 0) + qty

        return snap


# -- dummy GTT store --------------------------------------------------------------------


class DummyGttStore:
    """Dummy GTT records in a local JSON file, guarded by thread + file locks."""

    def __init__(self, path: Path):
        self.path = Path(path)
        self._lock = threading.RLock()

    @contextmanager
    def transaction(self) -> Iterator[dict]:
        with self._lock:
            self.path.parent.mkdir(parents=True, exist_ok=True)
            lock_path = self.path.with_suffix(self.path.suffix + ".lock")
            with open(lock_path, "a+") as lock_file:
                fcntl.flock(lock_file, fcntl.LOCK_EX)
                try:
                    data = self._read()
                    before = json.dumps(data, sort_keys=True)
                    yield data
                    if json.dumps(data, sort_keys=True) != before:
                        self.save(data)
                finally:
                    fcntl.flock(lock_file, fcntl.LOCK_UN)

    def _read(self) -> dict:
        if not self.path.exists():
            return {"next_seq": 1, "records": []}
        data = json.loads(self.path.read_text())
        data.setdefault("next_seq", 1)
        data.setdefault("records", [])
        return data

    def save(self, data: dict) -> None:
        """Atomic write. Call only inside transaction()."""
        tmp = self.path.with_suffix(self.path.suffix + ".tmp")
        with open(tmp, "w") as f:
            json.dump(data, f, indent=2)
            f.flush()
            os.fsync(f.fileno())
        os.replace(tmp, self.path)

    def list_records(self) -> list[dict]:
        with self.transaction() as data:
            return list(data["records"])


def _active_dummy(records: list[dict], symbol: str, trigger: Decimal | None) -> dict | None:
    for r in records:
        if r.get("status") != "active" or r.get("transaction_type") != "BUY":
            continue
        if r.get("symbol") == symbol:
            return r  # covers "same symbol" and "same symbol and buy trigger"
    return None


# -- evaluation -------------------------------------------------------------------------


@dataclass
class Candidate:
    symbol: str
    quantity: int = QUANTITY
    buy_price: Any = None
    stoploss: Any = None
    last_price: Any = None


def evaluate(
    c: Candidate,
    tick_size: Decimal | None,
    snap: AccountSnapshot,
    dummy_records: list[dict],
) -> dict:
    """The read-only state of one candidate. buy_status is 'ready' when clear."""
    symbol = c.symbol
    last_price = to_decimal(c.last_price)
    if last_price is not None and last_price <= 0:
        last_price = None
    pos_qty = snap.position_qty.get(symbol, 0) + snap.holding_qty.get(symbol, 0)
    buy_gtts = snap.active_buy_gtts.get(symbol, [])
    day_order = snap.day_buy_orders.get(symbol)

    result: dict[str, Any] = {
        "symbol": symbol,
        "quantity": QUANTITY,
        "buy_price": None,
        "stoploss": None,
        "tick_size": _num(tick_size),
        "last_price": _num(last_price),
        "account_state": "clear",
        "position_quantity": pos_qty,
        "active_buy_trigger_id": buy_gtts[0][0] if buy_gtts else None,
        "active_stoploss_trigger_id": snap.active_sell_gtts.get(symbol),
        "day_buy_order_id": day_order[0] if day_order else None,
        "day_buy_order_status": day_order[1] if day_order else None,
        "buy_status": "ready",
        "buy_trigger_id": None,
        "stoploss_status": "planned_after_buy",
        "stoploss_trigger_id": None,
        "message": MSG_READY,
    }

    def done(account_state: str, buy_status: str, message: str, **extra: Any) -> dict:
        result.update(account_state=account_state, buy_status=buy_status, message=message, **extra)
        return result

    buy_raw = to_decimal(c.buy_price)
    if buy_raw is None or buy_raw <= 0:
        return done("invalid", "not_available", MSG_NO_BUY_PRICE, stoploss_status="not_available")

    if tick_size is None or tick_size <= 0:
        return done("invalid", "not_placed", MSG_TICK, stoploss_status="not_available")
    buy = round_to_tick(buy_raw, tick_size)
    stoploss = round_to_tick(buy * STOPLOSS_FACTOR, tick_size)
    result["buy_price"], result["stoploss"] = _num(buy), _num(stoploss)
    if not (is_tick_multiple(buy, tick_size) and is_tick_multiple(stoploss, tick_size)):
        return done("invalid", "not_placed", MSG_TICK)

    dummy = _active_dummy(dummy_records, symbol, buy)
    if dummy:
        return done("already_active", "already_active", MSG_DUMMY_ACTIVE, buy_trigger_id=dummy["trigger_id"])

    same_trigger = next((gid for gid, trig in buy_gtts if buy in trig), None)
    if buy_gtts:
        gid = same_trigger or buy_gtts[0][0]
        return done("already_active", "already_active", MSG_GTT_ACTIVE, buy_trigger_id=gid, active_buy_trigger_id=gid)

    if day_order:
        return done("blocked", "blocked", MSG_DAY_ORDER)

    if snap.position_qty.get(symbol, 0) != 0 or snap.holding_qty.get(symbol, 0) > 0:
        return done("blocked", "blocked", MSG_POSITION.format(qty=pos_qty))

    if last_price is None:
        return done("waiting", "waiting_for_ltp", MSG_WAITING)

    return result


# -- service ------------------------------------------------------------------------------


class GttService:
    """Ties evaluation to Kite state and the dummy store. Never places orders."""

    def __init__(self, store: DummyGttStore, tick_size_for: Callable[[Any, str], Decimal | None]):
        self.store = store
        self.tick_size_for = tick_size_for

    def check_state(self, kite: Any, candidates: list[Candidate]) -> list[dict]:
        snap = AccountSnapshot.from_kite(kite)
        with self.store.transaction() as data:
            records = list(data["records"])
        return [evaluate(c, self.tick_size_for(kite, c.symbol), snap, records) for c in candidates]

    def create_dummy_gtts(self, kite: Any, candidates: list[Candidate]) -> list[dict]:
        """Repeats every state check, then stores dummy BUY GTTs for clear rows only."""
        results = []
        # One lock around read-check-write: concurrent requests are serialized, and a
        # symbol repeated within this request sees the record created moments before.
        with self.store.transaction() as data:
            snap = AccountSnapshot.from_kite(kite)
            for c in candidates:
                res = evaluate(c, self.tick_size_for(kite, c.symbol), snap, data["records"])
                if res["buy_status"] != "ready":
                    results.append(res)
                    continue
                appended = False
                try:
                    seq = int(data["next_seq"])
                    trigger_id = f"DUMMY-{c.symbol}-{seq:06d}"
                    data["records"].append(
                        {
                            "trigger_id": trigger_id,
                            "dummy": True,
                            "status": "active",
                            "symbol": c.symbol,
                            "exchange": EXCHANGE,
                            "transaction_type": "BUY",
                            "product": "CNC",
                            "order_type": "LIMIT",
                            "quantity": QUANTITY,
                            "trigger_price": str(res["buy_price"]),
                            "price": str(res["buy_price"]),
                            "planned_stoploss": str(res["stoploss"]),
                            "tick_size": str(res["tick_size"]),
                            "last_price_at_creation": res["last_price"],
                            "created_at": datetime.now(IST).isoformat(timespec="seconds"),
                        }
                    )
                    appended = True
                    data["next_seq"] = seq + 1
                    # Persist before reporting success, so a reported DUMMY- id always exists.
                    self.store.save(data)
                    res.update(buy_status="success", buy_trigger_id=trigger_id, message=MSG_CREATED)
                except Exception as exc:  # never fall back to real placement
                    if appended:
                        data["records"].pop()
                        data["next_seq"] = seq
                    res.update(buy_status="failed", message=MSG_CREATE_FAILED.format(reason=exc))
                results.append(res)
        return results
