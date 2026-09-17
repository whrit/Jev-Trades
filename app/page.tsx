"use client";

import dynamic from "next/dynamic";
import Image from "next/image";
import { useEffect, useMemo, useState } from "react";

const MarketChart = dynamic(() => import("./market-chart"), { ssr: false });

type Bar = { time: number; open: number; high: number; low: number; close: number; volume: number };
type Indicators = Record<string, number | null>;
type AgentEvent = { timestamp: number; price?: number; action: string; confidence: number | null; executed: string; request?: unknown; response?: unknown; error?: string | null };
type Trade = { symbol: string; side: "buy" | "sell"; quantity: number; price: number; entry_price: number; realized_pnl: number | null; cash_balance: number; timestamp: number };
type Position = { symbol: string; quantity: number; average_entry_price: number; mark_price: number; unrealized_pnl_pct: number; position: string };
type Trading = { account: { starting_cash: number; cash_balance: number; available_cash: number; equity: number; positions: Record<string, Position>; max_wallet_position_pct: number; risk_appetite: string; paper_trading: boolean }; agent_log: AgentEvent[]; positions: Trade[]; agent_enabled: boolean };
type Snapshot = { symbol: string; supported_symbols: string[]; status: string; trading_enabled: boolean; price: number | null; bars: Bar[]; indicators: Indicators; indicator_series: { ema20: (number | null)[]; sma50: (number | null)[] }; last_tick: number | null; trading: Trading; settings: { capital: number; max_wallet_position_pct: number; risk_appetite: string; trading_enabled: boolean } };

const feedBase = process.env.NEXT_PUBLIC_MARKET_FEED_URL ?? "http://127.0.0.1:8765";
const streamBase = process.env.NEXT_PUBLIC_MARKET_STREAM_URL ?? `${feedBase}/stream`;
const symbols = ["ADA-USD", "XRP-USD", "ETH-USD", "BTC-USD", "SOL-USD", "BNB-USD", "TRX-USD"];
const assetLogos: Record<string, string> = { "ADA-USD": "/logos/ada.png", "XRP-USD": "/logos/xrp.svg", "ETH-USD": "/logos/eth.svg", "BTC-USD": "/logos/btc.svg", "SOL-USD": "/logos/sol.svg", "BNB-USD": "/logos/bnb.png", "TRX-USD": "/logos/trx.png" };
const indicatorGroups: { title: string; items: [string, string][] }[] = [
  { title: "Moving averages", items: [["ema_10", "EMA 10"], ["sma_10", "SMA 10"], ["ema_20", "EMA 20"], ["sma_20", "SMA 20"], ["ema_30", "EMA 30"], ["sma_30", "SMA 30"], ["ema_50", "EMA 50"], ["sma_50", "SMA 50"], ["ema_100", "EMA 100"], ["sma_100", "SMA 100"], ["ema_200", "EMA 200"], ["sma_200", "SMA 200"], ["ichimoku_base_line_9_26_52_26", "Ichimoku base"], ["vwma_20", "VWMA 20"], ["hull_ma_9", "Hull MA 9"]] },
  { title: "Oscillators", items: [["relative_strength_index_14", "RSI 14"], ["stochastic_percent_k_14_3_3", "Stochastic %K"], ["commodity_channel_index_20", "CCI 20"], ["average_directional_index_14", "ADX 14"], ["awesome_oscillator", "Awesome oscillator"], ["momentum_10", "Momentum 10"], ["macd_level_12_26", "MACD 12/26"], ["stochastic_rsi_fast_3_3_14_14", "Stochastic RSI"], ["williams_percent_range_14", "Williams %R"], ["bull_bear_power", "Bull/Bear power"], ["ultimate_oscillator_7_14_28", "Ultimate oscillator"]] },
];
const allIndicatorKeys = indicatorGroups.flatMap((group) => group.items.map(([key]) => key));

