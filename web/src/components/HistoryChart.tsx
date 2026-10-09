// History charts on TradingView Lightweight Charts v5 (Apache-2.0; the attribution logo stays on).
// Panes share one time axis and crosshair. Times are UTC seconds; labels follow the tz toggle.
import { useEffect, useRef, useState, type ReactNode } from "react";
import {
  CandlestickSeries,
  ColorType,
  CrosshairMode,
  HistogramSeries,
  LineSeries,
  LineStyle,
  TickMarkType,
  createChart,
  createTextWatermark,
  type AutoscaleInfo,
  type DeepPartial,
  type IChartApi,
  type IPrimitivePaneRenderer,
  type IPrimitivePaneView,
  type ISeriesApi,
  type ISeriesPrimitive,
  type ChartOptions,
  type SeriesAttachedParameter,
  type SeriesType,
  type Time,
  type UTCTimestamp,
} from "lightweight-charts";
import { C, FUT_COLOR, HEDGE_COLOR, INV_COLOR, INVPNL_COLOR, MM_COLOR, S1, S2, SANS } from "../theme";
import { SeriesWord, useSeriesToggle } from "./ui";
import { DASH, int, num, pnl, price, qty, usdShort, type TzMode } from "../format";
import type { HistBar, HistDay, HistFill, Kline } from "../api";
import { serverNow, useStore } from "../store";

const VOL = "rgba(163,173,189,0.42)";
const GRID = "#0e1217";
const HEDGE = HEDGE_COLOR;
const OTHER_COLOR = "#4a5262"; // the per-bar remainder: quiet, it is usually small
const VOL_WORD = "#a3adbd";
export const sec = (ms: number) => Math.floor(ms / 1000) as UTCTimestamp;

// ---- time labels ----
const pad = (n: number) => (n < 10 ? "0" + n : String(n));
const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
function parts(ms: number, tz: TzMode) {
  const d = new Date(ms);
  return tz === "utc"
    ? { y: d.getUTCFullYear(), mo: d.getUTCMonth(), d: d.getUTCDate(), h: d.getUTCHours(), mi: d.getUTCMinutes() }
    : { y: d.getFullYear(), mo: d.getMonth(), d: d.getDate(), h: d.getHours(), mi: d.getMinutes() };
}
export function barTime(ms: number, tz: TzMode, step: number): string {
  const p = parts(ms, tz);
  const date = `${p.y}-${pad(p.mo + 1)}-${pad(p.d)}`;
  return step >= 86400 ? date : `${date} ${pad(p.h)}:${pad(p.mi)}`;
}

export function chartOptions(tz: TzMode, step: number): DeepPartial<ChartOptions> {
  return {
    autoSize: true,
    layout: {
      background: { type: ColorType.Solid, color: C.panel },
      textColor: C.muted,
      fontFamily: SANS,
      fontSize: 11,
      attributionLogo: true,   // Apache-2.0 NOTICE: the TradingView attribution stays on the page
      panes: { separatorColor: C.rule, separatorHoverColor: "rgba(126,166,246,0.18)", enableResize: true },
    },
    grid: { vertLines: { color: GRID }, horzLines: { color: GRID } },
    crosshair: {
      mode: CrosshairMode.Normal,
      vertLine: { color: "rgba(195,202,213,0.35)", style: LineStyle.Dashed, labelBackgroundColor: C.raised },
      horzLine: { color: "rgba(195,202,213,0.35)", style: LineStyle.Dashed, labelBackgroundColor: C.raised },
    },
    rightPriceScale: { borderColor: C.rule, minimumWidth: 64 },
    timeScale: {
      borderColor: C.rule,
      timeVisible: true,
      secondsVisible: false,
      minBarSpacing: 0.1,
      rightOffset: 2,
      tickMarkFormatter: (t: Time, type: TickMarkType) => {
        const p = parts((t as number) * 1000, tz);
        switch (type) {
          case TickMarkType.Year:
            return String(p.y);
          case TickMarkType.Month:
            return MON[p.mo]!;
          case TickMarkType.DayOfMonth:
            return `${MON[p.mo]} ${p.d}`;
          default:
            return `${pad(p.h)}:${pad(p.mi)}`;
        }
      },
    },
    localization: { timeFormatter: (t: Time) => barTime((t as number) * 1000, tz, step) },
  };
}

