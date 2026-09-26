"""Strict HTTP input contracts; broker-specific checks remain in PaperTrader."""

from typing import Annotated, Literal, Required, TypedDict

from pydantic import ConfigDict, Field, NonNegativeFloat, PositiveFloat, TypeAdapter, with_config


@with_config(ConfigDict(strict=True, extra="forbid", allow_inf_nan=False))
class OptionPolicyPatch(TypedDict, total=False):
    max_trade_pct: Annotated[float, Field(gt=0, le=1)]
    max_underlying_pct: Annotated[float, Field(gt=0, le=1)]
    max_total_pct: Annotated[float, Field(gt=0, le=1)]
    max_positions_per_underlying: Annotated[int, Field(ge=1)]
    max_contracts: Annotated[int, Field(ge=1)]
    min_confidence: Annotated[float, Field(ge=0, le=1)]


@with_config(ConfigDict(strict=True, extra="forbid", allow_inf_nan=False))
class CryptoPolicyPatch(TypedDict, total=False):
    max_trade_pct: Annotated[float, Field(gt=0, le=1)]
    max_pair_pct: Annotated[float, Field(gt=0, le=1)]
    max_total_pct: Annotated[float, Field(gt=0, le=1)]
    min_confidence: Annotated[float, Field(ge=0, le=1)]


@with_config(ConfigDict(strict=True, extra="forbid"))
class TradingScopePatch(TypedDict, total=False):
    stock_symbols: list[str]
    option_underlyings: list[str]
    stock_symbol: str
    stock_enabled: bool
    options_enabled: bool
    crypto_symbols: list[str]
    crypto_enabled: bool


@with_config(ConfigDict(strict=True, extra="forbid", allow_inf_nan=False))
class ConfigPayload(TypedDict, total=False):
    trading_scope: TradingScopePatch
    trading_enabled: bool
    active_timeframes: Annotated[list[str], Field(min_length=1)]
    capital: PositiveFloat
    max_wallet_position_pct: Annotated[float, Field(gt=0, le=1)]
    risk_appetite: Literal["conservative", "balanced", "aggressive"]
    crypto_risk_appetite: Literal["conservative", "balanced", "aggressive"]
    typesafe_api_key: str
    option_policy: OptionPolicyPatch
    crypto_policy: CryptoPolicyPatch


@with_config(ConfigDict(strict=True, extra="forbid", allow_inf_nan=False))
class OrderPayload(TypedDict, total=False):
    action: Required[Literal["buy", "sell", "exit", "update_tp_sl", "cancel"]]
    symbol: str
    order_id: Annotated[str, Field(min_length=1)]
    quantity: PositiveFloat | None
    amount_usd: PositiveFloat | None
    limit_price: PositiveFloat | None
    stop_price: PositiveFloat | None
    time_in_force: Literal["gtc", "ioc"] | None
    pct_of_position: Annotated[float, Field(gt=0, le=1)]
    stop_loss_pct: NonNegativeFloat | None
    stop_loss_price: NonNegativeFloat | None
    take_profit_pct: NonNegativeFloat | None
    take_profit_price: NonNegativeFloat | None


CONFIG_PAYLOAD = TypeAdapter(ConfigPayload)
ORDER_PAYLOAD = TypeAdapter(OrderPayload)
