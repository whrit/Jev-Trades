"use client";

import { useId, useState, type ReactNode } from "react";
import { toast } from "sonner";

import { useConfirm } from "@/components/terminal/confirm";
import { Empty, PanelHeader } from "@/components/terminal/panel";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
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
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import {
  errorText,
  incrementAttr,
  money,
  postFeed,
  priceDecimals,
  qty,
  qtyDecimals,
  signedMoney,
  type Instrument,
  type Position,
  type Trade,
} from "@/lib/terminal";
import { cn } from "@/lib/utils";

type Action = "buy" | "sell" | "exit";

export function OrderTicket({
  symbol,
  instrument,
  price,
  isCrypto,
  availableCash,
  position,
  brokerReady,
  className,
  hidden,
}: {
  symbol: string;
  instrument?: Instrument;
  price: number | null;
  isCrypto: boolean;
  availableCash: number;
  position?: Position;
  brokerReady: boolean;
  className?: string;
  hidden?: boolean;
}) {
  const confirm = useConfirm();
  const ids = useId();
  const [side, setSide] = useState<"buy" | "sell">("buy");
  const [sizingMode, setSizingMode] = useState<"usd" | "quantity">("usd");
  const [amountUsd, setAmountUsd] = useState("5000");
  const [quantity, setQuantity] = useState("1");
  const [limitPrice, setLimitPrice] = useState("");
  const [stopPrice, setStopPrice] = useState("");
  const [timeInForce, setTimeInForce] = useState<"gtc" | "ioc">("gtc");
  const [tpEnabled, setTpEnabled] = useState(true);
  const [tpPct, setTpPct] = useState("5.0");
  const [slEnabled, setSlEnabled] = useState(true);
  const [slPct, setSlPct] = useState("2.5");
  const [loading, setLoading] = useState(false);

  const isOption = !isCrypto && instrument?.asset_class === "us_option";
  const multiplier = instrument?.multiplier ?? 1;
  const units = isOption ? "contracts" : isCrypto ? "coins" : "shares";
  const decimals = priceDecimals(instrument);
  const estimateQuantity = (amount: number) =>
    isOption
      ? Math.floor(amount / ((price || 1) * multiplier)).toString()
      : (amount / (price || 1)).toFixed(qtyDecimals(instrument));
  const cryptoPriceStep = incrementAttr(
    isCrypto
      ? (instrument?.price_increment ??
          (price && price < 1
            ? 0.00000001
            : price && price < 100
              ? 0.0001
              : 0.01))
      : undefined,
    0.01,
  );
  const priceStep = isCrypto ? cryptoPriceStep : "0.01";
  const qtyStep = isOption
    ? "1"
    : isCrypto
      ? incrementAttr(instrument?.min_trade_increment, 0.00000001)
      : "0.000001";
  const qtyMin = isOption
    ? "1"
    : isCrypto
      ? incrementAttr(
          instrument?.min_order_size ?? instrument?.min_trade_increment,
          0.00000001,
        )
      : "0.000001";
  const held = position && position.quantity > 0 ? position : undefined;

  const submit = async (
    action: Action,
    extra: Record<string, unknown> = {},
    immediate = false,
  ) => {
    const orderLimit = immediate ? "" : limitPrice;
    const orderStop = immediate ? "" : stopPrice;
    if (isCrypto && orderStop && !orderLimit) {
      toast.error("Stop-limit orders require a limit price too.");
      return;
    }
    const payload: Record<string, unknown> = {
      action,
      symbol,
      limit_price: orderLimit ? Number(orderLimit) : undefined,
      ...(isCrypto &&
        !immediate && {
          stop_price: orderStop ? Number(orderStop) : undefined,
          time_in_force: orderStop ? "gtc" : timeInForce,
        }),
      ...extra,
    };
    if (action === "buy") {
      if (sizingMode === "usd") payload.amount_usd = Number(amountUsd);
      else payload.quantity = Number(quantity);
      if (tpEnabled && Number(tpPct) > 0)
        payload.take_profit_pct = Number(tpPct);
      if (slEnabled && Number(slPct) > 0) payload.stop_loss_pct = Number(slPct);
    } else if (action === "sell" && !extra.pct_of_position) {
      if (sizingMode === "quantity" && Number(quantity) > 0)
        payload.quantity = Number(quantity);
      else payload.pct_of_position = 1.0;
    }
    const rows: [string, ReactNode][] = [["Symbol", symbol]];
    if (payload.amount_usd != null)
      rows.push(["Amount", money(payload.amount_usd as number)]);
    if (payload.quantity != null)
      rows.push(["Quantity", `${payload.quantity} ${units}`]);
    if (payload.pct_of_position != null)
      rows.push([
        "Size",
        `${(payload.pct_of_position as number) * 100}% of position`,
      ]);
    rows.push([
      "Type",
      payload.limit_price != null
        ? payload.stop_price != null
          ? "Stop-limit"
          : "Limit"
        : isOption
          ? "Limit at fresh quote"
          : "Market",
    ]);
    if (payload.stop_price != null)
      rows.push(["Stop", money(payload.stop_price as number, decimals)]);
    if (payload.limit_price != null)
      rows.push(["Limit", money(payload.limit_price as number, decimals)]);
    if (payload.time_in_force)
      rows.push(["Time in force", String(payload.time_in_force).toUpperCase()]);
    if (payload.take_profit_pct != null)
      rows.push(["Take profit", `+${payload.take_profit_pct}%`]);
    if (payload.stop_loss_pct != null)
      rows.push(["Stop loss", `-${payload.stop_loss_pct}%`]);
    const ok = await confirm({
      title: `${action === "exit" ? "Exit" : action === "buy" ? "Buy" : "Sell"} ${symbol} on Alpaca paper`,
      rows,
      notes: [
        isCrypto
          ? "Crypto trades 24/7 with no margin or short selling. Alpaca charges taker fees up to 0.25%; stop-limit orders are GTC only."
          : "Stocks use market orders unless a limit is set; options use DAY limit orders.",
        "Fills are not guaranteed.",
      ],
      action: `Submit ${action}`,
      tone: action === "buy" ? "buy" : "sell",
    });
    if (!ok) return;
    setLoading(true);
    try {
      const { trade } = await postFeed<{ trade: Trade }>(
        "/order",
        payload,
        "Order execution failed",
      );
      toast.success(
        `${action.toUpperCase()} ${symbol} ${trade.status}; filled ${trade.filled_qty ?? 0}.`,
      );
    } catch (error) {
      toast.error(errorText(error, "Execution error"));
    } finally {
      setLoading(false);
    }
  };

  const setCashPercent = (pct: number) => {
    if (!availableCash) return;
    const target = (availableCash * (pct / 100)).toFixed(2);
    setAmountUsd(target);
    if (price && price > 0) setQuantity(estimateQuantity(Number(target)));
  };

  return (
    <aside
      hidden={hidden}
      aria-label="Manual paper order"
      className={cn("flex min-h-0 flex-col bg-card", className)}
    >
      <PanelHeader title="Order ticket">
        <span className="font-mono font-medium">{symbol || "--"}</span>
      </PanelHeader>
      <div className="min-h-0 flex-1 overflow-y-auto">
        {!symbol ? (
          <Empty>Select an instrument to trade.</Empty>
        ) : (
          <div className="grid gap-3 p-3">
            <ToggleGroup
              type="single"
              spacing={0}
              value={side}
              onValueChange={(value) =>
                value && setSide(value as "buy" | "sell")
              }
              aria-label="Order side"
              className="grid w-full grid-cols-2 gap-1 rounded-md bg-background p-0.5"
            >
              {(["buy", "sell"] as const).map((value) => (
                <ToggleGroupItem
                  key={value}
                  value={value}
                  className={cn(
                    "h-7 rounded-sm font-medium text-muted-foreground",
                    value === "buy"
                      ? "data-[state=on]:bg-up/15 data-[state=on]:text-up"
                      : "data-[state=on]:bg-down/15 data-[state=on]:text-down",
                  )}
                >
                  {value === "buy"
                    ? isOption
                      ? "Buy to open"
                      : "Buy"
                    : isOption
                      ? "Sell to close"
                      : "Sell"}
                </ToggleGroupItem>
              ))}
            </ToggleGroup>

            <Field
              id={`${ids}-limit`}
              label={isOption ? "Limit premium" : "Limit price"}
              hint="Optional"
            >
              <Input
                id={`${ids}-limit`}
                type="number"
                inputMode="decimal"
                min={priceStep}
                step={priceStep}
                value={limitPrice}
                onChange={(event) => setLimitPrice(event.target.value)}
                placeholder={isOption ? "Fresh quote" : "Market"}
                className="font-mono"
              />
            </Field>
            {isCrypto && (
              <div className="grid grid-cols-2 gap-2">
                <Field id={`${ids}-stop`} label="Stop price" hint="Optional">
                  <Input
                    id={`${ids}-stop`}
                    type="number"
                    inputMode="decimal"
                    min={cryptoPriceStep}
                    step={cryptoPriceStep}
                    value={stopPrice}
                    onChange={(event) => setStopPrice(event.target.value)}
                    placeholder="None"
                    className="font-mono"
                  />
                </Field>
                <Field id={`${ids}-tif`} label="Time in force">
                  <Select
                    value={stopPrice ? "gtc" : timeInForce}
                    disabled={!!stopPrice}
                    onValueChange={(value) =>
                      setTimeInForce(value as "gtc" | "ioc")
                    }
                  >
                    <SelectTrigger id={`${ids}-tif`} className="w-full">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="gtc">
                        GTC, good till canceled
                      </SelectItem>
                      <SelectItem value="ioc">
                        IOC, immediate or cancel
                      </SelectItem>
                    </SelectContent>
                  </Select>
                </Field>
              </div>
            )}

            <div className="grid gap-1.5">
              <div className="flex items-center justify-between">
                <Label htmlFor={`${ids}-size`}>Size</Label>
                <ToggleGroup
                  type="single"
                  size="sm"
                  spacing={0}
                  value={sizingMode}
                  onValueChange={(value) =>
                    value && setSizingMode(value as "usd" | "quantity")
                  }
                  aria-label="Size in"
                >
                  <ToggleGroupItem value="usd">USD</ToggleGroupItem>
                  <ToggleGroupItem value="quantity" className="capitalize">
                    {units}
                  </ToggleGroupItem>
                </ToggleGroup>
              </div>
              <InputGroup>
                <InputGroupAddon className="font-mono">
                  {sizingMode === "usd"
                    ? "$"
                    : isCrypto
                      ? symbol.split("/")[0]
                      : symbol.split("-")[0]}
                </InputGroupAddon>
                {sizingMode === "usd" ? (
                  <InputGroupInput
                    id={`${ids}-size`}
                    type="number"
                    inputMode="decimal"
                    min="1"
                    step="100"
                    value={amountUsd}
                    onChange={(event) => {
                      setAmountUsd(event.target.value);
                      if (price && price > 0)
                        setQuantity(
                          estimateQuantity(Number(event.target.value)),
                        );
                    }}
                    className="font-mono"
                  />
                ) : (
                  <InputGroupInput
                    id={`${ids}-size`}
                    type="number"
                    inputMode="decimal"
                    min={qtyMin}
                    step={qtyStep}
                    value={quantity}
                    onChange={(event) => {
                      setQuantity(event.target.value);
                      if (price && price > 0)
                        setAmountUsd(
                          (
                            Number(event.target.value) *
                            price *
                            multiplier
                          ).toFixed(2),
                        );
                    }}
                    className="font-mono"
                  />
                )}
                <InputGroupAddon align="inline-end" className="font-mono">
                  ≈{" "}
                  {sizingMode === "usd"
                    ? `${price && Number(amountUsd) > 0 ? estimateQuantity(Number(amountUsd)) : "0"} ${units}`
                    : money(
                        price && Number(quantity) > 0
                          ? Number(quantity) * price * multiplier
                          : 0,
                      )}
                </InputGroupAddon>
              </InputGroup>
              <div className="grid grid-cols-4 gap-1">
                {[25, 50, 75, 100].map((pct) => (
                  <Button
                    key={pct}
                    variant="outline"
                    size="xs"
                    className="font-mono"
                    onClick={() => setCashPercent(pct)}
                    title={`${pct}% of available cash`}
                  >
                    {pct}%
                  </Button>
                ))}
              </div>
            </div>

            {side === "buy" ? (
              <div className="grid gap-2 rounded-md border p-2">
                <TargetRow
                  label="Take profit"
                  tone="up"
                  enabled={tpEnabled}
                  onEnabled={setTpEnabled}
                  value={tpPct}
                  onValue={setTpPct}
                  presets={["2", "5", "8", "12"]}
                  target={
                    price
                      ? money(price * (1 + Number(tpPct) / 100), decimals)
                      : null
                  }
                />
                <TargetRow
                  label="Stop loss"
                  tone="down"
                  enabled={slEnabled}
                  onEnabled={setSlEnabled}
                  value={slPct}
                  onValue={setSlPct}
                  presets={["1.5", "2.5", "4", "6"]}
                  target={
                    price
                      ? money(price * (1 - Number(slPct) / 100), decimals)
                      : null
                  }
                />
              </div>
            ) : (
              <p className="rounded-md border p-2 leading-relaxed text-muted-foreground">
                {held
                  ? `You hold ${qty(held.quantity, instrument)} ${units}. Selling reduces or closes the long position after fills.`
                  : `No active position in ${symbol}. Enter a quantity to exit if held.`}
              </p>
            )}

            <Button
              size="lg"
              onClick={() => void submit(side)}
              disabled={loading || !price || !brokerReady}
              className={cn(
                "h-9 text-sm font-semibold text-background",
                side === "buy"
                  ? "bg-up hover:bg-up/85"
                  : "bg-down hover:bg-down/85",
              )}
            >
              {loading
                ? "Submitting…"
                : `${side === "buy" ? "Buy" : "Sell"} ${symbol}`}
            </Button>
            <p className="text-[0.6875rem] leading-relaxed text-muted-foreground">
              {isOption
                ? `Whole contracts, multiplier ${multiplier}. Buy to open and sell to close only.`
                : isCrypto
                  ? "Market orders seek immediate execution. Add a limit to cap the price, or a stop for a GTC stop-limit."
                  : "Fractional shares require a fractionable asset."}
            </p>
          </div>
        )}
        {held && (
          <PositionCard
            key={symbol}
            position={held}
            instrument={instrument}
            isOption={isOption}
            busy={loading || !brokerReady}
            onClose={(pct) =>
              void submit(
                pct === 1 ? "exit" : "sell",
                pct === 1 ? {} : { pct_of_position: pct },
                true,
              )
            }
          />
        )}
      </div>
    </aside>
  );
}