// ---- faint vertical line at each day start ----
class DaySeparators implements ISeriesPrimitive<Time> {
  private chart: IChartApi | null = null;
  private times: number[] = [];
  private request: (() => void) | null = null;
  private view: IPrimitivePaneView = {
    zOrder: () => "normal",
    renderer: (): IPrimitivePaneRenderer => ({
      draw: (target) => {
        const ts = this.chart?.timeScale();
        if (!ts || !this.times.length) return;
        target.useBitmapCoordinateSpace(({ context: ctx, bitmapSize, horizontalPixelRatio: hpr }) => {
          ctx.fillStyle = "rgba(195,202,213,0.16)";
          const w = Math.max(1, Math.floor(hpr));
          const half = ts.options().barSpacing / 2; // on the boundary before the day's first bar
          for (const t of this.times) {
            const x = ts.timeToCoordinate(t as UTCTimestamp);
            if (x == null) continue;
            ctx.fillRect(Math.round((x - half) * hpr - w / 2), 0, w, bitmapSize.height);
          }
        });
      },
    }),
  };
  attached(p: SeriesAttachedParameter<Time, SeriesType>) {
    this.chart = p.chart as IChartApi;
    this.request = p.requestUpdate;
  }
  detached() {
    this.chart = null;
    this.request = null;
  }
  paneViews() {
    return [this.view];
  }
  set(times: number[]) {
    this.times = times;
    this.request?.();
  }
}

/** Bar times (seconds) of the first bar at or after each day start, skipping the first bar. */
function separatorTimes(barMs: number[], days: HistDay[], step: number): number[] {
  if (step >= 86400 || barMs.length < 2) return [];
  const out: number[] = [];
  let i = 0;
  for (const d of days) {
    while (i < barMs.length && barMs[i]! < d.start) i++;
    if (i >= barMs.length) break;
    if (i > 0 && barMs[i]! - d.start < step * 1000) out.push(sec(barMs[i]!));
  }
  return out;
}

const VIEW_BARS = 150; // bars shown at first; older ones by scrolling or zooming out

/** Show the latest VIEW_BARS bars (all of them when fewer), so bars stay readable. */
function fitLatest(chart: IChartApi | null, n: number) {
  if (!chart) return;
  if (n <= VIEW_BARS) chart.timeScale().fitContent();
  else chart.timeScale().setVisibleLogicalRange({ from: n - VIEW_BARS, to: n + 2 });
}

export type PnlView = "day" | "cum" | "bar";
const DAY_MS = 86_400_000;
const PARTS = ["pi", "mm", "hedge"] as const;

/** The P&L of `bars` (running totals from the first bar) as one view: "day" restarts at each day start (the
 *  dayStart grid), "cum" starts at 0 on bar `k0`, "bar" is what each bar made by itself. Other fields pass. */
export function viewBars(bars: HistBar[], view: PnlView, dayStart: number, k0 = 0): HistBar[] {
  const out: HistBar[] = new Array(bars.length);
  const last: Record<string, number | null> = { c: null, pi: null, mm: null, hedge: null };
  let base: Record<string, number> = { c: 0, pi: 0, mm: 0, hedge: 0 };
  let day = NaN;
  if (view === "cum") {
    const b0 = bars[Math.min(Math.max(k0, 0), bars.length - 1)];
    base = { c: b0?.o ?? 0, pi: 0, mm: 0, hedge: 0 };
    for (const f of PARTS) {
      let v: number | null = null;
      for (let i = Math.min(k0, bars.length) - 1; i >= 0 && v == null; i--) v = bars[i]![f];
      for (let i = Math.max(k0, 0); i < bars.length && v == null; i++) v = bars[i]![f];
      base[f] = v ?? 0;
    }
  }
  for (let i = 0; i < bars.length; i++) {
    const b = bars[i]!;
    if (view === "day") {
      const d = dayStart + Math.floor((b.t - dayStart) / DAY_MS) * DAY_MS;
      if (d !== day) {
        // the running totals at the end of the previous day; the first day in view starts from 0
        if (i > 0) base = { c: last.c ?? 0, pi: last.pi ?? 0, mm: last.mm ?? 0, hedge: last.hedge ?? 0 };
        day = d;
      }
    }
    if (view === "bar") {
      const prev = { ...last };
      const d = (f: "pi" | "mm" | "hedge") => (b[f] == null ? null : b[f]! - (prev[f] ?? b[f]!));
      const o = prev.c ?? b.o;
      out[i] = { ...b, o: 0, h: b.h - o, l: b.l - o, c: b.c - o, pi: d("pi"), mm: d("mm"), hedge: d("hedge") };
    } else {
      const sub = (v: number | null, f: string) => (v == null ? null : v - base[f]!);
      out[i] = { ...b, o: b.o - base.c!, h: b.h - base.c!, l: b.l - base.c!, c: b.c - base.c!, pi: sub(b.pi, "pi"), mm: sub(b.mm, "mm"), hedge: sub(b.hedge, "hedge") };
    }
    last.c = b.c;
    for (const f of PARTS) if (b[f] != null) last[f] = b[f];
  }
  return out;
}

/** A bar's P&L split into market making, inventory, hedge and the rest, each stacked away from 0 by sign:
 *  for each part, the far edge of its segment (later parts outside earlier ones). */
