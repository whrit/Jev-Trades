"""Offline crypto feed checks: temporary cache/database, no broker or network."""

import asyncio
import os
import tempfile
import time
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path
from unittest.mock import patch

from alpaca.data.models import Bar, Quote
from pydantic import ValidationError

with patch.dict(os.environ, {}, clear=True), patch("dotenv.load_dotenv"):
    from pipeline import config, db
    from pipeline.paper_trader import PaperTrader


class CryptoData(unittest.TestCase):
    def setUp(self):
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        self.directory = Path(directory.name)
        database = patch.object(db, "DB_PATH", self.directory / "paper.db")
        database.start()
        self.addCleanup(database.stop)
        from pipeline import data_collector as feed

        self.feed = feed
        self.trader = PaperTrader()
        self.trader.scope = config.TradingScope(
            stock_symbols=(),
            stock_symbol="",
            stock_enabled=False,
            crypto_symbols=("BTC/USD",),
            crypto_symbol="BTC/USD",
            crypto_enabled=True,
        )
        for name, value in (("TRADER", self.trader), ("STORE_DIR", self.directory / "bars")):
            replacement = patch.object(feed, name, value)
            replacement.start()
            self.addCleanup(replacement.stop)
        state = patch.object(feed, "STATE", feed.MarketState())
        state.start()
        self.addCleanup(state.stop)

    def test_crypto_scope_cannot_cross_asset_classes_or_enable_empty_strategy(self):
        scope = config.TradingScope.model_validate(
            {"crypto_symbols": [" btc/usd ", "BTC/USD", "eth/usd"], "crypto_symbol": "btc/usd"}
        )
        self.assertEqual(scope.crypto_symbols, ("BTC/USD", "ETH/USD"))
        self.assertEqual(scope.crypto_symbol, "BTC/USD")
        self.assertFalse(scope.crypto_enabled)
        for values in (
            {"crypto_symbols": ["BTCUSD"]},
            {"crypto_symbols": ["../USD"]},
            {"crypto_symbols": ["BTC/EUR"]},
            {"stock_symbols": ["BTC/USD"]},
            {"option_underlyings": ["BTC/USD"]},
            {"crypto_enabled": True},
            {"crypto_symbols": ["BTC/USD"], "crypto_symbol": "ETH/USD"},
        ):
            with self.subTest(values=values), self.assertRaises(ValidationError):
                config.TradingScope.model_validate(values)

    def test_stream_quotes_preserve_fresh_price_and_reject_future_or_crossed_data(self):
        now = datetime.now(timezone.utc)
        quote = Quote("BTC/USD", {"t": now, "bp": 60000, "ap": 60002, "bs": 1, "as": 1})
        asyncio.run(self.feed.crypto_quote(quote))
        self.assertEqual(self.feed.STATE.snapshot("BTC/USD")["price"], 60001)
        stale = Quote(
            "BTC/USD", {"t": now - timedelta(seconds=60), "bp": 1, "ap": 2, "bs": 1, "as": 1}
        )
        asyncio.run(self.feed.crypto_quote(stale))
        self.assertEqual(self.feed.STATE.snapshot("BTC/USD")["price"], 60001)
        future = Quote(
            "BTC/USD", {"t": now + timedelta(days=1), "bp": 1, "ap": 2, "bs": 1, "as": 1}
        )
        asyncio.run(self.feed.crypto_quote(future))
        self.assertIsNotNone(self.feed.STATE.crypto_stream_error)
        crossed = Quote("BTC/USD", {"t": now, "bp": 3, "ap": 2, "bs": 1, "as": 1})
        asyncio.run(self.feed.crypto_quote(crossed))
        self.assertIsNotNone(self.feed.STATE.crypto_stream_error)
        self.assertEqual(self.feed.STATE.snapshot("BTC/USD")["price"], 60001)
        self.assertEqual(db.get_orders(), [])

    def test_completed_crypto_bars_correct_volume_and_queue_only_one_strategy_decision(self):
        feed = self.feed
        base = int(time.time() // 60) * 60 - 120
        first = Bar(
            "BTC/USD",
            {
                "t": datetime.fromtimestamp(base, timezone.utc),
                "o": 60000,
                "h": 60004,
                "l": 59999,
                "c": 60002,
                "v": 2,
                "n": 2,
                "vw": 60001,
            },
        )
        second = Bar(
            "BTC/USD",
            {
                "t": datetime.fromtimestamp(base + 60, timezone.utc),
                "o": 60002,
                "h": 60010,
                "l": 60000,
                "c": 60008,
                "v": 3,
                "n": 3,
                "vw": 60005,
            },
        )
        self.trader.enabled = True
        self.trader.api_key = "offline-only"
        feed.STATE.trading_enabled = True
        asyncio.run(feed.crypto_bar(first))
        self.assertTrue(self.trader.pending.empty())
        asyncio.run(feed.crypto_bar(second))
        correction = second.model_copy(update={"volume": 1.5, "close": 60006})
        asyncio.run(feed.crypto_bar(correction))
        asyncio.run(feed.crypto_bar(second.model_copy(update={"close": float("nan")})))
        self.assertIsNotNone(feed.STATE.crypto_stream_error)
        _, _, decision = self.trader.pending.get_nowait()
        self.assertEqual((decision["strategy"], decision["asset_class"]), ("crypto", "crypto"))
        self.assertTrue(self.trader.pending.empty())
        snapshot = feed.STATE.snapshot("BTC/USD")
        self.assertEqual([bar["volume"] for bar in snapshot["bars"]], [2, 1.5])
        self.assertEqual(snapshot["bars"][-1]["close"], 60006)
        self.assertEqual(snapshot["instruments"]["BTC/USD"]["asset_class"], "crypto")
        self.assertTrue((feed.STORE_DIR / "BTC%2FUSD.json").is_file())
        self.assertFalse((feed.STORE_DIR / "BTC").exists())
        self.assertEqual(db.get_orders(), [])

    def test_subcent_indicators_preserve_price_and_volatility(self):
        price = 0.00000001234
        bars = [
            {
                "time": i * 60,
                "open": price,
                "high": price + 1e-9,
                "low": price - 1e-9,
                "close": price,
                "volume": 1,
            }
            for i in range(220)
        ]
        indicators = self.feed.calculate_indicators(bars)
        series = self.feed.calculate_indicator_series(bars)
        ema, atr, sma = indicators["ema20"], indicators["atr14"], series["sma50"][-1]
        assert ema is not None and atr is not None and sma is not None
        self.assertAlmostEqual(ema, price, delta=1e-20)
        self.assertAlmostEqual(atr, 2e-9, delta=1e-20)
        self.assertAlmostEqual(sma, price, delta=1e-20)


if __name__ == "__main__":
    unittest.main()
