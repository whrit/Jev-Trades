"""Offline crypto execution checks: no credentials, network, or real broker orders."""

import os
import tempfile
import time
import unittest
from datetime import datetime, timedelta, timezone
from decimal import Decimal
from pathlib import Path
from types import SimpleNamespace as Model
from typing import cast
from unittest.mock import patch
from uuid import uuid4

from alpaca.data.historical import CryptoHistoricalDataClient
from alpaca.data.models import Quote
from alpaca.trading.client import TradingClient
from alpaca.trading.enums import AccountStatus, AssetClass, AssetStatus, OrderSide, OrderStatus

with patch.dict(os.environ, {}, clear=True), patch("dotenv.load_dotenv"):
    from pipeline import config, db
    from pipeline.paper_trader import CRYPTO_TAKER_FEE, PaperTrader

BTC = "BTC/USD"
MIN_ORDER_SIZE = 0.0001
MIN_TRADE_INCREMENT = 0.0001
PRICE_INCREMENT = 1.0
INSTRUMENT = {
    "asset_class": "crypto",
    "multiplier": 1,
    "tradable": True,
    "fractionable": True,
    "expiration": None,
    "min_order_size": MIN_ORDER_SIZE,
    "min_trade_increment": MIN_TRADE_INCREMENT,
    "price_increment": PRICE_INCREMENT,
}

BTC_ASSET_ID = uuid4()


class CryptoBroker:
    """Controlled broker boundary: acceptance and fills are separate transitions."""

    def __init__(self):
        self.orders = []
        self.positions = []
        self.cash = 100000.0
        self.crypto_status = AccountStatus.ACTIVE
        self.non_marginable_buying_power = 100000.0
        self.clock_open = False  # Deliberately closed: crypto must not depend on equity hours.
        self.fail = False
        self.requests = []
        self.asset_id = BTC_ASSET_ID

    def get_account(self):
        return Model(
            cash=str(self.cash),
            equity=str(self.cash),
            buying_power=str(self.cash),
            options_buying_power="0",
            options_trading_level=0,
            trading_blocked=False,
            account_blocked=False,
            crypto_status=self.crypto_status,
            non_marginable_buying_power=str(self.non_marginable_buying_power),
        )

    def get_orders(self, request):
        return list(self.orders)

    def get_order_by_client_id(self, client_id):
        return next(o for o in self.orders if o.client_order_id == client_id)

    def get_all_positions(self):
        return list(self.positions)

    def get_clock(self):
        return Model(is_open=self.clock_open)

    def get_asset(self, symbol_or_asset_id):
        # Alpaca resolves either the canonical symbol, a legacy no-slash alias, or the asset_id
        # to the same canonical asset (backward-compatible legacy naming).
        if str(symbol_or_asset_id) == "BTC/USDT":
            return Model(
                symbol="BTC/USDT",
                name="BTC/USDT pair",
                asset_class=AssetClass.CRYPTO,
                status=AssetStatus.ACTIVE,
                tradable=True,
                fractionable=True,
                min_order_size=MIN_ORDER_SIZE,
                min_trade_increment=MIN_TRADE_INCREMENT,
                price_increment=PRICE_INCREMENT,
            )
        if str(symbol_or_asset_id) not in (BTC, "BTCUSD", str(self.asset_id)):
            raise ValueError("Unknown asset")
        return Model(
            symbol=BTC,
            name="BTC/USD pair",
            asset_class=AssetClass.CRYPTO,
            status=AssetStatus.ACTIVE,
            tradable=True,
            fractionable=True,
            min_order_size=MIN_ORDER_SIZE,
            min_trade_increment=MIN_TRADE_INCREMENT,
            price_increment=PRICE_INCREMENT,
        )

    def get_all_assets(self, request):
        return [self.get_asset(BTC), self.get_asset("BTC/USDT")]

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
            asset_class=AssetClass.CRYPTO,
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
            self.cash += delta * price
            if remaining <= 1e-9:
                self.positions.remove(position)
            else:
                position.qty = position.qty_available = str(remaining)
                position.market_value = str(remaining * float(position.current_price))
                position.unrealized_pl = str(
                    remaining * (float(position.current_price) - float(position.avg_entry_price))
                )
            return
        self.cash -= qty * price
        self.positions = [
            Model(
                symbol=order.symbol,
                qty=str(qty),
                qty_available=str(qty),
                avg_entry_price=str(price),
                current_price=str(price),
                market_value=str(qty * price),
                unrealized_pl="0",
                unrealized_plpc="0",
                asset_class=AssetClass.CRYPTO,
            )
        ]

    def cancel_order_by_id(self, order_id):
        next(o for o in self.orders if str(o.id) == order_id).status = OrderStatus.CANCELED


