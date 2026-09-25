"""Alpaca paper execution. Broker acknowledgements are never treated as fills."""

from __future__ import annotations

import json
import math
import os
import queue
import threading
import time
import urllib.request
from copy import deepcopy
from datetime import datetime, timezone
from decimal import ROUND_DOWN, Decimal
from typing import Any, cast
from uuid import uuid4

from alpaca.common.exceptions import APIError
from alpaca.data.historical import OptionHistoricalDataClient, StockHistoricalDataClient
from alpaca.data.requests import OptionLatestQuoteRequest, StockLatestQuoteRequest
from alpaca.trading.client import TradingClient
from alpaca.trading.enums import (
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
    GetOptionContractsRequest,
    GetOrdersRequest,
    LimitOrderRequest,
    MarketOrderRequest,
)

if __package__:
    from . import config, db
    from .schema import Questions
else:
    import config
    import db
    from schema import Questions

TERMINAL = {"filled", "canceled", "expired", "rejected", "replaced"}
TYPESAFE_URL = "https://api.typesafe.ai/v1/systemone"


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


class PaperTrader:
    def __init__(
        self,
        capital: float = 100_000,
        max_wallet_position_pct: float = 0.75,
        risk_appetite: str = "balanced",
    ) -> None:
        self.lock = threading.RLock()
        self.starting_cash = positive(capital, "Strategy budget")
        self.max_wallet_position_pct = max_wallet_position_pct
        self.risk_appetite = risk_appetite
        self.api_key = os.getenv("TYPESAFE_API_KEY") or os.getenv("TYPESAFE_AI_API_KEY", "")
        self.enabled = False
        self.selected_symbol = config.SUPPORTED_SYMBOLS[0]
        self.generation = 0
        self.pending: queue.Queue = queue.Queue(maxsize=5)
        self.client = None
        self.stock_data = None
        self.option_data = None
        self.instruments: dict[str, dict[str, Any]] = {}
        self.positions: dict[str, dict[str, Any]] = {}
        self.account: dict[str, Any] = {}
        self.recent_logs: list[dict[str, Any]] = []
        self.broker_status = "starting"
        self.broker_error: str | None = None
        self.synced_at = 0.0
        self.started = False
        db.init_db()
        self.orders = {o["client_order_id"]: o for o in db.get_orders()}
        self.exits = db.get_exits()

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
        for symbol in config.SUPPORTED_SYMBOLS:
            if symbol in config.OPTION_SYMBOLS:
                contract = cast(OptionContract, self.client.get_option_contract(symbol))
                self.instruments[symbol] = {
                    "asset_class": "us_option",
                    "multiplier": positive(contract.size, "Contract size"),
                    "tradable": contract.tradable and contract.status == AssetStatus.ACTIVE,
                    "fractionable": False,
                    "expiration": str(contract.expiration_date),
                }
            else:
                asset = cast(Asset, self.client.get_asset(symbol))
                self.instruments[symbol] = {
                    "asset_class": "us_equity",
                    "multiplier": 1,
                    "tradable": asset.tradable and asset.status == AssetStatus.ACTIVE,
                    "fractionable": asset.fractionable,
                    "expiration": None,
                }

    def _poll(self) -> None:
        while True:
            try:
                with self.lock:
                    if self.client is None or len(self.instruments) != len(
                        config.SUPPORTED_SYMBOLS
                    ):
                        self._connect()
                    self.refresh()
            except Exception as error:
                with self.lock:
                    self.broker_status = "unavailable"
                    self.broker_error = str(error)
            time.sleep(3)

    def _record_order(self, order: Any) -> dict[str, Any]:
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
        }
        # Attach exit targets only to an actual (possibly partial) buy fill.
        if (
            record["side"] == "buy"
            and record["filled_qty"] > 0
            and "targets" in previous
            and not previous.get("targets_applied")
        ):
            self.exits[order.symbol] = previous["targets"]
            db.save_exits(order.symbol, previous["targets"])
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
        }
        self.synced_at = time.time()
        self.broker_status, self.broker_error = "connected", None

    def configure(
        self, capital=None, max_wallet_position_pct=None, risk_appetite=None, api_key=None
    ) -> None:
        with self.lock:
            if capital is not None:
                self.starting_cash = positive(capital, "Strategy budget")
            if max_wallet_position_pct is not None:
                pct = positive(max_wallet_position_pct, "Max position fraction")
                if pct > 1:
                    raise ValueError("Max position fraction cannot exceed 1")
                self.max_wallet_position_pct = pct
            if risk_appetite is not None:
                if risk_appetite not in {"conservative", "balanced", "aggressive"}:
                    raise ValueError("Invalid risk appetite")
                self.risk_appetite = risk_appetite
            if api_key:
                self.api_key = api_key.strip()
            self.generation += 1

    def set_enabled(self, enabled: bool, symbol: str) -> None:
        with self.lock:
            if symbol not in config.SUPPORTED_SYMBOLS:
                raise ValueError("Symbol is not configured")
            if enabled:
                self._ready()
                if not self.api_key:
                    raise ValueError("Set a TypeSafe API key before enabling automation")
            self.enabled, self.selected_symbol = enabled, symbol
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
                        **self.account,
                        "starting_cash": self.starting_cash,
                        "positions": self.positions,
                        "max_wallet_position_pct": self.max_wallet_position_pct,
                        "risk_appetite": self.risk_appetite,
                        "paper_trading": True,
                    },
                    "agent_log": self.recent_logs[-15:],
                    "positions": trades[:100],
                    "orders": orders[:100],
                    "agent_enabled": bool(self.api_key),
                    "broker_status": self.broker_status,
                    "broker_error": self.broker_error,
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
        if symbol in config.OPTION_SYMBOLS:
            if self.option_data is None:
                raise ValueError("Option data client is unavailable")
            quotes = self.option_data.get_option_latest_quote(
                OptionLatestQuoteRequest(symbol_or_symbols=symbol, feed=config.OPTION_FEED)
            )
        else:
            if self.stock_data is None:
                raise ValueError("Stock data client is unavailable")
            quotes = self.stock_data.get_stock_latest_quote(
                StockLatestQuoteRequest(symbol_or_symbols=symbol, feed=config.STOCK_FEED)
            )
        quote = quotes[symbol]
        age = (datetime.now(timezone.utc) - quote.timestamp).total_seconds()
        if not -5 <= age <= 30:
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
        if symbol in config.OPTION_SYMBOLS:
            capacity = min(capacity, self.account["options_buying_power"])
        return max(0, capacity)

    def _order(
        self,
        symbol: str,
        side: str,
        quantity=None,
        amount_usd=None,
        pct_of_position=1.0,
        limit_price=None,
        source="manual",
        targets=None,
    ) -> dict[str, Any]:
        with self.lock:
            self._ready()
            if symbol not in config.SUPPORTED_SYMBOLS:
                raise ValueError("Symbol is not configured")
            self.refresh()
            client = self._ready()
            if self._open_orders(symbol):
                raise ValueError("An open or unresolved order already exists for this symbol")
            instrument = self.instruments[symbol]
            if not instrument["tradable"]:
                raise ValueError("Asset is not tradable")
            if not cast(Clock, client.get_clock()).is_open:
                raise ValueError("Regular market session is closed")
            option = symbol in config.OPTION_SYMBOLS
            if option and side == "buy" and self.account["options_trading_level"] < 2:
                raise ValueError("Long options require Alpaca options trading level 2")
            quote = self._quote(symbol, side)
            limit = (
                positive(limit_price, "Limit price")
                if limit_price is not None
                else round(quote, 2)
                if option
                else None
            )
            if limit is not None:
                positive(limit, "Limit price")
            price = limit if limit is not None else quote
            multiplier = instrument["multiplier"]
            held = self.positions.get(symbol, {})
            if quantity is not None:
                quantity = positive(quantity, "Quantity")
                if option and not quantity.is_integer():
                    raise ValueError("Options require whole contracts")
            if side == "buy":
                if quantity is not None and amount_usd is not None:
                    raise ValueError("Specify quantity or amount_usd, not both")
                available = self._buying_capacity(symbol)
                allocation = (
                    positive(amount_usd, "Amount") if amount_usd is not None else available * 0.5
                )
                if quantity is None:
                    if allocation > available:
                        raise ValueError("Amount exceeds available cash or position budget")
                    quantity = rounded_quantity(
                        allocation / (price * multiplier), option or not instrument["fractionable"]
                    )
                if quantity * price * multiplier > available + 1e-8:
                    raise ValueError("Order exceeds available cash or position budget")
            else:
                available = max(0, min(held.get("quantity", 0), held.get("available_quantity", 0)))
                if quantity is None:
                    fraction = positive(pct_of_position, "Position fraction")
                    if fraction > 1:
                        raise ValueError("Position fraction cannot exceed 1")
                    quantity = rounded_quantity(available * fraction, option)
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
                time_in_force=TimeInForce.DAY,
                client_order_id=client_id,
                position_intent=PositionIntent.BUY_TO_OPEN
                if side == "buy"
                else PositionIntent.SELL_TO_CLOSE,
            )
            request = (
                LimitOrderRequest(**args, limit_price=limit)
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
        source="manual",
    ):
        with self.lock:
            targets = self._targets(
                positive(price, "Reference price"),
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
        source="manual",
    ):
        return self._order(
            symbol,
            "sell",
            quantity=quantity,
            pct_of_position=pct_of_position,
            limit_price=limit_price,
            source=source,
        )

    def cancel_order(self, order_id: str) -> dict[str, Any]:
        with self.lock:
            client = self._ready()
            client.cancel_order_by_id(order_id)
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
            targets = self._targets(position["average_entry_price"], **values)
            db.save_exits(symbol, targets)
            self.exits[symbol] = targets
            self.positions[symbol].update(targets)
            return targets

    def check_tp_sl(self, symbol, current_price, timeframe="1m"):
        with self.lock:
            if symbol not in config.SUPPORTED_SYMBOLS or symbol not in self.positions:
                return None
            targets = self.exits.get(symbol, {})
            sl, tp = targets.get("stop_loss_price"), targets.get("take_profit_price")
            reason = (
                "stop_loss"
                if sl and current_price <= sl
                else "take_profit"
                if tp and current_price >= tp
                else None
            )
            if reason:
                self._ready()
                # The fresh executable-side quote must also cross the target.
                bid = self._quote(symbol, "sell")
                if (reason == "stop_loss" and sl is not None and bid <= sl) or (
                    reason == "take_profit" and tp is not None and bid >= tp
                ):
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

    def submit(self, state: dict[str, Any]) -> None:
        with self.lock:
            if (
                not state
                or not self.enabled
                or state["symbol"] != self.selected_symbol
                or not self.api_key
            ):
                return
            try:
                self.pending.put_nowait((self.generation, time.time(), deepcopy(state)))
            except queue.Full:
                pass

    def _run(self) -> None:
        while True:
            generation, submitted_at, state = self.pending.get()
            try:
                with self.lock:
                    if (
                        generation != self.generation
                        or not self.enabled
                        or time.time() - submitted_at > 120
                    ):
                        continue
                body = json.dumps(
                    {"state": state, "model": "jev-latest", "questions": Questions}
                ).encode()
                request = urllib.request.Request(
                    TYPESAFE_URL,
                    data=body,
                    headers={
                        "Authorization": f"Bearer {self.api_key}",
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
                    event = self._apply_decision(state, result)
            except Exception as error:
                event = {
                    "timestamp": time.time(),
                    "action": "error",
                    "executed": "hold",
                    "confidence": None,
                    "error": str(error),
                }
            finally:
                self.pending.task_done()
            db.log_decision(event)
            with self.lock:
                self.recent_logs = (self.recent_logs + [event])[-15:]

    def _apply_decision(self, state: dict[str, Any], response: dict[str, Any]) -> dict[str, Any]:
        self._ready()
        answers = response.get("answers", {})
        answer = answers.get("action_choice", {})
        action, confidence = answer.get("choice", "hold"), float(answer.get("confidence", 0))
        threshold = {"conservative": 0.75, "balanced": 0.6, "aggressive": 0.5}[self.risk_appetite]
        event = {
            "timestamp": time.time(),
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
            risk = {"conservative": 0.5, "balanced": 0.75, "aggressive": 1.0}[self.risk_appetite]
            sl_choice = answers.get("stop_loss_target", {}).get("choice", "moderate")
            tp_choice = answers.get("take_profit_target", {}).get("choice", "balanced")
            sl_mult = {"conservative": 0.8, "balanced": 1.0, "aggressive": 1.3}[self.risk_appetite]
            tp_mult = {"conservative": 0.9, "balanced": 1.0, "aggressive": 1.2}[self.risk_appetite]
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
