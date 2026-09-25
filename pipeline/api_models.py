"""Strict HTTP input contracts; broker-specific checks remain in PaperTrader."""

from typing import Annotated, Literal, Required, TypedDict

from pydantic import ConfigDict, Field, NonNegativeFloat, PositiveFloat, TypeAdapter, with_config


@with_config(ConfigDict(strict=True, extra="forbid", allow_inf_nan=False))
class ConfigPayload(TypedDict, total=False):
    symbol: str
    trading_enabled: bool
    active_timeframes: Annotated[list[str], Field(min_length=1)]
    capital: PositiveFloat
    max_wallet_position_pct: Annotated[float, Field(gt=0, le=1)]
    risk_appetite: Literal["conservative", "balanced", "aggressive"]
    typesafe_api_key: str


@with_config(ConfigDict(strict=True, extra="forbid", allow_inf_nan=False))
class OrderPayload(TypedDict, total=False):
    action: Required[Literal["buy", "sell", "exit", "update_tp_sl", "cancel"]]
    symbol: str
    order_id: Annotated[str, Field(min_length=1)]
    quantity: PositiveFloat | None
    amount_usd: PositiveFloat | None
    limit_price: PositiveFloat | None
    pct_of_position: Annotated[float, Field(gt=0, le=1)]
    stop_loss_pct: NonNegativeFloat | None
    stop_loss_price: NonNegativeFloat | None
    take_profit_pct: NonNegativeFloat | None
    take_profit_price: NonNegativeFloat | None


CONFIG_PAYLOAD = TypeAdapter(ConfigPayload)
ORDER_PAYLOAD = TypeAdapter(OrderPayload)