function Field({
  id,
  label,
  hint,
  children,
}: {
  id: string;
  label: string;
  hint?: string;
  children: ReactNode;
}) {
  return (
    <div className="grid gap-1.5">
      <Label htmlFor={id} className="justify-between">
        {label}
        {hint && (
          <span className="font-normal text-muted-foreground">{hint}</span>
        )}
      </Label>
      {children}
    </div>
  );
}

function TargetRow({
  label,
  tone,
  enabled,
  onEnabled,
  value,
  onValue,
  presets,
  target,
}: {
  label: string;
  tone: "up" | "down";
  enabled: boolean;
  onEnabled: (enabled: boolean) => void;
  value: string;
  onValue: (value: string) => void;
  presets: string[];
  target: string | null;
}) {
  const sign = tone === "up" ? "+" : "-";
  return (
    <div className="grid gap-1.5">
      <div className="flex items-center justify-between">
        <Label className="cursor-pointer">
          <Checkbox
            checked={enabled}
            onCheckedChange={(checked) => onEnabled(checked === true)}
          />
          {label}
        </Label>
        {enabled && target && (
          <span
            className={cn("font-mono", tone === "up" ? "text-up" : "text-down")}
          >
            {target}
          </span>
        )}
      </div>
      {enabled && (
        <div className="flex items-center gap-1">
          <InputGroup className="w-20 shrink-0">
            <InputGroupInput
              aria-label={`${label} percent`}
              type="number"
              min="0.1"
              step="0.5"
              value={value}
              onChange={(event) => onValue(event.target.value)}
              className="font-mono"
            />
            <InputGroupAddon align="inline-end">%</InputGroupAddon>
          </InputGroup>
          {presets.map((preset) => (
            <Button
              key={preset}
              variant="ghost"
              size="xs"
              aria-pressed={Number(value) === Number(preset)}
              className="flex-1 font-mono text-muted-foreground aria-pressed:bg-accent aria-pressed:text-foreground"
              onClick={() => onValue(preset)}
            >
              {sign}
              {preset}
            </Button>
          ))}
        </div>
      )}
    </div>
  );
}

