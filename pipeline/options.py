"""Alpaca option discovery, eligibility filtering, and pre-trade re-verification.

`option_instrument` reports contract metadata for any contract, tradable or not.
`discover_candidates` and `validate_candidate` apply the same entry-eligibility
policy to the configured OPRA or indicative feed for paper trading.
"""

from __future__ import annotations

import math
from datetime import date, datetime, timedelta, timezone
from decimal import ROUND_CEILING, Decimal
from typing import Any, cast
from zoneinfo import ZoneInfo

from alpaca.data.historical import OptionHistoricalDataClient
from alpaca.data.models import OptionsSnapshot, Quote
from alpaca.data.requests import OptionSnapshotRequest
from alpaca.trading.client import TradingClient
from alpaca.trading.enums import AssetStatus, ContractType
from alpaca.trading.models import OptionContract, OptionContractsResponse
from alpaca.trading.requests import GetOptionContractsRequest

if __package__:
    from . import config
else:
    import config

NY = ZoneInfo("America/New_York")
STANDARD_SIZE = 100.0
CONTRACT_PAGE_LIMIT = 100

SNAPSHOT_BATCH_SIZE = 50


def option_instrument(contract: OptionContract) -> dict[str, Any]:
    """Verified contract metadata. Works for expired/nontradable contracts; never filters."""
    return {
        "asset_class": "us_option",
        "underlying": contract.underlying_symbol,
        "expiration": contract.expiration_date.isoformat(),
        "option_type": contract.type.value,
        "strike": float(contract.strike_price),
        "multiplier": float(contract.size),
        "tradable": contract.tradable and contract.status == AssetStatus.ACTIVE,
        "fractionable": False,
    }


def _normalize(now: datetime | None) -> datetime:
    moment = now or datetime.now(timezone.utc)
    return moment if moment.tzinfo is not None else moment.replace(tzinfo=timezone.utc)


def _to_float(value: str | None) -> float | None:
    if value is None:
        return None
    try:
        parsed = float(value)
    except ValueError:
        return None
    return parsed if math.isfinite(parsed) else None


def _fetch_contracts(
    trading: TradingClient, underlying: str, expiry_gte: date, expiry_lte: date
) -> list[OptionContract]:
    contracts: dict[str, OptionContract] = {}
    for contract_type in (ContractType.CALL, ContractType.PUT):
        page_token: str | None = None
        seen_tokens: set[str] = set()
        while True:
            request = GetOptionContractsRequest(
                underlying_symbols=[underlying],
                status=AssetStatus.ACTIVE,
                type=contract_type,
                expiration_date_gte=expiry_gte,
                expiration_date_lte=expiry_lte,
                limit=CONTRACT_PAGE_LIMIT,
                page_token=page_token,
            )
            response = cast(OptionContractsResponse, trading.get_option_contracts(request))
            contracts.update(
                (contract.symbol, contract) for contract in response.option_contracts or []
            )
            page_token = response.next_page_token
            if page_token is None:
                break
            if page_token in seen_tokens:
                raise ValueError(
                    f"Option contract pagination for {underlying} {contract_type.value}s repeated a page token"
                )
            seen_tokens.add(page_token)
    return list(contracts.values())


def _metadata_rejection(
    contract: OptionContract, underlying: str, today: date, policy: config.OptionPolicy
) -> str | None:
    if contract.underlying_symbol != underlying:
        return "wrong_underlying"
    if not (contract.tradable and contract.status == AssetStatus.ACTIVE):
        return "not_tradable"
    dte = (contract.expiration_date - today).days
    if not (policy.min_dte <= dte <= policy.max_dte):
        return "dte_out_of_range"
    size = _to_float(contract.size)
    if contract.root_symbol != underlying or size is None or size != STANDARD_SIZE:
        return "adjusted_contract"
    strike = contract.strike_price
    if strike is None or not math.isfinite(strike) or strike <= 0:
        return "invalid_strike"
    open_interest = _to_float(contract.open_interest)
    if open_interest is None or contract.open_interest_date is None:
        return "missing_open_interest"
    if open_interest < policy.min_open_interest:
        return "thin_open_interest"
    window_start = today - timedelta(days=policy.max_open_interest_age_days)
    if not (window_start <= contract.open_interest_date <= today):
        return "stale_open_interest"
    return None


