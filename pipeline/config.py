"""Server-side Alpaca paper-account configuration."""

import os
import re
from pathlib import Path
from typing import Self

from alpaca.data.enums import DataFeed, OptionsFeed
from dotenv import load_dotenv
from pydantic import BaseModel, ConfigDict, Field, model_validator

load_dotenv(Path(__file__).with_name(".env"))


def symbols(name: str, default: str, pattern: str) -> tuple[str, ...]:
    values = tuple(
        dict.fromkeys(s.strip().upper() for s in os.getenv(name, default).split(",") if s.strip())
    )
    if any(not re.fullmatch(pattern, value) for value in values):
        raise ValueError(f"Invalid symbol in {name}")
    return values


STOCK_SYMBOLS = symbols("ALPACA_STOCK_SYMBOLS", "SPY,AAPL,MSFT", r"[A-Z][A-Z0-9.]{0,9}")
OPTION_UNDERLYINGS = symbols("ALPACA_OPTION_UNDERLYINGS", "", r"[A-Z][A-Z0-9.]{0,9}")
MARKET_SYMBOLS = tuple(dict.fromkeys(STOCK_SYMBOLS + OPTION_UNDERLYINGS))
if not MARKET_SYMBOLS:
    raise ValueError("Configure at least one stock or option underlying")
if os.getenv("ALPACA_OPTION_SYMBOLS", "").strip():
    raise ValueError("Replace ALPACA_OPTION_SYMBOLS with ALPACA_OPTION_UNDERLYINGS (stock tickers)")
STOCK_FEED = DataFeed(os.getenv("ALPACA_STOCK_FEED", "iex"))
OPTION_FEED = OptionsFeed(os.getenv("ALPACA_OPTION_FEED", "indicative"))
if STOCK_FEED not in (DataFeed.IEX, DataFeed.SIP):
    raise ValueError("ALPACA_STOCK_FEED must be iex or sip")
ALLOWED_ORIGINS = set(
    os.getenv("FEED_ALLOWED_ORIGINS", "http://localhost:3000,http://127.0.0.1:3000").split(",")
)


class OptionPolicy(BaseModel):
    model_config = ConfigDict(frozen=True, allow_inf_nan=False)

    min_dte: int = Field(default=7, ge=1)
    max_dte: int = Field(default=45, ge=1)
    min_open_interest: int = Field(default=100, ge=1)
    max_open_interest_age_days: int = Field(default=7, ge=0)
    min_quote_size: int = Field(default=1, ge=1)
    max_spread_pct: float = Field(default=0.10, gt=0, le=1)
    max_spread_absolute: float = Field(default=0.50, gt=0)
    max_quote_age_seconds: int = Field(default=30, ge=1, le=30)
    max_candidates: int = Field(default=12, ge=2, le=40)
    max_trade_pct: float = Field(default=0.01, gt=0, le=1)
    max_underlying_pct: float = Field(default=0.05, gt=0, le=1)
    max_total_pct: float = Field(default=0.10, gt=0, le=1)
    max_contracts: int = Field(default=5, ge=1)
    stop_loss_pct: float = Field(default=20, gt=0, lt=100)
    take_profit_pct: float = Field(default=40, gt=0)
    exit_dte: int = Field(default=1, ge=0)
    entry_timeout_seconds: int = Field(default=120, ge=1)
    exit_reprice_seconds: int = Field(default=30, ge=1)
    max_price_drift_pct: float = Field(default=0.02, ge=0, le=1)

    @model_validator(mode="after")
    def valid_ranges(self) -> Self:
        if not self.exit_dte < self.min_dte <= self.max_dte:
            raise ValueError("Require OPTION_EXIT_DTE < OPTION_MIN_DTE <= OPTION_MAX_DTE")
        if not self.max_trade_pct <= self.max_underlying_pct <= self.max_total_pct:
            raise ValueError("Require option trade cap <= underlying cap <= total cap")
        return self


OPTIONS = OptionPolicy.model_validate(
    {
        field: os.environ[f"OPTION_{field.upper()}"]
        for field in OptionPolicy.model_fields
        if f"OPTION_{field.upper()}" in os.environ
    }
)


def credentials() -> tuple[str, str]:
    key, secret = os.getenv("ALPACA_API_KEY", ""), os.getenv("ALPACA_SECRET_KEY", "")
    if not key or not secret:
        raise ValueError("Set ALPACA_API_KEY and ALPACA_SECRET_KEY for an Alpaca paper account")
    return key, secret
