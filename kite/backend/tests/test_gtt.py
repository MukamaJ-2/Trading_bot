"""GTT simulation tests against a mocked Kite account. No real orders anywhere."""

import threading
from datetime import datetime, timedelta
from decimal import Decimal

import pytest
from fastapi.testclient import TestClient

from app import main
from app.gtt import (
    Candidate,
    DummyGttStore,
    GttService,
    is_tick_multiple,
    round_to_tick,
)
from app.kite_service import WRITE_METHODS, ReadOnlyKite, ReadOnlyViolation


class MockKite:
    """Configurable read-only account state. Every write method records and explodes."""

    def __init__(self, gtts=None, orders=None, positions=None, holdings=None, ticks=None):
        self._gtts = gtts or []
        self._orders = orders or []
        self._positions = positions or {"net": [], "day": []}
        self._holdings = holdings or []
        self._ticks = ticks or {}
        self.write_calls = []
        for name in WRITE_METHODS:
            setattr(self, name, self._forbidden(name))

    def _forbidden(self, name):
        def call(*args, **kwargs):
            self.write_calls.append(name)
            raise AssertionError(f"forbidden broker method called: {name}")
        return call

    def get_gtts(self):
        return self._gtts

    def orders(self):
        return self._orders

    def positions(self):
        return self._positions

    def holdings(self):
        return self._holdings

    def instruments(self, exchange=None):
        return [
            {"instrument_token": 1000 + i, "tradingsymbol": s, "name": s, "tick_size": t,
             "instrument_type": "EQ", "segment": "NSE"}
            for i, (s, t) in enumerate(self._ticks.items())
        ]


TICKS = {"SIEMENS": Decimal("0.1"), "INFY": Decimal("0.05"), "TCS": Decimal("0.1"), "ITC": Decimal("0.01")}


def make_service(tmp_path):
    return GttService(DummyGttStore(tmp_path / "dummy.json"), lambda kite, s: TICKS.get(s))


def siemens(**kw):
    base = dict(symbol="SIEMENS", quantity=1, buy_price=3903.3, stoploss=3708.1, last_price=4043)
    base.update(kw)
    return Candidate(**base)


# -- tick size -----------------------------------------------------------------------------


def test_round_to_tick_uses_exact_decimals():
    assert round_to_tick(Decimal("3708.135"), Decimal("0.1")) == Decimal("3708.1")
    assert round_to_tick(Decimal("101.03"), Decimal("0.05")) == Decimal("101.05")
    assert round_to_tick(Decimal("101.02"), Decimal("0.05")) == Decimal("101.00")
    assert round_to_tick(Decimal("0.1") + Decimal("0.2"), Decimal("0.05")) == Decimal("0.30")
    assert is_tick_multiple(Decimal("3903.3"), Decimal("0.1"))
    assert not is_tick_multiple(Decimal("3903.33"), Decimal("0.1"))


# -- state check -----------------------------------------------------------------------------


def test_state_check_clear_matches_example(tmp_path):
    kite = MockKite()
    [r] = make_service(tmp_path).check_state(ReadOnlyKite(kite), [siemens()])
    assert r["account_state"] == "clear"
    assert r["buy_status"] == "ready"
    assert r["buy_price"] == 3903.3 and r["stoploss"] == 3708.1 and r["tick_size"] == 0.1
    assert r["stoploss_status"] == "planned_after_buy"
    assert r["message"] == "Ready for buy GTT placement."
    assert kite.write_calls == []
    assert not (tmp_path / "dummy.json").exists()  # state check never writes


def test_state_check_invalid_and_waiting(tmp_path):
    svc = make_service(tmp_path)
    no_buy, no_ltp, unknown = svc.check_state(
        ReadOnlyKite(MockKite()),
        [siemens(buy_price=None, stoploss=None), siemens(symbol="INFY", buy_price=1500.02, last_price=None),
         siemens(symbol="NOPE")],
    )
    assert (no_buy["account_state"], no_buy["buy_status"]) == ("invalid", "not_available")
    assert no_buy["message"] == "Buy price is not available for this row."
    assert no_buy["stoploss"] is None and no_buy["stoploss_status"] == "not_available"
    assert (no_ltp["account_state"], no_ltp["buy_status"]) == ("waiting", "waiting_for_ltp")
    assert no_ltp["buy_price"] == 1500.0  # rounded to the 0.05 tick
    assert no_ltp["message"] == "Waiting for LTP."
    assert (unknown["account_state"], unknown["message"]) == ("invalid", "Trigger price should be a multiple of tick size.")