def _quote_rejection(
    quote: Quote | None, now_epoch: float, policy: config.OptionPolicy
) -> str | None:
    if quote is None:
        return "missing_quote"
    age = now_epoch - quote.timestamp.timestamp()
    if not (-5 <= age <= policy.max_quote_age_seconds):
        return "stale_quote"
    bid, ask, bid_size, ask_size = quote.bid_price, quote.ask_price, quote.bid_size, quote.ask_size
    if not all(math.isfinite(v) for v in (bid, ask, bid_size, ask_size)) or bid <= 0 or ask <= 0:
        return "invalid_quote"
    if bid > ask:
        return "crossed_quote"
    if bid_size < policy.min_quote_size or ask_size < policy.min_quote_size:
        return "thin_quote"
    mid = (bid + ask) / 2
    if (ask - bid) / mid > policy.max_spread_pct:
        return "wide_spread_pct"
    if (ask - bid) > policy.max_spread_absolute:
        return "wide_spread_absolute"
    return None


def _build_candidate(
    contract: OptionContract,
    quote: Quote,
    snapshot: OptionsSnapshot,
    budget: float,
    policy: config.OptionPolicy,
) -> dict[str, Any] | None:
    open_interest = _to_float(contract.open_interest)
    if open_interest is None or contract.open_interest_date is None:
        return None
    multiplier = float(contract.size)
    limit_price = float(
        Decimal(str(quote.ask_price)).quantize(Decimal("0.01"), rounding=ROUND_CEILING)
    )
    cost_per_contract = round(limit_price * multiplier, 2)
    if cost_per_contract <= 0 or cost_per_contract > budget:
        return None
    max_quantity = min(
        math.floor(budget / cost_per_contract), policy.max_contracts, math.floor(quote.ask_size)
    )
    if max_quantity < 1:
        return None
    greeks = snapshot.greeks
    iv = snapshot.implied_volatility
    return {
        **option_instrument(contract),
        "symbol": contract.symbol,
        "bid": quote.bid_price,
        "ask": quote.ask_price,
        "bid_size": quote.bid_size,
        "ask_size": quote.ask_size,
        "spread_pct": (quote.ask_price - quote.bid_price)
        / ((quote.ask_price + quote.bid_price) / 2),
        "quote_time": quote.timestamp.timestamp(),
        "open_interest": int(open_interest),
        "open_interest_date": contract.open_interest_date.isoformat(),
        "limit_price": limit_price,
        "cost_per_contract": cost_per_contract,
        "max_quantity": max_quantity,
        "greeks": None
        if greeks is None
        else {
            "delta": greeks.delta if math.isfinite(greeks.delta) else None,
            "gamma": greeks.gamma if math.isfinite(greeks.gamma) else None,
            "rho": greeks.rho if math.isfinite(greeks.rho) else None,
            "theta": greeks.theta if math.isfinite(greeks.theta) else None,
            "vega": greeks.vega if math.isfinite(greeks.vega) else None,
        },
        "implied_volatility": iv if iv is not None and math.isfinite(iv) else None,
    }


def _evaluate_quotes(
    data: OptionHistoricalDataClient,
    contracts: list[OptionContract],
    budget: float,
    policy: config.OptionPolicy,
    moment: datetime | None,
    rejections: dict[str, int],
) -> list[dict[str, Any]]:
    candidates: list[dict[str, Any]] = []

    for start in range(0, len(contracts), SNAPSHOT_BATCH_SIZE):
        batch = contracts[start : start + SNAPSHOT_BATCH_SIZE]
        snapshots = cast(
            dict[str, OptionsSnapshot],
            data.get_option_snapshot(
                OptionSnapshotRequest(
                    symbol_or_symbols=[c.symbol for c in batch], feed=config.OPTION_FEED
                )
            ),
        )
        now_epoch = (moment or datetime.now(timezone.utc)).timestamp()
        for contract in batch:
            snapshot = snapshots.get(contract.symbol)
            quote = snapshot.latest_quote if snapshot else None
            reason = _quote_rejection(quote, now_epoch, policy)
            if reason:
                rejections[reason] = rejections.get(reason, 0) + 1
                continue
            candidate = _build_candidate(
                contract, cast(Quote, quote), cast(OptionsSnapshot, snapshot), budget, policy
            )
            if candidate is None:
                rejections["unaffordable"] = rejections.get("unaffordable", 0) + 1
                continue
            candidates.append(candidate)
    return candidates


