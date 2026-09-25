"""Server-side Alpaca paper-account configuration."""

import os
import re
from pathlib import Path

from alpaca.data.enums import DataFeed, OptionsFeed
from dotenv import load_dotenv

load_dotenv(Path(__file__).with_name(".env"))


def symbols(name: str, default: str, pattern: str) -> tuple[str, ...]:
    values = tuple(
        dict.fromkeys(s.strip().upper() for s in os.getenv(name, default).split(",") if s.strip())
    )
    if any(not re.fullmatch(pattern, value) for value in values):
        raise ValueError(f"Invalid symbol in {name}")
    return values


STOCK_SYMBOLS = symbols("ALPACA_STOCK_SYMBOLS", "SPY,AAPL,MSFT", r"[A-Z][A-Z0-9.]{0,9}")
OPTION_SYMBOLS = symbols("ALPACA_OPTION_SYMBOLS", "", r"[A-Z]{1,6}\d{6}[CP]\d{8}")
SUPPORTED_SYMBOLS = STOCK_SYMBOLS + OPTION_SYMBOLS
if not SUPPORTED_SYMBOLS:
    raise ValueError("Configure at least one stock or option symbol")
STOCK_FEED = DataFeed(os.getenv("ALPACA_STOCK_FEED", "iex"))
OPTION_FEED = OptionsFeed(os.getenv("ALPACA_OPTION_FEED", "indicative"))
if STOCK_FEED not in (DataFeed.IEX, DataFeed.SIP):
    raise ValueError("ALPACA_STOCK_FEED must be iex or sip")
ALLOWED_ORIGINS = set(
    os.getenv("FEED_ALLOWED_ORIGINS", "http://localhost:3000,http://127.0.0.1:3000").split(",")
)


def credentials() -> tuple[str, str]:
    key, secret = os.getenv("ALPACA_API_KEY", ""), os.getenv("ALPACA_SECRET_KEY", "")
    if not key or not secret:
        raise ValueError("Set ALPACA_API_KEY and ALPACA_SECRET_KEY for an Alpaca paper account")
    return key, secret
