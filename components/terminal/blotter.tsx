"use client";

import type { ReactNode } from "react";
import { toast } from "sonner";
import { CaretRightIcon, XIcon } from "@phosphor-icons/react";

import { useConfirm } from "@/components/terminal/confirm";
import { Empty } from "@/components/terminal/panel";
import { Button } from "@/components/ui/button";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  clock,
  errorText,
  isCryptoTicker,
  money,
  postFeed,
  priceDecimals,
  qty,
  signedMoney,
  type AgentEvent,
  type AssetMode,
  type Snapshot,
  type Trade,
} from "@/lib/terminal";
import { cn } from "@/lib/utils";

export type DeskTab = "positions" | "orders" | "decisions" | "fills";

const CLOSED = ["filled", "canceled", "expired", "rejected", "replaced"];

export function Blotter({
  snapshot,
  assetMode,
  tab,
  onTab,
  onView,
  className,
}: {
  snapshot: Snapshot | null;
  assetMode: AssetMode;
  tab: DeskTab;
  onTab: (tab: DeskTab) => void;
  onView: (ticker: string) => void;
  className?: string;
}) {
  const confirm = useConfirm();
  const isCrypto = assetMode === "crypto";
  const inMode = (ticker: string) => isCryptoTicker(ticker) === isCrypto;
  const instruments = snapshot?.instruments ?? {};
  const positions = Object.entries(
    snapshot?.trading.account.positions ?? {},
  ).filter(([ticker, position]) => position.quantity !== 0 && inMode(ticker));
  const openOrders = (snapshot?.trading.orders ?? []).filter(
    (order) => !CLOSED.includes(order.status ?? "") && inMode(order.symbol),
  );
  const fills = (snapshot?.trading.positions ?? []).filter((trade) =>
    inMode(trade.symbol),
  );
  const decisions = (snapshot?.trading.agent_log ?? [])
    .toReversed()
    .filter((event) => inMode(eventField(event, "symbol") ?? ""));

  const cancelOrder = async (order: Trade) => {
    const ok = await confirm({
      title: "Cancel paper order",
      rows: [
        ["Order", order.id ?? "--"],
        ["Symbol", order.symbol],
        ["Side", order.side],
        ["Quantity", qty(order.quantity, instruments[order.symbol])],
      ],
      notes: ["A cancel request is not a confirmed cancellation."],
      action: "Cancel order",
      tone: "danger",
    });
    if (!ok) return;
    try {
      await postFeed(
        "/order",
        { action: "cancel", order_id: order.id },
        "Cancellation failed",
      );
      toast.success("Cancellation requested; awaiting broker confirmation.");
    } catch (error) {
      toast.error(errorText(error, "Cancellation failed"));
    }
  };

  return (
    <Tabs
      value={tab}
      onValueChange={(value) => onTab(value as DeskTab)}
      aria-label="Positions and activity"
      className={cn(
        "flex min-h-72 min-w-0 flex-col gap-0 bg-card lg:min-h-0",
        className,
      )}
    >
      <div className="flex h-8 shrink-0 items-end border-b px-1">
        <TabsList variant="line" className="h-8 gap-0">
          <Tab value="positions" count={positions.length}>
            Positions
          </Tab>
          <Tab value="orders" count={openOrders.length}>
            Orders
          </Tab>
          <Tab value="decisions">Decisions</Tab>
          <Tab value="fills">Fills</Tab>
        </TabsList>
      </div>

      <TabsContent value="positions" className="min-h-0 flex-1 overflow-auto">
        <Grid
          head={[
            "Instrument",
            ["Qty", "r"],
            ["Entry", "r"],
            ["Mark", "r"],
            ["Value", "r"],
            ["Unrl P&L", "r"],
            "Protection",
            "",
          ]}
        >
          {positions.map(([ticker, position]) => {
            const decimals = priceDecimals(instruments[ticker]);
            const up = position.unrealized_pnl >= 0;
            return (
              <TableRow
                key={ticker}
                className="cursor-pointer"
                onClick={() => onView(ticker)}
              >
                <TableCell className="font-medium">
                  {ticker}
                  {position.expiration && (
                    <span className="ml-2 text-muted-foreground">
                      exp {position.expiration}
                    </span>
                  )}
                </TableCell>
                <Num>{qty(position.quantity, instruments[ticker])}</Num>
                <Num>{money(position.average_entry_price, decimals)}</Num>
                <Num>{money(position.mark_price, decimals)}</Num>
                <Num>{money(position.market_value)}</Num>
                <Num className={up ? "text-up" : "text-down"}>
                  {signedMoney(position.unrealized_pnl)}{" "}
                  <span className="opacity-70">
                    {up ? "+" : ""}
                    {position.unrealized_pnl_pct.toFixed(2)}%
                  </span>
                </Num>
                <TableCell className="text-muted-foreground">
                  {position.exit_reason ||
                    `TP ${money(position.take_profit_price, decimals)} / SL ${money(position.stop_loss_price, decimals)}`}
                </TableCell>
                <TableCell className="text-right">
                  <Button
                    variant="ghost"
                    size="xs"
                    onClick={(event) => {
                      event.stopPropagation();
                      onView(ticker);
                    }}
                  >
                    Manage
                  </Button>
                </TableCell>
              </TableRow>
            );
          })}
        </Grid>
        {!positions.length && (
          <Empty>
            No open positions. Accepted orders appear under Orders until filled.
          </Empty>
        )}
      </TabsContent>

      <TabsContent value="orders" className="min-h-0 flex-1 overflow-auto">
        <Grid
          head={[
            "Instrument",
            "Side",
            "Status",
            ["Filled / Qty", "r"],
            ["Price", "r"],
            "",
          ]}
        >
          {openOrders.map((order, index) => (
            <TableRow key={order.id ?? index}>
              <TableCell className="font-medium">{order.symbol}</TableCell>
              <TableCell
                className={cn(
                  "uppercase",
                  order.side === "buy" ? "text-up" : "text-down",
                )}
              >
                {order.side}
              </TableCell>
              <TableCell
                className={cn(order.status === "unknown" && "text-warn")}
                title={
                  order.status === "unknown"
                    ? "Submission outcome unknown; do not resubmit before broker reconciliation."
                    : undefined
                }
              >
                {order.status}
                {order.status === "unknown" && (
                  <span role="alert" className="ml-2">
                    Do not resubmit before reconciliation
                  </span>
                )}
              </TableCell>
              <Num>
                {qty(order.filled_qty ?? 0, instruments[order.symbol])} /{" "}
                {qty(order.quantity, instruments[order.symbol])}
              </Num>
              <Num>
                {order.price != null
                  ? money(order.price, priceDecimals(instruments[order.symbol]))
                  : "awaiting fill"}
              </Num>
              <TableCell className="text-right">
                {order.id && (
                  <Button
                    variant="ghost"
                    size="xs"
                    className="hover:text-down"
                    onClick={() => void cancelOrder(order)}
                  >
                    <XIcon data-icon="inline-start" />
                    Cancel
                  </Button>
                )}
              </TableCell>
            </TableRow>
          ))}
        </Grid>
        {!openOrders.length && <Empty>No open orders.</Empty>}
      </TabsContent>

      <TabsContent value="decisions" className="min-h-0 flex-1 overflow-auto">
        <div className="sticky top-0 z-10 grid grid-cols-[1.25rem_4.5rem_minmax(5rem,1fr)_minmax(6rem,1.5fr)_3rem_5rem_4.5rem] gap-x-3 border-b bg-card px-3 py-1.5 text-[0.6875rem] text-muted-foreground">
          <span />
          <span>Time</span>
          <span>Ticker</span>
          <span>Strategy</span>
          <span>TF</span>
          <span>Result</span>
          <span className="text-right">Conf.</span>
        </div>
        {decisions.map((event, index) => (
          <Decision
            key={`${event.timestamp}-${index}`}
            event={event}
            snapshot={snapshot}
          />
        ))}
        {!decisions.length && (
          <Empty>
            No recent decisions. They appear after a completed strategy bar
            while automation is running.
          </Empty>
        )}
      </TabsContent>

      <TabsContent value="fills" className="min-h-0 flex-1 overflow-auto">
        <Grid
          head={[
            "Instrument",
            "Side",
            ["Filled", "r"],
            ["Avg fill", "r"],
            "Status",
            "Source",
            ["Updated", "r"],
          ]}
        >
          {fills.map((trade, index) => (
            <TableRow key={trade.id ?? index}>
              <TableCell className="font-medium">{trade.symbol}</TableCell>
              <TableCell
                className={cn(
                  "uppercase",
                  trade.side === "buy" ? "text-up" : "text-down",
                )}
              >
                {trade.side}
              </TableCell>
              <Num>{qty(trade.quantity, instruments[trade.symbol])}</Num>
              <Num>
                {money(trade.price, priceDecimals(instruments[trade.symbol]))}
              </Num>
              <TableCell>{trade.status}</TableCell>
              <TableCell className="text-muted-foreground">
                {trade.reason ?? "Alpaca"}
              </TableCell>
              <Num className="text-muted-foreground">
                {new Date(trade.timestamp * 1000).toLocaleString(undefined, {
                  hour12: false,
                })}
              </Num>
            </TableRow>
          ))}
        </Grid>
        {!fills.length && (
          <Empty>
            No confirmed fills yet. Broker acknowledgements are not fills.
          </Empty>
        )}
        <p className="px-3 py-2 text-[0.6875rem] text-muted-foreground">
          Cumulative broker fill summaries, not individual executions or tax
          lots.
        </p>
      </TabsContent>
    </Tabs>
  );
}

