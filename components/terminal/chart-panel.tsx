"use client";

import dynamic from "next/dynamic";
import { useState, type ReactNode } from "react";
import { CaretDownIcon, SlidersHorizontalIcon } from "@phosphor-icons/react";

import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Kbd } from "@/components/ui/kbd";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import {
  age,
  decimalsFromIncrement,
  indicatorGroups,
  indicatorLabel,
  money,
  overlaySeriesKey,
  periodColors,
  priceDecimals,
  TIMEFRAMES,
  type Instrument,
  type Position,
  type Snapshot,
} from "@/lib/terminal";
import { cn } from "@/lib/utils";

const MarketChart = dynamic(() => import("./market-chart"), { ssr: false });

/** Moving averages the feed ships as full series are drawn on the chart. */
const maOverlay = (key: string) => {
  const match = /^(ema|sma)_(\d+)$/.exec(key);
  return match && periodColors[match[2]]
    ? {
        series: overlaySeriesKey(key),
        color: periodColors[match[2]],
        dashed: match[1] === "sma",
      }
    : null;
};

export function ChartPanel({
  snapshot,
  symbol,
  symbolReady,
  price,
  instrument,
  position,
  isCrypto,
  timeframe,
  onTimeframe,
  onOpenSearch,
  hidden,
}: {
  snapshot: Snapshot | null;
  symbol: string;
  symbolReady: boolean;
  price: number | null;
  instrument?: Instrument;
  position?: Position;
  isCrypto: boolean;
  timeframe: string;
  onTimeframe: (timeframe: string) => void;
  onOpenSearch: () => void;
  hidden?: boolean;
}) {
  const [indicators, setIndicators] = useState([
    "ema_20",
    "sma_50",
    "relative_strength_index_14",
    "macd_level_12_26",
  ]);
  const toggle = (list: string[], name: string) =>
    list.includes(name)
      ? list.filter((item) => item !== name)
      : [...list, name];
  const overlays = indicators.flatMap((key) => {
    const overlay = maOverlay(key);
    return overlay && snapshot?.indicator_series[overlay.series]
      ? [overlay]
      : [];
  });

  const firstOpen = symbolReady ? snapshot?.bars[0]?.open : undefined;
  const change =
    price && firstOpen ? ((price - firstOpen) / firstOpen) * 100 : null;
  const cryptoIncrement = isCrypto
    ? (instrument?.price_increment ??
      (price && price < 1 ? 0.00000001 : price && price < 100 ? 0.0001 : 0.01))
    : undefined;
  const priceFormat = cryptoIncrement
    ? {
        minMove: cryptoIncrement,
        precision: decimalsFromIncrement(cryptoIncrement, 8),
      }
    : undefined;
  const kind =
    instrument?.asset_class === "us_option"
      ? `${instrument.option_type ?? "option"} · exp ${instrument.expiration ?? "--"}`
      : isCrypto
        ? "crypto · 24/7"
        : "equity";

  return (
    <section
      hidden={hidden}
      aria-label="Price chart"
      className="flex min-h-[30rem] min-w-0 flex-col bg-card lg:min-h-0"
    >
      <div className="flex min-h-10 shrink-0 flex-wrap items-center gap-x-4 gap-y-1 border-b px-2 py-1">
        <button
          type="button"
          onClick={onOpenSearch}
          title="Change chart symbol (viewing only; does not change strategy)"
          className="flex h-7 items-center gap-1.5 rounded-md px-1.5 font-mono text-sm font-semibold transition-colors hover:bg-accent"
        >
          {symbol || "Select symbol"}
          <CaretDownIcon className="size-3 text-muted-foreground" />
          <Kbd className="ml-1 hidden sm:inline-flex">/</Kbd>
        </button>
        <span className="text-[0.6875rem] text-muted-foreground capitalize">
          {kind}
        </span>
        <div className="flex items-baseline gap-2 font-mono">
          <LastPrice
            price={price}
            text={money(price, priceDecimals(instrument))}
          />
          <span
            className={cn(
              "text-xs",
              change == null
                ? "text-muted-foreground"
                : change >= 0
                  ? "text-up"
                  : "text-down",
            )}
            title="Change over loaded bars"
          >
            {change == null
              ? "awaiting quote"
              : `${change >= 0 ? "+" : ""}${change.toFixed(2)}%`}
          </span>
          {symbolReady && snapshot && (
            <span
              className={cn(
                "text-[0.6875rem]",
                snapshot.status === "live" ? "text-up" : "text-warn",
              )}
              title={
                snapshot.error ??
                (isCrypto
                  ? "Crypto quotes are current until the book changes; orders refuse quotes older than 5 minutes"
                  : "Orders refuse quotes older than 30 seconds")
              }
            >
              {snapshot.status}
              {snapshot.status !== "live" &&
                snapshot.last_tick != null &&
                ` ${age(snapshot.server_time - snapshot.last_tick)}`}
            </span>
          )}
        </div>
        <div className="ml-auto flex items-center gap-1">
          <ToggleGroup
            type="single"
            size="sm"
            spacing={0}
            value={timeframe}
            onValueChange={(value) => value && onTimeframe(value)}
            aria-label="Chart interval"
          >
            {TIMEFRAMES.map((tf) => (
              <ToggleGroupItem
                key={tf}
                value={tf}
                className="font-mono data-[state=on]:text-primary"
              >
                {tf}
              </ToggleGroupItem>
            ))}
          </ToggleGroup>
          <Popover>
            <PopoverTrigger asChild>
              <Button variant="ghost" size="sm">
                <SlidersHorizontalIcon data-icon="inline-start" />
                Indicators
                <span className="font-mono text-muted-foreground">
                  {indicators.length}
                </span>
              </Button>
            </PopoverTrigger>
            <PopoverContent
              align="end"
              className="max-h-[70dvh] w-72 overflow-y-auto p-0"
            >
              {indicatorGroups.map((group) => (
                <PickerGroup key={group.title} title={group.title}>
                  {group.items.map(([key, label]) => (
                    <PickerItem
                      key={key}
                      label={label}
                      checked={indicators.includes(key)}
                      onChange={() =>
                        setIndicators((list) => toggle(list, key))
                      }
                      swatch={maOverlay(key)?.color}
                      dashed={maOverlay(key)?.dashed}
                    />
                  ))}
                </PickerGroup>
              ))}
            </PopoverContent>
          </Popover>
        </div>
      </div>
      <div className="relative min-h-0 flex-1">
        {snapshot && symbolReady && symbol ? (
          <MarketChart
            key={symbol}
            bars={snapshot.bars}
            indicatorSeries={snapshot.indicator_series}
            overlays={overlays}
            position={position}
            priceFormat={priceFormat}
          />
        ) : (
          <div className="absolute inset-0 flex items-center justify-center text-muted-foreground">
            {snapshot
              ? symbol
                ? `Loading ${symbol} ${timeframe}…`
                : "Select a ticker to view its chart."
              : "Connecting to the market feed…"}
          </div>
        )}
      </div>
      <dl className="flex h-7 shrink-0 items-center gap-4 overflow-x-auto border-t px-3 whitespace-nowrap">
        {indicators.map((key) => {
          const value = symbolReady ? snapshot?.indicators[key] : null;
          return (
            <div key={key} className="flex items-baseline gap-1.5">
              <dt className="text-muted-foreground">{indicatorLabel(key)}</dt>
              <dd className="font-mono">
                {value == null
                  ? "warming"
                  : value.toLocaleString(undefined, {
                      maximumFractionDigits:
                        isCrypto && Math.abs(value) < 1
                          ? Math.max(2, priceDecimals(instrument))
                          : 2,
                    })}
              </dd>
            </div>
          );
        })}
        {!indicators.length && (
          <span className="text-muted-foreground">No indicators selected</span>
        )}
      </dl>
    </section>
  );
}

