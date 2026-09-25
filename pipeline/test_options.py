"""Offline behavioral checks: no credentials, network, or real broker orders."""

import os
import unittest
from datetime import date, datetime, timedelta, timezone
from typing import Any, cast
from unittest.mock import patch
from uuid import uuid4
from zoneinfo import ZoneInfo

from alpaca.data.enums import OptionsFeed
from alpaca.data.historical import OptionHistoricalDataClient
from alpaca.data.models import OptionsSnapshot
from alpaca.trading.client import TradingClient
from alpaca.trading.enums import AssetStatus, ContractType, ExerciseStyle
from alpaca.trading.models import OptionContract, OptionContractsResponse
from alpaca.trading.requests import GetOptionContractsRequest

with patch.dict(os.environ, {}, clear=True), patch("dotenv.load_dotenv"):
    from pipeline import config, options

NOW = datetime(2027, 3, 10, 15, 0, tzinfo=timezone.utc)
TODAY = NOW.astimezone(ZoneInfo("America/New_York")).date()


def make_contract(
    symbol: str,
    *,
    underlying: str = "AAPL",
    root: str | None = None,
    option_type: ContractType = ContractType.CALL,
    strike: float = 150.0,
    size: str = "100",
    tradable: bool = True,
    status: AssetStatus = AssetStatus.ACTIVE,
    expiration: date | None = None,
    open_interest: str | None = "150",
    open_interest_date: date | None = None,
) -> OptionContract:
    return OptionContract(
        id=str(uuid4()),
        symbol=symbol,
        name=symbol,
        status=status,
        tradable=tradable,
        expiration_date=expiration or TODAY + timedelta(days=20),
        root_symbol=root if root is not None else underlying,
        underlying_symbol=underlying,
        underlying_asset_id=uuid4(),
        type=option_type,
        style=ExerciseStyle.AMERICAN,
        strike_price=strike,
        size=size,
        open_interest=open_interest,
        open_interest_date=(
            open_interest_date if open_interest_date is not None else TODAY - timedelta(days=2)
        ),
        close_price=None,
        close_price_date=None,
    )


def make_snapshot(
    symbol: str,
    *,
    bid: float | None,
    ask: float | None,
    timestamp: datetime | None = None,
    bid_size: float = 10,
    ask_size: float = 10,
    iv: float | None = None,
    greeks: dict[str, float] | None = None,
) -> OptionsSnapshot:
    raw: dict[str, Any] = {}
    if bid is not None and ask is not None:
        raw["latestQuote"] = {
            "t": timestamp or NOW,
            "bp": bid,
            "ap": ask,
            "bs": bid_size,
            "as": ask_size,
        }
    if iv is not None:
        raw["impliedVolatility"] = iv
    if greeks is not None:
        raw["greeks"] = greeks
    return OptionsSnapshot(symbol=symbol, raw_data=raw)


class FakeTrading:
    """Controlled trading boundary: paginates option contracts by page_token index."""

    def __init__(self) -> None:
        self.pages: dict[ContractType, list[OptionContractsResponse]] = {}
        self.contracts_by_symbol: dict[str, OptionContract] = {}
        self.contract_requests: list[GetOptionContractsRequest] = []
        self.lookup_requests: list[str] = []

    def set_pages(self, contract_type: ContractType, pages: list[list[OptionContract]]) -> None:
        responses = []
        for index, page in enumerate(pages):
            token = str(index + 1) if index + 1 < len(pages) else None
            responses.append(OptionContractsResponse(option_contracts=page, next_page_token=token))
        self.pages[contract_type] = responses

    def get_option_contracts(self, request: GetOptionContractsRequest) -> OptionContractsResponse:
        self.contract_requests.append(request)
        pages = self.pages.get(cast(ContractType, request.type))
        if not pages:
            return OptionContractsResponse(option_contracts=[], next_page_token=None)
        index = int(request.page_token) if request.page_token else 0
        return pages[index]

    def get_option_contract(self, symbol: str) -> OptionContract:
        self.lookup_requests.append(symbol)
        if symbol not in self.contracts_by_symbol:
            raise ValueError(f"Unknown contract {symbol}")
        return self.contracts_by_symbol[symbol]


