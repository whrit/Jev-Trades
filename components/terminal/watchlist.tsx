"use client";

import { useState, type ReactNode } from "react";
import { CaretRightIcon, PencilSimpleIcon } from "@phosphor-icons/react";

import { Empty, PanelHeader } from "@/components/terminal/panel";
import { Button } from "@/components/ui/button";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import {
  clock,
  isCryptoTicker,
  money,
  qty,
  type AssetMode,
  type OptionScan,
  type Snapshot,
} from "@/lib/terminal";
import { cn } from "@/lib/utils";

export function Watchlist({
  snapshot,
  assetMode,
  symbol,
  onView,
  onEdit,
  className,
  hidden,
}: {
  snapshot: Snapshot | null;
  assetMode: AssetMode;
  symbol: string;
  onView: (ticker: string) => void;
  onEdit: () => void;
  className?: string;
  hidden?: boolean;
}) {
  const scope = snapshot?.trading_scope;
  const held = Object.entries(snapshot?.trading.account.positions ?? {}).filter(
    ([ticker, position]) =>
      position.quantity > 0 &&
      (assetMode === "crypto"
        ? isCryptoTicker(ticker)
        : position.asset_class === "us_option"),
  );
  const row = (ticker: string) => ({
    selected: symbol === ticker,
    onClick: () => onView(ticker),
  });

  return (
    <aside
      hidden={hidden}
      aria-label={
        assetMode === "crypto" ? "Crypto watchlist" : "Options watchlist"
      }
      className={cn("flex min-h-0 flex-col bg-card", className)}
    >
      <PanelHeader title="Watchlist">
        <Button
          variant="ghost"
          size="icon-sm"
          onClick={onEdit}
          aria-label="Edit watchlist"
          title="Edit watchlist"
        >
          <PencilSimpleIcon />
        </Button>
      </PanelHeader>
      <div className="min-h-0 flex-1 overflow-y-auto pb-2">
        {assetMode === "crypto" ? (
          <>
            <Group title="Pairs" enabled={scope?.crypto_enabled}>
              {scope?.crypto_symbols.length ? (
                scope.crypto_symbols.map((ticker) => (
                  <Row key={ticker} {...row(ticker)} label={ticker}>
                    {scope.crypto_enabled && scope.crypto_symbol === ticker ? (
                      <span className="text-primary">Strategy</span>
                    ) : (
                      "24/7"
                    )}
                  </Row>
                ))
              ) : (
                <Empty>Add pairs in Settings.</Empty>
              )}
            </Group>
            {!!held.length && (
              <Group title="Held">
                {held.map(([ticker, position]) => (
                  <Row key={ticker} {...row(ticker)} label={ticker}>
                    {qty(position.quantity, snapshot?.instruments[ticker])}
                  </Row>
                ))}
              </Group>
            )}
          </>
        ) : (
          <>
            <Group title="Options" enabled={scope?.options_enabled}>
              {snapshot?.options?.underlyings.length ? (
                snapshot.options.underlyings.map((underlying) => (
                  <OptionRow
                    key={underlying}
                    underlying={underlying}
                    scan={snapshot.trading.option_scans?.[underlying]}
                    symbol={symbol}
                    onView={onView}
                  />
                ))
              ) : (
                <Empty>Add options underlyings in Settings.</Empty>
              )}
            </Group>
            {!!scope?.stock_symbols.length && (
              <Group title="Stocks" enabled={scope.stock_enabled}>
                {scope.stock_symbols.map((ticker) => (
                  <Row key={ticker} {...row(ticker)} label={ticker}>
                    {scope.stock_enabled && scope.stock_symbol === ticker && (
                      <span className="text-primary">Strategy</span>
                    )}
                  </Row>
                ))}
              </Group>
            )}
            {!!held.length && (
              <Group title="Held options">
                {held.map(([ticker, position]) => (
                  <Row
                    key={ticker}
                    {...row(ticker)}
                    label={
                      <span className="flex flex-col">
                        {position.underlying}
                        <span className="text-[0.625rem] text-muted-foreground">
                          {ticker}
                        </span>
                      </span>
                    }
                  >
                    {position.quantity} ct
                  </Row>
                ))}
              </Group>
            )}
          </>
        )}
      </div>
    </aside>
  );
}