export default function Home() {
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [symbol, setSymbol] = useState("BTC-USD");
  const [capital, setCapital] = useState("100000");
  const [maxWalletPositionPct, setMaxWalletPositionPct] = useState("75");
  const [riskAppetite, setRiskAppetite] = useState("balanced");
  const [typeSafeKey, setTypeSafeKey] = useState("");
  const [tradingEnabled, setTradingEnabled] = useState(false);
  const [overlays, setOverlays] = useState(["ema20"]);
  const [selectedIndicators, setSelectedIndicators] = useState(["ema_20", "sma_50", "relative_strength_index_14", "macd_level_12_26"]);
  const [activityTab, setActivityTab] = useState<"logs" | "positions">("logs");

  useEffect(() => {
    const source = new EventSource(`${streamBase}?symbol=${encodeURIComponent(symbol)}`);
    source.onmessage = (event) => {
      const next = JSON.parse(event.data) as Snapshot;
      setSnapshot(next);
      setTradingEnabled(next.trading_enabled);
    };
    source.onerror = () => setSnapshot((current) => current ? { ...current, status: "feed unavailable" } : null);
    return () => source.close();
  }, [symbol]);

  const configurePortfolio = async (enabled = tradingEnabled, selectedSymbol = symbol) => {
    try {
      const response = await fetch(`${feedBase}/config`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ symbol: selectedSymbol, capital: Number(capital), max_wallet_position_pct: Number(maxWalletPositionPct) / 100, risk_appetite: riskAppetite, trading_enabled: enabled, typesafe_api_key: typeSafeKey.trim() || undefined }) });
      if (!response.ok) throw new Error(`Configuration request failed (${response.status})`);
      setTradingEnabled(enabled);
    } catch (error) {
      console.error("Could not configure the paper-trading feed", error);
    }
  };
  const price = snapshot?.price;
  const change = useMemo(() => { const first = snapshot?.bars[0]?.open; return price && first ? ((price - first) / first) * 100 : null; }, [price, snapshot?.bars]);
  const selectedPosition = snapshot?.trading.account.positions[symbol];
  const toggle = (name: string) => setOverlays((current) => current.includes(name) ? current.filter((item) => item !== name) : [...current, name]);
  const toggleIndicator = (name: string) => setSelectedIndicators((current) => current.includes(name) ? current.filter((item) => item !== name) : [...current, name]);
  const labelFor = (name: string) => indicatorGroups.flatMap((group) => group.items).find(([key]) => key === name)?.[1] ?? name;

  return (
    <main className="dashboard">
      <header className="topbar"><div><p className="eyebrow">MARKET DESK / LIVE FEED</p><h1>{symbol}</h1><p className="muted">{symbol} <span className="dot" /> 1 minute candles</p></div><div className="connection"><span className={`status-dot ${snapshot?.status === "live" ? "is-live" : ""}`} />{snapshot?.status ?? "connecting"}</div></header>
      <section className="portfolio-controls"><label>ASSET<div className="asset-picker"><Image src={assetLogos[symbol]} alt="" className="asset-logo" width={22} height={22} /><select value={symbol} onChange={(event) => { const nextSymbol = event.target.value; setSymbol(nextSymbol); void configurePortfolio(false, nextSymbol); }}>{symbols.map((item) => <option key={item}>{item}</option>)}</select></div></label><label>CAPITAL<input type="number" min="0" step="100" value={capital} onChange={(event) => setCapital(event.target.value)} /></label><label>MAX POSITION %<input type="number" min="1" max="100" step="1" value={maxWalletPositionPct} onChange={(event) => setMaxWalletPositionPct(event.target.value)} /></label><label>RISK<select value={riskAppetite} onChange={(event) => setRiskAppetite(event.target.value)}><option value="conservative">Conservative</option><option value="balanced">Balanced</option><option value="aggressive">Aggressive</option></select></label><label className="key-field">TYPESAFE KEY<input type="password" autoComplete="off" placeholder="Optional if server has one" value={typeSafeKey} onChange={(event) => setTypeSafeKey(event.target.value)} /></label><button className="control" onClick={() => void configurePortfolio()}>Apply portfolio</button><button className={tradingEnabled ? "trade-toggle running" : "trade-toggle"} onClick={() => void configurePortfolio(!tradingEnabled)}>{tradingEnabled ? `Stop trading ${symbol}` : `Start trading ${symbol}`}</button></section>
      <section className="quote-grid"><div className="quote"><span className="label">LAST PRICE</span><strong>{price ? `$${price.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` : "--"}</strong><span className={change !== null && change >= 0 ? "positive" : "negative"}>{change === null ? "Waiting for ticks" : `${change >= 0 ? "+" : ""}${change.toFixed(2)}% session`}</span></div><Metric label="RSI (14)" value={snapshot?.indicators.rsi14?.toFixed(2) ?? "--"} /><Metric label="MACD" value={snapshot?.indicators.macd?.toFixed(2) ?? "--"} /><Metric label="LAST TICK" value={snapshot?.last_tick ? new Date(snapshot.last_tick * 1000).toLocaleTimeString() : "--"} /></section>
      <div className="workspace-grid"><div className="main-column"><section className="chart-panel"><div className="panel-head"><div><p className="eyebrow">PRICE ACTION</p><h2>{symbol} / USD</h2></div><div className="controls">{[["ema20", "EMA 20"], ["sma50", "SMA 50"]].map(([name, label]) => <button key={name} className={overlays.includes(name) ? "control active" : "control"} onClick={() => toggle(name)}>{label}</button>)}</div></div>{snapshot ? <MarketChart bars={snapshot.bars} indicatorSeries={snapshot.indicator_series} overlays={overlays} /> : <div className="loading">Waiting for the market feed...</div>}<p className="attribution">Charts powered by TradingView Lightweight Charts. Data: Yahoo Finance via yfinance websocket.</p></section>
        <section className="indicator-panel"><div className="panel-head"><div><p className="eyebrow">INDICATOR LIBRARY</p><h2>Choose live values to display</h2></div><span className="muted">{selectedIndicators.length} selected / {allIndicatorKeys.length}</span></div><div className="indicator-groups">{indicatorGroups.map((group) => <div className="indicator-group" key={group.title}><span className="label">{group.title}</span><div className="indicator-options">{group.items.map(([key, label]) => <button key={key} className={selectedIndicators.includes(key) ? "indicator-option active" : "indicator-option"} onClick={() => toggleIndicator(key)}>{label}</button>)}</div></div>)}</div><div className="indicator-values">{selectedIndicators.map((key) => <div className="indicator-value" key={key}><span>{labelFor(key)}</span><strong>{snapshot?.indicators[key] === null || snapshot?.indicators[key] === undefined ? "Warming up" : snapshot.indicators[key]?.toFixed(4)}</strong></div>)}</div></section>
        <section className="lower-grid"><Metric label="EMA 20" value={snapshot?.indicators.ema20?.toFixed(2) ?? "--"} /><Metric label="SMA 50" value={snapshot?.indicators.sma50?.toFixed(2) ?? "Warming up"} /><div className="note"><span className="label">PIPELINE</span><p>All subscribed assets are evaluated against the shared paper portfolio.</p></div></section></div>
        <aside className="trading-panel"><div className="panel-head"><div><p className="eyebrow">PAPER PORTFOLIO</p><h2>Jev activity</h2></div><span className="paper-badge">SIMULATION ONLY</span></div><div className="account-grid"><Metric label="AVAILABLE CASH" value={snapshot ? `$${snapshot.trading.account.available_cash.toLocaleString(undefined, { maximumFractionDigits: 2 })}` : "--"} /><Metric label="EQUITY" value={snapshot ? `$${snapshot.trading.account.equity.toLocaleString(undefined, { maximumFractionDigits: 2 })}` : "--"} /><Metric label={`${symbol} POSITION`} value={selectedPosition?.position ?? "None"} /><Metric label={`${symbol} P&L`} value={selectedPosition ? `${selectedPosition.unrealized_pnl_pct.toFixed(2)}%` : "--"} /></div><div className="activity-tabs"><button className={activityTab === "logs" ? "activity-tab active" : "activity-tab"} onClick={() => setActivityTab("logs")}>Agent logs</button><button className={activityTab === "positions" ? "activity-tab active" : "activity-tab"} onClick={() => setActivityTab("positions")}>Positions</button></div>{activityTab === "logs" ? <div className="agent-log">{snapshot?.trading.agent_log.length ? snapshot.trading.agent_log.slice().reverse().map((event, index) => <details className="agent-event" key={`${event.timestamp}-${index}`}><summary><span className={`action action-${event.executed}`}>{event.executed.toUpperCase()}</span><strong>{event.price ? `$${event.price.toLocaleString(undefined, { maximumFractionDigits: 2 })}` : "--"}</strong><span>{event.confidence === null ? "error" : `${(event.confidence * 100).toFixed(0)}% confidence`}</span><time>{new Date(event.timestamp * 1000).toLocaleTimeString()}</time></summary><div className="agent-payloads"><div><span className="payload-title">REQUEST SENT</span><pre>{JSON.stringify(event.request, null, 2)}</pre></div><div><span className="payload-title">RESPONSE RECEIVED</span><pre>{JSON.stringify(event.response, null, 2)}</pre></div></div>{event.error ? <em>{event.error}</em> : null}</details>) : <p className="loading-log">{snapshot && !snapshot.trading.agent_enabled ? "TypeSafe key not loaded by the Python feed" : "Waiting for the first TypeSafe decision..."}</p>}</div> : <div className="positions-list">{snapshot?.trading.positions.length ? snapshot.trading.positions.slice().reverse().map((trade, index) => <div className={`position-record position-${trade.side}`} key={`${trade.timestamp}-${index}`}><div className="position-head"><span className={`action action-${trade.side}`}>{trade.symbol} {trade.side.toUpperCase()}</span><time>{new Date(trade.timestamp * 1000).toLocaleString()}</time></div><div className="position-details"><Metric label="PRICE" value={`$${trade.price.toLocaleString(undefined, { maximumFractionDigits: 2 })}`} /><Metric label="QUANTITY" value={trade.quantity.toFixed(6)} /><Metric label="ENTRY" value={`$${trade.entry_price.toLocaleString(undefined, { maximumFractionDigits: 2 })}`} /><Metric label="REALIZED P&L" value={trade.realized_pnl === null ? "Open" : `$${trade.realized_pnl.toFixed(2)}`} /><Metric label="CASH AFTER" value={`$${trade.cash_balance.toLocaleString(undefined, { maximumFractionDigits: 2 })}`} /></div></div>) : <p className="loading-log">No executed buy or sell positions yet.</p>}</div>}</aside></div>
    </main>
  );
}

function Metric({ label, value }: { label: string; value: string }) { return <div className="metric"><span className="label">{label}</span><strong>{value}</strong></div>; }
