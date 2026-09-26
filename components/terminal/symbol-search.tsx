"use client";

import {
  Command,
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import { type AssetMode, type Snapshot } from "@/lib/terminal";

/** Keyboard symbol switcher (/ or Cmd/Ctrl+K). Changes the chart only. */
export function SymbolSearch({
  open,
  onOpenChange,
  symbols,
  snapshot,
  assetMode,
  onSelect,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  symbols: string[];
  snapshot: Snapshot | null;
  assetMode: AssetMode;
  onSelect: (ticker: string) => void;
}) {
  const scope = snapshot?.trading_scope;
  const strategy =
    assetMode === "crypto"
      ? scope?.crypto_enabled && scope.crypto_symbol
      : scope?.stock_enabled && scope.stock_symbol;
  const held = snapshot?.trading.account.positions ?? {};

  return (
    <CommandDialog
      open={open}
      onOpenChange={onOpenChange}
      title="Chart symbol"
      description="Switch the chart symbol. Viewing does not change any strategy."
    >
      <Command>
        <CommandInput placeholder="Symbol…" />
        <CommandList>
          <CommandEmpty>No matching symbol in this workspace.</CommandEmpty>
          <CommandGroup
            heading={
              assetMode === "crypto" ? "Crypto pairs" : "Equities & options"
            }
          >
            {symbols.map((ticker) => {
              const instrument = snapshot?.instruments[ticker];
              return (
                <CommandItem
                  key={ticker}
                  value={ticker}
                  onSelect={() => onSelect(ticker)}
                  className="font-mono"
                >
                  <span className="font-medium">{ticker}</span>
                  <span className="ml-auto flex gap-2 font-sans text-muted-foreground">
                    {ticker === strategy && (
                      <span className="text-primary">Strategy</span>
                    )}
                    {held[ticker]?.quantity > 0 && <span>Held</span>}
                    {instrument?.asset_class === "us_option"
                      ? `${instrument.option_type ?? "option"} ${instrument.expiration ?? ""}`
                      : null}
                  </span>
                </CommandItem>
              );
            })}
          </CommandGroup>
        </CommandList>
      </Command>
    </CommandDialog>
  );
}
