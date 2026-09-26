"""Offline behavioral checks: no credentials, network, or real broker orders."""

import os
import tempfile
import time
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path
from types import SimpleNamespace as Model
from typing import cast
from unittest.mock import patch
from uuid import uuid4
from zoneinfo import ZoneInfo

from alpaca.data.enums import OptionsFeed
from alpaca.data.historical import OptionHistoricalDataClient, StockHistoricalDataClient
from alpaca.data.models import Quote
from alpaca.trading.client import TradingClient
from alpaca.trading.enums import AssetClass, AssetStatus, ContractType, OrderStatus, PositionIntent

with patch.dict(os.environ, {}, clear=True), patch("dotenv.load_dotenv"):
    from pipeline import config, db
    from pipeline.paper_trader import PaperTrader

TODAY = datetime.now(ZoneInfo("America/New_York")).date()
EXPIRATION = TODAY + timedelta(days=14)
OPTION = f"SPY{EXPIRATION:%y%m%d}C00600000"


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

    def get_asset(self, symbol):
        names = {
            "SPY": "SPDR S&P 500 ETF",
            "QQQ": "Invesco QQQ Trust",
            "AAPL": "Apple Inc.",
            "MSFT": "Microsoft Corporation",
            "NVDA": "NVIDIA Corporation",
            "BAD": "Untradable asset",
        }
        if symbol not in names:
            raise ValueError("Unknown asset")
        return Model(
            symbol=symbol,
            name=names[symbol],
            asset_class=AssetClass.US_EQUITY,
            status=AssetStatus.ACTIVE,
            tradable=symbol != "BAD",
            fractionable=True,
        )

    def get_all_assets(self, request):
        return [self.get_asset(symbol) for symbol in ("SPY", "QQQ", "AAPL", "MSFT", "NVDA", "BAD")]

    def get_option_contract(self, symbol):
        return Model(
            symbol=symbol,
            underlying_symbol="SPY",
            root_symbol="SPY",
            expiration_date=EXPIRATION,
            status=AssetStatus.ACTIVE,
            tradable=True,
            type=ContractType.CALL,
            strike_price=600.0,
            size="100",
            open_interest="1000",
            open_interest_date=TODAY,
        )

    def get_option_contracts(self, request):
        return Model(
            option_contracts=[self.get_option_contract(OPTION)]
            if request.type == ContractType.CALL
            else [],
            next_page_token=None,
        )

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
        delta = qty - float(order.filled_qty)
        order.filled_qty = str(qty)
        order.filled_avg_price = str(price)
        order.status = (
            OrderStatus.FILLED if qty == float(order.qty) else OrderStatus.PARTIALLY_FILLED
        )
        order.filled_at = datetime.now(timezone.utc)
        if order.side.value == "sell":
            position = next(p for p in self.positions if p.symbol == order.symbol)
            remaining = float(position.qty) - delta
            self.cash += delta * price * 100
            if remaining <= 0:
                self.positions.remove(position)
            else:
                position.qty = position.qty_available = str(remaining)
                position.market_value = str(remaining * float(position.current_price) * 100)
                position.unrealized_pl = str(
                    remaining
                    * (float(position.current_price) - float(position.avg_entry_price))
                    * 100
                )
            return
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

    def get_option_snapshot(self, request):
        return {
            OPTION: Model(
                latest_quote=self.get_option_latest_quote(request)[OPTION],
                greeks=None,
                implied_volatility=None,
            )
        }

    def get_stock_latest_quote(self, request):
        return {
            "SPY": Quote("SPY", {"t": self.timestamp, "bp": 599, "ap": 600, "bs": 10, "as": 10})
        }


