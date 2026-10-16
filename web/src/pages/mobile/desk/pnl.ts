// The phone Desk chart's data: today's desk P&L from the store (minute bars, the 5 s series, the fills tape)
// or the last 24 h from /api/history, as ExChart points. Earlier points keep their objects between updates
// (`keep`), so ExChart only updates the tail.
import type { HistBar } from "../../../api";
import type { DayBars, Fill, SeriesPoint } from "../../../protocol";
import type { ExOhlc, ExPoint } from "../../../components/ex";
import { MIN, bucket, todayRows } from "../../desk/model";

export type PnlIv = "line" | "1m" | "5m" | "15m";
export const PNL_STEP: Record<PnlIv, number> = { line: 60_000, "1m": 60_000, "5m": 300_000, "15m": 900_000 };


/** One bar of the chart: Day PnL as OHLC, the parts at the bar's close, the notional filled in it. */
export interface PnlBar {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  trading: number | null;
  mm: number | null;
  inv: number | null;
  hedge: number | null;
  rebates: number | null;
  vol: number;
}

export interface PnlData {
  /** Day PnL: candles (an interval) or points (Line). */
  main: ExOhlc[] | ExPoint[];
  trading: ExPoint[];
  mm: ExPoint[];
  inv: ExPoint[];
  hedge: ExPoint[];
  rebates: ExPoint[];
  vol: ExPoint[];
  bars: PnlBar[];
}

const EMPTY: PnlData = { main: [], trading: [], mm: [], inv: [], hedge: [], rebates: [], vol: [], bars: [] };

/**
 * Today's bars of `step` from the minute bars, the live 5 s series over them, and the fills after the last bar:
 * the desktop Desk chart's rows (desk/model.ts), so both layouts draw the same bars and the forming minute
 * follows the 5 s series.
 */
export function todayBars(dayStart: number, bars: DayBars | undefined, series: readonly SeriesPoint[] | undefined, fills: readonly Fill[] | undefined, step: number): PnlBar[] {
  return bucket(todayRows(bars, series, fills, dayStart, MIN), step).map((r) => ({
    time: r.t,
    open: r.o,
    high: r.h,
    low: r.l,
    close: r.c,
    trading: r.trading,
    mm: r.mm,
    inv: r.trading != null && r.mm != null ? r.trading - r.mm : null,
    hedge: r.hedge,
    rebates: null,
    vol: r.vol,
  }));
}

/** The last 24 h from /api/history (already bars of the step). */
export function histBars(bars: readonly HistBar[] | undefined): PnlBar[] {
  return (bars ?? []).map((b) => ({
    time: b.t,
    open: b.o,
    high: b.h,
    low: b.l,
    close: b.c,
    trading: b.pi,
    mm: b.mm,
    inv: b.pi != null && b.mm != null ? b.pi - b.mm : null,
    hedge: b.hedge,
    rebates: b.rebates,
    vol: b.volume,
  }));
}

const same = (a: ExPoint | ExOhlc, b: ExPoint | ExOhlc) => {
  if (a.time !== b.time) return false;
  if ("open" in a && "open" in b) return a.open === b.open && a.high === b.high && a.low === b.low && a.close === b.close;
  return (a as ExPoint).value === (b as ExPoint).value && (a as ExPoint).color === (b as ExPoint).color;
};

/** `next` with `prev`'s objects wherever a point is unchanged: ExChart then updates only the changed tail. */
export function keep<T extends ExPoint | ExOhlc>(prev: readonly T[] | undefined, next: T[]): T[] {
  if (!prev?.length) return next;
  const n = Math.min(prev.length, next.length);
  let i = 0;
  while (i < n && same(prev[i]!, next[i]!)) {
    next[i] = prev[i]!;
    i++;
  }
  return next;
}

/** ExChart's series data from the bars; `line`: Day PnL as a line on the finest points (`fine`). */
export function toChart(bars: PnlBar[], line: boolean, fine: readonly { t: number; v: number }[] | null, prev: PnlData | null, volColor: string): PnlData {
  if (!bars.length) return EMPTY;
  const pts = (f: (b: PnlBar) => number | null) => bars.map((b) => ({ time: b.time, value: f(b) }));
  const main: ExPoint[] | ExOhlc[] = line
    ? fine
      ? fine.map((p) => ({ time: p.t, value: p.v }))
      : pts((b) => b.close)
    : bars.map((b) => ({ time: b.time, open: b.open, high: b.high, low: b.low, close: b.close }));
  const hasReb = bars.some((b) => b.rebates != null);
  const d: PnlData = {
    main: keep(prev?.main as (ExPoint | ExOhlc)[] | undefined, main as (ExPoint | ExOhlc)[]) as ExPoint[] | ExOhlc[],
    trading: keep(prev?.trading, pts((b) => b.trading)),
    mm: keep(prev?.mm, pts((b) => b.mm)),
    inv: keep(prev?.inv, pts((b) => b.inv)),
    hedge: keep(prev?.hedge, pts((b) => b.hedge)),
    rebates: hasReb ? keep(prev?.rebates, pts((b) => b.rebates)) : [],
    vol: keep(prev?.vol, bars.map((b) => ({ time: b.time, value: b.vol, color: volColor }))),
    bars,
  };
  return d;
}