def test_state_check_blocked_states(tmp_path):
    today = datetime.now()
    kite = MockKite(
        gtts=[
            {"id": 111, "status": "active",
             "condition": {"exchange": "NSE", "tradingsymbol": "SIEMENS", "trigger_values": [3903.3]},
             "orders": [{"transaction_type": "BUY", "quantity": 1, "price": 3903.3}]},
            {"id": 222, "status": "active",
             "condition": {"exchange": "NSE", "tradingsymbol": "ITC", "trigger_values": [400.0]},
             "orders": [{"transaction_type": "SELL", "quantity": 3, "price": 400.0}]},
            {"id": 333, "status": "cancelled",
             "condition": {"exchange": "NSE", "tradingsymbol": "TCS", "trigger_values": [3000]},
             "orders": [{"transaction_type": "BUY"}]},
        ],
        orders=[
            {"order_id": "O1", "tradingsymbol": "INFY", "exchange": "NSE", "transaction_type": "BUY",
             "product": "CNC", "status": "OPEN", "order_timestamp": today},
            {"order_id": "O2", "tradingsymbol": "TCS", "exchange": "NSE", "transaction_type": "BUY",
             "product": "CNC", "status": "REJECTED", "order_timestamp": today},
            {"order_id": "O3", "tradingsymbol": "TCS", "exchange": "NSE", "transaction_type": "BUY",
             "product": "MIS", "status": "COMPLETE", "order_timestamp": today},
            {"order_id": "O4", "tradingsymbol": "TCS", "exchange": "NSE", "transaction_type": "BUY",
             "product": "CNC", "status": "OPEN", "order_timestamp": today - timedelta(days=1)},
        ],
        holdings=[{"tradingsymbol": "ITC", "exchange": "NSE", "quantity": 3, "t1_quantity": 0}],
    )
    svc = make_service(tmp_path)
    s, i, t, itc = svc.check_state(
        ReadOnlyKite(kite),
        [siemens(), siemens(symbol="INFY", buy_price=1500), siemens(symbol="TCS", buy_price=3000),
         siemens(symbol="ITC", buy_price=410)],
    )
    assert (s["account_state"], s["buy_status"], s["buy_trigger_id"]) == ("already_active", "already_active", 111)
    assert s["message"] == "Skipped: buy GTT already active."
    assert (i["account_state"], i["day_buy_order_id"]) == ("blocked", "O1")
    assert i["message"] == "Skipped: day BUY order already exists."
    # Cancelled GTT, rejected order, intraday product and yesterday's order don't block.
    assert t["buy_status"] == "ready"
    assert itc["account_state"] == "blocked" and itc["position_quantity"] == 3
    assert itc["message"] == "Skipped: existing position/holding quantity is 3."
    assert itc["active_stoploss_trigger_id"] == 222
    assert kite.write_calls == []


def test_net_position_blocks(tmp_path):
    kite = MockKite(positions={"net": [{"tradingsymbol": "SIEMENS", "exchange": "NSE", "quantity": 2}], "day": []})
    [r] = make_service(tmp_path).check_state(ReadOnlyKite(kite), [siemens()])
    assert r["account_state"] == "blocked" and r["position_quantity"] == 2


# -- dummy creation ------------------------------------------------------------------------


def test_dummy_creation_and_repeat_prevention(tmp_path):
    kite = MockKite()
    svc = make_service(tmp_path)
    [r] = svc.create_dummy_gtts(ReadOnlyKite(kite), [siemens()])
    assert r["buy_status"] == "success"
    assert r["buy_trigger_id"] == "DUMMY-SIEMENS-000001"
    assert r["message"] == "Dummy buy GTT created. No order sent to Kite. Stoploss planned after buy execution."
    assert r["stoploss_status"] == "planned_after_buy" and r["stoploss_trigger_id"] is None

    [again] = svc.create_dummy_gtts(ReadOnlyKite(kite), [siemens()])
    assert again["buy_status"] == "already_active"
    assert again["buy_trigger_id"] == "DUMMY-SIEMENS-000001"
    assert again["message"] == "Skipped: dummy buy GTT already active."

    # Survives a "restart": a brand-new service on the same file still sees the record.
    [after_restart] = make_service(tmp_path).create_dummy_gtts(ReadOnlyKite(kite), [siemens()])
    assert after_restart["buy_status"] == "already_active"

    records = svc.store.list_records()
    assert len(records) == 1
    rec = records[0]
    assert rec["dummy"] is True and rec["status"] == "active"
    assert (rec["transaction_type"], rec["product"], rec["exchange"], rec["order_type"], rec["quantity"]) == (
        "BUY", "CNC", "NSE", "LIMIT", 1)
    assert rec["trigger_price"] == rec["price"] == "3903.3"
    assert kite.write_calls == []


def test_same_symbol_twice_in_one_request(tmp_path):
    svc = make_service(tmp_path)
    a, b = svc.create_dummy_gtts(ReadOnlyKite(MockKite()), [siemens(), siemens()])
    assert a["buy_status"] == "success" and b["buy_status"] == "already_active"