function stackParts(b: HistBar): { pos: number[]; neg: number[] } {
  const mm = b.mm ?? 0;
  const inv = b.pi != null && b.mm != null ? b.pi - b.mm : 0;
  const he = b.hedge ?? 0;
  const parts = [mm, inv, he, b.c - (b.pi ?? 0) - he];
  const pos: number[] = [], neg: number[] = [];
  let p = 0, n = 0;
  for (const v of parts) {
    if (v > 0) p += v;
    else n += v;
    pos.push(p);
    neg.push(n);
  }
  return { pos, neg };
}

type DeskSeries = {
  candle: ISeriesApi<"Candlestick">;
  pl: ISeriesApi<"Line">;
  stack: ISeriesApi<"Histogram">[];
  pi: ISeriesApi<"Line">;
  mm: ISeriesApi<"Line">;
  ip: ISeriesApi<"Line">;
  he: ISeriesApi<"Line">;
};

/** The P&L series of one view: candles and lines ("day"), a Day PnL line and the parts ("cum"), stacked
 *  per-bar parts ("bar"). The series a view does not use are left empty. */
function draw(x: DeskSeries, vb: HistBar[], view: PnlView) {
  const pt = (b: HistBar, v: number | null) => (v == null ? [] : [{ time: sec(b.t), value: v }]);
  const lines = view !== "bar";
  x.candle.setData(view === "day" ? vb.map((b) => ({ time: sec(b.t), open: b.o, high: b.h, low: b.l, close: b.c })) : []);
  x.pl.setData(view === "cum" ? vb.map((b) => ({ time: sec(b.t), value: b.c })) : []);
  x.pi.setData(lines ? vb.flatMap((b) => pt(b, b.pi)) : []);
  x.mm.setData(lines ? vb.flatMap((b) => pt(b, b.mm)) : []);
  x.ip.setData(lines ? vb.flatMap((b) => pt(b, b.pi == null || b.mm == null ? null : b.pi - b.mm)) : []);
  x.he.setData(lines ? vb.flatMap((b) => pt(b, b.hedge)) : []);
  const st = view === "bar" ? vb.map(stackParts) : [];
  for (let k = 0; k < 4; k++)
    for (const sgn of [0, 1])
      x.stack[k * 2 + sgn]!.setData(vb.flatMap((b, i) => (view === "bar" ? [{ time: sec(b.t), value: (sgn ? st[i]!.neg : st[i]!.pos)[k]! }] : [])));
}

/** The newest bar of a view, as an update. */
function drawLast(x: DeskSeries, b: HistBar, view: PnlView) {
  const t = sec(b.t);
  if (view === "day") x.candle.update({ time: t, open: b.o, high: b.h, low: b.l, close: b.c });
  if (view === "cum") x.pl.update({ time: t, value: b.c });
  if (view === "bar") {
    const st = stackParts(b);
    for (let k = 0; k < 4; k++) {
      x.stack[k * 2]!.update({ time: t, value: st.pos[k]! });
      x.stack[k * 2 + 1]!.update({ time: t, value: st.neg[k]! });
    }
    return;
  }
  if (b.pi != null) x.pi.update({ time: t, value: b.pi });
  if (b.mm != null) x.mm.update({ time: t, value: b.mm });
  if (b.pi != null && b.mm != null) x.ip.update({ time: t, value: b.pi - b.mm });
  if (b.hedge != null) x.he.update({ time: t, value: b.hedge });
}

/** Today's live figures as the newest bar. Within a day each running total is the last bar before the day
 *  start (yesterday's close, in the same running total) plus today's own figure; `prev` is the newest bar. */
function liveBar(bars: HistBar[], prev: HistBar | null, dayStart: number, stepMs: number, now: number,
                 v: { pnl: number; pi: number; mm: number; hedge: number | null; inventory: number; futures: number }): HistBar | null {
  const last = bars[bars.length - 1];
  if (!last) return null;
  let k = bars.length - 1;
  while (k >= 0 && bars[k]!.t >= dayStart) k--;
  const base = (f: (b: HistBar) => number | null) => {
    for (let i = k; i >= 0; i--) {
      const x = f(bars[i]!);
      if (x != null) return x;
    }
    return 0;
  };
  const t = dayStart + Math.floor((now - dayStart) / stepMs) * stepMs;
  if (t < last.t) return null;
  const c = base((b) => b.c) + v.pnl;
  const open = prev && prev.t === t ? prev : t === last.t ? last : null;
  return {
    t,
    o: open ? open.o : c,
    h: Math.max(open ? open.h : c, c),
    l: Math.min(open ? open.l : c, c),
    c,
    pi: base((b) => b.pi) + v.pi,
    mm: base((b) => b.mm) + v.mm,
    realized: open?.realized ?? null,
    hedge: v.hedge == null ? (open?.hedge ?? null) : base((b) => b.hedge) + v.hedge,
    inventory: v.inventory,
    futures: v.futures,
    volume: open ? open.volume : 0,
    fills: open ? open.fills : 0,
  };
}

