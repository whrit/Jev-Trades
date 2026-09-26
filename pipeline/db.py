"""Local order intents and exit targets; Alpaca is the only account ledger.

The legacy jev_trades.db remains untouched and is never read as broker state.
"""

import json
import sqlite3
import time
from collections.abc import Iterator
from contextlib import closing, contextmanager
from pathlib import Path
from typing import Any

DB_PATH = Path(__file__).with_name("alpaca_paper.db")


@contextmanager
def get_connection() -> Iterator[sqlite3.Connection]:
    with closing(sqlite3.connect(DB_PATH)) as conn:
        conn.row_factory = sqlite3.Row
        conn.execute("PRAGMA journal_mode=WAL")
        with conn:
            yield conn


def init_db() -> None:
    with get_connection() as conn:
        conn.executescript("""
            CREATE TABLE IF NOT EXISTS orders (
                client_id TEXT PRIMARY KEY, symbol TEXT NOT NULL,
                status TEXT NOT NULL, payload TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS exits (
                symbol TEXT PRIMARY KEY, payload TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS decisions (
                timestamp REAL NOT NULL, payload TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS option_policy (
                id INTEGER PRIMARY KEY CHECK (id = 1), payload TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS trading_scope (
                id INTEGER PRIMARY KEY CHECK (id = 1), payload TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS crypto_policy (
                id INTEGER PRIMARY KEY CHECK (id = 1), payload TEXT NOT NULL
            );
        """)


def save_order(order: dict[str, Any]) -> None:
    with get_connection() as conn:
        conn.execute(
            "INSERT OR REPLACE INTO orders VALUES (?, ?, ?, ?)",
            (order["client_order_id"], order["symbol"], order["status"], json.dumps(order)),
        )


def get_orders() -> list[dict[str, Any]]:
    with get_connection() as conn:
        return [json.loads(row[0]) for row in conn.execute("SELECT payload FROM orders")]


def save_exits(symbol: str, targets: dict[str, Any]) -> None:
    with get_connection() as conn:
        conn.execute("INSERT OR REPLACE INTO exits VALUES (?, ?)", (symbol, json.dumps(targets)))


def get_exits() -> dict[str, dict[str, Any]]:
    with get_connection() as conn:
        return {
            row[0]: json.loads(row[1]) for row in conn.execute("SELECT symbol, payload FROM exits")
        }


def delete_exits(symbol: str) -> None:
    with get_connection() as conn:
        conn.execute("DELETE FROM exits WHERE symbol = ?", (symbol,))


def log_decision(event: dict[str, Any]) -> None:
    with get_connection() as conn:
        conn.execute("INSERT INTO decisions VALUES (?, ?)", (time.time(), json.dumps(event)))


def get_option_policy() -> dict[str, Any]:
    with get_connection() as conn:
        row = conn.execute("SELECT payload FROM option_policy WHERE id = 1").fetchone()
        return json.loads(row[0]) if row else {}


def get_trading_scope() -> dict[str, Any]:
    with get_connection() as conn:
        row = conn.execute("SELECT payload FROM trading_scope WHERE id = 1").fetchone()
        return json.loads(row[0]) if row else {}


def get_crypto_policy() -> dict[str, Any]:
    with get_connection() as conn:
        row = conn.execute("SELECT payload FROM crypto_policy WHERE id = 1").fetchone()
        return json.loads(row[0]) if row else {}


def save_configuration(
    policy: dict[str, Any] | None,
    scope: dict[str, Any] | None,
    crypto_policy: dict[str, Any] | None = None,
) -> None:
    with get_connection() as conn:
        if policy is not None:
            conn.execute(
                "INSERT OR REPLACE INTO option_policy VALUES (1, ?)", (json.dumps(policy),)
            )
        if scope is not None:
            conn.execute("INSERT OR REPLACE INTO trading_scope VALUES (1, ?)", (json.dumps(scope),))
        if crypto_policy is not None:
            conn.execute(
                "INSERT OR REPLACE INTO crypto_policy VALUES (1, ?)", (json.dumps(crypto_policy),)
            )
