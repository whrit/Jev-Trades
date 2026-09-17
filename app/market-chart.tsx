"use client";

import { useEffect, useRef } from "react";
import { CandlestickSeries, ColorType, createChart, HistogramSeries, LineSeries, type UTCTimestamp } from "lightweight-charts";

type Bar = { time: number; open: number; high: number; low: number; close: number; volume: number };
type IndicatorSeries = { ema20: (number | null)[]; sma50: (number | null)[] };

export default function MarketChart({ bars, indicatorSeries, overlays }: { bars: Bar[]; indicatorSeries: IndicatorSeries; overlays: string[] }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<ReturnType<typeof createChart> | null>(null);
  const seriesRef = useRef<Record<string, ReturnType<ReturnType<typeof createChart>["addSeries"]>>>({});
  const initializedRef = useRef(false);
  const renderedTimeRef = useRef<number | null>(null);
  const overlayStateRef = useRef("");

  useEffect(() => {
    if (!containerRef.current) return;
    const chart = createChart(containerRef.current, { layout: { background: { type: ColorType.Solid, color: "#111a1b" }, textColor: "#8b9d9d" }, grid: { vertLines: { color: "#1e2b2c" }, horzLines: { color: "#1e2b2c" } }, width: containerRef.current.clientWidth, height: 440, rightPriceScale: { borderColor: "#2c3b3c" }, timeScale: { borderColor: "#2c3b3c", timeVisible: true, secondsVisible: false } });
    const candles = chart.addSeries(CandlestickSeries, { upColor: "#8bd450", downColor: "#ef7156", borderVisible: false, wickUpColor: "#8bd450", wickDownColor: "#ef7156" });
    const volume = chart.addSeries(HistogramSeries, { priceFormat: { type: "volume" }, priceScaleId: "", color: "#3f5a58", lastValueVisible: false, priceLineVisible: false });
    chart.priceScale("").applyOptions({ scaleMargins: { top: 0.82, bottom: 0 } });
    seriesRef.current = { candles, volume }; chartRef.current = chart;
    const observer = new ResizeObserver(() => chart.applyOptions({ width: containerRef.current?.clientWidth ?? 800 })); observer.observe(containerRef.current);
    return () => { observer.disconnect(); chart.remove(); chartRef.current = null; };
  }, []);

  useEffect(() => {
    const { candles, volume } = seriesRef.current;
    if (!candles || !volume || !bars.length) return;
    const latestBar = bars[bars.length - 1];
    const latestCandle = { ...latestBar, time: latestBar.time as UTCTimestamp };
    const latestVolume = { time: latestBar.time as UTCTimestamp, value: latestBar.volume, color: latestBar.close >= latestBar.open ? "#41624f" : "#693e3b" };
    if (!initializedRef.current) {
      candles.setData(bars.map((bar) => ({ ...bar, time: bar.time as UTCTimestamp })));
      volume.setData(bars.map((bar) => ({ time: bar.time as UTCTimestamp, value: bar.volume, color: bar.close >= bar.open ? "#41624f" : "#693e3b" })));
      initializedRef.current = true;
      chartRef.current?.timeScale().fitContent();
    } else if (renderedTimeRef.current === latestBar.time || (renderedTimeRef.current !== null && latestBar.time > renderedTimeRef.current)) {
      candles.update(latestCandle);
      volume.update(latestVolume);
    }
    renderedTimeRef.current = latestBar.time;
    const chart = chartRef.current; if (!chart) return;
    const overlayState = overlays.join(",");
    for (const name of ["ema20", "sma50"]) {
      if (!overlays.includes(name)) {
        if (overlayStateRef.current.includes(name)) seriesRef.current[name]?.setData([]);
        continue;
      }
      if (!seriesRef.current[name]) seriesRef.current[name] = chart.addSeries(LineSeries, { color: name === "ema20" ? "#f3b85b" : "#71b7d5", lineWidth: 2, priceLineVisible: false, lastValueVisible: false });
      const values = name === "ema20" ? indicatorSeries.ema20 : indicatorSeries.sma50;
      if (!overlayStateRef.current.includes(name)) {
        seriesRef.current[name].setData(bars.slice(0, values.length).flatMap((bar, index) => values[index] === null ? [] : [{ time: bar.time as UTCTimestamp, value: values[index] as number }]));
      } else if (values.length > 0) {
        const latestValue = values[values.length - 1];
        const latestCompletedBar = bars[values.length - 1];
        if (latestValue !== null && latestCompletedBar) seriesRef.current[name].update({ time: latestCompletedBar.time as UTCTimestamp, value: latestValue });
      }
    }
    overlayStateRef.current = overlayState;
  }, [bars, indicatorSeries, overlays]);

  return <div ref={containerRef} className="chart-shell" aria-label="BTC-USD one minute candlestick chart" />;
}