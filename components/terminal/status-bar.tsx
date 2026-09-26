"use client";

import { InfoIcon } from "@phosphor-icons/react";

import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { clock, type AssetMode, type Snapshot } from "@/lib/terminal";

export function StatusBar({
  snapshot,
  assetMode,
  lastTick,
}: {
  snapshot: Snapshot | null;
  assetMode: AssetMode;
  lastTick: number | null;
}) {
  const feeds = snapshot?.data_feeds;
  const indicative = snapshot?.options?.feed === "indicative";
  return (
    <footer className="flex h-7 shrink-0 items-center gap-4 overflow-x-auto border-t bg-card px-3 text-[0.6875rem] whitespace-nowrap text-muted-foreground">
      <span>
        Feeds{" "}
        <span className="font-mono text-foreground/80">
          {assetMode === "crypto"
            ? (feeds?.crypto ?? "--")
            : `${feeds?.stocks ?? "--"} / ${feeds?.options ?? "--"}`}
        </span>
      </span>
      <span>
        Last quote{" "}
        <span className="font-mono text-foreground/80">
          {lastTick ? clock(lastTick) : "--"}
        </span>
      </span>
      <Popover>
        <PopoverTrigger className="flex items-center gap-1 hover:text-foreground">
          <InfoIcon className="size-3" />
          {assetMode === "crypto"
            ? "Crypto pricing details"
            : indicative
              ? "Indicative quotes, not executable NBBO"
              : "Pricing details"}
        </PopoverTrigger>
        <PopoverContent
          side="top"
          align="start"
          className="w-80 leading-relaxed"
        >
          {assetMode === "crypto"
            ? `Crypto trades 24/7 with no margin or short selling; Alpaca charges taker fees up to 0.25%. Crypto feed: ${feeds?.crypto ?? "unavailable"}. Exits require this feed process and a fresh quote; fills are not guaranteed.`
            : `${
                indicative
                  ? "Quotes are derived; trades are delayed 15 minutes. Spread and depth checks use this indicative feed. Simulated results do not establish live execution quality."
                  : "Paper fills do not establish live execution quality."
              } Stock feed: ${feeds?.stocks ?? "unavailable"}. Exits require this feed process, a fresh quote, and an open market; fills are not guaranteed.`}
        </PopoverContent>
      </Popover>
      <span className="ml-auto">Alpaca paper only. Not live execution.</span>
      <a
        className="hover:text-foreground"
        href="https://x.com/zadescoxp"
        target="_blank"
        rel="noreferrer"
      >
        @zade
      </a>
      <a
        className="hover:text-foreground"
        href="https://github.com/zadescoxp/Jev-Trades"
        target="_blank"
        rel="noreferrer"
      >
        Source
      </a>
    </footer>
  );
}
