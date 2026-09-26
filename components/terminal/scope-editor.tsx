"use client";

import { useEffect, useId, useState } from "react";
import { toast } from "sonner";
import { MagnifyingGlassIcon, PlusIcon, XIcon } from "@phosphor-icons/react";

import { useConfirm } from "@/components/terminal/confirm";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  InputGroup,
  InputGroupAddon,
  InputGroupInput,
} from "@/components/ui/input-group";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import {
  errorText,
  feedBase,
  postFeed,
  type AssetMode,
  type TradingScope,
} from "@/lib/terminal";
import { cn } from "@/lib/utils";

type Asset = { symbol: string; name: string };
type ListField = "option_underlyings" | "stock_symbols" | "crypto_symbols";

export default function ScopeEditor({
  saved,
  running,
  onSaved,
  mode,
}: {
  saved: TradingScope;
  running: boolean;
  onSaved: (scope: TradingScope) => void;
  mode: AssetMode;
}) {
  const confirm = useConfirm();
  const ids = useId();
  const [draft, setDraft] = useState<TradingScope | null>(null);
  const [target, setTarget] = useState<"option_underlyings" | "stock_symbols">(
    "option_underlyings",
  );
  const searchTarget: ListField = mode === "crypto" ? "crypto_symbols" : target;
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<Asset[]>([]);
  const [searchState, setSearchState] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const scope = draft ?? saved;

  useEffect(() => {
    const controller = new AbortController();
    const timer = setTimeout(async () => {
      if (!query.trim()) return;
      try {
        const assetClass =
          searchTarget === "crypto_symbols" ? "crypto" : "us_equity";
        const response = await fetch(
          `${feedBase}/assets?asset_class=${assetClass}&query=${encodeURIComponent(query.trim())}`,
          { signal: controller.signal },
        );
        const result = await response.json();
        if (!response.ok || !result.ok)
          throw new Error(result.error || "Ticker search failed");
        if (controller.signal.aborted) return;
        setResults(result.assets);
        setSearchState(
          result.assets.length
            ? ""
            : assetClass === "crypto"
              ? "No matching tradable crypto pairs."
              : "No matching tradable stocks or ETFs.",
        );
      } catch (failure) {
        if (!controller.signal.aborted)
          setSearchState(errorText(failure, "Ticker search unavailable"));
      }
    }, 250);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [query, searchTarget]);

  const change = (patch: Partial<TradingScope>) => {
    setDraft({ ...scope, ...patch });
    setError(null);
  };
  const remove = (field: ListField, symbol: string) => {
    const remaining = scope[field].filter((item) => item !== symbol);
    if (field === "stock_symbols") {
      change({
        stock_symbols: remaining,
        stock_symbol:
          scope.stock_symbol === symbol
            ? (remaining[0] ?? "")
            : scope.stock_symbol,
        stock_enabled: remaining.length > 0 && scope.stock_enabled,
      });
    } else if (field === "crypto_symbols") {
      change({
        crypto_symbols: remaining,
        crypto_symbol:
          scope.crypto_symbol === symbol
            ? (remaining[0] ?? "")
            : scope.crypto_symbol,
        crypto_enabled: remaining.length > 0 && scope.crypto_enabled,
      });
    } else {
      change({
        option_underlyings: remaining,
        options_enabled: remaining.length > 0 && scope.options_enabled,
      });
    }
  };
  const add = (symbol: string) =>
    change({
      [searchTarget]: [...scope[searchTarget], symbol],
      ...(searchTarget === "stock_symbols" &&
        !scope.stock_symbol && { stock_symbol: symbol }),
      ...(searchTarget === "crypto_symbols" &&
        !scope.crypto_symbol && { crypto_symbol: symbol }),
    });

  const save = async () => {
    if (!draft || saving) return;
    if (
      scope.stock_enabled &&
      (!scope.stock_symbol || !scope.stock_symbols.includes(scope.stock_symbol))
    )
      return setError(
        "Choose a stock strategy symbol or turn stock automation off.",
      );
    if (scope.options_enabled && !scope.option_underlyings.length)
      return setError(
        "Add an options underlying or turn options automation off.",
      );
    if (
      scope.crypto_enabled &&
      (!scope.crypto_symbol ||
        !scope.crypto_symbols.includes(scope.crypto_symbol))
    )
      return setError(
        "Choose a crypto strategy pair or turn crypto automation off.",
      );
    const ok = await confirm({
      title: "Save paper trading scope",
      rows: [
        ["Options watchlist", scope.option_underlyings.join(", ") || "Empty"],
        ["Options automation", scope.options_enabled ? "On" : "Off"],
        ["Stock watchlist", scope.stock_symbols.join(", ") || "Empty"],
        [
          "Stock automation",
          scope.stock_enabled ? `On, ${scope.stock_symbol}` : "Off",
        ],
        ["Crypto watchlist", scope.crypto_symbols.join(", ") || "Empty"],
        [
          "Crypto automation",
          scope.crypto_enabled ? `On, ${scope.crypto_symbol}` : "Off",
        ],
        [
          "Master automation",
          running ? "On; new decisions use this scope now" : "Paused",
        ],
      ],
      notes: [
        "Applies account-wide across the equities/options and crypto views.",
        "Removing tickers blocks new entries; it does not cancel orders or close positions. Protective exits continue.",
      ],
      action: "Save scope",
    });
    if (!ok) return;
    setSaving(true);
    setError(null);
    try {
      const result = await postFeed<{ trading_scope: TradingScope }>(
        "/config",
        { trading_scope: scope },
        "Could not save trading scope",
      );
      onSaved(result.trading_scope);
      setDraft(null);
      toast.success(
        "Trading scope saved. Existing positions and protective exits are unchanged.",
      );
    } catch (failure) {
      setError(errorText(failure, "Could not save trading scope"));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Card size="sm">
      <CardHeader className="border-b">
        <CardTitle>
          {mode === "crypto" ? "Crypto scope" : "Equities & options scope"}
        </CardTitle>
        <CardDescription>
          What Jev can trade. Viewing a chart never changes this scope.
        </CardDescription>
        <CardAction
          className={cn(
            "text-[0.6875rem]",
            draft ? "text-warn" : "text-muted-foreground",
          )}
        >
          {draft ? "Unsaved changes" : "Saved"}
        </CardAction>
      </CardHeader>
      <fieldset disabled={saving} className="grid gap-4">
        <legend className="sr-only">Trading watchlists and strategies</legend>
        <CardContent className="grid gap-4">
          {mode === "equities" ? (
            <>
              <ScopeList
                title="Options automation"
                description="Scans calls and puts across these underlyings."
                enabled={scope.options_enabled}
                onEnabled={(options_enabled) => change({ options_enabled })}
                symbols={scope.option_underlyings}
                onRemove={(symbol) => remove("option_underlyings", symbol)}
                empty="No options underlyings selected."
              />
              <ScopeList
                title="Stock automation"
                description="One active stock strategy. The watchlist also permits manual stock entries."
                enabled={scope.stock_enabled}
                onEnabled={(stock_enabled) => change({ stock_enabled })}
                symbols={scope.stock_symbols}
                onRemove={(symbol) => remove("stock_symbols", symbol)}
                empty="No stock entries configured."
                strategy={scope.stock_symbol}
                onStrategy={(stock_symbol) => change({ stock_symbol })}
                strategyLabel="Strategy symbol"
              />
            </>
          ) : (
            <ScopeList
              title="Crypto automation"
              description="Trades one pair 24/7, no margin or short selling. The watchlist also permits manual entries."
              enabled={scope.crypto_enabled}
              onEnabled={(crypto_enabled) => change({ crypto_enabled })}
              symbols={scope.crypto_symbols}
              onRemove={(symbol) => remove("crypto_symbols", symbol)}
              empty="No crypto pairs selected."
              strategy={scope.crypto_symbol}
              onStrategy={(crypto_symbol) => change({ crypto_symbol })}
              strategyLabel="Strategy pair"
            />
          )}

          <div className="grid gap-1.5 border-t pt-4">
            <div className="flex items-center justify-between gap-2">
              <Label htmlFor={`${ids}-search`}>
                {mode === "crypto" ? "Add crypto pair" : "Add ticker"}
              </Label>
              {mode === "equities" && (
                <ToggleGroup
                  type="single"
                  size="sm"
                  spacing={0}
                  value={target}
                  onValueChange={(value) =>
                    value && setTarget(value as typeof target)
                  }
                  aria-label="Add to"
                >
                  <ToggleGroupItem value="option_underlyings">
                    Options
                  </ToggleGroupItem>
                  <ToggleGroupItem value="stock_symbols">
                    Stocks
                  </ToggleGroupItem>
                </ToggleGroup>
              )}
            </div>
            <InputGroup>
              <InputGroupAddon>
                <MagnifyingGlassIcon />
              </InputGroupAddon>
              <InputGroupInput
                id={`${ids}-search`}
                type="search"
                value={query}
                maxLength={80}
                autoComplete="off"
                placeholder={
                  mode === "crypto"
                    ? "BTC, ETH, SOL…"
                    : "Ticker or company, e.g. SPY, Apple"
                }
                onChange={(event) => {
                  setQuery(event.target.value);
                  setResults([]);
                  setSearchState(
                    event.target.value.trim() ? "Searching broker assets…" : "",
                  );
                }}
              />
            </InputGroup>
            {query.trim() && (
              <div
                aria-label="Ticker search results"
                className="max-h-56 overflow-y-auto rounded-md border"
              >
                {searchState && (
                  <output className="block px-2.5 py-2 text-muted-foreground">
                    {searchState}
                  </output>
                )}
                {results.map((asset) => {
                  const added = scope[searchTarget].includes(asset.symbol);
                  return (
                    <button
                      type="button"
                      key={asset.symbol}
                      disabled={added}
                      onClick={() => add(asset.symbol)}
                      className="flex w-full items-center gap-3 border-b px-2.5 py-1.5 text-left transition-colors last:border-b-0 hover:bg-accent disabled:opacity-50 disabled:hover:bg-transparent"
                    >
                      <span className="w-20 shrink-0 font-mono font-medium">
                        {asset.symbol}
                      </span>
                      <span className="min-w-0 flex-1 truncate text-muted-foreground">
                        {asset.name}
                      </span>
                      <span
                        className={cn(
                          "flex items-center gap-1",
                          added ? "text-muted-foreground" : "text-primary",
                        )}
                      >
                        {!added && <PlusIcon className="size-3" />}
                        {added ? "Added" : "Add"}
                      </span>
                    </button>
                  );
                })}
              </div>
            )}
            <p className="text-muted-foreground">
              {mode === "crypto"
                ? "Alpaca's tradable USD-quoted crypto pairs. Alpaca charges taker fees up to 0.25%."
                : "Alpaca's active tradable stocks/ETFs. Options eligibility is checked during scanning. Empty the stock watchlist to also disallow manual stock entries."}
            </p>
          </div>
          {error && (
            <p role="alert" className="text-down">
              {error}
            </p>
          )}
        </CardContent>
        <CardFooter className="gap-2 border-t">
          <Button
            type="button"
            disabled={!draft || saving}
            onClick={() => void save()}
          >
            {saving ? "Saving…" : "Save scope"}
          </Button>
          <Button
            type="button"
            variant="ghost"
            disabled={!draft || saving}
            onClick={() => {
              setDraft(null);
              setError(null);
            }}
          >
            Discard
          </Button>
        </CardFooter>
      </fieldset>
    </Card>
  );
}

function ScopeList({
  title,
  description,
  enabled,
  onEnabled,
  symbols,
  onRemove,
  empty,
  strategy,
  onStrategy,
  strategyLabel,
}: {
  title: string;
  description: string;
  enabled: boolean;
  onEnabled: (enabled: boolean) => void;
  symbols: string[];
  onRemove: (symbol: string) => void;
  empty: string;
  strategy?: string;
  onStrategy?: (symbol: string) => void;
  strategyLabel?: string;
}) {
  const ids = useId();
  return (
    <div className="grid gap-2">
      <div className="flex items-start justify-between gap-3">
        <div className="grid gap-0.5">
          <Label htmlFor={`${ids}-switch`}>{title}</Label>
          <p className="text-muted-foreground">{description}</p>
        </div>
        <Switch
          id={`${ids}-switch`}
          checked={enabled}
          onCheckedChange={onEnabled}
        />
      </div>
      <div className="flex flex-wrap gap-1" aria-label={`${title} watchlist`}>
        {symbols.map((symbol) => (
          <span
            key={symbol}
            className={cn(
              "inline-flex h-6 items-center gap-1 rounded-sm border bg-background pl-2 font-mono",
              symbol === strategy && "border-primary/40 text-primary",
            )}
          >
            {symbol}
            <button
              type="button"
              onClick={() => onRemove(symbol)}
              aria-label={`Remove ${symbol}`}
              className="flex h-full items-center px-1.5 text-muted-foreground transition-colors hover:text-down"
            >
              <XIcon className="size-3" />
            </button>
          </span>
        ))}
        {!symbols.length && (
          <span className="text-muted-foreground">{empty}</span>
        )}
      </div>
      {onStrategy && (
        <div className="flex items-center gap-2">
          <Label
            htmlFor={`${ids}-strategy`}
            className="shrink-0 font-normal text-muted-foreground"
          >
            {strategyLabel}
          </Label>
          <Select
            value={strategy ?? ""}
            onValueChange={onStrategy}
            disabled={!symbols.length}
          >
            <SelectTrigger
              id={`${ids}-strategy`}
              size="sm"
              className="min-w-28 font-mono"
            >
              <SelectValue placeholder="Select" />
            </SelectTrigger>
            <SelectContent>
              {symbols.map((symbol) => (
                <SelectItem key={symbol} value={symbol} className="font-mono">
                  {symbol}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      )}
    </div>
  );
}
