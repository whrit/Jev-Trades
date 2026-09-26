"use client";

import { useEffect, useRef } from "react";
import {
  CandlestickSeries,
  ColorType,
  createChart,
  HistogramSeries,
  LineSeries,
  LineStyle,
  type IPriceLine,
  type ISeriesApi,
  type UTCTimestamp,
} from "lightweight-charts";

import { chartColors as colors, type Bar, type Snapshot } from "@/lib/terminal";

const volumeColor = (bar: Bar) =>
  bar.close >= bar.open ? colors.upVolume : colors.downVolume;
export type Overlay = { series: string; color: string; dashed: boolean };
type PositionData = {
  average_entry_price?: number;
  stop_loss_price?: number | null;
  take_profit_price?: number | null;
  quantity?: number;
};

export default function MarketChart({
  bars,
  indicatorSeries,
  overlays,
  position,
  priceFormat,
}: {
  bars: Bar[];
  indicatorSeries: Snapshot["indicator_series"];
  overlays: Overlay[];
  position?: PositionData | null;
  priceFormat?: { minMove: number; precision: number };
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<ReturnType<typeof createChart> | null>(null);
  const seriesRef = useRef<{
    candles?: ISeriesApi<"Candlestick">;
    volume?: ISeriesApi<"Histogram">;
  }>({});
  const linesRef = useRef(new Map<string, ISeriesApi<"Line">>());
  const priceLinesRef = useRef<{
    entry?: IPriceLine | null;
    tp?: IPriceLine | null;
    sl?: IPriceLine | null;
  }>({});
  const initializedRef = useRef(false);
  const renderedTimeRef = useRef<number | null>(null);
  const { average_entry_price, stop_loss_price, take_profit_price, quantity } =
    position ?? {};

  useEffect(() => {
    if (!containerRef.current) return;
    initializedRef.current = false;
    renderedTimeRef.current = null;
    linesRef.current.clear();
    priceLinesRef.current = {};
    const chart = createChart(containerRef.current, {
      autoSize: true,
      layout: {
        background: { type: ColorType.Solid, color: colors.bg },
        textColor: colors.text,
        fontFamily: getComputedStyle(document.body).fontFamily,
        fontSize: 11,
        attributionLogo: false,
      },
      grid: {
        vertLines: { color: colors.grid },
        horzLines: { color: colors.grid },
      },
      crosshair: {
        vertLine: { color: colors.text, labelBackgroundColor: "#1d232c" },
        horzLine: { color: colors.text, labelBackgroundColor: "#1d232c" },
      },
      rightPriceScale: { borderColor: colors.border },
      timeScale: {
        borderColor: colors.border,
        timeVisible: true,
        secondsVisible: false,
      },
    });
    const candles = chart.addSeries(CandlestickSeries, {
      upColor: colors.up,
      downColor: colors.down,
      borderVisible: false,
      wickUpColor: colors.up,
      wickDownColor: colors.down,
      priceFormat: { type: "price", minMove: 0.01 },
    });
    const volume = chart.addSeries(HistogramSeries, {
      priceFormat: { type: "volume" },
      priceScaleId: "",
      lastValueVisible: false,
      priceLineVisible: false,
    });
    chart
      .priceScale("")
      .applyOptions({ scaleMargins: { top: 0.82, bottom: 0 } });
    seriesRef.current = { candles, volume };
    chartRef.current = chart;
    return () => {
      chart.remove();
      chartRef.current = null;
    };
  }, []);
  useEffect(() => {
    const lines = [seriesRef.current.candles, ...linesRef.current.values()];
    for (const series of lines) {
      series?.applyOptions({
        priceFormat: {
          type: "price",
          minMove: priceFormat?.minMove ?? 0.01,
          precision: priceFormat?.precision ?? 2,
        },
      });
    }
  }, [priceFormat?.minMove, priceFormat?.precision]);

  useEffect(() => {
    const { candles, volume } = seriesRef.current;
    if (!candles || !volume || !bars.length) return;

    // De-duplicate and sort bars to strictly ascending order to prevent chart crashes
    const uniqueBars = Array.from(
      new Map(bars.map((bar) => [bar.time, bar])).values(),
    );
    const sortedBars = uniqueBars.sort((a, b) => a.time - b.time);

    const latestBar = sortedBars[sortedBars.length - 1];
    const latestCandle = { ...latestBar, time: latestBar.time as UTCTimestamp };
    const latestVolume = {
      time: latestBar.time as UTCTimestamp,
      value: latestBar.volume,
      color: volumeColor(latestBar),
    };
    if (!initializedRef.current) {
      candles.setData(
        sortedBars.map((bar) => ({ ...bar, time: bar.time as UTCTimestamp })),
      );
      volume.setData(
        sortedBars.map((bar) => ({
          time: bar.time as UTCTimestamp,
          value: bar.volume,
          color: volumeColor(bar),
        })),
      );
      initializedRef.current = true;
      chartRef.current?.timeScale().fitContent();
    } else if (
      renderedTimeRef.current !== null &&
      latestBar.time < renderedTimeRef.current
    ) {
      // Time went backwards (e.g. timeframe changed) — full reset
      candles.setData(
        sortedBars.map((bar) => ({ ...bar, time: bar.time as UTCTimestamp })),
      );
      volume.setData(
        sortedBars.map((bar) => ({
          time: bar.time as UTCTimestamp,
          value: bar.volume,
          color: volumeColor(bar),
        })),
      );
      chartRef.current?.timeScale().fitContent();
    } else {
      try {
        candles.update(latestCandle);
        volume.update(latestVolume);
      } catch {
        // Fallback: full reset if update fails (e.g. time mismatch)
        candles.setData(
          sortedBars.map((bar) => ({ ...bar, time: bar.time as UTCTimestamp })),
        );
        volume.setData(
          sortedBars.map((bar) => ({
            time: bar.time as UTCTimestamp,
            value: bar.volume,
            color: volumeColor(bar),
          })),
        );
      }
    }
    renderedTimeRef.current = latestBar.time;
    const chart = chartRef.current;
    if (!chart) return;
    const wanted = new Set(overlays.map((overlay) => overlay.series));
    for (const [name, line] of linesRef.current) {
      if (wanted.has(name)) continue;
      chart.removeSeries(line);
      linesRef.current.delete(name);
    }
    for (const { series: name, color, dashed } of overlays) {
      const values = indicatorSeries[name];
      if (!values) continue;
      let line = linesRef.current.get(name);
      if (!line) {
        line = chart.addSeries(LineSeries, {
          color,
          lineWidth: 1,
          lineStyle: dashed ? LineStyle.Dashed : LineStyle.Solid,
          priceLineVisible: false,
          lastValueVisible: false,
          crosshairMarkerVisible: false,
          priceFormat: {
            type: "price",
            minMove: priceFormat?.minMove ?? 0.01,
            precision: priceFormat?.precision ?? 2,
          },
        });
        linesRef.current.set(name, line);
      }
      // Always use setData for overlays to avoid time mismatch issues with update()
      line.setData(
        sortedBars.slice(0, values.length).flatMap((bar, index) =>
          values[index] == null
            ? []
            : [
                {
                  time: bar.time as UTCTimestamp,
                  value: values[index] as number,
                },
              ],
        ),
      );
    }
  }, [
    bars,
    indicatorSeries,
    overlays,
    priceFormat?.minMove,
    priceFormat?.precision,
  ]);

  // Update Price Lines for Position Entry, Take Profit, and Stop Loss
  useEffect(() => {
    const candles = seriesRef.current.candles;
    if (!candles) return;

    // Clear old lines
    if (priceLinesRef.current.entry) {
      candles.removePriceLine(priceLinesRef.current.entry);
      priceLinesRef.current.entry = null;
    }
    if (priceLinesRef.current.tp) {
      candles.removePriceLine(priceLinesRef.current.tp);
      priceLinesRef.current.tp = null;
    }
    if (priceLinesRef.current.sl) {
      candles.removePriceLine(priceLinesRef.current.sl);
      priceLinesRef.current.sl = null;
    }

    if ((quantity ?? 0) > 0) {
      if (average_entry_price) {
        priceLinesRef.current.entry = candles.createPriceLine({
          price: average_entry_price,
          color: colors.accent,
          lineWidth: 1,
          lineStyle: LineStyle.Solid,
          axisLabelVisible: true,
          title: "Entry",
        });
      }
      if (take_profit_price) {
        priceLinesRef.current.tp = candles.createPriceLine({
          price: take_profit_price,
          color: colors.up,
          lineWidth: 1,
          lineStyle: LineStyle.Dashed,
          axisLabelVisible: true,
          title: "TP",
        });
      }
      if (stop_loss_price) {
        priceLinesRef.current.sl = candles.createPriceLine({
          price: stop_loss_price,
          color: colors.down,
          lineWidth: 1,
          lineStyle: LineStyle.Dashed,
          axisLabelVisible: true,
          title: "SL",
        });
      }
    }
  }, [average_entry_price, stop_loss_price, take_profit_price, quantity]);

  return (
    <div
      ref={containerRef}
      className="size-full min-h-0"
      aria-label="Selected instrument candlestick chart"
    />
  );
}