def _rank_key(candidate: dict[str, Any]) -> tuple[float, float, str, float]:
    return (
        candidate["spread_pct"],
        -candidate["open_interest"],
        candidate["expiration"],
        candidate["strike"],
    )


def _shortlist(candidates: list[dict[str, Any]], max_candidates: int) -> list[dict[str, Any]]:
    calls = sorted((c for c in candidates if c["option_type"] == "call"), key=_rank_key)
    puts = sorted((c for c in candidates if c["option_type"] == "put"), key=_rank_key)
    shortlist: list[dict[str, Any]] = []
    i = j = 0
    while len(shortlist) < max_candidates and (i < len(calls) or j < len(puts)):
        if i < len(calls):
            shortlist.append(calls[i])
            i += 1
        if len(shortlist) < max_candidates and j < len(puts):
            shortlist.append(puts[j])
            j += 1
    return shortlist


def discover_candidates(
    trading: TradingClient,
    data: OptionHistoricalDataClient,
    underlying: str,
    budget: float,
    now: datetime | None = None,
) -> dict[str, Any]:
    """Discover, verify, and rank tradable contracts for one underlying.

    `eligible` counts every contract that passed all filters, before the
    balanced call/put shortlist truncates `candidates` to `max_candidates`.
    """

    policy = config.OPTIONS
    moment = _normalize(now)
    today = moment.astimezone(NY).date()
    contracts = _fetch_contracts(
        trading,
        underlying,
        today + timedelta(days=policy.min_dte),
        today + timedelta(days=policy.max_dte),
    )
    rejections: dict[str, int] = {}
    survivors: list[OptionContract] = []
    for contract in contracts:
        reason = _metadata_rejection(contract, underlying, today, policy)
        if reason is None:
            survivors.append(contract)
        else:
            rejections[reason] = rejections.get(reason, 0) + 1
    candidates = _evaluate_quotes(
        data, survivors, budget, policy, moment if now is not None else None, rejections
    )
    return {
        "candidates": _shortlist(candidates, policy.max_candidates),
        "discovered": len(contracts),
        "eligible": len(candidates),
        "rejections": rejections,
        "as_of": moment.timestamp(),
        "underlying": underlying,
        "feed": config.OPTION_FEED.value,
    }


def validate_candidate(
    trading: TradingClient,
    data: OptionHistoricalDataClient,
    symbol: str,
    underlying: str,
    budget: float,
    expected_price: float | None = None,
    now: datetime | None = None,
) -> dict[str, Any]:
    """Refetch `symbol` from the broker and re-apply every discovery filter before execution.

    Never trusts an AI-selected symbol's claimed underlying/type/strike: the contract is
    refetched from the broker and its `underlying_symbol` is checked against `underlying`.
    """

    policy = config.OPTIONS
    moment = _normalize(now)
    today = moment.astimezone(NY).date()
    contract = cast(OptionContract, trading.get_option_contract(symbol))
    if contract.symbol != symbol:
        raise ValueError(f"Broker returned a different contract than {symbol}")
    if contract.underlying_symbol != underlying:
        raise ValueError(f"{symbol} does not belong to underlying {underlying}")
    reason = _metadata_rejection(contract, underlying, today, policy)
    if reason is not None:
        raise ValueError(f"{symbol} is no longer eligible: {reason}")
    rejections: dict[str, int] = {}
    candidates = _evaluate_quotes(
        data, [contract], budget, policy, moment if now is not None else None, rejections
    )
    if not candidates:
        raise ValueError(f"{symbol} is no longer eligible: {next(iter(rejections), 'ineligible')}")
    candidate = candidates[0]
    if expected_price is not None and candidate["ask"] > expected_price * (
        1 + policy.max_price_drift_pct
    ):
        raise ValueError(f"{symbol} ask price drifted beyond the allowed tolerance since discovery")
    return candidate
