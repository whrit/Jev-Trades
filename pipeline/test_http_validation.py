"""Offline HTTP regression: reject unsafe inputs before changing trading state."""

import json
import os
import tempfile
import threading
import unittest
from http.client import HTTPConnection
from http.server import ThreadingHTTPServer
from pathlib import Path
from unittest.mock import patch

with patch.dict(os.environ, {}, clear=True), patch("dotenv.load_dotenv"):
    from pipeline import config, db
    from pipeline.paper_trader import PaperTrader


class HttpValidation(unittest.TestCase):
    def test_invalid_payloads_preserve_settings_and_do_not_echo_secrets(self):
        with (
            tempfile.TemporaryDirectory() as directory,
            patch.object(db, "DB_PATH", Path(directory) / "paper.db"),
            patch.dict(os.environ, {"HOST": "127.0.0.1", "PORT": "8765"}),
        ):
            from pipeline import data_collector as feed

            with (
                patch.object(feed, "STATE", feed.MarketState()),
                patch.object(feed, "TRADER", PaperTrader()),
                ThreadingHTTPServer(("127.0.0.1", 0), feed.FeedHandler) as server,
            ):
                worker = threading.Thread(target=server.serve_forever, daemon=True)
                worker.start()

                def post(path, payload):
                    connection = HTTPConnection("127.0.0.1", server.server_port, timeout=3)
                    try:
                        connection.request(
                            "POST", path, json.dumps(payload), {"Content-Type": "application/json"}
                        )
                        response = connection.getresponse()
                        return response.status, json.loads(response.read())
                    finally:
                        connection.close()

                try:
                    status, _ = post("/config", {"capital": 1234, "trading_enabled": False})
                    self.assertEqual(status, 200)
                    self.assertEqual(feed.TRADER.starting_cash, 1234)
                    for field, value in (
                        ("capital", True),
                        ("capital", "2000"),
                        ("capital", float("nan")),
                        ("trading_enabled", "false"),
                        ("trading_enabled", None),
                        ("active_timeframes", []),
                        ("max_wallet_position_pct", 1.1),
                        ("unexpected_setting", "value"),
                        ("typesafe_api_key", ["secret-must-not-leak"]),
                    ):
                        with self.subTest(field=field, value=value):
                            status, response = post("/config", {"capital": 9000, field: value})
                            self.assertEqual(status, 400)
                            self.assertFalse(response["ok"])
                            self.assertIn(field, response["error"])
                            self.assertNotIn("secret-must-not-leak", response["error"])
                            self.assertEqual(feed.TRADER.starting_cash, 1234)
                            self.assertFalse(feed.TRADER.enabled)
                    status, response = post(
                        "/order",
                        {"action": "buy", "symbol": config.MARKET_SYMBOLS[0], "quantity": True},
                    )
                    self.assertEqual(status, 400)
                    self.assertIn("quantity", response["error"])
                    self.assertEqual(db.get_orders(), [])
                finally:
                    server.shutdown()
                    worker.join(timeout=3)


if __name__ == "__main__":
    unittest.main()