class LoopingTrading:
    """A broker that never terminates pagination."""

    def get_option_contracts(self, request: GetOptionContractsRequest) -> OptionContractsResponse:
        return OptionContractsResponse(option_contracts=[], next_page_token="loop")


class FakeData:
    def __init__(self) -> None:
        self.snapshots: dict[str, OptionsSnapshot] = {}
        self.snapshot_requests: list[list[str]] = []

    def get_option_snapshot(self, request: Any) -> dict[str, OptionsSnapshot]:
        symbols = request.symbol_or_symbols
        symbols = symbols if isinstance(symbols, list) else [symbols]
        self.snapshot_requests.append(list(symbols))
        return {s: self.snapshots[s] for s in symbols if s in self.snapshots}


class DiscoverPaginationTests(unittest.TestCase):
    def test_contracts_on_late_pages_are_not_silently_excluded(self):
        with patch.object(config, "OPTION_FEED", OptionsFeed.OPRA):
            trading, data = FakeTrading(), FakeData()
            contracts = [make_contract(f"AAPL_PAGE_{i}") for i in range(51)]
            trading.set_pages(ContractType.CALL, [[contract] for contract in contracts])
            last = contracts[-1]
            data.snapshots[last.symbol] = make_snapshot(last.symbol, bid=1.99, ask=2)
            result = options.discover_candidates(
                cast(TradingClient, trading),
                cast(OptionHistoricalDataClient, data),
                "AAPL",
                1000,
                now=NOW,
            )
            self.assertEqual([c["symbol"] for c in result["candidates"]], [last.symbol])

    def test_paginates_across_explicit_call_and_put_pages(self):
        with patch.object(config, "OPTION_FEED", OptionsFeed.OPRA):
            trading, data = FakeTrading(), FakeData()
            calls = [
                make_contract(f"AAPL_C{i}", option_type=ContractType.CALL, strike=100 + i)
                for i in range(3)
            ]
            puts = [
                make_contract(f"AAPL_P{i}", option_type=ContractType.PUT, strike=100 + i)
                for i in range(2)
            ]
            trading.set_pages(ContractType.CALL, [calls[:2], calls[2:]])
            trading.set_pages(ContractType.PUT, [puts])
            for contract in calls + puts:
                data.snapshots[contract.symbol] = make_snapshot(contract.symbol, bid=2.00, ask=2.05)
            result = options.discover_candidates(
                cast(TradingClient, trading),
                cast(OptionHistoricalDataClient, data),
                "AAPL",
                1000,
                now=NOW,
            )
            self.assertEqual(result["discovered"], 5)
            self.assertEqual(result["eligible"], 5)
            self.assertEqual(len(result["candidates"]), 5)
            self.assertEqual(result["feed"], "opra")
            self.assertEqual(result["underlying"], "AAPL")
            call_requests = [r for r in trading.contract_requests if r.type == ContractType.CALL]
            put_requests = [r for r in trading.contract_requests if r.type == ContractType.PUT]
            self.assertEqual(len(call_requests), 2)
            self.assertEqual(len(put_requests), 1)

    def test_rejects_pagination_that_does_not_terminate(self):
        with patch.object(config, "OPTION_FEED", OptionsFeed.OPRA):
            trading, data = LoopingTrading(), FakeData()
            with self.assertRaises(ValueError):
                options.discover_candidates(
                    cast(TradingClient, trading),
                    cast(OptionHistoricalDataClient, data),
                    "AAPL",
                    1000,
                    now=NOW,
                )


