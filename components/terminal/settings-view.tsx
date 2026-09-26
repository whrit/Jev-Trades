"use client";

import { useId, useState, type ReactNode } from "react";
import { toast } from "sonner";
import { CaretRightIcon } from "@phosphor-icons/react";

import { useConfirm } from "@/components/terminal/confirm";
import ScopeEditor from "@/components/terminal/scope-editor";
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
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import {
  InputGroup,
  InputGroupAddon,
  InputGroupInput,
} from "@/components/ui/input-group";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import {
  errorText,
  feedBase,
  money,
  optionPolicyFields,
  postFeed,
  TIMEFRAMES,
  type AssetMode,
  type ConfigResult,
  type OptionPolicy,
  type OptionPolicyKey,
  type Snapshot,
} from "@/lib/terminal";
import { cn } from "@/lib/utils";

export function SettingsView({
  snapshot,
  assetMode,
  tradingEnabled,
  onConfigSaved,
  hidden,
}: {
  snapshot: Snapshot | null;
  assetMode: AssetMode;
  tradingEnabled: boolean;
  onConfigSaved: (result: Partial<ConfigResult>) => void;
  hidden?: boolean;
}) {
  const scope = snapshot?.trading_scope;
  const options = snapshot?.options;
  return (
    <div hidden={hidden} className="min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto grid max-w-6xl gap-4 p-4 lg:p-6">
        <header>
          <h1 className="text-base font-semibold">Settings</h1>
          <p className="text-muted-foreground">
            {assetMode === "crypto"
              ? "Crypto scope. Budget and limits apply account-wide."
              : "Trading scope, budget and options risk limits. Applies account-wide."}
          </p>
        </header>
        <div className="grid items-start gap-4 xl:grid-cols-2">
          {scope ? (
            <ScopeEditor
              key={assetMode}
              saved={scope}
              running={tradingEnabled}
              mode={assetMode}
              onSaved={(saved) => onConfigSaved({ trading_scope: saved })}
            />
          ) : (
            <Card size="sm">
              <CardContent className="text-muted-foreground">
                {snapshot
                  ? "Restart the updated feed when ready to enable dashboard-editable trading scope. Automation restarts paused."
                  : "Waiting for the feed connection before loading saved settings."}
              </CardContent>
            </Card>
          )}
          <StrategySettings
            snapshot={snapshot}
            assetMode={assetMode}
            tradingEnabled={tradingEnabled}
            onConfigSaved={onConfigSaved}
          />
        </div>
        {assetMode === "equities" && options && (
          <>
            <OptionLimits
              snapshot={snapshot}
              tradingEnabled={tradingEnabled}
              onConfigSaved={onConfigSaved}
            />
            <AdvancedPolicy
              policy={options.policy}
              editable={editablePolicy(options.policy)}
            />
          </>
        )}
      </div>
    </div>
  );
}

const editablePolicy = (policy: OptionPolicy) =>
  Number.isFinite(policy.max_positions_per_underlying) &&
  Number.isFinite(policy.min_confidence);

function DraftState({ dirty }: { dirty: boolean }) {
  return (
    <CardAction
      className={cn(
        "text-[0.6875rem]",
        dirty ? "text-warn" : "text-muted-foreground",
      )}
    >
      {dirty ? "Unsaved changes" : "Saved"}
    </CardAction>
  );
}

