// The phone Desk chart's data: today's desk P&L from the store (minute bars, the 5 s series, the fills tape)
// or the last 24 h from /api/history, as ExChart points. Earlier points keep their objects between updates
// (`keep`), so ExChart only updates the tail.
import type { HistBar } from "../../../api";
import type { DayBars, Fill, SeriesPoint } from "../../../protocol";
import type { ExOhlc, ExPoint } from "../../../components/ex";

export type PnlIv = "line" | "1m" | "5m" | "15m";
export const PNL_STEP: Record<PnlIv, number> = { line: 60_000, "1m": 60_000, "5m": 300_000, "15m": 900_000 };

const MIN = 60_000;

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

/** Today's bars of `step` from the minute bars, the live 5 s series over them, and the fills after the last bar. */
export function todayBars(dayStart: number, bars: DayBars | undefined, series: readonly SeriesPoint[] | undefined, fills: readonly Fill[] | undefined, step: number): PnlBar[] {
  const out = new Map<number, PnlBar>();
  const at = (t: number, v: number): PnlBar => {
    const k = Math.floor(t / step) * step;
    let b = out.get(k);
    if (!b) out.set(k, (b = { time: k, open: v, high: v, low: v, close: v, trading: null, mm: null, inv: null, hedge: null, rebates: null, vol: 0 }));
    return b;
  };
  const move = (b: PnlBar, v: number) => {
    b.high = Math.max(b.high, v);
    b.low = Math.min(b.low, v);
    b.close = v;
  };
  let lastBar = dayStart - MIN;
  if (bars) {
    for (let i = 0; i < bars.t.length; i++) {
      const t = bars.t[i]!;
      if (t < dayStart) continue;
      const v = bars.pnl_day[i]!;
      const b = at(t, v);
      move(b, v);
      const pi = bars.trading[i] ?? null;
      const mm = bars.mm[i] ?? null;
      if (pi != null) b.trading = pi;
      if (mm != null) b.mm = mm;
      if (pi != null && mm != null) b.inv = pi - mm;
      if (bars.hedge[i] != null) b.hedge = bars.hedge[i]!;
      b.vol += bars.volume[i] ?? 0;
      lastBar = t;
    }
  }
  // the 5 s series moves the minutes the bars have not closed yet (and gives the minutes their highs and lows)
  for (const p of series ?? []) {
    if (p.t < dayStart) continue;
    const b = at(p.t, p.pnl_day);
    if (p.t >= lastBar + MIN) {
      move(b, p.pnl_day);
      if (p.trading != null) {
        b.trading = p.trading;
        if (b.mm != null) b.inv = p.trading - b.mm;
      }
    } else {
      b.high = Math.max(b.high, p.pnl_day);
      b.low = Math.min(b.low, p.pnl_day);
    }
  }
  // the notional of the minutes after the last bar, from the tape
  for (const f of fills ?? []) {
    if (f.ts < lastBar + MIN) break; // newest first
    const b = out.get(Math.floor(f.ts / step) * step);
    if (b) b.vol += f.notional;
  }
  const list = [...out.values()].sort((a, b) => a.time - b.time);
  // a bar opens where the last one closed; the parts carry forward over minutes without them
  for (let i = 1; i < list.length; i++) {
    const p = list[i - 1]!;
    const b = list[i]!;
    b.open = p.close;
    b.high = Math.max(b.high, b.open);
    b.low = Math.min(b.low, b.open);
    b.mm ??= p.mm;
    b.hedge ??= p.hedge;
    if (b.inv == null && b.trading != null && b.mm != null) b.inv = b.trading - b.mm;
  }
  return list;
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
