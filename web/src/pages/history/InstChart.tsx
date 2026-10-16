// An instrument's history on ExChart: Binance's klines, our fills on them (one small hollow ring per bar and side
// at our VWAP, hidden while the bars are dense; counts and prices in the legend), the market's volume with
// ours, and what we bought net over the range.
import { useMemo, useRef, type ReactNode } from "react";
import {
  ExChart,
  fillMarkers,
  fillsByBar,
  fillsShort,
  fillsText,
  rgba,
  volumePoints,
  type Candle,
  type Chip,
  type ExLegendItem,
  type ExPoint,
  type ExPriceLine,
  type ExSeries,
  type ExView,
  type KInterval,
} from "../../components/ex";
import type { HistFill } from "../../api";
import { C, INV_COLOR } from "../../theme";
import { compact, price, qty } from "../../format";
import type { HInterval } from "./data";
import { maskFormat } from "../../mask";

const KI: Record<HInterval, KInterval> = { "15m": "15m", "1h": "1h", "4h": "4h", "1d": "1d", "1w": "1w" };

export function InstChart({
  symbol,
  bars,
  fills,
  interval,
  avgCost,
  loading,
  error,
  toolbarLeft,
  intervals,
  onInterval,
  view,
  hide,
  onBarClick,
}: {
  symbol: string;
  bars: Candle[];
  fills: HistFill[];
  interval: HInterval;
  avgCost: number | null;
  loading: boolean;
  error: string | null;
  toolbarLeft: ReactNode;
  intervals: { value: string; label: string }[];
  onInterval: (v: string) => void;
  view: ExView | null;
  /** Hide amounts: our notional and net quantity read •••. */
  hide: boolean;
  /** A click on a bar. */
  onBarClick?: (t: number) => void;
}) {
  const kIv = KI[interval];
  const byBar = useMemo(() => fillsByBar(fills, kIv), [fills, kIv]);

  // our notional per bar, and the running net quantity from the range start; a point that comes out the same
  // keeps its object, so a live candle redraws only the tail
  const prev = useRef<{ ours: ExPoint[]; net: ExPoint[] }>({ ours: [], net: [] });
  const { ours, net } = useMemo(() => {
    const ours: ExPoint[] = [];
    const net: ExPoint[] = [];
    const po = prev.current.ours,
      pn = prev.current.net;
    let run = 0;
    bars.forEach((b, i) => {
      const f = byBar.get(b.time);
      const n = f ? f.buyQty * (f.buyVwap ?? 0) + f.sellQty * (f.sellVwap ?? 0) : 0;
      if (f) run += f.buyQty - f.sellQty;
      const o = po[i],
        q = pn[i];
      ours.push(o && o.time === b.time && o.value === n ? o : { time: b.time, value: n, color: rgba(C.ink, 0.8) });
      net.push(q && q.time === b.time && q.value === run ? q : { time: b.time, value: run });
    });
    prev.current = { ours, net };
    return { ours, net };
  }, [bars, byBar]);

  const series = useMemo<ExSeries[]>(
    () => [
      { key: "k", kind: "candles", label: symbol, data: bars, toggle: false, format: price },
      { key: "vol", kind: "histogram", label: "Vol(USDT)", pane: 1, data: volumePoints(bars, true), format: (v) => compact(v) },
      { key: "ours", kind: "histogram", label: "Ours", pane: 1, data: ours, color: C.ink, format: maskFormat(hide, (v) => compact(v)) },
      { key: "net", kind: "line", label: "Net qty", pane: 2, color: INV_COLOR, data: net, format: maskFormat(hide, (v) => qty(v, true)), lastValue: true },
    ],
    [symbol, bars, ours, net, hide],
  );

  const legendExtra = useMemo<ExLegendItem[]>(
    () => [
      ...(avgCost ? [{ key: "avg", label: "Avg cost", color: C.muted, value: () => price(avgCost), title: "Today's average cost of the inventory held" }] : []),
      { key: "fills", label: "Fills", value: (t: number) => fillsText(byBar.get(t)), box: (t: number) => fillsShort(byBar.get(t)) },
    ],
    [byBar, avgCost],
  );

  const markers = useMemo(() => fillMarkers(byBar, "k"), [byBar]);
  const priceLines = useMemo<ExPriceLine[]>(
    () => (avgCost ? [{ series: "k", key: "avg", price: avgCost, color: C.muted, style: "large", labelColor: C.raised, labelTextColor: C.ink }] : []),
    [avgCost],
  );
  const chips: (Chip | "|")[] = [
    { key: "fills", label: "Fills", color: C.up, ring: true },
    ...(avgCost ? [{ key: "avg", label: "Avg cost", color: C.muted, stroke: "large" as const }] : []),
    "|",
    { key: "vol", label: "Vol" },
    { key: "ours", label: "Ours", color: C.ink, bar: true },
    { key: "net", label: "Net qty", color: INV_COLOR },
  ];

  return (
    <ExChart
      id="hist-inst"
      fill
      series={series}
      paneStretch={[1, 0.22, 0.2]}
      toolbarLeft={toolbarLeft}
      intervals={intervals}
      interval={interval}
      onInterval={onInterval}
      fullscreen
      title={symbol}
      loading={loading}
      emptyText={error ?? "No klines in this range"}
      markers={markers}
      priceLines={priceLines}
      legendExtra={legendExtra}
      chips={chips}
      initialBars={interval === "15m" ? 700 : undefined}
      resetKey={symbol}
      rightOffset={interval === "1d" || interval === "1w" ? 1 : undefined}
      view={view}
      onBarClick={onBarClick}
    />
  );
}
