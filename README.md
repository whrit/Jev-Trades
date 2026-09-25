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

Edit `pipeline/.env` to set `ALPACA_API_KEY` and `ALPACA_SECRET_KEY` from a **paper** account. The example includes stock symbols, an option-underlying watchlist, data feeds, hard option policy, optional TypeSafe credentials, and local listener/origin settings. Blank credentials leave trading unavailable. Existing shell variables take precedence over `pipeline/.env`.

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
- `ALPACA_OPTION_UNDERLYINGS=SPY,AAPL,MSFT,QQQ,NVDA` configures stock tickers, not OCC contracts. The service discovers calls and puts itself. Replace the obsolete `ALPACA_OPTION_SYMBOLS` setting; its presence is rejected rather than silently interpreted. Leave the underlying list blank to disable new option entries.
- Long calls and puts only: **buy to open / sell to close**, integer contract quantities, no short options, spreads, futures, or other derivative products.
- Long options require the paper account's effective options trading level to be at least 2. Alpaca also enforces expiration-day cutoffs and contract tradability.
- New entries require standard, unadjusted 100-share contracts. A $2 premium costs $200 per contract. Whole-contract quantities are bounded by premium budget, quoted ask size, and the contract cap. Held contracts retain broker metadata for risk-reducing exits.

The automation paginates discovery automatically. The read-only endpoint remains available for inspection, using a real future expiration date:

```sh
curl 'http://127.0.0.1:8765/contracts?underlying=SPY&expiration=2026-12-18'
```

The response includes `option_contracts` and `next_page_token`; pass `page_token` for later pages. This raw discovery endpoint does not certify entry eligibility. The date is illustrative, not a promise of availability or a trading recommendation.

## Market data

Both stocks and options use Alpaca's historical data clients:

- All configured stock symbols and option underlyings are watched independently of the selected chart. Underlying quotes and active contract charts are polled every five seconds; displayed prices are midpoints. The shortlist does not create a historical-bars subscription for every contract.
- Completed one-minute OHLCV bars are polled every minute. Startup requests up to 1,000 recent bars per symbol from the preceding seven days; subsequent polls refresh the last five minutes.
- Broker-provided bar timestamps are upsert keys. Corrections replace bars instead of double-counting volume. Quotes never fabricate candles or trade volume.
- Charts support 1m, 5m, 15m, 1h, and 4h aggregation, existing moving averages, oscillators, and TP/SL overlays. Sparse or insufficient history displays warming indicators.
- Cached bars are stored in `pipeline/alpaca_market_data/`. Cached or stale data is not represented as a live quote.

This implementation uses REST polling, not WebSocket streams. Broker reconciliation and option lifecycle monitoring run every three seconds; stock target checks use the market-data loop. These are not guaranteed exit latencies: broker/network delays add to each interval.

`ALPACA_STOCK_FEED=iex` is the default; use `sip` only with the necessary entitlement. IEX is not the consolidated market. Options default to `indicative`, which supports automatic discovery, paper entries and monitored exits without an OPRA subscription. Its quotes are derived rather than executable OPRA/NBBO, and trades are delayed 15 minutes. Spread/depth filters measure that indicative feed; paper results do not establish live execution quality. Optional `opra` supplies consolidated quotes and requires a working entitlement. Requests always use the configured feed; entitlement errors are surfaced, not silently replaced with another feed. Historical option bars use the SDK endpoint without a feed selector; options and equities have different historical availability.

Orders require a quote no more than 30 seconds old and an open regular market session. Automated decisions require a newly completed bar no more than three minutes old. Delayed subscriptions, quiet contracts, closed markets, and stale quotes can therefore prevent trading rather than bypass these guards.

## Paper trading workflow

1. Select a configured underlying, an eligible shortlisted contract, or a broker-held position.
2. Set the **strategy budget**, maximum position percentage, and risk profile. Budget changes do **not** deposit, withdraw, reset, or otherwise change Alpaca cash. The budget covers long holdings plus estimated unfilled buy exposure across symbols; market movements and actual fill prices can exceed these estimates.
3. Apply settings. Manual orders remain independent of the automation toggle.
4. Submit a manual order, or explicitly confirm starting Jev for the selected configured stock **and every configured option underlying**. Chart navigation never changes or pauses that scope: option-only underlying charts do not enable stock trading, and an empty stock list supports options-only automation. The dashboard shows the feed server's configured stock strategy separately from the viewed chart.
5. Monitor **Broker orders** for acceptance, partial fills, rejection, expiration, and cancellation. A cancel request is not a confirmed cancellation.

Stocks use DAY market orders unless a limit price is supplied. Fractional shares require a fractionable asset. Options always use DAY limit orders, with an explicit premium limit or the current quote rounded to cents. Market-order slippage can exceed an estimated stock allocation; limits can remain unfilled. Submitted quantities are checked against current cash, buying power, the strategy's per-symbol position cap, and available long holdings. Sells cannot intentionally open a short position.

All analysis timeframes share **one net broker position per symbol**. Manual orders, Jev orders, and broker-side changes appear in the same portfolio. Do not use timeframe labels as independent position allocations. Use a dedicated Alpaca paper account for this application, and run only one feed process against it.

### Jev automation

Automation starts disabled, including after restart. Confirm **Start Jev** once to run discovery, AI decisions and paper orders automatically until stopped; there is no per-trade approval. Both `indicative` and entitled `opra` are supported. New completed active-timeframe bars trigger the selected-stock strategy and an independent options strategy for **every** configured underlying:

1. Evaluate the underlying stock's current quote, completed OHLCV bars, indicators, volume and volatility.
2. Fetch every page of Alpaca calls and puts in the expiration window.
3. Filter contract metadata and fresh snapshots from the configured options feed; retain a bounded, deterministic, call/put-balanced shortlist.
4. Give TypeSafe only that verified shortlist, permitted held-position exits, and an explicit **hold** choice. Unknown symbols/actions and invalid confidence are rejected. No eligible entry or held exit means hold without an unnecessary AI request.
5. Refetch the selected contract and quote, require the exact requested symbol, and check quote freshness **after** fetching. Recheck price drift and current broker/portfolio capacity before submitting a paper DAY limit order. The AI cannot override quantity, cash, eligibility, or exit safeguards.

| Hard option policy | Default |
| --- | --- |
| Expiration window | 7–45 calendar days; ACTIVE and tradable calls/puts only |
| Deliverable | Standard root matching the underlying; multiplier 100; adjusted contracts excluded |
| Open interest | At least 100; observation no more than 7 days old and not future-dated |
| Quote liquidity | Positive ordered bid/ask; at least one contract on each side |
| Spread | At most 10% of midpoint **and** $0.50 |
| Quote age | At most 30 seconds; at most 5 seconds of future clock skew |
| AI shortlist | Up to 12 candidates, balanced across calls and puts |
| New premium exposure | At most 1% per trade, 5% per underlying including stock exposure, 10% total options |
| Quantity | At most 5 contracts and no more than quoted ask depth or affordable quantity |
| Revalidation price drift | Ask cannot rise more than 2% above the proposed limit |
| Premium stop / target | 20% loss / 40% gain from confirmed average option fill price |
| Near-expiry close | Attempt liquidation at 1 calendar DTE or less |
| Unfilled entry remainder | Request cancellation after 120 seconds |
| Outstanding exit | Request cancellation after 30 seconds, then reprice only after broker confirmation |

Every field can be overridden with its OPTION_* setting in pipeline/.env.example. Validation enforces coherent expiration/exposure ranges, finite values, and a maximum 30-second quote-age limit. The trade cap uses the lesser of strategy budget and broker equity, reduced to 50%/75%/100% by conservative/balanced/aggressive risk. Cash, options buying power, the global strategy budget, per-symbol limits and pending buy reservations also apply. Expected sell proceeds are never spendable cash. Only one long option position or pending entry per underlying is allowed; this is not a multi-leg strategy.

A bounded, deduplicated queue drops work older than two minutes. Option decisions also require a fresh underlying quote and recent completed bars before inference and execution. Changing settings or pausing invalidates queued/in-flight decisions before submission; it does not cancel existing orders or disable lifecycle monitoring. The stock strategy retains its confidence, allocation and ATR behavior; option stops are premium percentages, not underlying ATR distances.

TypeSafe receives underlying indicators, the verified shortlist, held positions, policy and portfolio balances. Enable automation only if you intend to disclose that trading context to TypeSafe.

### TP/SL limitations

TP/SL values are **local monitored exit targets**, not broker-hosted bracket/OCO protection. Held strategy options remain monitored while Jev is paused, after restart, and after their underlying is removed from the entry watchlist. Positions outside this strategy are not silently liquidated. Option exits use fresh quotes from the configured feed, including indicative. They do not execute while the service is down, quotes are unavailable/stale, or the regular session is closed. They are limit orders and may remain unfilled.

Targets attach only after a confirmed partial/full fill. Triggered option exits are persisted: price recovery, restart or watchlist changes do not erase the exit request. Remaining buys are canceled before selling a partial fill. Existing sells are canceled before repricing; acknowledged cancellation is not confirmation, and ambiguous submissions stay blocked rather than duplicated. The dashboard exposes exit intent and monitoring errors.

The service attempts to close near-expiry strategy options and reconciles broker positions through removal/expiration. **This cannot guarantee liquidation before expiration or prevent exercise/delivery.** Closed sessions, outages and illiquidity can defeat the attempt. Review Alpaca directly for expiry, exercise and resulting underlying shares. The service neither rolls contracts nor manages delivered shares automatically.

## State and history

- `pipeline/alpaca_paper.db`: durable submission intents/client IDs, instrument metadata, stable submission times, observed order states, premium targets, triggered exit intent, and agent decisions. Not a second cash ledger.
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

Offline regressions use temporary storage and controlled broker transitions. Coverage includes paginated discovery/filtering, indicative and OPRA eligibility, verified AI choices, execution revalidation, exact-cent sizing, premium budgets, partial fills, restart reconciliation, paused/watchlist-removed exits, repricing after cancellation, near-expiry handling, stale/invalid inputs, ambiguous submissions, corrected candle volumes, and HTTP validation without secret disclosure or partial settings changes. No account credentials or real broker orders are used.

## References

- [Alpaca-py market data](https://alpaca.markets/sdks/python/market_data.html)
- [Alpaca-py trading](https://alpaca.markets/sdks/python/trading.html)
- [Alpaca-py options examples](https://github.com/alpacahq/alpaca-py/tree/master/examples/options)
- [Alpaca-py Context7 documentation](https://context7.com/alpacahq/alpaca-py)

## Contributing and license

Contributions: https://github.com/zadescoxp/Jev-Trades

Apache License 2.0; see [LICENSE](LICENSE).