/** Asks for older bars when the view comes within a few bars of the left edge. */
function onLeftEdge(chart: IChartApi, older: { current?: () => void }) {
  chart.timeScale().subscribeVisibleLogicalRangeChange((r) => {
    if (r && r.from < 10) older.current?.();
  });
}

/** After older bars were put in front, move the view by as many bars so it shows the same time. */
function keepView(chart: IChartApi | null, prevFirst: number | null, times: number[]) {
  if (!chart || prevFirst == null || !times.length || times[0]! >= prevFirst) return;
  const shift = times.findIndex((t) => t >= prevFirst);
  const r = chart.timeScale().getVisibleLogicalRange();
  if (r && shift > 0) chart.timeScale().setVisibleLogicalRange({ from: r.from + shift, to: r.to + shift });
}

/** Volume scale capped at 1.2 × the 98th percentile, so one huge bar does not flatten the rest. */
export function capAt(values: number[]): number | null {
  const xs = values.filter((v) => v > 0).sort((a, b) => a - b);
  if (xs.length < 20) return null;
  return xs[Math.floor(xs.length * 0.98)]! * 1.2;
}

function paneLabel(chart: IChartApi, pane: number, text: string) {
  return createTextWatermark(chart.panes()[pane]!, {
    horzAlign: "left",
    vertAlign: "top",
    lines: [{ text, color: "rgba(138,148,165,0.75)", fontSize: 10, fontFamily: SANS, fontStyle: "" }],
  });
}

export const usdFmt = { type: "custom" as const, formatter: (v: number) => usdShort(v), minMove: 0.01 };
export const quiet = { priceLineVisible: false, lastValueVisible: false } as const;

/** Hovered bar index; `onMove` is subscribed by the chart's mount effect. */
function useCrosshairIndex(idx: React.RefObject<Map<number, number>>) {
  const [hover, setHover] = useState<number | null>(null);
  const onMove = useRef((p: { time?: Time }) => setHover(p.time == null ? null : (idx.current.get(p.time as number) ?? null)));
  return [hover, onMove.current] as const;
}

export function KV({ k, children, color, off }: { k: ReactNode; children: ReactNode; color?: string; off?: boolean }) {
  return (
    <span className={"hl-kv" + (off ? " off" : "")}>
      <span className="hl-k" style={color ? { color } : undefined}>
        {k}
      </span>
      {children}
    </span>
  );
}
/** One side's fills in the hovered bar: count, quantity, average price, notional. */
function SideRow({ label, color, n, q, v }: { label: string; color: string; n?: number; q?: number; v?: number }) {
  return (
    <div className="hl-row">
      <KV k={label} color={color}>
        {n ? n : DASH}
      </KV>
      {n && q && v ? (
        <>
          <KV k="qty">{qty(q)}</KV>
          <KV k="avg">{price(v / q)}</KV>
          <KV k="USDT">{usdShort(v)}</KV>
        </>
      ) : null}
    </div>
  );
}
const sgn = (v: number | null | undefined) => (v == null || v === 0 ? "" : v > 0 ? "up" : "down");

// =============================== desk ===============================


