"""SMA crossover detection for the Signals tab."""

from __future__ import annotations


def sma(values: list[float], period: int) -> list[float | None]:
    out: list[float | None] = [None] * len(values)
    if period <= 0:
        return out
    running = 0.0
    for i, v in enumerate(values):
        running += v
        if i >= period:
            running -= values[i - period]
        if i >= period - 1:
            out[i] = running / period
    return out


def latest_crossover(candles: list[dict], short: int, long: int) -> dict | None:
    """The most recent bullish or bearish crossover of SMA(short) over SMA(long).

    A bullish crossover happens on the candle where the short SMA closes above the
    long SMA after being at or below it on the previous candle; bearish is the
    reverse. Returns None when there was no crossover in the candles given.
    """
    closes = [c["close"] for c in candles]
    s, l = sma(closes, short), sma(closes, long)
    for i in range(len(candles) - 1, 0, -1):
        if None in (s[i], l[i], s[i - 1], l[i - 1]):
            break
        prev_diff = s[i - 1] - l[i - 1]
        diff = s[i] - l[i]
        kind = None
        if prev_diff <= 0 < diff:
            kind = "Bullish"
        elif prev_diff >= 0 > diff:
            kind = "Bearish"
        if kind:
            last = len(candles) - 1
            return {
                "crossover_type": kind,
                "crossover_date": candles[i]["date"],
                "close": closes[last],
                "sma_short": round(s[last], 2),
                "sma_long": round(l[last], 2),
            }
    return None
