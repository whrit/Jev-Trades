"""Confidence-gated paper trading driven by TypeSafe structured judgments."""

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
        self.lock = threading.Lock()
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
                position["unrealized_pnl_pct"] = round(((price - position["average_entry_price"]) / position["average_entry_price"]) * 100, 4)
            positions = deepcopy(account["positions"])
            equity = account["cash_balance"] + sum(position["quantity"] * position["mark_price"] for position in positions.values())
            return {"account": {**account, "equity": equity, "available_cash": account["cash_balance"], "max_wallet_position_pct": self.max_wallet_position_pct, "risk_appetite": self.risk_appetite}, "agent_log": list(self.recent_logs[-12:]), "positions": list(self.positions[-100:]), "agent_enabled": bool(self.api_key)}

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
                self.account["cash_balance"] -= allocation
                self.account["positions"][symbol] = {"symbol": symbol, "quantity": quantity, "average_entry_price": price, "mark_price": price, "unrealized_pnl_pct": 0.0, "position": "Long"}
                executed = "buy"
                trade = {"symbol": symbol, "side": "buy", "quantity": quantity, "price": price, "entry_price": price, "realized_pnl": None, "cash_balance": self.account["cash_balance"], "timestamp": time.time()}
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
                trade = {"symbol": symbol, "side": "sell", "quantity": quantity, "price": price, "entry_price": entry_price, "realized_pnl": round((price - entry_price) * quantity, 4), "cash_balance": self.account["cash_balance"], "timestamp": time.time()}
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
            self.recent_logs = self.recent_logs[-12:]
