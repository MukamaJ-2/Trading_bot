"""The Nifty 100 universe, loaded from the official Nifty Indices CSV.

Order of preference:
1. The official CSV from niftyindices.com, re-downloaded at most once a day and
   cached in state/cache/.
2. The last cached copy of the official CSV (if today's download fails).
3. A bundled snapshot (app/data/nifty100_fallback.csv). Index membership changes
   twice a year, so this is only a last resort and is reported as such.
"""

from __future__ import annotations

import csv
import io
import time
import urllib.request
from dataclasses import dataclass
from datetime import date
from pathlib import Path

from . import config

_USER_AGENT = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/126.0 Safari/537.36"
)


@dataclass(frozen=True)
class Constituent:
    symbol: str
    company_name: str
    industry: str
    nifty50: bool
    nifty100: bool = True


@dataclass
class Universe:
    constituents: list[Constituent]
    source: str  # "official", "official-cached" or "bundled-fallback"


def _download(url: str, dest: Path) -> str:
    req = urllib.request.Request(url, headers={"User-Agent": _USER_AGENT, "Accept": "text/csv,*/*"})
    with urllib.request.urlopen(req, timeout=20) as resp:
        text = resp.read().decode("utf-8-sig")
    if "Symbol" not in text.splitlines()[0]:
        raise ValueError(f"Unexpected CSV header from {url}")
    dest.write_text(text)
    return text


def _fetch_csv(url: str, name: str) -> tuple[str | None, bool]:
    """Returns (csv_text, fresh). Uses today's cache when present."""
    dest = config.CACHE_DIR / name
    if dest.exists() and date.fromtimestamp(dest.stat().st_mtime) == date.today():
        return dest.read_text(), True
    try:
        return _download(url, dest), True
    except Exception:
        if dest.exists():
            return dest.read_text(), False
        return None, False


def _parse_official(text: str) -> list[dict]:
    rows = []
    for row in csv.DictReader(io.StringIO(text)):
        row = {k.strip(): (v or "").strip() for k, v in row.items() if k}
        if row.get("Symbol") and row.get("Series", "EQ") == "EQ":
            rows.append(row)
    return rows


_cache: tuple[float, Universe] | None = None


def load_universe(force: bool = False) -> Universe:
    global _cache
    if _cache and not force and time.time() - _cache[0] < 3600:
        return _cache[1]

    n100_text, n100_fresh = _fetch_csv(config.NIFTY100_CSV_URL, "ind_nifty100list.csv")
    n50_text, _ = _fetch_csv(config.NIFTY50_CSV_URL, "ind_nifty50list.csv")

    if n100_text:
        n50 = {r["Symbol"] for r in _parse_official(n50_text)} if n50_text else set()
        constituents = [
            Constituent(
                symbol=r["Symbol"],
                company_name=r.get("Company Name", r["Symbol"]),
                industry=r.get("Industry", ""),
                nifty50=r["Symbol"] in n50,
            )
            for r in _parse_official(n100_text)
        ]
        universe = Universe(constituents, "official" if n100_fresh else "official-cached")
    else:
        text = (config.BUNDLED_DATA_DIR / "nifty100_fallback.csv").read_text()
        constituents = [
            Constituent(
                symbol=r["Symbol"],
                company_name=r["Company Name"],
                industry="",
                nifty50=r.get("Nifty50") == "1",
            )
            for r in csv.DictReader(io.StringIO(text))
        ]
        universe = Universe(constituents, "bundled-fallback")

    _cache = (time.time(), universe)
    return universe