function Group({
  title,
  enabled,
  children,
}: {
  title: string;
  enabled?: boolean;
  children: ReactNode;
}) {
  return (
    <section className="pt-2">
      <h3 className="flex items-center justify-between px-3 pb-1 text-[0.625rem] font-medium tracking-wide text-muted-foreground uppercase">
        {title}
        {enabled !== undefined && (
          <span
            className={cn(
              "normal-case tracking-normal",
              enabled ? "text-up" : "text-muted-foreground/70",
            )}
          >
            {enabled ? "Auto on" : "Auto off"}
          </span>
        )}
      </h3>
      {children}
    </section>
  );
}

function Row({
  label,
  selected,
  onClick,
  children,
}: {
  label: ReactNode;
  selected: boolean;
  onClick: () => void;
  children?: ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-current={selected || undefined}
      className={cn(
        "relative flex min-h-7 w-full items-center justify-between gap-2 px-3 py-1 text-left font-mono transition-colors hover:bg-accent",
        selected &&
          "bg-accent before:absolute before:inset-y-0 before:left-0 before:w-0.5 before:bg-primary",
      )}
    >
      <span className="min-w-0 truncate font-medium">{label}</span>
      <span className="shrink-0 text-[0.6875rem] text-muted-foreground">
        {children}
      </span>
    </button>
  );
}

function OptionRow({
  underlying,
  scan,
  symbol,
  onView,
}: {
  underlying: string;
  scan?: OptionScan;
  symbol: string;
  onView: (ticker: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const scanning = scan?.status === "scanning";
  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <div
        className={cn(
          "group relative flex items-center transition-colors hover:bg-accent",
          symbol === underlying &&
            "bg-accent before:absolute before:inset-y-0 before:left-0 before:w-0.5 before:bg-primary",
        )}
      >
        <CollapsibleTrigger asChild>
          <button
            type="button"
            className="flex h-7 w-7 shrink-0 items-center justify-center text-muted-foreground hover:text-foreground"
            aria-label={`${open ? "Hide" : "Show"} ${underlying} contracts`}
          >
            <CaretRightIcon
              className={cn("size-3 transition-transform", open && "rotate-90")}
            />
          </button>
        </CollapsibleTrigger>
        <button
          type="button"
          onClick={() => onView(underlying)}
          aria-current={symbol === underlying || undefined}
          className="flex min-h-7 min-w-0 flex-1 items-center justify-between gap-2 py-1 pr-3 text-left font-mono"
        >
          <span className="font-medium">{underlying}</span>
          <span
            className={cn(
              "text-[0.6875rem] text-muted-foreground",
              scanning && "animate-pulse text-primary",
              scan?.error && "text-down",
            )}
          >
            {scanning
              ? "scanning"
              : scan?.eligible != null
                ? `${scan.eligible}/${scan.discovered ?? 0}`
                : (scan?.status ?? "pending")}
          </span>
        </button>
      </div>
      <CollapsibleContent className="border-y bg-background/50 pb-1">
        <p className="px-3 pt-1.5 pb-1 text-[0.6875rem] text-muted-foreground">
          {scan?.eligible != null
            ? `${scan.eligible} eligible of ${scan.discovered ?? 0} found`
            : "Awaiting first completed scan"}
          {scan?.as_of ? ` at ${clock(scan.as_of)}` : ""}
        </p>
        {scan?.reason && (
          <p className="px-3 pb-1 text-[0.6875rem] text-muted-foreground">
            {scan.reason}
          </p>
        )}
        {scan?.error && (
          <p className="px-3 pb-1 text-[0.6875rem] text-down">{scan.error}</p>
        )}
        {scan?.candidates?.map((candidate) => (
          <button
            type="button"
            key={candidate.symbol}
            onClick={() => onView(candidate.symbol)}
            aria-current={symbol === candidate.symbol || undefined}
            className="grid w-full grid-cols-[auto_1fr_auto] items-baseline gap-x-2 px-3 py-1 text-left font-mono text-[0.6875rem] transition-colors hover:bg-accent aria-[current=true]:bg-accent"
          >
            <span
              className={cn(
                "font-medium uppercase",
                candidate.option_type === "call" ? "text-up" : "text-down",
              )}
            >
              {candidate.option_type === "call" ? "C" : "P"}
            </span>
            <span>
              {candidate.strike} {candidate.expiration}
            </span>
            <span>{money(candidate.limit_price)}</span>
            <span />
            <span className="col-span-2 text-muted-foreground">
              OI {candidate.open_interest} · spr{" "}
              {(candidate.spread_pct * 100).toFixed(1)}% · max{" "}
              {candidate.max_quantity} ct
            </span>
          </button>
        ))}
      </CollapsibleContent>
    </Collapsible>
  );
}
