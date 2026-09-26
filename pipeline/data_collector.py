"""Poll Alpaca stock/option data and publish the dashboard SSE feed."""

from __future__ import annotations

import json
import math
import os
import threading
import time
from datetime import datetime, timedelta, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any, cast
from urllib.parse import parse_qs, urlparse
from zoneinfo import ZoneInfo

import pandas as pd
from alpaca.common.enums import Sort
from alpaca.data.historical import OptionHistoricalDataClient, StockHistoricalDataClient
from alpaca.data.models import BarSet
from alpaca.data.requests import (
    OptionBarsRequest,
    OptionLatestQuoteRequest,
    StockBarsRequest,
    StockLatestQuoteRequest,
)
from alpaca.data.timeframe import TimeFrame
from pydantic import ValidationError

if __package__:
    from . import config
    from .api_models import CONFIG_PAYLOAD, ORDER_PAYLOAD
    from .paper_trader import PaperTrader
else:
    import config
    from api_models import CONFIG_PAYLOAD, ORDER_PAYLOAD
    from paper_trader import PaperTrader


TIMEFRAMES = {"1m": 60, "5m": 300, "15m": 900, "1h": 3600, "4h": 14400}
HOST = os.getenv("HOST", "127.0.0.1")
PORT = int(os.getenv("PORT", "8765"))
MAX_BARS = 1000
STORE_DIR = Path(__file__).with_name("alpaca_market_data")


class MarketState:
    def __init__(self) -> None:
        self.lock = threading.RLock()
        self.selected_symbol = next(iter(TRADER.symbols()), "")
        self.trading_enabled = False
        self.markets = {
            s: {"bars": [], "price": None, "last_tick": None, "status": "starting", "error": None}
            for s in TRADER.symbols()
        }
        self.capital = 100_000.0
        self.max_wallet_position_pct = 0.75
        self.risk_appetite = "balanced"
        self.active_timeframes = ["1m"]
        self.chart_timeframe = "1m"

    def snapshot(self, symbol: str | None = None, timeframe: str | None = None) -> dict[str, Any]:
        with self.lock, TRADER.lock:
            selected = symbol or (
                self.selected_symbol
                if self.selected_symbol in TRADER.symbols()
                else next(iter(TRADER.symbols()), "")
            )
            tf = timeframe or self.chart_timeframe
            supported = TRADER.symbols()
            if selected not in supported and selected in TRADER.instruments:
                supported = (*supported, selected)
            if (selected and selected not in supported) or tf not in TIMEFRAMES:
                raise ValueError("Unknown symbol or timeframe")
            if selected:
                TRADER.chart_requests[selected] = time.time()
            market = self.markets.setdefault(
                selected,
                {"bars": [], "price": None, "last_tick": None, "status": "starting", "error": None},
            )
            bars = resample_bars(market["bars"], tf)
            completed = [bar for bar in bars if bar["time"] + TIMEFRAMES[tf] <= time.time()]
            price = market["price"] or (bars[-1]["close"] if bars else None)
            return {
                "symbol": selected,
                "supported_symbols": supported,
                "trading_scope": TRADER.scope.model_dump(mode="json"),
                "instruments": {
                    s: TRADER.instruments.get(s, {"asset_class": "us_equity", "multiplier": 1})
                    for s in supported
                },
                "options": {
                    "underlyings": TRADER.scope.option_underlyings,
                    "policy": TRADER.option_policy.model_dump(),
                    "feed": config.OPTION_FEED.value,
                },
                "data_feeds": {
                    "stocks": config.STOCK_FEED.value,
                    "options": config.OPTION_FEED.value,
                },
                "status": market["status"],
                "error": market["error"],
                "server_time": int(time.time()),
                "last_tick": market["last_tick"],
                "price": price,
                "bars": bars,
                "indicators": calculate_indicators(completed),
                "indicator_series": calculate_indicator_series(bars),
                "trading": TRADER.snapshot(),
                "trading_enabled": self.trading_enabled,
                "settings": {
                    "capital": self.capital,
                    "max_wallet_position_pct": self.max_wallet_position_pct,
                    "risk_appetite": self.risk_appetite,
                    "active_timeframes": self.active_timeframes,
                    "chart_timeframe": tf,
                },
            }


