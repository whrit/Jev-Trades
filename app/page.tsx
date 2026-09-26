"use client";

import dynamic from "next/dynamic";
import Link from "next/link";
import ScopeEditor, { type TradingScope } from "./scope-editor";

import { useEffect, useMemo, useState, type KeyboardEvent } from "react";

const MarketChart = dynamic(() => import("./market-chart"), { ssr: false });

function dismissIndicatorPicker(event: KeyboardEvent<HTMLElement>) {
  const picker = event.currentTarget.closest("details");
  if (event.key === "Escape" && picker) {
    picker.open = false;
    picker.querySelector("summary")?.focus();
  }
}

type Bar = {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
};
type Indicators = Record<string, number | null>;
type Trade = {
  symbol: string;
  multiplier?: number;
  estimated_price?: number;
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
  symbol?: string;
  strategy?: string;
  time_frame?: string;
  timestamp: number;
  price?: number;
  action: string;
  confidence: number | null;
  executed: string;
  reason?: string;
  request?: Record<string, unknown>;
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
  max_positions_per_underlying: number;
  min_confidence: number;
  stop_loss_pct: number;
  take_profit_pct: number;
  exit_dte: number;
  entry_timeout_seconds: number;
  exit_reprice_seconds: number;
  max_price_drift_pct: number;
};
const optionPolicyFields = [
  {
    key: "max_trade_pct",
    label: "Per-entry premium (%)",
    scale: 100,
    min: 0.01,
    max: 100,
    step: 0.01,
  },
  {
    key: "max_underlying_pct",
    label: "Per-ticker exposure (%)",
    scale: 100,
    min: 0.01,
    max: 100,
    step: 0.01,
  },
  {
    key: "max_total_pct",
    label: "Total options exposure (%)",
    scale: 100,
    min: 0.01,
    max: 100,
    step: 0.01,
  },
  {
    key: "max_positions_per_underlying",
    label: "Positions per ticker",
    scale: 1,
    min: 1,
    max: undefined,
    step: 1,
  },
  {
    key: "max_contracts",
    label: "Contracts per order",
    scale: 1,
    min: 1,
    max: undefined,
    step: 1,
  },
  {
    key: "min_confidence",
    label: "Jev confidence (%)",
    scale: 100,
    min: 0,
    max: 100,
    step: 0.01,
  },
] as const;
type OptionPolicyKey = (typeof optionPolicyFields)[number]["key"];

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
    options_exposure?: number | null;
    crypto_status?: string | null;
    crypto_buying_power?: number | null;
    positions: Record<string, Position>;
    max_wallet_position_pct: number;
    risk_appetite: string;
    paper_trading: boolean;
  };
  agent_log: AgentEvent[];
  positions: Trade[];
  agent_enabled: boolean;

  orders: Trade[];
  broker_status: string;
  broker_error: string | null;
  option_scans?: Record<string, OptionScan>;
  monitor_error?: string | null;
};
type Snapshot = {
  symbol: string;
  supported_symbols: string[];
  trading_scope?: TradingScope;
  status: string;
  error: string | null;
  instruments: Record<
    string,
    {
      asset_class: string;
      multiplier: number;
      underlying?: string;
      expiration?: string;
      option_type?: "call" | "put";
      min_order_size?: number | null;
      min_trade_increment?: number | null;
      price_increment?: number | null;
    }
  >;
  data_feeds: { stocks: string; options: string; crypto: string };
  trading_enabled: boolean;
  price: number | null;
  bars: Bar[];
  indicators: Indicators;
  indicator_series: { ema20: (number | null)[]; sma50: (number | null)[] };
  last_tick: number | null;
  trading: Trading;
  settings: {
    capital: number;
    max_wallet_position_pct: number;
    risk_appetite: string;
    active_timeframes: string[];
    chart_timeframe: string;
  };
  options?: OptionsConfig;
};

const feedBase =
  process.env.NEXT_PUBLIC_MARKET_FEED_URL ?? "http://127.0.0.1:8765";
const streamBase =
  process.env.NEXT_PUBLIC_MARKET_STREAM_URL ?? `${feedBase}/stream`;
const isCryptoTicker = (value: string) => value.includes("/");
type InstrumentInfo = {
  asset_class?: string;
  price_increment?: number | null;
  min_trade_increment?: number | null;
};
const exactDecimals = (value: number) => {
  const str = Math.abs(value).toString();
  const eIndex = str.indexOf("e");
  if (eIndex === -1) {
    const dot = str.indexOf(".");
    return dot === -1 ? 0 : str.length - dot - 1;
  }
  const mantissa = str.slice(0, eIndex);
  const exponent = Number(str.slice(eIndex + 1));
  const dot = mantissa.indexOf(".");
  const mantissaDecimals = dot === -1 ? 0 : mantissa.length - dot - 1;
  return Math.max(0, mantissaDecimals - exponent);
};
const decimalsFromIncrement = (
  increment: number | null | undefined,
  fallback: number,
) => {
  if (!increment || increment <= 0) return fallback;
  return Math.min(20, exactDecimals(increment));
};
const incrementAttr = (value: number | null | undefined, fallback: number) => {
  const base = value && value > 0 ? value : fallback;
  return base.toFixed(decimalsFromIncrement(base, 8));
};
const priceDecimals = (instrument?: InstrumentInfo) =>
  instrument?.asset_class === "crypto"
    ? decimalsFromIncrement(instrument.price_increment, 8)
    : 2;
const qtyDecimals = (instrument?: InstrumentInfo) =>
  instrument?.asset_class === "us_option"
    ? 0
    : instrument?.asset_class === "crypto"
      ? decimalsFromIncrement(instrument.min_trade_increment, 8)
      : 6;
const money = (value: number | null | undefined, decimals = 2) =>
  value == null
    ? "--"
    : `$${value.toLocaleString(undefined, { minimumFractionDigits: Math.min(2, decimals), maximumFractionDigits: decimals })}`;
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
const allIndicatorKeys = indicatorGroups.flatMap((group) =>
  group.items.map(([key]) => key),
);