function StrategySettings({
  snapshot,
  assetMode,
  tradingEnabled,
  onConfigSaved,
}: {
  snapshot: Snapshot | null;
  assetMode: AssetMode;
  tradingEnabled: boolean;
  onConfigSaved: (result: Partial<ConfigResult>) => void;
}) {
  const confirm = useConfirm();
  const ids = useId();
  const [draft, setDraft] = useState<Partial<{
    capital: string;
    maxPosition: string;
    risk: string;
    frames: string[];
  }> | null>(null);
  const [typeSafeKey, setTypeSafeKey] = useState("");
  const [saving, setSaving] = useState(false);
  const capital = draft?.capital ?? String(snapshot?.settings.capital ?? "");
  const maxPosition =
    draft?.maxPosition ??
    String((snapshot?.settings.max_wallet_position_pct ?? 0.75) * 100);
  const risk = draft?.risk ?? snapshot?.settings.risk_appetite ?? "balanced";
  const frames = draft?.frames ?? snapshot?.settings.active_timeframes ?? [];
  const dirty = !!draft || !!typeSafeKey;
  const edit = (patch: NonNullable<typeof draft>) =>
    setDraft((current) => ({ ...current, ...patch }));

  const apply = async () => {
    if (!snapshot || saving) return;
    const key = typeSafeKey.trim();
    const ok = await confirm({
      title: "Apply strategy settings",
      rows: [
        ["Budget", money(Number(capital))],
        ["Per-symbol cap", `${maxPosition}%`],
        ["Stock risk", risk],
        ["Evaluation", frames.join(", ")],
        [
          "Automation",
          tradingEnabled ? "On; takes effect immediately" : "Paused",
        ],
      ],
      notes: [
        "Budget does not deposit, withdraw or change Alpaca paper cash.",
        ...(key
          ? [
              "The entered TypeSafe key will be retained by the feed server for future calls.",
            ]
          : []),
      ],
      action: "Apply settings",
    });
    if (!ok) return;
    setSaving(true);
    try {
      onConfigSaved(
        await postFeed<ConfigResult>(
          "/config",
          {
            capital: Number(capital),
            max_wallet_position_pct: Number(maxPosition) / 100,
            risk_appetite: risk,
            active_timeframes: frames,
            typesafe_api_key: key || undefined,
          },
          "Could not save configuration",
        ),
      );
      setDraft(null);
      setTypeSafeKey("");
      toast.success("Strategy settings saved.");
    } catch (error) {
      toast.error(errorText(error, "Could not save configuration"));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Card size="sm">
      <CardHeader className="border-b">
        <CardTitle>Strategy</CardTitle>
        <CardDescription>
          Applies to automation, not chart navigation.
        </CardDescription>
        <DraftState dirty={dirty} />
      </CardHeader>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void apply();
        }}
      >
        <fieldset disabled={saving || !snapshot} className="grid gap-4">
          <legend className="sr-only">Strategy settings</legend>
          <CardContent className="grid gap-4">
            <div className="grid gap-3 sm:grid-cols-3">
              <div className="grid gap-1.5">
                <Label htmlFor={`${ids}-capital`}>Strategy budget</Label>
                <InputGroup>
                  <InputGroupAddon>$</InputGroupAddon>
                  <InputGroupInput
                    id={`${ids}-capital`}
                    name="capital"
                    type="number"
                    required
                    min="0.01"
                    step="0.01"
                    value={capital}
                    onChange={(event) => edit({ capital: event.target.value })}
                    className="font-mono"
                  />
                </InputGroup>
              </div>
              <div className="grid gap-1.5">
                <Label htmlFor={`${ids}-cap`}>Per-symbol cap</Label>
                <InputGroup>
                  <InputGroupInput
                    id={`${ids}-cap`}
                    name="max_position"
                    type="number"
                    required
                    min="0.01"
                    max="100"
                    step="0.01"
                    value={maxPosition}
                    onChange={(event) =>
                      edit({ maxPosition: event.target.value })
                    }
                    className="font-mono"
                  />
                  <InputGroupAddon align="inline-end">%</InputGroupAddon>
                </InputGroup>
              </div>
              {assetMode === "equities" && (
                <div className="grid gap-1.5">
                  <Label htmlFor={`${ids}-risk`}>Stock risk</Label>
                  <Select
                    value={risk}
                    onValueChange={(value) => edit({ risk: value })}
                  >
                    <SelectTrigger id={`${ids}-risk`} className="w-full">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="conservative">Conservative</SelectItem>
                      <SelectItem value="balanced">Balanced</SelectItem>
                      <SelectItem value="aggressive">Aggressive</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              )}
            </div>
            <div className="grid gap-1.5">
              <Label id={`${ids}-frames`}>Evaluation intervals</Label>
              <ToggleGroup
                type="multiple"
                variant="outline"
                size="sm"
                spacing={0}
                aria-labelledby={`${ids}-frames`}
                value={frames}
                onValueChange={(value) =>
                  edit({
                    frames: TIMEFRAMES.filter((tf) => value.includes(tf)),
                  })
                }
              >
                {TIMEFRAMES.map((tf) => (
                  <ToggleGroupItem
                    key={tf}
                    value={tf}
                    className="w-12 font-mono data-[state=on]:bg-primary/15 data-[state=on]:text-primary"
                  >
                    {tf}
                  </ToggleGroupItem>
                ))}
              </ToggleGroup>
              <p className="text-muted-foreground">
                Each interval evaluates completed bars. Positions net by symbol
                across intervals; the chart interval is independent.
              </p>
            </div>
            <Collapsible className="rounded-md border">
              <CollapsibleTrigger className="group flex w-full items-center gap-2 px-2.5 py-2 text-left">
                <CaretRightIcon className="size-3 text-muted-foreground transition-transform group-data-[state=open]:rotate-90" />
                TypeSafe connection
                <span
                  className={cn(
                    "ml-auto text-[0.6875rem]",
                    snapshot?.trading.agent_enabled
                      ? "text-up"
                      : "text-muted-foreground",
                  )}
                >
                  {snapshot?.trading.agent_enabled
                    ? "Server key configured"
                    : "Key required for automation"}
                </span>
              </CollapsibleTrigger>
              <CollapsibleContent className="grid gap-1.5 border-t p-2.5">
                <Label htmlFor={`${ids}-key`}>TypeSafe API key</Label>
                <Input
                  id={`${ids}-key`}
                  type="password"
                  autoComplete="off"
                  value={typeSafeKey}
                  placeholder="Leave blank to reuse server key"
                  onChange={(event) => setTypeSafeKey(event.target.value)}
                />
                <p className="text-muted-foreground">
                  Sent to and retained by {feedBase} for future model calls.
                  Market and portfolio context is sent to TypeSafe when
                  automation runs.
                </p>
              </CollapsibleContent>
            </Collapsible>
          </CardContent>
          <CardFooter className="gap-2 border-t">
            <Button type="submit" disabled={saving || !dirty || !frames.length}>
              {saving ? "Saving…" : "Apply settings"}
            </Button>
            <Button
              type="button"
              variant="ghost"
              disabled={saving || !dirty}
              onClick={() => {
                setDraft(null);
                setTypeSafeKey("");
              }}
            >
              Discard
            </Button>
          </CardFooter>
        </fieldset>
      </form>
    </Card>
  );
}

