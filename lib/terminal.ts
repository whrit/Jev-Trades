export type Bar = {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
};
export type Trade = {
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
  /** Order origin: "manual", "jev", "stop_loss", "take_profit", ... */
  source?: string;
  submitted_at?: number;
  tp?: number | null;
  sl?: number | null;
  is_manual?: boolean;
  underlying?: string;
  expiration?: string;
  exit_reason?: string;
};
export type Position = {
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
export type AgentEvent = {
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
export type OptionCandidate = {
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
  bid_size: number;
  ask_size: number;
  quote_time: number;
  greeks: Record<
    "delta" | "gamma" | "rho" | "theta" | "vega",
    number | null
  > | null;
  implied_volatility: number | null;
};
export type OptionScan = {
  status: string;
  reason?: string;
  error?: string;
  as_of?: number;
  discovered?: number;
  eligible?: number;
  candidates?: OptionCandidate[];
};
export type CryptoPolicy = {
  max_trade_pct: number;
  max_pair_pct: number;
  max_total_pct: number;
  min_confidence: number;
};
export type CryptoQuote = {
  bid: number | null;
  ask: number | null;
  price: number | null;
  status: string | null;
  /** Previous UTC daily close, for the day change. */
  prev_close: number | null;
};
export type OptionPolicy = {
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
export type TradingScope = {
  stock_symbols: string[];
  option_underlyings: string[];
  stock_symbol: string;
  stock_enabled: boolean;
  options_enabled: boolean;
  crypto_symbols: string[];
  crypto_enabled: boolean;
};
export type Instrument = {
  asset_class: string;
  multiplier: number;
  underlying?: string;
  expiration?: string;
  option_type?: "call" | "put";
  min_order_size?: number | null;
  min_trade_increment?: number | null;
  price_increment?: number | null;
};
export type Settings = {
  capital: number;
  max_wallet_position_pct: number;
  risk_appetite: string;
  crypto_risk_appetite: string;
  active_timeframes: string[];
  chart_timeframe: string;
};
export type Snapshot = {
  symbol: string;
  supported_symbols: string[];
  trading_scope?: TradingScope;
  /** Quote state: starting | cached | live | stale quote | no quote | unavailable. */
  status: string;
  error: string | null;
  instruments: Record<string, Instrument>;
  data_feeds: { stocks: string; options: string; crypto: string };
  trading_enabled: boolean;
  price: number | null;
  bars: Bar[];
  indicators: Record<string, number | null>;
  /** Full-length moving-average series (EMA/SMA 10-200) aligned to `bars`. */
  indicator_series: Record<string, (number | null)[]>;
  last_tick: number | null;
  server_time: number;
  crypto_stream_error?: string | null;
  stock_stream_error?: string | null;
  trading: {
    account: {
      starting_cash: number;
      cash_balance: number | null;
      available_cash: number | null;
      equity: number | null;
      options_exposure?: number | null;
      /** Held crypto value plus fee-inclusive pending crypto buys. */
      crypto_exposure?: number | null;
      crypto_status?: string | null;
      crypto_buying_power?: number | null;
      options_buying_power?: number;
      options_trading_level?: number;
      trading_blocked?: boolean;
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
  settings: Settings;
  options?: { underlyings: string[]; policy: OptionPolicy; feed: string };
  crypto?: { policy: CryptoPolicy; quotes: Record<string, CryptoQuote> };
};
export type AssetMode = "equities" | "crypto";
/** Response of POST /config; the fields present depend on the patch sent. */
export type ConfigResult = {
  settings: Settings;
  trading_enabled: boolean;
  trading_scope: TradingScope;
  option_policy: OptionPolicy;
  crypto_policy: CryptoPolicy;
};

/** Mirrors pipeline/paper_trader.py: worst-tier Alpaca crypto taker fee used for sizing. */
export const CRYPTO_TAKER_FEE = 0.0025;

// Mirrors the CSS tokens in app/globals.css (the chart canvas cannot read them).
export const chartColors = {
  bg: "#101318",
  text: "#8a93a3",
  grid: "rgba(255,255,255,0.035)",
  border: "rgba(255,255,255,0.07)",
  up: "#72a7f7",
  down: "#f0616b",
  upVolume: "rgba(114,167,247,0.28)",
  downVolume: "rgba(240,97,107,0.28)",
  accent: "#72a7f7",
};

/** Picker key → feed `indicator_series` key (20/50 keep legacy names). */
export const overlaySeriesKey = (key: string) =>
  key === "ema_20" ? "ema20" : key === "sma_50" ? "sma50" : key;
/** One hue per period; EMAs draw solid, SMAs dashed. */
export const periodColors: Record<string, string> = {
  "10": "#e6b450",
  "20": "#7cc4d8",
  "30": "#d98ad6",
  "50": "#f0915f",
  "100": "#9fc27a",
  "200": "#d7dbe3",
};

export const feedBase =
  process.env.NEXT_PUBLIC_MARKET_FEED_URL ?? "http://127.0.0.1:8765";
export const streamBase =
  process.env.NEXT_PUBLIC_MARKET_STREAM_URL ?? `${feedBase}/stream`;
export const TIMEFRAMES = ["1m", "5m", "15m", "1h", "4h"] as const;

/** POST JSON to the feed; throws the server's error text on failure. */
export async function postFeed<T = Record<string, unknown>>(
  path: "/config" | "/order",
  body: unknown,
  fallbackError: string,
): Promise<T> {
  const response = await fetch(`${feedBase}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const result = await response.json();
  if (!response.ok || !result.ok)
    throw new Error(result.error || fallbackError);
  return result as T;
}

export const errorText = (error: unknown, fallback: string) =>
  error instanceof Error ? error.message : fallback;

export const isCryptoTicker = (value: string) => value.includes("/");

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
export const decimalsFromIncrement = (
  increment: number | null | undefined,
  fallback: number,
) => {
  if (!increment || increment <= 0) return fallback;
  return Math.min(20, exactDecimals(increment));
};
export const incrementAttr = (
  value: number | null | undefined,
  fallback: number,
) => {
  const base = value && value > 0 ? value : fallback;
  return base.toFixed(decimalsFromIncrement(base, 8));
};
type InstrumentInfo = Partial<
  Pick<Instrument, "asset_class" | "price_increment" | "min_trade_increment">
>;
export const priceDecimals = (instrument?: InstrumentInfo) =>
  instrument?.asset_class === "crypto"
    ? decimalsFromIncrement(instrument.price_increment, 8)
    : 2;
export const qtyDecimals = (instrument?: InstrumentInfo) =>
  instrument?.asset_class === "us_option"
    ? 0
    : instrument?.asset_class === "crypto"
      ? decimalsFromIncrement(instrument.min_trade_increment, 8)
      : 6;
export const money = (value: number | null | undefined, decimals = 2) =>
  value == null
    ? "--"
    : `$${value.toLocaleString(undefined, { minimumFractionDigits: Math.min(2, decimals), maximumFractionDigits: decimals })}`;
export const signedMoney = (value: number | null | undefined) =>
  value == null ? "--" : `${value >= 0 ? "+" : "-"}${money(Math.abs(value))}`;
/** Compact elapsed time, e.g. 42s, 7m, 9h, 3d. */
export const age = (seconds: number) => {
  const s = Math.max(0, Math.round(seconds));
  return s < 60
    ? `${s}s`
    : s < 3600
      ? `${Math.floor(s / 60)}m`
      : s < 86400
        ? `${Math.floor(s / 3600)}h`
        : `${Math.floor(s / 86400)}d`;
};
export const qty = (value: number, instrument?: InstrumentInfo) =>
  value.toLocaleString(undefined, {
    maximumFractionDigits: qtyDecimals(instrument),
  });
export const clock = (seconds: number) =>
  new Date(seconds * 1000).toLocaleTimeString(undefined, { hour12: false });

export const indicatorGroups: { title: string; items: [string, string][] }[] = [
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
      ["stochastic_percent_k_14_3_3", "Stoch %K"],
      ["commodity_channel_index_20", "CCI 20"],
      ["average_directional_index_14", "ADX 14"],
      ["awesome_oscillator", "AO"],
      ["momentum_10", "MOM 10"],
      ["macd_level_12_26", "MACD 12/26"],
      ["stochastic_rsi_fast_3_3_14_14", "Stoch RSI"],
      ["williams_percent_range_14", "Williams %R"],
      ["bull_bear_power", "Bull/Bear"],
      ["ultimate_oscillator_7_14_28", "UO"],
    ],
  },
];
export const indicatorLabel = (key: string) =>
  indicatorGroups
    .flatMap((group) => group.items)
    .find(([k]) => k === key)?.[1] ?? key;

/** One editable risk-limit input. `ceiling` fields show their dollar ceiling. */
export type PolicyField = {
  key: string;
  label: string;
  unit: "%" | "";
  scale: number;
  min: number;
  max?: number;
  step: number;
  hint: string | "ceiling";
};
const pctField = (key: string, label: string): PolicyField => ({
  key,
  label,
  unit: "%",
  scale: 100,
  min: 0.01,
  max: 100,
  step: 0.01,
  hint: "ceiling",
});
const confidenceField: PolicyField = {
  key: "min_confidence",
  label: "Jev confidence",
  unit: "%",
  scale: 100,
  min: 0,
  max: 100,
  step: 0.01,
  hint: "Not a profit probability",
};
export const optionPolicyFields: PolicyField[] = [
  pctField("max_trade_pct", "Per-entry premium"),
  pctField("max_underlying_pct", "Per-ticker exposure"),
  pctField("max_total_pct", "Total options exposure"),
  {
    key: "max_positions_per_underlying",
    label: "Positions per ticker",
    unit: "",
    scale: 1,
    min: 1,
    step: 1,
    hint: "Held + pending entries",
  },
  {
    key: "max_contracts",
    label: "Contracts per order",
    unit: "",
    scale: 1,
    min: 1,
    step: 1,
    hint: "Whole contracts per entry",
  },
  confidenceField,
];
export const cryptoPolicyFields: PolicyField[] = [
  pctField("max_trade_pct", "Per-entry notional"),
  pctField("max_pair_pct", "Per-pair exposure"),
  pctField("max_total_pct", "Total crypto exposure"),
  confidenceField,
];