def test_concurrent_requests_create_one_record(tmp_path):
    svc = make_service(tmp_path)
    barrier = threading.Barrier(8)
    out = []

    def worker():
        barrier.wait()
        out.extend(svc.create_dummy_gtts(ReadOnlyKite(MockKite()), [siemens()]))

    threads = [threading.Thread(target=worker) for _ in range(8)]
    [t.start() for t in threads]
    [t.join() for t in threads]
    assert sorted(r["buy_status"] for r in out) == ["already_active"] * 7 + ["success"]
    assert len(svc.store.list_records()) == 1


def test_non_ready_rows_are_not_created(tmp_path):
    svc = make_service(tmp_path)
    kite = MockKite(holdings=[{"tradingsymbol": "INFY", "exchange": "NSE", "quantity": 1}])
    res = svc.create_dummy_gtts(
        ReadOnlyKite(kite),
        [siemens(buy_price=None), siemens(symbol="INFY", buy_price=1500), siemens(symbol="TCS", buy_price=3000, last_price=None)],
    )
    assert [r["buy_status"] for r in res] == ["not_available", "blocked", "waiting_for_ltp"]
    assert svc.store.list_records() == []


def test_dummy_save_failure_reports_failed(tmp_path, monkeypatch):
    svc = make_service(tmp_path)

    def boom(data):
        raise OSError("disk full")

    monkeypatch.setattr(svc.store, "save", boom)
    [r] = svc.create_dummy_gtts(ReadOnlyKite(MockKite()), [siemens()])
    assert r["buy_status"] == "failed"
    assert r["message"] == "Unable to create dummy GTT record: disk full"
    assert r["buy_trigger_id"] is None


# -- read-only guard -------------------------------------------------------------------------


@pytest.mark.parametrize("name", sorted(WRITE_METHODS))
def test_read_only_wrapper_refuses_write_methods(name):
    kite = MockKite()
    with pytest.raises(ReadOnlyViolation):
        getattr(ReadOnlyKite(kite), name)
    assert kite.write_calls == []


# -- HTTP endpoints ---------------------------------------------------------------------------


@pytest.fixture
def client(tmp_path, monkeypatch):
    kite = MockKite(ticks={k: float(v) for k, v in TICKS.items()})
    monkeypatch.setattr(main.session, "_client", ReadOnlyKite(kite))
    monkeypatch.setattr(main.gtt_service, "store", DummyGttStore(tmp_path / "api_dummy.json"))
    monkeypatch.setattr(main.instruments, "_loaded_on", None)
    yield TestClient(main.app), kite
    main.instruments._loaded_on = None


ORDER = {"symbol": "SIEMENS", "quantity": 1, "buy_price": 3903.3, "stoploss": 3708.1, "last_price": 4043}


def test_state_endpoint_reads_only(client):
    c, kite = client
    r = c.post("/api/algo-orders/gtt-state", json={"orders": [ORDER]})
    assert r.status_code == 200
    [row] = r.json()["results"]
    assert row["buy_status"] == "ready" and row["tick_size"] == 0.1
    expected_keys = {
        "symbol", "quantity", "buy_price", "stoploss", "tick_size", "last_price", "account_state",
        "position_quantity", "active_buy_trigger_id", "active_stoploss_trigger_id", "day_buy_order_id",
        "day_buy_order_status", "buy_status", "buy_trigger_id", "stoploss_status", "stoploss_trigger_id", "message",
    }
    assert set(row) == expected_keys
    assert kite.write_calls == []


@pytest.mark.parametrize("payload", [{"orders": [ORDER]}, {"orders": [ORDER], "confirm_live": False}])
def test_live_endpoint_requires_confirm_live(client, payload):
    c, kite = client
    assert c.post("/api/algo-orders/live-gtt", json=payload).status_code == 400
    assert main.gtt_service.store.list_records() == []


def test_live_endpoint_only_creates_dummies(client):
    c, kite = client
    body = {"orders": [ORDER], "confirm_live": True}
    first = c.post("/api/algo-orders/live-gtt", json=body).json()
    assert first["real_orders_sent"] == 0
    assert first["results"][0]["buy_trigger_id"] == "DUMMY-SIEMENS-000001"
    second = c.post("/api/algo-orders/live-gtt", json=body).json()
    assert second["results"][0]["buy_status"] == "already_active"
    state = c.post("/api/algo-orders/gtt-state", json={"orders": [ORDER]}).json()["results"][0]
    assert state["account_state"] == "already_active"
    assert state["buy_trigger_id"] == "DUMMY-SIEMENS-000001"
    assert kite.write_calls == []  # even with confirm_live true
