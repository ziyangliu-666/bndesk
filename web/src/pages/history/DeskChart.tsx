// The desk's P&L history on ExChart: the running P&L as candles (each bar opens where the one before it closed),
// volume under it. One chart, no modes: the split, the per-day bars and the inventory are in the tables and the
// side column, not here.
import { useMemo } from "react";
import { ExChart, rgba, type ExLegendItem, type ExPoint, type ExOhlc, type ExSeries, type ExView } from "../../components/ex";
import { maskFormat } from "../../mask";
import { REF_LINE } from "../../components/ex/palette";
import { C, PNL_COLORS, PNL_STROKES, type Stroke } from "../../theme";
import { compact, num, int } from "../../format";
import { type HInterval, type Part, type Row } from "./data";
import { notionalCur } from "../../desk";

export const PART_META: Record<Part, { label: string; long: string; color: string; title?: string; style: Stroke }> = {
  pi: { label: "Trading", long: "Trading PnL", color: PNL_COLORS.trading, style: PNL_STROKES.trading, title: "Trading PnL: market making plus inventory PnL, fees included; not hedged" },
  mm: { label: "Market making", long: "Market making", color: PNL_COLORS.mm, style: PNL_STROKES.mm, title: "Market making: each fill against the mid 60 s later, minus fees" },
  inv: { label: "Inventory PnL", long: "Inventory PnL", color: PNL_COLORS.inv, style: PNL_STROKES.inv, title: "Inventory PnL: what the held inventory made after those 60 s" },
  hedge: { label: "Hedge", long: "Hedge", color: PNL_COLORS.hedge, style: PNL_STROKES.hedge, title: "The hedge's legs: price, fees, funding" },
  reb: { label: "Rebates", long: "Rebates", color: PNL_COLORS.reb, style: PNL_STROKES.reb, title: "Market-maker rebates" },
  other: { label: "Other", long: "Other", color: PNL_COLORS.other, style: PNL_STROKES.other, title: "What the split does not explain: Day PnL − trading − hedge − rebates" },
};
const sign2 = (v: number) => num(v, 2, true);

// one cache per drawn series: a row object gives the same point object, so a live tick redraws only the tail
const caches = new Map<string, WeakMap<Row, ExPoint | ExOhlc>>();
function points<P extends ExPoint | ExOhlc>(key: string, rows: Row[], f: (r: Row) => P): P[] {
  let m = caches.get(key);
  if (!m) caches.set(key, (m = new WeakMap()));
  return rows.map((r) => {
    let p = m!.get(r) as P | undefined;
    if (!p) m!.set(r, (p = f(r)));
    return p;
  });
}

export function periodWord(iv: HInterval): string {
  return iv === "1w" ? "Week" : iv === "1d" ? "Day" : "Bar";
}

export function DeskChart({
  rows,
  range,
  inRange,
  interval,
  loading,
  error,
  intervals,
  onInterval,
  view,
  legendTime,
  chosen,
  onBarClick,
  hide,
}: {
  rows: Row[];
  /** The range the view opens on, and the rows in it (the rest are there to scroll to). */
  range: string;
  inRange: number;
  interval: HInterval;
  loading: boolean;
  error: string | null;
  intervals: { value: string; label: string }[];
  onInterval: (v: string) => void;
  /** A range the page zooms to (a chosen day). */
  view: ExView | null;
  /** The bar the legend shows at rest (the chosen day's). */
  legendTime?: number | null;
  /** The chosen day's (week's) bar, ms: marked on the chart. */
  chosen?: number | null;
  /** A click on a bar. */
  onBarClick?: (t: number) => void;
  /** Hide amounts: the axis and legend figures read •••. */
  hide: boolean;
}) {
  const sgn = maskFormat(hide, sign2);
  const vol = maskFormat(hide, (v: number) => compact(v));
  const word = periodWord(interval);
  const byT = useMemo(() => new Map(rows.map((r) => [r.t, r])), [rows]);

  const series = useMemo<ExSeries[]>(
    () => [
      {
        key: "k",
        kind: "candles",
        label: "Cumulative PnL",
        toggle: false,
        format: sgn,
        // a row's o/h/l/c are from its day's (week's) start, moved onto the running total by what that start
        // stood at, so each bar opens where the one before it closed
        data: points("k", rows, (r) => {
          const off = r.cum - r.c;
          return { time: r.t, open: r.o + off, high: Math.max(r.h, r.o, r.c) + off, low: Math.min(r.l, r.o, r.c) + off, close: r.cum };
        }),
      },
      {
        key: "vol",
        kind: "histogram",
        label: `Vol(${notionalCur()})`,
        pane: 1,
        toggle: false,
        color: rgba(C.ink2, 0.32),
        format: vol,
        data: points("vol", rows, (r) => ({ time: r.t, value: r.volume })),
      },
    ],
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [rows, hide],
  );
  const markers = useMemo(
    () => (chosen != null && rows.some((r) => r.t === chosen) ? [{ series: "k", time: chosen, color: C.accent, shape: "arrowUp" as const, position: "belowBar" as const, size: 1 }] : []),
    [chosen, rows],
  );
  const legendExtra = useMemo<ExLegendItem[]>(
    () => [
      { label: "Fills", pane: 1, line: 1, value: (t) => [int(byT.get(t)?.fills), C.ink] },
    ],
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [byT, word, hide],
  );
  const zeroLine = useMemo(() => [{ series: "k", price: 0, color: REF_LINE, style: "solid" as const, axisLabel: false }], []);

  return (
    <ExChart
      id="hist"
      fill
      series={series}
      paneStretch={[1, 0.22]}
      intervals={intervals}
      interval={interval}
      onInterval={onInterval}
      fullscreen
      legendRest="names"
      title="Desk PnL"
      loading={loading}
      emptyText={error ? "Could not load the history" : "No data yet"}
      legendExtra={legendExtra}
      priceLines={zeroLine}
      initialBars={Math.max(2, interval === "15m" ? Math.min(700, inRange) : inRange)}
      resetKey={range}
      rightOffset={1}
      fixEdges
      view={view}
      legendTime={legendTime}
      markers={markers}
      onBarClick={onBarClick}
    />
  );
}