class CryptoQuotes:
    def __init__(self):
        self.timestamp = datetime.now(timezone.utc)
        self.bid, self.ask = 59999.0, 60001.0

    def get_crypto_latest_quote(self, request, feed=None):
        symbol = request.symbol_or_symbols
        return {
            symbol: Quote(
                symbol,
                {"t": self.timestamp, "bp": self.bid, "ap": self.ask, "bs": 1, "as": 1},
            )
        }


class CryptoExecution(unittest.TestCase):
    def setUp(self):
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        database = patch.object(db, "DB_PATH", Path(directory.name) / "paper.db")
        database.start()
        self.addCleanup(database.stop)
        crypto_symbols = patch.object(config, "CRYPTO_SYMBOLS", ())
        crypto_symbols.start()
        self.addCleanup(crypto_symbols.stop)
        stock_symbols = patch.object(config, "STOCK_SYMBOLS", ())
        stock_symbols.start()
        self.addCleanup(stock_symbols.stop)

    def _trader(self, *, crypto_status=AccountStatus.ACTIVE, buying_power=100000.0):
        trader = PaperTrader()
        trader.scope = config.TradingScope(
            crypto_symbols=(BTC,), crypto_symbol=BTC, crypto_enabled=True
        )
        broker, quotes = CryptoBroker(), CryptoQuotes()
        broker.crypto_status = crypto_status
        broker.non_marginable_buying_power = buying_power
        trader.client = cast(TradingClient, broker)
        trader.crypto_data = cast(CryptoHistoricalDataClient, quotes)
        trader.instruments = {BTC: dict(INSTRUMENT)}
        trader.refresh()
        return trader, broker, quotes

    def test_crypto_metadata_discovery_atomic_scope_validation_and_search_assets(self):
        with patch.object(config, "CRYPTO_SYMBOLS", ()):
            trader = PaperTrader()
            broker = CryptoBroker()
            trader.client = cast(TradingClient, broker)
            trader.refresh()
            trader.configure(
                trading_scope={
                    "crypto_symbols": [" btc/usd "],
                    "crypto_symbol": "btc/usd",
                    "crypto_enabled": True,
                }
            )
            self.assertEqual(trader.scope.crypto_symbols, (BTC,))
            self.assertEqual(
                trader.instruments[BTC]["min_order_size"],
                MIN_ORDER_SIZE,
            )
            self.assertEqual(trader.instruments[BTC]["min_trade_increment"], MIN_TRADE_INCREMENT)
            self.assertEqual(trader.instruments[BTC]["price_increment"], PRICE_INCREMENT)
            self.assertEqual(
                trader.search_assets("btc", "crypto"), [{"symbol": BTC, "name": "BTC/USD pair"}]
            )
            self.assertEqual(trader.search_assets("btc"), [])  # default asset_class=us_equity
            with self.assertRaises(ValueError):
                trader.search_assets("btc", "bogus")
            saved = db.get_trading_scope()
            generation = trader.generation
            with self.assertRaises(ValueError):
                trader.configure(capital=1234, trading_scope={"crypto_symbols": ["ETH/USD"]})
            self.assertEqual(db.get_trading_scope(), saved)  # Atomic: bad addition rolls back.
            self.assertEqual((trader.starting_cash, trader.generation), (100000, generation))
            restarted = PaperTrader()
            self.assertEqual(restarted.scope.crypto_symbols, (BTC,))

    def test_crypto_eligibility_nonmargin_buying_power_and_equity_clock_bypass(self):
        trader, broker, _ = self._trader(crypto_status=AccountStatus.INACTIVE)
        with self.assertRaises(ValueError):
            trader.manual_buy(BTC, 60000, quantity=0.001)
        self.assertEqual(broker.requests, [])
        broker.crypto_status = AccountStatus.ACTIVE
        broker.non_marginable_buying_power = 10.0
        trader.refresh()
        self.assertAlmostEqual(trader._buying_capacity(BTC), 10.0)
        self.assertFalse(broker.clock_open)  # Regular market session is closed the whole test.
        trader.manual_buy(BTC, 60000, quantity=0.0001, limit_price=60000)
        self.assertEqual(len(broker.requests), 1)  # Crypto trades despite the closed clock.

    def test_market_limit_stop_limit_order_types_and_time_in_force(self):
        trader, broker, _ = self._trader()
        with self.assertRaises(ValueError):  # stop_price without limit_price is ambiguous.
            trader.manual_buy(BTC, 60000, quantity=0.001, stop_price=59000)
        with self.assertRaises(ValueError):  # Crypto stop-limit is GTC only.
            trader.manual_buy(
                BTC, 60000, quantity=0.001, stop_price=59000, limit_price=60000, time_in_force="ioc"
            )
        with self.assertRaises(ValueError):
            trader.manual_buy(BTC, 60000, quantity=0.001, time_in_force="fok")
        self.assertEqual(broker.requests, [])

        market = trader.manual_buy(BTC, 60000, quantity=0.001)
        self.assertEqual(broker.requests[-1].type.value, "market")
        self.assertEqual(broker.requests[-1].time_in_force.value, "gtc")
        self.assertIsNone(getattr(broker.requests[-1], "position_intent", None))
        broker.fill(broker.orders[-1], 0.001, 60000)
        trader.refresh()

        limit = trader.manual_sell(BTC, 60000, quantity=0.0005, limit_price=60000)
        self.assertEqual(broker.requests[-1].type.value, "limit")
        self.assertEqual(float(broker.requests[-1].limit_price), 60000)
        broker.fill(broker.orders[-1], 0.0005, 60000)
        trader.refresh()

        stop_limit = trader.manual_sell(
            BTC, 60000, quantity=0.0005, stop_price=59000, limit_price=59500
        )
        self.assertEqual(broker.requests[-1].type.value, "stop_limit")
        self.assertEqual(float(broker.requests[-1].stop_price), 59000)
        self.assertEqual(float(broker.requests[-1].limit_price), 59500)
        self.assertEqual(broker.requests[-1].time_in_force.value, "gtc")
        self.assertTrue(all([market, limit, stop_limit]))

    def test_stock_rejects_crypto_only_order_parameters(self):
        with patch.object(config, "STOCK_SYMBOLS", ("SPY",)):
            trader = PaperTrader()
            broker = CryptoBroker()
            broker.get_asset = lambda symbol_or_asset_id: Model(
                symbol=symbol_or_asset_id,
                name="SPDR S&P 500 ETF",
                asset_class=AssetClass.US_EQUITY,
                status=AssetStatus.ACTIVE,
                tradable=True,
                fractionable=True,
            )
            trader.client = cast(TradingClient, broker)
            trader.instruments["SPY"] = {
                "asset_class": "us_equity",
                "multiplier": 1,
                "tradable": True,
                "fractionable": True,
                "expiration": None,
            }
            trader.refresh()
            with self.assertRaises(ValueError):
                trader.manual_buy("SPY", 600, quantity=1, time_in_force="gtc")
            with self.assertRaises(ValueError):
                trader.manual_buy("SPY", 600, quantity=1, stop_price=590, limit_price=595)
            self.assertEqual(broker.requests, [])

    def test_decimal_min_quantity_increment_and_price_checks(self):
        trader, broker, _ = self._trader()
        with self.assertRaises(ValueError):  # Not a multiple of the 0.0001 trade increment.
            trader.manual_buy(BTC, 60000, quantity=0.00015, limit_price=60000)
        with self.assertRaises(ValueError):  # Below the broker minimum order size.
            trader.manual_buy(BTC, 60000, quantity=0.00005, limit_price=60000)
        with self.assertRaises(ValueError):  # Not a multiple of the $1 price increment.
            trader.manual_buy(BTC, 60000, quantity=0.001, limit_price=60000.5)
        with self.assertRaises(ValueError):
            trader.manual_buy(BTC, 60000, quantity=0.001, stop_price=59000.5, limit_price=59500)
        self.assertEqual(broker.requests, [])

        trade = trader.manual_buy(BTC, 60000, quantity=0.001, limit_price=60000)
        self.assertEqual(trade["quantity"], 0.001)
        broker.fill(broker.orders[-1], 0.001, 60000)
        trader.refresh()

        # amount_usd-derived sizing auto-floors to the trade increment (fee-adjusted; see below).
        naive = 1000 / 60001
        order = trader.manual_buy(BTC, 60001, amount_usd=1000)
        qty = float(broker.requests[-1].qty)
        self.assertLess(qty, naive)  # Fee headroom shrinks the floored quantity.
        self.assertEqual(Decimal(str(qty)) % Decimal(str(MIN_TRADE_INCREMENT)), 0)
        self.assertGreaterEqual(qty, MIN_ORDER_SIZE)
        self.assertIsNotNone(order)

    def test_conservative_fee_sizing_and_no_short_sell_available_quantity(self):
        trader, broker, _ = self._trader()
        self.assertAlmostEqual(trader._buying_capacity(BTC), 75000.0)  # 100k * 0.75 wallet cap.
        with self.assertRaises(ValueError):  # Exactly the raw budget with no fee headroom.
            trader.manual_buy(BTC, 60000, quantity=1.25, limit_price=60000)
        self.assertEqual(broker.requests, [])
        fee_mult = 1 + CRYPTO_TAKER_FEE
        self.assertLessEqual(1.20 * 60000 * fee_mult, 75000)
        trader.manual_buy(BTC, 60000, quantity=1.20, limit_price=60000)
        broker.fill(broker.orders[-1], 1.20, 60000)
        trader.refresh()
        with self.assertRaises(ValueError):  # No shorting: cannot sell more than held.
            trader.manual_sell(BTC, 60000, quantity=1.21, limit_price=60000)
        # Selling the full available position needs no fee headroom (fee only reduces proceeds).
        sell = trader.manual_sell(BTC, 60000, quantity=1.20, limit_price=60000)
        self.assertEqual(sell["quantity"], 1.20)

    def test_stale_crossed_quotes_and_ambiguous_submission_fail_closed(self):
        trader, broker, quotes = self._trader()
        quotes.timestamp = datetime.now(timezone.utc) - timedelta(seconds=60)
        with self.assertRaises(ValueError):
            trader.manual_buy(BTC, 60000, quantity=0.001)
        quotes.timestamp, quotes.bid, quotes.ask = datetime.now(timezone.utc), 60002.0, 60001.0
        with self.assertRaises(ValueError):
            trader.manual_buy(BTC, 60000, quantity=0.001)
        self.assertEqual(broker.requests, [])
        quotes.bid, quotes.ask = 59999.0, 60001.0
        broker.fail = True
        with self.assertRaises(TimeoutError):
            trader.manual_buy(BTC, 60000, quantity=0.001)
        self.assertEqual(trader._open_orders(BTC)[0]["status"], "unknown")
        before = len(broker.requests)
        with self.assertRaises(ValueError):  # An ambiguous submission is not safe to repeat.
            trader.manual_buy(BTC, 60000, quantity=0.001)
        self.assertEqual(len(broker.requests), before)
        # Restart durably reconciles the broker's own record of the ambiguous order.
        broker.fail = False
        restarted = PaperTrader()
        restarted.scope = trader.scope
        restarted.client = cast(TradingClient, broker)
        restarted.crypto_data = cast(CryptoHistoricalDataClient, quotes)
        restarted.instruments = {BTC: dict(INSTRUMENT)}
        restarted.refresh()
        self.assertEqual(restarted._open_orders(BTC)[0]["status"], "accepted")
        order_id = restarted._open_orders(BTC)[0]["id"]
        restarted.cancel_order(order_id)
        restarted.refresh()
        self.assertEqual(restarted._open_orders(BTC), [])

    def test_fill_based_tp_sl_durable_through_pause_scope_removal_and_restart(self):
        trader, broker, quotes = self._trader()
        # Fill price (59800) deliberately differs from the reference price (60000): percent
        # targets anchor to the caller-supplied reference at submission (the stock model), not
        # the eventual fill average, mirroring manual/jev stock orders exactly.
        trader.manual_buy(BTC, 60000, quantity=1.0, stop_loss_pct=5)
        broker.fill(broker.orders[0], 1.0, 59800)
        trader.refresh()
        self.assertAlmostEqual(trader.exits[BTC]["stop_loss_price"], 57000)
        # Pause automation and drop BTC/USD from the crypto watchlist entirely.
        trader.configure(
            trading_scope={"crypto_enabled": False, "crypto_symbols": (), "crypto_symbol": ""}
        )
        self.assertFalse(trader.scope.crypto_enabled)
        self.assertNotIn(BTC, trader.scope.crypto_symbols)
        quotes.bid, quotes.ask = 56000.0, 56002.0
        self.assertIsNotNone(trader.check_tp_sl(BTC, 56000))
        self.assertEqual(broker.requests[-1].side.value, "sell")
        self.assertEqual(float(broker.requests[-1].qty), 1.0)
        broker.fill(broker.orders[-1], 1.0, 56000)
        trader.refresh()
        self.assertNotIn(BTC, trader.positions)
        self.assertNotIn(BTC, db.get_exits())
        # Restart still knows nothing is held; the paused/removed state persisted cleanly.
        restarted = PaperTrader()
        restarted.client = cast(TradingClient, broker)
        restarted.crypto_data = cast(CryptoHistoricalDataClient, quotes)
        restarted.instruments = {BTC: dict(INSTRUMENT)}
        restarted.refresh()
        self.assertFalse(restarted.scope.crypto_enabled)
        self.assertNotIn(BTC, restarted.positions)

    def test_protective_exit_latch_survives_cancel_pending_and_restart_price_recovery(self):
        trader, broker, quotes = self._trader()
        trader.manual_buy(BTC, 60000, quantity=1.0, stop_loss_pct=5)
        broker.fill(broker.orders[0], 0.5, 60000)  # Partial fill; remainder stays open.
        trader.refresh()
        self.assertEqual(trader.positions[BTC]["quantity"], 0.5)
        self.assertEqual(len(trader._open_orders(BTC)), 1)
        # Price drops through the stop: the pending remainder must be canceled first, but the
        # exit intent is latched immediately so a later price recovery cannot abandon it.
        quotes.bid, quotes.ask = 56000.0, 56002.0
        self.assertIsNone(trader.check_tp_sl(BTC, 56000))
        self.assertEqual(broker.orders[0].status, OrderStatus.CANCELED)
        self.assertEqual(db.get_exits()[BTC]["exit_reason"], "stop_loss")
        self.assertEqual(len(broker.requests), 1)  # No sell submitted yet: cancel still pending.
        # Restart mid-cancellation; the broker already shows the remainder canceled.
        restarted = PaperTrader()
        restarted.client = cast(TradingClient, broker)
        restarted.crypto_data = cast(CryptoHistoricalDataClient, quotes)
        restarted.instruments = {BTC: dict(INSTRUMENT)}
        restarted.refresh()
        self.assertEqual(restarted.exits[BTC]["exit_reason"], "stop_loss")
        self.assertEqual(restarted._open_orders(BTC), [])
        # Price recovers above the stop threshold; a fresh re-check would not trigger on its
        # own, but the durable latch forces the exit through regardless.
        quotes.bid, quotes.ask = 58000.0, 58002.0
        sell = restarted.check_tp_sl(BTC, 58000)
        assert sell is not None
        self.assertEqual((sell["side"], sell["quantity"]), ("sell", 0.5))
        self.assertEqual(len(broker.requests), 2)

    def test_crypto_strategy_gate_independent_of_stock_and_reuses_stock_decision_model(self):
        trader, broker, quotes = self._trader()
        trader.api_key = "offline-test"
        trader.configure(enabled=True)
        # Wrong symbol / disabled scope silently drop the submission (no crash, no queue).
        trader.submit({"symbol": "ETH/USD", "current_price": 3000}, strategy="crypto")
        self.assertTrue(trader.pending.empty())
        trader.configure(trading_scope={"crypto_enabled": False})
        trader.submit({"symbol": BTC, "current_price": 60000}, strategy="crypto")
        self.assertTrue(trader.pending.empty())
        trader.configure(trading_scope={"crypto_enabled": True})
        trader.submit({"symbol": BTC, "current_price": 60000}, strategy="crypto")
        _, _, queued = trader.pending.get_nowait()
        self.assertEqual((queued["strategy"], queued["symbol"]), ("crypto", BTC))

        # _apply_decision reuses the stock action_choice/quantity-score model, not option_questions.
        response = {
            "answers": {
                "action_choice": {"choice": "buy", "confidence": 0.9},
                "buying_quantity": {"score": 1.0},
                "stop_loss_target": {"choice": "moderate"},
                "take_profit_target": {"choice": "balanced"},
            }
        }
        state = {
            "symbol": BTC,
            "current_price": 60000,
            "strategy": "crypto",
            "time_frame": "1m",
            "quote_time": time.time(),
            "bar_time": time.time() - 60,
        }
        with self.assertRaises(ValueError):  # A stale bar/quote must not drive a crypto decision.
            trader._apply_decision({**state, "bar_time": time.time() - 600}, response)
        event = trader._apply_decision(state, response)
        self.assertEqual((event["strategy"], event["executed"]), ("crypto", "submitted"))
        self.assertEqual(broker.requests[-1].symbol, BTC)
        self.assertIsNone(getattr(broker.requests[-1], "position_intent", None))

    def test_legacy_no_slash_symbols_normalize_to_canonical_and_migrate_exit_targets(self):
        trader, broker, _ = self._trader()
        legacy_targets = {"stop_loss_price": 57000.0, "take_profit_price": 63000.0}
        trader.exits["BTCUSD"] = legacy_targets
        db.save_exits("BTCUSD", legacy_targets)
        broker.positions = [
            Model(
                symbol="BTCUSD",
                asset_id=broker.asset_id,
                asset_class=AssetClass.CRYPTO,
                avg_entry_price="60000",
                qty="1.0",
                qty_available="1.0",
                current_price="60500",
                market_value="60500",
                unrealized_pl="500",
                unrealized_plpc="0.0083",
            )
        ]
        broker.orders.append(
            Model(
                id=uuid4(),
                client_order_id="legacy-order-1",
                symbol="BTCUSD",
                side=OrderSide.SELL,
                asset_class=AssetClass.CRYPTO,
                asset_id=broker.asset_id,
                qty="0.5",
                filled_qty="0.5",
                filled_avg_price="60500",
                status=OrderStatus.FILLED,
                created_at=datetime.now(timezone.utc),
                submitted_at=datetime.now(timezone.utc),
                filled_at=datetime.now(timezone.utc),
            )
        )
        trader.refresh()
        self.assertIn(BTC, trader.positions)
        self.assertNotIn("BTCUSD", trader.positions)
        self.assertEqual(trader.orders["legacy-order-1"]["symbol"], BTC)
        self.assertEqual(trader.exits[BTC]["stop_loss_price"], 57000.0)
        self.assertNotIn("BTCUSD", trader.exits)
        persisted = db.get_exits()
        self.assertNotIn("BTCUSD", persisted)
        self.assertEqual(persisted[BTC]["stop_loss_price"], 57000.0)

    def test_search_assets_and_metadata_enforce_usd_quoted_crypto_pairs(self):
        trader, broker, _ = self._trader()
        results = trader.search_assets("btc", "crypto")
        self.assertEqual(results, [{"symbol": BTC, "name": "BTC/USD pair"}])
        self.assertNotIn("BTC/USDT", [r["symbol"] for r in results])
        with self.assertRaises(ValueError):
            trader._crypto_metadata("BTC/USDT")
        # is_crypto uses the exact canonical BASE/USD shape, not a loose "contains a slash" check.
        self.assertFalse(trader.is_crypto("BTC/USDT"))
        self.assertFalse(trader.is_crypto("BTC/EUR"))
        self.assertTrue(trader.is_crypto(BTC))

    def test_pending_crypto_buy_reservation_includes_fee_allowance(self):
        trader, broker, _ = self._trader()
        trader.manual_buy(BTC, 60000, quantity=1.0, limit_price=60000)  # stays unfilled/accepted
        fee_mult = 1 + CRYPTO_TAKER_FEE
        expected = 100000 - 1.0 * 60000 * fee_mult
        self.assertAlmostEqual(trader._buying_capacity(BTC), expected)
        # The naive (bug) computation without fee headroom would have left more capacity.
        self.assertLess(trader._buying_capacity(BTC), 100000 - 1.0 * 60000)


if __name__ == "__main__":
    unittest.main()