function Tab({
  value,
  count,
  children,
}: {
  value: DeskTab;
  count?: number;
  children: ReactNode;
}) {
  return (
    <TabsTrigger value={value} className="px-3 after:bottom-[-1px]!">
      {children}
      {count !== undefined && (
        <span className="font-mono text-muted-foreground">{count}</span>
      )}
    </TabsTrigger>
  );
}

function Grid({
  head,
  children,
}: {
  head: (string | [string, "r"])[];
  children: ReactNode;
}) {
  return (
    <Table className="text-xs" containerClassName="overflow-visible">
      <TableHeader className="sticky top-0 z-10 bg-card">
        <TableRow className="hover:bg-transparent">
          {head.map((cell, index) => {
            const [label, align] = Array.isArray(cell) ? cell : [cell];
            return (
              <TableHead
                key={`${label}-${index}`}
                className={cn(
                  "h-7 px-3 text-[0.6875rem] font-normal text-muted-foreground",
                  align && "text-right",
                )}
              >
                {label}
              </TableHead>
            );
          })}
        </TableRow>
      </TableHeader>
      <TableBody className="font-mono [&_td]:px-3 [&_td]:py-1.5">
        {children}
      </TableBody>
    </Table>
  );
}

function Num({
  className,
  children,
}: {
  className?: string;
  children: ReactNode;
}) {
  return (
    <TableCell className={cn("text-right", className)}>{children}</TableCell>
  );
}