/** Last price that tints blue/red for a moment whenever it ticks. */
function LastPrice({ price, text }: { price: number | null; text: string }) {
  const [previous, setPrevious] = useState(price);
  const [direction, setDirection] = useState(0);
  if (price !== previous) {
    setDirection(
      price != null && previous != null ? Math.sign(price - previous) : 0,
    );
    setPrevious(price);
  }
  return (
    <span
      key={text}
      className={cn(
        "rounded-sm px-1 text-base font-semibold",
        direction > 0 && "tick-up",
        direction < 0 && "tick-down",
      )}
    >
      {text}
    </span>
  );
}

function PickerGroup({
  title,
  children,
}: {
  title: string;
  children: ReactNode;
}) {
  return (
    <div className="border-b p-2 last:border-b-0">
      <h3 className="px-1 pb-1 text-[0.625rem] font-medium tracking-wide text-muted-foreground uppercase">
        {title}
      </h3>
      <div className="grid grid-cols-2">{children}</div>
    </div>
  );
}

function PickerItem({
  label,
  checked,
  onChange,
  swatch,
  dashed,
}: {
  label: string;
  checked: boolean;
  onChange: () => void;
  swatch?: string;
  dashed?: boolean;
}) {
  return (
    <label className="flex h-7 cursor-pointer items-center gap-2 rounded-sm px-1 hover:bg-accent">
      <Checkbox checked={checked} onCheckedChange={onChange} />
      {label}
      {swatch && (
        <span
          aria-hidden
          title="Drawn on chart"
          className={cn(
            "mr-1 ml-auto w-3 border-t-2",
            dashed && "border-dashed",
          )}
          style={{ borderColor: swatch }}
        />
      )}
    </label>
  );
}
