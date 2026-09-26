# Jev Trades

A Next.js dashboard for Alpaca market data and paper trading of US stocks and long calls/puts, with optional TypeSafe/Jev automation.

Crypto is not implemented in this app. Alpaca supports it, but this service currently validates US-equity watchlists and uses stock/options data clients and order rules; adding a crypto ticker does not enable crypto trading.

**Paper only:** `TradingClient(..., paper=True)` is fixed in the Python service. There is no live-trading switch. Orders go to Alpaca's paper brokerage; acceptance is not a fill. Alpaca—not SQLite—is authoritative for cash, positions, fills, exercise/assignment effects, and buying power.

## Setup

Requirements: Node.js 22.18+ on the 22.x line or Node.js 24+, pnpm 12.4.2, uv, and an Alpaca paper account. The Node requirement supports the TypeScript Oxlint/Oxfmt configs. Python 3.14 is selected by `pipeline/.python-version`; `pyproject.toml` requires Python 3.14+. The SDK is pinned to `alpaca-py==0.44.0`.

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

- `ALPACA_STOCK_SYMBOLS` and `ALPACA_OPTION_UNDERLYINGS` are bootstrap defaults. After saving **Settings → Trading scope**, the complete saved scope overrides these lists on restart. Edit tickers in the dashboard; no environment change or service restart is needed.
- Search Alpaca’s active tradable stocks/ETFs by ticker or company name, add/remove watchlist entries, and confirm the exact scope before saving. Options lists contain underlying stock tickers, not OCC contracts; eligible calls/puts are discovered automatically. The obsolete `ALPACA_OPTION_SYMBOLS` setting remains rejected.
- Stock and options automation have independent switches. Turn stock automation off for options-only automation; clear the stock watchlist to also disallow new manual stock buys. The explicit stock strategy symbol is independent of the viewed chart. Removing tickers or disabling a strategy blocks new automated entries without canceling pending orders, liquidating positions, or abandoning protective exits.
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

**Terminal** keeps account equity, available cash, held-plus-reserved options exposure, and applied strategy intervals above the watchlist, chart, and manual trade panel. Positions, open orders, recent decisions, and fill summaries appear below. **Activity** focuses those records; **Settings** contains trading scope, budget, strategy evaluation intervals, TypeSafe connection, and option risk limits. Chart navigation and the compact indicator picker only change the view.

Unsaved settings survive live snapshots and navigation between workspace views. Scans retain their last completed counts, candidates, and timestamp while updating or reporting an error; failed/stale scans are not reused for automatic entries. Decision rows identify ticker, strategy, interval, action, confidence, and timestamp, with expandable actual context/response. Holds do not display invented execution prices.

1. Select a configured underlying, an eligible shortlisted contract, or a broker-held position.
2. Set the **strategy budget**, maximum position percentage, and risk profile. Budget changes do **not** deposit, withdraw, reset, or otherwise change Alpaca cash. The budget covers long holdings plus estimated unfilled buy exposure across symbols; market movements and actual fill prices can exceed these estimates.
3. Apply settings. Manual orders remain independent of the automation toggle.
4. Submit a confirmed manual order, or confirm **Start automation** for the saved scope. Stock/options strategy switches independently gate automated work; viewing a chart never changes them. Strategy evaluation intervals are separate from the chart candle interval.
5. Monitor **Open orders** for acceptance, partial fills, rejection, expiration, and cancellation. A cancel request is not a confirmed cancellation. **Pause automation** stops new autonomous decisions; existing orders and protective exits remain active.

Stocks use DAY market orders unless a limit price is supplied. Fractional shares require a fractionable asset. Options always use DAY limit orders, with an explicit premium limit or the current quote rounded to cents. Market-order slippage can exceed an estimated stock allocation; limits can remain unfilled. Submitted quantities are checked against current cash, buying power, the strategy's per-symbol position cap, and available long holdings. Sells cannot intentionally open a short position.

All analysis timeframes share **one net broker position per symbol**. Manual orders, Jev orders, and broker-side changes appear in the same portfolio. Do not use timeframe labels as independent position allocations. Use a dedicated Alpaca paper account for this application, and run only one feed process against it.

### Jev automation

Automation starts paused, including after restart. Confirm **Start automation** to run discovery, AI decisions and paper orders for the saved enabled strategies until **Pause automation**; there is no per-trade approval. Both `indicative` and entitled `opra` are supported. New completed strategy-interval bars trigger the enabled stock strategy and an independent options strategy for every enabled options underlying:

1. Evaluate the underlying stock's current quote, completed OHLCV bars, indicators, volume and volatility.
2. Fetch every page of Alpaca calls and puts in the expiration window.
3. Filter contract metadata and fresh snapshots from the configured options feed; retain a bounded, deterministic, call/put-balanced shortlist.
4. Give TypeSafe only that verified shortlist, permitted held-position exits, and an explicit **hold** choice. Unknown symbols/actions and invalid confidence are rejected. No eligible entry or held exit means hold without an unnecessary AI request.
5. Refetch the selected contract and quote, require the exact requested symbol, and check quote freshness **after** fetching. Recheck price drift and current broker/portfolio capacity before submitting a paper DAY limit order. The AI cannot override quantity, cash, eligibility, or exit safeguards.

| Hard option policy       | Default                                                                                |
| ------------------------ | -------------------------------------------------------------------------------------- |
| Expiration window        | 7–45 calendar days; ACTIVE and tradable calls/puts only                                |
| Deliverable              | Standard root matching the underlying; multiplier 100; adjusted contracts excluded     |
| Open interest            | At least 100; observation no more than 7 days old and not future-dated                 |
| Quote liquidity          | Positive ordered bid/ask; at least one contract on each side                           |
| Spread                   | At most 10% of midpoint **and** $0.50                                                  |
| Quote age                | At most 30 seconds; at most 5 seconds of future clock skew                             |
| AI shortlist             | Up to 12 candidates, balanced across calls and puts                                    |
| New premium exposure     | At most 10% per entry, 25% per underlying including stock exposure, 75% total options  |
| Quantity                 | At most 5 contracts and no more than quoted ask depth or affordable quantity           |
| Distinct positions       | Up to 10 distinct OCC symbols per underlying, including pending entries                |
| Model confidence         | At least 60% for discretionary option entries/exits; protective exits bypass this gate |
| Revalidation price drift | Ask cannot rise more than 2% above the proposed limit                                  |
| Premium stop / target    | 20% loss / 40% gain from confirmed average option fill price                           |
| Near-expiry close        | Attempt liquidation at 1 calendar DTE or less                                          |
| Unfilled entry remainder | Request cancellation after 120 seconds                                                 |
| Outstanding exit         | Request cancellation after 30 seconds, then reprice only after broker confirmation     |

The dashboard exposes these three exposure percentages, distinct positions per underlying, contracts per order, and model confidence under **Settings → Options risk limits**. Drafts survive streaming updates. Dollar ceilings use the **applied** strategy budget and broker equity, not an unsaved budget input. Applying changes requires confirmation of all six values; invalid or failed updates preserve active settings. Discard restores server values. At a $10,000 budget and at least $10,000 equity, the default ceilings are **$1,000 per entry / $2,500 per underlying / $7,500 total options**.

Defaults and advanced eligibility/exit safeguards can be set with `OPTION_*` variables in `pipeline/.env.example`. Saved UI overrides take precedence for edited fields and survive feed restarts; automation still restarts disabled. Validation requires `0 < entry <= underlying <= total <= 1`, positive whole position/quantity limits, confidence in `[0, 1]`, finite numbers, coherent expiration ranges, and quotes no older than 30 seconds. Existing environment overrides are preserved when upgrading; restart the feed when ready to expose the new controls.

Options percentages apply directly to the lesser of strategy budget and broker equity, with **no stock-risk multiplier**. Cash, options buying power, the global strategy budget, per-symbol limits, and pending buys can reduce available capacity. Per-underlying exposure includes stock holdings and pending stock buys; total options exposure includes held options and outstanding buy premiums. Expected sell proceeds are never spendable cash. Distinct OCC symbols may coexist on one underlying, but buying more of an already-held/pending contract is prohibited. A partial fill and its remaining buy count as one position slot. These are independent long calls/puts, not atomic multi-leg orders. Lowering limits blocks additional entries as needed; it never forces liquidation, cancels pending orders, or changes existing exit targets.

A bounded, deduplicated queue drops work older than two minutes. Option decisions also require a fresh underlying quote and recent completed bars before inference and execution. Changing settings or pausing invalidates queued/in-flight decisions before submission; it does not cancel existing orders or disable lifecycle monitoring. The stock strategy retains its confidence, allocation and ATR behavior; option stops are premium percentages, not underlying ATR distances.

TypeSafe receives underlying indicators, the verified shortlist, held positions, policy and portfolio balances. Enable automation only if you intend to disclose that trading context to TypeSafe.