function PositionCard({
  position,
  instrument,
  isOption,
  busy,
  onClose,
}: {
  position: Position;
  instrument?: Instrument;
  isOption: boolean;
  busy: boolean;
  onClose: (pct: number) => void;
}) {
  const confirm = useConfirm();
  const [editing, setEditing] = useState(false);
  const [tp, setTp] = useState("");
  const [sl, setSl] = useState("");
  const [saving, setSaving] = useState(false);
  const decimals = priceDecimals(instrument);
  const up = position.unrealized_pnl >= 0;

  const saveTargets = async () => {
    const ok = await confirm({
      title: `Update exit targets for ${position.symbol}`,
      rows: [
        ["Take profit", tp ? `+${tp}%` : "Unchanged"],
        ["Stop loss", sl ? `-${sl}%` : "Unchanged"],
      ],
      notes: [
        "These are local paper exit targets. Monitoring requires the feed process to keep running.",
      ],
      action: "Update targets",
    });
    if (!ok) return;
    setSaving(true);
    try {
      await postFeed(
        "/order",
        {
          action: "update_tp_sl",
          symbol: position.symbol,
          take_profit_pct: tp ? Number(tp) : undefined,
          stop_loss_pct: sl ? Number(sl) : undefined,
        },
        "Failed to update TP/SL",
      );
      setEditing(false);
      toast.success("Exit targets updated.");
    } catch (error) {
      toast.error(errorText(error, "Failed to update TP/SL"));
    } finally {
      setSaving(false);
    }
  };

  return (
    <section
      aria-label="Open position"
      className="border-t bg-background/40 p-3"
    >
      <div className="mb-2 flex items-center justify-between">
        <h3 className="flex items-center gap-2 font-medium">
          Long {qty(position.quantity, instrument)}
          <span className="rounded-sm bg-accent px-1 text-[0.625rem] text-muted-foreground">
            {position.tp_sl_source === "jev" ||
            position.tp_sl_source === "jev-options"
              ? "Jev"
              : "Manual"}
          </span>
        </h3>
        <span
          className={cn("font-mono font-medium", up ? "text-up" : "text-down")}
        >
          {signedMoney(position.unrealized_pnl)} ({up ? "+" : ""}
          {position.unrealized_pnl_pct.toFixed(2)}%)
        </span>
      </div>
      <dl className="grid grid-cols-2 gap-x-3 gap-y-1">
        <Fact
          label="Entry"
          value={money(position.average_entry_price, decimals)}
        />
        <Fact label="Value" value={money(position.market_value)} />
        <Fact
          label="TP"
          className="text-up"
          value={
            position.take_profit_price
              ? `${money(position.take_profit_price, decimals)} +${position.take_profit_pct?.toFixed(1)}%`
              : "None"
          }
        />
        <Fact
          label="SL"
          className="text-down"
          value={
            position.stop_loss_price
              ? `${money(position.stop_loss_price, decimals)} -${position.stop_loss_pct?.toFixed(1)}%`
              : "None"
          }
        />
        {position.expiration && (
          <Fact label="Expiry" value={position.expiration} />
        )}
        {position.exit_reason && (
          <Fact
            label="Exit"
            value={position.exit_reason}
            className="col-span-2"
          />
        )}
      </dl>
      {editing ? (
        <div className="mt-3 grid grid-cols-2 gap-2">
          <InputGroup>
            <InputGroupAddon>TP</InputGroupAddon>
            <InputGroupInput
              aria-label="Take profit percent"
              type="number"
              step="0.5"
              placeholder="5"
              value={tp}
              onChange={(event) => setTp(event.target.value)}
              className="font-mono"
            />
            <InputGroupAddon align="inline-end">%</InputGroupAddon>
          </InputGroup>
          <InputGroup>
            <InputGroupAddon>SL</InputGroupAddon>
            <InputGroupInput
              aria-label="Stop loss percent"
              type="number"
              step="0.5"
              placeholder="2.5"
              value={sl}
              onChange={(event) => setSl(event.target.value)}
              className="font-mono"
            />
            <InputGroupAddon align="inline-end">%</InputGroupAddon>
          </InputGroup>
          <Button onClick={() => void saveTargets()} disabled={saving}>
            {saving ? "Saving…" : "Save targets"}
          </Button>
          <Button variant="outline" onClick={() => setEditing(false)}>
            Cancel
          </Button>
        </div>
      ) : (
        <div className="mt-3 grid grid-cols-3 gap-1">
          <Button
            variant="destructive"
            disabled={busy}
            onClick={() => onClose(1)}
            title="Submit a paper order to exit this position; execution is not guaranteed"
          >
            Close all
          </Button>
          <Button
            variant="outline"
            disabled={busy || (isOption && position.quantity < 2)}
            onClick={() => onClose(0.5)}
          >
            Close 50%
          </Button>
          <Button
            variant="outline"
            onClick={() => {
              setTp(position.take_profit_pct?.toString() ?? "");
              setSl(position.stop_loss_pct?.toString() ?? "");
              setEditing(true);
            }}
          >
            Edit TP/SL
          </Button>
        </div>
      )}
    </section>
  );
}

function Fact({
  label,
  value,
  className,
}: {
  label: string;
  value: string;
  className?: string;
}) {
  return (
    <div className={cn("flex items-baseline justify-between gap-2", className)}>
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="truncate font-mono">{value}</dd>
    </div>
  );
}