function OptionLimits({
  snapshot,
  tradingEnabled,
  onConfigSaved,
}: {
  snapshot: Snapshot | null;
  tradingEnabled: boolean;
  onConfigSaved: (result: Partial<ConfigResult>) => void;
}) {
  const confirm = useConfirm();
  const ids = useId();
  const [draft, setDraft] = useState<Partial<
    Record<OptionPolicyKey, string>
  > | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const options = snapshot?.options;
  if (!options) return null;
  if (!editablePolicy(options.policy))
    return (
      <Card size="sm">
        <CardContent className="text-muted-foreground">
          The feed process needs a restart to support editable options limits.
          Restart when ready; automation will start paused.
        </CardContent>
      </Card>
    );

  const policy = {
    ...options.policy,
    ...Object.fromEntries(
      optionPolicyFields.map(({ key, scale }) => [
        key,
        Number(draft?.[key] ?? options.policy[key] * scale) / scale,
      ]),
    ),
  } as OptionPolicy;
  const equity = snapshot?.trading.account.equity;
  const capital =
    equity == null || !snapshot
      ? null
      : Math.min(snapshot.settings.capital, equity);
  const ceiling = (pct: number) =>
    money(capital == null ? null : capital * pct);

  const apply = async () => {
    if (capital === null) return;
    if (
      policy.max_trade_pct > policy.max_underlying_pct ||
      policy.max_underlying_pct > policy.max_total_pct
    ) {
      setError(
        "Entry limit must not exceed the per-ticker limit, which must not exceed the total options limit.",
      );
      return;
    }
    const ok = await confirm({
      title: "Apply options risk limits",
      rows: [
        ["Underlyings", options.underlyings.join(", ")],
        [
          "Per entry",
          `${policy.max_trade_pct * 100}% (${ceiling(policy.max_trade_pct)})`,
        ],
        [
          "Per ticker",
          `${policy.max_underlying_pct * 100}% (${ceiling(policy.max_underlying_pct)})`,
        ],
        [
          "Total options",
          `${policy.max_total_pct * 100}% (${ceiling(policy.max_total_pct)})`,
        ],
        ["Positions / ticker", policy.max_positions_per_underlying],
        ["Contracts / order", policy.max_contracts],
        ["Jev confidence", `${policy.min_confidence * 100}%`],
      ],
      notes: [
        `Automation stays ${tradingEnabled ? "on; new orders may use these limits immediately" : "off"}. Per-ticker exposure includes stock exposure.`,
        "Existing positions, pending orders and exit targets are not changed. Limits are saved on the feed server.",
      ],
      action: "Apply limits",
    });
    if (!ok) return;
    setSaving(true);
    setError(null);
    try {
      onConfigSaved(
        await postFeed<ConfigResult>(
          "/config",
          {
            option_policy: Object.fromEntries(
              optionPolicyFields.map(({ key }) => [key, policy[key]]),
            ),
          },
          "Options policy update failed",
        ),
      );
      setDraft(null);
      toast.success(
        "Options limits saved. New entries use the updated policy; existing exits are unchanged.",
      );
    } catch (failure) {
      setError(errorText(failure, "Options policy update failed"));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Card size="sm">
      <CardHeader className="border-b">
        <CardTitle>Options risk limits</CardTitle>
        <CardDescription>
          Dollar ceilings use the smaller of applied budget and broker equity:{" "}
          <span className="font-mono text-foreground">{money(capital)}</span>.
          Cash, quote depth and pending orders can reduce capacity.
        </CardDescription>
        <DraftState dirty={!!draft} />
      </CardHeader>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void apply();
        }}
      >
        <fieldset disabled={saving} className="grid gap-4">
          <legend className="sr-only">Options entry limits</legend>
          <CardContent className="grid gap-3 sm:grid-cols-3 lg:grid-cols-6">
            {optionPolicyFields.map(
              ({ key, label, unit, scale, min, max, step }) => (
                <div key={key} className="grid content-start gap-1.5">
                  <Label htmlFor={`${ids}-${key}`}>{label}</Label>
                  <InputGroup>
                    <InputGroupInput
                      id={`${ids}-${key}`}
                      name={key}
                      type="number"
                      required
                      min={min}
                      max={max}
                      step={step}
                      value={
                        draft?.[key] ??
                        Number((options.policy[key] * scale).toFixed(8))
                      }
                      onChange={(event) => {
                        setDraft((current) => ({
                          ...current,
                          [key]: event.target.value,
                        }));
                        setError(null);
                      }}
                      className="font-mono"
                    />
                    {unit && (
                      <InputGroupAddon align="inline-end">
                        {unit}
                      </InputGroupAddon>
                    )}
                  </InputGroup>
                  <span className="text-[0.6875rem] text-muted-foreground">
                    {key === "max_trade_pct" ||
                    key === "max_underlying_pct" ||
                    key === "max_total_pct" ? (
                      <>
                        <span className="font-mono">
                          {ceiling(policy[key])}
                        </span>{" "}
                        ceiling
                      </>
                    ) : key === "max_positions_per_underlying" ? (
                      "Held + pending entries"
                    ) : key === "max_contracts" ? (
                      "Whole contracts per entry"
                    ) : (
                      "Not a profit probability"
                    )}
                  </span>
                </div>
              ),
            )}
            {error && (
              <p role="alert" className="text-down sm:col-span-full">
                {error}
              </p>
            )}
            <p className="text-muted-foreground sm:col-span-full">
              Multiple distinct long calls/puts are allowed; adding to the same
              contract is not. Confidence gates discretionary options trades,
              not protective exits. Lower limits block new exposure and never
              force liquidation.
            </p>
          </CardContent>
          <CardFooter className="gap-2 border-t">
            <Button
              type="submit"
              disabled={!draft || saving || capital === null}
            >
              {saving ? "Saving…" : "Apply limits"}
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
      </form>
    </Card>
  );
}

