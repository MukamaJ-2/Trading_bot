# Kite Algo Dashboard (Zerodha, NSE)

A React + Vite dashboard with a Python FastAPI backend for Zerodha Kite Connect.
It was built from the prompts in *Algo Trading Prompts* (Prompts 1–2) and *Fully
Automated Trading Prompts* (Prompts 3–4).

| Tab | What it does |
| --- | --- |
| **User** | Your Kite profile: user name, user ID, products, exchanges. |
| **Signals** | A Nifty 100 SMA crossover scanner (default SMA 6 / SMA 30). Stocks with the most recent crossover are ranked first. |
| **Algo Signals** | High-volume breakout-and-retest scanner on daily candles, with live prices from the Kite tick feed. It has the **Run Live** button. |
| **GTT Placement** | A read-only status table of buy GTT candidates built from Algo Signals. |

> **No real orders, ever.** The GTT workflow is a simulation. Run Live stores
> **DUMMY-** buy GTT records in a local file and never sends anything to Kite. On top
> of that, the backend wraps the Kite client in a read-only guard (`ReadOnlyKite`)
> that only exposes data-reading methods. `place_order`, `place_gtt`, `modify_*`,
> `cancel_*` and `delete_gtt` don't exist on it, so no code path can reach them. The
> `confirm_live` flag and the "Run Live" label are kept only for compatibility.

## Quick start

You need **Python 3.10+** and **Node.js 18+**. Use two terminals.

**1. Backend** (from `kite/backend`):

```bash
python -m venv .venv
source .venv/bin/activate          # Windows: .venv\Scripts\activate
pip install -r requirements.txt
uvicorn app.main:app --reload --port 8000
```

**2. Frontend** (from `kite/frontend`):

```bash
npm install
npm run dev                        # open http://localhost:5173
```

### Try it without a Zerodha account (demo mode)

Start the backend with `KITE_DEMO=true`. You can put it in `kite/backend/.env`
(copy `.env.example`) or set it inline:

```bash
KITE_DEMO=true uvicorn app.main:app --reload --port 8000
```

Demo mode skips the login page and uses **synthetic** candles, ticks and a fake
account. It plants a few breakout setups, a holding and an open day order so every
table and status shows up. A yellow **DEMO DATA** badge stays in the sidebar.

## Logging in to Kite