class DiscoverMetadataFilterTests(unittest.TestCase):
    def test_rejects_ineligible_contract_metadata(self):
        with patch.object(config, "OPTION_FEED", OptionsFeed.OPRA):
            trading, data = FakeTrading(), FakeData()
            not_tradable = make_contract("AAPL_NT", tradable=False)
            too_soon = make_contract("AAPL_SOON", expiration=TODAY + timedelta(days=3))
            too_far = make_contract("AAPL_FAR", expiration=TODAY + timedelta(days=90))
            adjusted_root = make_contract("AAPL_ADJ_ROOT", root="AAPL1")
            adjusted_size = make_contract("AAPL_ADJ_SIZE", size="10")
            thin_oi = make_contract("AAPL_THIN_OI", open_interest="50")
            missing_oi = make_contract("AAPL_NO_OI", open_interest=None)
            stale_oi = make_contract("AAPL_STALE_OI", open_interest_date=TODAY - timedelta(days=10))
            eligible = make_contract("AAPL_OK")
            trading.set_pages(
                ContractType.CALL,
                [
                    [
                        not_tradable,
                        too_soon,
                        too_far,
                        adjusted_root,
                        adjusted_size,
                        thin_oi,
                        missing_oi,
                        stale_oi,
                        eligible,
                    ]
                ],
            )
            trading.set_pages(ContractType.PUT, [[]])
            data.snapshots[eligible.symbol] = make_snapshot(eligible.symbol, bid=2.00, ask=2.05)
            result = options.discover_candidates(
                cast(TradingClient, trading),
                cast(OptionHistoricalDataClient, data),
                "AAPL",
                1000,
                now=NOW,
            )
            self.assertEqual(result["discovered"], 9)
            self.assertEqual(result["eligible"], 1)
            self.assertEqual(result["candidates"][0]["symbol"], "AAPL_OK")
            self.assertEqual(
                result["rejections"],
                {
                    "not_tradable": 1,
                    "dte_out_of_range": 2,
                    "adjusted_contract": 2,
                    "thin_open_interest": 1,
                    "missing_open_interest": 1,
                    "stale_open_interest": 1,
                },
            )


class DiscoverQuoteFilterTests(unittest.TestCase):
    def test_rejects_ineligible_quotes(self):
        with patch.object(config, "OPTION_FEED", OptionsFeed.INDICATIVE):
            trading, data = FakeTrading(), FakeData()
            missing = make_contract("AAPL_MISSING")
            stale = make_contract("AAPL_STALE")
            crossed = make_contract("AAPL_CROSSED")
            wide_pct = make_contract("AAPL_WIDEPCT")
            wide_abs = make_contract("AAPL_WIDEABS")
            thin = make_contract("AAPL_THIN")
            eligible = make_contract("AAPL_OK")
            trading.set_pages(
                ContractType.CALL, [[missing, stale, crossed, wide_pct, wide_abs, thin, eligible]]
            )
            trading.set_pages(ContractType.PUT, [[]])
            data.snapshots[stale.symbol] = make_snapshot(
                stale.symbol, bid=2.00, ask=2.05, timestamp=NOW - timedelta(seconds=61)
            )
            data.snapshots[crossed.symbol] = make_snapshot(crossed.symbol, bid=2.10, ask=2.00)
            data.snapshots[wide_pct.symbol] = make_snapshot(wide_pct.symbol, bid=1.00, ask=1.30)
            data.snapshots[wide_abs.symbol] = make_snapshot(wide_abs.symbol, bid=10.00, ask=10.60)
            data.snapshots[thin.symbol] = make_snapshot(
                thin.symbol, bid=2.00, ask=2.05, bid_size=0.5, ask_size=0.5
            )
            data.snapshots[eligible.symbol] = make_snapshot(eligible.symbol, bid=2.00, ask=2.05)
            result = options.discover_candidates(
                cast(TradingClient, trading),
                cast(OptionHistoricalDataClient, data),
                "AAPL",
                1000,
                now=NOW,
            )
            self.assertEqual(
                result["rejections"],
                {
                    "missing_quote": 1,
                    "stale_quote": 1,
                    "crossed_quote": 1,
                    "wide_spread_pct": 1,
                    "wide_spread_absolute": 1,
                    "thin_quote": 1,
                },
            )
            self.assertEqual(result["eligible"], 1)
            self.assertEqual(result["candidates"][0]["symbol"], "AAPL_OK")


