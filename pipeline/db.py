import sqlite3
import json
import time
from pathlib import Path
from typing import Any, Dict, List, Optional

DB_PATH = Path(__file__).parent / "jev_trades.db"

def get_connection() -> sqlite3.Connection:
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")
    return conn

def init_db(starting_cash: float = 100000.0) -> None:
    with get_connection() as conn:
        conn.execute("""
            CREATE TABLE IF NOT EXISTS trades (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                symbol TEXT NOT NULL,
                timeframe TEXT NOT NULL,
                side TEXT NOT NULL,
                qty REAL NOT NULL,
                price REAL NOT NULL,
                fee REAL NOT NULL,
                source TEXT NOT NULL,
                realized_pnl REAL,
                executed_at REAL NOT NULL
            )
        """)
        conn.execute("""
            CREATE TABLE IF NOT EXISTS positions (
                symbol TEXT NOT NULL,
                timeframe TEXT NOT NULL,
                qty REAL NOT NULL,
                avg_entry_price REAL NOT NULL,
                updated_at REAL NOT NULL,
                tp_price REAL,
                sl_price REAL,
                tp_sl_source TEXT,
                PRIMARY KEY (symbol, timeframe)
            )
        """)
        conn.execute("""
            CREATE TABLE IF NOT EXISTS account_ledger (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                timestamp REAL NOT NULL,
                cash_balance REAL NOT NULL,
                equity REAL NOT NULL,
                event_type TEXT NOT NULL,
                trade_id INTEGER,
                FOREIGN KEY(trade_id) REFERENCES trades(id)
            )
        """)
        conn.execute("""
            CREATE TABLE IF NOT EXISTS agent_decisions (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                symbol TEXT NOT NULL,
                timeframe TEXT NOT NULL,
                timestamp REAL NOT NULL,
                answers_json TEXT NOT NULL,
                confidence REAL NOT NULL,
                executed BOOLEAN NOT NULL,
                reason TEXT
            )
        """)
        
        # Initialize ledger if empty
        cur = conn.execute("SELECT COUNT(*) FROM account_ledger")
        if cur.fetchone()[0] == 0:
            conn.execute(
                "INSERT INTO account_ledger (timestamp, cash_balance, equity, event_type) VALUES (?, ?, ?, ?)",
                (time.time(), starting_cash, starting_cash, "initialization")
            )

def execute_trade(
    symbol: str, 
    timeframe: str, 
    side: str, 
    qty: float, 
    price: float, 
    fee: float, 
    source: str,
    current_prices: Dict[str, float],
    tp_price: Optional[float] = None,
    sl_price: Optional[float] = None,
    tp_sl_source: Optional[str] = None
) -> Dict[str, Any]:
    """
    Executes a trade, mutates positions, updates cash balance, and logs to ledger.
    """
    with get_connection() as conn:
        cur = conn.cursor()
        
        # 1. Fetch current cash balance
        cur.execute("SELECT cash_balance FROM account_ledger ORDER BY id DESC LIMIT 1")
        row = cur.fetchone()
        cash_balance = row["cash_balance"] if row else 0.0
        
        # 2. Fetch existing position
        cur.execute("SELECT qty, avg_entry_price, tp_price, sl_price, tp_sl_source FROM positions WHERE symbol = ? AND timeframe = ?", (symbol, timeframe))
        pos_row = cur.fetchone()
        
        existing_qty = pos_row["qty"] if pos_row else 0.0
        avg_entry_price = pos_row["avg_entry_price"] if pos_row else 0.0
        
        realized_pnl = None
        
        if side == "buy":
            # Cash goes down
            cost = (qty * price) + fee
            if cash_balance < cost:
                raise ValueError(f"Insufficient cash. Have {cash_balance}, need {cost}")
            
            cash_balance -= cost
            
            # Position goes up
            total_qty = existing_qty + qty
            new_avg_entry_price = ((existing_qty * avg_entry_price) + (qty * price)) / total_qty
            
            # Keep existing TP/SL if not provided
            final_tp = tp_price if tp_price is not None else (pos_row["tp_price"] if pos_row else None)
            final_sl = sl_price if sl_price is not None else (pos_row["sl_price"] if pos_row else None)
            final_tp_sl_source = tp_sl_source if tp_sl_source is not None else (pos_row["tp_sl_source"] if pos_row else None)

            cur.execute("""
                INSERT INTO positions (symbol, timeframe, qty, avg_entry_price, updated_at, tp_price, sl_price, tp_sl_source)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(symbol, timeframe) DO UPDATE SET
                    qty = excluded.qty,
                    avg_entry_price = excluded.avg_entry_price,
                    updated_at = excluded.updated_at,
                    tp_price = excluded.tp_price,
                    sl_price = excluded.sl_price,
                    tp_sl_source = excluded.tp_sl_source
            """, (symbol, timeframe, total_qty, new_avg_entry_price, time.time(), final_tp, final_sl, final_tp_sl_source))
            
        elif side == "sell":
            if existing_qty < qty - 1e-12: # Tolerance
                raise ValueError(f"Insufficient position. Have {existing_qty}, want to sell {qty}")
            
            # Cash goes up
            proceeds = (qty * price) - fee
            cash_balance += proceeds
            
            # Realized PNL
            realized_pnl = (price - avg_entry_price) * qty - fee
            
            # Position goes down
            new_qty = existing_qty - qty
            if new_qty <= 1e-12:
                cur.execute("DELETE FROM positions WHERE symbol = ? AND timeframe = ?", (symbol, timeframe))
            else:
                cur.execute("""
                    UPDATE positions SET qty = ?, updated_at = ? WHERE symbol = ? AND timeframe = ?
                """, (new_qty, time.time(), symbol, timeframe))
        else:
            raise ValueError(f"Invalid side: {side}")
            
        # 3. Record Trade
        executed_at = time.time()
        cur.execute("""
            INSERT INTO trades (symbol, timeframe, side, qty, price, fee, source, realized_pnl, executed_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        """, (symbol, timeframe, side, qty, price, fee, source, realized_pnl, executed_at))
        trade_id = cur.lastrowid
        
        # 4. Calculate Equity Snapshot
        # Equity = cash + value of all open positions
        cur.execute("SELECT symbol, timeframe, qty FROM positions")
        all_positions = cur.fetchall()
        equity = cash_balance
        for p in all_positions:
            slot_key = f"{p['symbol']}:{p['timeframe']}"
            p_price = current_prices.get(slot_key, current_prices.get(p['symbol'], price)) # fallback
            equity += p['qty'] * p_price
            
        # 5. Insert into Ledger
        cur.execute("""
            INSERT INTO account_ledger (timestamp, cash_balance, equity, event_type, trade_id)
            VALUES (?, ?, ?, ?, ?)
        """, (executed_at, cash_balance, equity, f"{source}_{side}", trade_id))
        
        conn.commit()
        
        return {
            "id": trade_id,
            "symbol": symbol,
            "timeframe": timeframe,
            "side": side,
            "qty": qty,
            "price": price,
            "fee": fee,
            "source": source,
            "realized_pnl": realized_pnl,
            "executed_at": executed_at
        }

