"""Alpaca paper execution. Broker acknowledgements are never treated as fills."""

from __future__ import annotations

import json
import math
import os
import queue
import re
import threading
import time
import urllib.request
from collections.abc import Mapping
from copy import deepcopy
from datetime import date, datetime, timezone
from decimal import ROUND_DOWN, Decimal
from typing import Any, cast
from uuid import uuid4
from zoneinfo import ZoneInfo

from alpaca.common.exceptions import APIError
from alpaca.data.historical import (
    CryptoHistoricalDataClient,
    OptionHistoricalDataClient,
    StockHistoricalDataClient,
)
from alpaca.data.requests import (
    CryptoLatestQuoteRequest,
    OptionLatestQuoteRequest,
    StockLatestQuoteRequest,
)
from alpaca.trading.client import TradingClient
from alpaca.trading.enums import (
    AssetClass,
    AssetStatus,
    OrderSide,
    PositionIntent,
    QueryOrderStatus,
    TimeInForce,
)
from alpaca.trading.models import (
    Asset,
    Clock,
    OptionContract,
    OptionContractsResponse,
    Order,
    Position,
    TradeAccount,
)
from alpaca.trading.requests import (
    GetAssetsRequest,
    GetOptionContractsRequest,
    GetOrdersRequest,
    LimitOrderRequest,
    MarketOrderRequest,
    StopLimitOrderRequest,
)

if __package__:
    from . import config, db, options
    from .schema import Questions, option_questions
else:
    import config
    import db
    import options
    from schema import Questions, option_questions

TERMINAL = {"filled", "canceled", "expired", "rejected", "replaced"}
TYPESAFE_URL = "https://api.typesafe.ai/v1/systemone"
CRYPTO_TAKER_FEE = 0.0025  # Conservative: Alpaca's worst-case (lowest 30d-volume tier) taker fee.
CRYPTO_PAIR = re.compile(r"[A-Z][A-Z0-9]{0,19}/USD")  # Matches config.TradingScope's own shape.


def is_crypto_pair(symbol: str) -> bool:
    return bool(CRYPTO_PAIR.fullmatch(symbol))


def positive(value: Any, name: str) -> float:
    if isinstance(value, bool):
        raise ValueError(f"{name} must be a number, not a boolean")
    number = float(value)
    if not math.isfinite(number) or number <= 0:
        raise ValueError(f"{name} must be finite and positive")
    return number


def rounded_quantity(value: float, option: bool) -> float:
    return float(
        Decimal(str(value)).quantize(
            Decimal("1") if option else Decimal("0.000001"), rounding=ROUND_DOWN
        )
    )


def crypto_quantity(value: float, instrument: Mapping[str, Any], *, floor: bool) -> float:
    """Enforce broker min order size and trade increment. Auto-derived sizes floor down;
    explicit caller-supplied quantities are rejected outright rather than silently adjusted.
    """
    step = Decimal(str(instrument["min_trade_increment"]))
    minimum = Decimal(str(instrument["min_order_size"]))
    quantized = Decimal(str(value))
    if floor:
        quantized = (quantized / step).to_integral_value(rounding=ROUND_DOWN) * step
    if quantized < minimum or quantized % step != 0:
        raise ValueError(
            "Crypto quantity must meet the broker minimum order size and trade increment"
        )
    return float(quantized)


def crypto_price(value: float, instrument: Mapping[str, Any]) -> float:
    """Broker-quoted crypto prices must land on the instrument's price increment grid."""
    step = Decimal(str(instrument["price_increment"]))
    if Decimal(str(value)) % step != 0:
        raise ValueError("Crypto price must be a multiple of the broker price increment")
    return value