class AffordabilityTests(unittest.TestCase):
    def test_exact_cent_premium_remains_affordable_at_exact_budget(self):
        with patch.object(config, "OPTION_FEED", OptionsFeed.OPRA):
            trading, data = FakeTrading(), FakeData()
            contract = make_contract("AAPL_CENT")
            trading.set_pages(ContractType.CALL, [[contract]])
            data.snapshots[contract.symbol] = make_snapshot(contract.symbol, bid=1.09, ask=1.10)
            result = options.discover_candidates(
                cast(TradingClient, trading),
                cast(OptionHistoricalDataClient, data),
                "AAPL",
                110,
                now=NOW,
            )
            self.assertEqual(
                [(c["limit_price"], c["max_quantity"]) for c in result["candidates"]], [(1.1, 1)]
            )

    def test_applies_multiplier_cents_ceiling_and_budget_caps_to_sizing(self):
        with patch.object(config, "OPTION_FEED", OptionsFeed.OPRA):
            trading, data = FakeTrading(), FakeData()
            contract = make_contract("AAPL_SIZE")
            trading.set_pages(ContractType.CALL, [[contract]])
            trading.set_pages(ContractType.PUT, [[]])
            data.snapshots[contract.symbol] = make_snapshot(
                contract.symbol, bid=1.99, ask=2.001, ask_size=3
            )
            result = options.discover_candidates(
                cast(TradingClient, trading),
                cast(OptionHistoricalDataClient, data),
                "AAPL",
                450,
                now=NOW,
            )
            candidate = result["candidates"][0]
            self.assertEqual(candidate["limit_price"], 2.01)
            self.assertEqual(candidate["cost_per_contract"], 201.0)
            self.assertEqual(
                candidate["max_quantity"], 2
            )  # min(floor(450/201)=2, max_contracts=5, floor(3)=3)

    def test_rejects_contract_unaffordable_within_budget(self):
        with patch.object(config, "OPTION_FEED", OptionsFeed.OPRA):
            trading, data = FakeTrading(), FakeData()
            contract = make_contract("AAPL_EXP")
            trading.set_pages(ContractType.CALL, [[contract]])
            trading.set_pages(ContractType.PUT, [[]])
            data.snapshots[contract.symbol] = make_snapshot(contract.symbol, bid=9.90, ask=10.00)
            result = options.discover_candidates(
                cast(TradingClient, trading),
                cast(OptionHistoricalDataClient, data),
                "AAPL",
                500,
                now=NOW,
            )
            self.assertEqual(result["eligible"], 0)
            self.assertEqual(result["rejections"], {"unaffordable": 1})


class ShortlistTests(unittest.TestCase):
    def test_shortlists_balanced_calls_and_puts_and_reports_full_eligible_count_before_shortlist(
        self,
    ):
        with (
            patch.object(config, "OPTION_FEED", OptionsFeed.OPRA),
            patch.object(config, "OPTIONS", config.OptionPolicy(max_candidates=4)),
        ):
            trading, data = FakeTrading(), FakeData()
            calls = [
                make_contract(f"AAPL_C{i}", option_type=ContractType.CALL, strike=100 + i)
                for i in range(5)
            ]
            puts = [make_contract("AAPL_P0", option_type=ContractType.PUT, strike=100)]
            trading.set_pages(ContractType.CALL, [calls])
            trading.set_pages(ContractType.PUT, [puts])
            for contract in calls + puts:
                data.snapshots[contract.symbol] = make_snapshot(contract.symbol, bid=2.00, ask=2.05)
            result = options.discover_candidates(
                cast(TradingClient, trading),
                cast(OptionHistoricalDataClient, data),
                "AAPL",
                1000,
                now=NOW,
            )
            # 6 contracts pass every filter; eligible reflects that even though the shortlist caps at 4.
            self.assertEqual(result["eligible"], 6)
            self.assertEqual(len(result["candidates"]), 4)
            self.assertEqual(
                [c["symbol"] for c in result["candidates"]],
                ["AAPL_C0", "AAPL_P0", "AAPL_C1", "AAPL_C2"],
            )


class IndicativeFeedTests(unittest.TestCase):
    def test_indicative_revalidation_rejects_quotes_that_age_after_discovery(self):
        with patch.object(config, "OPTION_FEED", OptionsFeed.INDICATIVE):
            trading, data = FakeTrading(), FakeData()
            contract = make_contract("AAPL_INDICATIVE")
            trading.set_pages(ContractType.CALL, [[contract]])
            trading.contracts_by_symbol[contract.symbol] = contract
            data.snapshots[contract.symbol] = make_snapshot(contract.symbol, bid=2, ask=2.05)
            broker = cast(TradingClient, trading)
            quotes = cast(OptionHistoricalDataClient, data)
            scan = options.discover_candidates(broker, quotes, "AAPL", 1000, now=NOW)
            self.assertEqual([c["symbol"] for c in scan["candidates"]], [contract.symbol])
            candidate = options.validate_candidate(
                broker, quotes, contract.symbol, "AAPL", 1000, now=NOW
            )
            self.assertEqual(candidate["max_quantity"], 4)
            with self.assertRaises(ValueError):
                options.validate_candidate(
                    broker, quotes, contract.symbol, "AAPL", 1000, now=NOW + timedelta(seconds=31)
                )