def log_decision(symbol: str, timeframe: str, answers: Dict[str, Any], confidence: float, executed: bool, reason: str = "") -> None:
    with get_connection() as conn:
        conn.execute("""
            INSERT INTO agent_decisions (symbol, timeframe, timestamp, answers_json, confidence, executed, reason)
            VALUES (?, ?, ?, ?, ?, ?, ?)
        """, (symbol, timeframe, time.time(), json.dumps(answers), confidence, executed, reason))

def get_cash_balance() -> float:
    with get_connection() as conn:
        cur = conn.execute("SELECT cash_balance FROM account_ledger ORDER BY id DESC LIMIT 1")
        row = cur.fetchone()
        return row["cash_balance"] if row else 0.0

def get_positions() -> List[Dict[str, Any]]:
    with get_connection() as conn:
        cur = conn.execute("SELECT symbol, timeframe, qty, avg_entry_price, updated_at, tp_price, sl_price, tp_sl_source FROM positions")
        return [dict(row) for row in cur.fetchall()]

def get_trades(limit: int = 100) -> List[Dict[str, Any]]:
    with get_connection() as conn:
        cur = conn.execute("SELECT * FROM trades ORDER BY executed_at DESC LIMIT ?", (limit,))
        return [dict(row) for row in cur.fetchall()]

def get_ledger(limit: int = 100) -> List[Dict[str, Any]]:
    with get_connection() as conn:
        cur = conn.execute("SELECT * FROM account_ledger ORDER BY timestamp DESC LIMIT ?", (limit,))
        return [dict(row) for row in cur.fetchall()]

def get_position(symbol: str, timeframe: str) -> Optional[Dict[str, Any]]:
    with get_connection() as conn:
        cur = conn.execute("SELECT symbol, timeframe, qty, avg_entry_price, updated_at, tp_price, sl_price, tp_sl_source FROM positions WHERE symbol = ? AND timeframe = ?", (symbol, timeframe))
        row = cur.fetchone()
        return dict(row) if row else None

def update_tp_sl_in_db(symbol: str, timeframe: str, tp_price: Optional[float], sl_price: Optional[float], tp_sl_source: str) -> None:
    with get_connection() as conn:
        conn.execute("""
            UPDATE positions 
            SET tp_price = ?, sl_price = ?, tp_sl_source = ?, updated_at = ?
            WHERE symbol = ? AND timeframe = ?
        """, (tp_price, sl_price, tp_sl_source, time.time(), symbol, timeframe))
        conn.commit()

def adjust_capital(diff: float) -> None:
    with get_connection() as conn:
        cur = conn.cursor()
        cur.execute("SELECT cash_balance, equity FROM account_ledger ORDER BY id DESC LIMIT 1")
        row = cur.fetchone()
        if not row:
            return
        
        new_cash = row["cash_balance"] + diff
        new_equity = row["equity"] + diff
        
        cur.execute("""
            INSERT INTO account_ledger (timestamp, cash_balance, equity, event_type)
            VALUES (?, ?, ?, ?)
        """, (time.time(), new_cash, new_equity, "capital_adjustment"))
        conn.commit()

