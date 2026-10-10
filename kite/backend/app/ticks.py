"""Live ticks relayed to the browser over /ws/ticks.

One upstream connection (Kite's KiteTicker, or a simulated feed in demo mode) is
shared by every browser connection. The upstream subscription is the union of the
tokens all connected browsers asked for. The access token stays on the backend.
"""

from __future__ import annotations

import asyncio
import logging
import random
import threading
from datetime import date, datetime
from typing import Any

from fastapi import WebSocket

log = logging.getLogger("ticks")


def _clean_tick(t: dict) -> dict:
    out: dict[str, Any] = {}
    for key in ("instrument_token", "last_price", "change", "volume_traded", "last_traded_quantity",
                "average_traded_price", "ohlc", "last_trade_time", "exchange_timestamp", "mode"):
        if key in t:
            v = t[key]
            out[key] = v.isoformat() if isinstance(v, (datetime, date)) else v
    return out


class TickHub:
    def __init__(self, session: Any):
        self.session = session
        self.clients: dict[WebSocket, set[int]] = {}
        self.loop: asyncio.AbstractEventLoop | None = None
        self.status = "idle"
        self.status_message = "No live subscription yet."
        self._lock = threading.Lock()
        self._ticker: Any = None
        self._subscribed: set[int] = set()
        self._demo_task: asyncio.Task | None = None
        self._demo_prices: dict[int, float] = {}

    # -- browser side ------------------------------------------------------------------

    async def connect(self, ws: WebSocket, tokens: set[int]) -> None:
        self.loop = asyncio.get_running_loop()
        self.clients[ws] = tokens
        await self._send(ws, self._status_payload())
        self._resubscribe()

    def disconnect(self, ws: WebSocket) -> None:
        self.clients.pop(ws, None)
        self._resubscribe()

    def wanted(self) -> set[int]:
        out: set[int] = set()
        for tokens in self.clients.values():
            out |= tokens
        return out

    async def _send(self, ws: WebSocket, payload: dict) -> None:
        try:
            await ws.send_json(payload)
        except Exception:
            self.clients.pop(ws, None)

    async def broadcast_ticks(self, ticks: list[dict]) -> None:
        for ws, tokens in list(self.clients.items()):
            mine = [t for t in ticks if t.get("instrument_token") in tokens]
            if mine:
                await self._send(ws, {"type": "ticks", "ticks": mine})

    async def broadcast_status(self) -> None:
        for ws in list(self.clients):
            await self._send(ws, self._status_payload())

    def _status_payload(self) -> dict:
        return {"type": "status", "status": self.status, "message": self.status_message,
                "subscribed": len(self._subscribed)}

    def _set_status(self, status: str, message: str) -> None:
        self.status, self.status_message = status, message
        if self.loop:
            asyncio.run_coroutine_threadsafe(self.broadcast_status(), self.loop)

    # -- upstream side -------------------------------------------------------------------

    def _resubscribe(self) -> None:
        wanted = self.wanted()
        if self.session.demo:
            self._demo_resubscribe(wanted)
        else:
            self._kite_resubscribe(wanted)

    def _kite_resubscribe(self, wanted: set[int]) -> None:
        with self._lock:
            if not self.session.access_token:
                self._set_status("error", "Not logged in: live ticks need a Kite session.")
                return
            if self._ticker is None and wanted:
                self._start_kite_ticker()
            if self._ticker is None:
                return
            add, remove = wanted - self._subscribed, self._subscribed - wanted
            try:
                if self._ticker.is_connected():
                    if remove:
                        self._ticker.unsubscribe(list(remove))
                    if add:
                        self._ticker.subscribe(list(add))
                        self._ticker.set_mode(self._ticker.MODE_FULL, list(add))
            except Exception as exc:  # pragma: no cover - network dependent
                log.warning("tick resubscribe failed: %s", exc)
            self._subscribed = wanted
            if self.status == "live":
                self._set_status("live", f"Live: {len(wanted)} instruments subscribed.")

    def _start_kite_ticker(self) -> None:
        from kiteconnect import KiteTicker

        ticker = KiteTicker(self.session.api_key, self.session.access_token)

        def on_ticks(ws, ticks):
            if self.loop:
                asyncio.run_coroutine_threadsafe(self.broadcast_ticks([_clean_tick(t) for t in ticks]), self.loop)

        def on_connect(ws, response):
            tokens = list(self.wanted())
            if tokens:
                ws.subscribe(tokens)
                ws.set_mode(ws.MODE_FULL, tokens)
            self._subscribed = set(tokens)
            self._set_status("live", f"Live: {len(tokens)} instruments subscribed.")

        def on_close(ws, code, reason):
            self._set_status("closed", f"Tick feed closed ({code}): {reason}")

        def on_error(ws, code, reason):
            self._set_status("error", f"Tick feed error ({code}): {reason}")

        def on_reconnect(ws, attempts):
            self._set_status("reconnecting", f"Reconnecting to tick feed (attempt {attempts})...")

        ticker.on_ticks = on_ticks
        ticker.on_connect = on_connect
        ticker.on_close = on_close
        ticker.on_error = on_error
        ticker.on_reconnect = on_reconnect
        self._set_status("connecting", "Connecting to Kite tick feed...")
        ticker.connect(threaded=True)
        self._ticker = ticker

    # -- demo feed ---------------------------------------------------------------------

    def _demo_resubscribe(self, wanted: set[int]) -> None:
        self._subscribed = wanted
        if wanted and (self._demo_task is None or self._demo_task.done()) and self.loop:
            self._demo_task = self.loop.create_task(self._demo_loop())
        msg = f"Simulated live feed (demo): {len(wanted)} instruments subscribed." if wanted else "No live subscription yet."
        self.status, self.status_message = ("live" if wanted else "idle"), msg
        if self.loop:
            self.loop.create_task(self.broadcast_status())

    async def _demo_loop(self) -> None:
        from .market_data import instruments

        kite = self.session.client()
        rng = random.Random()
        while self._subscribed:
            missing = [t for t in self._subscribed if t not in self._demo_prices]
            if missing:
                keys = {}
                for t in missing:
                    inst = instruments.by_token(kite, t)
                    if inst:
                        keys[f"NSE:{inst.symbol}"] = t
                for key, q in kite.ohlc(list(keys)).items():
                    self._demo_prices[keys[key]] = q["last_price"]
            ticks = []
            for t in list(self._subscribed):
                if t not in self._demo_prices:
                    continue
                inst = instruments.by_token(kite, t)
                tick = float(inst.tick_size) if inst else 0.05
                # Jitter around the last close (mean-reverting, so it never drifts far).
                p = self._demo_prices[t] * (1 + rng.gauss(0, 0.0015))
                p = round(round(p / tick) * tick, 2)
                ticks.append({"instrument_token": t, "last_price": p, "mode": "full"})
            if ticks:
                await self.broadcast_ticks(ticks)
            await asyncio.sleep(1.0)