class PaperTrader:
    def __init__(
        self,
        capital: float = 100_000,
        max_wallet_position_pct: float = 0.75,
        risk_appetite: str = "balanced",
        crypto_risk_appetite: str = "balanced",
    ) -> None:
        self.lock = threading.RLock()
        self.starting_cash = positive(capital, "Strategy budget")
        self.max_wallet_position_pct = max_wallet_position_pct
        self.risk_appetite = risk_appetite
        self.crypto_risk_appetite = crypto_risk_appetite
        self.api_key = os.getenv("TYPESAFE_API_KEY") or os.getenv("TYPESAFE_AI_API_KEY", "")
        self.enabled = False
        self.asset_directory: list[dict[str, str]] | None = None
        self.crypto_asset_directory: list[dict[str, str]] | None = None
        self.generation = 0
        self.pending: queue.Queue = queue.Queue()
        self.queued: set[tuple[str, str, str]] = set()
        self.client = None
        self.stock_data = None
        self.option_data = None
        self.crypto_data = None
        self.instruments: dict[str, dict[str, Any]] = {}
        self.positions: dict[str, dict[str, Any]] = {}
        self.account: dict[str, Any] = {}
        self.recent_logs: list[dict[str, Any]] = []
        self.broker_status = "starting"
        self.broker_error: str | None = None
        self.synced_at = 0.0
        self.option_scans: dict[str, dict[str, Any]] = {}
        self.monitor_error: str | None = None
        self.chart_requests: dict[str, float] = {}
        self.started = False
        db.init_db()
        self.option_policy = config.OptionPolicy.model_validate(
            {**config.OPTIONS.model_dump(), **db.get_option_policy()}, strict=True
        )
        self.crypto_policy = config.CryptoPolicy.model_validate(
            {**config.CRYPTO.model_dump(), **db.get_crypto_policy()}, strict=True
        )
        saved_scope = db.get_trading_scope()
        if saved_scope.pop("crypto_symbol", None) is not None:
            # Legacy single-pair crypto strategy. Multi-pair automation covers the whole
            # watchlist, so require an explicit re-enable instead of silently widening it.
            saved_scope["crypto_enabled"] = False
        self.scope = config.TradingScope.model_validate(saved_scope)
        self.pending.maxsize = max(
            5,
            len(
                set(
                    self.scope.stock_symbols
                    + self.scope.option_underlyings
                    + self.scope.crypto_symbols
                )
            )
            * 10,
        )
        self.option_scans = {s: {"status": "idle"} for s in self.scope.option_underlyings}
        self.orders = {o["client_order_id"]: o for o in db.get_orders()}
        self.exits = db.get_exits()
        self.instruments.update(
            {o["symbol"]: o["instrument"] for o in self.orders.values() if o.get("instrument")}
        )
        self.instruments.update(
            {
                s: target["instrument"]
                for s, target in self.exits.items()
                if target.get("instrument")
            }
        )

    def start(self) -> None:
        if self.started:
            return
        self.started = True
        threading.Thread(target=self._poll, daemon=True, name="alpaca-paper-account").start()
        threading.Thread(target=self._run, daemon=True, name="typesafe-decisions").start()

    def _connect(self) -> None:
        key, secret = config.credentials()
        self.client = TradingClient(key, secret, paper=True)
        self.stock_data = StockHistoricalDataClient(key, secret)
        self.option_data = OptionHistoricalDataClient(key, secret)
        self.crypto_data = CryptoHistoricalDataClient(key, secret)
        self.asset_directory = None
        self.crypto_asset_directory = None
        for symbol in (*self.scope.stock_symbols, *self.scope.option_underlyings):
            self.instruments[symbol] = self._stock_metadata(symbol)
        for symbol in self.scope.crypto_symbols:
            self.instruments[symbol] = self._crypto_metadata(symbol)

    def _stock_metadata(self, symbol: str) -> dict[str, Any]:
        if self.client is None:
            raise ValueError("Alpaca paper client is unavailable")
        asset = cast(Asset, self.client.get_asset(symbol))
        if asset.symbol != symbol or asset.asset_class != AssetClass.US_EQUITY:
            raise ValueError("Expected a matching US stock/ETF asset")
        return {
            "asset_class": "us_equity",
            "multiplier": 1,
            "tradable": asset.tradable and asset.status == AssetStatus.ACTIVE,
            "fractionable": asset.fractionable,
            "expiration": None,
        }

    def _crypto_metadata(self, symbol: str) -> dict[str, Any]:
        if self.client is None:
            raise ValueError("Alpaca paper client is unavailable")
        asset = cast(Asset, self.client.get_asset(symbol))
        if (
            asset.symbol != symbol
            or asset.asset_class != AssetClass.CRYPTO
            or not is_crypto_pair(asset.symbol)
        ):
            raise ValueError("Expected a matching USD-quoted crypto asset")
        if (
            asset.min_order_size is None
            or asset.min_trade_increment is None
            or asset.price_increment is None
        ):
            raise ValueError("Crypto instrument is missing broker sizing metadata")
        return {
            "asset_class": "crypto",
            "multiplier": 1,
            "tradable": asset.tradable and asset.status == AssetStatus.ACTIVE,
            "fractionable": asset.fractionable,
            "expiration": None,
            "min_order_size": positive(asset.min_order_size, "Minimum order size"),
            "min_trade_increment": positive(asset.min_trade_increment, "Minimum trade increment"),
            "price_increment": positive(asset.price_increment, "Price increment"),
        }

    def _canonical_crypto_symbol(self, symbol: str, asset_id: Any) -> str:
        """Alpaca crypto orders/positions may carry legacy no-slash symbols (e.g. "BTCUSD");
        the broker resolves either form by asset_id to the same canonical "BASE/USD" asset.
        """
        if is_crypto_pair(symbol):
            return symbol
        if self.client is None:
            raise ValueError("Alpaca paper client is unavailable")
        asset = cast(Asset, self.client.get_asset(asset_id if asset_id is not None else symbol))
        if asset.asset_class != AssetClass.CRYPTO or not is_crypto_pair(asset.symbol):
            raise ValueError("Legacy crypto symbol did not resolve to a USD-quoted crypto asset")
        return asset.symbol

    def _reconcile_crypto_symbol(self, obj: Any) -> None:
        """Normalize a crypto Order/Position's legacy no-slash symbol in place before any
        dictionary lookup, migrating an exit target persisted under the legacy key.
        """
        symbol = getattr(obj, "symbol", None)
        if getattr(obj, "asset_class", None) != "crypto" or not symbol or is_crypto_pair(symbol):
            return
        canonical = self._canonical_crypto_symbol(symbol, getattr(obj, "asset_id", None))
        obj.symbol = canonical
        if symbol in self.exits:
            merged = {**self.exits.pop(symbol), **self.exits.get(canonical, {})}
            self.exits[canonical] = merged
            db.save_exits(canonical, merged)
            db.delete_exits(symbol)

    def search_assets(self, query: str, asset_class: str = "us_equity") -> list[dict[str, str]]:
        if asset_class not in ("us_equity", "crypto"):
            raise ValueError("Unsupported asset class")
        query = query.strip().upper()
        if not query or len(query) > 80:
            return []
        with self.lock:
            client = self._ready()
            cls = AssetClass.CRYPTO if asset_class == "crypto" else AssetClass.US_EQUITY
            cache_attr = "crypto_asset_directory" if asset_class == "crypto" else "asset_directory"
            if getattr(self, cache_attr) is None:
                assets = cast(
                    list[Asset],
                    client.get_all_assets(
                        GetAssetsRequest(status=AssetStatus.ACTIVE, asset_class=cls)
                    ),
                )
                setattr(
                    self,
                    cache_attr,
                    [
                        {"symbol": a.symbol, "name": a.name or a.symbol}
                        for a in assets
                        if a.tradable
                        and a.status == AssetStatus.ACTIVE
                        and a.asset_class == cls
                        and (asset_class != "crypto" or is_crypto_pair(a.symbol))
                    ],
                )
            directory = getattr(self, cache_attr)
            matches = [a for a in directory if query in a["symbol"] or query in a["name"].upper()]
            return sorted(
                matches,
                key=lambda a: (
                    a["symbol"] != query,
                    not a["symbol"].startswith(query),
                    a["symbol"],
                ),
            )[:20]

    def is_option(self, symbol: str) -> bool:
        return (
            self.instruments.get(symbol, self.positions.get(symbol, {})).get("asset_class")
            == "us_option"
        )

    def is_crypto(self, symbol: str) -> bool:
        if (
            self.instruments.get(symbol, self.positions.get(symbol, {})).get("asset_class")
            == "crypto"
        ):
            return True
        return is_crypto_pair(symbol) or symbol in self.scope.crypto_symbols

    def symbols(self) -> tuple[str, ...]:
        with self.lock:
            candidates = [
                c["symbol"]
                for scan in self.option_scans.values()
                for c in scan.get("candidates", [])
            ]
            pending = [o["symbol"] for o in self.orders.values() if o["status"] not in TERMINAL]
            viewed = [
                s for s, requested in self.chart_requests.items() if time.time() - requested <= 30
            ]
            selected = [self.scope.stock_symbol] if self.scope.stock_symbol else []
            return tuple(
                dict.fromkeys(
                    [
                        *self.scope.stock_symbols,
                        *self.scope.option_underlyings,
                        *self.scope.crypto_symbols,
                        *candidates,
                        *self.positions,
                        *pending,
                        *viewed,
                        *selected,
                    ]
                )
            )

    def _register_option(self, symbol: str) -> None:
        if self.client is None:
            raise ValueError("Alpaca paper client is unavailable")
        self.instruments[symbol] = options.option_instrument(
            cast(OptionContract, self.client.get_option_contract(symbol))
        )

    def _poll(self) -> None:
        while True:
            try:
                with self.lock:
                    if self.client is None or any(
                        s not in self.instruments
                        for s in (
                            *self.scope.stock_symbols,
                            *self.scope.option_underlyings,
                            *self.scope.crypto_symbols,
                        )
                    ):
                        self._connect()
                    self.refresh()
                    self.monitor_options()
            except Exception as error:
                with self.lock:
                    self.broker_status = "unavailable"
                    self.broker_error = str(error)
            time.sleep(3)

    def _record_order(self, order: Any) -> dict[str, Any]:
        self._reconcile_crypto_symbol(order)
        previous = self.orders.get(order.client_order_id, {})
        record = {
            **previous,
            "id": str(order.id),
            "client_order_id": order.client_order_id,
            "symbol": order.symbol,
            "side": order.side.value,
            "quantity": float(order.qty or 0),
            "filled_qty": float(order.filled_qty or 0),
            "price": float(order.filled_avg_price) if order.filled_avg_price is not None else None,
            "estimated_price": float(
                getattr(order, "limit_price", None)
                or previous.get("estimated_price")
                or order.filled_avg_price
                or 0
            ),
            "multiplier": self.instruments.get(order.symbol, {}).get(
                "multiplier", 100 if getattr(order, "asset_class", None) == "us_option" else 1
            ),
            "status": order.status.value,
            "timestamp": (order.filled_at or order.submitted_at or order.created_at).timestamp(),
            "instrument": self.instruments.get(order.symbol, previous.get("instrument", {})),
            "submitted_at": previous.get(
                "submitted_at", (order.submitted_at or order.created_at).timestamp()
            ),
        }
        # Attach exit targets only to an actual (possibly partial) buy fill.
        if (
            record["side"] == "buy"
            and record["filled_qty"] > 0
            and "targets" in previous
            and (
                not previous.get("targets_applied")
                or (
                    previous.get("source") == "jev-options"
                    and previous.get("price") != record["price"]
                    and self.exits.get(order.symbol, {}).get("tp_sl_source") == "jev-options"
                )
            )
        ):
            targets = {**self.exits.get(order.symbol, {}), **previous["targets"]}
            if previous.get("source") == "jev-options":
                entry = positive(record["price"], "Fill price")
                targets["stop_loss_price"] = entry * (1 - targets["premium_stop_pct"] / 100)
                targets["take_profit_price"] = entry * (1 + targets["premium_take_pct"] / 100)
            self.exits[order.symbol] = targets
            db.save_exits(order.symbol, targets)
            record["targets_applied"] = True
        self.orders[order.client_order_id] = record
        db.save_order(record)
        return record

    def refresh(self) -> None:
        """Reconcile account, positions and order status after restart or partial fills."""
        if self.client is None:
            raise ValueError("Alpaca paper account is not connected")
        # Clients use SDK models (raw_data=False), not raw response dictionaries.
        account = cast(TradeAccount, self.client.get_account())
        cash, equity, buying_power = account.cash, account.equity, account.buying_power
        if cash is None or equity is None or buying_power is None:
            raise ValueError("Alpaca account balances are unavailable")
        broker_orders = cast(
            list[Order],
            self.client.get_orders(GetOrdersRequest(status=QueryOrderStatus.ALL, limit=500)),
        )
        seen = set()
        for broker_order in broker_orders:
            self._reconcile_crypto_symbol(broker_order)
            if (
                getattr(broker_order, "asset_class", None) == "us_option"
                and broker_order.status.value not in TERMINAL
                and broker_order.symbol is not None
                and broker_order.symbol not in self.instruments
            ):
                self._register_option(broker_order.symbol)
            elif (
                getattr(broker_order, "asset_class", None) == "crypto"
                and broker_order.status.value not in TERMINAL
                and broker_order.symbol is not None
                and broker_order.symbol not in self.instruments
            ):
                self.instruments[broker_order.symbol] = self._crypto_metadata(broker_order.symbol)
            seen.add(broker_order.client_order_id)
            self._record_order(broker_order)
        for client_id, order in list(self.orders.items()):
            if client_id not in seen and order["status"] not in TERMINAL:
                try:
                    self._record_order(self.client.get_order_by_client_id(client_id))
                except APIError as error:
                    if error.status_code != 404:
                        raise
                    # An ambiguous submission is not safe to repeat, even after a 404.
        positions = {}
        for p in cast(list[Position], self.client.get_all_positions()):
            self._reconcile_crypto_symbol(p)
            if p.asset_class.value == "us_option" and p.symbol not in self.instruments:
                self._register_option(p.symbol)
            elif p.asset_class.value == "crypto" and p.symbol not in self.instruments:
                self.instruments[p.symbol] = self._crypto_metadata(p.symbol)
            entry = float(p.avg_entry_price)
            targets = self.exits.get(p.symbol, {})
            multiplier = self.instruments.get(p.symbol, {}).get(
                "multiplier", 100 if p.asset_class.value == "us_option" else 1
            )
            positions[p.symbol] = {
                "symbol": p.symbol,
                "quantity": float(p.qty),
                "available_quantity": float(p.qty_available or 0),
                "average_entry_price": entry,
                "mark_price": float(p.current_price or entry),
                "market_value": float(p.market_value or 0),
                "unrealized_pnl": float(p.unrealized_pl or 0),
                "unrealized_pnl_pct": float(p.unrealized_plpc or 0) * 100,
                "asset_class": p.asset_class.value,
                "multiplier": multiplier,
                "position": "Long" if float(p.qty) > 0 else "Short",
                "underlying": self.instruments.get(p.symbol, {}).get("underlying"),
                "expiration": self.instruments.get(p.symbol, {}).get("expiration"),
                **targets,
                "stop_loss_pct": (1 - targets["stop_loss_price"] / entry) * 100
                if targets.get("stop_loss_price")
                else None,
                "take_profit_pct": (targets["take_profit_price"] / entry - 1) * 100
                if targets.get("take_profit_price")
                else None,
            }
        for symbol in list(self.exits):
            if symbol not in positions and not self._open_orders(symbol):
                expiration = self.instruments.get(symbol, {}).get("expiration")
                if (
                    expiration
                    and expiration <= datetime.now(ZoneInfo("America/New_York")).date().isoformat()
                ):
                    self._log_event(
                        {
                            "timestamp": time.time(),
                            "action": "expiry_reconciliation",
                            "executed": "hold",
                            "confidence": None,
                            "reason": f"{symbol} is no longer held at Alpaca; inspect account for exercise or delivery effects.",
                        }
                    )
                db.delete_exits(symbol)
                del self.exits[symbol]
        self.positions = positions
        self.account = {
            "cash_balance": float(cash),
            "equity": float(equity),
            "available_cash": max(0, min(float(cash), float(buying_power))),
            "options_buying_power": float(account.options_buying_power or 0),
            "options_trading_level": account.options_trading_level or 0,
            "trading_blocked": account.trading_blocked or account.account_blocked,
            "crypto_status": account.crypto_status.value if account.crypto_status else None,
            "crypto_buying_power": max(0.0, float(account.non_marginable_buying_power or 0)),
        }
        self.synced_at = time.time()
        self.broker_status, self.broker_error = "connected", None

    def configure(
        self,
        capital=None,
        max_wallet_position_pct=None,
        risk_appetite=None,
        api_key=None,
        option_policy: Mapping[str, Any] | None = None,
        trading_scope: Mapping[str, Any] | None = None,
        crypto_policy: Mapping[str, Any] | None = None,
        crypto_risk_appetite=None,
        enabled: bool | None = None,
    ) -> None:
        with self.lock:
            policy = config.OptionPolicy.model_validate(
                {**self.option_policy.model_dump(), **(option_policy or {})}, strict=True
            )
            crypto_limits = config.CryptoPolicy.model_validate(
                {**self.crypto_policy.model_dump(), **(crypto_policy or {})}, strict=True
            )
            scope = config.TradingScope.model_validate(
                {**self.scope.model_dump(), **(trading_scope or {})}
            )
            stock_additions = set((*scope.stock_symbols, *scope.option_underlyings)) - set(
                (*self.scope.stock_symbols, *self.scope.option_underlyings)
            )
            crypto_additions = set(scope.crypto_symbols) - set(self.scope.crypto_symbols)
            instruments = {}
            if stock_additions or crypto_additions:
                self._ready()
                for symbol in stock_additions:
                    instruments[symbol] = self._stock_metadata(symbol)
                    if not instruments[symbol]["tradable"]:
                        raise ValueError(f"{symbol} is not an active tradable stock/ETF")
                for symbol in crypto_additions:
                    instruments[symbol] = self._crypto_metadata(symbol)
                    if not instruments[symbol]["tradable"]:
                        raise ValueError(f"{symbol} is not an active tradable crypto pair")
            capital = (
                self.starting_cash if capital is None else positive(capital, "Strategy budget")
            )
            pct = (
                self.max_wallet_position_pct
                if max_wallet_position_pct is None
                else positive(max_wallet_position_pct, "Max position fraction")
            )
            if pct > 1:
                raise ValueError("Max position fraction cannot exceed 1")
            risk = self.risk_appetite if risk_appetite is None else risk_appetite
            crypto_risk = (
                self.crypto_risk_appetite if crypto_risk_appetite is None else crypto_risk_appetite
            )
            if {risk, crypto_risk} - {"conservative", "balanced", "aggressive"}:
                raise ValueError("Invalid risk appetite")
            key = api_key.strip() if api_key else self.api_key
            if enabled:
                self._ready()
                if not key:
                    raise ValueError("Set a TypeSafe API key before enabling automation")
            if option_policy is not None or trading_scope is not None or crypto_policy is not None:
                db.save_configuration(
                    {**db.get_option_policy(), **option_policy}
                    if option_policy is not None
                    else None,
                    scope.model_dump(mode="json") if trading_scope is not None else None,
                    {**db.get_crypto_policy(), **crypto_policy}
                    if crypto_policy is not None
                    else None,
                )
                self.crypto_policy = crypto_limits
                self.option_policy, self.scope = policy, scope
                self.pending.maxsize = max(
                    5,
                    len(set(scope.stock_symbols + scope.option_underlyings + scope.crypto_symbols))
                    * 10,
                )
                self.instruments.update(instruments)
                self.option_scans = {
                    s: {
                        **self.option_scans.get(s, {}),
                        "status": "idle",
                        "reason": "Settings updated; awaiting next strategy bar",
                    }
                    for s in scope.option_underlyings
                }
            self.starting_cash, self.max_wallet_position_pct = capital, pct
            self.risk_appetite, self.crypto_risk_appetite = risk, crypto_risk
            self.api_key = key
            if enabled is not None:
                self.enabled = enabled
            self.generation += 1

    def _ready(self) -> TradingClient:
        if (
            self.client is None
            or self.broker_status != "connected"
            or time.time() - self.synced_at > 15
        ):
            raise ValueError("Alpaca paper account is unavailable or stale")
        if self.account.get("trading_blocked"):
            raise ValueError("Alpaca account is blocked for trading")
        return self.client

    def snapshot(self, price=None, symbol=None) -> dict[str, Any]:
        with self.lock:
            orders = sorted(self.orders.values(), key=lambda o: o["timestamp"], reverse=True)
            trades = [
                {
                    **o,
                    "quantity": o["filled_qty"],
                    "entry_price": o["price"],
                    "realized_pnl": None,
                    "cash_balance": None,
                    "reason": o.get("source", "alpaca"),
                    "is_manual": o.get("source") == "manual",
                }
                for o in orders
                if o.get("filled_qty", 0) > 0
            ]
            return deepcopy(
                {
                    "account": {
                        "cash_balance": None,
                        "equity": None,
                        "available_cash": None,
                        "crypto_status": None,
                        "crypto_buying_power": None,
                        **self.account,
                        "starting_cash": self.starting_cash,
                        "positions": self.positions,
                        "max_wallet_position_pct": self.max_wallet_position_pct,
                        "risk_appetite": self.risk_appetite,
                        "crypto_risk_appetite": self.crypto_risk_appetite,
                        "crypto_exposure": self._crypto_exposure()[1] if self.account else None,
                        "paper_trading": True,
                        "options_exposure": (
                            sum(
                                max(0, p["market_value"])
                                for s, p in self.positions.items()
                                if self.is_option(s)
                            )
                            + sum(
                                max(0, o["quantity"] - o["filled_qty"])
                                * o["estimated_price"]
                                * o["multiplier"]
                                for o in self.orders.values()
                                if o["side"] == "buy"
                                and o["status"] not in TERMINAL
                                and (self.is_option(o["symbol"]) or o["multiplier"] != 1)
                            )
                        )
                        if self.account
                        else None,
                    },
                    "agent_log": self.recent_logs[-15:],
                    "positions": trades[:100],
                    "orders": orders[:100],
                    "agent_enabled": bool(self.api_key),
                    "scope": self.scope.model_dump(mode="json"),
                    "broker_status": self.broker_status,
                    "broker_error": self.broker_error,
                    "option_scans": self.option_scans,
                    "monitor_error": self.monitor_error,
                }
            )

    def history(self) -> dict[str, Any]:
        snapshot = self.snapshot()
        return {
            "ok": True,
            "trades": snapshot["positions"],
            "orders": snapshot["orders"],
            "account": snapshot["account"],
        }

    def contracts(self, underlying: str, expiration: str, page_token=None) -> dict[str, Any]:
        with self.lock:
            client = self._ready()
            result = client.get_option_contracts(
                GetOptionContractsRequest(
                    underlying_symbols=[underlying],
                    expiration_date=expiration,
                    status=AssetStatus.ACTIVE,
                    limit=100,
                    page_token=page_token,
                )
            )
            return cast(OptionContractsResponse, result).model_dump(mode="json")

    def _open_orders(self, symbol: str) -> list[dict[str, Any]]:
        return [
            o for o in self.orders.values() if o["symbol"] == symbol and o["status"] not in TERMINAL
        ]

    def _quote(self, symbol: str, side: str) -> float:
        if self.is_option(symbol):
            if self.option_data is None:
                raise ValueError("Option data client is unavailable")
            quotes = self.option_data.get_option_latest_quote(
                OptionLatestQuoteRequest(symbol_or_symbols=symbol, feed=config.OPTION_FEED)
            )
        elif self.is_crypto(symbol):
            if self.crypto_data is None:
                raise ValueError("Crypto data client is unavailable")
            quotes = self.crypto_data.get_crypto_latest_quote(
                CryptoLatestQuoteRequest(symbol_or_symbols=symbol), feed=config.CRYPTO_FEED
            )
        else:
            if self.stock_data is None:
                raise ValueError("Stock data client is unavailable")
            quotes = self.stock_data.get_stock_latest_quote(
                StockLatestQuoteRequest(symbol_or_symbols=symbol, feed=config.STOCK_FEED)
            )
        quote = quotes[symbol]
        age = (datetime.now(timezone.utc) - quote.timestamp).total_seconds()
        limit = (
            config.CRYPTO_QUOTE_MAX_AGE_SECONDS
            if self.is_crypto(symbol)
            else config.QUOTE_MAX_AGE_SECONDS
        )
        if not -5 <= age <= limit:
            raise ValueError("Market quote is stale; refusing an order")
        bid, ask = positive(quote.bid_price, "Bid"), positive(quote.ask_price, "Ask")
        if bid > ask:
            raise ValueError("Crossed market quote; refusing an order")
        return ask if side == "buy" else bid

    def _targets(
        self,
        price: float,
        stop_loss_pct=None,
        stop_loss_price=None,
        take_profit_pct=None,
        take_profit_price=None,
        source="manual",
    ) -> dict[str, Any]:
        sl = (
            positive(stop_loss_price, "Stop price")
            if stop_loss_price is not None
            else price * (1 - positive(stop_loss_pct, "Stop percent") / 100)
            if stop_loss_pct is not None
            else None
        )
        tp = (
            positive(take_profit_price, "Target price")
            if take_profit_price is not None
            else price * (1 + positive(take_profit_pct, "Target percent") / 100)
            if take_profit_pct is not None
            else None
        )
        if sl is not None and not 0 < sl < price:
            raise ValueError("Stop loss must be below the reference price and above zero")
        if tp is not None and tp <= price:
            raise ValueError("Take profit must be above the reference price")
        return {"stop_loss_price": sl, "take_profit_price": tp, "tp_sl_source": source}

    def _buying_capacity(self, symbol: str) -> float:
        exposure = sum(max(0, p["market_value"]) for p in self.positions.values())
        reserved = 0.0
        for order in self.orders.values():
            if order["side"] != "buy" or order["status"] in TERMINAL:
                continue
            if not order.get("estimated_price"):
                return 0.0  # Unknown external-order exposure must not bypass the budget.
            reserved += (
                max(0, order["quantity"] - order["filled_qty"])
                * order["estimated_price"]
                * order["multiplier"]
                * (1 + CRYPTO_TAKER_FEE if self.is_crypto(order["symbol"]) else 1)
            )
        held = max(0, self.positions.get(symbol, {}).get("market_value", 0))
        per_symbol = (
            min(self.starting_cash, self.account["equity"]) * self.max_wallet_position_pct - held
        )
        capacity = min(
            self.account["available_cash"],
            self.account["cash_balance"] - reserved,
            self.starting_cash - exposure - reserved,
            per_symbol,
        )
        if self.is_option(symbol):
            capacity = min(capacity, self.account["options_buying_power"])
        elif self.is_crypto(symbol):
            capacity = min(capacity, self.account["crypto_buying_power"])
        return max(0, capacity)

    def _option_capacity(self, underlying: str, symbol: str | None = None) -> float:
        capital = min(self.starting_cash, self.account["equity"])
        option_exposure = underlying_exposure = 0.0
        occupied: set[str] = set()
        for ticker, position in self.positions.items():
            instrument = self.instruments.get(ticker, {})
            exposure = max(0, position["market_value"])
            if self.is_option(ticker):
                if not instrument.get("underlying") or position["quantity"] < 0:
                    return 0.0
                option_exposure += exposure
                if instrument["underlying"] == underlying and position["quantity"] > 0:
                    occupied.add(ticker)
            if ticker == underlying or instrument.get("underlying") == underlying:
                underlying_exposure += exposure
        for order in self.orders.values():
            if order["side"] != "buy" or order["status"] in TERMINAL:
                continue
            ticker = order["symbol"]
            instrument = self.instruments.get(ticker) or order.get("instrument") or {}
            reserved = (
                max(0, order["quantity"] - order["filled_qty"])
                * order["estimated_price"]
                * order["multiplier"]
            )
            if self.is_option(ticker) or order["multiplier"] != 1:
                if not instrument.get("underlying"):
                    return 0.0
                if instrument["underlying"] == underlying:
                    occupied.add(ticker)
                option_exposure += reserved
            if ticker == underlying or instrument.get("underlying") == underlying:
                underlying_exposure += reserved
        # A partial fill and its remaining buy reserve one slot, not two. No pyramiding.
        if symbol in occupied or len(occupied) >= self.option_policy.max_positions_per_underlying:
            return 0.0
        return max(
            0.0,
            min(
                self._buying_capacity(symbol or underlying),
                self.account["options_buying_power"],
                capital * self.option_policy.max_trade_pct,
                capital * self.option_policy.max_underlying_pct - underlying_exposure,
                capital * self.option_policy.max_total_pct - option_exposure,
            ),
        )

    def _crypto_exposure(self, symbol: str | None = None) -> tuple[float, float]:
        """(symbol, all-crypto) exposure: held market value plus fee-inclusive pending buys."""
        pair = total = 0.0
        for ticker, position in self.positions.items():
            if self.is_crypto(ticker):
                value = max(0, position["market_value"])
                total += value
                pair += value if ticker == symbol else 0
        for order in self.orders.values():
            if (
                order["side"] != "buy"
                or order["status"] in TERMINAL
                or not self.is_crypto(order["symbol"])
            ):
                continue
            reserved = (
                max(0, order["quantity"] - order["filled_qty"])
                * (order.get("estimated_price") or 0)
                * (1 + CRYPTO_TAKER_FEE)
            )
            total += reserved
            pair += reserved if order["symbol"] == symbol else 0
        return pair, total

    def _crypto_capacity(self, symbol: str) -> float:
        capital = min(self.starting_cash, self.account["equity"])
        policy = self.crypto_policy
        pair, total = self._crypto_exposure(symbol)
        return max(
            0.0,
            min(
                capital * policy.max_trade_pct,
                capital * policy.max_pair_pct - pair,
                capital * policy.max_total_pct - total,
            ),
        )

    def _order(
        self,
        symbol: str,
        side: str,
        quantity=None,
        amount_usd=None,
        pct_of_position=1.0,
        limit_price=None,
        stop_price=None,
        time_in_force=None,
        source="manual",
        targets=None,
        expected_price=None,
    ) -> dict[str, Any]:
        with self.lock:
            self._ready()
            if symbol not in self.instruments:
                raise ValueError("Symbol has no verified instrument metadata")
            self.refresh()
            client = self._ready()
            if self._open_orders(symbol):
                raise ValueError("An open or unresolved order already exists for this symbol")
            instrument = self.instruments[symbol]
            if side == "buy" and not instrument["tradable"]:
                raise ValueError("Asset is not tradable")
            crypto = self.is_crypto(symbol)
            if crypto and self.account.get("crypto_status") != "ACTIVE":
                raise ValueError("Alpaca account is not eligible for crypto trading")
            if not crypto and (stop_price is not None or time_in_force is not None):
                raise ValueError("stop_price and time_in_force are crypto-only order parameters")
            if time_in_force is not None and time_in_force not in ("gtc", "ioc"):
                raise ValueError("time_in_force must be gtc or ioc")
            tif = TimeInForce.GTC if crypto else TimeInForce.DAY
            if time_in_force is not None:
                tif = TimeInForce(time_in_force)
            if not crypto and not cast(Clock, client.get_clock()).is_open:
                raise ValueError("Regular market session is closed")
            option = self.is_option(symbol)
            candidate = None
            if option and side == "buy":
                underlying = instrument.get("underlying")
                if underlying not in self.scope.option_underlyings:
                    raise ValueError("Option underlying is not in the entry watchlist")
                if self.account["options_trading_level"] < 2:
                    raise ValueError("Long options require Alpaca options trading level 2")
                if self.option_data is None:
                    raise ValueError("Option data client is unavailable")
                candidate = options.validate_candidate(
                    client,
                    self.option_data,
                    symbol,
                    underlying,
                    self._option_capacity(underlying, symbol),
                    expected_price=expected_price,
                    policy=self.option_policy,
                )
                self.instruments[symbol] = instrument = candidate
            elif crypto and side == "buy":
                if symbol not in self.scope.crypto_symbols:
                    raise ValueError("Crypto pair is not in the entry watchlist")
            elif side == "buy" and symbol not in self.scope.stock_symbols:
                raise ValueError("Stock is not in the stock-entry watchlist")
            quote = candidate["limit_price"] if candidate else self._quote(symbol, side)
            limit = (
                positive(limit_price, "Limit price")
                if limit_price is not None
                else round(quote, 2)
                if option
                else None
            )
            if limit is not None:
                positive(limit, "Limit price")
                if crypto:
                    limit = crypto_price(limit, instrument)
            if stop_price is not None:
                stop_price = positive(stop_price, "Stop price")
                if crypto:
                    stop_price = crypto_price(stop_price, instrument)
                if limit is None:
                    raise ValueError("A stop-limit order requires both stop_price and limit_price")
                if tif != TimeInForce.GTC:
                    raise ValueError("Crypto stop-limit orders require gtc time in force")
            price = limit if limit is not None else quote
            multiplier = instrument["multiplier"]
            held = self.positions.get(symbol, {})
            if quantity is not None:
                quantity = positive(quantity, "Quantity")
                if option and not quantity.is_integer():
                    raise ValueError("Options require whole contracts")
                if crypto:
                    quantity = crypto_quantity(quantity, instrument, floor=False)
            fee_multiplier = 1 + CRYPTO_TAKER_FEE if crypto else 1.0
            if side == "buy":
                if quantity is not None and amount_usd is not None:
                    raise ValueError("Specify quantity or amount_usd, not both")
                available = (
                    self._option_capacity(instrument["underlying"], symbol)
                    if option
                    else self._buying_capacity(symbol)
                )
                allocation = (
                    positive(amount_usd, "Amount") if amount_usd is not None else available * 0.5
                )
                if quantity is None:
                    if allocation > available:
                        raise ValueError("Amount exceeds available cash or position budget")
                    quantity = (
                        crypto_quantity(
                            allocation / fee_multiplier / (price * multiplier),
                            instrument,
                            floor=True,
                        )
                        if crypto
                        else rounded_quantity(
                            allocation / (price * multiplier),
                            option or not instrument["fractionable"],
                        )
                    )
                if candidate and quantity > candidate["max_quantity"]:
                    raise ValueError(
                        "Quantity exceeds option risk budget, contract cap, or available quote depth"
                    )
                if quantity * price * multiplier * fee_multiplier > available + 1e-8:
                    raise ValueError("Order exceeds available cash or position budget")
            else:
                available = max(0, min(held.get("quantity", 0), held.get("available_quantity", 0)))
                if quantity is None:
                    fraction = positive(pct_of_position, "Position fraction")
                    if fraction > 1:
                        raise ValueError("Position fraction cannot exceed 1")
                    quantity = (
                        crypto_quantity(available * fraction, instrument, floor=True)
                        if crypto
                        else rounded_quantity(available * fraction, option)
                    )
                if quantity > available:
                    raise ValueError("Sell exceeds available long position; shorting is disabled")
            positive(quantity, "Order quantity")
            if not option and not instrument["fractionable"] and not float(quantity).is_integer():
                raise ValueError("Asset does not support fractional shares")
            client_id = f"jev-{uuid4().hex}"
            args = dict(
                symbol=symbol,
                qty=quantity,
                side=OrderSide(side),
                time_in_force=tif,
                client_order_id=client_id,
            )
            if not crypto:
                args["position_intent"] = (
                    PositionIntent.BUY_TO_OPEN if side == "buy" else PositionIntent.SELL_TO_CLOSE
                )
            request = (
                StopLimitOrderRequest(**args, stop_price=stop_price, limit_price=limit)
                if stop_price is not None
                else LimitOrderRequest(**args, limit_price=limit)
                if limit is not None
                else MarketOrderRequest(**args)
            )
            intent = {
                "client_order_id": client_id,
                "id": None,
                "symbol": symbol,
                "side": side,
                "quantity": quantity,
                "filled_qty": 0,
                "price": None,
                "status": "submitting",
                "timestamp": time.time(),
                "source": source,
                "estimated_price": price,
                "multiplier": multiplier,
                "instrument": instrument,
                "submitted_at": time.time(),
            }
            if targets is not None and side == "buy":
                intent["targets"] = targets
            db.save_order(intent)
            self.orders[client_id] = intent
            try:
                return self._record_order(client.submit_order(request))
            except Exception as error:
                intent["status"] = (
                    "rejected"
                    if isinstance(error, APIError) and error.status_code in {400, 401, 403, 422}
                    else "unknown"
                )
                intent["error"] = str(error)
                db.save_order(intent)
                raise

    def manual_buy(
        self,
        symbol,
        price,
        quantity=None,
        amount_usd=None,
        stop_loss_pct=None,
        stop_loss_price=None,
        take_profit_pct=None,
        take_profit_price=None,
        timeframe="1m",
        limit_price=None,
        stop_price=None,
        time_in_force=None,
        source="manual",
    ):
        with self.lock:
            targets = self._targets(
                self._quote(symbol, "buy")
                if price is None and self.is_option(symbol)
                else positive(price, "Reference price"),
                stop_loss_pct,
                stop_loss_price,
                take_profit_pct,
                take_profit_price,
                source,
            )
            targets = {
                **targets,
                **self.exits.get(symbol, {}),
                **{k: v for k, v in targets.items() if v is not None},
            }
            return self._order(
                symbol,
                "buy",
                quantity,
                amount_usd,
                limit_price=limit_price,
                stop_price=stop_price,
                time_in_force=time_in_force,
                source=source,
                targets=targets,
            )

    def manual_sell(
        self,
        symbol,
        price,
        quantity=None,
        pct_of_position=1.0,
        timeframe="1m",
        limit_price=None,
        stop_price=None,
        time_in_force=None,
        source="manual",
    ):
        return self._order(
            symbol,
            "sell",
            quantity=quantity,
            pct_of_position=pct_of_position,
            limit_price=limit_price,
            stop_price=stop_price,
            time_in_force=time_in_force,
            source=source,
        )

    def cancel_order(self, order_id: str) -> dict[str, Any]:
        with self.lock:
            client = self._ready()
            record = next((o for o in self.orders.values() if o.get("id") == order_id), None)
            if record is None or not record.get("cancel_requested_at"):
                client.cancel_order_by_id(order_id)
                if record is not None:
                    record["cancel_requested_at"] = time.time()
                    db.save_order(record)
            return {"id": order_id, "status": "cancel_requested"}

    def update_tp_sl(
        self,
        symbol,
        stop_loss_pct=None,
        stop_loss_price=None,
        take_profit_pct=None,
        take_profit_price=None,
        timeframe="1m",
    ):
        with self.lock:
            self._ready()
            self.refresh()
            position = self.positions.get(symbol)
            if not position or position["quantity"] <= 0:
                raise ValueError("No long position for this symbol")
            old = self.exits.get(symbol, {})
            values: dict[str, Any] = {
                "stop_loss_price": old.get("stop_loss_price"),
                "take_profit_price": old.get("take_profit_price"),
            }
            for kind, pct, absolute in [
                ("stop_loss", stop_loss_pct, stop_loss_price),
                ("take_profit", take_profit_pct, take_profit_price),
            ]:
                target = absolute if absolute is not None else pct
                if target is not None:
                    value = float(target)
                    if not math.isfinite(value) or value < 0:
                        raise ValueError("Exit targets must be finite and nonnegative")
                    values[kind + "_price"] = None
                    if value:
                        values[kind + ("_price" if absolute is not None else "_pct")] = value
            targets = {**old, **self._targets(position["average_entry_price"], **values)}
            db.save_exits(symbol, targets)
            self.exits[symbol] = targets
            self.positions[symbol].update(targets)
            return targets

    def check_tp_sl(self, symbol, current_price, timeframe="1m"):
        with self.lock:
            if symbol not in self.positions:
                return None
            targets = self.exits.get(symbol, {})
            crypto = self.is_crypto(symbol)
            latched = crypto and bool(targets.get("exit_reason"))
            sl, tp = targets.get("stop_loss_price"), targets.get("take_profit_price")
            reason = (
                targets.get("exit_reason")
                if latched
                else "stop_loss"
                if sl and current_price <= sl
                else "take_profit"
                if tp and current_price >= tp
                else None
            )
            if reason:
                self._ready()
                # The fresh executable-side quote must also cross the target, unless a crypto
                # exit was already latched: a later price recovery must not abandon it.
                bid = self._quote(symbol, "sell")
                if (
                    latched
                    or (reason == "stop_loss" and sl is not None and bid <= sl)
                    or (reason == "take_profit" and tp is not None and bid >= tp)
                ):
                    if self.is_option(symbol):
                        return self._drive_option_exit(symbol, reason)
                    if crypto and not latched:
                        targets.update(exit_reason=reason, exit_requested_at=time.time())
                        db.save_exits(symbol, targets)
                        self.exits[symbol] = targets
                    pending = self._open_orders(symbol)
                    if pending:
                        for order in pending:
                            if (
                                order["side"] == "buy"
                                and order.get("id")
                                and order["status"] != "pending_cancel"
                            ):
                                self.cancel_order(order["id"])
                        return None  # Wait for broker-confirmed cancellation before selling a partial fill.
                    return self.manual_sell(symbol, bid, source=reason)
        return None

    def _drive_option_exit(self, symbol: str, reason: str) -> dict[str, Any] | None:
        targets = self.exits.setdefault(symbol, {})
        if not targets.get("exit_reason"):
            targets.update(
                exit_reason=reason,
                exit_requested_at=time.time(),
                instrument=self.instruments[symbol],
            )
            db.save_exits(symbol, targets)
        self.positions[symbol].update(targets)
        pending = self._open_orders(symbol)
        for order in pending:
            if not order.get("source"):
                raise ValueError(
                    "Unmanaged open order prevents automated exit; reconcile it at Alpaca"
                )
            if not order.get("id"):
                raise ValueError("Unresolved order outcome prevents another exit submission")
            if (
                order["side"] == "buy"
                or time.time() - order["submitted_at"] >= self.option_policy.exit_reprice_seconds
            ):
                self.cancel_order(order["id"])
        if pending:
            return None  # Cancellation acknowledgement is not cancellation confirmation.
        return self._order(symbol, "sell", source=targets["exit_reason"])

    def monitor_options(self) -> None:
        """Manage owned option positions even when automation is paused or the watchlist changes."""
        errors = []
        today = datetime.now(ZoneInfo("America/New_York")).date()
        for order in list(self.orders.values()):
            if (
                order.get("source") != "jev-options"
                or order["side"] != "buy"
                or order["status"] in TERMINAL
            ):
                continue
            if time.time() - order["submitted_at"] >= self.option_policy.entry_timeout_seconds:
                try:
                    if not order.get("id"):
                        raise ValueError(
                            "Unresolved entry outcome; reservation retained until broker reconciliation"
                        )
                    self.cancel_order(order["id"])
                except Exception as error:
                    errors.append(f"{order['symbol']}: {error}")
        for symbol, position in list(self.positions.items()):
            if not self.is_option(symbol) or position["quantity"] <= 0:
                continue
            if symbol not in self.exits:
                continue  # Broker-held positions outside this strategy are not silently liquidated.
            try:
                expiration = date.fromisoformat(self.instruments[symbol]["expiration"])
                if expiration < today:
                    raise ValueError(
                        "Expired position remains at broker; awaiting expiry/exercise reconciliation"
                    )
                targets = self.exits[symbol]
                reason = targets.get("exit_reason")
                if (expiration - today).days <= self.option_policy.exit_dte:
                    reason = reason or "near_expiry"
                if not reason:
                    bid = self._quote(symbol, "sell")
                    sl, tp = targets.get("stop_loss_price"), targets.get("take_profit_price")
                    reason = (
                        "stop_loss"
                        if sl and bid <= sl
                        else "take_profit"
                        if tp and bid >= tp
                        else None
                    )
                if reason:
                    self._drive_option_exit(symbol, reason)
            except Exception as error:
                errors.append(f"{symbol}: {error}")
        self.monitor_error = "; ".join(errors) or None

    def _fresh_underlying(self, state: dict[str, Any]) -> None:
        now = time.time()
        quote_time, bar_time = state.get("quote_time"), state.get("bar_time")
        limit = (
            config.CRYPTO_QUOTE_MAX_AGE_SECONDS
            if self.is_crypto(state["symbol"])
            else config.QUOTE_MAX_AGE_SECONDS
        )
        if quote_time is None or not -5 <= now - quote_time <= limit:
            raise ValueError("Underlying quote is stale or unavailable")
        if bar_time is None or not 0 <= now - bar_time <= 180:
            raise ValueError("Underlying completed bars are stale or unavailable")

    def _prepare_options(self, state: dict[str, Any]) -> dict[str, Any]:
        underlying = state["symbol"]
        self._fresh_underlying(state)
        with self.lock:
            if not self.scope.options_enabled or underlying not in self.scope.option_underlyings:
                return {}
            client = self._ready()
            self.refresh()
            if self.option_data is None:
                raise ValueError("Option data client is unavailable")
            if not cast(Clock, client.get_clock()).is_open:
                raise ValueError("Regular market session is closed")
            budget = self._option_capacity(underlying)
            policy, generation = self.option_policy, self.generation
            excluded = {s for s, p in self.positions.items() if p["quantity"] > 0}
            excluded.update(
                o["symbol"]
                for o in self.orders.values()
                if o["side"] == "buy" and o["status"] not in TERMINAL
            )
            held = [
                dict(p)
                for s, p in self.positions.items()
                if self.is_option(s)
                and p.get("underlying") == underlying
                and p["quantity"] > 0
                and s in self.exits
            ]
            self.option_scans[underlying] = {
                **self.option_scans.get(underlying, {}),
                "status": "scanning",
                "started_at": time.time(),
            }
        try:
            scan = (
                options.discover_candidates(
                    client,
                    self.option_data,
                    underlying,
                    budget,
                    policy=policy,
                    excluded_symbols=excluded,
                )
                if budget > 0
                else {
                    "candidates": [],
                    "discovered": 0,
                    "eligible": 0,
                    "rejections": {},
                    "as_of": time.time(),
                    "reason": "Existing exposure or premium budget prevents another entry",
                }
            )
            scan["status"] = "ready" if scan["candidates"] else "no eligible contracts"
        except Exception as error:
            scan = {
                "status": "blocked",
                "error": str(error),
                "candidates": [],
                "as_of": time.time(),
            }
        with self.lock:
            if generation != self.generation:
                return {}
            self.option_scans[underlying] = (
                {
                    **self.option_scans.get(underlying, {}),
                    "status": "blocked",
                    "error": scan["error"],
                }
                if scan.get("error")
                else scan
            )
            for candidate in scan["candidates"]:
                self.instruments[candidate["symbol"]] = candidate
            supported = set(self.symbols())
            for symbol in list(self.instruments):
                if symbol not in supported:
                    del self.instruments[symbol]
        return {
            **state,
            "candidates": scan["candidates"],
            "option_positions": held,
            "option_budget": budget,
            "option_policy": policy.model_dump(),
            "option_feed": config.OPTION_FEED.value,
            "scan_reason": scan.get("error", scan.get("reason", "No eligible option contracts")),
        }

    def _apply_option_decision(
        self, state: dict[str, Any], response: dict[str, Any]
    ) -> dict[str, Any]:
        answer = response.get("answers", {}).get("option_action", {})
        choice = answer.get("choice", "hold")
        permitted = option_questions(state)["option_action"]["criteria"]
        if choice not in permitted:
            raise ValueError("Agent selected an option action outside the verified shortlist")
        confidence = answer.get("confidence", 0)
        if (
            isinstance(confidence, bool)
            or not isinstance(confidence, (int, float))
            or not math.isfinite(confidence)
            or not 0 <= confidence <= 1
        ):
            raise ValueError("Invalid agent confidence")
        event = {
            "timestamp": time.time(),
            "symbol": state["symbol"],
            "strategy": "options",
            "time_frame": state.get("time_frame"),
            "action": choice,
            "confidence": confidence,
            "executed": "hold",
            "request": state,
            "response": response,
        }
        threshold = self.option_policy.min_confidence
        if choice == "hold" or confidence < threshold:
            event["reason"] = (
                "Model selected hold"
                if choice == "hold"
                else f"Confidence below {threshold:.0%} minimum"
            )
            return event
        self._fresh_underlying(state)
        action, symbol = choice.split(":", 1)
        if action == "buy":
            candidate = next(c for c in state["candidates"] if c["symbol"] == symbol)
            targets = {
                "premium_stop_pct": self.option_policy.stop_loss_pct,
                "premium_take_pct": self.option_policy.take_profit_pct,
                "tp_sl_source": "jev-options",
            }
            order = self._order(
                symbol,
                "buy",
                quantity=candidate["max_quantity"],
                source="jev-options",
                targets=targets,
                expected_price=candidate["limit_price"],
            )
        else:
            self.refresh()
            if symbol not in self.positions or self.positions[symbol]["quantity"] <= 0:
                return event
            order = self._drive_option_exit(symbol, "agent_exit")
        event.update(executed="submitted" if order else "exit_pending", trade=order)
        return event

    def _log_event(self, event: dict[str, Any]) -> None:
        db.log_decision(event)
        with self.lock:
            self.recent_logs = (self.recent_logs + [event])[-15:]

    def submit(self, state: dict[str, Any], strategy: str = "stock") -> None:
        with self.lock:
            if not state or not self.enabled or not self.api_key:
                return
            symbol = state["symbol"]
            if strategy == "options":
                if not self.scope.options_enabled or symbol not in self.scope.option_underlyings:
                    return
            elif strategy == "crypto":
                if not self.scope.crypto_enabled or symbol not in self.scope.crypto_symbols:
                    return
            elif (
                strategy != "stock"
                or not self.scope.stock_enabled
                or symbol != self.scope.stock_symbol
                or symbol not in self.scope.stock_symbols
            ):
                return
            key = (strategy, symbol, state.get("time_frame", "1m"))
            if key in self.queued:
                return
            try:
                self.pending.put_nowait(
                    (self.generation, time.time(), {**deepcopy(state), "strategy": strategy})
                )
                self.queued.add(key)
            except queue.Full:
                pass

    def _run(self) -> None:
        while True:
            generation, submitted_at, state = self.pending.get()
            key = (state["strategy"], state["symbol"], state.get("time_frame", "1m"))
            try:
                with self.lock:
                    if (
                        generation != self.generation
                        or not self.enabled
                        or time.time() - submitted_at > 120
                    ):
                        continue
                if state["strategy"] == "options":
                    state = self._prepare_options(state)
                    if not state:
                        continue
                    if not state["candidates"] and not state["option_positions"]:
                        self._log_event(
                            {
                                "timestamp": time.time(),
                                "symbol": state["symbol"],
                                "strategy": state["strategy"],
                                "time_frame": state.get("time_frame"),
                                "action": "hold",
                                "executed": "hold",
                                "confidence": None,
                                "reason": state["scan_reason"],
                            }
                        )
                        continue
                questions = option_questions(state) if state["strategy"] == "options" else Questions
                with self.lock:
                    if (
                        generation != self.generation
                        or not self.enabled
                        or time.time() - submitted_at > 120
                    ):
                        continue
                    api_key = self.api_key
                request = urllib.request.Request(
                    TYPESAFE_URL,
                    data=json.dumps(
                        {"state": state, "model": "jev-latest", "questions": questions}
                    ).encode(),
                    headers={
                        "Authorization": f"Bearer {api_key}",
                        "Content-Type": "application/json",
                    },
                    method="POST",
                )
                with urllib.request.urlopen(request, timeout=15) as response:
                    result = json.loads(response.read())
                with self.lock:
                    if (
                        generation != self.generation
                        or not self.enabled
                        or time.time() - submitted_at > 120
                    ):
                        continue
                    self._log_event(self._apply_decision(state, result))
            except Exception as error:
                with self.lock:
                    if generation != self.generation:
                        continue
                    if state["strategy"] == "options":
                        self.option_scans[state["symbol"]] = {
                            **self.option_scans.get(state["symbol"], {}),
                            "status": "blocked",
                            "error": str(error),
                        }
                    self._log_event(
                        {
                            "timestamp": time.time(),
                            "symbol": state["symbol"],
                            "strategy": state["strategy"],
                            "time_frame": state.get("time_frame"),
                            "action": "error",
                            "executed": "hold",
                            "confidence": None,
                            "error": str(error),
                        }
                    )
            finally:
                with self.lock:
                    self.queued.discard(key)
                self.pending.task_done()

    def _apply_decision(self, state: dict[str, Any], response: dict[str, Any]) -> dict[str, Any]:
        if state.get("strategy") == "options":
            return self._apply_option_decision(state, response)
        if state.get("strategy") == "crypto":
            self._fresh_underlying(state)
        self._ready()
        answers = response.get("answers", {})
        answer = answers.get("action_choice", {})
        action, confidence = answer.get("choice", "hold"), float(answer.get("confidence", 0))
        crypto = state.get("strategy") == "crypto"
        profile = self.crypto_risk_appetite if crypto else self.risk_appetite
        threshold = (
            self.crypto_policy.min_confidence
            if crypto
            else {"conservative": 0.75, "balanced": 0.6, "aggressive": 0.5}[profile]
        )
        event = {
            "timestamp": time.time(),
            "symbol": state["symbol"],
            "strategy": state.get("strategy", "stock"),
            "time_frame": state.get("time_frame"),
            "price": state["current_price"],
            "action": action,
            "confidence": confidence,
            "executed": "hold",
            "request": state,
            "response": response,
        }
        if not math.isfinite(confidence) or not 0 <= confidence <= 1:
            raise ValueError("Invalid agent confidence")
        if confidence < threshold or action not in {"buy", "sell"}:
            event["reason"] = (
                f"Confidence below {threshold:.0%} minimum"
                if confidence < threshold
                else "Model selected hold"
            )
            return event
        symbol, price = state["symbol"], positive(state["current_price"], "Price")
        if self._open_orders(symbol):
            return event
        score = float(
            answers.get("buying_quantity" if action == "buy" else "selling_quantity", {}).get(
                "score", 0
            )
        )
        if not math.isfinite(score):
            raise ValueError("Invalid agent size")
        fraction = 0.25 if score < 0.67 else 0.5 if score < 1.34 else 1.0
        if action == "buy":
            risk = {"conservative": 0.5, "balanced": 0.75, "aggressive": 1.0}[profile]
            sl_choice = answers.get("stop_loss_target", {}).get("choice", "moderate")
            tp_choice = answers.get("take_profit_target", {}).get("choice", "balanced")
            sl_mult = {"conservative": 0.8, "balanced": 1.0, "aggressive": 1.3}[profile]
            tp_mult = {"conservative": 0.9, "balanced": 1.0, "aggressive": 1.2}[profile]
            atr = state.get("price", {}).get("atr14")
            if atr is not None and math.isfinite(float(atr)) and atr > 0:
                sl = (
                    atr
                    * {"tight": 1.5, "moderate": 2.5, "wide": 4.0}.get(sl_choice, 2.5)
                    / price
                    * 100
                    * sl_mult
                )
                tp = (
                    atr
                    * {"conservative": 2.0, "balanced": 4.0, "aggressive": 8.0}.get(tp_choice, 4.0)
                    / price
                    * 100
                    * tp_mult
                )
                fraction *= max(0.2, min(1.0, 1.5 / (atr / price * 100)))
            else:
                sl = {"tight": 1.5, "moderate": 3.0, "wide": 5.0}.get(sl_choice, 3.0) * sl_mult
                tp = {"conservative": 3.0, "balanced": 6.0, "aggressive": 10.0}.get(
                    tp_choice, 6.0
                ) * tp_mult
            allocation = self._buying_capacity(symbol) * risk * fraction
            if crypto:
                allocation = min(allocation, self._crypto_capacity(symbol))
            if allocation <= 0:
                return event
            order = self.manual_buy(
                symbol,
                price,
                amount_usd=allocation,
                stop_loss_pct=sl,
                take_profit_pct=tp,
                source="jev",
            )
        elif symbol in self.positions:
            order = self.manual_sell(symbol, price, pct_of_position=fraction, source="jev")
        else:
            return event
        event.update(executed="submitted", trade=order)
        return event