function AdvancedPolicy({
  policy,
  editable,
}: {
  policy: OptionPolicy;
  editable: boolean;
}) {
  const pct = (value: number, digits: number) =>
    `${(value * 100).toFixed(digits)}%`;
  const facts: [string, ReactNode][] = [
    ["Min DTE", `${policy.min_dte}d`],
    ["Max DTE", `${policy.max_dte}d`],
    ["Exit DTE", `${policy.exit_dte}d`],
    ["Min open interest", policy.min_open_interest],
    ["Max OI age", `${policy.max_open_interest_age_days}d`],
    ["Min quote size", policy.min_quote_size],
    ["Max spread", pct(policy.max_spread_pct, 1)],
    ["Max spread $", `$${policy.max_spread_absolute.toFixed(2)}`],
    ["Max quote age", `${policy.max_quote_age_seconds}s`],
    ["Max candidates", policy.max_candidates],
    ["Max per trade", pct(policy.max_trade_pct, 2)],
    ["Max per underlying", pct(policy.max_underlying_pct, 2)],
    ["Max total", pct(policy.max_total_pct, 2)],
    ["Max contracts", policy.max_contracts],
    ...(editable
      ? ([
          ["Positions per ticker", policy.max_positions_per_underlying],
          ["Jev confidence", pct(policy.min_confidence, 0)],
        ] as [string, ReactNode][])
      : []),
    ["Take profit", `+${policy.take_profit_pct}%`],
    ["Stop loss", `-${policy.stop_loss_pct}%`],
    ["Entry timeout", `${policy.entry_timeout_seconds}s`],
    ["Exit reprice", `${policy.exit_reprice_seconds}s`],
    ["Max price drift", pct(policy.max_price_drift_pct, 1)],
  ];
  return (
    <Collapsible asChild>
      <Card size="sm" className="gap-0 py-0">
        <CollapsibleTrigger className="group flex w-full flex-wrap items-center gap-x-3 gap-y-1 p-3 text-left">
          <CaretRightIcon className="size-3 text-muted-foreground transition-transform group-data-[state=open]:rotate-90" />
          <span className="text-sm font-medium">
            Advanced eligibility and exits
          </span>
          <span className="font-mono text-muted-foreground">
            DTE {policy.min_dte}-{policy.max_dte}d, exit {policy.exit_dte}d, TP
            +{policy.take_profit_pct}% / SL -{policy.stop_loss_pct}%
          </span>
          <span className="ml-auto text-[0.6875rem] text-muted-foreground">
            Read-only; set via OPTION_* env
          </span>
        </CollapsibleTrigger>
        <CollapsibleContent>
          <dl className="grid grid-cols-2 gap-px border-t bg-border sm:grid-cols-4 lg:grid-cols-5">
            {facts.map(([label, value]) => (
              <div key={label} className="bg-card px-3 py-2">
                <dt className="text-[0.6875rem] text-muted-foreground">
                  {label}
                </dt>
                <dd className="font-mono">{value}</dd>
              </div>
            ))}
          </dl>
        </CollapsibleContent>
      </Card>
    </Collapsible>
  );
}