1. Create an app at [developers.kite.trade](https://developers.kite.trade). Set its
   redirect URL to anything you control, for example `http://127.0.0.1:5173/`.
2. On the login page, enter your **API Key** and click *Open the Kite login page*.
3. After you log in, Kite redirects to your redirect URL with `?request_token=...`.
   Copy that value into **Request Token**, enter your **API Secret**, and click **Login**.

The backend exchanges the request token for an access token. It keeps the token in
memory and in `kite/backend/state/kite_session.json` (owner-only permissions,
git-ignored). It never sends the token to the browser, and it never stores the API
secret. Because the token is saved, restarting the backend or changing code doesn't
make you log in again. Kite tokens expire every morning (around 6 AM IST). When that
happens the app sends you back to the login page.

## How each part works

### Signals: SMA crossover (Prompt 2)

- **Universe:** the official Nifty 100 CSV from niftyindices.com, downloaded at most
  once a day and cached. If it can't be downloaded, the app uses the last cached
  copy, and then a bundled snapshot (`backend/app/data/nifty100_fallback.csv`, which
  the UI flags). Index membership changes twice a year, so prefer the official file.
- Symbols are mapped to NSE instrument tokens with `kite.instruments("NSE")`.
- Daily candles come from `kite.historical_data`, rate-limited to stay under Kite's
  3 requests per second. A full 100-stock scan takes about 35 seconds the first
  time, and is cached for the rest of the day.
- **Lookback Days** is how many calendar days of history to fetch. It must cover
  more trading days than the long SMA.
- **Close**, **SMA short** and **SMA long** show the latest values. **Crossover Date**
  is the most recent day the short SMA crossed the long SMA.

### Algo Signals: breakout and retest (Prompt 3)

`GET /api/scanner-data` returns metadata plus, for each stock: symbol, company name,
instrument token, tick size, Nifty 50/100 flags and about 120 days of daily candles.
The scanner itself runs in the browser (`frontend/src/lib/scanner.ts`), using exactly
these parameters: volume lookback 20, volume ×3, price lookback 20, maximum breakout
age 20, midpoint tolerance 1%. It scans backward from the second-last candle and
keeps the most recent accepted setup per stock. Results are sorted by age, then by
distance from the midpoint.

Current Price is the websocket LTP if there is one, then the OHLC snapshot LTP, then
the latest close. The websocket (`/ws/ticks?tokens=...&mode=full`) subscribes only
to the stocks the scanner returned. Live prices update in place, and the ranking
stays fixed until the scanner runs again.

### GTT Placement: simulated (Prompt 4)

**Run Live** (on the Algo Signals tab) does this:

1. Refreshes scanner data and reruns the same Algo Signals scanner.
2. Loads an OHLC snapshot and merges it with the live ticks.
3. Builds one candidate per signal: quantity 1, buy at the **breakout candle low**,
   stoploss at **buy × 0.95**, both rounded to the instrument's tick size with exact
   decimal math.
4. Calls `POST /api/algo-orders/gtt-state`. This is read-only and checks `get_gtts()`,
   `orders()`, `positions()` and `holdings()`.
5. Calls `POST /api/algo-orders/live-gtt` with `confirm_live: true`, but only for
   rows that are `ready`. The backend repeats every check, then stores a dummy BUY
   GTT (NSE, CNC, LIMIT, qty 1) with an ID like `DUMMY-SIEMENS-000001`.

A dummy buy GTT is **not** created when the symbol already has any of these:

- an active buy GTT (real or dummy)
- a non-cancelled, non-rejected current-day NSE CNC BUY order
- a net position
- a holding

The check and the record creation run under one lock: a thread lock plus an OS file
lock. So double clicks, concurrent requests and backend restarts can't create a
duplicate. No stoploss GTT is ever created, because the stoploss stays
`planned_after_buy` and no buy execution is ever simulated.

Dummy records live in `kite/backend/state/dummy_gtts.json`. You can list them at
`GET /api/algo-orders/dummy-gtts`. To start fresh, stop the backend and delete that
file.

## API reference

| Method | Path | Notes |
| --- | --- | --- |
| GET | `/api/auth/status` | `{logged_in, demo, user_name}`. Never includes the token. |
| POST | `/api/auth/login` | `{api_key, api_secret, request_token}` |
| POST | `/api/auth/logout` | Clears the saved session. |
| GET | `/api/profile` | User tab |
| GET | `/api/signals?short=6&long=30&lookback_days=120&max_stocks=100` | Signals tab |
| GET | `/api/scanner-data` | Cached daily candles for the Nifty 100 |
| POST | `/api/scanner-data/refresh` | Forces a rebuild of the cache |
| GET | `/api/ohlc?symbols=A,B` | OHLC snapshot with `last_price` |
| WS | `/ws/ticks?tokens=1,2&mode=full` | `{type: "ticks"}` and `{type: "status"}` messages |
| POST | `/api/algo-orders/gtt-state` | Read-only state check |
| POST | `/api/algo-orders/live-gtt` | Dummy records only. Requires `confirm_live: true`. |
| GET | `/api/algo-orders/dummy-gtts` | Lists the dummy records |

## Tests

```bash
cd kite/backend && python -m pytest -q    # GTT states, duplicates, concurrency, read-only guard
cd kite/frontend && npm test              # scanner logic and tick rounding
cd kite/frontend && npm run build         # type-check and production build
```

The backend tests use a mocked Kite account whose `place_*`, `modify_*`, `cancel_*`
and `delete_*` methods fail the test if they're ever called, including when
`confirm_live` is true. CI runs all of this on every change under `kite/`
(`.github/workflows/kite-tests.yml`).

## Customizing the look

All colours, the radius and the fonts are CSS variables at the top of
`frontend/src/styles.css`.

## Notes

- After you log in again, live ticks may need a backend restart to reconnect. Kite's
  ticker runs on a Twisted reactor, which can only start once per process.
- This is a tool for research and learning. Nothing here is investment advice.
