"""Confidence-gated paper trading driven by TypeSafe structured judgments with TP/SL execution and manual controls."""

from __future__ import annotations

import json
import os
import queue
import threading
import time
import urllib.error
import urllib.request
from copy import deepcopy
from pathlib import Path
from typing import Any

def load_dotenv(path: Path) -> None:
    if not path.exists():
        return
    for line in path.read_text(encoding="utf-8").splitlines():
        key, separator, value = line.partition("=")
        if separator and key.strip() and key.strip() not in os.environ:
            os.environ[key.strip()] = value.strip().strip('"').strip("'")

try:
    from .schema import Questions
except ImportError:
    from schema import Questions

LOG_PATH = Path(__file__).with_name("agent_log.jsonl")
TYPESAFE_URL = "https://api.typesafe.ai/v1/systemone"
load_dotenv(Path(__file__).with_name(".env"))
if os.getenv("TYPESAFE_AI_API_KEY") and not os.getenv("TYPESAFE_API_KEY"):
    os.environ["TYPESAFE_API_KEY"] = os.environ["TYPESAFE_AI_API_KEY"]


class PaperTrader:
    def __init__(self, capital: float = 100_000.0, max_wallet_position_pct: float = 0.75, risk_appetite: str = "balanced") -> None:
        self.lock = threading.RLock()
        self.starting_cash = capital
        self.max_wallet_position_pct = max(0.01, min(max_wallet_position_pct, 1.0))
        self.risk_appetite = risk_appetite
        self.api_key = os.getenv("TYPESAFE_API_KEY", "")
        self.account: dict[str, Any] = {
            "starting_cash": capital,
            "cash_balance": capital,
            "positions": {},
            "last_action": "hold",
            "last_decision_at": None,
            "paper_trading": True,
        }
        self.recent_logs: list[dict[str, Any]] = []
        self.positions: list[dict[str, Any]] = []
        self.pending: queue.Queue[dict[str, Any]] = queue.Queue()
        self.worker = threading.Thread(target=self._run, daemon=True, name="typesafe-paper-trader")
        self.worker.start()

    def configure(self, capital: float | None = None, max_wallet_position_pct: float | None = None, risk_appetite: str | None = None, api_key: str | None = None) -> None:
        with self.lock:
            if api_key is not None and api_key.strip():
                self.api_key = api_key.strip()
            if capital is not None and not self.account["positions"]:
                self.starting_cash = max(0.0, capital)
                self.account["starting_cash"] = self.starting_cash
                self.account["cash_balance"] = self.starting_cash
            if max_wallet_position_pct is not None:
                self.max_wallet_position_pct = max(0.01, min(max_wallet_position_pct, 1.0))
            if risk_appetite in {"conservative", "balanced", "aggressive"}:
                self.risk_appetite = risk_appetite

    def submit(self, state: dict[str, Any]) -> None:
        if self.api_key:
            self.pending.put(deepcopy(state))

    def snapshot(self, price: float | None = None, symbol: str | None = None) -> dict[str, Any]:
        with self.lock:
            account = deepcopy(self.account)
            if price is not None and symbol and symbol in account["positions"]:
                position = account["positions"][symbol]
                position["mark_price"] = price
                entry = position["average_entry_price"]
                if entry > 0:
                    position["unrealized_pnl_pct"] = round(((price - entry) / entry) * 100, 4)
            positions = deepcopy(account["positions"])
            equity = account["cash_balance"] + sum(position["quantity"] * position["mark_price"] for position in positions.values())
            return {
                "account": {
                    **account,
                    "equity": equity,
                    "available_cash": account["cash_balance"],
                    "max_wallet_position_pct": self.max_wallet_position_pct,
                    "risk_appetite": self.risk_appetite,
                },
                "agent_log": list(self.recent_logs[-15:]),
                "positions": list(self.positions[-100:]),
                "agent_enabled": bool(self.api_key),
            }

    def check_tp_sl(self, symbol: str, current_price: float) -> dict[str, Any] | None:
        """Check if active position breached Stop Loss or Take Profit targets and execute exit."""
        if current_price <= 0:
            return None
        with self.lock:
            position = self.account["positions"].get(symbol)
            if not position or position["quantity"] <= 1e-12:
                return None

            position["mark_price"] = current_price
            entry_price = position["average_entry_price"]
            position["unrealized_pnl_pct"] = round(((current_price - entry_price) / entry_price) * 100, 4)

            sl_price = position.get("stop_loss_price")
            tp_price = position.get("take_profit_price")

            # Check Stop Loss
            if sl_price is not None and current_price <= sl_price:
                quantity = position["quantity"]
                proceeds = quantity * current_price
                realized_pnl = round((current_price - entry_price) * quantity, 4)
                self.account["cash_balance"] += proceeds
                del self.account["positions"][symbol]
                self.account["last_action"] = "stop_loss"
                self.account["last_decision_at"] = time.time()

                trade = {
                    "symbol": symbol,
                    "side": "sell",
                    "quantity": quantity,
                    "price": current_price,
                    "entry_price": entry_price,
                    "realized_pnl": realized_pnl,
                    "cash_balance": self.account["cash_balance"],
                    "timestamp": time.time(),
                    "reason": "stop_loss",
                    "tp": tp_price,
                    "sl": sl_price,
                    "is_manual": False,
                }
                event = {
                    "timestamp": time.time(),
                    "price": current_price,
                    "action": "stop_loss",
                    "confidence": 1.0,
                    "executed": "sell",
                    "reason": f"Stop Loss triggered at ${current_price:,.2f} (SL: ${sl_price:,.2f})",
                    "account": deepcopy(self.account),
                    "trade": trade,
                }
                self.positions.append(trade)
                self._write_log(event)
                return trade

            # Check Take Profit
            if tp_price is not None and current_price >= tp_price:
                quantity = position["quantity"]
                proceeds = quantity * current_price
                realized_pnl = round((current_price - entry_price) * quantity, 4)
                self.account["cash_balance"] += proceeds
                del self.account["positions"][symbol]
                self.account["last_action"] = "take_profit"
                self.account["last_decision_at"] = time.time()

                trade = {
                    "symbol": symbol,
                    "side": "sell",
                    "quantity": quantity,
                    "price": current_price,
                    "entry_price": entry_price,
                    "realized_pnl": realized_pnl,
                    "cash_balance": self.account["cash_balance"],
                    "timestamp": time.time(),
                    "reason": "take_profit",
                    "tp": tp_price,
                    "sl": sl_price,
                    "is_manual": False,
                }
                event = {
                    "timestamp": time.time(),
                    "price": current_price,
                    "action": "take_profit",
                    "confidence": 1.0,
                    "executed": "sell",
                    "reason": f"Take Profit triggered at ${current_price:,.2f} (TP: ${tp_price:,.2f})",
                    "account": deepcopy(self.account),
                    "trade": trade,
                }
                self.positions.append(trade)
                self._write_log(event)
                return trade

        return None

    def manual_buy(
        self,
        symbol: str,
        price: float,
        quantity: float | None = None,
        amount_usd: float | None = None,
        stop_loss_pct: float | None = None,
        stop_loss_price: float | None = None,
        take_profit_pct: float | None = None,
        take_profit_price: float | None = None,
    ) -> dict[str, Any]:
        """Execute a manual buy order with optional custom quantity, TP, and SL."""
        with self.lock:
            if price <= 0:
                raise ValueError("Invalid price for buy order")

            available = self.account["cash_balance"]
            if available <= 0:
                raise ValueError("Insufficient cash balance")

            if amount_usd is not None and amount_usd > 0:
                allocation = min(available, float(amount_usd))
                qty = allocation / price
            elif quantity is not None and quantity > 0:
                allocation = float(quantity) * price
                if allocation > available:
                    allocation = available
                    qty = allocation / price
                else:
                    qty = float(quantity)
            else:
                allocation = min(available, self.account["starting_cash"] * self.max_wallet_position_pct * 0.5)
                qty = allocation / price

            if qty <= 1e-12:
                raise ValueError("Order quantity is too small")

            sl_price: float | None = None
            sl_pct: float | None = None
            if stop_loss_price is not None and stop_loss_price > 0 and stop_loss_price < price:
                sl_price = round(stop_loss_price, 4)
                sl_pct = round(((price - sl_price) / price) * 100, 2)
            elif stop_loss_pct is not None and stop_loss_pct > 0:
                sl_pct = round(stop_loss_pct, 2)
                sl_price = round(price * (1.0 - sl_pct / 100.0), 4)

            tp_price: float | None = None
            tp_pct: float | None = None
            if take_profit_price is not None and take_profit_price > price:
                tp_price = round(take_profit_price, 4)
                tp_pct = round(((tp_price - price) / price) * 100, 2)
            elif take_profit_pct is not None and take_profit_pct > 0:
                tp_pct = round(take_profit_pct, 2)
                tp_price = round(price * (1.0 + take_profit_pct / 100.0), 4)

            self.account["cash_balance"] -= allocation
            existing = self.account["positions"].get(symbol)
            if existing:
                total_qty = existing["quantity"] + qty
                avg_entry = ((existing["quantity"] * existing["average_entry_price"]) + (qty * price)) / total_qty
                existing["quantity"] = total_qty
                existing["average_entry_price"] = avg_entry
                existing["mark_price"] = price
                existing["unrealized_pnl_pct"] = round(((price - avg_entry) / avg_entry) * 100, 4)
                if sl_price is not None:
                    existing["stop_loss_price"] = sl_price
                    existing["stop_loss_pct"] = sl_pct
                if tp_price is not None:
                    existing["take_profit_price"] = tp_price
                    existing["take_profit_pct"] = tp_pct
                existing["tp_sl_source"] = "manual"
            else:
                self.account["positions"][symbol] = {
                    "symbol": symbol,
                    "quantity": qty,
                    "average_entry_price": price,
                    "mark_price": price,
                    "unrealized_pnl_pct": 0.0,
                    "position": "Long",
                    "stop_loss_price": sl_price,
                    "take_profit_price": tp_price,
                    "stop_loss_pct": sl_pct,
                    "take_profit_pct": tp_pct,
                    "tp_sl_source": "manual",
                }

            self.account["last_action"] = "buy"
            self.account["last_decision_at"] = time.time()

            trade = {
                "symbol": symbol,
                "side": "buy",
                "quantity": qty,
                "price": price,
                "entry_price": price,
                "realized_pnl": None,
                "cash_balance": self.account["cash_balance"],
                "timestamp": time.time(),
                "reason": "manual_buy",
                "tp": tp_price,
                "sl": sl_price,
                "is_manual": True,
            }
            event = {
                "timestamp": time.time(),
                "price": price,
                "action": "buy",
                "confidence": 1.0,
                "executed": "buy",
                "reason": f"Manual Buy order executed for {qty:.6f} {symbol}",
                "account": deepcopy(self.account),
                "trade": trade,
            }
            self.positions.append(trade)
            self._write_log(event)
            return trade

    def manual_sell(self, symbol: str, price: float, quantity: float | None = None, pct_of_position: float = 1.0) -> dict[str, Any]:
        """Execute a manual sell / exit order for an active position."""
        with self.lock:
            if price <= 0:
                raise ValueError("Invalid price for sell order")

            position = self.account["positions"].get(symbol)
            if not position or position["quantity"] <= 1e-12:
                raise ValueError(f"No active position found for {symbol} to sell")

            current_qty = position["quantity"]
            if quantity is not None and quantity > 0:
                sell_qty = min(current_qty, float(quantity))
            else:
                pct = max(0.01, min(pct_of_position, 1.0))
                sell_qty = current_qty * pct

            if sell_qty <= 1e-12:
                raise ValueError("Sell quantity too small")

            entry_price = position["average_entry_price"]
            proceeds = sell_qty * price
            realized_pnl = round((price - entry_price) * sell_qty, 4)

            self.account["cash_balance"] += proceeds
            position["quantity"] -= sell_qty

            if position["quantity"] <= 1e-12:
                del self.account["positions"][symbol]
            else:
                position["mark_price"] = price
                position["unrealized_pnl_pct"] = round(((price - entry_price) / entry_price) * 100, 4)

            self.account["last_action"] = "sell"
            self.account["last_decision_at"] = time.time()

            trade = {
                "symbol": symbol,
                "side": "sell",
                "quantity": sell_qty,
                "price": price,
                "entry_price": entry_price,
                "realized_pnl": realized_pnl,
                "cash_balance": self.account["cash_balance"],
                "timestamp": time.time(),
                "reason": "manual_exit" if pct_of_position >= 0.999 else "manual_sell",
                "is_manual": True,
            }
            event = {
                "timestamp": time.time(),
                "price": price,
                "action": "sell",
                "confidence": 1.0,
                "executed": "sell",
                "reason": f"Manual Sell/Exit order executed for {sell_qty:.6f} {symbol}",
                "account": deepcopy(self.account),
                "trade": trade,
            }
            self.positions.append(trade)
            self._write_log(event)
            return trade

    def update_tp_sl(
        self,
        symbol: str,
        stop_loss_pct: float | None = None,
        stop_loss_price: float | None = None,
        take_profit_pct: float | None = None,
        take_profit_price: float | None = None,
    ) -> dict[str, Any]:
        """Update Take Profit and Stop Loss levels for an open position."""
        with self.lock:
            position = self.account["positions"].get(symbol)
            if not position:
                raise ValueError(f"No active position for {symbol}")

            entry = position["average_entry_price"]
            mark = position.get("mark_price", entry)
            ref_price = entry if entry > 0 else mark

            if stop_loss_price is not None:
                position["stop_loss_price"] = round(stop_loss_price, 4) if stop_loss_price > 0 else None
                position["stop_loss_pct"] = round(((ref_price - stop_loss_price) / ref_price) * 100, 2) if stop_loss_price > 0 else None
            elif stop_loss_pct is not None:
                if stop_loss_pct > 0:
                    position["stop_loss_pct"] = round(stop_loss_pct, 2)
                    position["stop_loss_price"] = round(ref_price * (1.0 - stop_loss_pct / 100.0), 4)
                else:
                    position["stop_loss_price"] = None
                    position["stop_loss_pct"] = None

            if take_profit_price is not None:
                position["take_profit_price"] = round(take_profit_price, 4) if take_profit_price > 0 else None
                position["take_profit_pct"] = round(((take_profit_price - ref_price) / ref_price) * 100, 2) if take_profit_price > 0 else None
            elif take_profit_pct is not None:
                if take_profit_pct > 0:
                    position["take_profit_pct"] = round(take_profit_pct, 2)
                    position["take_profit_price"] = round(ref_price * (1.0 + take_profit_pct / 100.0), 4)
                else:
                    position["take_profit_price"] = None
                    position["take_profit_pct"] = None

            position["tp_sl_source"] = "manual"
            return deepcopy(position)

    def _run(self) -> None:
        while True:
            state = self.pending.get()
            try:
                request_payload, response = self._ask_typesafe(state)
                event = self._apply_decision(state, response, request_payload)
            except Exception as error:
                event = self._event(state, "error", {"error": f"{type(error).__name__}: {error}"}, None, self._request_payload(state), {"error": f"{type(error).__name__}: {error}"})
            self._write_log(event)

    def _request_payload(self, state: dict[str, Any]) -> dict[str, Any]:
        return {"state": state, "model": "jev-latest", "questions": Questions}

    def _ask_typesafe(self, state: dict[str, Any]) -> tuple[dict[str, Any], dict[str, Any]]:
        payload = self._request_payload(state)
        body = json.dumps(payload).encode()
        request = urllib.request.Request(TYPESAFE_URL, data=body, headers={"Authorization": f"Bearer {self.api_key}", "Content-Type": "application/json"}, method="POST")
        with urllib.request.urlopen(request, timeout=15) as response:
            return payload, json.loads(response.read().decode())

    def _calculate_jev_tp_sl(self, price: float, answers: dict[str, Any]) -> tuple[float, float, float, float]:
        """Derive Stop Loss and Take Profit levels based on Jev's structured judgments and risk appetite."""
        sl_choice = answers.get("stop_loss_target", {}).get("choice", "moderate")
        tp_choice = answers.get("take_profit_target", {}).get("choice", "balanced")

        sl_map = {"tight": 1.5, "moderate": 3.0, "wide": 5.0}
        tp_map = {"conservative": 3.0, "balanced": 6.0, "aggressive": 10.0}

        base_sl_pct = sl_map.get(sl_choice, 3.0)
        base_tp_pct = tp_map.get(tp_choice, 6.0)

        risk_sl_mult = {"conservative": 0.8, "balanced": 1.0, "aggressive": 1.3}.get(self.risk_appetite, 1.0)
        risk_tp_mult = {"conservative": 0.9, "balanced": 1.0, "aggressive": 1.2}.get(self.risk_appetite, 1.0)

        sl_pct = round(base_sl_pct * risk_sl_mult, 2)
        tp_pct = round(base_tp_pct * risk_tp_mult, 2)

        sl_price = round(price * (1.0 - sl_pct / 100.0), 4)
        tp_price = round(price * (1.0 + tp_pct / 100.0), 4)

        return sl_price, tp_price, sl_pct, tp_pct

    def _apply_decision(self, state: dict[str, Any], response: dict[str, Any], request_payload: dict[str, Any]) -> dict[str, Any]:
        answers = response.get("answers", {})
        action_answer = answers.get("action_choice", {})
        action = action_answer.get("choice", "hold")
        confidence = float(action_answer.get("confidence", 0.0))
        price = float(state["current_price"])
        symbol = str(state["symbol"])
        executed = "hold"
        trade: dict[str, Any] | None = None
        with self.lock:
            position = self.account["positions"].get(symbol)
            threshold = {"conservative": 0.75, "balanced": 0.6, "aggressive": 0.5}[self.risk_appetite]
            if confidence >= threshold and action == "buy":
                size_score = float(answers.get("buying_quantity", {}).get("score", 0.0))
                fraction = 0.25 if size_score < 0.67 else 0.5 if size_score < 1.34 else 1.0
                risk_multiplier = {"conservative": 0.5, "balanced": 0.75, "aggressive": 1.0}[self.risk_appetite]
                allocation = min(self.account["cash_balance"], self.account["starting_cash"] * self.max_wallet_position_pct * risk_multiplier * fraction)
                quantity = allocation / price

                sl_price, tp_price, sl_pct, tp_pct = self._calculate_jev_tp_sl(price, answers)

                self.account["cash_balance"] -= allocation
                self.account["positions"][symbol] = {
                    "symbol": symbol,
                    "quantity": quantity,
                    "average_entry_price": price,
                    "mark_price": price,
                    "unrealized_pnl_pct": 0.0,
                    "position": "Long",
                    "stop_loss_price": sl_price,
                    "take_profit_price": tp_price,
                    "stop_loss_pct": sl_pct,
                    "take_profit_pct": tp_pct,
                    "tp_sl_source": "jev",
                }
                executed = "buy"
                trade = {
                    "symbol": symbol,
                    "side": "buy",
                    "quantity": quantity,
                    "price": price,
                    "entry_price": price,
                    "realized_pnl": None,
                    "cash_balance": self.account["cash_balance"],
                    "timestamp": time.time(),
                    "reason": "jev_buy",
                    "tp": tp_price,
                    "sl": sl_price,
                    "is_manual": False,
                }
            elif confidence >= threshold and action == "sell" and position and position["quantity"] > 0:
                size_score = float(answers.get("selling_quantity", {}).get("score", 0.0))
                fraction = 0.25 if size_score < 0.67 else 0.5 if size_score < 1.34 else 1.0
                quantity = position["quantity"] * fraction
                entry_price = position["average_entry_price"]
                proceeds = quantity * price
                self.account["cash_balance"] += proceeds
                position["quantity"] -= quantity
                if position["quantity"] <= 1e-12:
                    del self.account["positions"][symbol]
                executed = "sell"
                trade = {
                    "symbol": symbol,
                    "side": "sell",
                    "quantity": quantity,
                    "price": price,
                    "entry_price": entry_price,
                    "realized_pnl": round((price - entry_price) * quantity, 4),
                    "cash_balance": self.account["cash_balance"],
                    "timestamp": time.time(),
                    "reason": "jev_sell",
                    "is_manual": False,
                }
            elif position:
                position["mark_price"] = price
                position["unrealized_pnl_pct"] = round(((price - position["average_entry_price"]) / position["average_entry_price"]) * 100, 4)
            self.account["last_action"] = action
            self.account["last_decision_at"] = time.time()
        return self._event(state, executed, response, confidence, request_payload, response, trade)

    def _event(self, state: dict[str, Any], executed: str, response: dict[str, Any], confidence: float | None, request_payload: dict[str, Any], response_payload: dict[str, Any], trade: dict[str, Any] | None = None) -> dict[str, Any]:
        answers = response.get("answers", {}) if isinstance(response, dict) else response
        action = answers.get("action_choice", {}).get("choice", "hold") if isinstance(answers, dict) else "error"
        event = {"timestamp": time.time(), "price": state.get("current_price"), "action": action, "confidence": confidence, "executed": executed, "answers": answers, "account": self.snapshot().get("account"), "request": request_payload, "response": response_payload, "error": response.get("error") if isinstance(response, dict) else None}
        if trade:
            event["trade"] = trade
            self.positions.append(trade)
        return event

    def _write_log(self, event: dict[str, Any]) -> None:
        LOG_PATH.parent.mkdir(parents=True, exist_ok=True)
        with LOG_PATH.open("a", encoding="utf-8") as log_file:
            log_file.write(json.dumps(event, separators=(",", ":")) + "\n")
        with self.lock:
            self.recent_logs.append(event)
            self.recent_logs = self.recent_logs[-15:]