TRADER = PaperTrader()
STATE = MarketState()


def _series(bars: list[dict[str, Any]], key: str) -> pd.Series:
    return pd.Series([bar[key] for bar in bars], dtype="float64")


def _last(value: Any) -> float | None:
    return None if not math.isfinite(float(value)) else round(float(value), 6)


def _wilder(series: pd.Series, period: int) -> pd.Series:
    return series.ewm(alpha=1 / period, adjust=False, min_periods=period).mean()


def _wma(series: pd.Series, period: int) -> pd.Series:
    weights = pd.Series(range(1, period + 1), dtype="float64")
    return series.rolling(period).apply(
        lambda values: float((values * weights.to_numpy()).sum() / weights.sum()), raw=True
    )


def calculate_indicators(bars: list[dict[str, Any]]) -> dict[str, float | None]:
    """Calculate the indicator contract in pipeline/schema.py from completed OHLCV bars."""
    if not bars:
        return {}

    close = _series(bars, "close")
    high = _series(bars, "high")
    low = _series(bars, "low")
    volume = _series(bars, "volume")
    typical = (high + low + close) / 3
    ma: dict[str, pd.Series] = {}
    for period in (10, 20, 30, 50, 100, 200):
        ma[f"ema_{period}"] = close.ewm(span=period, adjust=False, min_periods=period).mean()
        ma[f"sma_{period}"] = close.rolling(period).mean()
    ma["ichimoku_base_line_9_26_52_26"] = (high.rolling(26).max() + low.rolling(26).min()) / 2
    ma["vwma_20"] = (close * volume).rolling(20).sum() / volume.rolling(20).sum().replace(
        0, float("nan")
    )
    hma_half = _wma(close, 9 // 2)
    hma_full = _wma(close, 9)
    ma["hull_ma_9"] = _wma(2 * hma_half - hma_full, int(9**0.5))

    delta = close.diff()
    gain = delta.clip(lower=0)
    loss = -delta.clip(upper=0)
    average_gain = _wilder(gain, 14)
    average_loss = _wilder(loss, 14)
    rsi = 100 - (100 / (1 + average_gain / average_loss.replace(0, float("nan"))))
    rsi = rsi.mask((average_loss == 0) & (average_gain > 0), 100)
    rsi = rsi.mask((average_gain == 0) & (average_loss > 0), 0)
    trailing_high = high.rolling(14).max()
    trailing_low = low.rolling(14).min()
    raw_stochastic = (
        100 * (close - trailing_low) / (trailing_high - trailing_low).replace(0, float("nan"))
    )
    stochastic_k = raw_stochastic.rolling(3).mean()
    mean_deviation = typical.rolling(20).apply(
        lambda values: float(abs(values - values.mean()).mean()), raw=True
    )
    cci = (typical - typical.rolling(20).mean()) / (0.015 * mean_deviation)

    true_range = pd.concat(
        [high - low, (high - close.shift()).abs(), (low - close.shift()).abs()], axis=1
    ).max(axis=1)
    up_move = high.diff()
    down_move = -low.diff()
    plus_dm = up_move.where((up_move > down_move) & (up_move > 0), 0)
    minus_dm = down_move.where((down_move > up_move) & (down_move > 0), 0)
    atr14 = _wilder(true_range, 14)
    plus_di = 100 * _wilder(plus_dm, 14) / atr14
    minus_di = 100 * _wilder(minus_dm, 14) / atr14
    dx = 100 * (plus_di - minus_di).abs() / (plus_di + minus_di).replace(0, float("nan"))
    adx = _wilder(dx, 14)

    macd = (
        close.ewm(span=12, adjust=False, min_periods=26).mean()
        - close.ewm(span=26, adjust=False, min_periods=26).mean()
    )
    macd_signal = macd.ewm(span=9, adjust=False, min_periods=9).mean()
    stoch_rsi = (
        100
        * (rsi - rsi.rolling(14).min())
        / (rsi.rolling(14).max() - rsi.rolling(14).min()).replace(0, float("nan"))
    )
    stoch_rsi_fast = stoch_rsi.rolling(3).mean()
    williams = (
        -100 * (trailing_high - close) / (trailing_high - trailing_low).replace(0, float("nan"))
    )
    awesome = (high + low).div(2).rolling(5).mean() - (high + low).div(2).rolling(34).mean()
    momentum = close - close.shift(10)
    bull_bear = (high - close.ewm(span=13, adjust=False, min_periods=13).mean()) + (
        low - close.ewm(span=13, adjust=False, min_periods=13).mean()
    )
    true_low = pd.concat([low, close.shift()], axis=1).min(axis=1)
    buying_pressure = close - true_low
    uo = (
        (
            4 * buying_pressure.rolling(7).sum() / true_range.rolling(7).sum()
            + 2 * buying_pressure.rolling(14).sum() / true_range.rolling(14).sum()
            + buying_pressure.rolling(28).sum() / true_range.rolling(28).sum()
        )
        / 7
        * 100
    )

    result = {name: _last(values.iloc[-1]) for name, values in ma.items()}
    result.update(
        {
            "relative_strength_index_14": _last(rsi.iloc[-1]),
            "stochastic_percent_k_14_3_3": _last(stochastic_k.iloc[-1]),
            "commodity_channel_index_20": _last(cci.iloc[-1]),
            "average_directional_index_14": _last(adx.iloc[-1]),
            "awesome_oscillator": _last(awesome.iloc[-1]),
            "momentum_10": _last(momentum.iloc[-1]),
            "macd_level_12_26": _last(macd.iloc[-1]),
            "stochastic_rsi_fast_3_3_14_14": _last(stoch_rsi_fast.iloc[-1]),
            "williams_percent_range_14": _last(williams.iloc[-1]),
            "bull_bear_power": _last(bull_bear.iloc[-1]),
            "ultimate_oscillator_7_14_28": _last(uo.iloc[-1]),
            "ema20": _last(ma["ema_20"].iloc[-1]),
            "sma50": _last(ma["sma_50"].iloc[-1]),
            "rsi14": _last(rsi.iloc[-1]),
            "macd": _last(macd.iloc[-1]),
            "signal": _last(macd_signal.iloc[-1]),
            "atr14": _last(atr14.iloc[-1]),
        }
    )
    return result


def calculate_indicator_series(bars: list[dict[str, Any]]) -> dict[str, list[float | None]]:
    close = _series(bars, "close")
    series: dict[str, pd.Series] = {}
    for period in (10, 20, 30, 50, 100, 200):
        series[f"ema_{period}"] = close.ewm(span=period, adjust=False, min_periods=period).mean()
        series[f"sma_{period}"] = close.rolling(period).mean()
    return {
        name.replace("_", "") if name in ("ema_20", "sma_50") else name: [
            _last(value) for value in values
        ]
        for name, values in series.items()
    }


def resample_bars(bars: list[dict[str, Any]], tf: str) -> list[dict[str, Any]]:
    if not bars or tf == "1m":
        return bars
    df = pd.DataFrame(bars)
    df["datetime"] = pd.to_datetime(df["time"], unit="s")
    df.set_index("datetime", inplace=True)

    rule = f"{TIMEFRAMES[tf]}s"
    resampled = (
        df.resample(rule, label="left", closed="left")
        .agg(
            {
                "time": "first",
                "open": "first",
                "high": "max",
                "low": "min",
                "close": "last",
                "volume": "sum",
            }
        )
        .dropna()
    )
    resampled["time"] = cast(pd.DatetimeIndex, resampled.index).as_unit("s").astype("int64")
    return cast(list[dict[str, Any]], resampled.to_dict("records"))


def merge_bars(symbol: str, incoming: list[Any]) -> None:
    """Upsert provider candles by timestamp; a quote is never candle volume."""
    with STATE.lock:
        market = STATE.markets[symbol]
        previous = market["bars"][-1]["time"] if market["bars"] else None
        merged = {bar["time"]: bar for bar in market["bars"]}
        for bar in incoming:
            timestamp = int(bar.timestamp.timestamp())
            if timestamp + 60 > time.time():
                continue
            merged[timestamp] = {
                "time": timestamp,
                "open": bar.open,
                "high": bar.high,
                "low": bar.low,
                "close": bar.close,
                "volume": bar.volume,
            }
        market["bars"] = [merged[t] for t in sorted(merged)[-MAX_BARS:]]
        latest = market["bars"][-1]["time"] if market["bars"] else None
        STORE_DIR.mkdir(parents=True, exist_ok=True)
        path = STORE_DIR / f"{symbol}.json"
        temporary = path.with_suffix(".tmp")
        temporary.write_text(json.dumps(market["bars"]), encoding="utf-8")
        temporary.replace(path)
        # Never replay historical decisions on warm start or after a long outage.
        if previous is None or latest is None or latest <= previous or time.time() - latest > 180:
            return
        if STATE.trading_enabled:
            for tf in STATE.active_timeframes:
                if (latest + 60) // TIMEFRAMES[tf] > (previous + 60) // TIMEFRAMES[tf]:
                    state = build_agent_state(symbol, tf)
                    TRADER.submit(state, strategy="options")
                    TRADER.submit(state, strategy="stock")


def build_agent_state(symbol: str, timeframe: str = "1m") -> dict[str, Any]:
    with STATE.lock:
        market = STATE.markets[symbol]
        completed = market["bars"][-MAX_BARS:]
        bars = completed
        resampled_completed = [
            b
            for b in resample_bars(completed, timeframe)
            if b["time"] + TIMEFRAMES[timeframe] <= time.time()
        ]

        indicators = calculate_indicators(resampled_completed)
        price = market["price"] or (completed[-1]["close"] if completed else None)
        if price is None:
            return {}
        day_start = (
            datetime.now(ZoneInfo("America/New_York"))
            .replace(hour=0, minute=0, second=0, microsecond=0)
            .timestamp()
        )
        day_bars = [bar for bar in bars if bar["time"] >= day_start]
        day_high = max((bar["high"] for bar in day_bars), default=price)
        day_low = min((bar["low"] for bar in day_bars), default=price)
        day_open = day_bars[0]["open"] if day_bars else price
        day_volume = sum(bar["volume"] for bar in day_bars)
        trading = TRADER.snapshot(price, symbol)["account"]

        position = trading["positions"].get(symbol, {})
        return {
            "symbol": symbol,
            "asset_class": "us_option" if TRADER.is_option(symbol) else "us_equity",
            "contract_multiplier": TRADER.instruments.get(symbol, {}).get(
                "multiplier", 100 if TRADER.is_option(symbol) else 1
            ),
            "current_price": price,
            "bar_time": completed[-1]["time"] if completed else None,
            "quote_time": market["last_tick"],
            "oscillators": {
                key: value
                for key, value in indicators.items()
                if key not in {"ema20", "sma50", "rsi14", "macd", "signal"}
                and key
                not in {
                    "ema_10",
                    "sma_10",
                    "ema_20",
                    "sma_20",
                    "ema_30",
                    "sma_30",
                    "ema_50",
                    "sma_50",
                    "ema_100",
                    "sma_100",
                    "ema_200",
                    "sma_200",
                    "ichimoku_base_line_9_26_52_26",
                    "vwma_20",
                    "hull_ma_9",
                }
            },
            "moving_averages": {
                key: indicators.get(key)
                for key in (
                    "ema_10",
                    "sma_10",
                    "ema_20",
                    "sma_20",
                    "ema_30",
                    "sma_30",
                    "ema_50",
                    "sma_50",
                    "ema_100",
                    "sma_100",
                    "ema_200",
                    "sma_200",
                    "ichimoku_base_line_9_26_52_26",
                    "vwma_20",
                    "hull_ma_9",
                )
            },
            "position": position.get("position", "None"),
            "quantity": position.get("quantity", 0.0),
            "time_frame": f"{timeframe.replace('m', ' minute').replace('h', ' hour')}",
            "cash_balance": trading["cash_balance"],
            "capital": trading["starting_cash"],
            "equity": trading["equity"],
            "available_cash": trading["available_cash"],
            "position_quantity": position.get("quantity", 0.0),
            "average_entry_price": position.get("average_entry_price"),
            "unrealized_pnl_pct": position.get("unrealized_pnl_pct", 0.0),
            "stop_loss_price": position.get("stop_loss_price"),
            "take_profit_price": position.get("take_profit_price"),
            "stop_loss_pct": position.get("stop_loss_pct"),
            "take_profit_pct": position.get("take_profit_pct"),
            "position_age_bars": 0,
            "max_wallet_position_pct": STATE.max_wallet_position_pct,
            "risk_appetite": STATE.risk_appetite,
            "price": {
                "change_percent": ((price - day_open) / day_open) * 100 if day_open else 0,
                "day_high": day_high,
                "day_low": day_low,
                "open_price": day_open,
                "day_volume": day_volume,
                "atr14": indicators.get("atr14"),
            },
        }


def market_worker() -> None:
    clients = None
    last_history: dict[str, float] = {}
    for symbol in TRADER.symbols():
        path = STORE_DIR / f"{symbol}.json"
        if path.exists():
            try:
                with STATE.lock:
                    STATE.markets[symbol]["bars"] = json.loads(path.read_text(encoding="utf-8"))[
                        -MAX_BARS:
                    ]
                    STATE.markets[symbol]["status"] = "cached"
            except (ValueError, OSError) as error:
                STATE.markets[symbol]["error"] = str(error)
    while True:
        with TRADER.lock:
            TRADER.chart_requests = {
                s: requested
                for s, requested in TRADER.chart_requests.items()
                if time.time() - requested <= 30
            }
            watched = tuple(
                dict.fromkeys(
                    [
                        *TRADER.scope.stock_symbols,
                        *TRADER.scope.option_underlyings,
                        *TRADER.positions,
                        *TRADER.chart_requests,
                    ]
                )
            )
        for symbol in watched:
            try:
                with STATE.lock:
                    STATE.markets.setdefault(
                        symbol,
                        {
                            "bars": [],
                            "price": None,
                            "last_tick": None,
                            "status": "starting",
                            "error": None,
                        },
                    )
                if clients is None:
                    key, secret = config.credentials()
                    clients = (
                        StockHistoricalDataClient(key, secret),
                        OptionHistoricalDataClient(key, secret),
                    )
                stock, option = clients
                is_option = TRADER.is_option(symbol)
                if is_option:
                    quotes = option.get_option_latest_quote(
                        OptionLatestQuoteRequest(symbol_or_symbols=symbol, feed=config.OPTION_FEED)
                    )
                else:
                    quotes = stock.get_stock_latest_quote(
                        StockLatestQuoteRequest(symbol_or_symbols=symbol, feed=config.STOCK_FEED)
                    )
                quote = quotes.get(symbol)
                if quote is not None:
                    age = time.time() - quote.timestamp.timestamp()
                    price = (quote.bid_price + quote.ask_price) / 2
                    if math.isfinite(price) and 0 < quote.bid_price <= quote.ask_price:
                        with STATE.lock:
                            market = STATE.markets[symbol]
                            market.update(
                                price=price,
                                last_tick=quote.timestamp.timestamp(),
                                status="live" if -5 <= age <= 30 else "stale / market closed",
                                error=None,
                            )
                        if -5 <= age <= 30 and not is_option:
                            try:
                                TRADER.check_tp_sl(symbol, quote.bid_price)
                            except Exception as error:
                                with STATE.lock:
                                    market["error"] = f"Exit monitoring: {error}"
                else:
                    with STATE.lock:
                        STATE.markets[symbol].update(
                            status="no quote", error="No quote returned for this symbol"
                        )
                if time.time() - last_history.get(symbol, 0) >= 60:
                    now = datetime.now(timezone.utc)
                    start = (
                        now - timedelta(days=7)
                        if symbol not in last_history
                        else now - timedelta(minutes=5)
                    )
                    args: dict[str, Any] = dict(
                        symbol_or_symbols=symbol,
                        timeframe=TimeFrame.Minute,
                        start=start,
                        end=now.replace(second=0, microsecond=0),
                        sort=Sort.DESC,
                        limit=MAX_BARS,
                    )
                    bars = (
                        option.get_option_bars(OptionBarsRequest(**args))
                        if is_option
                        else stock.get_stock_bars(StockBarsRequest(**args, feed=config.STOCK_FEED))
                    )
                    merge_bars(symbol, cast(BarSet, bars).data.get(symbol, []))
                    last_history[symbol] = time.time()
            except Exception as error:
                with STATE.lock:
                    STATE.markets[symbol].update(status="unavailable", error=str(error))
        time.sleep(5)


def configure(payload: dict[str, Any]) -> None:
    request = CONFIG_PAYLOAD.validate_python(payload)
    with STATE.lock, TRADER.lock:
        enabled = request.get("trading_enabled", STATE.trading_enabled)
        frames = request.get("active_timeframes", STATE.active_timeframes)
        capital = request.get("capital", STATE.capital)
        pct = request.get("max_wallet_position_pct", STATE.max_wallet_position_pct)
        risk = request.get("risk_appetite", STATE.risk_appetite)
        key = request.get("typesafe_api_key")

        if any(tf not in TIMEFRAMES for tf in frames):
            raise ValueError("Choose supported analysis timeframes")
        TRADER.configure(
            capital,
            pct,
            risk,
            key,
            option_policy=request.get("option_policy"),
            trading_scope=request.get("trading_scope"),
            enabled=enabled,
        )
        STATE.trading_enabled = enabled
        STATE.capital, STATE.max_wallet_position_pct, STATE.risk_appetite = capital, pct, risk
        STATE.active_timeframes = list(dict.fromkeys(frames))


class FeedHandler(BaseHTTPRequestHandler):
    def allowed(self) -> bool:
        origin = self.headers.get("Origin")
        if origin and origin not in config.ALLOWED_ORIGINS:
            return False
        # Reject DNS rebinding of the unauthenticated local service.
        if HOST in {"127.0.0.1", "localhost"}:
            return self.headers.get("Host", "").split(":")[0] in {"127.0.0.1", "localhost"}
        return True

    def cors(self) -> None:
        origin = self.headers.get("Origin")
        if origin in config.ALLOWED_ORIGINS:
            self.send_header("Access-Control-Allow-Origin", origin)
            self.send_header("Vary", "Origin")

    def do_OPTIONS(self) -> None:
        if not self.allowed():
            self.send_error(403)
            return
        self.send_response(204)
        self.cors()
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.end_headers()

    def do_GET(self) -> None:
        if not self.allowed():
            self.send_error(403)
            return
        url = urlparse(self.path)
        query = parse_qs(url.query)
        try:
            if url.path == "/health":
                self.send_json(
                    {
                        "ok": TRADER.broker_status == "connected",
                        "broker_status": TRADER.broker_status,
                        "error": TRADER.broker_error,
                    }
                )
                return
            if url.path == "/history":
                self.send_json(TRADER.history())
                return
            if url.path == "/assets":
                self.send_json(
                    {"ok": True, "assets": TRADER.search_assets(query.get("query", [""])[0])}
                )
                return
            if url.path == "/contracts":
                self.send_json(
                    TRADER.contracts(
                        query.get("underlying", ["SPY"])[0],
                        query["expiration"][0],
                        query.get("page_token", [None])[0],
                    )
                )
                return
            if url.path != "/stream":
                self.send_error(404)
                return
            selected, timeframe = query.get("symbol", [None])[0], query.get("timeframe", [None])[0]
            STATE.snapshot(selected, timeframe)
        except Exception as error:
            self.send_json({"ok": False, "error": str(error)}, 400)
            return
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.send_header("Cache-Control", "no-cache")
        self.cors()
        self.end_headers()
        try:
            while True:
                payload = json.dumps(
                    STATE.snapshot(selected, timeframe), separators=(",", ":"), allow_nan=False
                )
                self.wfile.write(f"data: {payload}\n\n".encode())
                self.wfile.flush()
                time.sleep(1)
        except BrokenPipeError, ConnectionResetError, ConnectionAbortedError:
            return

    def send_json(self, payload: dict[str, Any], status: int = 200) -> None:
        body = json.dumps(payload, allow_nan=False).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.cors()
        self.end_headers()
        self.wfile.write(body)

    def do_POST(self) -> None:
        if not self.allowed():
            self.send_error(403)
            return
        try:
            if self.headers.get_content_type() != "application/json":
                raise ValueError("Content-Type must be application/json")
            length = int(self.headers.get("Content-Length", 0))
            if not 0 < length <= 16384:
                raise ValueError("Invalid request body size")
            payload = json.loads(self.rfile.read(length))
            if not isinstance(payload, dict):
                raise ValueError("Expected a JSON object")
            path = urlparse(self.path).path
            if path == "/config":
                configure(payload)
                self.send_json(
                    {
                        "ok": True,
                        "settings": STATE.snapshot()["settings"],
                        "option_policy": TRADER.option_policy.model_dump(),
                        "trading_scope": TRADER.scope.model_dump(mode="json"),
                        "trading_enabled": TRADER.enabled,
                    }
                )
                return
            if path != "/order":
                self.send_error(404)
                return
            ORDER_PAYLOAD.validate_python(payload)
            action = payload.get("action")
            if action == "cancel":
                self.send_json({"ok": True, "trade": TRADER.cancel_order(payload["order_id"])})
                return
            symbol = payload.get("symbol", STATE.selected_symbol)
            if symbol not in TRADER.symbols():
                raise ValueError("Symbol is not configured")
            price = STATE.snapshot(symbol)["price"]
            fields = {
                k: payload[k]
                for k in (
                    "stop_loss_pct",
                    "stop_loss_price",
                    "take_profit_pct",
                    "take_profit_price",
                )
                if payload.get(k) is not None
            }
            if action == "buy":
                trade = TRADER.manual_buy(
                    symbol,
                    price,
                    quantity=payload.get("quantity"),
                    amount_usd=payload.get("amount_usd"),
                    limit_price=payload.get("limit_price"),
                    **fields,
                )
            elif action in {"sell", "exit"}:
                trade = TRADER.manual_sell(
                    symbol,
                    price,
                    quantity=payload.get("quantity") if action == "sell" else None,
                    pct_of_position=payload.get("pct_of_position", 1.0)
                    if action == "sell"
                    else 1.0,
                    limit_price=payload.get("limit_price"),
                )
            elif action == "update_tp_sl":
                trade = TRADER.update_tp_sl(symbol, **fields)
            else:
                raise ValueError("Unsupported order action")
            self.send_json({"ok": True, "trade": trade, "snapshot": TRADER.snapshot()})
        except ValidationError as error:
            details = error.errors(include_input=False, include_url=False)
            message = "; ".join(f"{'.'.join(map(str, e['loc']))}: {e['msg']}" for e in details)
            self.send_json({"ok": False, "error": message}, 400)
        except Exception as error:
            self.send_json({"ok": False, "error": str(error)}, 400)

    def log_message(self, format: str, *args: Any) -> None:
        return


if __name__ == "__main__":
    TRADER.start()
    threading.Thread(target=market_worker, daemon=True, name="alpaca-market-data").start()
    print(f"Alpaca paper feed listening on http://{HOST}:{PORT}", flush=True)
    ThreadingHTTPServer((HOST, PORT), FeedHandler).serve_forever()
