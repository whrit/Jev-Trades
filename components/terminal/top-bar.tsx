"use client";

import { PauseIcon, PlayIcon } from "@phosphor-icons/react";

import { Button } from "@/components/ui/button";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { money, type AssetMode, type Snapshot } from "@/lib/terminal";
import { cn } from "@/lib/utils";

export type Workspace = "terminal" | "activity" | "settings";

export function TopBar({
  snapshot,
  workspace,
  onWorkspace,
  assetMode,
  onAssetMode,
  tradingEnabled,
  automationBusy,
  canStart,
  onToggleAutomation,
}: {
  snapshot: Snapshot | null;
  workspace: Workspace;
  onWorkspace: (workspace: Workspace) => void;
  assetMode: AssetMode;
  onAssetMode: (mode: AssetMode) => void;
  tradingEnabled: boolean;
  automationBusy: boolean;
  canStart: boolean;
  onToggleAutomation: () => void;
}) {
  const account = snapshot?.trading.account;
  const scope = snapshot?.trading_scope;
  const options = snapshot?.options;
  const optionCapital =
    account?.equity == null || !snapshot
      ? null
      : Math.min(snapshot.settings.capital, account.equity);
  const brokerStatus = snapshot?.trading.broker_status ?? "connecting";
  const live = brokerStatus === "connected";

  return (
    <header className="flex h-11 shrink-0 items-center gap-3 overflow-x-auto border-b bg-card px-3 whitespace-nowrap">
      <div className="flex items-baseline gap-1.5 pr-1">
        <span className="font-mono text-sm font-semibold tracking-tight">
          jev
        </span>
        <span className="rounded-sm bg-warn/15 px-1 font-mono text-[0.625rem] font-medium text-warn">
          PAPER
        </span>
      </div>
      <nav aria-label="Workspace" className="flex h-full items-stretch">
        {(["terminal", "activity", "settings"] as const).map((tab) => (
          <button
            key={tab}
            type="button"
            aria-current={workspace === tab ? "page" : undefined}
            onClick={() => onWorkspace(tab)}
            className={cn(
              "relative px-2.5 text-xs font-medium text-muted-foreground capitalize transition-colors hover:text-foreground",
              "after:absolute after:inset-x-2.5 after:bottom-0 after:h-px after:bg-primary after:opacity-0 after:transition-opacity",
              "aria-[current=page]:text-foreground aria-[current=page]:after:opacity-100",
            )}
          >
            {tab}
          </button>
        ))}
      </nav>
      <ToggleGroup
        type="single"
        size="sm"
        variant="outline"
        spacing={0}
        value={assetMode}
        onValueChange={(value) => value && onAssetMode(value as AssetMode)}
        aria-label="Market workspace"
      >
        <ToggleGroupItem value="equities">
          Equities &amp; options
        </ToggleGroupItem>
        <ToggleGroupItem value="crypto">Crypto</ToggleGroupItem>
      </ToggleGroup>

      <dl className="ml-auto hidden items-center gap-5 xl:flex">
        <Stat label="Equity" value={money(account?.equity)} />
        <Stat label="Cash" value={money(account?.available_cash)} />
        {assetMode === "crypto" ? (
          <Stat
            label="Crypto BP"
            value={money(account?.crypto_buying_power)}
            hint={account?.crypto_status ?? "Not connected"}
          />
        ) : (
          <Stat
            label="Options exp."
            value={money(account?.options_exposure)}
            hint={`of ${money(
              optionCapital === null || !options
                ? null
                : optionCapital * options.policy.max_total_pct,
            )} cap · held + reserved`}
          />
        )}
        <Stat
          label="Eval"
          value={snapshot?.settings.active_timeframes?.join(" ") || "--"}
          hint="Strategy evaluation intervals"
        />
      </dl>

      <div className="ml-auto flex items-center gap-3 xl:ml-2">
        {tradingEnabled && (
          <span className="hidden font-medium text-up sm:inline">
            Automation on
          </span>
        )}
        <Tooltip>
          <TooltipTrigger asChild>
            <span>
              <Button
                size="sm"
                variant={tradingEnabled ? "outline" : "default"}
                disabled={automationBusy || (!tradingEnabled && !canStart)}
                onClick={onToggleAutomation}
                className={cn(
                  tradingEnabled &&
                    "hover:border-down/40 hover:bg-down/10 hover:text-down",
                )}
              >
                {tradingEnabled ? (
                  <PauseIcon weight="fill" data-icon="inline-start" />
                ) : (
                  <PlayIcon weight="fill" data-icon="inline-start" />
                )}
                {automationBusy
                  ? "Applying…"
                  : tradingEnabled
                    ? "Pause"
                    : "Start automation"}
              </Button>
            </span>
          </TooltipTrigger>
          <TooltipContent side="bottom" align="end" className="max-w-64">
            <div className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 font-mono">
              {assetMode === "crypto" ? (
                <>
                  <span className="text-muted-foreground">Crypto</span>
                  <span>
                    {scope?.crypto_enabled ? scope.crypto_symbol : "Off"}
                  </span>
                </>
              ) : (
                <>
                  <span className="text-muted-foreground">Options</span>
                  <span>
                    {scope?.options_enabled
                      ? scope.option_underlyings.join(", ")
                      : "Off"}
                  </span>
                  <span className="text-muted-foreground">Stock</span>
                  <span>
                    {scope?.stock_enabled ? scope.stock_symbol : "Off"}
                  </span>
                </>
              )}
            </div>
            <p className="mt-1 text-muted-foreground">
              {tradingEnabled
                ? "Click to pause. Protective exits remain active."
                : "Global switch for both workspaces."}
            </p>
          </TooltipContent>
        </Tooltip>
        <span
          className="flex items-center gap-1.5 text-muted-foreground"
          title={snapshot?.trading.broker_error ?? undefined}
        >
          <span
            aria-hidden
            className={cn(
              "size-1.5 rounded-full",
              live ? "bg-up" : "bg-down",
              !snapshot && "animate-pulse bg-muted-foreground",
            )}
          />
          <span className="capitalize">{brokerStatus}</span>
        </span>
      </div>
    </header>
  );
}

function Stat({
  label,
  value,
  hint,
}: {
  label: string;
  value: string;
  hint?: string;
}) {
  return (
    <div className="flex items-baseline gap-1.5" title={hint}>
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="font-mono font-medium">{value}</dd>
    </div>
  );
}