### TP/SL limitations

TP/SL values are **local monitored exit targets**, not broker-hosted bracket/OCO protection. Held strategy options remain monitored while Jev is paused, after restart, and after their underlying is removed from the entry watchlist. Positions outside this strategy are not silently liquidated. Option exits use fresh quotes from the configured feed, including indicative. They do not execute while the service is down, quotes are unavailable/stale, or the regular session is closed. They are limit orders and may remain unfilled.

Targets attach only after a confirmed partial/full fill. Triggered option exits are persisted: price recovery, restart or watchlist changes do not erase the exit request. Remaining buys are canceled before selling a partial fill. Existing sells are canceled before repricing; acknowledged cancellation is not confirmation, and ambiguous submissions stay blocked rather than duplicated. The dashboard exposes exit intent and monitoring errors.

The service attempts to close near-expiry strategy options and reconciles broker positions through removal/expiration. **This cannot guarantee liquidation before expiration or prevent exercise/delivery.** Closed sessions, outages and illiquidity can defeat the attempt. Review Alpaca directly for expiry, exercise and resulting underlying shares. The service neither rolls contracts nor manages delivered shares automatically.

## State and history

- `pipeline/alpaca_paper.db`: durable submission intents/client IDs, instrument metadata, stable submission times, observed order states, premium targets, triggered exit intent, agent decisions, options-policy overrides, and complete saved trading scope. Not a second cash ledger.
- Orders with uncertain submission outcomes remain blocked by symbol until reconciled with Alpaca using their persisted client order ID. They are not blindly resubmitted. If an unknown order cannot be found, inspect the paper account and resolve the discrepancy before altering local state.
- Broker reconciliation polls every three seconds and resumes after restart. The dashboard shows the latest 100 observed orders/fill summaries; each order's filled quantity and average price are cumulative, not individual execution events.
- Per-trade realized P&L/cash-after values are not invented. Position value and unrealized P&L come directly from Alpaca; consult Alpaca for its complete ledger/tax-lot accounting.
- The old `pipeline/jev_trades.db` is retained untouched for reference. Simulated crypto holdings/cash are **not migrated into broker orders**.

Keep the SQLite database: submission intents, exit targets, saved watchlists/strategy switches, and options limits must survive a restart even though Alpaca owns the actual ledger. Preserve it when restarting/upgrading; stop the feed before copying the database and any remaining WAL files for a backup. Credentials, budget, risk profile, and strategy evaluation intervals are not persisted there; automation always restarts paused.

OHLCV files are a rebuildable cache, not an audit ledger. A separate SQL market-data archive is unnecessary for the current dashboard; add one only for durable backtesting/history requirements. There is no automatic retention policy for persisted order and decision history.

## HTTP service and security

| Endpoint                                              | Purpose                                                                                                     |
| ----------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| `GET /stream?symbol=SPY&timeframe=1m`                 | Dashboard SSE snapshot                                                                                      |
| `GET /health`                                         | Broker connectivity/error status                                                                            |
| `GET /history`                                        | Broker-derived order/fill summaries and account snapshot                                                    |
| `GET /contracts?underlying=SPY&expiration=YYYY-MM-DD` | Paginated contract discovery                                                                                |
| `GET /assets?query=apple`                             | Broker-backed active tradable stock/ETF search by ticker or name                                            |
| `POST /config`                                        | Budget, stock risk, strategy timeframes, master automation, nested trading-scope and options-policy patches |
| `POST /order`                                         | `buy`, `sell`, `exit`, `update_tp_sl`, or `cancel`                                                          |

Order requests use the configured `symbol`, `quantity` **or** `amount_usd` for buys, optional `limit_price`, and optional `stop_loss_pct` / `take_profit_pct` or absolute targets. Sell requests accept `quantity` or `pct_of_position`; `exit` sells all available long holdings. `cancel` requires `order_id`. Zero TP/SL values in `update_tp_sl` remove the corresponding local target.

Pydantic validates both mutation payloads: unknown fields, numeric strings/booleans, non-finite numbers, invalid actions, and malformed settings are rejected with HTTP 400 before mutation. Validation responses omit submitted input values to avoid echoing credentials. Broker-specific sizing, permissions, market-session, and quote-freshness checks remain in the execution layer.

An options-policy update sends `{ "option_policy": { "max_trade_pct": 0.10, "max_underlying_pct": 0.25, "max_total_pct": 0.75, "max_positions_per_underlying": 10, "max_contracts": 5, "min_confidence": 0.60 } }`. All six fields are optional; omitted fields retain active values. This patch preserves budget, trading scope, timeframes, and automation state. Advanced eligibility/exit fields are not accepted here.

