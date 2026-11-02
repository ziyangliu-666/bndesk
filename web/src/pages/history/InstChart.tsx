// An instrument's history on ExChart: Binance's klines, our fills on them (one small hollow ring per bar and side
// at our VWAP, hidden while the bars are dense; counts and prices in the legend), the market's volume with
// ours, and what we bought net since the range's start. The chart holds more bars than the range, which is the
// view it opens on; before the fills loaded (`fillsFrom`) ours and the net are blank, not zero.
import { useMemo, useRef, type ReactNode } from "react";
import {
  ExChart,
  INTERVAL_MS,
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
import { notionalCur } from "../../desk";

const KI: Record<HInterval, KInterval> = { "15m": "15m", "1h": "1h", "4h": "4h", "1d": "1d", "1w": "1w" };

export function InstChart({
  symbol,
  bars,
  fills,
  fillsFrom,
  range,
  rangeFrom,
  inRange,
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
  onNearStart,
  onViewStart,
}: {
  symbol: string;
  bars: Candle[];
  fills: HistFill[];
  /** Our fills are loaded from this time on. */
  fillsFrom: number;
  /** The range the view opens on, its start, and the bars in it. */
  range: string;
  rangeFrom: number;
  inRange: number;
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
  onNearStart?: () => void;
  onViewStart?: (t: number) => void;
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
    const step = INTERVAL_MS[kIv];
    const known = (t: number) => t + step > fillsFrom;
    // the net reads 0 where the range starts and goes on either side of it
    let run = 0;
    for (const b of bars) {
      if (b.time + step > rangeFrom) break;
      const f = byBar.get(b.time);
      if (f) run -= f.buyQty - f.sellQty;
    }
    bars.forEach((b, i) => {
      const f = byBar.get(b.time);
      const n = !known(b.time) ? null : f ? f.buyQty * (f.buyVwap ?? 0) + f.sellQty * (f.sellVwap ?? 0) : 0;
      if (f) run += f.buyQty - f.sellQty;
      const v = known(b.time) ? run : null;
      const o = po[i],
        q = pn[i];
      ours.push(o && o.time === b.time && o.value === n ? o : { time: b.time, value: n, color: rgba(C.ink, 0.8) });
      net.push(q && q.time === b.time && q.value === v ? q : { time: b.time, value: v });
    });
    prev.current = { ours, net };
    return { ours, net };
  }, [bars, byBar, fillsFrom, rangeFrom, kIv]);

  const series = useMemo<ExSeries[]>(
    () => [
      { key: "k", kind: "candles", label: symbol, data: bars, toggle: false, format: price },
      { key: "vol", kind: "histogram", label: `Vol(${notionalCur()})`, pane: 1, data: volumePoints(bars, true), format: (v) => compact(v) },
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
      initialBars={Math.max(2, interval === "15m" ? Math.min(700, inRange) : inRange)}
      resetKey={`${symbol}|${range}`}
      rightOffset={1}
      fixEdges
      view={view}
      onBarClick={onBarClick}
      onNearStart={onNearStart}
      onViewStart={onViewStart}
    />
  );
}