class ValidateCandidateTests(unittest.TestCase):
    def test_quotes_aging_out_during_fetch_are_rejected(self):
        with patch.object(config, "OPTION_FEED", OptionsFeed.OPRA):
            trading, data = FakeTrading(), FakeData()
            contract = make_contract("AAPL_AGING")
            trading.contracts_by_symbol[contract.symbol] = contract
            data.snapshots[contract.symbol] = make_snapshot(
                contract.symbol, bid=1.99, ask=2, timestamp=NOW - timedelta(seconds=29)
            )
            with patch("pipeline.options.datetime", wraps=datetime) as clock:
                clock.now.side_effect = [NOW, NOW + timedelta(seconds=2)]
                with self.assertRaises(ValueError):
                    options.validate_candidate(
                        cast(TradingClient, trading),
                        cast(OptionHistoricalDataClient, data),
                        contract.symbol,
                        "AAPL",
                        1000,
                    )

    def test_broker_cannot_substitute_a_different_contract_on_same_underlying(self):
        with patch.object(config, "OPTION_FEED", OptionsFeed.OPRA):
            trading, data = FakeTrading(), FakeData()
            returned = make_contract("AAPL_RETURNED")
            trading.contracts_by_symbol["AAPL_REQUESTED"] = returned
            data.snapshots[returned.symbol] = make_snapshot(returned.symbol, bid=1.99, ask=2)
            with self.assertRaises(ValueError):
                options.validate_candidate(
                    cast(TradingClient, trading),
                    cast(OptionHistoricalDataClient, data),
                    "AAPL_REQUESTED",
                    "AAPL",
                    1000,
                    now=NOW,
                )

    def test_rejects_symbol_whose_broker_underlying_does_not_match_requested_underlying(self):
        with patch.object(config, "OPTION_FEED", OptionsFeed.OPRA):
            trading, data = FakeTrading(), FakeData()
            mismatched = make_contract("SPY270115C00600000", underlying="SPY", root="SPY")
            trading.contracts_by_symbol[mismatched.symbol] = mismatched
            with self.assertRaises(ValueError):
                options.validate_candidate(
                    cast(TradingClient, trading),
                    cast(OptionHistoricalDataClient, data),
                    mismatched.symbol,
                    "AAPL",
                    1000,
                    now=NOW,
                )

    def test_rejects_symbol_that_fails_current_eligibility_checks(self):
        with patch.object(config, "OPTION_FEED", OptionsFeed.OPRA):
            trading, data = FakeTrading(), FakeData()
            contract = make_contract("AAPL270115C00150000", tradable=False)
            trading.contracts_by_symbol[contract.symbol] = contract
            with self.assertRaises(ValueError):
                options.validate_candidate(
                    cast(TradingClient, trading),
                    cast(OptionHistoricalDataClient, data),
                    contract.symbol,
                    "AAPL",
                    1000,
                    now=NOW,
                )

    def test_rejects_ask_price_drift_beyond_tolerance_and_accepts_within_tolerance(self):
        with patch.object(config, "OPTION_FEED", OptionsFeed.OPRA):
            trading, data = FakeTrading(), FakeData()
            contract = make_contract("AAPL270115C00150000")
            trading.contracts_by_symbol[contract.symbol] = contract
            data.snapshots[contract.symbol] = make_snapshot(contract.symbol, bid=1.99, ask=2.10)
            with self.assertRaises(ValueError):
                options.validate_candidate(
                    cast(TradingClient, trading),
                    cast(OptionHistoricalDataClient, data),
                    contract.symbol,
                    "AAPL",
                    1000,
                    expected_price=2.00,
                    now=NOW,
                )
            candidate = options.validate_candidate(
                cast(TradingClient, trading),
                cast(OptionHistoricalDataClient, data),
                contract.symbol,
                "AAPL",
                1000,
                expected_price=2.06,
                now=NOW,
            )
            self.assertEqual(candidate["symbol"], contract.symbol)
            self.assertEqual(candidate["ask"], 2.10)


if __name__ == "__main__":
    unittest.main()
