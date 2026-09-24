"use client";

import { useEffect, useRef } from "react";
import { CandlestickSeries, ColorType, createChart, HistogramSeries, LineSeries, LineStyle, type IPriceLine, type UTCTimestamp } from "lightweight-charts";

type Bar = { time: number; open: number; high: number; low: number; close: number; volume: number };
type IndicatorSeries = { ema20: (number | null)[]; sma50: (number | null)[] };
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
}: {
  bars: Bar[];
  indicatorSeries: IndicatorSeries;
  overlays: string[];
  position?: PositionData | null;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<ReturnType<typeof createChart> | null>(null);
  const seriesRef = useRef<Record<string, any>>({});
  const priceLinesRef = useRef<{ entry?: IPriceLine | null; tp?: IPriceLine | null; sl?: IPriceLine | null }>({});
  const initializedRef = useRef(false);
  const renderedTimeRef = useRef<number | null>(null);
  const overlayStateRef = useRef("");

  useEffect(() => {
    if (!containerRef.current) return;
    const chart = createChart(containerRef.current, {
      layout: { background: { type: ColorType.Solid, color: "#111a1b" }, textColor: "#8b9d9d" },
      grid: { vertLines: { color: "#1e2b2c" }, horzLines: { color: "#1e2b2c" } },
      width: containerRef.current.clientWidth,
      height: 440,
      rightPriceScale: { borderColor: "#2c3b3c" },
      timeScale: { borderColor: "#2c3b3c", timeVisible: true, secondsVisible: false },
    });
    const candles = chart.addSeries(CandlestickSeries, {
      upColor: "#8bd450",
      downColor: "#ef7156",
      borderVisible: false,
      wickUpColor: "#8bd450",
      wickDownColor: "#ef7156",
    });
    const volume = chart.addSeries(HistogramSeries, {
      priceFormat: { type: "volume" },
      priceScaleId: "",
      color: "#3f5a58",
      lastValueVisible: false,
      priceLineVisible: false,
    });
    chart.priceScale("").applyOptions({ scaleMargins: { top: 0.82, bottom: 0 } });
    seriesRef.current = { candles, volume };
    chartRef.current = chart;
    const observer = new ResizeObserver(() => chart.applyOptions({ width: containerRef.current?.clientWidth ?? 800 }));
    observer.observe(containerRef.current);
    return () => {
      observer.disconnect();
      chart.remove();
      chartRef.current = null;
    };
  }, []);

  useEffect(() => {
    const { candles, volume } = seriesRef.current;
    if (!candles || !volume || !bars.length) return;
    
    // De-duplicate and sort bars to strictly ascending order to prevent chart crashes
    const uniqueBars = Array.from(new Map(bars.map((bar) => [bar.time, bar])).values());
    const sortedBars = uniqueBars.sort((a, b) => a.time - b.time);
    
    const latestBar = sortedBars[sortedBars.length - 1];
    const latestCandle = { ...latestBar, time: latestBar.time as UTCTimestamp };
    const latestVolume = {
      time: latestBar.time as UTCTimestamp,
      value: latestBar.volume,
      color: latestBar.close >= latestBar.open ? "#41624f" : "#693e3b",
    };
    if (!initializedRef.current) {
      candles.setData(sortedBars.map((bar) => ({ ...bar, time: bar.time as UTCTimestamp })));
      volume.setData(sortedBars.map((bar) => ({ time: bar.time as UTCTimestamp, value: bar.volume, color: bar.close >= bar.open ? "#41624f" : "#693e3b" })));
      initializedRef.current = true;
      chartRef.current?.timeScale().fitContent();
    } else if (renderedTimeRef.current !== null && latestBar.time < renderedTimeRef.current) {
      // Time went backwards (e.g. timeframe changed) — full reset
      candles.setData(sortedBars.map((bar) => ({ ...bar, time: bar.time as UTCTimestamp })));
      volume.setData(sortedBars.map((bar) => ({ time: bar.time as UTCTimestamp, value: bar.volume, color: bar.close >= bar.open ? "#41624f" : "#693e3b" })));
      chartRef.current?.timeScale().fitContent();
    } else {
      try {
        candles.update(latestCandle);
        volume.update(latestVolume);
      } catch {
        // Fallback: full reset if update fails (e.g. time mismatch)
        candles.setData(sortedBars.map((bar) => ({ ...bar, time: bar.time as UTCTimestamp })));
        volume.setData(sortedBars.map((bar) => ({ time: bar.time as UTCTimestamp, value: bar.volume, color: bar.close >= bar.open ? "#41624f" : "#693e3b" })));
      }
    }
    renderedTimeRef.current = latestBar.time;
    const chart = chartRef.current;
    if (!chart) return;
    const overlayState = overlays.join(",");
    for (const name of ["ema20", "sma50"]) {
      if (!overlays.includes(name)) {
        if (overlayStateRef.current.includes(name)) seriesRef.current[name]?.setData([]);
        continue;
      }
      if (!seriesRef.current[name]) {
        seriesRef.current[name] = chart.addSeries(LineSeries, {
          color: name === "ema20" ? "#f3b85b" : "#71b7d5",
          lineWidth: 2,
          priceLineVisible: false,
          lastValueVisible: false,
        });
      }
      const values = name === "ema20" ? indicatorSeries.ema20 : indicatorSeries.sma50;
      // Always use setData for overlays to avoid time mismatch issues with update()
      seriesRef.current[name].setData(
        sortedBars.slice(0, values.length).flatMap((bar, index) =>
          values[index] === null ? [] : [{ time: bar.time as UTCTimestamp, value: values[index] as number }]
        )
      );
    }
    overlayStateRef.current = overlayState;
  }, [bars, indicatorSeries, overlays]);

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

    if (position && (position.quantity ?? 0) > 0) {
      if (position.average_entry_price) {
        priceLinesRef.current.entry = candles.createPriceLine({
          price: position.average_entry_price,
          color: "#38bdf8",
          lineWidth: 1,
          lineStyle: LineStyle.Solid,
          axisLabelVisible: true,
          title: "ENTRY",
        });
      }
      if (position.take_profit_price) {
        priceLinesRef.current.tp = candles.createPriceLine({
          price: position.take_profit_price,
          color: "#8bd450",
          lineWidth: 1,
          lineStyle: LineStyle.Dashed,
          axisLabelVisible: true,
          title: "TAKE PROFIT",
        });
      }
      if (position.stop_loss_price) {
        priceLinesRef.current.sl = candles.createPriceLine({
          price: position.stop_loss_price,
          color: "#ef7156",
          lineWidth: 1,
          lineStyle: LineStyle.Dashed,
          axisLabelVisible: true,
          title: "STOP LOSS",
        });
      }
    }
  }, [position?.average_entry_price, position?.stop_loss_price, position?.take_profit_price, position?.quantity]);

  return <div ref={containerRef} className="chart-shell" aria-label="BTC-USD one minute candlestick chart" />;
}