"""Offline behavioral checks: no credentials, network, or real broker orders."""

import os
import tempfile
import time
import unittest
from datetime import datetime, timezone
from pathlib import Path
from types import SimpleNamespace as Model
from typing import cast
from unittest.mock import patch
from uuid import uuid4

from alpaca.data.historical import OptionHistoricalDataClient, StockHistoricalDataClient
from alpaca.data.models import Quote
from alpaca.trading.client import TradingClient
from alpaca.trading.enums import AssetClass, OrderStatus, PositionIntent

with patch.dict(os.environ, {}, clear=True), patch("dotenv.load_dotenv"):
    from pipeline import config, db
    from pipeline.paper_trader import PaperTrader

OPTION = "SPY271217C00600000"


class Broker:
    """Controlled broker boundary: acceptance and fills are separate transitions."""

    def __init__(self):
        self.orders = []
        self.positions = []
        self.cash = 100000.0
        self.fail = False
        self.requests = []

    def get_account(self):
        return Model(
            cash=str(self.cash),
            equity="100000",
            buying_power=str(self.cash),
            options_buying_power=str(self.cash),
            options_trading_level=2,
            trading_blocked=False,
            account_blocked=False,
        )

    def get_orders(self, request):
        return list(self.orders)

    def get_all_positions(self):
        return list(self.positions)

    def get_clock(self):
        return Model(is_open=True)

    def submit_order(self, request):
        self.requests.append(request)
        order = Model(
            id=uuid4(),
            client_order_id=request.client_order_id,
            symbol=request.symbol,
            side=request.side,
            qty=str(request.qty),
            filled_qty="0",
            filled_avg_price=None,
            status=OrderStatus.ACCEPTED,
            created_at=datetime.now(timezone.utc),
            submitted_at=datetime.now(timezone.utc),
            filled_at=None,
        )
        self.orders.append(order)
        if self.fail:
            raise TimeoutError("Response lost after broker accepted")
        return order

    def fill(self, order, qty, price):
        order.filled_qty = str(qty)
        order.filled_avg_price = str(price)
        order.status = (
            OrderStatus.FILLED if qty == float(order.qty) else OrderStatus.PARTIALLY_FILLED
        )
        order.filled_at = datetime.now(timezone.utc)
        self.cash = 100000 - qty * price * 100
        self.positions = [
            Model(
                symbol=order.symbol,
                qty=str(qty),
                qty_available=str(qty),
                avg_entry_price=str(price),
                current_price="2",
                market_value=str(qty * 200),
                unrealized_pl=str(qty * (2 - price) * 100),
                unrealized_plpc=str(2 / price - 1),
                asset_class=AssetClass.US_OPTION,
            )
        ]

    def cancel_order_by_id(self, order_id):
        next(o for o in self.orders if str(o.id) == order_id).status = OrderStatus.CANCELED


class Quotes:
    def __init__(self):
        self.timestamp = datetime.now(timezone.utc)
        self.bid, self.ask = 1.99, 2.0

    def get_option_latest_quote(self, request):
        return {
            OPTION: Quote(
                OPTION, {"t": self.timestamp, "bp": self.bid, "ap": self.ask, "bs": 10, "as": 10}
            )
        }

    def get_stock_latest_quote(self, request):
        return {
            "SPY": Quote("SPY", {"t": self.timestamp, "bp": 599, "ap": 600, "bs": 10, "as": 10})
        }


