"""FastAPI backend for the Kite dashboard.

Run:  uvicorn app.main:app --reload --port 8000   (from kite/backend)

No endpoint here places, modifies, cancels or deletes a real order or GTT. The GTT
endpoints only read Kite state and store local dummy records.
"""

from __future__ import annotations

import logging
from typing import Any

from fastapi import FastAPI, HTTPException, Query, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from fastapi.concurrency import run_in_threadpool
from pydantic import BaseModel, Field

from . import config
from .gtt import Candidate, DummyGttStore, GttService
from .kite_service import KiteSession, NotLoggedIn, ReadOnlyViolation, is_token_error
from .market_data import instruments
from .services import scanner_cache, sma_signals
from .ticks import TickHub

logging.basicConfig(level=logging.INFO)

app = FastAPI(title="Kite Algo Dashboard API")
app.add_middleware(
    CORSMiddleware,
    allow_origins=config.CORS_ORIGINS,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

session = KiteSession()
tick_hub = TickHub(session)


def _tick_size_for(kite: Any, symbol: str):
    inst = instruments.get(kite, symbol)
    return inst.tick_size if inst else None


gtt_service = GttService(DummyGttStore(config.DUMMY_GTT_FILE), _tick_size_for)


@app.exception_handler(NotLoggedIn)
async def _not_logged_in(_, exc: NotLoggedIn):
    return JSONResponse(status_code=401, content={"detail": str(exc)})


@app.exception_handler(ReadOnlyViolation)
async def _read_only(_, exc: ReadOnlyViolation):
    return JSONResponse(status_code=403, content={"detail": str(exc)})


async def _kite_call(fn, *args, **kwargs):
    """Runs a blocking Kite call in a thread and turns Kite errors into HTTP errors."""
    try:
        return await run_in_threadpool(fn, *args, **kwargs)
    except (NotLoggedIn, ReadOnlyViolation, HTTPException):
        raise
    except Exception as exc:
        if is_token_error(exc):
            session.logout()
            raise HTTPException(401, "Kite session expired. Please log in again.") from exc
        raise HTTPException(502, f"Kite error: {exc}") from exc


# -- auth ------------------------------------------------------------------------------


class LoginBody(BaseModel):
    api_key: str = Field(min_length=1)
    api_secret: str = Field(min_length=1)
    request_token: str = Field(min_length=1)


@app.get("/api/auth/status")
def auth_status():
    return session.status()


@app.post("/api/auth/login")
async def login(body: LoginBody):
    try:
        result = await run_in_threadpool(
            session.login, body.api_key.strip(), body.api_secret.strip(), body.request_token.strip()
        )
    except Exception as exc:
        raise HTTPException(400, f"Login failed: {exc}") from exc
    return {"ok": True, **result}  # never includes the access token


@app.post("/api/auth/logout")
def logout():
    session.logout()
    return {"ok": True}


@app.get("/api/auth/login-url")
def login_url(api_key: str):
    return {"url": f"https://kite.zerodha.com/connect/login?v=3&api_key={api_key.strip()}"}


# -- user -------------------------------------------------------------------------------


@app.get("/api/profile")
async def profile():
    p = await _kite_call(session.client().profile)
    return {
        "user_name": p.get("user_name"),
        "user_id": p.get("user_id"),
        "email": p.get("email"),
        "broker": p.get("broker"),
        "products": p.get("products", []),
        "exchanges": p.get("exchanges", []),
        "order_types": p.get("order_types", []),
        "demo": session.demo,
    }


# -- signals (SMA crossover) ------------------------------------------------------------


@app.get("/api/signals")
async def signals(
    short: int = Query(6, ge=1, le=200),
    long: int = Query(30, ge=2, le=400),
    lookback_days: int = Query(120, ge=10, le=2000),
    max_stocks: int = Query(100, ge=1, le=100),
):
    if short >= long:
        raise HTTPException(400, "Short SMA must be smaller than Long SMA.")
    return await _kite_call(sma_signals, session.client(), short, long, lookback_days, max_stocks)


# -- algo signals data ------------------------------------------------------------------


@app.get("/api/scanner-data")
async def scanner_data():
    return await _kite_call(scanner_cache.get, session.client())


@app.post("/api/scanner-data/refresh")
async def scanner_data_refresh():
    data = await _kite_call(scanner_cache.get, session.client(), True)
    return {"ok": True, "metadata": data["metadata"]}


@app.get("/api/ohlc")
async def ohlc(symbols: str = Query(..., description="Comma-separated NSE symbols")):
    syms = [s.strip() for s in symbols.split(",") if s.strip()][:500]
    if not syms:
        return {}
    raw = await _kite_call(session.client().ohlc, [f"NSE:{s}" for s in syms])
    return {
        k.split(":", 1)[-1]: {
            "instrument_token": v.get("instrument_token"),
            "last_price": v.get("last_price"),
            "ohlc": v.get("ohlc"),
        }
        for k, v in raw.items()
    }


@app.websocket("/ws/ticks")
async def ws_ticks(ws: WebSocket, tokens: str = "", mode: str = "full"):
    await ws.accept()
    wanted = {int(t) for t in tokens.split(",") if t.strip().isdigit()}
    await tick_hub.connect(ws, wanted)
    try:
        while True:
            await ws.receive_text()  # keep-alive; the browser sends nothing meaningful
    except WebSocketDisconnect:
        pass
    finally:
        tick_hub.disconnect(ws)


# -- GTT placement (simulation only) -----------------------------------------------------


class OrderIn(BaseModel):
    symbol: str = Field(min_length=1)
    quantity: int = 1
    buy_price: float | None = None
    stoploss: float | None = None
    last_price: float | None = None


class StateBody(BaseModel):
    orders: list[OrderIn] = Field(default_factory=list, max_length=200)


class LiveBody(StateBody):
    # Kept for compatibility only. It authorizes the dummy simulation, never a real order.
    confirm_live: bool | None = None


def _candidates(orders: list[OrderIn]) -> list[Candidate]:
    return [
        Candidate(symbol=o.symbol.strip().upper(), quantity=o.quantity, buy_price=o.buy_price,
                  stoploss=o.stoploss, last_price=o.last_price)
        for o in orders
    ]


@app.post("/api/algo-orders/gtt-state")
async def gtt_state(body: StateBody):
    """Read-only: whether each candidate is clear, blocked, already active, waiting or invalid."""
    results = await _kite_call(gtt_service.check_state, session.client(), _candidates(body.orders))
    return {"mode": "simulation", "results": results}


@app.post("/api/algo-orders/live-gtt")
async def live_gtt(body: LiveBody):
    """Creates DUMMY buy GTT records only. Nothing is ever sent to Kite."""
    if body.confirm_live is not True:
        raise HTTPException(400, "confirm_live must be true. (It only authorizes dummy GTT simulation.)")
    results = await _kite_call(gtt_service.create_dummy_gtts, session.client(), _candidates(body.orders))
    return {"mode": "simulation", "real_orders_sent": 0, "results": results}


@app.get("/api/algo-orders/dummy-gtts")
async def dummy_gtts():
    return {"records": await run_in_threadpool(gtt_service.store.list_records)}


@app.get("/api/health")
def health():
    return {"ok": True, "demo": config.DEMO_MODE}
