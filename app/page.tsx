"use client";

import dynamic from "next/dynamic";

import { useEffect, useMemo, useState } from "react";

const MarketChart = dynamic(() => import("./market-chart"), { ssr: false });

type Bar = { time: number; open: number; high: number; low: number; close: number; volume: number };
type Indicators = Record<string, number | null>;
type Trade = {
  symbol: string;
  side: "buy" | "sell";
  quantity: number;
  price: number | null;
  entry_price: number | null;
  realized_pnl: number | null;
  cash_balance: number | null;
  id?: string;
  status?: string;
  filled_qty?: number;
  timestamp: number;
  reason?: string;
  tp?: number | null;
  sl?: number | null;
  is_manual?: boolean;
  underlying?: string;
  expiration?: string;
  exit_reason?: string;
};
type Position = {
  symbol: string;
  quantity: number;
  average_entry_price: number;
  mark_price: number;
  unrealized_pnl_pct: number;
  position: string;
  multiplier: number;
  asset_class: string;
  market_value: number;
  unrealized_pnl: number;
  stop_loss_price?: number | null;
  take_profit_price?: number | null;
  stop_loss_pct?: number | null;
  take_profit_pct?: number | null;
  tp_sl_source?: "jev" | "jev-options" | "manual";
  underlying?: string;
  expiration?: string;
  exit_reason?: string;
};
type AgentEvent = {
  timestamp: number;
  price?: number;
  action: string;
  confidence: number | null;
  executed: string;
  reason?: string;
  request?: unknown;
  response?: unknown;
  error?: string | null;
  trade?: Trade;
};
type OptionCandidate = {
  symbol: string;
  underlying: string;
  option_type: "call" | "put";
  expiration: string;
  strike: number;
  bid: number;
  ask: number;
  spread_pct: number;
  open_interest: number;
  max_quantity: number;
  cost_per_contract: number;
  limit_price: number;
};
type OptionScan = {
  status: string;
  reason?: string;
  error?: string;
  as_of?: number;
  discovered?: number;
  eligible?: number;
  candidates?: OptionCandidate[];
};
type OptionPolicy = {
  min_dte: number;
  max_dte: number;
  min_open_interest: number;
  max_open_interest_age_days: number;
  min_quote_size: number;
  max_spread_pct: number;
  max_spread_absolute: number;
  max_quote_age_seconds: number;
  max_candidates: number;
  max_trade_pct: number;
  max_underlying_pct: number;
  max_total_pct: number;
  max_contracts: number;
  stop_loss_pct: number;
  take_profit_pct: number;
  exit_dte: number;
  entry_timeout_seconds: number;
  exit_reprice_seconds: number;
  max_price_drift_pct: number;
};
type OptionsConfig = {
  underlyings: string[];
  policy: OptionPolicy;
  feed: string;
};
type Trading = {
  account: {
    starting_cash: number;
    cash_balance: number | null;
    available_cash: number | null;
    equity: number | null;
    positions: Record<string, Position>;
    max_wallet_position_pct: number;
    risk_appetite: string;
    paper_trading: boolean;
  };
  agent_log: AgentEvent[];
  positions: Trade[];
  agent_enabled: boolean;
  stock_symbol: string | null;
  orders: Trade[];
  broker_status: string;
  broker_error: string | null;
  option_scans?: Record<string, OptionScan>;
  monitor_error?: string | null;
};
type Snapshot = {
  symbol: string;
  supported_symbols: string[];
  stock_symbols: string[];
  status: string;
  error: string | null;
  instruments: Record<string, { asset_class: string; multiplier: number; underlying?: string; expiration?: string; option_type?: "call" | "put" }>;
  data_feeds: { stocks: string; options: string };
  trading_enabled: boolean;
  price: number | null;
  bars: Bar[];
  indicators: Indicators;
  indicator_series: { ema20: (number | null)[]; sma50: (number | null)[] };
  last_tick: number | null;
  trading: Trading;
  settings: { capital: number; max_wallet_position_pct: number; risk_appetite: string; trading_enabled: boolean };
  options?: OptionsConfig;
};

const feedBase = process.env.NEXT_PUBLIC_MARKET_FEED_URL ?? "http://127.0.0.1:8765";
const streamBase = process.env.NEXT_PUBLIC_MARKET_STREAM_URL ?? `${feedBase}/stream`;
const money = (value: number | null | undefined) => value == null ? "--" : `$${value.toLocaleString(undefined, { maximumFractionDigits: 2 })}`;
const indicatorGroups: { title: string; items: [string, string][] }[] = [
  {
    title: "Moving averages",
    items: [
      ["ema_10", "EMA 10"],
      ["sma_10", "SMA 10"],
      ["ema_20", "EMA 20"],
      ["sma_20", "SMA 20"],
      ["ema_30", "EMA 30"],
      ["sma_30", "SMA 30"],
      ["ema_50", "EMA 50"],
      ["sma_50", "SMA 50"],
      ["ema_100", "EMA 100"],
      ["sma_100", "SMA 100"],
      ["ema_200", "EMA 200"],
      ["sma_200", "SMA 200"],
      ["ichimoku_base_line_9_26_52_26", "Ichimoku base"],
      ["vwma_20", "VWMA 20"],
      ["hull_ma_9", "Hull MA 9"],
    ],
  },
  {
    title: "Oscillators",
    items: [
      ["relative_strength_index_14", "RSI 14"],
      ["stochastic_percent_k_14_3_3", "Stochastic %K"],
      ["commodity_channel_index_20", "CCI 20"],
      ["average_directional_index_14", "ADX 14"],
      ["awesome_oscillator", "Awesome oscillator"],
      ["momentum_10", "Momentum 10"],
      ["macd_level_12_26", "MACD 12/26"],
      ["stochastic_rsi_fast_3_3_14_14", "Stochastic RSI"],
      ["williams_percent_range_14", "Williams %R"],
      ["bull_bear_power", "Bull/Bear power"],
      ["ultimate_oscillator_7_14_28", "Ultimate oscillator"],
    ],
  },
];
const allIndicatorKeys = indicatorGroups.flatMap((group) => group.items.map(([key]) => key));

