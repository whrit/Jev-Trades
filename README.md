# Jev Trades

A Next.js dashboard for Alpaca market data and paper trading of US stocks and long calls/puts, with optional TypeSafe/Jev automation.

**Paper only:** `TradingClient(..., paper=True)` is fixed in the Python service. There is no live-trading switch. Orders go to Alpaca's paper brokerage; acceptance is not a fill. Alpaca—not SQLite—is authoritative for cash, positions, fills, exercise/assignment effects, and buying power.

## Setup

Requirements: Node.js 20.9+, pnpm, uv, and an Alpaca paper account. Python 3.14 is selected by `pipeline/.python-version`; `pyproject.toml` requires Python 3.14+. The SDK is pinned to `alpaca-py==0.44.0`.

From the repository root, for a fresh checkout:

```sh
pnpm install
uv sync --project pipeline --locked
cp .env.example .env.local
cp pipeline/.env.example pipeline/.env
```

Edit `pipeline/.env` to set `ALPACA_API_KEY` and `ALPACA_SECRET_KEY` from a **paper** account. The example includes stock/option symbols, data feeds, optional TypeSafe credentials, and local listener/origin settings. Blank credentials leave trading unavailable. Existing shell variables take precedence over `pipeline/.env`.

The root `.env.local` contains only public dashboard feed URLs. Its example keeps the local defaults; `NEXT_PUBLIC_MARKET_STREAM_URL` is an optional override of the feed URL plus `/stream`. Restart Next.js after changing these values. Do not overwrite existing environment files when upgrading.

`TYPESAFE_AI_API_KEY` is also accepted. Manual trading and data do not require TypeSafe. Never put broker or TypeSafe secrets in `NEXT_PUBLIC_*` variables. The dashboard's optional TypeSafe key field changes the current process's key without writing it to disk.

Start from the repository root in separate terminals:

```sh
uv run --project pipeline --locked python -m pipeline.data_collector
```

```sh
pnpm dev
```

Open `http://localhost:3000`. The feed defaults to `http://127.0.0.1:8765`. Missing credentials and broker/data errors are visible in the dashboard; there is no simulated cash or synthetic-price fallback.

### Python dependency workflow

`pipeline/pyproject.toml` and `pipeline/uv.lock` are the dependency sources of truth; no parallel `requirements.txt` is needed. This is a non-packaged service (`tool.uv.package = false`), not a library to publish. Commit both files when dependencies change.

- Runtime dependencies: Alpaca SDK, pandas, Pydantic 2, and python-dotenv. TypeSafe uses the existing HTTP integration, so its unused SDK dependency was removed.
- Development group: Ruff for lint/import sorting and formatting; Pyright in basic mode; pandas-stubs for meaningful dataframe type checking. Pyright uses Node.js, already required by the dashboard.
- Add runtime dependencies with `uv add --project pipeline <package>`; use `--dev` for development tools. Use `uv remove --project pipeline <package>` to remove a dependency. These commands update the lockfile.
- Normal `uv sync` includes development tools. For runtime-only installs, use `uv sync --project pipeline --locked --no-dev` and include `--no-dev` in the `uv run` startup command too.
- For editor type checking, select `pipeline/.venv/bin/python`; tool settings live in `pipeline/pyproject.toml`.


## Stocks and options

- Stock symbols come from `ALPACA_STOCK_SYMBOLS`.
- `ALPACA_OPTION_SYMBOLS` is a comma-separated list of actual Alpaca OCC contract symbols. Configure specific, unexpired contracts and restart the feed. No expired contract is silently rolled to a new one.
- Long calls and puts only: **buy to open / sell to close**, integer contract quantities, no short options, spreads, futures, or other derivative products.
- Long options require the paper account's effective options trading level to be at least 2. Alpaca also enforces expiration-day cutoffs and contract tradability.
- Contract size comes from Alpaca contract metadata. A standard $2 premium with a 100-share multiplier costs $200 per contract. Dollar allocations round down to whole contracts; an allocation below one contract is rejected.

Discover contracts through the read-only endpoint, using a real future expiration date:

```sh
curl 'http://127.0.0.1:8765/contracts?underlying=SPY&expiration=2026-12-18'
```

The response includes `option_contracts` and `next_page_token`. Pass `page_token` to fetch subsequent pages. Select a returned tradable symbol for `ALPACA_OPTION_SYMBOLS`; the date above is illustrative, not a promise of availability or a trading recommendation.

## Market data

Both stocks and options use Alpaca's historical data clients:

- Latest bid/ask quotes are polled every five seconds; the displayed price is their midpoint.
- Completed one-minute OHLCV bars are polled every minute. Startup requests up to 1,000 recent bars per symbol from the preceding seven days; subsequent polls refresh the last five minutes.
- Broker-provided bar timestamps are upsert keys. Corrections replace bars instead of double-counting volume. Quotes never fabricate candles or trade volume.
- Charts support 1m, 5m, 15m, 1h, and 4h aggregation, existing moving averages, oscillators, and TP/SL overlays. Sparse or insufficient history displays warming indicators.
- Cached bars are stored in `pipeline/alpaca_market_data/`. Cached or stale data is not represented as a live quote.

This implementation uses REST polling, not WebSocket streams. Five-second polling is not tick-level execution or a guaranteed exit latency. Broker/network delays add to that interval.

`ALPACA_STOCK_FEED=iex` is the default; use `sip` only with the necessary entitlement. IEX is not the consolidated market. Options default to `indicative`; `opra` requires the corresponding entitlement. Indicative options quotes are not executable OPRA/NBBO quotes, and indicative trades may be delayed. Historical option bars use the SDK's historical options endpoint, whose request has no feed selector. Entitlements and historical availability differ from equities; the SDK's general stock history statement does not guarantee five years of option history.

Orders require a quote no more than 30 seconds old and an open regular market session. Automated decisions require a newly completed bar no more than three minutes old. Delayed subscriptions, quiet contracts, closed markets, and stale quotes can therefore prevent trading rather than bypass these guards.

## Paper trading workflow

1. Select a configured stock or option contract.
2. Set the **strategy budget**, maximum position percentage, and risk profile. Budget changes do **not** deposit, withdraw, reset, or otherwise change Alpaca cash. The budget covers long holdings plus estimated unfilled buy exposure across symbols; market movements and actual fill prices can exceed these estimates.
3. Apply settings. Manual orders remain independent of the automation toggle.
4. Submit a manual buy/sell, or explicitly confirm starting Jev automation for the selected symbol.
5. Monitor **Broker orders** for acceptance, partial fills, rejection, expiration, and cancellation. A cancel request is not a confirmed cancellation.

Stocks use DAY market orders unless a limit price is supplied. Fractional shares require a fractionable asset. Options always use DAY limit orders, with an explicit premium limit or the current quote rounded to cents. Market-order slippage can exceed an estimated stock allocation; limits can remain unfilled. Submitted quantities are checked against current cash, buying power, the strategy's per-symbol position cap, and available long holdings. Sells cannot intentionally open a short position.

All analysis timeframes share **one net broker position per symbol**. Manual orders, Jev orders, and broker-side changes appear in the same portfolio. Do not use timeframe labels as independent position allocations. Use a dedicated Alpaca paper account for this application, and run only one feed process against it.

### Jev automation

Automation starts disabled. Both configured stocks and configured long option contracts are eligible once enabled. Jev analyzes the selected instrument's own candles/premiums, not an automatically selected option chain or an underlying-to-options strategy.

New completed timeframe bars trigger decisions. A bounded queue avoids an unbounded tick backlog; work older than two minutes is discarded. Risk profile, confidence thresholds, allocation fractions, and ATR-based sizing/exit distances gate decisions. Stopping automation or changing configuration invalidates pending/in-flight decisions before submission. It does **not** cancel already submitted broker orders or disable local exit monitoring.

The TypeSafe request contains the selected instrument's indicators, position, and account balances. Enable automation only if you intend to send that trading context to TypeSafe.

### TP/SL limitations

TP/SL values are **local monitored exit targets**, not broker-hosted bracket/OCO protection. They are evaluated against fresh bid quotes while the feed process runs, including while Jev is paused. No exit runs while the service is down, market data is unavailable, or the regular session is closed. Options exits are limit orders and can remain unfilled after a stop is crossed.

Targets attach only after a confirmed buy fill, including a partial fill. If a target is crossed during a partially filled buy, the service requests cancellation of the remaining buy, waits for broker confirmation, then can sell the held quantity. Pending sells prevent duplicate exits. There is no guarantee of execution at a stop price.

Review expiring options in Alpaca directly: exercise/assignment and expiry are broker-controlled. This application does not automatically roll contracts or manage delivery of underlying shares.

## State and history