class PaperLifecycle(unittest.TestCase):
    def test_scope_persistence_atomic_validation_and_independent_strategy_gates(self):
        with (
            tempfile.TemporaryDirectory() as directory,
            patch.object(db, "DB_PATH", Path(directory) / "paper.db"),
            patch.object(config, "OPTION_UNDERLYINGS", ("SPY",)),
        ):
            trader = PaperTrader()
            broker = Broker()
            trader.client = cast(TradingClient, broker)
            trader.refresh()
            trader.api_key = "offline-test"
            trader.configure(enabled=True)
            trader.submit({"symbol": "SPY"}, strategy="stock")
            old_generation, _, _ = trader.pending.get_nowait()
            trader.queued.clear()
            trader.configure(
                trading_scope={
                    "stock_enabled": False,
                    "option_underlyings": [" spy ", "QQQ", "SPY"],
                }
            )
            self.assertEqual(trader.scope.option_underlyings, ("SPY", "QQQ"))
            self.assertNotEqual(old_generation, trader.generation)
            trader.submit({"symbol": "SPY"}, strategy="stock")
            self.assertTrue(trader.pending.empty())
            trader.submit({"symbol": "QQQ"}, strategy="options")
            self.assertEqual(trader.pending.get_nowait()[2]["strategy"], "options")
            saved = db.get_trading_scope()
            generation = trader.generation
            with self.assertRaises(ValueError):
                trader.configure(
                    capital=1234,
                    option_policy={"max_contracts": 2},
                    trading_scope={"option_underlyings": ["BAD"]},
                )
            self.assertEqual(db.get_trading_scope(), saved)
            self.assertEqual(db.get_option_policy(), {})
            self.assertEqual((trader.starting_cash, trader.generation), (100000, generation))
            self.assertEqual(
                trader.search_assets("apple"), [{"symbol": "AAPL", "name": "Apple Inc."}]
            )
            self.assertEqual(trader.search_assets("untradable"), [])
            restarted = PaperTrader()
            self.assertEqual(restarted.scope, trader.scope)
            self.assertFalse(restarted.enabled)
            trader.configure(
                trading_scope={
                    "stock_symbols": [],
                    "stock_symbol": "",
                    "stock_enabled": False,
                    "option_underlyings": [],
                    "options_enabled": False,
                }
            )
            self.assertEqual(PaperTrader().scope.option_underlyings, ())
            trader.submit({"symbol": "SPY"}, strategy="options")
            self.assertTrue(trader.pending.empty())

    def test_rescan_retains_results_and_scope_change_discards_inflight_result(self):
        from pipeline import options

        with (
            tempfile.TemporaryDirectory() as directory,
            patch.object(db, "DB_PATH", Path(directory) / "paper.db"),
            patch.object(config, "OPTION_UNDERLYINGS", ("SPY",)),
        ):
            trader = PaperTrader()
            trader.client = cast(TradingClient, Broker())
            trader.option_data = cast(OptionHistoricalDataClient, Quotes())
            trader.refresh()
            previous = {
                "status": "ready",
                "eligible": 7,
                "discovered": 20,
                "candidates": [],
                "as_of": 100,
            }
            trader.option_scans["SPY"] = previous
            state = {
                "symbol": "SPY",
                "current_price": 600,
                "quote_time": time.time(),
                "bar_time": time.time() - 60,
            }
            with patch.object(
                options, "discover_candidates", side_effect=ValueError("Quote feed unavailable")
            ):
                self.assertEqual(trader._prepare_options(state)["candidates"], [])
            self.assertEqual(
                (trader.option_scans["SPY"]["eligible"], trader.option_scans["SPY"]["as_of"]),
                (7, 100),
            )
            self.assertEqual(trader.option_scans["SPY"]["status"], "blocked")

            def discover(*args, **kwargs):
                scan = trader.option_scans["SPY"]
                self.assertEqual(
                    (scan["status"], scan["eligible"], scan["as_of"]), ("scanning", 7, 100)
                )
                trader.configure(trading_scope={"option_underlyings": ["QQQ"]})
                return {"eligible": 2, "discovered": 3, "candidates": [], "as_of": time.time()}

            with patch.object(options, "discover_candidates", side_effect=discover):
                self.assertEqual(trader._prepare_options(state), {})
            self.assertNotIn("SPY", trader.option_scans)
            self.assertEqual(trader.scope.option_underlyings, ("QQQ",))

    def test_option_slots_deduplicate_partial_fills_and_reserve_shared_exposure(self):
        with (
            tempfile.TemporaryDirectory() as directory,
            patch.object(db, "DB_PATH", Path(directory) / "paper.db"),
        ):
            trader = PaperTrader(capital=10000)
            trader.account = {
                "equity": 10000,
                "cash_balance": 10000,
                "available_cash": 10000,
                "options_buying_power": 10000,
            }
            trader.configure(
                option_policy={
                    "max_trade_pct": 0.10,
                    "max_underlying_pct": 0.25,
                    "max_total_pct": 0.75,
                    "max_positions_per_underlying": 2,
                }
            )
            trader.instruments = {
                "A": {"asset_class": "us_option", "underlying": "SPY"},
                "B": {"asset_class": "us_option", "underlying": "SPY"},
                "C": {"asset_class": "us_option", "underlying": "AAPL"},
            }
            trader.positions = {"A": {"quantity": 1, "market_value": 400}}
            trader.orders = {
                "a": {
                    "symbol": "A",
                    "side": "buy",
                    "status": "partially_filled",
                    "quantity": 3,
                    "filled_qty": 1,
                    "estimated_price": 4,
                    "multiplier": 100,
                }
            }
            self.assertEqual(trader._option_capacity("SPY", "A"), 0)  # No pyramiding.
            self.assertEqual(
                trader._option_capacity("SPY", "B"), 1000
            )  # Partial + pending uses one slot.
            trader.orders["b"] = {
                "symbol": "B",
                "side": "buy",
                "status": "accepted",
                "quantity": 1,
                "filled_qty": 0,
                "estimated_price": 2,
                "multiplier": 100,
            }
            self.assertEqual(trader._option_capacity("SPY"), 0)
            self.assertEqual(trader._option_capacity("AAPL"), 1000)
            trader.configure(option_policy={"max_positions_per_underlying": 3})
            trader.positions["SPY"] = {"quantity": 1, "market_value": 800}
            self.assertEqual(trader._option_capacity("SPY"), 300)
            trader.orders["stock"] = {
                "symbol": "SPY",
                "side": "buy",
                "status": "accepted",
                "quantity": 1,
                "filled_qty": 0,
                "estimated_price": 100,
                "multiplier": 1,
            }
            self.assertEqual(trader._option_capacity("SPY"), 200)
            trader.orders["stock"]["status"] = "canceled"
            self.assertEqual(trader._option_capacity("SPY"), 300)
            trader.positions["C"] = {"quantity": 30, "market_value": 6000}
            self.assertEqual(trader._option_capacity("SPY"), 100)
            trader.configure(option_policy={"max_total_pct": 0.70})
            self.assertEqual(trader._option_capacity("SPY"), 0)
            self.assertEqual(set(trader.positions), {"A", "SPY", "C"})

    def test_viewed_contract_remains_chartable_after_leaving_shortlist(self):
        with (
            tempfile.TemporaryDirectory() as directory,
            patch.object(db, "DB_PATH", Path(directory) / "paper.db"),
            patch.object(config, "OPTION_UNDERLYINGS", ("SPY",)),
            patch.object(config, "OPTION_FEED", OptionsFeed.OPRA),
        ):
            from pipeline import data_collector as feed

            broker, quotes = Broker(), Quotes()
            trader = PaperTrader()
            trader.client = cast(TradingClient, broker)
            trader.option_data = cast(OptionHistoricalDataClient, quotes)
            trader.refresh()
            state = {
                "strategy": "options",
                "symbol": "SPY",
                "current_price": 600,
                "quote_time": time.time(),
                "bar_time": time.time() - 60,
            }
            trader._prepare_options(state)
            with patch.object(feed, "TRADER", trader):
                market = feed.MarketState()
                market.snapshot(OPTION)
                quotes.bid, quotes.ask = 100, 100.1
                self.assertEqual(trader._prepare_options(state)["candidates"], [])
                snapshot = market.snapshot(OPTION)
                self.assertEqual(snapshot["symbol"], OPTION)
                self.assertEqual(snapshot["instruments"][OPTION]["asset_class"], "us_option")

    def test_verified_ai_choice_revalidation_and_durable_partial_fill_exit(self):
        with (
            tempfile.TemporaryDirectory() as directory,
            patch.object(db, "DB_PATH", Path(directory) / "paper.db"),
            patch.object(config, "OPTION_UNDERLYINGS", ("SPY",)),
            patch.object(config, "OPTION_FEED", OptionsFeed.INDICATIVE),
        ):
            broker, quotes = Broker(), Quotes()
            trader = PaperTrader()
            trader.configure(
                option_policy={"max_trade_pct": 0.0075}
            )  # Explicit $750 premium ceiling.
            trader.client = cast(TradingClient, broker)
            trader.option_data = cast(OptionHistoricalDataClient, quotes)
            trader.refresh()
            state = trader._prepare_options(
                {
                    "strategy": "options",
                    "symbol": "SPY",
                    "current_price": 600,
                    "quote_time": time.time(),
                    "bar_time": time.time() - 60,
                }
            )
            self.assertEqual([c["symbol"] for c in state["candidates"]], [OPTION])
            self.assertEqual(state["candidates"][0]["max_quantity"], 3)
            response = {
                "answers": {"option_action": {"choice": "buy:UNVERIFIED", "confidence": 0.99}}
            }
            with self.assertRaises(ValueError):
                trader._apply_decision(state, response)
            self.assertEqual(broker.requests, [])
            response["answers"]["option_action"]["choice"] = f"buy:{OPTION}"
            quotes.bid, quotes.ask = 2.09, 2.10
            with self.assertRaises(ValueError):
                trader._apply_decision(state, response)
            self.assertEqual(broker.requests, [])
            quotes.bid, quotes.ask = 1.99, 2.0
            event = trader._apply_decision(state, response)
            self.assertEqual((event["executed"], broker.requests[-1].qty), ("submitted", 3))
            broker.fill(broker.orders[0], 1, 1.9)
            trader.refresh()
            self.assertAlmostEqual(trader.exits[OPTION]["stop_loss_price"], 1.52)
            quotes.bid, quotes.ask = 1.4, 1.41
            trader.monitor_options()
            self.assertEqual(trader.exits[OPTION]["exit_reason"], "stop_loss")
            self.assertEqual(broker.orders[0].status, OrderStatus.CANCELED)
            self.assertEqual(len(broker.requests), 1)
            # The stop remains latched after restart, pause, watchlist removal and price recovery.
            with patch.object(config, "OPTION_UNDERLYINGS", ()):
                restarted = PaperTrader()
                restarted.client = cast(TradingClient, broker)
                restarted.option_data = cast(OptionHistoricalDataClient, quotes)
                restarted.refresh()
                self.assertFalse(restarted.enabled)
                quotes.bid, quotes.ask = 1.8, 1.81
                restarted.monitor_options()
                self.assertEqual(
                    (broker.requests[-1].side.value, broker.requests[-1].qty), ("sell", 1)
                )
                sell = restarted._open_orders(OPTION)[0]
                sell["submitted_at"] = time.time() - config.OPTIONS.exit_reprice_seconds - 1
                restarted.monitor_options()
                self.assertEqual(len(broker.requests), 2)
                self.assertEqual(broker.orders[-1].status, OrderStatus.CANCELED)
                restarted.refresh()
                quotes.bid, quotes.ask = 1.85, 1.86
                restarted.monitor_options()
                self.assertEqual((len(broker.requests), broker.requests[-1].limit_price), (3, 1.85))
                broker.fill(broker.orders[-1], 1, 1.85)
                restarted.refresh()
                self.assertNotIn(OPTION, restarted.positions)
                self.assertNotIn(OPTION, db.get_exits())

    def test_expiry_exit_is_persisted_while_market_closed(self):
        with (
            tempfile.TemporaryDirectory() as directory,
            patch.object(db, "DB_PATH", Path(directory) / "paper.db"),
            patch.object(config, "OPTION_UNDERLYINGS", ("SPY",)),
            patch.object(config, "OPTION_FEED", OptionsFeed.OPRA),
        ):
            broker, quotes = Broker(), Quotes()
            trader = PaperTrader()
            trader.client = cast(TradingClient, broker)
            trader.option_data = cast(OptionHistoricalDataClient, quotes)
            trader._register_option(OPTION)
            trader.refresh()
            trader.manual_buy(OPTION, 2, quantity=1)
            broker.fill(broker.orders[0], 1, 2)
            future = datetime.now(ZoneInfo("America/New_York")) + timedelta(days=13)
            quotes.timestamp = future
            with (
                patch("pipeline.paper_trader.datetime", wraps=datetime) as clock,
                patch("pipeline.paper_trader.time.time", return_value=future.timestamp()),
            ):
                clock.now.return_value = future
                trader.refresh()
                with patch.object(broker, "get_clock", return_value=Model(is_open=False)):
                    trader.monitor_options()
                self.assertEqual(db.get_exits()[OPTION]["exit_reason"], "near_expiry")
                self.assertEqual(len(broker.requests), 1)
                self.assertIsNotNone(trader.monitor_error)
                trader.monitor_options()
                self.assertEqual(
                    (broker.requests[-1].side.value, broker.requests[-1].qty), ("sell", 1)
                )
                self.assertIsNone(trader.monitor_error)

    def test_broker_fills_contract_sizing_restart_and_ambiguous_submission(self):
        with (
            tempfile.TemporaryDirectory() as directory,
            patch.object(db, "DB_PATH", Path(directory) / "paper.db"),
            patch.object(config, "MARKET_SYMBOLS", ("SPY",)),
            patch.object(config, "OPTION_UNDERLYINGS", ("SPY",)),
            patch.object(config, "OPTION_FEED", OptionsFeed.OPRA),
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
                        "underlying": "SPY",
                        "expiration": EXPIRATION.isoformat(),
                        "option_type": "call",
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
            with self.assertRaises(ValueError):
                trader.manual_buy(OPTION, 2, quantity=1)
            trader.configure(capital=1000)
            with self.assertRaises(ValueError):
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
            with self.assertRaises(ValueError):
                trader.manual_sell(OPTION, 2, quantity=0.5)
            with self.assertRaises(ValueError):
                trader.manual_sell(OPTION, 2, quantity=4)
            sell = trader.manual_sell(OPTION, 2, pct_of_position=0.5)
            self.assertEqual(sell["quantity"], 1)
            self.assertEqual(broker.requests[-1].position_intent, PositionIntent.SELL_TO_CLOSE)
            self.assertEqual(trader.positions[OPTION]["quantity"], 3)
            trader.cancel_order(sell["id"])
            trader.refresh()
            self.assertEqual(trader.orders[sell["client_order_id"]]["status"], "canceled")
            with self.assertRaises(ValueError):
                trader.manual_buy(OPTION, 2, quantity=1000)
            trader.configure(capital=1000)
            with self.assertRaises(ValueError):
                trader.manual_buy("SPY", 600, quantity=1)
            trader.configure(capital=100000)
            for invalid in [float("nan"), float("inf"), -1, 0, True]:
                with self.assertRaises(ValueError):
                    trader.manual_buy("SPY", 600, quantity=invalid)
            quotes.timestamp = datetime.fromtimestamp(time.time() - 60, timezone.utc)
            with self.assertRaises(ValueError):
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
            with self.assertRaises(ValueError):
                trader.manual_buy("SPY", 600, quantity=0.5)
            self.assertEqual(len(broker.requests), before)
            trader.api_key = "offline-test"
            trader.configure(enabled=True)
            trader.submit({"symbol": "SPY", "current_price": 600})
            generation, _, _ = trader.pending.get_nowait()
            trader.configure(enabled=False)
            self.assertNotEqual(generation, trader.generation)
            trader.submit({"symbol": "SPY", "current_price": 600})
            self.assertTrue(trader.pending.empty())

    def test_partial_buy_is_canceled_before_stop_exit_even_when_automation_paused(self):
        with (
            tempfile.TemporaryDirectory() as directory,
            patch.object(db, "DB_PATH", Path(directory) / "paper.db"),
            patch.object(config, "MARKET_SYMBOLS", ("SPY",)),
            patch.object(config, "OPTION_UNDERLYINGS", ("SPY",)),
            patch.object(config, "OPTION_FEED", OptionsFeed.OPRA),
        ):
            trader, broker, quotes = PaperTrader(), Broker(), Quotes()
            trader.client = cast(TradingClient, broker)
            trader.option_data = cast(OptionHistoricalDataClient, quotes)
            trader.instruments = {
                OPTION: {
                    "multiplier": 100,
                    "tradable": True,
                    "fractionable": False,
                    "asset_class": "us_option",
                    "underlying": "SPY",
                    "expiration": EXPIRATION.isoformat(),
                    "option_type": "call",
                }
            }
            trader.refresh()
            trader.manual_buy(OPTION, 2, quantity=3, stop_loss_pct=5)
            broker.fill(broker.orders[0], 1, 1.95)
            trader.refresh()
            trader.configure(trading_scope={"option_underlyings": [], "options_enabled": False})
            self.assertNotIn("SPY", trader.scope.option_underlyings)
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
                symbol = config.MARKET_SYMBOLS[0]
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
