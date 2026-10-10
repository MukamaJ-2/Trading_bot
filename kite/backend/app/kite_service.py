"""Kite Connect session handling and the read-only client guard.

The access token lives only on the backend: in memory and in a local session file
(state/kite_session.json, git-ignored) so it survives backend restarts during local
development. It is never returned to the browser.

Every Kite client the app uses is wrapped in ReadOnlyKite, which only exposes methods
that read data. Methods that place, modify, cancel or delete orders or GTTs simply do
not exist on the wrapper, so no code in this app can reach them by mistake.
"""

from __future__ import annotations

import json
import os
import threading
from datetime import datetime
from typing import Any

from . import config

# The only broker methods the app may call. Everything here reads data.
READ_ONLY_METHODS = frozenset(
    {
        "profile",
        "instruments",
        "historical_data",
        "ohlc",
        "ltp",
        "quote",
        "get_gtts",
        "orders",
        "positions",
        "holdings",
    }
)

# Methods that change orders, GTTs or positions. Listed so tests can assert they are
# never called; ReadOnlyKite refuses them (and anything else not allow-listed).
WRITE_METHODS = frozenset(
    {
        "place_order",
        "place_autoslice_order",
        "modify_order",
        "cancel_order",
        "exit_order",
        "convert_position",
        "place_gtt",
        "modify_gtt",
        "delete_gtt",
        "place_mf_order",
        "cancel_mf_order",
        "place_mf_sip",
        "modify_mf_sip",
        "cancel_mf_sip",
    }
)


class ReadOnlyViolation(PermissionError):
    pass


class ReadOnlyKite:
    """Wraps a KiteConnect-like client and exposes only READ_ONLY_METHODS."""

    __slots__ = ("_client",)

    def __init__(self, client: Any):
        object.__setattr__(self, "_client", client)

    def __getattr__(self, name: str) -> Any:
        if name in READ_ONLY_METHODS:
            return getattr(object.__getattribute__(self, "_client"), name)
        raise ReadOnlyViolation(
            f"Kite method '{name}' is not available: this app is read-only and never "
            "places, modifies, cancels or deletes orders or GTTs."
        )

    def __setattr__(self, name: str, value: Any) -> None:
        raise ReadOnlyViolation("ReadOnlyKite is immutable.")


class NotLoggedIn(Exception):
    pass


class KiteSession:
    """Holds the current Kite client, built from the saved session file if present."""

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._client: ReadOnlyKite | None = None
        self._api_key: str | None = None
        self._access_token: str | None = None
        self._user_name: str | None = None
        if config.DEMO_MODE:
            from .demo_kite import DemoKite

            self._client = ReadOnlyKite(DemoKite())
            self._api_key = "demo"
            self._user_name = "Demo Trader"
        else:
            self._load_saved()

    # -- persistence -------------------------------------------------------------

    def _load_saved(self) -> None:
        path = config.SESSION_FILE
        if not path.exists():
            return
        try:
            data = json.loads(path.read_text())
            api_key, token = data["api_key"], data["access_token"]
        except (ValueError, KeyError, OSError):
            return
        self._set_client(api_key, token, data.get("user_name"))

    def _save(self) -> None:
        payload = {
            "api_key": self._api_key,
            "access_token": self._access_token,
            "user_name": self._user_name,
            "saved_at": datetime.now().isoformat(timespec="seconds"),
        }
        tmp = config.SESSION_FILE.with_suffix(".tmp")
        # Owner-only permissions: the file holds a live access token.
        fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
        with os.fdopen(fd, "w") as f:
            json.dump(payload, f)
        os.replace(tmp, config.SESSION_FILE)

    def _set_client(self, api_key: str, access_token: str, user_name: str | None) -> None:
        from kiteconnect import KiteConnect

        raw = KiteConnect(api_key=api_key)
        raw.set_access_token(access_token)
        self._client = ReadOnlyKite(raw)
        self._api_key = api_key
        self._access_token = access_token
        self._user_name = user_name

    # -- public API --------------------------------------------------------------

    @property
    def demo(self) -> bool:
        return config.DEMO_MODE

    @property
    def api_key(self) -> str | None:
        return self._api_key

    @property
    def access_token(self) -> str | None:
        return self._access_token

    def login(self, api_key: str, api_secret: str, request_token: str) -> dict:
        """Exchange a request token for an access token and save it on the backend."""
        if config.DEMO_MODE:
            return {"user_name": self._user_name, "demo": True}
        from kiteconnect import KiteConnect

        raw = KiteConnect(api_key=api_key)
        session = raw.generate_session(request_token, api_secret=api_secret)
        with self._lock:
            self._set_client(api_key, session["access_token"], session.get("user_name"))
            self._save()
        # The API secret is used once here and never stored.
        return {"user_name": self._user_name, "demo": False}

    def logout(self) -> None:
        if config.DEMO_MODE:
            return
        with self._lock:
            self._client = None
            self._access_token = None
            self._user_name = None
            try:
                config.SESSION_FILE.unlink()
            except FileNotFoundError:
                pass

    def client(self) -> ReadOnlyKite:
        if self._client is None:
            raise NotLoggedIn("Not logged in to Kite. Log in from the login page first.")
        return self._client

    def status(self) -> dict:
        return {
            "logged_in": self._client is not None,
            "demo": config.DEMO_MODE,
            "user_name": self._user_name,
        }


def is_token_error(exc: Exception) -> bool:
    """True when Kite rejected the saved access token (expired or revoked)."""
    try:
        from kiteconnect.exceptions import TokenException
    except ImportError:  # pragma: no cover
        return False
    return isinstance(exc, TokenException)
