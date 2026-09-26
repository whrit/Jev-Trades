"""Server-side Alpaca paper-account configuration."""

import os
import re
from pathlib import Path
from typing import Self

from alpaca.data.enums import CryptoFeed, DataFeed, OptionsFeed
from dotenv import load_dotenv
from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

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
CRYPTO_SYMBOLS = symbols("ALPACA_CRYPTO_SYMBOLS", "", r"[A-Z][A-Z0-9]{0,19}/USD")
MARKET_SYMBOLS = tuple(dict.fromkeys(STOCK_SYMBOLS + OPTION_UNDERLYINGS + CRYPTO_SYMBOLS))
if os.getenv("ALPACA_OPTION_SYMBOLS", "").strip():
    raise ValueError("Replace ALPACA_OPTION_SYMBOLS with ALPACA_OPTION_UNDERLYINGS (stock tickers)")
STOCK_FEED = DataFeed(os.getenv("ALPACA_STOCK_FEED", "iex"))
OPTION_FEED = OptionsFeed(os.getenv("ALPACA_OPTION_FEED", "indicative"))
CRYPTO_FEED = CryptoFeed.US
# Seconds a quote's timestamp may lag. Alpaca stamps a quote when the top of book changes,
# so a just-fetched crypto quote is the current 24/7 book even when quiet overnight; the
# longer crypto window only guards against a frozen venue. Equity/option quotes keep the
# strict window because an old stamp there means a closed session or halt.
QUOTE_MAX_AGE_SECONDS = 30
CRYPTO_QUOTE_MAX_AGE_SECONDS = 300
if STOCK_FEED not in (DataFeed.IEX, DataFeed.SIP):
    raise ValueError("ALPACA_STOCK_FEED must be iex or sip")
ALLOWED_ORIGINS = set(
    os.getenv("FEED_ALLOWED_ORIGINS", "http://localhost:3000,http://127.0.0.1:3000").split(",")
)


class TradingScope(BaseModel):
    model_config = ConfigDict(frozen=True, extra="forbid", strict=True)

    stock_symbols: tuple[str, ...] = Field(default_factory=lambda: STOCK_SYMBOLS)
    option_underlyings: tuple[str, ...] = Field(default_factory=lambda: OPTION_UNDERLYINGS)
    stock_symbol: str = Field(default_factory=lambda: next(iter(STOCK_SYMBOLS), ""))
    stock_enabled: bool = Field(default_factory=lambda: bool(STOCK_SYMBOLS))
    options_enabled: bool = Field(default_factory=lambda: bool(OPTION_UNDERLYINGS))
    crypto_symbols: tuple[str, ...] = Field(default_factory=lambda: CRYPTO_SYMBOLS)
    # Crypto automation evaluates every watchlist pair, like options scans every underlying.
    crypto_enabled: bool = False

    @field_validator("stock_symbols", "option_underlyings", mode="before")
    @classmethod
    def valid_symbols(cls, values):
        if not isinstance(values, (list, tuple)) or any(not isinstance(s, str) for s in values):
            raise ValueError("Watchlists must contain stock/ETF ticker strings")
        normalized = tuple(dict.fromkeys(s.strip().upper() for s in values))
        if any(not re.fullmatch(r"[A-Z][A-Z0-9.]{0,9}", s) for s in normalized):
            raise ValueError("Use stock/ETF tickers, not option contract symbols")
        return normalized

    @field_validator("crypto_symbols", mode="before")
    @classmethod
    def valid_crypto_symbols(cls, values):
        if not isinstance(values, (list, tuple)) or any(not isinstance(s, str) for s in values):
            raise ValueError("Crypto watchlists must contain BASE/USD pair strings")
        normalized = tuple(dict.fromkeys(s.strip().upper() for s in values))
        if any(not re.fullmatch(r"[A-Z][A-Z0-9]{0,19}/USD", s) for s in normalized):
            raise ValueError("Use USD-quoted crypto pairs such as BTC/USD")
        return normalized

    @field_validator("stock_symbol")
    @classmethod
    def normalize_stock(cls, value: str) -> str:
        return value.strip().upper()

    @model_validator(mode="after")
    def valid_scope(self) -> Self:
        if self.stock_symbol and self.stock_symbol not in self.stock_symbols:
            raise ValueError("Stock strategy symbol must belong to the stock watchlist")
        if self.stock_enabled and not self.stock_symbol:
            raise ValueError("Select a stock strategy symbol or turn stock automation off")
        if self.options_enabled and not self.option_underlyings:
            raise ValueError("Add option underlyings or turn options automation off")
        if self.crypto_enabled and not self.crypto_symbols:
            raise ValueError("Add crypto pairs or turn crypto automation off")
        return self


class OptionPolicy(BaseModel):
    model_config = ConfigDict(frozen=True, extra="forbid", allow_inf_nan=False)

    min_dte: int = Field(default=7, ge=1)
    max_dte: int = Field(default=45, ge=1)
    min_open_interest: int = Field(default=100, ge=1)
    max_open_interest_age_days: int = Field(default=7, ge=0)
    min_quote_size: int = Field(default=1, ge=1)
    max_spread_pct: float = Field(default=0.10, gt=0, le=1)
    max_spread_absolute: float = Field(default=0.50, gt=0)
    max_quote_age_seconds: int = Field(default=30, ge=1, le=30)
    max_candidates: int = Field(default=12, ge=2, le=40)
    max_trade_pct: float = Field(default=0.10, gt=0, le=1)
    max_underlying_pct: float = Field(default=0.25, gt=0, le=1)
    max_total_pct: float = Field(default=0.75, gt=0, le=1)
    max_positions_per_underlying: int = Field(default=10, ge=1)
    min_confidence: float = Field(default=0.60, ge=0, le=1)
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


class CryptoPolicy(BaseModel):
    """Automated crypto entry limits; fractions of min(strategy budget, broker equity)."""

    model_config = ConfigDict(frozen=True, extra="forbid", allow_inf_nan=False)

    max_trade_pct: float = Field(default=0.10, gt=0, le=1)
    max_pair_pct: float = Field(default=0.25, gt=0, le=1)
    max_total_pct: float = Field(default=0.50, gt=0, le=1)
    min_confidence: float = Field(default=0.60, ge=0, le=1)

    @model_validator(mode="after")
    def valid_ranges(self) -> Self:
        if not self.max_trade_pct <= self.max_pair_pct <= self.max_total_pct:
            raise ValueError("Require crypto trade cap <= pair cap <= total cap")
        return self


CRYPTO = CryptoPolicy.model_validate(
    {
        field: os.environ[f"CRYPTO_{field.upper()}"]
        for field in CryptoPolicy.model_fields
        if f"CRYPTO_{field.upper()}" in os.environ
    }
)


def credentials() -> tuple[str, str]:
    key, secret = os.getenv("ALPACA_API_KEY", ""), os.getenv("ALPACA_SECRET_KEY", "")
    if not key or not secret:
        raise ValueError("Set ALPACA_API_KEY and ALPACA_SECRET_KEY for an Alpaca paper account")
    return key, secret