Scope updates use `{ "trading_scope": { "stock_symbols": ["SPY", "AAPL"], "stock_symbol": "SPY", "stock_enabled": false, "option_underlyings": ["SPY", "QQQ"], "options_enabled": true } }`. Nested fields are optional; the merged complete scope must remain valid. Tickers are normalized/deduplicated, additions are validated with Alpaca, and scope/policy overrides are persisted together before activation. The old top-level `/config` `symbol` field is rejected: use `trading_scope.stock_symbol`; chart selection belongs to the SSE query. Responses include effective `settings`, `trading_scope`, `option_policy`, and `trading_enabled`; SSE also carries the effective scope. A strategy cannot be enabled with an empty entry list. Disabled strategies may have empty lists.

The service binds to loopback by default. Browser origins are restricted to `http://localhost:3000` and `http://127.0.0.1:3000`; override with comma-separated `FEED_ALLOWED_ORIGINS` if necessary. Mutations require bounded JSON requests. `HOST` and `PORT` configure the listener.

**There is no multi-user authentication or authorization.** CORS is not authentication. Do not expose this shared paper-account service to a public network. Remote deployment requires an authenticated HTTPS reverse proxy and a deliberate origin allowlist. `NEXT_PUBLIC_MARKET_FEED_URL` changes the dashboard feed URL, not the Alpaca broker URL. Vercel can host the dashboard, not the long-running Python feed.

## Frontend tooling

`oxlint.config.ts` and `oxfmt.config.ts` are auto-discovered from the repository root. Oxlint runs native TypeScript, React/hooks, Next.js, accessibility, import, Unicorn, and Oxc correctness checks; warnings and unused suppression directives fail the check. Browser/Node globals use built-in environments rather than a generated globals list. TypeScript compiler checking remains a separate `tsc` step; experimental Oxlint type checking and React Compiler rules are not enabled.

Oxfmt owns formatting for frontend code, CSS, JSON, Markdown, and supported project configuration files, using an 80-column print width. Generated output, lockfiles, agent instructions, and the Python pipeline are excluded. Python formatting remains with Ruff. The dashboard uses blue accents and cool dark surfaces; red remains reserved for losses and errors.

```sh
pnpm lint          # Check source; no writes
pnpm lint:fix      # Apply safe lint fixes
pnpm format        # Format supported project files
pnpm format:check  # Check formatting; no writes
pnpm typecheck     # Generate Next.js types, then run TypeScript
pnpm check         # Lint, formatting, and type checks together
```

Commit configuration and `pnpm-lock.yaml` changes together. CI can run `pnpm install --frozen-lockfile`, `pnpm check`, and `pnpm build`. No separate ESLint/Prettier configuration or migration-generated `.oxlintrc.json` is needed.

## Verification

From the repository root:

```sh
uv sync --project pipeline --locked
uv run --project pipeline --locked ruff check pipeline
uv run --project pipeline --locked ruff format --check pipeline
uv run --project pipeline --locked pyright --project pipeline/pyproject.toml
uv run --project pipeline --locked python -m unittest discover -s pipeline -v
pnpm check
pnpm build
```

Offline regressions use temporary storage and controlled broker transitions. Coverage includes paginated discovery/filtering, indicative and OPRA eligibility, verified AI choices, execution revalidation, exact-cent sizing, premium budgets, partial fills, restart reconciliation, paused/watchlist-removed exits, repricing after cancellation, near-expiry handling, stale/invalid inputs, ambiguous submissions, corrected candle volumes, and HTTP validation without secret disclosure or partial settings changes. No account credentials or real broker orders are used.

## References

- [Alpaca-py market data](https://alpaca.markets/sdks/python/market_data.html)
- [Alpaca-py trading](https://alpaca.markets/sdks/python/trading.html)
- [Alpaca-py options examples](https://github.com/alpacahq/alpaca-py/tree/master/examples/options)
- [Alpaca-py Context7 documentation](https://context7.com/alpacahq/alpaca-py)
- [Oxlint configuration](https://oxc.rs/docs/guide/usage/linter/config.html)
- [Oxfmt configuration](https://oxc.rs/docs/guide/usage/formatter/config.html)

## Contributing and license

Contributions: https://github.com/zadescoxp/Jev-Trades

Apache License 2.0; see [LICENSE](LICENSE).