export function DeskChart({ bars, days, step, tz, fitKey, onOlder, view }: {
  bars: HistBar[]; days: HistDay[]; step: number; tz: TzMode; fitKey: string; onOlder?: () => void; view: PnlView;
}) {
  const host = useRef<HTMLDivElement>(null);
  const chart = useRef<IChartApi | null>(null);
  const s = useRef<{
    candle: ISeriesApi<"Candlestick">;
    pl: ISeriesApi<"Line">;
    stack: ISeriesApi<"Histogram">[]; // [part][sign]: market making, inventory, hedge, other × up, down
    pi: ISeriesApi<"Line">;
    mm: ISeriesApi<"Line">;
    ip: ISeriesApi<"Line">;
    he: ISeriesApi<"Line">;
    vol: ISeriesApi<"Histogram">;
    inv: ISeriesApi<"Line">;
    fut: ISeriesApi<"Line">;
    seps: DaySeparators[];
    labels: { applyOptions: (o: { visible: boolean }) => void }[];
  } | null>(null);
  const idx = useRef(new Map<number, number>());
  const lastFit = useRef("");
  const first = useRef<number | null>(null);
  const older = useRef(onOlder);
  older.current = onOlder;
  const [hover, onMove] = useCrosshairIndex(idx);
  const barsRef = useRef(bars);
  barsRef.current = bars;
  const hiddenRef = useRef<string[]>([]);
  const sm = useStore((st) => st.snap?.summary);
  const expo = useStore((st) => st.snap?.exposure);
  const dsRef = useRef(0);
  dsRef.current = sm?.day_start ?? days[days.length - 1]?.start ?? 0;
  const shown = useRef<HistBar[]>([]);
  // the cumulative view starts at 0 on the first bar loaded for this view; older bars loaded later count
  // back from there, so dragging never moves the lines
  const origin = useRef<{ key: string; t: number } | null>(null);
  if (bars.length && origin.current?.key !== fitKey) origin.current = { key: fitKey, t: bars[0]!.t };
  const t0 = origin.current?.t ?? 0;
  const k0 = Math.max(0, bars.findIndex((b) => b.t >= t0));

  useEffect(() => {
    const c = createChart(host.current!, chartOptions(tz, step));
    chart.current = c;
    c.subscribeCrosshairMove(onMove);
    onLeftEdge(c, older);
    const candle = c.addSeries(CandlestickSeries, {
      upColor: C.up,
      downColor: C.down,
      borderVisible: false,
      wickUpColor: C.up,
      wickDownColor: C.down,
      priceFormat: usdFmt,
      // one scale with its parts, so the lines and the candles compare at the same height
    });
    candle.priceScale().applyOptions({ scaleMargins: { top: 0.24, bottom: 0.06 } }); // clear of the two legend rows
    const line = (color: string, pane: number, extra = {}) =>
      c.addSeries(LineSeries, { color, lineWidth: 1, crosshairMarkerVisible: false, priceFormat: usdFmt, ...quiet, ...extra }, pane);
    const right = {};
    // per-bar view: outer segments first, so each part's inner edge is painted over by the part inside it
    const stackColors = [MM_COLOR, INVPNL_COLOR, HEDGE, OTHER_COLOR];
    const stack: ISeriesApi<"Histogram">[] = new Array(8);
    for (let k = 3; k >= 0; k--)
      for (const sgn of [0, 1])
        stack[k * 2 + sgn] = c.addSeries(HistogramSeries, { color: stackColors[k], priceFormat: usdFmt, ...quiet, visible: false }, 0);
    const pl = line(C.ink, 0, { visible: false });
    const he = line(HEDGE, 0, right);
    const ip = line(INVPNL_COLOR, 0, right);
    const mm = line(MM_COLOR, 0, right);
    const pi = line(S2, 0, right);
    const vol = c.addSeries(HistogramSeries, { color: VOL, priceFormat: usdFmt, ...quiet }, 1);
    const inv = line(INV_COLOR, 2, { crosshairMarkerVisible: true, crosshairMarkerRadius: 2 });
    const fut = line(FUT_COLOR, 2, { crosshairMarkerVisible: true, crosshairMarkerRadius: 2 });
    vol.priceScale().applyOptions({ scaleMargins: { top: 0.22, bottom: 0 } });
    inv.priceScale().applyOptions({ scaleMargins: { top: 0.22, bottom: 0.08 } });
    const panes = c.panes();
    panes[0]!.setStretchFactor(3.2);
    panes[1]!.setStretchFactor(0.9);
    panes[2]!.setStretchFactor(1.1);
    const labels = [paneLabel(c, 1, "Volume USDT"), paneLabel(c, 2, "Inventory / futures notional USDT")];
    const seps = [candle, vol, inv].map((x) => {
      const p = new DaySeparators();
      x.attachPrimitive(p);
      return p;
    });
    s.current = { candle, pl, stack, pi, mm, ip, he, vol, inv, fut, seps, labels };
    return () => {
      c.remove();
      chart.current = null;
      s.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    chart.current?.applyOptions(chartOptions(tz, step));
  }, [tz, step]);

  useEffect(() => {
    const x = s.current;
    if (!x) return;
    idx.current = new Map(bars.map((b, i) => [sec(b.t), i]));
    // Separators first: setData repaints every pane, a primitive's own update request does not.
    const st = separatorTimes(
      bars.map((b) => b.t),
      days,
      step,
    );
    x.seps.forEach((p) => p.set(st));
    const vb = viewBars(bars, view, dsRef.current, k0);
    shown.current = vb;
    draw(x, vb, view);
    x.inv.setData(bars.flatMap((b) => (b.inventory == null ? [] : [{ time: sec(b.t), value: b.inventory }])));
    x.fut.setData(bars.flatMap((b) => (b.futures == null ? [] : [{ time: sec(b.t), value: b.futures }])));
    x.vol.setData(bars.map((b) => ({ time: sec(b.t), value: b.volume })));
    if (fitKey !== lastFit.current) {
      lastFit.current = fitKey;
      fitLatest(chart.current, bars.length);
    } else keepView(chart.current, first.current, bars.map((b) => b.t));
    first.current = bars[0]?.t ?? null;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bars, days, step, fitKey, view, k0]);

  // the newest bar follows the live figures, like the Desk page, between fetches
  const live = useRef<HistBar | null>(null);
  const [liveB, setLiveB] = useState<HistBar | null>(null);
  useEffect(() => {
    live.current = null;
  }, [bars]);
  useEffect(() => {
    const x = s.current;
    if (!x || !sm || !expo || !bars.length) return;
    const b = liveBar(bars, live.current, sm.day_start, step * 1000, serverNow(), {
      pnl: sm.pnl_day, pi: sm.pnl.trading, mm: sm.pnl.mm, hedge: expo.hedge_day?.hedge_pnl ?? null,
      inventory: sm.inventory_value, futures: expo.futures_notional,
    });
    if (!b) return;
    live.current = b;
    const t = sec(b.t);
    if (!idx.current.has(t)) idx.current.set(t, bars.length);
    const n = bars.length && bars[bars.length - 1]!.t === b.t ? bars.length - 1 : bars.length;
    const shownLive = viewBars([...bars.slice(0, n), b], view, sm.day_start, k0)[n]!;
    drawLast(x, shownLive, view);
    x.inv.update({ time: t, value: b.inventory! });
    x.fut.update({ time: t, value: b.futures! });
    setLiveB(shownLive);
  }, [sm, expo, bars, step, view, k0]);

  const at = hover ?? bars.length - 1;
  const b = liveB && (hover == null || liveB.t === bars[at]?.t || at >= bars.length) ? liveB : shown.current[at];
  const has = (k: "pi" | "mm" | "hedge") => bars.some((x) => x[k] != null);
  const names = [
    "Day PnL",
    ...(has("pi") ? ["Trading PnL"] : []),
    ...(has("mm") ? ["Market making", "Inventory PnL"] : []),
    ...(has("hedge") ? ["Hedge"] : []),
    ...(view === "bar" ? ["Other"] : []),
    "Volume",
    "Inventory",
    "Futures",
  ];
  const tog = useSeriesToggle("history", names);
  hiddenRef.current = tog.hidden;
  const hiddenKey = tog.hidden.join("|");
  useEffect(() => {
    const x = s.current;
    const c = chart.current;
    if (!x || !c) return;
    const by: Record<string, { applyOptions: (o: { visible: boolean }) => void }[]> = {
      "Day PnL": [x.candle, x.pl],
      "Trading PnL": [x.pi],
      "Market making": [x.mm, x.stack[0]!, x.stack[1]!],
      "Inventory PnL": [x.ip, x.stack[2]!, x.stack[3]!],
      Hedge: [x.he, x.stack[4]!, x.stack[5]!],
      Other: [x.stack[6]!, x.stack[7]!],
      Volume: [x.vol],
      Inventory: [x.inv],
      Futures: [x.fut],
    };
    for (const [name, ser] of Object.entries(by)) for (const z of ser) z.applyOptions({ visible: !tog.hidden.includes(name) });
    // a pane with nothing shown folds away
    const off = (...n: string[]) => n.every((x) => tog.hidden.includes(x));
    const panes = c.panes();
    panes[1]?.setStretchFactor(off("Volume") ? 0.001 : 0.9);
    panes[2]?.setStretchFactor(off("Inventory", "Futures") ? 0.001 : 1.1);
    x.labels[0]!.applyOptions({ visible: !off("Volume") });
    x.labels[1]!.applyOptions({ visible: !off("Inventory", "Futures") });
    panes.forEach((_, i) => c.priceScale("right", i).applyOptions({ autoScale: true }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hiddenKey]);
  const w = (name: string, color?: string) => <SeriesWord name={name} color={color} t={tog} />;
  const off = tog.off;
  return (
    <div className="hist-chart" ref={host}>
      {b && (
        <div className="hist-legend fig" style={{ left: 76 }}>
          <div className="hl-row">
            <span className="hl-time">{barTime(b.t, tz, step)}</span>
            <span className={"hl-kv" + (off("Day PnL") ? " off" : "")}>{w("Day PnL", C.ink)}</span>
            {view === "day" ? (
              <>
                <KV k="O" off={off("Day PnL")}>{pnl(b.o)}</KV>
                <KV k="H" off={off("Day PnL")}>{pnl(b.h)}</KV>
                <KV k="L" off={off("Day PnL")}>{pnl(b.l)}</KV>
                <KV k="C" off={off("Day PnL")}>
                  <span className={sgn(b.c)}>{pnl(b.c)}</span>
                </KV>
                <KV k="bar" off={off("Day PnL")}>
                  <span className={sgn(b.c - b.o)}>{pnl(b.c - b.o)}</span>
                </KV>
              </>
            ) : (
              <span className={"hl-v " + sgn(b.c)}>{pnl(b.c)}</span>
            )}
            {view === "bar" && (
              <KV k={w("Other", OTHER_COLOR)} off={off("Other")}>{pnl(b.c - (b.pi ?? 0) - (b.hedge ?? 0))}</KV>
            )}
          </div>
          <div className="hl-row">
            {has("pi") && <KV k={w("Trading PnL", S2)} off={off("Trading PnL")}>{pnl(b.pi)}</KV>}
            {has("mm") && <KV k={w("Market making", MM_COLOR)} off={off("Market making")}>{pnl(b.mm)}</KV>}
            {has("mm") && (
              <KV k={w("Inventory PnL", INVPNL_COLOR)} off={off("Inventory PnL")}>
                {b.pi == null || b.mm == null ? DASH : pnl(b.pi - b.mm)}
              </KV>
            )}
            {has("hedge") && <KV k={w("Hedge", HEDGE)} off={off("Hedge")}>{pnl(b.hedge)}</KV>}
            <KV k={w("Volume", VOL_WORD)} off={off("Volume")}>{usdShort(b.volume)}</KV>
            <KV k="Fills">{int(b.fills)}</KV>
            <KV k={w("Inventory", INV_COLOR)} off={off("Inventory")}>{b.inventory == null ? DASH : usdShort(b.inventory)}</KV>
            <KV k={w("Futures", FUT_COLOR)} off={off("Futures")}>{b.futures == null ? DASH : usdShort(b.futures)}</KV>
          </div>
        </div>
      )}
    </div>
  );
}

// =============================== instrument ===============================

// our fills, in colors apart from the candles' up / down so a dot on a candle of its side stays visible
const BUY = S1;
const SELL = S2;

interface Agg {
  bn: number;
  bq: number;
  bv: number;
  sn: number;
  sq: number;
  sv: number;
}
function aggregate(fills: HistFill[], stepMs: number): Map<number, Agg> {
  const m = new Map<number, Agg>();
  for (const f of fills) {
    const k = Math.floor(f.t / stepMs) * stepMs;
    let a = m.get(k);
    if (!a) m.set(k, (a = { bn: 0, bq: 0, bv: 0, sn: 0, sq: 0, sv: 0 }));
    if (f.side === "buy") {
      a.bn++;
      a.bq += f.qty;
      a.bv += f.qty * f.price;
    } else {
      a.sn++;
      a.sq += f.qty;
      a.sv += f.qty * f.price;
    }
  }
  return m;
}

function pxFormat(p: number) {
  const a = Math.abs(p);
  const d = a >= 1000 ? 2 : a >= 10 ? 3 : a >= 1 ? 4 : a >= 0.01 ? 5 : 8;
  return { type: "custom" as const, minMove: 10 ** -d, formatter: (v: number) => price(v) };
}

export function InstrumentChart({
  klines,
  fills,
  days,
  step,
  tz,
  fitKey,
  onOlder,
}: {
  klines: Kline[];
  fills: HistFill[];
  days: HistDay[];
  step: number;
  tz: TzMode;
  fitKey: string;
  onOlder?: () => void;
}) {
  const host = useRef<HTMLDivElement>(null);
  const chart = useRef<IChartApi | null>(null);
  const s = useRef<{
    candle: ISeriesApi<"Candlestick">;
    buyPx: ISeriesApi<"Line">;
    sellPx: ISeriesApi<"Line">;
    buys: ISeriesApi<"Histogram">;
    sells: ISeriesApi<"Histogram">;
    vol: ISeriesApi<"Histogram">;
    seps: DaySeparators[];
  } | null>(null);
  const idx = useRef(new Map<number, number>());
  const lastFit = useRef("");
  const first = useRef<number | null>(null);
  const older = useRef(onOlder);
  older.current = onOlder;
  const aggRef = useRef(new Map<number, Agg>());
  const volCap = useRef<number | null>(null);
  const [hover, onMove] = useCrosshairIndex(idx);

  useEffect(() => {
    const c = createChart(host.current!, chartOptions(tz, step));
    chart.current = c;
    c.subscribeCrosshairMove(onMove);
    onLeftEdge(c, older);
    const candle = c.addSeries(CandlestickSeries, {
      upColor: C.up,
      downColor: C.down,
      borderVisible: false,
      wickUpColor: C.up,
      wickDownColor: C.down,
    });
    candle.priceScale().applyOptions({ scaleMargins: { top: 0.14, bottom: 0.08 } });
    // our average buy and sell price in each bar, as dots on the candles
    const dots = (color: string) =>
      c.addSeries(LineSeries, {
        color,
        lineVisible: false,
        pointMarkersVisible: true,
        pointMarkersRadius: 2.5,
        crosshairMarkerVisible: false,
        lastValueVisible: false,
        priceLineVisible: false,
      });
    const buyPx = dots(BUY);
    const sellPx = dots(SELL);
    const buys = c.addSeries(HistogramSeries, { color: BUY, priceFormat: usdFmt, ...quiet }, 1);
    const sells = c.addSeries(HistogramSeries, { color: SELL, priceFormat: usdFmt, ...quiet }, 1);
    const vol = c.addSeries(
      HistogramSeries,
      {
        color: VOL,
        priceFormat: usdFmt,
        ...quiet,
        autoscaleInfoProvider: (orig: () => AutoscaleInfo | null) => {
          const r = orig();
          const cap = volCap.current;
          return r && cap != null && r.priceRange && r.priceRange.maxValue > cap ? { ...r, priceRange: { minValue: 0, maxValue: cap } } : r;
        },
      },
      2,
    );
    buys.priceScale().applyOptions({ scaleMargins: { top: 0.2, bottom: 0.04 } });
    vol.priceScale().applyOptions({ scaleMargins: { top: 0.25, bottom: 0 } });
    const panes = c.panes();
    panes[0]!.setStretchFactor(3.4);
    panes[1]!.setStretchFactor(1.1);
    panes[2]!.setStretchFactor(0.8);
    paneLabel(c, 1, "Our fills USDT, buys up / sells down");
    paneLabel(c, 2, "Market volume USDT");
    const seps = [candle, buys, vol].map((x) => {
      const p = new DaySeparators();
      x.attachPrimitive(p);
      return p;
    });
    s.current = { candle, buyPx, sellPx, buys, sells, vol, seps };
    return () => {
      c.remove();
      chart.current = null;
      s.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    chart.current?.applyOptions(chartOptions(tz, step));
  }, [tz, step]);

  useEffect(() => {
    const x = s.current;
    if (!x) return;
    idx.current = new Map(klines.map((k, i) => [sec(k[0]), i]));
    const st = separatorTimes(
      klines.map((k) => k[0]),
      days,
      step,
    );
    x.seps.forEach((p) => p.set(st));
    const last = klines[klines.length - 1];
    if (last) x.candle.applyOptions({ priceFormat: pxFormat(last[4]) });
    x.candle.setData(klines.map((k) => ({ time: sec(k[0]), open: k[1], high: k[2], low: k[3], close: k[4] })));
    const vols = klines.map((k) => k[5] * k[4]);
    volCap.current = capAt(vols);
    x.vol.setData(klines.map((k, i) => ({ time: sec(k[0]), value: vols[i]! })));
    aggRef.current = aggregate(fills, step * 1000);
    const known = new Set(klines.map((k) => k[0]));
    for (const t of [...aggRef.current.keys()]) if (!known.has(t)) aggRef.current.delete(t);
    const keys = [...aggRef.current.keys()].sort((a, b) => a - b);
    x.buys.setData(keys.flatMap((t) => (aggRef.current.get(t)!.bv ? [{ time: sec(t), value: aggRef.current.get(t)!.bv }] : [])));
    x.sells.setData(keys.flatMap((t) => (aggRef.current.get(t)!.sv ? [{ time: sec(t), value: -aggRef.current.get(t)!.sv }] : [])));
    const ag = aggRef.current;
    x.buyPx.setData(keys.flatMap((t) => (ag.get(t)!.bq ? [{ time: sec(t), value: ag.get(t)!.bv / ag.get(t)!.bq }] : [])));
    x.sellPx.setData(keys.flatMap((t) => (ag.get(t)!.sq ? [{ time: sec(t), value: ag.get(t)!.sv / ag.get(t)!.sq }] : [])));
    if (fitKey !== lastFit.current) {
      lastFit.current = fitKey;
      fitLatest(chart.current, klines.length);
    } else keepView(chart.current, first.current, klines.map((k) => k[0]));
    first.current = klines[0]?.[0] ?? null;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [klines, fills, days, step, fitKey]);

  const k = klines[hover ?? klines.length - 1];
  const a = k ? aggRef.current.get(k[0]) : undefined;
  const chg = k && k[1] ? (k[4] / k[1] - 1) * 1e4 : null;
  return (
    <div className="hist-chart" ref={host}>
      {k && (
        <div className="hist-legend fig">
          <div className="hl-row">
            <span className="hl-time">{barTime(k[0], tz, step)}</span>
            <KV k="O">{price(k[1])}</KV>
            <KV k="H">{price(k[2])}</KV>
            <KV k="L">{price(k[3])}</KV>
            <KV k="C">
              <span className={sgn(chg)}>{price(k[4])}</span>
            </KV>
            <KV k="chg">
              <span className={sgn(chg)}>{num(chg, 1, true)} bps</span>
            </KV>
            <KV k="mkt vol">{usdShort(k[5] * k[4])}</KV>
          </div>
          {a?.bn ? <SideRow label="buys" color={BUY} n={a.bn} q={a.bq} v={a.bv} /> : null}
          {a?.sn ? <SideRow label="sells" color={SELL} n={a.sn} q={a.sq} v={a.sv} /> : null}
        </div>
      )}
    </div>
  );
}
