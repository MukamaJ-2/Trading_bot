from app.sma import latest_crossover, sma


def bars(closes):
    return [{"date": f"2026-01-{i + 1:02d}", "close": c} for i, c in enumerate(closes)]


def test_sma():
    assert sma([1, 2, 3, 4], 2) == [None, 1.5, 2.5, 3.5]


def test_bullish_then_bearish_returns_latest():
    closes = [10] * 5 + [12, 14, 16] + [9, 7, 5]
    x = latest_crossover(bars(closes), 2, 4)
    assert x["crossover_type"] == "Bearish"
    up = latest_crossover(bars([10] * 5 + [12, 14, 16]), 2, 4)
    assert up["crossover_type"] == "Bullish"
    assert up["crossover_date"] == "2026-01-06"


def test_no_crossover():
    assert latest_crossover(bars(list(range(1, 20))), 2, 4) is None
