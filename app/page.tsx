"use client";

import { useEffect, useState } from "react";
import { toast } from "sonner";
import { WarningIcon } from "@phosphor-icons/react";

import { Blotter, type DeskTab } from "@/components/terminal/blotter";
import { ChartPanel } from "@/components/terminal/chart-panel";
import { useConfirm } from "@/components/terminal/confirm";
import { OrderTicket } from "@/components/terminal/order-ticket";
import { SettingsView } from "@/components/terminal/settings-view";
import { StatusBar } from "@/components/terminal/status-bar";
import { SymbolSearch } from "@/components/terminal/symbol-search";
import { TopBar, type Workspace } from "@/components/terminal/top-bar";
import { Watchlist } from "@/components/terminal/watchlist";
import {
  errorText,
  isCryptoTicker,
  money,
  postFeed,
  streamBase,
  type AssetMode,
  type ConfigResult,
  type Snapshot,
} from "@/lib/terminal";
import { cn } from "@/lib/utils";

export default function Home() {
  const confirm = useConfirm();
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [feedError, setFeedError] = useState<string | null>(null);
  const [assetMode, setAssetMode] = useState<AssetMode>("equities");
  const [equitySymbol, setEquitySymbol] = useState("");
  const [cryptoSymbol, setCryptoSymbol] = useState("");
  const symbol = assetMode === "crypto" ? cryptoSymbol : equitySymbol;
  const [workspace, setWorkspace] = useState<Workspace>("terminal");
  const [deskTab, setDeskTab] = useState<DeskTab>("positions");
  const [chartTimeframe, setChartTimeframe] = useState("1m");
  const [tradingEnabled, setTradingEnabled] = useState(false);
  const [automationSaving, setAutomationSaving] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);

  useEffect(() => {
    const source = new EventSource(
      `${streamBase}?symbol=${encodeURIComponent(symbol)}&timeframe=${encodeURIComponent(chartTimeframe)}`,
    );
    source.onmessage = (event) => {
      const next = JSON.parse(event.data) as Snapshot;
      setSnapshot(next);
      setFeedError(null);
      if (!symbol || !next.supported_symbols.includes(symbol)) {
        const match = next.supported_symbols.find(
          (candidate) => isCryptoTicker(candidate) === (assetMode === "crypto"),
        );
        if (match)
          (assetMode === "crypto" ? setCryptoSymbol : setEquitySymbol)(match);
      }
      setTradingEnabled(next.trading_enabled);
    };
    source.onerror = () => {
      setFeedError(
        "Feed connection unavailable. Check that the local feed is running.",
      );
      setSnapshot((current) =>
        current
          ? {
              ...current,
              status: "feed unavailable",
              trading: {
                ...current.trading,
                broker_status: "unavailable",
                broker_error: "Feed connection unavailable",
              },
            }
          : null,
      );
    };
    return () => source.close();
  }, [symbol, chartTimeframe, assetMode]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement;
      const typing =
        target.isContentEditable ||
        ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName);
      if (
        (event.key === "k" && (event.metaKey || event.ctrlKey)) ||
        (event.key === "/" && !typing)
      ) {
        event.preventDefault();
        setSearchOpen((open) => !open);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const mergeConfig = (result: Partial<ConfigResult>) => {
    setSnapshot((current) => {
      if (!current) return current;
      const scope = result.trading_scope;
      return {
        ...current,
        ...(result.settings && {
          settings: {
            ...result.settings,
            chart_timeframe: current.settings.chart_timeframe,
          },
        }),
        ...(result.trading_enabled !== undefined && {
          trading_enabled: result.trading_enabled,
        }),
        ...(scope && { trading_scope: scope }),
        options: current.options && {
          ...current.options,
          ...(scope && { underlyings: scope.option_underlyings }),
          ...(result.option_policy && { policy: result.option_policy }),
        },
      };
    });
    if (result.trading_enabled !== undefined)
      setTradingEnabled(result.trading_enabled);
  };

  const scope = snapshot?.trading_scope;
  const brokerReady = snapshot?.trading.broker_status === "connected";
  const canStart =
    brokerReady &&
    !!scope &&
    !!snapshot?.trading.agent_enabled &&
    (scope.stock_enabled || scope.options_enabled || scope.crypto_enabled);

  const toggleAutomation = async () => {
    if (!snapshot || automationSaving) return;
    const enabled = !tradingEnabled;
    const ok = await confirm(
      enabled
        ? {
            title: "Start paper automation",
            rows: [
              [
                "Options",
                scope?.options_enabled
                  ? scope.option_underlyings.join(", ")
                  : "Off",
              ],
              ["Stock", scope?.stock_enabled ? scope.stock_symbol : "Off"],
              ["Crypto", scope?.crypto_enabled ? scope.crypto_symbol : "Off"],
              ["Applied budget", money(snapshot.settings.capital)],
              ["Evaluation", snapshot.settings.active_timeframes.join(", ")],
            ],
            notes: [
              "One global switch shared by the equities/options and crypto views.",
              "Market indicators, option candidates and portfolio context are sent to TypeSafe. Jev may submit Alpaca paper orders until paused.",
            ],
            action: "Start automation",
          }
        : {
            title: "Pause automation",
            notes: [
              "New automated decisions stop. Existing orders are not canceled.",
              "Protective exits remain active while this feed is running; fills are not guaranteed.",
            ],
            action: "Pause automation",
            tone: "danger",
          },
    );
    if (!ok) return;
    setAutomationSaving(true);
    try {
      mergeConfig(
        await postFeed<ConfigResult>(
          "/config",
          { trading_enabled: enabled },
          "Could not save configuration",
        ),
      );
      toast.success(
        enabled
          ? "Automation started with the saved scope."
          : "Automation paused. Protective exits remain active.",
      );
    } catch (error) {
      toast.error(errorText(error, "Could not save configuration"));
    } finally {
      setAutomationSaving(false);
    }
  };

  const symbolReady =
    snapshot?.symbol === symbol &&
    snapshot?.settings.chart_timeframe === chartTimeframe;
  const price = symbolReady ? (snapshot?.price ?? null) : null;
  const instrument = snapshot?.instruments[symbol];
  const position = snapshot?.trading.account.positions[symbol];
  const symbols = (snapshot?.supported_symbols ?? []).filter(
    (ticker) => isCryptoTicker(ticker) === (assetMode === "crypto"),
  );
  const viewSymbol = (ticker: string) => {
    (assetMode === "crypto" ? setCryptoSymbol : setEquitySymbol)(ticker);
    setWorkspace("terminal");
  };
  const account = snapshot?.trading.account;
  const errors = [
    feedError || snapshot?.trading.broker_error || snapshot?.error,
    snapshot?.trading.monitor_error &&
      `Exit monitor: ${snapshot.trading.monitor_error}`,
    account?.trading_blocked && "Alpaca account is blocked for trading.",
    assetMode === "crypto" &&
      snapshot?.crypto_stream_error &&
      `Crypto stream: ${snapshot.crypto_stream_error}`,
    assetMode === "equities" &&
      snapshot?.stock_stream_error &&
      `Stock stream: ${snapshot.stock_stream_error}`,
    assetMode === "equities" &&
      !!snapshot?.options?.underlyings.length &&
      account?.options_trading_level != null &&
      account.options_trading_level < 2 &&
      `Options trading level ${account.options_trading_level}; long options require level 2.`,
  ].filter(Boolean);
  const onDesk = workspace !== "settings";

  return (
    <div className="flex min-h-dvh flex-col lg:h-dvh">
      <a
        className="sr-only focus:not-sr-only focus:absolute focus:z-50 focus:m-2 focus:rounded-md focus:bg-primary focus:px-3 focus:py-1.5 focus:text-primary-foreground"
        href="#workspace"
      >
        Skip to workspace
      </a>
      <TopBar
        snapshot={snapshot}
        workspace={workspace}
        onWorkspace={(next) => {
          setWorkspace(next);
          if (next === "activity") setDeskTab("decisions");
        }}
        assetMode={assetMode}
        onAssetMode={setAssetMode}
        tradingEnabled={tradingEnabled}
        automationBusy={automationSaving}
        canStart={canStart}
        onToggleAutomation={() => void toggleAutomation()}
      />
      {errors.map((text) => (
        <p
          key={text as string}
          role="alert"
          className="flex items-center gap-2 border-b border-down/20 bg-down/10 px-3 py-1.5 text-down"
        >
          <WarningIcon className="size-3.5 shrink-0" weight="fill" />
          {text}
        </p>
      ))}
      {snapshot && !snapshot.trading.agent_enabled && (
        <p className="border-b bg-card px-3 py-1.5 text-muted-foreground">
          Automation requires a TypeSafe key. Add it in Settings; manual paper
          orders remain available.
        </p>
      )}
      <main id="workspace" className="flex min-h-0 flex-1 flex-col">
        <div
          hidden={!onDesk}
          className={cn(
            "grid min-h-0 flex-1 gap-px bg-border",
            workspace === "terminal"
              ? "grid-cols-1 lg:grid-cols-[15rem_minmax(0,1fr)_19rem] lg:grid-rows-[minmax(0,1fr)_17rem]"
              : "grid-rows-[minmax(0,1fr)]",
          )}
        >
          <Watchlist
            hidden={workspace !== "terminal"}
            className="lg:row-span-2"
            snapshot={snapshot}
            assetMode={assetMode}
            symbol={symbol}
            onView={viewSymbol}
            onEdit={() => setWorkspace("settings")}
          />
          <ChartPanel
            hidden={workspace !== "terminal"}
            snapshot={snapshot}
            symbol={symbol}
            symbolReady={symbolReady}
            price={price}
            instrument={instrument}
            position={position}
            isCrypto={assetMode === "crypto"}
            timeframe={chartTimeframe}
            onTimeframe={setChartTimeframe}
            onOpenSearch={() => setSearchOpen(true)}
          />
          <OrderTicket
            hidden={workspace !== "terminal"}
            className="lg:col-start-3 lg:row-span-2 lg:row-start-1"
            symbol={symbol}
            instrument={instrument}
            price={price}
            isCrypto={assetMode === "crypto"}
            availableCash={snapshot?.trading.account.available_cash ?? 0}
            position={position}
            brokerReady={brokerReady}
          />
          <Blotter
            className={
              workspace === "terminal" ? "lg:col-start-2 lg:row-start-2" : ""
            }
            snapshot={snapshot}
            assetMode={assetMode}
            tab={deskTab}
            onTab={setDeskTab}
            onView={viewSymbol}
          />
        </div>
        <SettingsView
          hidden={workspace !== "settings"}
          snapshot={snapshot}
          assetMode={assetMode}
          tradingEnabled={tradingEnabled}
          onConfigSaved={mergeConfig}
        />
      </main>
      <StatusBar
        snapshot={snapshot}
        assetMode={assetMode}
        lastTick={symbolReady ? (snapshot?.last_tick ?? null) : null}
      />
      <SymbolSearch
        open={searchOpen}
        onOpenChange={setSearchOpen}
        symbols={symbols}
        snapshot={snapshot}
        assetMode={assetMode}
        onSelect={(ticker) => {
          viewSymbol(ticker);
          setSearchOpen(false);
        }}
      />
    </div>
  );
}