export default function Home() {
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [feedError, setFeedError] = useState<string | null>(null);
  const [assetMode, setAssetMode] = useState<"equities" | "crypto">("equities");
  const [equitySymbol, setEquitySymbol] = useState("");
  const [cryptoSymbol, setCryptoSymbol] = useState("");
  const symbol = assetMode === "crypto" ? cryptoSymbol : equitySymbol;
  const setSymbolForMode = (target: "equities" | "crypto", value: string) =>
    target === "crypto" ? setCryptoSymbol(value) : setEquitySymbol(value);
  const [workspace, setWorkspace] = useState<
    "terminal" | "activity" | "settings"
  >("terminal");
  const [deskTab, setDeskTab] = useState<
    "positions" | "orders" | "decisions" | "fills"
  >("positions");
  const [generalDraft, setGeneralDraft] = useState<Partial<{
    capital: string;
    maxPosition: string;
    risk: string;
    frames: string[];
  }> | null>(null);
  const [configSaving, setConfigSaving] = useState(false);
  const scope = snapshot?.trading_scope;
  const capital =
    generalDraft?.capital ?? String(snapshot?.settings.capital ?? "");
  const maxWalletPositionPct =
    generalDraft?.maxPosition ??
    String((snapshot?.settings.max_wallet_position_pct ?? 0.75) * 100);
  const riskAppetite =
    generalDraft?.risk ?? snapshot?.settings.risk_appetite ?? "balanced";
  const activeTimeframes =
    generalDraft?.frames ?? snapshot?.settings.active_timeframes ?? [];
  const [typeSafeKey, setTypeSafeKey] = useState("");
  const [tradingEnabled, setTradingEnabled] = useState(false);
  const [overlays, setOverlays] = useState(["ema20"]);
  const [selectedIndicators, setSelectedIndicators] = useState([
    "ema_20",
    "sma_50",
    "relative_strength_index_14",
    "macd_level_12_26",
  ]);
  const [limitPrice, setLimitPrice] = useState("");
  const [chartTimeframe, setChartTimeframe] = useState<string>("1m");
  const [optionDraft, setOptionDraft] = useState<Partial<
    Record<OptionPolicyKey, string>
  > | null>(null);
  const [optionSaving, setOptionSaving] = useState(false);
  const [optionFeedback, setOptionFeedback] = useState<{
    type: "success" | "error";
    text: string;
  } | null>(null);

  // Manual Trading State
  const [orderSide, setOrderSide] = useState<"buy" | "sell">("buy");
  const [sizingMode, setSizingMode] = useState<"usd" | "quantity">("usd");
  const [orderAmountUsd, setOrderAmountUsd] = useState("5000");
  const [orderQuantity, setOrderQuantity] = useState("1");
  const [stopPrice, setStopPrice] = useState("");
  const [timeInForce, setTimeInForce] = useState<"gtc" | "ioc">("gtc");
  const [tpEnabled, setTpEnabled] = useState(true);
  const [tpPct, setTpPct] = useState("5.0");
  const [slEnabled, setSlEnabled] = useState(true);
  const [slPct, setSlPct] = useState("2.5");
  const [orderLoading, setOrderLoading] = useState(false);
  const [feedback, setFeedback] = useState<{
    type: "success" | "error";
    text: string;
  } | null>(null);

  // Edit TP/SL state for active position
  const [isEditingTpSl, setIsEditingTpSl] = useState(false);
  const [editTpVal, setEditTpVal] = useState("");
  const [editSlVal, setEditSlVal] = useState("");

  useEffect(() => {
    const source = new EventSource(
      `${streamBase}?symbol=${encodeURIComponent(symbol)}&timeframe=${encodeURIComponent(chartTimeframe)}`,
    );
    source.onmessage = (event) => {
      const next = JSON.parse(event.data) as Snapshot;
      setSnapshot(next);
      setFeedError(null);
      if (!symbol || !next.supported_symbols.includes(symbol)) {
        const match = next.supported_symbols.find(
          (candidate) => isCryptoTicker(candidate) === (assetMode === "crypto"),
        );
        if (match) setSymbolForMode(assetMode, match);
      }
      setTradingEnabled(next.trading_enabled);
    };
    source.onerror = () => {
      setFeedError(
        "Feed connection unavailable. Check that the local feed is running.",
      );
      setSnapshot((current) =>
        current
          ? {
              ...current,
              status: "feed unavailable",
              trading: {
                ...current.trading,
                broker_status: "unavailable",
                broker_error: "Feed connection unavailable",
              },
            }
          : null,
      );
    };
    return () => source.close();
  }, [symbol, chartTimeframe, assetMode]);

  const configurePortfolio = async (enabled?: boolean) => {
    if (!snapshot || configSaving) return;
    const changingAutomation = enabled !== undefined;
    const payload = changingAutomation
      ? { trading_enabled: enabled }
      : {
          capital: Number(capital),
          max_wallet_position_pct: Number(maxWalletPositionPct) / 100,
          risk_appetite: riskAppetite,
          active_timeframes: activeTimeframes,
          typesafe_api_key: typeSafeKey.trim() || undefined,
        };
    const description = changingAutomation
      ? enabled
        ? `Start Alpaca PAPER automation? This is a single global switch shared by both the equities/options and crypto views.
Options: ${scope?.options_enabled ? scope.option_underlyings.join(", ") : "off"}
Stock: ${scope?.stock_enabled ? scope.stock_symbol : "off"}
Crypto: ${scope?.crypto_enabled ? scope.crypto_symbol : "off"}
Applied budget: ${money(snapshot.settings.capital)}; evaluation: ${snapshot.settings.active_timeframes.join(", ")}
Market indicators, option candidates and portfolio context will be sent to TypeSafe. Jev may submit orders until paused.`
        : "Pause new automated decisions? Existing orders are not canceled. Protective exits remain active while this feed is running; fills are not guaranteed."
      : `Apply Alpaca PAPER settings?
Budget: ${money(Number(capital))}
Per-symbol cap: ${maxWalletPositionPct}%
Stock risk: ${riskAppetite}
Strategy evaluation: ${activeTimeframes.join(", ")}
Automation stays ${tradingEnabled ? "ON; settings take effect immediately" : "PAUSED"}.${typeSafeKey.trim() ? "\nThe entered TypeSafe key will be retained by the feed server for future calls." : ""}`;
    if (!window.confirm(description)) return;
    setConfigSaving(true);
    setFeedback(null);
    try {
      const response = await fetch(`${feedBase}/config`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const result = await response.json();
      if (!response.ok || !result.ok)
        throw new Error(result.error || "Could not save configuration");
      setSnapshot((current) =>
        current
          ? {
              ...current,
              settings: {
                ...result.settings,
                chart_timeframe: current.settings.chart_timeframe,
              },
              trading_enabled: result.trading_enabled,
              trading_scope: result.trading_scope,
            }
          : current,
      );
      setTradingEnabled(result.trading_enabled);
      if (!changingAutomation) {
        setGeneralDraft(null);
        setTypeSafeKey("");
      }
      setFeedback({
        type: "success",
        text: changingAutomation
          ? enabled
            ? "Automation started with the saved scope."
            : "Automation paused. Protective exits remain active."
          : "Strategy settings saved.",
      });
    } catch (error) {
      setFeedback({
        type: "error",
        text:
          error instanceof Error
            ? error.message
            : "Could not save configuration",
      });
    } finally {
      setConfigSaving(false);
    }
  };

  const symbolReady =
    snapshot?.symbol === symbol &&
    snapshot?.settings.chart_timeframe === chartTimeframe;
  const price = symbolReady ? snapshot?.price : undefined;
  const change = useMemo(() => {
    const first = symbolReady ? snapshot?.bars[0]?.open : undefined;
    return price && first ? ((price - first) / first) * 100 : null;
  }, [price, symbolReady, snapshot?.bars]);

  const selectedPosition = snapshot?.trading.account.positions[symbol];
  const availableCash = snapshot?.trading.account.available_cash ?? 0;
  const symbols = (snapshot?.supported_symbols ?? []).filter(
    (ticker) => isCryptoTicker(ticker) === (assetMode === "crypto"),
  );
  const instrument = snapshot?.instruments[symbol];
  const isCrypto = assetMode === "crypto";
  const isOption = !isCrypto && instrument?.asset_class === "us_option";
  const multiplier = instrument?.multiplier ?? 1;
  const brokerReady = snapshot?.trading.broker_status === "connected";
  const units = isOption ? "contracts" : isCrypto ? "coins" : "shares";
  const optionsConfig = snapshot?.options;
  const estimateQuantity = (amount: number) =>
    isOption
      ? Math.floor(amount / ((price || 1) * multiplier)).toString()
      : (amount / (price || 1)).toFixed(qtyDecimals(instrument));
  const cryptoPriceIncrement = isCrypto
    ? (instrument?.price_increment ??
      (price && price < 1 ? 0.00000001 : price && price < 100 ? 0.0001 : 0.01))
    : undefined;
  const chartPriceFormat = cryptoPriceIncrement
    ? {
        minMove: cryptoPriceIncrement,
        precision: decimalsFromIncrement(cryptoPriceIncrement, 8),
      }
    : undefined;
  const cryptoPriceStep = incrementAttr(cryptoPriceIncrement, 0.01);
  const cryptoQtyStep = incrementAttr(
    instrument?.min_trade_increment,
    0.00000001,
  );
  const cryptoQtyMin = incrementAttr(
    instrument?.min_order_size ?? instrument?.min_trade_increment,
    0.00000001,
  );
  const toggle = (name: string) =>
    setOverlays((current) =>
      current.includes(name)
        ? current.filter((item) => item !== name)
        : [...current, name],
    );
  const toggleIndicator = (name: string) =>
    setSelectedIndicators((current) =>
      current.includes(name)
        ? current.filter((item) => item !== name)
        : [...current, name],
    );
  const labelFor = (name: string) =>
    indicatorGroups
      .flatMap((group) => group.items)
      .find(([key]) => key === name)?.[1] ?? name;
  const heldOptionPositions = Object.entries(
    snapshot?.trading.account.positions ?? {},
  ).filter(
    ([, position]) =>
      position.asset_class === "us_option" && position.quantity > 0,
  );
  const heldCryptoPositions = Object.entries(
    snapshot?.trading.account.positions ?? {},
  ).filter(
    ([ticker, position]) => isCryptoTicker(ticker) && position.quantity > 0,
  );
  const editablePolicyAvailable =
    optionsConfig &&
    Number.isFinite(optionsConfig.policy.max_positions_per_underlying) &&
    Number.isFinite(optionsConfig.policy.min_confidence);
  const proposedOptionPolicy = editablePolicyAvailable
    ? ({
        ...optionsConfig.policy,
        ...Object.fromEntries(
          optionPolicyFields.map(({ key, scale }) => [
            key,
            Number(optionDraft?.[key] ?? optionsConfig.policy[key] * scale) /
              scale,
          ]),
        ),
      } as OptionPolicy)
    : null;
  const optionCapital =
    snapshot?.trading.account.equity == null
      ? null
      : Math.min(snapshot.settings.capital, snapshot.trading.account.equity);
  const applyOptionPolicy = async () => {
    if (!proposedOptionPolicy || optionCapital === null) return;
    const policy = proposedOptionPolicy;
    if (
      policy.max_trade_pct > policy.max_underlying_pct ||
      policy.max_underlying_pct > policy.max_total_pct
    ) {
      setOptionFeedback({
        type: "error",
        text: "Entry limit must not exceed the per-ticker limit, which must not exceed the total options limit.",
      });
      return;
    }
    if (
      !window.confirm(
        `Apply Alpaca PAPER options limits for ${optionsConfig?.underlyings.join(", ")}?
Per entry: ${policy.max_trade_pct * 100}% (${money(optionCapital * policy.max_trade_pct)})
Per ticker, including stock exposure: ${policy.max_underlying_pct * 100}% (${money(optionCapital * policy.max_underlying_pct)})
Total options: ${policy.max_total_pct * 100}% (${money(optionCapital * policy.max_total_pct)})
Distinct positions per ticker: ${policy.max_positions_per_underlying}; contracts per order: ${policy.max_contracts}
Jev confidence threshold: ${policy.min_confidence * 100}%

Automation stays ${tradingEnabled ? "ON; new orders may use these limits immediately" : "OFF"}. Existing positions, pending orders and exit targets are not changed. These limits will be saved on the feed server.`,
      )
    )
      return;
    setOptionSaving(true);
    setOptionFeedback(null);
    try {
      const response = await fetch(`${feedBase}/config`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          option_policy: Object.fromEntries(
            optionPolicyFields.map(({ key }) => [key, policy[key]]),
          ),
        }),
      });
      const result = await response.json();
      if (!response.ok || !result.ok)
        throw new Error(result.error || "Options policy update failed");
      setSnapshot((current) =>
        current?.options
          ? {
              ...current,
              options: { ...current.options, policy: result.option_policy },
            }
          : current,
      );
      setOptionDraft(null);
      setOptionFeedback({
        type: "success",
        text: "Options limits saved. New entries use the updated policy; existing exits are unchanged.",
      });
    } catch (error) {
      setOptionFeedback({
        type: "error",
        text:
          error instanceof Error
            ? error.message
            : "Options policy update failed",
      });
    } finally {
      setOptionSaving(false);
    }
  };

  // Execute manual order (buy, sell, exit)
  const handleExecuteOrder = async (
    action: "buy" | "sell" | "exit",
    extraParams: Record<string, unknown> = {},
    immediate = false,
  ) => {
    const orderLimitPrice = immediate ? "" : limitPrice;
    const orderStopPrice = immediate ? "" : stopPrice;
    if (isCrypto && orderStopPrice && !orderLimitPrice) {
      setFeedback({
        type: "error",
        text: "Stop-limit orders require a limit price too.",
      });
      return;
    }
    setOrderLoading(true);
    setFeedback(null);
    try {
      const payload: Record<string, unknown> = {
        action,
        symbol,
        limit_price: orderLimitPrice ? Number(orderLimitPrice) : undefined,
        ...(isCrypto && !immediate
          ? { stop_price: orderStopPrice ? Number(orderStopPrice) : undefined }
          : {}),
        ...(isCrypto && !immediate
          ? { time_in_force: orderStopPrice ? "gtc" : timeInForce }
          : {}),
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
      if (
        !window.confirm(
          `Submit Alpaca PAPER ${action.toUpperCase()} for ${symbol}? ${JSON.stringify(payload)}. ${isCrypto ? "Crypto trades 24/7 with no margin or short selling; Alpaca charges taker fees up to 0.25%; stop-limit orders are GTC only." : "Stocks use market orders unless a limit is set; options use DAY limit orders."} Fills are not guaranteed.`,
        )
      )
        return;
      const res = await fetch(`${feedBase}/order`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const data = await res.json();
      if (!res.ok || !data.ok) {
        throw new Error(data.error || "Order execution failed");
      }
      setFeedback({
        type: "success",
        text: `${action.toUpperCase()} order ${data.trade.status}; filled ${data.trade.filled_qty ?? 0}.`,
      });
      setTimeout(() => setFeedback(null), 4000);
    } catch (err) {
      setFeedback({
        type: "error",
        text: err instanceof Error ? err.message : "Execution error",
      });
      setTimeout(() => setFeedback(null), 5000);
    } finally {
      setOrderLoading(false);
    }
  };

  const handleUpdatePositionTpSl = async () => {
    if (
      !window.confirm(
        `Update local paper exit targets for ${symbol}: TP ${editTpVal || "unchanged"}%, SL ${editSlVal || "unchanged"}%? Monitoring requires the feed process to remain running.`,
      )
    )
      return;
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
      setFeedback({ type: "success", text: "Exit targets updated." });
      setTimeout(() => setFeedback(null), 4000);
    } catch (err) {
      setFeedback({
        type: "error",
        text: err instanceof Error ? err.message : "Failed to update TP/SL",
      });
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
    if (
      !window.confirm(
        `Cancel Alpaca PAPER order ${order.id} for ${order.symbol} (${order.side}, ${order.quantity})?`,
      )
    )
      return;
    try {
      const response = await fetch(`${feedBase}/order`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "cancel", order_id: order.id }),
      });
      const result = await response.json();
      if (!response.ok || !result.ok)
        throw new Error(result.error || "Cancellation failed");
      setFeedback({
        type: "success",
        text: "Cancellation requested; awaiting broker confirmation.",
      });
    } catch (error) {
      setFeedback({
        type: "error",
        text: error instanceof Error ? error.message : "Cancellation failed",
      });
    }
  };
  const openOrders = (snapshot?.trading.orders ?? [])
    .filter(
      (order) =>
        !["filled", "canceled", "expired", "rejected", "replaced"].includes(
          order.status ?? "",
        ),
    )
    .filter((order) => isCryptoTicker(order.symbol) === isCrypto);
  const positions = Object.entries(snapshot?.trading.account.positions ?? {})
    .filter(([, position]) => position.quantity !== 0)
    .filter(([ticker]) => isCryptoTicker(ticker) === isCrypto);
  const viewSymbol = (ticker: string) => {
    setSymbolForMode(assetMode, ticker);
    setIsEditingTpSl(false);
    setWorkspace("terminal");
  };
  return (
    <main className="dashboard">
      <a className="skip-link" href="#workspace-content">
        Skip to workspace
      </a>
      <header className="app-nav">
        <Link className="brand" href="/" aria-label="Jev terminal">
          jev<span>/ Paper</span>
        </Link>
        <nav aria-label="Workspace">
          {(["terminal", "activity", "settings"] as const).map((tab) => (
            <button
              key={tab}
              aria-current={workspace === tab ? "page" : undefined}
              onClick={() => {
                setWorkspace(tab);
                if (tab === "activity") setDeskTab("decisions");
              }}
            >
              {tab[0].toUpperCase() + tab.slice(1)}
            </button>
          ))}
        </nav>
        <span className="connection">
          <span className={brokerReady ? "status-dot is-live" : "status-dot"} />
          {snapshot?.trading.broker_status ?? "Connecting"}
        </span>
      </header>
      <div className="mode-bar">
        <fieldset className="tf-switcher" aria-label="Trading mode">
          <button
            type="button"
            aria-pressed={assetMode === "equities"}
            className={assetMode === "equities" ? "active" : ""}
            onClick={() => setAssetMode("equities")}
          >
            Equities &amp; options
          </button>
          <button
            type="button"
            aria-pressed={assetMode === "crypto"}
            className={assetMode === "crypto" ? "active" : ""}
            onClick={() => setAssetMode("crypto")}
          >
            Crypto
          </button>
        </fieldset>
      </div>
      <section className="scope-bar" aria-label="Active automation scope">
        <div>
          {assetMode === "crypto" ? (
            <>
              <span className="scope-label">Crypto</span>
              <strong>
                {scope?.crypto_enabled ? scope.crypto_symbol : "Off"}
              </strong>
            </>
          ) : (
            <>
              <span className="scope-label">Options</span>
              <strong>
                {scope?.options_enabled
                  ? scope.option_underlyings.join(" · ")
                  : "Off"}
              </strong>
              <span className="scope-label">Stock</span>
              <strong>
                {scope?.stock_enabled ? scope.stock_symbol : "Off"}
              </strong>
            </>
          )}
          <button
            className="text-button"
            onClick={() => setWorkspace("settings")}
          >
            Edit scope
          </button>
        </div>
        <div className="automation-control">
          <button
            className={tradingEnabled ? "pause-button" : "primary"}
            disabled={
              configSaving ||
              (!tradingEnabled &&
                (!brokerReady ||
                  !scope ||
                  !snapshot?.trading.agent_enabled ||
                  (!scope.stock_enabled &&
                    !scope.options_enabled &&
                    !scope.crypto_enabled)))
            }
            onClick={() => void configurePortfolio(!tradingEnabled)}
          >
            {configSaving
              ? "Applying…"
              : tradingEnabled
                ? "Pause automation"
                : "Start automation"}
          </button>
          <small>Protective exits remain active</small>
        </div>
      </section>
      <section className="account-strip" aria-label="Account overview">
        <Metric
          label="Equity"
          value={money(snapshot?.trading.account.equity)}
        />
        <Metric
          label="Available cash"
          value={money(snapshot?.trading.account.available_cash)}
        />
        {assetMode === "crypto" ? (
          <div className="metric">
            <span className="label">Crypto buying power</span>
            <strong>
              {money(snapshot?.trading.account.crypto_buying_power)}
            </strong>
            <span className="muted">
              {snapshot?.trading.account.crypto_status ?? "Not connected"}
            </span>
          </div>
        ) : (
          <div className="metric">
            <span className="label">Options exposure · held + reserved</span>
            <strong>
              {money(snapshot?.trading.account.options_exposure)}{" "}
              <span className="metric-secondary">
                /{" "}
                {money(
                  optionCapital === null || !optionsConfig
                    ? null
                    : optionCapital * optionsConfig.policy.max_total_pct,
                )}
              </span>
            </strong>
          </div>
        )}
        <div className="metric">
          <span className="label">Strategy evaluation</span>
          <strong>
            {snapshot?.settings.active_timeframes?.join(" · ") ||
              "Not connected"}
          </strong>
          <span className="muted">
            {tradingEnabled ? "Automation running" : "Automation paused"}
          </span>
        </div>
      </section>
      {feedback && (
        <p
          role={feedback.type === "error" ? "alert" : "status"}
          className={"feedback-banner " + feedback.type}
        >
          {feedback.text}
        </p>
      )}
      {(feedError || snapshot?.trading.broker_error || snapshot?.error) && (
        <p role="alert" className="feedback-banner error">
          {feedError || snapshot?.trading.broker_error || snapshot?.error}
        </p>
      )}
      {snapshot?.trading.monitor_error && (
        <p role="alert" className="feedback-banner error">
          Exit monitor: {snapshot.trading.monitor_error}
        </p>
      )}
      {!snapshot?.trading.agent_enabled && snapshot && (
        <p className="help-text">
          Automation requires a TypeSafe key. Configure it in Settings; manual
          paper orders remain available.
        </p>
      )}
      <details className="feed-disclosure">
        {assetMode === "crypto" ? (
          <>
            <summary>
              Alpaca crypto paper trading
              <span>Pricing details</span>
            </summary>
            <p>
              Crypto trades 24/7 with no margin or short selling; Alpaca charges
              taker fees up to 0.25%. Crypto feed:{" "}
              {snapshot?.data_feeds.crypto ?? "unavailable"}. Exits require this
              feed process and a fresh quote; fills are not guaranteed.
            </p>
          </>
        ) : (
          <>
            <summary>
              {optionsConfig?.feed === "indicative"
                ? "Indicative quotes · paper only · not executable NBBO"
                : "Alpaca paper trading"}
              <span>Pricing details</span>
            </summary>
            <p>
              {optionsConfig?.feed === "indicative"
                ? "Quotes are derived; trades are delayed 15 minutes. Spread and depth checks use this indicative feed. Simulated results do not establish live execution quality."
                : "Paper fills do not establish live execution quality."}{" "}
              Stock feed: {snapshot?.data_feeds.stocks ?? "unavailable"}. Exits
              require this feed process, a fresh quote, and an open market;
              fills are not guaranteed.
            </p>
          </>
        )}
      </details>
      <div id="workspace-content">
        <div hidden={workspace !== "terminal"} className="terminal-view">
          <div className="terminal-grid">
            <aside
              className="watchlist-panel"
              aria-label={
                assetMode === "crypto"
                  ? "Crypto watchlist"
                  : "Options watchlist"
              }
            >
              <div className="panel-head">
                <h2>Watchlist</h2>
                <button
                  className="text-button"
                  onClick={() => setWorkspace("settings")}
                >
                  Edit watchlist
                </button>
              </div>
              {assetMode === "crypto" ? (
                <>
                  <p className="help-text">
                    Crypto pairs ·{" "}
                    {scope?.crypto_enabled ? "enabled" : "automation off"}
                  </p>
                  {scope?.crypto_symbols.length ? (
                    scope.crypto_symbols.map((ticker) => (
                      <button
                        key={ticker}
                        className="ticker-button"
                        onClick={() => viewSymbol(ticker)}
                      >
                        <strong>{ticker}</strong>
                        <span className="muted">
                          {scope.crypto_enabled &&
                          scope.crypto_symbol === ticker
                            ? "Active strategy"
                            : "24/7 · View chart"}
                        </span>
                      </button>
                    ))
                  ) : (
                    <div className="empty-state">
                      Add crypto pairs in Settings to build your watchlist.
                    </div>
                  )}
                  {!!heldCryptoPositions.length && (
                    <div className="stock-watchlist">
                      <h3>Held crypto</h3>
                      {heldCryptoPositions.map(([ticker, position]) => (
                        <button
                          className="contract-link"
                          key={ticker}
                          onClick={() => viewSymbol(ticker)}
                        >
                          <strong>{ticker}</strong>
                          <span>
                            {position.quantity.toLocaleString(undefined, {
                              maximumFractionDigits: qtyDecimals(
                                snapshot?.instruments[ticker],
                              ),
                            })}{" "}
                            coins
                          </span>
                        </button>
                      ))}
                    </div>
                  )}
                </>
              ) : (
                <>
                  <p className="help-text">
                    Options underlyings ·{" "}
                    {scope?.options_enabled ? "enabled" : "automation off"}
                  </p>
                  {optionsConfig?.underlyings.length ? (
                    optionsConfig.underlyings.map((underlying) => {
                      const scan = snapshot?.trading.option_scans?.[underlying];
                      return (
                        <div
                          className={
                            symbol === underlying
                              ? "watchlist-row selected"
                              : "watchlist-row"
                          }
                          key={underlying}
                        >
                          <button
                            className="ticker-button"
                            onClick={() => viewSymbol(underlying)}
                          >
                            <strong>{underlying}</strong>
                            <span
                              className={
                                scan?.status === "scanning"
                                  ? "scan-updating"
                                  : "muted"
                              }
                            >
                              {scan?.status === "scanning"
                                ? "Updating"
                                : (scan?.status ?? "Awaiting scan")}
                            </span>
                          </button>
                          <details>
                            <summary>
                              {scan?.eligible != null
                                ? `${scan.eligible} eligible / ${scan.discovered ?? 0} found`
                                : "Awaiting first completed scan"}
                            </summary>
                            {scan?.as_of && (
                              <p className="help-text">
                                Last result{" "}
                                {new Date(
                                  scan.as_of * 1000,
                                ).toLocaleTimeString()}
                              </p>
                            )}
                            {scan?.reason && (
                              <p className="help-text">{scan.reason}</p>
                            )}
                            {scan?.error && (
                              <p className="negative">{scan.error}</p>
                            )}
                            {scan?.candidates?.map((candidate) => (
                              <button
                                className="contract-link"
                                key={candidate.symbol}
                                onClick={() => viewSymbol(candidate.symbol)}
                              >
                                <strong>
                                  {candidate.option_type} · {candidate.strike}
                                </strong>
                                <span>
                                  {candidate.expiration} ·{" "}
                                  {money(candidate.limit_price)} premium
                                </span>
                                <small>
                                  {candidate.open_interest} OI ·{" "}
                                  {(candidate.spread_pct * 100).toFixed(1)}%
                                  spread · up to {candidate.max_quantity} ct
                                </small>
                              </button>
                            ))}
                          </details>
                        </div>
                      );
                    })
                  ) : (
                    <div className="empty-state">
                      Add options underlyings in Settings to build your
                      watchlist.
                    </div>
                  )}
                  {!!scope?.stock_symbols.length && (
                    <div className="stock-watchlist">
                      <h3>Stock watchlist</h3>
                      {scope.stock_symbols.map((ticker) => (
                        <button
                          key={ticker}
                          className="ticker-button"
                          onClick={() => viewSymbol(ticker)}
                        >
                          <strong>{ticker}</strong>
                          <span className="muted">
                            {scope.stock_enabled &&
                            scope.stock_symbol === ticker
                              ? "Active strategy"
                              : "View chart"}
                          </span>
                        </button>
                      ))}
                    </div>
                  )}
                  {!!heldOptionPositions.length && (
                    <div className="stock-watchlist">
                      <h3>Held options</h3>
                      {heldOptionPositions.map(([ticker, position]) => (
                        <button
                          className="contract-link"
                          key={ticker}
                          onClick={() => viewSymbol(ticker)}
                        >
                          <strong>
                            {position.underlying} · {position.quantity} ct
                          </strong>
                          <span>{ticker}</span>
                        </button>
                      ))}
                    </div>
                  )}
                </>
              )}
            </aside>
            <section className="chart-panel" aria-label="Price chart">
              <div className="chart-heading">
                <div>
                  <label className="field">
                    Chart symbol
                    <select
                      aria-label="Chart symbol"
                      value={symbol}
                      onChange={(event) => viewSymbol(event.target.value)}
                    >
                      {!symbols.length && (
                        <option value="">Choose a watchlist first</option>
                      )}
                      {symbols.map((ticker) => (
                        <option key={ticker}>{ticker}</option>
                      ))}
                    </select>
                  </label>
                  <span className="help-text">
                    Viewing only · does not change strategy
                  </span>
                </div>
                <div className="quote">
                  <strong>{money(price, priceDecimals(instrument))}</strong>
                  <span
                    className={
                      change != null && change >= 0 ? "positive" : "muted"
                    }
                  >
                    {change == null
                      ? "Awaiting quote"
                      : `${change >= 0 ? "+" : ""}${change.toFixed(2)}% over loaded bars`}
                  </span>
                </div>
              </div>
              <div className="chart-toolbar">
                <fieldset className="tf-switcher" aria-label="Chart interval">
                  {["1m", "5m", "15m", "1h", "4h"].map((tf) => (
                    <button
                      key={tf}
                      aria-pressed={chartTimeframe === tf}
                      className={chartTimeframe === tf ? "active" : ""}
                      onClick={() => setChartTimeframe(tf)}
                    >
                      {tf}
                    </button>
                  ))}
                </fieldset>
                <details className="indicator-picker">
                  <summary onKeyDown={dismissIndicatorPicker}>
                    Indicators <span>{selectedIndicators.length}</span>
                  </summary>
                  <div className="picker-popover">
                    <h3>Chart overlays</h3>
                    {[
                      ["ema20", "EMA 20"],
                      ["sma50", "SMA 50"],
                    ].map(([key, label]) => (
                      <label key={key}>
                        <input
                          type="checkbox"
                          checked={overlays.includes(key)}
                          onChange={() => toggle(key)}
                          onKeyDown={dismissIndicatorPicker}
                        />
                        {label}
                      </label>
                    ))}
                    {indicatorGroups.map((group) => (
                      <fieldset key={group.title}>
                        <legend>{group.title}</legend>
                        {group.items.map(([key, label]) => (
                          <label key={key}>
                            <input
                              type="checkbox"
                              checked={selectedIndicators.includes(key)}
                              onChange={() => toggleIndicator(key)}
                              onKeyDown={dismissIndicatorPicker}
                            />
                            {label}
                          </label>
                        ))}
                      </fieldset>
                    ))}
                    <small>
                      {allIndicatorKeys.length} available indicators
                    </small>
                  </div>
                </details>
              </div>
              {snapshot && symbolReady && symbol ? (
                <MarketChart
                  key={symbol}
                  bars={snapshot.bars}
                  indicatorSeries={snapshot.indicator_series}
                  overlays={overlays}
                  position={selectedPosition}
                  priceFormat={chartPriceFormat}
                />
              ) : (
                <div className="loading">
                  {snapshot
                    ? "Select a ticker to view its chart."
                    : "Connecting to the market feed…"}
                </div>
              )}
              <div className="indicator-values">
                {selectedIndicators.map((key) => (
                  <div className="indicator-value" key={key}>
                    <span>{labelFor(key)}</span>
                    <strong>
                      {symbolReady && snapshot?.indicators[key] != null
                        ? snapshot.indicators[key].toLocaleString(undefined, {
                            maximumFractionDigits:
                              isCrypto && Math.abs(snapshot.indicators[key]) < 1
                                ? Math.max(2, priceDecimals(instrument))
                                : 2,
                          })
                        : "Warming up"}
                    </strong>
                  </div>
                ))}
              </div>
              <p className="chart-caption">
                Chart: {chartTimeframe} candles · strategy:{" "}
                {snapshot?.settings.active_timeframes?.join(", ") ||
                  "not configured"}
                . Last quote{" "}
                {symbolReady && snapshot?.last_tick
                  ? new Date(snapshot.last_tick * 1000).toLocaleTimeString()
                  : "unavailable"}
                . TradingView Lightweight Charts.
              </p>
            </section>
            <aside className="trading-panel" aria-label="Manual paper order">
              <div className="panel-head">
                <h2>Trade</h2>
                <span className="paper-badge">Paper</span>
              </div>
              <p className="trade-symbol">
                {symbol || "Select an instrument"}
                <span>
                  {isOption
                    ? "Long options only"
                    : isCrypto
                      ? "Crypto · 24/7"
                      : "Stocks"}
                </span>
              </p>
              <div className="manual-order-panel">
                <div className="side-selector">
                  <button
                    className={`side-btn buy-side ${orderSide === "buy" ? "active" : ""}`}
                    onClick={() => setOrderSide("buy")}
                  >
                    Buy / long
                  </button>
                  <button
                    className={`side-btn sell-side ${orderSide === "sell" ? "active" : ""}`}
                    onClick={() => setOrderSide("sell")}
                  >
                    Sell / exit
                  </button>
                </div>

                <label className="order-field-row">
                  Limit price / premium (optional)
                  <input
                    type="number"
                    min={isCrypto ? cryptoPriceStep : "0.01"}
                    step={isCrypto ? cryptoPriceStep : "0.01"}
                    value={limitPrice}
                    onChange={(e) => setLimitPrice(e.target.value)}
                    placeholder={
                      isOption ? "Fresh quote limit" : "Market order"
                    }
                  />
                </label>
                {isCrypto && (
                  <label className="order-field-row">
                    Stop price (optional · stop-limit)
                    <input
                      type="number"
                      min={cryptoPriceStep}
                      step={cryptoPriceStep}
                      value={stopPrice}
                      onChange={(e) => setStopPrice(e.target.value)}
                      placeholder="Requires a limit price too"
                    />
                  </label>
                )}
                {isCrypto && (
                  <label className="order-field-row">
                    Time in force
                    <select
                      value={stopPrice ? "gtc" : timeInForce}
                      disabled={!!stopPrice}
                      onChange={(e) =>
                        setTimeInForce(e.target.value as "gtc" | "ioc")
                      }
                    >
                      <option value="gtc">GTC — good till canceled</option>
                      <option value="ioc">IOC — immediate or cancel</option>
                    </select>
                  </label>
                )}
                <p className="size-hint">
                  {isOption
                    ? `Whole contracts; multiplier ${multiplier}. Buy to open / sell to close only.`
                    : isCrypto
                      ? "Market orders seek immediate execution; fills are not guaranteed. Add a limit price to constrain fill price, or a stop price for a stop-limit order (GTC only)."
                      : "Shares; fractional quantities require a fractionable asset."}
                </p>

                {/* Sizing Mode Switch */}
                <div className="order-field-row">
                  <span className="field-label">Order size</span>
                  <div className="sizing-mode-toggle">
                    <button
                      className={`mode-btn ${sizingMode === "usd" ? "active" : ""}`}
                      onClick={() => setSizingMode("usd")}
                    >
                      USD ($)
                    </button>
                    <button
                      className={
                        sizingMode === "quantity"
                          ? "mode-btn active"
                          : "mode-btn"
                      }
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
                      <span className="input-prefix">
                        {isCrypto ? symbol.split("/")[0] : symbol.split("-")[0]}
                      </span>
                      <input
                        type="number"
                        min={
                          isOption ? "1" : isCrypto ? cryptoQtyMin : "0.000001"
                        }
                        step={
                          isOption ? "1" : isCrypto ? cryptoQtyStep : "0.000001"
                        }
                        value={orderQuantity}
                        onChange={(e) => {
                          const val = e.target.value;
                          setOrderQuantity(val);
                          if (price && price > 0) {
                            setOrderAmountUsd(
                              (Number(val) * price * multiplier).toFixed(2),
                            );
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
                      ≈{" "}
                      {price && Number(orderAmountUsd) > 0
                        ? estimateQuantity(Number(orderAmountUsd))
                        : "0"}{" "}
                      {units}
                    </span>
                  ) : (
                    <span>
                      ≈{" "}
                      {money(
                        price && Number(orderQuantity) > 0
                          ? Number(orderQuantity) * price * multiplier
                          : 0,
                      )}{" "}
                      USD
                    </span>
                  )}
                </div>

                {/* Quick Cash Presets */}
                <div className="quick-presets">
                  <button
                    className="preset-chip"
                    onClick={() => setCashPercent(25)}
                  >
                    25%
                  </button>
                  <button
                    className="preset-chip"
                    onClick={() => setCashPercent(50)}
                  >
                    50%
                  </button>
                  <button
                    className="preset-chip"
                    onClick={() => setCashPercent(75)}
                  >
                    75%
                  </button>
                  <button
                    className="preset-chip"
                    onClick={() => setCashPercent(100)}
                  >
                    100% cash
                  </button>
                </div>

                {orderSide === "buy" ? (
                  <details className="exit-targets">
                    <summary>
                      Exit targets · {tpEnabled ? `TP +${tpPct}%` : "TP off"} /{" "}
                      {slEnabled ? `SL −${slPct}%` : "SL off"}
                    </summary>
                    {/* Take Profit Setting */}
                    <div className="risk-setting-row">
                      <div className="risk-header">
                        <label className="checkbox-label">
                          <input
                            type="checkbox"
                            checked={tpEnabled}
                            onChange={(e) => setTpEnabled(e.target.checked)}
                          />
                          <span>Take profit</span>
                        </label>
                        {tpEnabled && price ? (
                          <span className="target-calc text-accent">
                            Target:{" "}
                            {money(
                              price * (1 + Number(tpPct) / 100),
                              priceDecimals(instrument),
                            )}
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
                          <span>Stop loss</span>
                        </label>
                        {slEnabled && price ? (
                          <span className="target-calc text-coral">
                            Target:{" "}
                            {money(
                              price * (1 - Number(slPct) / 100),
                              priceDecimals(instrument),
                            )}
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
                  </details>
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
                    ? "Submitting…"
                    : orderSide === "buy"
                      ? `Manual buy ${symbol}`
                      : `Manual sell / exit ${symbol}`}
                </button>
              </div>
            </aside>
          </div>
        </div>
        <section
          className="activity-panel"
          hidden={workspace === "settings"}
          aria-label="Positions and activity"
        >
          <div className="activity-tabs">
            {(["positions", "orders", "decisions", "fills"] as const).map(
              (tab) => (
                <button
                  key={tab}
                  aria-pressed={deskTab === tab}
                  className={deskTab === tab ? "active" : ""}
                  onClick={() => setDeskTab(tab)}
                >
                  {tab === "positions"
                    ? `Positions (${positions.length})`
                    : tab === "orders"
                      ? `Open orders (${openOrders.length})`
                      : tab === "decisions"
                        ? "Recent decisions"
                        : "Fill history"}
                </button>
              ),
            )}
          </div>
          {deskTab === "positions" && (
            <>
              <div className="table-scroll">
                <table>
                  <thead>
                    <tr>
                      <th>Instrument</th>
                      <th>Quantity</th>
                      <th>Entry</th>
                      <th>Market value</th>
                      <th>Unrealized P&amp;L</th>
                      <th>Protection</th>
                      <th>Manage</th>
                    </tr>
                  </thead>
                  <tbody>
                    {positions.map(([ticker, position]) => {
                      const rowInstrument = snapshot?.instruments[ticker];
                      return (
                        <tr key={ticker}>
                          <td>
                            <strong>{ticker}</strong>
                            {position.expiration && (
                              <small>Expires {position.expiration}</small>
                            )}
                          </td>
                          <td>
                            {position.quantity.toLocaleString(undefined, {
                              maximumFractionDigits: qtyDecimals(rowInstrument),
                            })}
                          </td>
                          <td>
                            {money(
                              position.average_entry_price,
                              priceDecimals(rowInstrument),
                            )}
                          </td>
                          <td>{money(position.market_value)}</td>
                          <td
                            className={
                              position.unrealized_pnl >= 0
                                ? "positive"
                                : "negative"
                            }
                          >
                            {money(position.unrealized_pnl)}
                          </td>
                          <td>
                            {position.exit_reason ||
                              `TP ${money(position.take_profit_price, priceDecimals(rowInstrument))} / SL ${money(position.stop_loss_price, priceDecimals(rowInstrument))}`}
                          </td>
                          <td>
                            <button onClick={() => viewSymbol(ticker)}>
                              View / manage
                            </button>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
                {!positions.length && (
                  <p className="empty-state">
                    No open positions. Accepted orders appear under Open orders
                    until filled.
                  </p>
                )}
              </div>{" "}
              {selectedPosition && selectedPosition.quantity > 0 ? (
                <div className="active-position-card">
                  <div className="pos-card-header">
                    <div className="pos-badge">
                      <span className="pos-side">
                        Long {selectedPosition.symbol}
                      </span>
                      <span className="pos-source">
                        {selectedPosition.tp_sl_source === "jev" ||
                        selectedPosition.tp_sl_source === "jev-options"
                          ? "Jev automation"
                          : "Manual"}
                      </span>
                    </div>
                    <div
                      className={`pos-pnl ${selectedPosition.unrealized_pnl_pct >= 0 ? "positive" : "negative"}`}
                    >
                      {selectedPosition.unrealized_pnl_pct >= 0 ? "+" : ""}
                      {selectedPosition.unrealized_pnl_pct.toFixed(2)}%
                    </div>
                  </div>

                  <div className="pos-card-body">
                    <div className="pos-metric">
                      <span className="pos-label">Entry:</span>
                      <strong>
                        {money(
                          selectedPosition.average_entry_price,
                          priceDecimals(instrument),
                        )}
                      </strong>
                    </div>
                    <div className="pos-metric">
                      <span className="pos-label">Size:</span>
                      <strong>
                        {selectedPosition.quantity.toLocaleString(undefined, {
                          maximumFractionDigits: qtyDecimals(instrument),
                        })}
                      </strong>
                    </div>
                    <div className="pos-metric">
                      <span className="pos-label">Take profit:</span>
                      <strong className="text-accent">
                        {selectedPosition.take_profit_price
                          ? `${money(selectedPosition.take_profit_price, priceDecimals(instrument))} (+${selectedPosition.take_profit_pct?.toFixed(2)}%)`
                          : "None"}
                      </strong>
                    </div>
                    <div className="pos-metric">
                      <span className="pos-label">Stop loss:</span>
                      <strong className="text-coral">
                        {selectedPosition.stop_loss_price
                          ? `${money(selectedPosition.stop_loss_price, priceDecimals(instrument))} (-${selectedPosition.stop_loss_pct?.toFixed(2)}%)`
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
                  <p className="size-hint">
                    Market value: {money(selectedPosition.market_value)} ·
                    Unrealized P&amp;L: {money(selectedPosition.unrealized_pnl)}
                  </p>

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
                        <button
                          className="btn-sm btn-save"
                          onClick={handleUpdatePositionTpSl}
                          disabled={orderLoading}
                        >
                          Save TP/SL
                        </button>
                        <button
                          className="btn-sm btn-cancel"
                          onClick={() => setIsEditingTpSl(false)}
                        >
                          Cancel
                        </button>
                      </div>
                    </div>
                  ) : (
                    <div className="pos-card-actions">
                      <button
                        className="exit-btn danger"
                        onClick={() => handleExecuteOrder("exit", {}, true)}
                        disabled={orderLoading || !brokerReady}
                        title="Submit a paper order to exit this position; execution is not guaranteed"
                      >
                        {orderLoading ? "Exiting..." : "Exit position (100%)"}
                      </button>
                      <button
                        className="exit-btn secondary"
                        onClick={() =>
                          handleExecuteOrder(
                            "sell",
                            { pct_of_position: 0.5 },
                            true,
                          )
                        }
                        disabled={
                          orderLoading ||
                          !brokerReady ||
                          (isOption && selectedPosition.quantity < 2)
                        }
                        title="Exit 50% of this position"
                      >
                        Exit 50%
                      </button>
                      <button
                        className="exit-btn outline"
                        onClick={() => {
                          setEditTpVal(
                            selectedPosition.take_profit_pct?.toString() || "",
                          );
                          setEditSlVal(
                            selectedPosition.stop_loss_pct?.toString() || "",
                          );
                          setIsEditingTpSl(true);
                        }}
                      >
                        Edit TP/SL
                      </button>
                    </div>
                  )}
                </div>
              ) : null}
            </>
          )}
          {deskTab === "orders" && (
            <div className="orders-list">
              {openOrders.length ? (
                openOrders.map((order, index) => (
                  <div className="order-row" key={order.id ?? index}>
                    <div>
                      <strong>{order.symbol}</strong>
                      <span>
                        {order.side} · {order.status}
                      </span>
                    </div>
                    <span>
                      {(order.filled_qty ?? 0).toLocaleString(undefined, {
                        maximumFractionDigits: qtyDecimals(
                          snapshot?.instruments[order.symbol],
                        ),
                      })}{" "}
                      /{" "}
                      {order.quantity.toLocaleString(undefined, {
                        maximumFractionDigits: qtyDecimals(
                          snapshot?.instruments[order.symbol],
                        ),
                      })}{" "}
                      filled
                    </span>
                    <span>
                      {order.price != null
                        ? money(
                            order.price,
                            priceDecimals(snapshot?.instruments[order.symbol]),
                          )
                        : "Awaiting fill"}
                    </span>
                    {order.id && (
                      <button onClick={() => void cancelOrder(order)}>
                        Cancel order
                      </button>
                    )}
                    {order.status === "unknown" && (
                      <p role="alert" className="negative">
                        Submission outcome unknown; do not resubmit before
                        broker reconciliation.
                      </p>
                    )}
                  </div>
                ))
              ) : (
                <p className="empty-state">No open orders.</p>
              )}
            </div>
          )}
          {deskTab === "decisions" && (
            <div className="agent-log">
              {snapshot?.trading.agent_log.length ? (
                snapshot.trading.agent_log
                  .slice()
                  .reverse()
                  .filter((event) => {
                    const eventTicker =
                      event.symbol ??
                      (typeof event.request?.symbol === "string"
                        ? event.request.symbol
                        : "");
                    return isCryptoTicker(eventTicker) === isCrypto;
                  })
                  .map((event, index) => {
                    const ticker =
                      event.symbol ??
                      (typeof event.request?.symbol === "string"
                        ? event.request.symbol
                        : "Unknown symbol");
                    const strategy =
                      event.strategy ??
                      (typeof event.request?.strategy === "string"
                        ? event.request.strategy
                        : "Unspecified strategy");
                    const interval =
                      event.time_frame ??
                      (typeof event.request?.time_frame === "string"
                        ? event.request.time_frame
                        : "Interval unavailable");
                    return (
                      <details
                        className="agent-event"
                        key={`${event.timestamp}-${index}`}
                      >
                        <summary>
                          <strong>{ticker}</strong>
                          <span>{strategy}</span>
                          <span className={event.error ? "negative" : "action"}>
                            {event.error ? "Error" : event.executed}
                          </span>
                          <span>
                            {event.confidence == null
                              ? "No model decision"
                              : `${(event.confidence * 100).toFixed(0)}% confidence`}
                          </span>
                          <span>{interval}</span>
                          <time>
                            {new Date(
                              event.timestamp * 1000,
                            ).toLocaleTimeString()}
                          </time>
                        </summary>
                        <div className="agent-payloads">
                          {event.reason && <p>{event.reason}</p>}
                          {event.error && (
                            <p className="negative">{event.error}</p>
                          )}
                          <p>Proposed action: {event.action}</p>
                          {event.trade && (
                            <p>
                              {event.trade.symbol} · {event.trade.side} ·{" "}
                              {(event.trade.filled_qty ?? 0).toLocaleString(
                                undefined,
                                {
                                  maximumFractionDigits: qtyDecimals(
                                    snapshot?.instruments[event.trade.symbol],
                                  ),
                                },
                              )}{" "}
                              /{" "}
                              {event.trade.quantity.toLocaleString(undefined, {
                                maximumFractionDigits: qtyDecimals(
                                  snapshot?.instruments[event.trade.symbol],
                                ),
                              })}{" "}
                              filled
                              {event.trade.price != null
                                ? ` at ${money(event.trade.price, priceDecimals(snapshot?.instruments[event.trade.symbol]))}`
                                : ""}
                            </p>
                          )}
                          {event.request && (
                            <details>
                              <summary>Decision context</summary>
                              <pre>
                                {JSON.stringify(event.request, null, 2)}
                              </pre>
                            </details>
                          )}
                          {event.response != null && (
                            <details>
                              <summary>Actual model response</summary>
                              <pre>
                                {JSON.stringify(event.response, null, 2)}
                              </pre>
                            </details>
                          )}
                        </div>
                      </details>
                    );
                  })
              ) : (
                <p className="empty-state">
                  No recent decisions. Decisions appear after a completed
                  strategy bar while automation is running.
                </p>
              )}
            </div>
          )}
          {deskTab === "fills" && (
            <div className="table-scroll">
              <table>
                <thead>
                  <tr>
                    <th>Instrument</th>
                    <th>Side</th>
                    <th>Filled quantity</th>
                    <th>Average fill</th>
                    <th>Status</th>
                    <th>Source</th>
                    <th>Updated</th>
                  </tr>
                </thead>
                <tbody>
                  {(snapshot?.trading.positions ?? [])
                    .filter(
                      (trade) => isCryptoTicker(trade.symbol) === isCrypto,
                    )
                    .map((trade, index) => (
                      <tr key={trade.id ?? index}>
                        <td>{trade.symbol}</td>
                        <td>{trade.side}</td>
                        <td>
                          {trade.quantity.toLocaleString(undefined, {
                            maximumFractionDigits: qtyDecimals(
                              snapshot?.instruments[trade.symbol],
                            ),
                          })}
                        </td>
                        <td>
                          {money(
                            trade.price,
                            priceDecimals(snapshot?.instruments[trade.symbol]),
                          )}
                        </td>
                        <td>{trade.status}</td>
                        <td>{trade.reason ?? "Alpaca"}</td>
                        <td>
                          {new Date(trade.timestamp * 1000).toLocaleString()}
                        </td>
                      </tr>
                    ))}
                </tbody>
              </table>
              {!(snapshot?.trading.positions ?? []).filter(
                (trade) => isCryptoTicker(trade.symbol) === isCrypto,
              ).length && (
                <p className="empty-state">
                  No confirmed fills yet. Broker acknowledgements are not fills.
                </p>
              )}
              <p className="help-text">
                Cumulative broker fill summaries, not individual executions or
                tax lots.
              </p>
            </div>
          )}
        </section>
        <div className="settings-view" hidden={workspace !== "settings"}>
          <div className="view-heading">
            <h1>Settings</h1>
            <p className="muted">
              {assetMode === "crypto"
                ? "Set the crypto scope. Global budget and limits apply account-wide."
                : "Set the scope. Define the limits. Keep execution deliberate."}
            </p>
          </div>
          {scope ? (
            <ScopeEditor
              key={assetMode}
              saved={scope}
              running={tradingEnabled}
              feedBase={feedBase}
              mode={assetMode}
              onSaved={(saved) =>
                setSnapshot((current) =>
                  current
                    ? {
                        ...current,
                        trading_scope: saved,
                        options: current.options
                          ? {
                              ...current.options,
                              underlyings: saved.option_underlyings,
                            }
                          : undefined,
                      }
                    : current,
                )
              }
            />
          ) : (
            <output className="feedback-banner">
              {snapshot
                ? "Restart the updated feed when ready to enable dashboard-editable trading scope. Automation restarts paused."
                : "Waiting for the feed connection before loading saved settings."}
            </output>
          )}
          <section className="settings-card">
            <div className="panel-head">
              <div>
                <h2>Strategy settings</h2>
                <p className="muted">
                  Applied to automation, not chart navigation. Budget does not
                  change broker cash.
                </p>
              </div>
              <span
                className={
                  generalDraft || typeSafeKey ? "draft-status" : "muted"
                }
              >
                {generalDraft || typeSafeKey
                  ? "Unsaved changes"
                  : "Active server settings"}
              </span>
            </div>
            <form
              onSubmit={(event) => {
                event.preventDefault();
                void configurePortfolio();
              }}
            >
              <fieldset disabled={configSaving || !snapshot}>
                <legend className="sr-only">Strategy settings</legend>
                <div className="settings-fields">
                  <label className="field">
                    Strategy budget ($)
                    <input
                      name="capital"
                      type="number"
                      required
                      min="0.01"
                      step="0.01"
                      value={capital}
                      onChange={(event) =>
                        setGeneralDraft((d) => ({
                          ...d,
                          capital: event.target.value,
                        }))
                      }
                    />
                  </label>
                  <label className="field">
                    Per-symbol account cap (%)
                    <input
                      name="max_position"
                      type="number"
                      required
                      min="0.01"
                      max="100"
                      step="0.01"
                      value={maxWalletPositionPct}
                      onChange={(event) =>
                        setGeneralDraft((d) => ({
                          ...d,
                          maxPosition: event.target.value,
                        }))
                      }
                    />
                  </label>
                  {assetMode === "equities" && (
                    <label className="field">
                      Stock risk
                      <select
                        value={riskAppetite}
                        onChange={(event) =>
                          setGeneralDraft((d) => ({
                            ...d,
                            risk: event.target.value,
                          }))
                        }
                      >
                        <option value="conservative">Conservative</option>
                        <option value="balanced">Balanced</option>
                        <option value="aggressive">Aggressive</option>
                      </select>
                    </label>
                  )}
                </div>
                <fieldset className="interval-options">
                  <legend>Strategy evaluation intervals</legend>
                  {["1m", "5m", "15m", "1h", "4h"].map((tf) => (
                    <label key={tf}>
                      <input
                        type="checkbox"
                        checked={activeTimeframes.includes(tf)}
                        onChange={() =>
                          setGeneralDraft((d) => ({
                            ...d,
                            frames: activeTimeframes.includes(tf)
                              ? activeTimeframes.filter((item) => item !== tf)
                              : [...activeTimeframes, tf],
                          }))
                        }
                      />
                      {tf}
                    </label>
                  ))}
                </fieldset>
                <p className="help-text">
                  Each selected interval evaluates completed bars. Positions are
                  netted by symbol across intervals. The chart interval is
                  independent.
                </p>
                <details className="disclosure">
                  <summary>
                    TypeSafe connection ·{" "}
                    {snapshot?.trading.agent_enabled
                      ? "server key configured"
                      : "key required for automation"}
                  </summary>
                  <label className="field">
                    TypeSafe API key
                    <input
                      type="password"
                      autoComplete="off"
                      value={typeSafeKey}
                      placeholder="Leave blank to reuse server key"
                      onChange={(event) => setTypeSafeKey(event.target.value)}
                    />
                  </label>
                  <p className="help-text">
                    A key entered here is sent to and retained by {feedBase} for
                    future model calls. Market and portfolio context is sent to
                    TypeSafe when automation runs.
                  </p>
                </details>
                <div className="form-actions">
                  <button
                    className="primary"
                    type="submit"
                    disabled={
                      configSaving ||
                      (!generalDraft && !typeSafeKey) ||
                      !activeTimeframes.length
                    }
                  >
                    {configSaving ? "Saving…" : "Apply strategy settings"}
                  </button>
                  <button
                    type="button"
                    disabled={configSaving || (!generalDraft && !typeSafeKey)}
                    onClick={() => {
                      setGeneralDraft(null);
                      setTypeSafeKey("");
                    }}
                  >
                    Discard settings changes
                  </button>
                </div>
              </fieldset>
            </form>
          </section>

          {assetMode === "equities" && optionsConfig && (
            <>
              {" "}
              {!editablePolicyAvailable ? (
                <output className="help-text">
                  The feed process needs a restart to support editable options
                  limits. Restart when ready; automation will start paused.
                </output>
              ) : (
                <form
                  className="settings-card option-policy"
                  onSubmit={(event) => {
                    event.preventDefault();
                    void applyOptionPolicy();
                  }}
                >
                  <div className="panel-head">
                    <div>
                      <h2>Options risk limits</h2>
                    </div>
                    <span className="muted">
                      {optionDraft
                        ? "Unsaved changes"
                        : "Active server settings"}
                    </span>
                  </div>
                  <p className="help-text">
                    Dollar ceilings use the smaller of the applied strategy
                    budget and broker equity: {money(optionCapital)}. No extra
                    stock-risk multiplier. Cash, quote depth and pending orders
                    can reduce available capacity.
                  </p>
                  <fieldset
                    className="portfolio-controls option-policy-fields"
                    disabled={optionSaving}
                  >
                    <legend className="sr-only">Options entry limits</legend>
                    {optionPolicyFields.map(
                      ({ key, label, scale, min, max, step }) => (
                        <label key={key}>
                          {label}
                          <input
                            name={key}
                            type="number"
                            required
                            min={min}
                            max={max}
                            step={step}
                            value={
                              optionDraft?.[key] ??
                              Number(
                                (optionsConfig.policy[key] * scale).toFixed(8),
                              )
                            }
                            onChange={(event) => {
                              setOptionDraft((current) => ({
                                ...current,
                                [key]: event.target.value,
                              }));
                              setOptionFeedback(null);
                            }}
                          />
                          {key === "max_trade_pct" ||
                          key === "max_underlying_pct" ||
                          key === "max_total_pct" ? (
                            <output>
                              {money(
                                optionCapital == null
                                  ? null
                                  : optionCapital *
                                      (proposedOptionPolicy?.[key] ?? 0),
                              )}{" "}
                              ceiling
                            </output>
                          ) : (
                            <span className="muted">
                              {key === "max_positions_per_underlying"
                                ? "Held + pending entries"
                                : key === "max_contracts"
                                  ? "Whole contracts per entry"
                                  : "Not a profit probability"}
                            </span>
                          )}
                        </label>
                      ),
                    )}
                  </fieldset>
                  <p className="help-text">
                    Per-ticker exposure includes its stock position. Multiple
                    distinct long calls/puts are allowed; adding to the same
                    contract is not. Confidence gates discretionary options
                    trades, not protective exits. Lower limits block new
                    exposure, never force liquidation.
                  </p>
                  <div className="controls">
                    <button
                      className="primary"
                      type="submit"
                      disabled={
                        !optionDraft || optionSaving || optionCapital === null
                      }
                    >
                      {optionSaving ? "Saving…" : "Apply options limits"}
                    </button>
                    <button
                      className="control"
                      type="button"
                      disabled={!optionDraft || optionSaving}
                      onClick={() => {
                        setOptionDraft(null);
                        setOptionFeedback(null);
                      }}
                    >
                      Discard changes
                    </button>
                  </div>
                  {optionFeedback && (
                    <p
                      role={
                        optionFeedback.type === "error" ? "alert" : "status"
                      }
                      className={"feedback-banner " + optionFeedback.type}
                    >
                      {optionFeedback.text}
                    </p>
                  )}
                </form>
              )}
              <details className="settings-card disclosure">
                <summary className="position-head">
                  <strong>Advanced eligibility and exits</strong>
                  <span className="muted">
                    DTE {optionsConfig.policy.min_dte}
                    {"\u2013"}
                    {optionsConfig.policy.max_dte}d {"\u00b7"} exit{" "}
                    {optionsConfig.policy.exit_dte}d {"\u00b7"} TP +
                    {optionsConfig.policy.take_profit_pct}% / SL -
                    {optionsConfig.policy.stop_loss_pct}%
                  </span>
                </summary>
                <div className="account-grid">
                  <Metric
                    label="MIN DTE"
                    value={`${optionsConfig.policy.min_dte}d`}
                  />
                  <Metric
                    label="MAX DTE"
                    value={`${optionsConfig.policy.max_dte}d`}
                  />
                  <Metric
                    label="EXIT DTE"
                    value={`${optionsConfig.policy.exit_dte}d`}
                  />
                  <Metric
                    label="MIN OPEN INTEREST"
                    value={`${optionsConfig.policy.min_open_interest}`}
                  />
                  <Metric
                    label="MAX OI AGE"
                    value={`${optionsConfig.policy.max_open_interest_age_days}d`}
                  />
                  <Metric
                    label="MIN QUOTE SIZE"
                    value={`${optionsConfig.policy.min_quote_size}`}
                  />
                  <Metric
                    label="MAX SPREAD %"
                    value={`${(optionsConfig.policy.max_spread_pct * 100).toFixed(1)}%`}
                  />
                  <Metric
                    label="MAX SPREAD $"
                    value={`$${optionsConfig.policy.max_spread_absolute.toFixed(2)}`}
                  />
                  <Metric
                    label="MAX QUOTE AGE"
                    value={`${optionsConfig.policy.max_quote_age_seconds}s`}
                  />
                  <Metric
                    label="MAX CANDIDATES"
                    value={`${optionsConfig.policy.max_candidates}`}
                  />
                  <Metric
                    label="MAX PER-TRADE"
                    value={`${(optionsConfig.policy.max_trade_pct * 100).toFixed(2)}%`}
                  />
                  <Metric
                    label="MAX PER-UNDERLYING"
                    value={`${(optionsConfig.policy.max_underlying_pct * 100).toFixed(2)}%`}
                  />
                  <Metric
                    label="MAX TOTAL"
                    value={`${(optionsConfig.policy.max_total_pct * 100).toFixed(2)}%`}
                  />
                  <Metric
                    label="MAX CONTRACTS"
                    value={`${optionsConfig.policy.max_contracts}`}
                  />
                  {editablePolicyAvailable && (
                    <Metric
                      label="POSITIONS PER TICKER"
                      value={`${optionsConfig.policy.max_positions_per_underlying}`}
                    />
                  )}
                  {editablePolicyAvailable && (
                    <Metric
                      label="JEV CONFIDENCE"
                      value={`${(optionsConfig.policy.min_confidence * 100).toFixed(0)}%`}
                    />
                  )}
                  <Metric
                    label="TAKE PROFIT"
                    value={`+${optionsConfig.policy.take_profit_pct}%`}
                  />
                  <Metric
                    label="STOP LOSS"
                    value={`-${optionsConfig.policy.stop_loss_pct}%`}
                  />
                  <Metric
                    label="ENTRY TIMEOUT"
                    value={`${optionsConfig.policy.entry_timeout_seconds}s`}
                  />
                  <Metric
                    label="EXIT REPRICE"
                    value={`${optionsConfig.policy.exit_reprice_seconds}s`}
                  />
                  <Metric
                    label="MAX PRICE DRIFT"
                    value={`${(optionsConfig.policy.max_price_drift_pct * 100).toFixed(1)}%`}
                  />
                </div>
              </details>
            </>
          )}
        </div>
      </div>
      <footer>
        <span>Jev / Alpaca paper · Not live execution</span>
        <div>
          <a href="https://x.com/zadescoxp" target="_blank" rel="noreferrer">
            Made by @zade
          </a>
          <a
            href="https://github.com/zadescoxp/Jev-Trades"
            target="_blank"
            rel="noreferrer"
          >
            Source code
          </a>
        </div>
      </footer>
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