class PaperLifecycle(unittest.TestCase):
    def test_broker_fills_contract_sizing_restart_and_ambiguous_submission(self):
        with (
            tempfile.TemporaryDirectory() as directory,
            patch.object(db, "DB_PATH", Path(directory) / "paper.db"),
            patch.object(config, "SUPPORTED_SYMBOLS", ("SPY", OPTION)),
            patch.object(config, "OPTION_SYMBOLS", (OPTION,)),
        ):
            broker, quotes = Broker(), Quotes()

            def connect():
                trader = PaperTrader()
                trader.client = cast(TradingClient, broker)
                trader.stock_data = cast(StockHistoricalDataClient, quotes)
                trader.option_data = cast(OptionHistoricalDataClient, quotes)
                trader.instruments = {
                    OPTION: {
                        "multiplier": 100,
                        "tradable": True,
                        "fractionable": False,
                        "asset_class": "us_option",
                    },
                    "SPY": {
                        "multiplier": 1,
                        "tradable": True,
                        "fractionable": True,
                        "asset_class": "us_equity",
                    },
                }
                trader.refresh()
                return trader

            trader = connect()
            accepted = trader.manual_buy(OPTION, 2, amount_usd=650, stop_loss_pct=5)
            self.assertEqual(
                (accepted["quantity"], accepted["filled_qty"], accepted["status"]),
                (3, 0, "accepted"),
            )
            self.assertEqual(trader.snapshot()["account"]["cash_balance"], 100000)
            self.assertEqual(trader.snapshot()["account"]["positions"], {})
            self.assertEqual(broker.requests[-1].position_intent, PositionIntent.BUY_TO_OPEN)
            self.assertEqual(broker.requests[-1].limit_price, 2)
            with self.assertRaisesRegex(ValueError, "open or unresolved"):
                trader.manual_buy(OPTION, 2, quantity=1)
            trader.configure(capital=1000)
            with self.assertRaisesRegex(ValueError, "budget"):
                trader.manual_buy("SPY", 600, quantity=1)
            trader.configure(capital=100000)
            broker.fill(broker.orders[0], 1, 1.9)
            trader.refresh()
            p = trader.snapshot()["account"]["positions"][OPTION]
            self.assertEqual(
                (p["quantity"], p["market_value"], p["stop_loss_price"]), (1, 200, 1.9)
            )
            self.assertAlmostEqual(p["unrealized_pnl"], 10)
            self.assertEqual(trader.snapshot()["positions"][0]["quantity"], 1)
            trader = connect()
            self.assertEqual(trader.positions[OPTION]["quantity"], 1)
            self.assertEqual(trader.positions[OPTION]["stop_loss_price"], 1.9)
            broker.fill(broker.orders[0], 3, 1.95)
            trader.refresh()
            with self.assertRaisesRegex(ValueError, "whole contracts"):
                trader.manual_sell(OPTION, 2, quantity=0.5)
            with self.assertRaisesRegex(ValueError, "Sell exceeds"):
                trader.manual_sell(OPTION, 2, quantity=4)
            sell = trader.manual_sell(OPTION, 2, pct_of_position=0.5)
            self.assertEqual(sell["quantity"], 1)
            self.assertEqual(broker.requests[-1].position_intent, PositionIntent.SELL_TO_CLOSE)
            self.assertEqual(trader.positions[OPTION]["quantity"], 3)
            trader.cancel_order(sell["id"])
            trader.refresh()
            self.assertEqual(trader.orders[sell["client_order_id"]]["status"], "canceled")
            with self.assertRaisesRegex(ValueError, "budget"):
                trader.manual_buy(OPTION, 2, quantity=1000)
            trader.configure(capital=1000)
            with self.assertRaisesRegex(ValueError, "budget"):
                trader.manual_buy("SPY", 600, quantity=1)
            trader.configure(capital=100000)
            for invalid in [float("nan"), float("inf"), -1, 0, True]:
                with self.assertRaises(ValueError):
                    trader.manual_buy("SPY", 600, quantity=invalid)
            quotes.timestamp = datetime.fromtimestamp(time.time() - 60, timezone.utc)
            with self.assertRaisesRegex(ValueError, "stale"):
                trader.manual_buy("SPY", 600, quantity=1)
            quotes.timestamp = datetime.now(timezone.utc)
            broker.fail = True
            with self.assertRaises(TimeoutError):
                trader.manual_buy("SPY", 600, quantity=0.5)
            self.assertEqual(trader._open_orders("SPY")[0]["status"], "unknown")
            # Restart finds the accepted order by persisted client ID; it does not resubmit.
            trader = connect()
            self.assertEqual(trader._open_orders("SPY")[0]["status"], "accepted")
            before = len(broker.requests)
            with self.assertRaisesRegex(ValueError, "open or unresolved"):
                trader.manual_buy("SPY", 600, quantity=0.5)
            self.assertEqual(len(broker.requests), before)
            trader.api_key = "offline-test"
            trader.set_enabled(True, "SPY")
            trader.submit({"symbol": "SPY", "current_price": 600})
            generation, _, _ = trader.pending.get_nowait()
            trader.set_enabled(False, "SPY")
            self.assertNotEqual(generation, trader.generation)
            trader.submit({"symbol": "SPY", "current_price": 600})
            self.assertTrue(trader.pending.empty())

    def test_partial_buy_is_canceled_before_stop_exit_even_when_automation_paused(self):
        with (
            tempfile.TemporaryDirectory() as directory,
            patch.object(db, "DB_PATH", Path(directory) / "paper.db"),
            patch.object(config, "SUPPORTED_SYMBOLS", (OPTION,)),
            patch.object(config, "OPTION_SYMBOLS", (OPTION,)),
        ):
            trader, broker, quotes = PaperTrader(), Broker(), Quotes()
            trader.client = cast(TradingClient, broker)
            trader.option_data = cast(OptionHistoricalDataClient, quotes)
            trader.instruments = {
                OPTION: {"multiplier": 100, "tradable": True, "fractionable": False}
            }
            trader.refresh()
            trader.manual_buy(OPTION, 2, quantity=3, stop_loss_pct=5)
            broker.fill(broker.orders[0], 1, 1.95)
            trader.refresh()
            quotes.bid, quotes.ask = 1.8, 1.81
            self.assertFalse(trader.enabled)
            self.assertIsNone(trader.check_tp_sl(OPTION, 1.8))
            self.assertEqual(broker.orders[0].status, OrderStatus.CANCELED)
            self.assertEqual(len(broker.requests), 1)
            trader.refresh()
            exit_order = trader.check_tp_sl(OPTION, 1.8)
            assert exit_order is not None
            self.assertEqual((exit_order["side"], exit_order["quantity"]), ("sell", 1))
            trader.check_tp_sl(OPTION, 1.8)
            self.assertEqual(len(broker.requests), 2)

    def test_provider_bar_corrections_do_not_duplicate_volume_or_time_buckets(self):
        from alpaca.data.models import Bar

        with (
            tempfile.TemporaryDirectory() as directory,
            patch.object(db, "DB_PATH", Path(directory) / "paper.db"),
            patch.dict(os.environ, {"HOST": "127.0.0.1", "PORT": "8765"}),
        ):
            from pipeline import data_collector as feed

            with (
                patch.object(feed, "STATE", feed.MarketState()),
                patch.object(feed, "STORE_DIR", Path(directory) / "bars"),
            ):
                symbol = config.SUPPORTED_SYMBOLS[0]
                base = int(time.time() // 300) * 300 - 600

                def bar(offset, volume):
                    return Bar(
                        symbol,
                        {
                            "t": datetime.fromtimestamp(base + offset, timezone.utc),
                            "o": 10,
                            "h": 12,
                            "l": 9,
                            "c": 11,
                            "v": volume,
                            "n": 1,
                            "vw": 11,
                        },
                    )

                feed.merge_bars(symbol, [bar(60, 10), bar(120, 20), bar(300, 7)])
                feed.merge_bars(symbol, [bar(60, 5), bar(300, 7)])
                rows = feed.resample_bars(feed.STATE.markets[symbol]["bars"], "5m")
                self.assertEqual([r["time"] for r in rows], [base, base + 300])
                self.assertEqual([r["volume"] for r in rows], [25, 7])
                self.assertEqual(
                    (rows[0]["open"], rows[0]["high"], rows[0]["low"], rows[0]["close"]),
                    (10, 12, 9, 11),
                )


if __name__ == "__main__":
    unittest.main()