- `pipeline/alpaca_paper.db`: durable submission intents/client IDs, observed broker order states, local exit targets, and agent decisions. Not a second cash ledger.
- Orders with uncertain submission outcomes remain blocked by symbol until reconciled with Alpaca using their persisted client order ID. They are not blindly resubmitted. If an unknown order cannot be found, inspect the paper account and resolve the discrepancy before altering local state.
- Broker reconciliation polls every three seconds and resumes after restart. The dashboard shows the latest 100 observed orders/fill summaries; each order's filled quantity and average price are cumulative, not individual execution events.
- Per-trade realized P&L/cash-after values are not invented. Position value and unrealized P&L come directly from Alpaca; consult Alpaca for its complete ledger/tax-lot accounting.
- The old `pipeline/jev_trades.db` is retained untouched for reference. Simulated crypto holdings/cash are **not migrated into broker orders**.

Keep the SQLite database: submission intents and exit targets must survive a restart even though Alpaca owns the actual ledger. Preserve it when restarting/upgrading; stop the feed before copying the database and any remaining WAL files for a backup. Credentials and runtime strategy settings are not persisted there, and automation always restarts disabled.

OHLCV files are a rebuildable cache, not an audit ledger. A separate SQL market-data archive is unnecessary for the current dashboard; add one only for durable backtesting/history requirements. There is no automatic retention policy for persisted order and decision history.

## HTTP service and security

| Endpoint | Purpose |
| --- | --- |
| `GET /stream?symbol=SPY&timeframe=1m` | Dashboard SSE snapshot |
| `GET /health` | Broker connectivity/error status |
| `GET /history` | Broker-derived order/fill summaries and account snapshot |
| `GET /contracts?underlying=SPY&expiration=YYYY-MM-DD` | Paginated contract discovery |
| `POST /config` | Strategy budget, risk, active timeframes, selected symbol, automation |
| `POST /order` | `buy`, `sell`, `exit`, `update_tp_sl`, or `cancel` |

Order requests use the configured `symbol`, `quantity` **or** `amount_usd` for buys, optional `limit_price`, and optional `stop_loss_pct` / `take_profit_pct` or absolute targets. Sell requests accept `quantity` or `pct_of_position`; `exit` sells all available long holdings. `cancel` requires `order_id`. Zero TP/SL values in `update_tp_sl` remove the corresponding local target.

Pydantic validates both mutation payloads: unknown fields, numeric strings/booleans, non-finite numbers, invalid actions, and malformed settings are rejected with HTTP 400 before mutation. Validation responses omit submitted input values to avoid echoing credentials. Broker-specific sizing, permissions, market-session, and quote-freshness checks remain in the execution layer.

The service binds to loopback by default. Browser origins are restricted to `http://localhost:3000` and `http://127.0.0.1:3000`; override with comma-separated `FEED_ALLOWED_ORIGINS` if necessary. Mutations require bounded JSON requests. `HOST` and `PORT` configure the listener.

**There is no multi-user authentication or authorization.** CORS is not authentication. Do not expose this shared paper-account service to a public network. Remote deployment requires an authenticated HTTPS reverse proxy and a deliberate origin allowlist. `NEXT_PUBLIC_MARKET_FEED_URL` changes the dashboard feed URL, not the Alpaca broker URL. Vercel can host the dashboard, not the long-running Python feed.

## Verification

From the repository root:

```sh
uv sync --project pipeline --locked
uv run --project pipeline --locked ruff check pipeline
uv run --project pipeline --locked ruff format --check pipeline
uv run --project pipeline --locked pyright --project pipeline/pyproject.toml
uv run --project pipeline --locked python -m unittest discover -s pipeline -v
pnpm exec next typegen
pnpm exec tsc --noEmit
pnpm build
```

The four offline regressions use temporary storage and controlled broker transitions. They exercise contract sizing and aggregate budget limits, partial fills, restart reconciliation, oversell/fractional-option rejection, stale/invalid inputs, pending-order suppression, ambiguous submission recovery, partial-fill stop exits while automation is paused, corrected candle volumes/time buckets, and HTTP validation without secret disclosure or partial configuration changes. No account credentials or real broker orders are used.

## References

- [Alpaca-py market data](https://alpaca.markets/sdks/python/market_data.html)
- [Alpaca-py trading](https://alpaca.markets/sdks/python/trading.html)
- [Alpaca-py options examples](https://github.com/alpacahq/alpaca-py/tree/master/examples/options)
- [Alpaca-py Context7 documentation](https://context7.com/alpacahq/alpaca-py)

## Contributing and license

Contributions: https://github.com/zadescoxp/Jev-Trades

Apache License 2.0; see [LICENSE](LICENSE).
