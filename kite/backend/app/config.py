"""Settings, read from environment variables (or a local .env file)."""

import os
from pathlib import Path

BACKEND_DIR = Path(__file__).resolve().parent.parent


def _load_dotenv() -> None:
    env_file = BACKEND_DIR / ".env"
    if not env_file.exists():
        return
    for line in env_file.read_text().splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        os.environ.setdefault(key.strip(), value.strip().strip('"').strip("'"))


_load_dotenv()


def _flag(name: str, default: str = "false") -> bool:
    return os.environ.get(name, default).strip().lower() in {"1", "true", "yes", "on"}


# Demo mode serves synthetic market data and a fake (empty) account, so the whole
# dashboard can be tried without a Zerodha account.
DEMO_MODE = _flag("KITE_DEMO")

# Where the backend keeps its local files: the saved session, caches, dummy GTTs.
STATE_DIR = Path(os.environ.get("KITE_STATE_DIR", BACKEND_DIR / "state"))
STATE_DIR.mkdir(parents=True, exist_ok=True)

SESSION_FILE = STATE_DIR / "kite_session.json"
DUMMY_GTT_FILE = STATE_DIR / "dummy_gtts.json"
CACHE_DIR = STATE_DIR / "cache"
CACHE_DIR.mkdir(parents=True, exist_ok=True)

BUNDLED_DATA_DIR = Path(__file__).resolve().parent / "data"

NIFTY100_CSV_URL = os.environ.get(
    "NIFTY100_CSV_URL", "https://niftyindices.com/IndexConstituent/ind_nifty100list.csv"
)
NIFTY50_CSV_URL = os.environ.get(
    "NIFTY50_CSV_URL", "https://niftyindices.com/IndexConstituent/ind_nifty50list.csv"
)

# How many calendar days of daily candles /api/scanner-data serves per stock.
SCANNER_HISTORY_DAYS = int(os.environ.get("SCANNER_HISTORY_DAYS", "120"))

# Kite's historical API allows about 3 requests a second.
HISTORICAL_MIN_INTERVAL_SEC = float(os.environ.get("HISTORICAL_MIN_INTERVAL_SEC", "0.35"))

# Origins allowed to call the API (the Vite dev server by default).
CORS_ORIGINS = [
    o.strip()
    for o in os.environ.get("CORS_ORIGINS", "http://localhost:5173,http://127.0.0.1:5173").split(",")
    if o.strip()
]