export default function Home() {
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [symbol, setSymbol] = useState("");
  const strategySymbol = snapshot?.trading.stock_symbol ?? "";
  const [capital, setCapital] = useState("100000");
  const [maxWalletPositionPct, setMaxWalletPositionPct] = useState("75");
  const [riskAppetite, setRiskAppetite] = useState("balanced");
  const [typeSafeKey, setTypeSafeKey] = useState("");
  const [tradingEnabled, setTradingEnabled] = useState(false);
  const [overlays, setOverlays] = useState(["ema20"]);
  const [selectedIndicators, setSelectedIndicators] = useState(["ema_20", "sma_50", "relative_strength_index_14", "macd_level_12_26"]);
  const [activityTab, setActivityTab] = useState<"manual" | "logs" | "positions">("manual");
  const [activeTimeframes, setActiveTimeframes] = useState<string[]>(["1m"]);
  const [limitPrice, setLimitPrice] = useState("");
  const [chartTimeframe, setChartTimeframe] = useState<string>("1m");

  // Manual Trading State
  const [orderSide, setOrderSide] = useState<"buy" | "sell">("buy");
  const [sizingMode, setSizingMode] = useState<"usd" | "quantity">("usd");
  const [orderAmountUsd, setOrderAmountUsd] = useState("5000");
  const [orderQuantity, setOrderQuantity] = useState("1");
  const [tpEnabled, setTpEnabled] = useState(true);
  const [tpPct, setTpPct] = useState("5.0");
  const [slEnabled, setSlEnabled] = useState(true);
  const [slPct, setSlPct] = useState("2.5");
  const [orderLoading, setOrderLoading] = useState(false);
  const [feedback, setFeedback] = useState<{ type: "success" | "error"; text: string } | null>(null);

  // Edit TP/SL state for active position
  const [isEditingTpSl, setIsEditingTpSl] = useState(false);
  const [editTpVal, setEditTpVal] = useState("");
  const [editSlVal, setEditSlVal] = useState("");

  useEffect(() => {
    const source = new EventSource(`${streamBase}?symbol=${encodeURIComponent(symbol)}&timeframe=${encodeURIComponent(chartTimeframe)}`);
    source.onmessage = (event) => {
      const next = JSON.parse(event.data) as Snapshot;
      setSnapshot(next);
      if (!symbol) setSymbol(next.symbol);

      setTradingEnabled(next.trading_enabled);
    };
    source.onerror = () => setSnapshot((current) => (current ? { ...current, status: "feed unavailable", trading: { ...current.trading, broker_status: "unavailable", broker_error: "Feed connection unavailable" } } : null));
    return () => source.close();
  }, [symbol, chartTimeframe]);

  // Chart navigation never changes the server-confirmed stock strategy.
  const configurePortfolio = async (enabled: boolean, selectedSymbol: string) => {
    if (enabled && !window.confirm(`Enable autonomous Alpaca PAPER trading?

- Stock strategy: ${snapshot?.stock_symbols.includes(selectedSymbol) ? selectedSymbol : "none (options only)"}. Budget $${capital}, max position ${maxWalletPositionPct}%, risk ${riskAppetite}, timeframes ${activeTimeframes.join(", ")}.
- Options scanning covers ALL configured underlyings, independent of the chart, within the server's hard option policy.
Jev may submit buys/sells until stopped. Underlying indicators, option candidates and portfolio context are sent to TypeSafe. A key entered here is retained by the feed server for future calls; leave it blank to reuse the server key.`)) return;
    try {
      const response = await fetch(`${feedBase}/config`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(tradingEnabled && !enabled ? { symbol: selectedSymbol, trading_enabled: false } : {
          symbol: selectedSymbol,
          capital: Number(capital),
          max_wallet_position_pct: Number(maxWalletPositionPct) / 100,
          risk_appetite: riskAppetite,
          trading_enabled: enabled,
          typesafe_api_key: typeSafeKey.trim() || undefined,
          active_timeframes: activeTimeframes,
        }),
      });
      const result = await response.json();
      if (!response.ok || !result.ok) throw new Error(result.error || "Configuration failed");
      setTradingEnabled(enabled);
      setSnapshot((current) => current ? { ...current, trading_enabled: enabled, trading: { ...current.trading, stock_symbol: current.stock_symbols.includes(selectedSymbol) ? selectedSymbol : null } } : current);
    } catch (error) {
      setFeedback({ type: "error", text: error instanceof Error ? error.message : "Configuration failed" });
    }
  };

  const symbolReady = snapshot?.symbol === symbol;
  const price = symbolReady ? snapshot?.price : undefined;
  const change = useMemo(() => {
    const first = symbolReady ? snapshot?.bars[0]?.open : undefined;
    return price && first ? ((price - first) / first) * 100 : null;
  }, [price, symbolReady, snapshot?.bars]);

  const selectedPosition = snapshot?.trading.account.positions[symbol];
  const availableCash = snapshot?.trading.account.available_cash ?? 0;
  const symbols = snapshot?.supported_symbols ?? [];
  const instrument = snapshot?.instruments[symbol];
  const isOption = instrument?.asset_class === "us_option";
  const multiplier = instrument?.multiplier ?? 1;
  const brokerReady = snapshot?.trading.broker_status === "connected";
  const units = isOption ? "contracts" : "shares";
  const optionsConfig = snapshot?.options;
  const estimateQuantity = (amount: number) => isOption ? Math.floor(amount / ((price || 1) * multiplier)).toString() : (amount / (price || 1)).toFixed(6);
  const toggle = (name: string) => setOverlays((current) => (current.includes(name) ? current.filter((item) => item !== name) : [...current, name]));
  const toggleIndicator = (name: string) => setSelectedIndicators((current) => (current.includes(name) ? current.filter((item) => item !== name) : [...current, name]));
  const labelFor = (name: string) => indicatorGroups.flatMap((group) => group.items).find(([key]) => key === name)?.[1] ?? name;
  const heldOptionPositions = Object.entries(snapshot?.trading.account.positions ?? {}).filter(([, position]) => position.asset_class === "us_option" && position.quantity > 0);
  const proposedStrategySymbol = snapshot?.stock_symbols.includes(symbol) ? symbol : strategySymbol || optionsConfig?.underlyings[0] || "";
  const proposedScope = snapshot?.stock_symbols.includes(proposedStrategySymbol) ? `stock ${proposedStrategySymbol} + options` : "options only";
  const runningScope = strategySymbol ? `stock ${strategySymbol} + options` : "options only";

  // Execute manual order (buy, sell, exit)
  const handleExecuteOrder = async (action: "buy" | "sell" | "exit", extraParams: Record<string, any> = {}) => {
    setOrderLoading(true);
    setFeedback(null);
    try {
      const payload: Record<string, any> = {
        action,
        symbol,
        limit_price: limitPrice ? Number(limitPrice) : undefined,
        ...extraParams,
      };

      if (action === "buy") {
        if (sizingMode === "usd") {
          payload.amount_usd = Number(orderAmountUsd);
        } else {
          payload.quantity = Number(orderQuantity);
        }
        if (tpEnabled && Number(tpPct) > 0) {
          payload.take_profit_pct = Number(tpPct);
        }
        if (slEnabled && Number(slPct) > 0) {
          payload.stop_loss_pct = Number(slPct);
        }
      } else if (action === "sell") {
        if (!extraParams.pct_of_position) {
          if (sizingMode === "quantity" && Number(orderQuantity) > 0) {
            payload.quantity = Number(orderQuantity);
          } else {
            payload.pct_of_position = 1.0;
          }
        }
      }
      if (!window.confirm(`Submit Alpaca PAPER ${action.toUpperCase()} for ${symbol}? ${JSON.stringify(payload)}. Stocks use market orders unless a limit is set; options use DAY limit orders. Fills are not guaranteed.`)) return;
      const res = await fetch(`${feedBase}/order`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const data = await res.json();
      if (!res.ok || !data.ok) {
        throw new Error(data.error || "Order execution failed");
      }
      setFeedback({ type: "success", text: `${action.toUpperCase()} order ${data.trade.status}; filled ${data.trade.filled_qty ?? 0}.` });
      setTimeout(() => setFeedback(null), 4000);
    } catch (err: any) {
      setFeedback({ type: "error", text: err.message || "Execution error" });
      setTimeout(() => setFeedback(null), 5000);
    } finally {
      setOrderLoading(false);
    }
  };

  const handleUpdatePositionTpSl = async () => {
    if (!window.confirm(`Update local paper exit targets for ${symbol}: TP ${editTpVal || "unchanged"}%, SL ${editSlVal || "unchanged"}%? Monitoring requires the feed process to remain running.`)) return;
    setOrderLoading(true);
    try {
      const res = await fetch(`${feedBase}/order`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "update_tp_sl",
          symbol,

          take_profit_pct: editTpVal ? Number(editTpVal) : undefined,
          stop_loss_pct: editSlVal ? Number(editSlVal) : undefined,
        }),
      });
      const data = await res.json();
      if (!res.ok || !data.ok) {
        throw new Error(data.error || "Failed to update TP/SL");
      }
      setIsEditingTpSl(false);
      setFeedback({ type: "success", text: "Updated TP & SL targets successfully!" });
      setTimeout(() => setFeedback(null), 4000);
    } catch (err: any) {
      setFeedback({ type: "error", text: err.message || "Failed to update TP/SL" });
      setTimeout(() => setFeedback(null), 5000);
    } finally {
      setOrderLoading(false);
    }
  };

  const setCashPercent = (pct: number) => {
    if (!availableCash) return;
    const targetUsd = (availableCash * (pct / 100)).toFixed(2);
    setOrderAmountUsd(targetUsd);
    if (price && price > 0) {
      setOrderQuantity(estimateQuantity(Number(targetUsd)));
    }
  };
  const cancelOrder = async (order: Trade) => {
    if (!window.confirm(`Cancel Alpaca PAPER order ${order.id} for ${order.symbol} (${order.side}, ${order.quantity})?`)) return;
    try {
      const response = await fetch(`${feedBase}/order`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "cancel", order_id: order.id }),
      });
      const result = await response.json();
      if (!response.ok || !result.ok) throw new Error(result.error || "Cancellation failed");
      setFeedback({ type: "success", text: "Cancellation requested; awaiting broker confirmation." });
    } catch (error) {
      setFeedback({ type: "error", text: error instanceof Error ? error.message : "Cancellation failed" });
    }
  };

  return (
    <main className="dashboard">
      <header className="topbar">
        <div>
          <p className="eyebrow">JEV TRADES / ALPACA PAPER</p>
          <h1>{symbol}</h1>
          <p className="muted">
            {symbol} <span className="dot" /> {chartTimeframe === "1m" ? "1 minute" : chartTimeframe === "5m" ? "5 minute" : chartTimeframe === "15m" ? "15 minute" : chartTimeframe === "1h" ? "1 hour" : "4 hour"} candles
          </p>
        </div>
        <div className="topbar-meta">
          <a className="creator-link" href="https://x.com/zadescoxp" target="_blank" rel="noreferrer">
            made by @zade
          </a>
          <div className="connection">
            <span className={`status-dot ${snapshot?.status === "live" ? "is-live" : ""}`} />
            {snapshot?.status ?? "connecting"}
          </div>
        </div>
      </header>

      <section className="portfolio-controls">
        <label>
          ASSET
          <div className="asset-picker">

            <select
              value={symbol}
              onChange={(event) => setSymbol(event.target.value)}
            >
              {symbols.map((item) => (
                <option key={item}>{item}</option>
              ))}
            </select>
          </div>
        </label>
        <label>
          STRATEGY BUDGET ($)
          <input type="number" min="0" step="100" value={capital} onChange={(event) => setCapital(event.target.value)} />
        </label>
        <label>
          MAX POSITION %
          <input type="number" min="1" max="100" step="1" value={maxWalletPositionPct} onChange={(event) => setMaxWalletPositionPct(event.target.value)} />
        </label>
        <label>
          RISK
          <select value={riskAppetite} onChange={(event) => setRiskAppetite(event.target.value)}>
            <option value="conservative">Conservative</option>
            <option value="balanced">Balanced</option>
            <option value="aggressive">Aggressive</option>
          </select>
        </label>
        <label className="key-field">
          TYPESAFE KEY
          <input type="password" autoComplete="off" placeholder="Optional if server has one" value={typeSafeKey} onChange={(event) => setTypeSafeKey(event.target.value)} />
        </label>
        <label>
          TIMEFRAMES
          <select multiple value={activeTimeframes} onChange={(e) => setActiveTimeframes(Array.from(e.target.selectedOptions, option => option.value))} style={{ height: "60px" }}>
            <option value="1m">1m</option>
            <option value="5m">5m</option>
            <option value="15m">15m</option>
            <option value="1h">1h</option>
            <option value="4h">4h</option>
          </select>
        </label>
        <button disabled={!proposedStrategySymbol} className="control" onClick={() => void configurePortfolio(tradingEnabled, proposedStrategySymbol)} title={`Apply budget, risk and timeframes for ${proposedScope}; preserve automation state.`}>Apply settings</button>
        <button disabled={!brokerReady && !tradingEnabled} className={tradingEnabled ? "trade-toggle running" : "trade-toggle"} onClick={() => void configurePortfolio(!tradingEnabled, tradingEnabled ? strategySymbol || proposedStrategySymbol : proposedStrategySymbol)} title={tradingEnabled ? `Pause ${runningScope}; exit monitoring continues.` : `Start ${proposedScope}; options scanning covers every configured underlying.`}>
          {tradingEnabled ? `Stop Jev (${runningScope})` : `Start Jev (${proposedScope})`}
        </button>
      </section>
      <p className="attribution">TypeSafe key: if the field above is filled in, it is sent to and retained by the feed server ({feedBase}) for future automated calls, not just the current request; leave it blank to reuse whatever key the server already has configured.</p>
      <p className="attribution">Broker: {snapshot?.trading.broker_status ?? "connecting"}. Stocks: {snapshot?.data_feeds.stocks ?? "--"}; options: {snapshot?.data_feeds.options ?? "--"}. Budget does not change broker cash. Positions are netted by symbol across timeframes. Configured stock strategy: {strategySymbol || "none (options only)"}. Options scanning covers every configured underlying, independently of the chart.</p>
      {(snapshot?.trading.broker_error || snapshot?.error) && <p role="alert" className="feedback-banner error">{snapshot.trading.broker_error || snapshot.error}</p>}
      {snapshot?.trading.monitor_error && <p role="alert" className="feedback-banner error">Exit monitor error: {snapshot.trading.monitor_error}</p>}
      <section className="quote-grid">
        <div className="quote">
          <span className="label">QUOTE MIDPOINT</span>
          <strong>{price ? `$${price.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` : "--"}</strong>
          <span className={change !== null && change >= 0 ? "positive" : "negative"}>{change === null ? "Waiting for ticks" : `${change >= 0 ? "+" : ""}${change.toFixed(2)}% session`}</span>
        </div>
        <Metric label="RSI (14)" value={snapshot?.indicators.rsi14?.toFixed(2) ?? "--"} />
        <Metric label="MACD" value={snapshot?.indicators.macd?.toFixed(2) ?? "--"} />
        <Metric label="LAST TICK" value={snapshot?.last_tick ? new Date(snapshot.last_tick * 1000).toLocaleTimeString() : "--"} />
      </section>

      <section className="indicator-panel options-panel">
        <div className="panel-head">
          <div>
            <p className="eyebrow">OPTIONS RADAR</p>
            <h2>Autonomous scan across configured underlyings</h2>
          </div>
          <span className="muted">
            {optionsConfig ? `${optionsConfig.feed} feed · paper trading` : "Waiting for options configuration…"}
          </span>
        </div>

        {!optionsConfig ? (
          <p className="muted">Options configuration has not loaded from the feed yet.</p>
        ) : optionsConfig.underlyings.length === 0 ? (
          <p className="muted">No ALPACA_OPTION_UNDERLYINGS configured on the server; options scanning is disabled.</p>
        ) : (
          <>
            {optionsConfig.feed === "indicative" && (
              <p className="attribution">
                Indicative paper pricing is enabled: quotes are derived, not executable OPRA/NBBO, and trades are delayed 15 minutes. Spread and depth checks use this indicative feed; simulated results do not establish live execution quality.
              </p>
            )}

            <details className="position-record">
              <summary className="position-head">
                <strong>Active policy limits</strong>
                <span className="muted">
                  DTE {optionsConfig.policy.min_dte}{"\u2013"}{optionsConfig.policy.max_dte}d {"\u00b7"} exit {optionsConfig.policy.exit_dte}d {"\u00b7"} TP +{optionsConfig.policy.take_profit_pct}% / SL -{optionsConfig.policy.stop_loss_pct}% {"\u00b7"} 19 parameters
                </span>
              </summary>
              <div className="account-grid">
                <Metric label="MIN DTE" value={`${optionsConfig.policy.min_dte}d`} />
                <Metric label="MAX DTE" value={`${optionsConfig.policy.max_dte}d`} />
                <Metric label="EXIT DTE" value={`${optionsConfig.policy.exit_dte}d`} />
                <Metric label="MIN OPEN INTEREST" value={`${optionsConfig.policy.min_open_interest}`} />
                <Metric label="MAX OI AGE" value={`${optionsConfig.policy.max_open_interest_age_days}d`} />
                <Metric label="MIN QUOTE SIZE" value={`${optionsConfig.policy.min_quote_size}`} />
                <Metric label="MAX SPREAD %" value={`${(optionsConfig.policy.max_spread_pct * 100).toFixed(1)}%`} />
                <Metric label="MAX SPREAD $" value={`$${optionsConfig.policy.max_spread_absolute.toFixed(2)}`} />
                <Metric label="MAX QUOTE AGE" value={`${optionsConfig.policy.max_quote_age_seconds}s`} />
                <Metric label="MAX CANDIDATES" value={`${optionsConfig.policy.max_candidates}`} />
                <Metric label="MAX PER-TRADE" value={`${(optionsConfig.policy.max_trade_pct * 100).toFixed(2)}%`} />
                <Metric label="MAX PER-UNDERLYING" value={`${(optionsConfig.policy.max_underlying_pct * 100).toFixed(2)}%`} />
                <Metric label="MAX TOTAL" value={`${(optionsConfig.policy.max_total_pct * 100).toFixed(2)}%`} />
                <Metric label="MAX CONTRACTS" value={`${optionsConfig.policy.max_contracts}`} />
                <Metric label="TAKE PROFIT" value={`+${optionsConfig.policy.take_profit_pct}%`} />
                <Metric label="STOP LOSS" value={`-${optionsConfig.policy.stop_loss_pct}%`} />
                <Metric label="ENTRY TIMEOUT" value={`${optionsConfig.policy.entry_timeout_seconds}s`} />
                <Metric label="EXIT REPRICE" value={`${optionsConfig.policy.exit_reprice_seconds}s`} />
                <Metric label="MAX PRICE DRIFT" value={`${(optionsConfig.policy.max_price_drift_pct * 100).toFixed(1)}%`} />
              </div>
            </details>

            <div className="positions-list">
              {optionsConfig.underlyings.map((underlying) => {
                const scan = snapshot?.trading.option_scans?.[underlying];
                const scanRan = !!scan && (scan.as_of != null || scan.discovered != null || scan.eligible != null || scan.reason != null || scan.error != null);
                return (
                  <details className="position-record" key={underlying}>
                    <summary className="position-head">
                      <div className="trade-tag-group">
                        <strong>{underlying}</strong>
                        <span className="trade-reason-tag">{scan?.status ?? "pending"}</span>
                      </div>
                      <span className="muted">{scanRan ? `${scan?.discovered ?? "--"} found \u00b7 ${scan?.eligible ?? "--"} eligible` : "awaiting first scan"}</span>
                      <time>{scan?.as_of ? new Date(scan.as_of * 1000).toLocaleTimeString() : "--"}</time>
                    </summary>
                    {scan?.error ? <p role="alert" className="feedback-banner error">{scan.error}</p> : null}
                    {scan?.reason ? <p className="muted">{scan.reason}</p> : null}
                    {scan?.candidates?.length ? (
                      <div className="indicator-options">
                        {scan.candidates.map((candidate) => (
                          <button
                            type="button"
                            key={candidate.symbol}
                            className={symbol === candidate.symbol ? "indicator-option active" : "indicator-option"}
                            onClick={() => setSymbol(candidate.symbol)}
                            title={`View ${candidate.symbol} on the chart`}
                          >
                            <span className={candidate.option_type === "call" ? "text-lime" : "text-coral"}>{candidate.option_type.toUpperCase()}</span>
                            {" "}{candidate.expiration} &middot; ${candidate.strike.toFixed(2)} &middot; spread {(candidate.spread_pct * 100).toFixed(1)}% &middot; OI {candidate.open_interest} &middot; premium ${candidate.limit_price.toFixed(2)} (${candidate.cost_per_contract.toFixed(2)}/contract)
                          </button>
                        ))}
                      </div>
                    ) : scanRan ? (
                      <p className="muted">No eligible candidates from the last scan.</p>
                    ) : (
                      <p className="muted">Awaiting first scan.</p>
                    )}
                  </details>
                );
              })}
            </div>
          </>
        )}

        {heldOptionPositions.length ? (
          <>
            <span className="label">HELD OPTION POSITIONS</span>
            <div className="indicator-options">
              {heldOptionPositions.map(([heldSymbol, position]) => (
                <button
                  type="button"
                  key={heldSymbol}
                  className={symbol === heldSymbol ? "indicator-option active" : "indicator-option"}
                  onClick={() => setSymbol(heldSymbol)}
                  title={`View held position ${heldSymbol} on the chart`}
                >
                  {position.underlying ?? heldSymbol}{position.expiration ? ` \u00b7 ${position.expiration}` : ""} &middot; {position.quantity} ct &middot; {position.unrealized_pnl_pct >= 0 ? "+" : ""}{position.unrealized_pnl_pct.toFixed(1)}%
                </button>
              ))}
            </div>
          </>
        ) : null}
      </section>

      <div className="workspace-grid">
        <div className="main-column">
          <section className="chart-panel">
            <div className="panel-head">
              <div>
                <p className="eyebrow">PRICE ACTION</p>
                <h2>{symbol} / USD</h2>
              </div>
              <div className="controls">
                <div className="tf-switcher">
                  {["1m", "5m", "15m", "1h", "4h"].map((tf) => (
                    <button key={tf} className={chartTimeframe === tf ? "control active" : "control"} onClick={() => setChartTimeframe(tf)}>
                      {tf}
                    </button>
                  ))}
                </div>
                {[
                  ["ema20", "EMA 20"],
                  ["sma50", "SMA 50"],
                ].map(([name, label]) => (
                  <button key={name} className={overlays.includes(name) ? "control active" : "control"} onClick={() => toggle(name)}>
                    {label}
                  </button>
                ))}
              </div>
            </div>
            {snapshot && symbolReady ? (
              <MarketChart bars={snapshot.bars} indicatorSeries={snapshot.indicator_series} overlays={overlays} position={selectedPosition} />
            ) : (
              <div className="loading">Waiting for the market feed...</div>
            )}
            <p className="attribution">TradingView Lightweight Charts. Alpaca completed one-minute bars polled every minute; quotes polled every five seconds.</p>
          </section>

          <section className="indicator-panel">
            <div className="panel-head">
              <div>
                <p className="eyebrow">INDICATOR LIBRARY</p>
                <h2>Choose live values to display</h2>
              </div>
              <span className="muted">
                {selectedIndicators.length} selected / {allIndicatorKeys.length}
              </span>
            </div>
            <div className="indicator-groups">
              {indicatorGroups.map((group) => (
                <div className="indicator-group" key={group.title}>
                  <span className="label">{group.title}</span>
                  <div className="indicator-options">
                    {group.items.map(([key, label]) => (
                      <button key={key} className={selectedIndicators.includes(key) ? "indicator-option active" : "indicator-option"} onClick={() => toggleIndicator(key)}>
                        {label}
                      </button>
                    ))}
                  </div>
                </div>
              ))}
            </div>
            <div className="indicator-values">
              {selectedIndicators.map((key) => (
                <div className="indicator-value" key={key}>
                  <span>{labelFor(key)}</span>
                  <strong>{snapshot?.indicators[key] === null || snapshot?.indicators[key] === undefined ? "Warming up" : snapshot.indicators[key]?.toFixed(4)}</strong>
                </div>
              ))}
            </div>
          </section>

          <section className="lower-grid">
            <Metric label="EMA 20" value={snapshot?.indicators.ema20?.toFixed(2) ?? "--"} />
            <Metric label="SMA 50" value={snapshot?.indicators.sma50?.toFixed(2) ?? "Warming up"} />
            <div className="note">
              <span className="label">PIPELINE</span>
              <p>Local TP/SL and options (stop loss, take profit, expiry) exit monitoring remains active for open positions while Jev is paused. Exits require this feed process, a fresh quote, and an open market; fills are not guaranteed.</p>
            </div>
          </section>
        </div>

        <aside className="trading-panel">
          <div className="panel-head">
            <div>
              <p className="eyebrow">PAPER PORTFOLIO & EXECUTION</p>
              <h2>Live Trade Desk</h2>
            </div>
            <span className="paper-badge">ALPACA PAPER</span>
          </div>
          <details>
            <summary>Broker orders ({snapshot?.trading.orders.length ?? 0})</summary>
            {snapshot?.trading.orders.map((order, index) => (
              <div className="position-record" key={order.id ?? index}>
                <strong>{order.symbol} {order.side} — {order.status}</strong>
                <p>{order.filled_qty ?? 0} / {order.quantity} filled · {money(order.price)}</p>
                {order.id && !["filled", "canceled", "expired", "rejected", "replaced"].includes(order.status ?? "") && (
                  <button className="control" onClick={() => void cancelOrder(order)}>Cancel order</button>
                )}
                {order.status === "unknown" && <p role="alert">Submission outcome unknown. This symbol is blocked until broker reconciliation; do not resubmit.</p>}
              </div>
            ))}
          </details>

          <div className="account-grid">
            <Metric label="AVAILABLE CASH" value={money(snapshot?.trading.account.available_cash)} />
            <Metric label="EQUITY" value={money(snapshot?.trading.account.equity)} />
            <Metric label="POSITION SIZE" value={selectedPosition ? `${selectedPosition.quantity.toFixed(isOption ? 0 : 4)} ${units}` : "Flat"} />
            <Metric
              label="POSITION P&L"
              value={
                selectedPosition
                  ? `${selectedPosition.unrealized_pnl_pct >= 0 ? "+" : ""}${selectedPosition.unrealized_pnl_pct.toFixed(2)}%`
                  : "--"
              }
            />
          </div>

          {/* Active Position Spotlight & Quick Exit */}
          {selectedPosition && selectedPosition.quantity > 0 ? (
            <div className="active-position-card">
              <div className="pos-card-header">
                <div className="pos-badge">
                  <span className="pos-side">LONG {selectedPosition.symbol}</span>
                  <span className="pos-source">{selectedPosition.tp_sl_source === "jev" || selectedPosition.tp_sl_source === "jev-options" ? "JEV AUTO" : "MANUAL"}</span>
                </div>
                <div className={`pos-pnl ${selectedPosition.unrealized_pnl_pct >= 0 ? "positive" : "negative"}`}>
                  {selectedPosition.unrealized_pnl_pct >= 0 ? "+" : ""}
                  {selectedPosition.unrealized_pnl_pct.toFixed(2)}%
                </div>
              </div>

              <div className="pos-card-body">
                <div className="pos-metric">
                  <span className="pos-label">Entry:</span>
                  <strong>${selectedPosition.average_entry_price.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</strong>
                </div>
                <div className="pos-metric">
                  <span className="pos-label">Size:</span>
                  <strong>{selectedPosition.quantity.toFixed(6)}</strong>
                </div>
                <div className="pos-metric">
                  <span className="pos-label">Take Profit:</span>
                  <strong className="text-lime">
                    {selectedPosition.take_profit_price
                      ? `$${selectedPosition.take_profit_price.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })} (+${selectedPosition.take_profit_pct?.toFixed(2)}%)`
                      : "None"}
                  </strong>
                </div>
                <div className="pos-metric">
                  <span className="pos-label">Stop Loss:</span>
                  <strong className="text-coral">
                    {selectedPosition.stop_loss_price
                      ? `$${selectedPosition.stop_loss_price.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })} (-${selectedPosition.stop_loss_pct?.toFixed(2)}%)`
                      : "None"}
                  </strong>
                </div>
                {selectedPosition.expiration ? (
                  <div className="pos-metric">
                    <span className="pos-label">Expiry:</span>
                    <strong>{selectedPosition.expiration}</strong>
                  </div>
                ) : null}
                {selectedPosition.exit_reason ? (
                  <div className="pos-metric">
                    <span className="pos-label">Exit reason:</span>
                    <strong>{selectedPosition.exit_reason}</strong>
                  </div>
                ) : null}
              </div>
              <p className="size-hint">Market value: {money(selectedPosition.market_value)} · Unrealized P&amp;L: {money(selectedPosition.unrealized_pnl)}</p>

              {isEditingTpSl ? (
                <div className="tpsl-edit-box">
                  <div className="tpsl-edit-inputs">
                    <label>
                      TP %
                      <input
                        type="number"
                        step="0.5"
                        placeholder="e.g. 5"
                        value={editTpVal}
                        onChange={(e) => setEditTpVal(e.target.value)}
                      />
                    </label>
                    <label>
                      SL %
                      <input
                        type="number"
                        step="0.5"
                        placeholder="e.g. 2.5"
                        value={editSlVal}
                        onChange={(e) => setEditSlVal(e.target.value)}
                      />
                    </label>
                  </div>
                  <div className="tpsl-edit-actions">
                    <button className="btn-sm btn-save" onClick={handleUpdatePositionTpSl} disabled={orderLoading}>
                      Save TP/SL
                    </button>
                    <button className="btn-sm btn-cancel" onClick={() => setIsEditingTpSl(false)}>
                      Cancel
                    </button>
                  </div>
                </div>
              ) : (
                <div className="pos-card-actions">
                  <button
                    className="exit-btn danger"
                    onClick={() => handleExecuteOrder("exit")}
                    disabled={orderLoading || !brokerReady}
                    title="Submit a paper order to exit this position; execution is not guaranteed"
                  >
                    {orderLoading ? "Exiting..." : `Exit Position (100%)`}
                  </button>
                  <button
                    className="exit-btn secondary"
                    onClick={() => handleExecuteOrder("sell", { pct_of_position: 0.5 })}
                    disabled={orderLoading || !brokerReady || (isOption && selectedPosition.quantity < 2)}
                    title="Exit 50% of this position"
                  >
                    Exit 50%
                  </button>
                  <button
                    className="exit-btn outline"
                    onClick={() => {
                      setEditTpVal(selectedPosition.take_profit_pct?.toString() || "");
                      setEditSlVal(selectedPosition.stop_loss_pct?.toString() || "");
                      setIsEditingTpSl(true);
                    }}
                  >
                    Edit TP/SL
                  </button>
                </div>
              )}
            </div>
          ) : null}

          {/* Activity Tabs */}
          <div className="activity-tabs">
            <button className={activityTab === "manual" ? "activity-tab active" : "activity-tab"} onClick={() => setActivityTab("manual")}>
              Trade Order
            </button>
            <button className={activityTab === "logs" ? "activity-tab active" : "activity-tab"} onClick={() => setActivityTab("logs")}>
              Jev Logs
            </button>
            <button className={activityTab === "positions" ? "activity-tab active" : "activity-tab"} onClick={() => setActivityTab("positions")}>
              History ({snapshot?.trading.positions.length ?? 0})
            </button>
          </div>

          {feedback ? <div className={`feedback-banner ${feedback.type}`}>{feedback.text}</div> : null}

          {activityTab === "manual" ? (
            <div className="manual-order-panel">
              <div className="side-selector">
                <button
                  className={`side-btn buy-side ${orderSide === "buy" ? "active" : ""}`}
                  onClick={() => setOrderSide("buy")}
                >
                  BUY / LONG
                </button>
                <button
                  className={`side-btn sell-side ${orderSide === "sell" ? "active" : ""}`}
                  onClick={() => setOrderSide("sell")}
                >
                  SELL / EXIT
                </button>
              </div>
              
              <label className="order-field-row">
                LIMIT PRICE / SHARE OR PREMIUM (optional)
                <input type="number" min="0.01" step="0.01" value={limitPrice} onChange={(e) => setLimitPrice(e.target.value)} placeholder={isOption ? "Fresh quote limit" : "Market order"} />
              </label>
              <p className="size-hint">{isOption ? `Whole contracts; multiplier ${multiplier}. Buy to open / sell to close only.` : "Shares; fractional quantities require a fractionable asset."}</p>

              {/* Sizing Mode Switch */}
              <div className="order-field-row">
                <span className="field-label">ORDER SIZE</span>
                <div className="sizing-mode-toggle">
                  <button
                    className={`mode-btn ${sizingMode === "usd" ? "active" : ""}`}
                    onClick={() => setSizingMode("usd")}
                  >
                    USD ($)
                  </button>
                  <button
                    className={sizingMode === "quantity" ? "mode-btn active" : "mode-btn"}
                    onClick={() => setSizingMode("quantity")}
                  >
                    {units} (Qty)
                  </button>
                </div>
              </div>

              {/* Sizing Input */}
              <div className="order-input-wrapper">
                {sizingMode === "usd" ? (
                  <div className="input-group">
                    <span className="input-prefix">$</span>
                    <input
                      type="number"
                      min="1"
                      step="100"
                      value={orderAmountUsd}
                      onChange={(e) => {
                        const val = e.target.value;
                        setOrderAmountUsd(val);
                        if (price && price > 0) {
                          setOrderQuantity(estimateQuantity(Number(val)));
                        }
                      }}
                      placeholder="Amount in USD"
                    />
                  </div>
                ) : (
                  <div className="input-group">
                    <span className="input-prefix">{symbol.split("-")[0]}</span>
                    <input
                      type="number"
                      min={isOption ? "1" : "0.000001"}
                      step={isOption ? "1" : "0.000001"}
                      value={orderQuantity}
                      onChange={(e) => {
                        const val = e.target.value;
                        setOrderQuantity(val);
                        if (price && price > 0) {
                          setOrderAmountUsd((Number(val) * price * multiplier).toFixed(2));
                        }
                      }}
                      placeholder={`Quantity of ${symbol}`}
                    />
                  </div>
                )}
              </div>

              {/* Conversion helper */}
              <div className="size-hint">
                {sizingMode === "usd" ? (
                  <span>
                    ≈ {price && Number(orderAmountUsd) > 0 ? estimateQuantity(Number(orderAmountUsd)) : "0"} {units}
                  </span>
                ) : (
                  <span>
                    ≈ {money(price && Number(orderQuantity) > 0 ? Number(orderQuantity) * price * multiplier : 0)} USD
                  </span>
                )}
              </div>

              {/* Quick Cash Presets */}
              <div className="quick-presets">
                <button className="preset-chip" onClick={() => setCashPercent(25)}>
                  25%
                </button>
                <button className="preset-chip" onClick={() => setCashPercent(50)}>
                  50%
                </button>
                <button className="preset-chip" onClick={() => setCashPercent(75)}>
                  75%
                </button>
                <button className="preset-chip" onClick={() => setCashPercent(100)}>
                  100% Cash
                </button>
              </div>

              {orderSide === "buy" ? (
                <>
                  {/* Take Profit Setting */}
                  <div className="risk-setting-row">
                    <div className="risk-header">
                      <label className="checkbox-label">
                        <input
                          type="checkbox"
                          checked={tpEnabled}
                          onChange={(e) => setTpEnabled(e.target.checked)}
                        />
                        <span>TAKE PROFIT (TP)</span>
                      </label>
                      {tpEnabled && price ? (
                        <span className="target-calc text-lime">
                          Target: ${(price * (1 + Number(tpPct) / 100)).toLocaleString(undefined, { maximumFractionDigits: 2 })}
                        </span>
                      ) : null}
                    </div>
                    {tpEnabled ? (
                      <div className="risk-input-row">
                        <div className="input-group compact">
                          <input
                            aria-label="Take profit percent"
                            type="number"
                            min="0.1"
                            step="0.5"
                            value={tpPct}
                            onChange={(e) => setTpPct(e.target.value)}
                          />
                          <span className="input-suffix">% gain</span>
                        </div>
                        <div className="risk-presets">
                          {["2", "5", "8", "12"].map((p) => (
                            <button
                              key={p}
                              className={`preset-chip sm ${tpPct === p ? "active" : ""}`}
                              onClick={() => setTpPct(p)}
                            >
                              +{p}%
                            </button>
                          ))}
                        </div>
                      </div>
                    ) : null}
                  </div>

                  {/* Stop Loss Setting */}
                  <div className="risk-setting-row">
                    <div className="risk-header">
                      <label className="checkbox-label">
                        <input
                          type="checkbox"
                          checked={slEnabled}
                          onChange={(e) => setSlEnabled(e.target.checked)}
                        />
                        <span>STOP LOSS (SL)</span>
                      </label>
                      {slEnabled && price ? (
                        <span className="target-calc text-coral">
                          Target: ${(price * (1 - Number(slPct) / 100)).toLocaleString(undefined, { maximumFractionDigits: 2 })}
                        </span>
                      ) : null}
                    </div>
                    {slEnabled ? (
                      <div className="risk-input-row">
                        <div className="input-group compact">
                          <input
                            aria-label="Stop loss percent"
                            type="number"
                            min="0.1"
                            step="0.5"
                            value={slPct}
                            onChange={(e) => setSlPct(e.target.value)}
                          />
                          <span className="input-suffix">% loss</span>
                        </div>
                        <div className="risk-presets">
                          {["1.5", "2.5", "4", "6"].map((p) => (
                            <button
                              key={p}
                              className={`preset-chip sm ${slPct === p ? "active" : ""}`}
                              onClick={() => setSlPct(p)}
                            >
                              -{p}%
                            </button>
                          ))}
                        </div>
                      </div>
                    ) : null}
                  </div>
                </>
              ) : (
                <div className="sell-info-box">
                  <p>
                    {selectedPosition && selectedPosition.quantity > 0
                      ? `You hold ${selectedPosition.quantity} ${units} of ${symbol}. A sell order reduces or closes the long position after fills.`
                      : `No active position for ${symbol}. Enter a quantity to exit if held.`}
                  </p>
                </div>
              )}

              {/* Main Submit Button */}
              <button
                className={`main-order-btn ${orderSide === "buy" ? "buy-action" : "sell-action"}`}
                onClick={() => handleExecuteOrder(orderSide)}
                disabled={orderLoading || !price || !brokerReady}
              >
                {orderLoading
                  ? "Submitting Order..."
                  : orderSide === "buy"
                  ? `Manual Buy ${symbol}`
                  : `Manual Sell / Exit ${symbol}`}
              </button>
            </div>
          ) : activityTab === "logs" ? (
            <div className="agent-log">
              {snapshot?.trading.agent_log.length ? (
                snapshot.trading.agent_log
                  .slice()
                  .reverse()
                  .map((event, index) => (
                    <details className="agent-event" key={`${event.timestamp}-${index}`}>
                      <summary>
                        <span className={`action action-${event.executed}`}>{event.executed.toUpperCase()}</span>
                        <strong>{event.price ? `$${event.price.toLocaleString(undefined, { maximumFractionDigits: 2 })}` : "--"}</strong>
                        <span>{event.reason ?? (event.confidence === null ? "error" : `${(event.confidence * 100).toFixed(0)}% confidence`)}</span>
                        <time>{new Date(event.timestamp * 1000).toLocaleTimeString()}</time>
                      </summary>
                      <div className="agent-payloads">
                        {event.trade ? (
                          <div className="trade-meta-box">
                            <span className="payload-title">TRADE DETAILS</span>
                            <div className="trade-meta-grid">
                              <div>Side: {event.trade.side.toUpperCase()}</div>
                              <div>Qty: {event.trade.quantity.toFixed(6)}</div>
                              <div>Fill price: {money(event.trade.price)}</div>
                              {event.trade.tp ? <div className="text-lime">TP: ${event.trade.tp.toLocaleString()}</div> : null}
                              {event.trade.sl ? <div className="text-coral">SL: ${event.trade.sl.toLocaleString()}</div> : null}
                              {event.trade.realized_pnl != null ? (
                                <div className={event.trade.realized_pnl >= 0 ? "text-lime" : "text-coral"}>
                                  Realized P&L: ${event.trade.realized_pnl.toFixed(2)}
                                </div>
                              ) : null}
                            </div>
                          </div>
                        ) : null}
                        {event.request ? (
                          <div>
                            <span className="payload-title">REQUEST SENT</span>
                            <pre>{JSON.stringify(event.request, null, 2)}</pre>
                          </div>
                        ) : null}
                        {event.response ? (
                          <div>
                            <span className="payload-title">RESPONSE RECEIVED</span>
                            <pre>{JSON.stringify(event.response, null, 2)}</pre>
                          </div>
                        ) : null}
                      </div>
                      {event.error ? <em>{event.error}</em> : null}
                    </details>
                  ))
              ) : (
                <p className="loading-log">
                  {snapshot && !snapshot.trading.agent_enabled
                    ? "TypeSafe key not loaded by the Python feed"
                    : "Waiting for trade events or Jev decisions..."}
                </p>
              )}
            </div>
          ) : (
            <div className="positions-list">
              {snapshot?.trading.positions.length ? (
                snapshot.trading.positions
                  .slice()
                  .reverse()
                  .map((trade, index) => (
                    <div className={`position-record position-${trade.side}`} key={`${trade.timestamp}-${index}`}>
                      <div className="position-head">
                        <div className="trade-tag-group">
                          <span className={`action action-${trade.side}`}>
                            {trade.symbol} {trade.side.toUpperCase()}
                          </span>
                          <span className="trade-reason-tag">
                            {trade.reason === "stop_loss"
                              ? "🛑 STOP LOSS"
                              : trade.reason === "take_profit"
                              ? "🎯 TAKE PROFIT"
                              : trade.is_manual
                              ? "👤 MANUAL"
                              : trade.reason === "jev" || trade.reason === "jev-options" ? "JEV AUTO" : "ALPACA"}
                          </span>
                        </div>
                        <time>{new Date(trade.timestamp * 1000).toLocaleString()}</time>
                      </div>
                      <div className="position-details">
                        <Metric label="FILL PRICE" value={money(trade.price)} />
                        <Metric label="QUANTITY" value={trade.quantity.toFixed(6)} />
                        <Metric label="STATUS" value={trade.status ?? "filled"} />
                        <Metric label="REALIZED P&L" value={money(trade.realized_pnl)} />
                        {trade.expiration ? <Metric label="EXPIRY" value={trade.expiration} /> : null}
                        {trade.exit_reason ? <Metric label="EXIT REASON" value={trade.exit_reason} /> : null}
                        {trade.tp ? (
                          <Metric label="TAKE PROFIT" value={`$${trade.tp.toLocaleString(undefined, { maximumFractionDigits: 2 })}`} />
                        ) : null}
                        {trade.sl ? (
                          <Metric label="STOP LOSS" value={`$${trade.sl.toLocaleString(undefined, { maximumFractionDigits: 2 })}`} />
                        ) : null}
                      </div>
                    </div>
                  ))
              ) : (
                <p className="loading-log">No executed buy or sell positions yet.</p>
              )}
            </div>
          )}
        </aside>
      </div>

      <section className="contribute-panel">
        <div>
          <p className="eyebrow">OPEN SOURCE</p>
          <h2>Build with Jev Trades</h2>
          <p className="muted">Autonomous agentic intelligence meets precise manual execution.</p>
        </div>
        <a className="github-link" href="https://github.com/zadescoxp/Jev-Trades" target="_blank" rel="noreferrer">
          Contribute on GitHub <span aria-hidden="true">-&gt;</span>
        </a>
      </section>
    </main>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="metric">
      <span className="label">{label}</span>
      <strong>{value}</strong>
    </div>
  );
}