const eventField = (
  event: AgentEvent,
  key: "symbol" | "strategy" | "time_frame",
) =>
  event[key] ??
  (typeof event.request?.[key] === "string"
    ? (event.request[key] as string)
    : undefined);

function Decision({
  event,
  snapshot,
}: {
  event: AgentEvent;
  snapshot: Snapshot | null;
}) {
  const trade = event.trade;
  const tradeInstrument = trade && snapshot?.instruments[trade.symbol];
  return (
    <Collapsible className="border-b">
      <CollapsibleTrigger className="group grid w-full grid-cols-[1.25rem_4.5rem_minmax(5rem,1fr)_minmax(6rem,1.5fr)_3rem_5rem_4.5rem] items-center gap-x-3 px-3 py-1.5 text-left font-mono transition-colors hover:bg-accent">
        <CaretRightIcon className="size-3 text-muted-foreground transition-transform group-data-[state=open]:rotate-90" />
        <span className="text-muted-foreground">{clock(event.timestamp)}</span>
        <span className="truncate font-medium">
          {eventField(event, "symbol") ?? "Unknown"}
        </span>
        <span className="truncate text-muted-foreground">
          {eventField(event, "strategy") ?? "Unspecified"}
        </span>
        <span className="text-muted-foreground">
          {eventField(event, "time_frame") ?? "--"}
        </span>
        <span
          className={cn("truncate", event.error ? "text-down" : "text-primary")}
        >
          {event.error ? "error" : event.executed}
        </span>
        <span className="text-right">
          {event.confidence == null
            ? "--"
            : `${(event.confidence * 100).toFixed(0)}%`}
        </span>
      </CollapsibleTrigger>
      <CollapsibleContent className="grid gap-2 bg-background/50 px-3 py-2 pl-11">
        {event.reason && <p className="leading-relaxed">{event.reason}</p>}
        {event.error && <p className="text-down">{event.error}</p>}
        <p className="text-muted-foreground">
          Proposed action:{" "}
          <span className="font-mono text-foreground">{event.action}</span>
          {event.confidence == null && " (no model decision)"}
        </p>
        {trade && (
          <p className="font-mono">
            {trade.symbol} {trade.side}{" "}
            {qty(trade.filled_qty ?? 0, tradeInstrument)} /{" "}
            {qty(trade.quantity, tradeInstrument)} filled
            {trade.price != null &&
              ` at ${money(trade.price, priceDecimals(tradeInstrument))}`}
          </p>
        )}
        {event.request && (
          <Payload title="Decision context" value={event.request} />
        )}
        {event.response != null && (
          <Payload title="Model response" value={event.response} />
        )}
      </CollapsibleContent>
    </Collapsible>
  );
}

function Payload({ title, value }: { title: string; value: unknown }) {
  return (
    <Collapsible>
      <CollapsibleTrigger className="group flex items-center gap-1 text-muted-foreground hover:text-foreground">
        <CaretRightIcon className="size-3 transition-transform group-data-[state=open]:rotate-90" />
        {title}
      </CollapsibleTrigger>
      <CollapsibleContent>
        <pre className="mt-1 max-h-72 overflow-auto rounded-md border bg-background p-2 font-mono text-[0.6875rem] leading-relaxed">
          {JSON.stringify(value, null, 2)}
        </pre>
      </CollapsibleContent>
    </Collapsible>
  );
}
