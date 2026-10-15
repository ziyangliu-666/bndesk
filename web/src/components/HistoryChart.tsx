// History charts on TradingView Lightweight Charts v5 (Apache-2.0; the attribution logo stays on).
// Panes share one time axis and crosshair. Times are UTC seconds; labels follow the tz toggle.
import { useEffect, useRef, useState, type ReactNode, type RefObject } from "react";
import {
  CandlestickSeries,
  ColorType,
  CrosshairMode,
  HistogramSeries,
  LineSeries,
  LineStyle,
  TickMarkType,
  TrackingModeExitMode,
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
import { C, FUT_COLOR, HEDGE_COLOR, INV_COLOR, INVPNL_COLOR, MM_COLOR, REBATE_COLOR, S1, S2, SANS } from "../theme";
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
/** A phone's bar time, as its other dates read: "15 Oct 18:10", a day bar "15 Oct". */
export function phoneTime(ms: number, tz: TzMode, step: number): string {
  const p = parts(ms, tz);
  const date = `${p.d} ${MON[p.mo]}`;
  return step >= 86400 ? date : `${date} ${pad(p.h)}:${pad(p.mi)}`;
}
/** The bar time of a legend or crosshair label: the desk's ISO form, a phone's short one. */
export const legendTime = (ms: number, tz: TzMode, step: number, phone: boolean) => (phone ? phoneTime : barTime)(ms, tz, step);

export function chartOptions(tz: TzMode, step: number, phone = false): DeepPartial<ChartOptions> {
  const o: DeepPartial<ChartOptions> = {
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
    localization: {
      timeFormatter: (t: Time) => legendTime((t as number) * 1000, tz, step, phone),
      ...(phone && { tickmarksPriceFormatter: phoneTicks }),
    },
  };
  return phone ? touchOptions(o) : o;
}

/** A phone chart's price axis labels, read like the uPlot charts' (usdTicks): thousands as "4k" once the step
 *  between labels is a thousand or more (millions as "1.2m"), else separated whole numbers ("1,250"), with
 *  decimals only as fine as the step needs (a price under 1). Never "4000.00". */
export function phoneTicks(prices: number[]): string[] {
  const sorted = [...prices].sort((a, b) => a - b);
  let step = Infinity;
  for (let i = 1; i < sorted.length; i++) {
    const d = sorted[i]! - sorted[i - 1]!;
    if (d > 1e-12 && d < step) step = d;
  }
  if (!Number.isFinite(step)) step = Math.abs(sorted[0] ?? 0) || 1;
  // the decimals a step needs: 2.5k → 1, 0.05 → 2 (the axis' steps are round numbers)
  const digits = (q: number) => {
    for (let d = 0; d < 8; d++) {
      const x = q * 10 ** d;
      if (Math.abs(x - Math.round(x)) < 1e-6 * Math.max(1, x)) return d;
    }
    return 8;
  };
  return prices.map((v) => {
    if (Math.abs(v) < step * 1e-6) return "0";
    if (step >= 1e6) return num(v / 1e6, digits(step / 1e6)) + "m";
    if (step >= 1000) return num(v / 1000, digits(step / 1000)) + "k";
    return num(v, digits(step));
  });
}

/** Phones: a vertical swipe scrolls the page past the chart, a horizontal drag pans, a pinch zooms, and a long
 *  press shows the crosshair until the finger lifts. Narrower axis and smaller type; panes keep their size
 *  (a 1 px separator is no touch target). A mouse in a narrow window still drags. */
function touchOptions(o: DeepPartial<ChartOptions>): DeepPartial<ChartOptions> {
  return {
    ...o,
    layout: { ...o.layout, fontSize: 10, panes: { ...o.layout?.panes, enableResize: false } },
    // the top and bottom labels only when they fit whole (a half label at the plot's top edge reads wrong)
    rightPriceScale: { ...o.rightPriceScale, minimumWidth: 44, entireTextOnly: true },
    timeScale: { ...o.timeScale, rightOffset: 1 },
    handleScroll: { mouseWheel: false, pressedMouseMove: true, horzTouchDrag: true, vertTouchDrag: false },
    handleScale: { mouseWheel: false, pinch: true, axisPressedMouseMove: { time: true, price: false }, axisDoubleClickReset: true },
    kineticScroll: { touch: true, mouse: false },
    trackingMode: { exitMode: TrackingModeExitMode.OnTouchEnd },
  };
}

/** Phones: whether the user panned or pinched the chart (the visible range moved while a finger or button was
 *  down), for a Reset button: iOS fires no dblclick. A vertical swipe that scrolls the page does not count. */
export function useMoved(chart: RefObject<IChartApi | null>, host: RefObject<HTMLElement | null>, on: boolean, onMove?: () => void) {
  const [moved, setMoved] = useState(false);
  const cb = useRef(onMove);
  cb.current = onMove;
  useEffect(() => {
    const c = chart.current;
    const el = host.current;
    if (!on || !c || !el) return;
    let down = false;
    const press = () => (down = true);
    const lift = () => (down = false);
    const range = () => {
      if (!down) return;
      setMoved(true);
      cb.current?.();
    };
    el.addEventListener("pointerdown", press, { capture: true });
    for (const t of ["pointerup", "pointercancel", "pointerleave"]) el.addEventListener(t, lift, { capture: true });
    c.timeScale().subscribeVisibleLogicalRangeChange(range);
    return () => {
      el.removeEventListener("pointerdown", press, { capture: true });
      for (const t of ["pointerup", "pointercancel", "pointerleave"]) el.removeEventListener(t, lift, { capture: true });
      c.timeScale().unsubscribeVisibleLogicalRangeChange(range);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [on]);
  return [moved, setMoved] as const;
}

/** The phone's way back to the default view. */
export function ResetButton({ onClick }: { onClick: () => void }) {
  return (
    <button type="button" className="lwc-reset" onClick={onClick}>
      Reset
    </button>
  );
}

/** A phone chart's plot height: the page's choice, but never more than the screen left between the bars (a
 *  phone held sideways) less `chrome` px of legend and the page's controls above the plot. */
export function phonePlotHeight(height: number | string, chrome: number): string {
  const h = typeof height === "number" ? `${height}px` : height;
  const room = `calc(100svh - var(--m-bar-h, 48px) - var(--m-nav-h, 56px) - var(--safe-t, 0px) - var(--safe-b, 0px) - ${chrome}px)`;
  return `max(140px, min(${h}, ${room}))`;
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
const VIEW_BARS_PHONE = 60;

/** Show the latest `k` bars (all of them when fewer), so bars stay readable. `lead` px are left free before
 *  the first bar: a phone's plot starts at the screen edge, and the first time label is centred on its bar. */
function fitLatest(chart: IChartApi | null, n: number, k = VIEW_BARS, lead = 0) {
  if (!chart) return;
  const ts = chart.timeScale();
  if (!lead) {
    if (n <= k) ts.fitContent();
    else ts.setVisibleLogicalRange({ from: n - k, to: n + 2 });
    return;
  }
  const from = n <= k ? -0.5 : n - k;
  const to = n <= k ? n + 0.5 : n + 2;
  const w = ts.width();
  const extra = w > 3 * lead ? ((to - from) * lead) / (w - lead) : 0;
  ts.setVisibleLogicalRange({ from: from - extra, to });
}
/** Room left of a phone chart's first bar for half a time label. */
const PHONE_LEAD = 20;

/** Phone, Hide amounts: the price axis keeps its place (and the time axis' corner, where the attribution mark
 *  sits) but shows no figures, nor does the crosshair's price label. */
export function maskAxis(chart: IChartApi | null, masked: boolean) {
  chart?.applyOptions({
    rightPriceScale: { textColor: masked ? "rgba(0,0,0,0)" : C.muted },
    crosshair: { horzLine: { labelVisible: !masked } },
  });
}

/** Every pane's price axis back to autoscale. */
function autoScaleAll(chart: IChartApi) {
  chart.panes().forEach((_, i) => chart.priceScale("right", i).applyOptions({ autoScale: true }));
}

// series kept off a phone's single pane: hidden, on a scale of their own so they never move the P&L axis
const OFF_PANE = { visible: false, priceScaleId: "off" } as const;
const LOWER = ["Volume", "Inventory", "Futures"];

export type PnlView = "day" | "cum" | "bar";
const DAY_MS = 86_400_000;
const PARTS = ["pi", "mm", "hedge", "rebates"] as const;

/** The P&L of `bars` (running totals from the first bar) as one view: "day" restarts at each day start (the
 *  dayStart grid), "cum" starts at 0 on bar `k0`, "bar" is what each bar made by itself. Other fields pass. */
export function viewBars(bars: HistBar[], view: PnlView, dayStart: number, k0 = 0): HistBar[] {
  const out: HistBar[] = new Array(bars.length);
  const last: Record<string, number | null> = { c: null, pi: null, mm: null, hedge: null, rebates: null };
  let base: Record<string, number> = { c: 0, pi: 0, mm: 0, hedge: 0, rebates: 0 };
  let day = NaN;
  if (view === "cum") {
    const b0 = bars[Math.min(Math.max(k0, 0), bars.length - 1)];
    base = { c: b0?.o ?? 0, pi: 0, mm: 0, hedge: 0, rebates: 0 };
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
        if (i > 0) base = { c: last.c ?? 0, pi: last.pi ?? 0, mm: last.mm ?? 0, hedge: last.hedge ?? 0, rebates: last.rebates ?? 0 };
        day = d;
      }
    }
    if (view === "bar") {
      const prev = { ...last };
      const d = (f: (typeof PARTS)[number]) => (b[f] == null ? null : b[f]! - (prev[f] ?? b[f]!));
      const o = prev.c ?? b.o;
      out[i] = { ...b, o: 0, h: b.h - o, l: b.l - o, c: b.c - o, pi: d("pi"), mm: d("mm"), hedge: d("hedge"), rebates: d("rebates") };
    } else {
      const sub = (v: number | null, f: string) => (v == null ? null : v - base[f]!);
      out[i] = { ...b, o: b.o - base.c!, h: b.h - base.c!, l: b.l - base.c!, c: b.c - base.c!, pi: sub(b.pi, "pi"), mm: sub(b.mm, "mm"), hedge: sub(b.hedge, "hedge"), rebates: sub(b.rebates, "rebates") };
    }
    last.c = b.c;
    for (const f of PARTS) if (b[f] != null) last[f] = b[f];
  }
  return out;
}

/** A bar's P&L split into market making, inventory, hedge, rebates and the rest, each stacked away from 0 by sign:
 *  for each part, the far edge of its segment (later parts outside earlier ones). */
function stackParts(b: HistBar): { pos: number[]; neg: number[] } {
  const mm = b.mm ?? 0;
  const inv = b.pi != null && b.mm != null ? b.pi - b.mm : 0;
  const he = b.hedge ?? 0;
  const rb = b.rebates ?? 0;
  const parts = [mm, inv, he, rb, b.c - (b.pi ?? 0) - he - rb];
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
  stack: ISeriesApi<"Histogram">[];
  pi: ISeriesApi<"Line">;
  mm: ISeriesApi<"Line">;
  ip: ISeriesApi<"Line">;
  he: ISeriesApi<"Line">;
  rb: ISeriesApi<"Line">;
};

/** The P&L series of one view: candles and the parts' lines ("day", "cum"), stacked per-bar parts ("bar").
 *  The series a view does not use are left empty. */
function draw(x: DeskSeries, vb: HistBar[], view: PnlView) {
  const pt = (b: HistBar, v: number | null) => (v == null ? [] : [{ time: sec(b.t), value: v }]);
  const lines = view !== "bar";
  x.candle.setData(lines ? vb.map((b) => ({ time: sec(b.t), open: b.o, high: b.h, low: b.l, close: b.c })) : []);
  x.pi.setData(lines ? vb.flatMap((b) => pt(b, b.pi)) : []);
  x.mm.setData(lines ? vb.flatMap((b) => pt(b, b.mm)) : []);
  x.ip.setData(lines ? vb.flatMap((b) => pt(b, b.pi == null || b.mm == null ? null : b.pi - b.mm)) : []);
  x.he.setData(lines ? vb.flatMap((b) => pt(b, b.hedge)) : []);
  x.rb.setData(lines ? vb.flatMap((b) => pt(b, b.rebates)) : []);
  const st = view === "bar" ? vb.map(stackParts) : [];
  for (let k = 0; k < 5; k++)
    for (const sgn of [0, 1])
      x.stack[k * 2 + sgn]!.setData(vb.flatMap((b, i) => (view === "bar" ? [{ time: sec(b.t), value: (sgn ? st[i]!.neg : st[i]!.pos)[k]! }] : [])));
}

/** The newest bar of a view, as an update. */
function drawLast(x: DeskSeries, b: HistBar, view: PnlView) {
  const t = sec(b.t);
  if (view !== "bar") x.candle.update({ time: t, open: b.o, high: b.h, low: b.l, close: b.c });
  if (view === "bar") {
    const st = stackParts(b);
    for (let k = 0; k < 5; k++) {
      x.stack[k * 2]!.update({ time: t, value: st.pos[k]! });
      x.stack[k * 2 + 1]!.update({ time: t, value: st.neg[k]! });
    }
    return;
  }
  if (b.pi != null) x.pi.update({ time: t, value: b.pi });
  if (b.mm != null) x.mm.update({ time: t, value: b.mm });
  if (b.pi != null && b.mm != null) x.ip.update({ time: t, value: b.pi - b.mm });
  if (b.hedge != null) x.he.update({ time: t, value: b.hedge });
  if (b.rebates != null) x.rb.update({ time: t, value: b.rebates });
}

/** Today's live figures as the newest bar. Within a day each running total is the last bar before the day
 *  start (yesterday's close, in the same running total) plus today's own figure; `prev` is the newest bar. */
function liveBar(bars: HistBar[], prev: HistBar | null, dayStart: number, stepMs: number, now: number,
                 v: { pnl: number; pi: number; mm: number; hedge: number | null; rebates: number; inventory: number; futures: number }): HistBar | null {
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
    rebates: base((b) => b.rebates) + v.rebates,
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

/** Phone: USD figures masked while Hide amounts is on (sign kept), as the phone's Money does. */
export function useMask(phone: boolean): (s: string) => string {
  const hide = useStore((st) => st.hideAmounts) && phone;
  return hide ? (s: string) => s.replace(/\d[\d.,]*[kMBT]?/, "•••") : (s: string) => s;
}

/** Phone legend: keeps its height at rest while a finger is down, so the plot never moves under the finger. */
export function useHeldHeight(pressed: boolean) {
  const el = useRef<HTMLDivElement | null>(null);
  const rest = useRef(0);
  if (!pressed && el.current) rest.current = el.current.offsetHeight;
  return { ref: (e: HTMLDivElement | null) => {
    el.current = e;
    if (e && !pressed) rest.current = e.offsetHeight;
  }, style: pressed && rest.current ? { minHeight: rest.current } : undefined };
}

/** Phone legend at rest: the series names, each a toggle a thumb can hit. While a finger is on the chart the
 *  legend shows that moment's figures instead, so the figures on the page are not repeated. */
export function PhoneWords({ words, t }: { words: (readonly [name: string, label: string, color: string])[]; t: ReturnType<typeof useSeriesToggle> }) {
  return (
    <div className="hl-row lwc-words">
      {words.map(([name, label, color]) => (
        <button key={name} type="button" className={"lwc-word" + (t.off(name) ? " off" : "")} aria-pressed={!t.off(name)} onClick={(e) => t.click(name, e)}>
          <span className="lwc-swatch" style={{ color }} />
          {label}
        </button>
      ))}
    </div>
  );
}

// =============================== desk ===============================


export interface PhoneChartProps {
  /** Touch layout: a page swipe passes through, the legend sits above the plot, a Reset button after a pan or
   *  pinch. Off: the desktop chart, unchanged. Fixed for the life of the chart. */
  phone?: boolean;
  /** The lower panes (volume, inventory / our fills, market volume). Default: on desktop, off on a phone. */
  lower?: boolean;
  /** Phone: the plot's height (px or any CSS length, not vh); the legend adds 44 px above it. Default 240. */
  height?: number | string;
  /** The first view (and Reset) shows every bar loaded instead of the latest ones. Default: off. */
  fitAll?: boolean;
}

type DeskProps = {
  bars: HistBar[]; days: HistDay[]; step: number; tz: TzMode; fitKey: string; onOlder?: () => void; view: PnlView;
  /** The newest bar follows the live figures between fetches. Off for a range that ends before today. Default: on. */
  live?: boolean;
} & PhoneChartProps;

export function DeskChart(p: DeskProps) {
  // the series and panes are made once per mount: a change of layout makes a new chart
  return <DeskChartIn key={`${!!p.phone}${p.lower ?? !p.phone}`} {...p} />;
}

// a phone shows Day PnL alone at first: the parts are a tap on their names away
const PHONE_HIDDEN = ["Trading PnL", "Market making", "Inventory PnL", "Hedge", "Rebates", "Other"];

function DeskChartIn({ bars, days, step, tz, fitKey, onOlder, view, phone = false, lower = !phone, height = 240, live: follow = true, fitAll = false }: DeskProps) {
  const host = useRef<HTMLDivElement>(null);
  const chart = useRef<IChartApi | null>(null);
  const s = useRef<{
    candle: ISeriesApi<"Candlestick">;
    stack: ISeriesApi<"Histogram">[]; // [part][sign]: market making, inventory, hedge, rebates, other × up, down
    pi: ISeriesApi<"Line">;
    mm: ISeriesApi<"Line">;
    ip: ISeriesApi<"Line">;
    he: ISeriesApi<"Line">;
    rb: ISeriesApi<"Line">;
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
    const c = createChart(host.current!, chartOptions(tz, step, phone));
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
      // a phone's narrow axis: the last-value tag would cover its labels
      ...(phone && { lastValueVisible: false }),
    });
    // clear of the two legend rows; a phone's legend sits above the plot
    candle.priceScale().applyOptions({ scaleMargins: { top: phone ? 0.08 : 0.24, bottom: 0.06 } });
    const line = (color: string, pane: number, extra = {}) =>
      c.addSeries(LineSeries, { color, lineWidth: 1, crosshairMarkerVisible: false, priceFormat: usdFmt, ...quiet, ...extra }, pane);
    const right = {};
    // per-bar view: outer segments first, so each part's inner edge is painted over by the part inside it
    const stackColors = [MM_COLOR, INVPNL_COLOR, HEDGE, REBATE_COLOR, OTHER_COLOR];
    const stack: ISeriesApi<"Histogram">[] = new Array(10);
    for (let k = 4; k >= 0; k--)
      for (const sgn of [0, 1])
        stack[k * 2 + sgn] = c.addSeries(HistogramSeries, { color: stackColors[k], priceFormat: usdFmt, ...quiet, visible: false }, 0);
    const rb = line(REBATE_COLOR, 0, right);
    const he = line(HEDGE, 0, right);
    const ip = line(INVPNL_COLOR, 0, right);
    const mm = line(MM_COLOR, 0, right);
    const pi = line(S2, 0, right);
    const off = lower ? {} : OFF_PANE;
    const vol = c.addSeries(HistogramSeries, { color: VOL, priceFormat: usdFmt, ...quiet, ...off }, lower ? 1 : 0);
    const inv = line(INV_COLOR, lower ? 2 : 0, { crosshairMarkerVisible: true, crosshairMarkerRadius: 2, ...off });
    const fut = line(FUT_COLOR, lower ? 2 : 0, { crosshairMarkerVisible: true, crosshairMarkerRadius: 2, ...off });
    vol.priceScale().applyOptions({ scaleMargins: { top: 0.22, bottom: 0 } });
    inv.priceScale().applyOptions({ scaleMargins: { top: 0.22, bottom: 0.08 } });
    const panes = c.panes();
    panes[0]!.setStretchFactor(3.2);
    panes[1]?.setStretchFactor(0.9);
    panes[2]?.setStretchFactor(1.1);
    const labels = lower ? [paneLabel(c, 1, "Volume USDT"), paneLabel(c, 2, "Inventory / futures notional USDT")] : [];
    const seps = (lower ? [candle, vol, inv] : [candle]).map((x) => {
      const p = new DaySeparators();
      x.attachPrimitive(p);
      return p;
    });
    s.current = { candle, stack, pi, mm, ip, he, rb, vol, inv, fut, seps, labels };
    return () => {
      c.remove();
      chart.current = null;
      s.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    chart.current?.applyOptions(chartOptions(tz, step, phone));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tz, step]);

  const viewN = fitAll ? Infinity : phone ? VIEW_BARS_PHONE : VIEW_BARS;
  const [moved, setMoved] = useMoved(chart, host, phone);
  const reset = () => {
    const c = chart.current;
    if (!c) return;
    fitLatest(c, barsRef.current.length, viewN, phone ? PHONE_LEAD : 0);
    autoScaleAll(c);
    setMoved(false);
  };
  const mask = useMask(phone);
  const masked = mask("1") !== "1";
  useEffect(() => {
    if (phone) maskAxis(chart.current, masked);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [masked]);

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
      fitLatest(chart.current, bars.length, viewN, phone ? PHONE_LEAD : 0);
      if (phone) setMoved(false);
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
    if (!follow || !x || !sm || !expo || !bars.length) return;
    const b = liveBar(bars, live.current, sm.day_start, step * 1000, serverNow(), {
      pnl: sm.pnl_day, pi: sm.pnl.trading, mm: sm.pnl.mm, hedge: expo.hedge_day?.hedge_pnl ?? null, rebates: sm.rebates,
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
  }, [sm, expo, bars, step, view, k0, follow]);

  const at = hover ?? bars.length - 1;
  const b = liveB && (hover == null || liveB.t === bars[at]?.t || at >= bars.length) ? liveB : shown.current[at];
  const has = (k: "pi" | "mm" | "hedge" | "rebates") => bars.some((x) => x[k] != null);
  const names = [
    "Day PnL",
    ...(has("pi") ? ["Trading PnL"] : []),
    ...(has("mm") ? ["Market making", "Inventory PnL"] : []),
    ...(has("hedge") ? ["Hedge"] : []),
    ...(has("rebates") ? ["Rebates"] : []),
    ...(view === "bar" ? ["Other"] : []),
    "Volume",
    "Inventory",
    "Futures",
  ];
  const tog = useSeriesToggle(phone ? "history-phone" : "history", names, phone ? PHONE_HIDDEN : undefined);
  hiddenRef.current = tog.hidden;
  const hiddenKey = tog.hidden.join("|");
  useEffect(() => {
    const x = s.current;
    const c = chart.current;
    if (!x || !c) return;
    const by: Record<string, { applyOptions: (o: { visible: boolean }) => void }[]> = {
      "Day PnL": [x.candle],
      "Trading PnL": [x.pi],
      "Market making": [x.mm, x.stack[0]!, x.stack[1]!],
      "Inventory PnL": [x.ip, x.stack[2]!, x.stack[3]!],
      Hedge: [x.he, x.stack[4]!, x.stack[5]!],
      Rebates: [x.rb, x.stack[6]!, x.stack[7]!],
      Other: [x.stack[8]!, x.stack[9]!],
      Volume: [x.vol],
      Inventory: [x.inv],
      Futures: [x.fut],
    };
    for (const [name, ser] of Object.entries(by))
      for (const z of ser) z.applyOptions({ visible: !tog.hidden.includes(name) && (lower || !LOWER.includes(name)) });
    // a pane with nothing shown folds away
    const off = (...n: string[]) => n.every((x) => tog.hidden.includes(x));
    const panes = c.panes();
    panes[1]?.setStretchFactor(off("Volume") ? 0.001 : 0.9);
    panes[2]?.setStretchFactor(off("Inventory", "Futures") ? 0.001 : 1.1);
    x.labels[0]?.applyOptions({ visible: !off("Volume") });
    x.labels[1]?.applyOptions({ visible: !off("Inventory", "Futures") });
    panes.forEach((_, i) => c.priceScale("right", i).applyOptions({ autoScale: true }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hiddenKey]);
  const w = (name: string, color?: string, label?: string) => <SeriesWord name={name} label={label} color={color} t={tog} />;
  const off = tog.off;
  const held = useHeldHeight(phone && hover != null);
  if (phone) {
    const pressed = hover != null && b ? b : null;
    const on = (name: string) => !off(name);
    return (
      <div className="lwc-phone">
        <div className="lwc-legend fig" {...held}>
          {pressed ? (
            <div className="hl-row">
              <span className="hl-time">{phoneTime(pressed.t, tz, step)}</span>
              {on("Day PnL") && (
                <KV k="Day PnL">
                  <span className={sgn(pressed.c)}>{mask(pnl(pressed.c))}</span>
                </KV>
              )}
              {on("Day PnL") && view !== "bar" && (
                <KV k="bar">
                  <span className={sgn(pressed.c - pressed.o)}>{mask(pnl(pressed.c - pressed.o))}</span>
                </KV>
              )}
              {view === "bar" && on("Other") && (
                <KV k="Other" color={OTHER_COLOR}>{mask(pnl(pressed.c - (pressed.pi ?? 0) - (pressed.hedge ?? 0) - (pressed.rebates ?? 0)))}</KV>
              )}
              {has("pi") && on("Trading PnL") && <KV k="Trading PnL" color={S2}>{mask(pnl(pressed.pi))}</KV>}
              {has("mm") && on("Market making") && <KV k="Market making" color={MM_COLOR}>{mask(pnl(pressed.mm))}</KV>}
              {has("mm") && on("Inventory PnL") && (
                <KV k="Inventory PnL" color={INVPNL_COLOR}>{pressed.pi == null || pressed.mm == null ? DASH : mask(pnl(pressed.pi - pressed.mm))}</KV>
              )}
              {has("hedge") && on("Hedge") && <KV k="Hedge" color={HEDGE}>{mask(pnl(pressed.hedge))}</KV>}
              {has("rebates") && on("Rebates") && <KV k="Rebates" color={REBATE_COLOR}>{mask(pnl(pressed.rebates))}</KV>}
            </div>
          ) : (
            <PhoneWords
              t={tog}
              words={[
                ["Day PnL", "Day PnL", C.ink],
                ...(has("pi") ? [["Trading PnL", "Trading PnL", S2] as const] : []),
                ...(has("mm") ? [["Market making", "Market making", MM_COLOR] as const, ["Inventory PnL", "Inventory PnL", INVPNL_COLOR] as const] : []),
                ...(has("hedge") ? [["Hedge", "Hedge", HEDGE] as const] : []),
                ...(has("rebates") ? [["Rebates", "Rebates", REBATE_COLOR] as const] : []),
                ...(view === "bar" ? [["Other", "Other", OTHER_COLOR] as const] : []),
              ]}
            />
          )}
        </div>
        <div className="lwc-plot" style={{ height: phonePlotHeight(height, 120) }}>
          <div className="lwc-host" ref={host} />
          {moved && <ResetButton onClick={reset} />}
        </div>
      </div>
    );
  }
  return (
    <div className="hist-chart" ref={host}>
      {b && (
        <div className="hist-legend fig" style={{ left: 76 }}>
          <div className="hl-row">
            <span className="hl-time">{barTime(b.t, tz, step)}</span>
            <span className={"hl-kv" + (off("Day PnL") ? " off" : "")}>{w("Day PnL", C.ink)}</span>
            {view !== "bar" ? (
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
              <KV k={w("Other", OTHER_COLOR)} off={off("Other")}>{pnl(b.c - (b.pi ?? 0) - (b.hedge ?? 0) - (b.rebates ?? 0))}</KV>
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
            {has("rebates") && <KV k={w("Rebates", REBATE_COLOR)} off={off("Rebates")}>{pnl(b.rebates)}</KV>}
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

type InstrumentProps = {
  klines: Kline[];
  fills: HistFill[];
  days: HistDay[];
  step: number;
  tz: TzMode;
  fitKey: string;
  onOlder?: () => void;
} & PhoneChartProps;

export function InstrumentChart(p: InstrumentProps) {
  return <InstrumentChartIn key={`${!!p.phone}${p.lower ?? !p.phone}`} {...p} />;
}

function InstrumentChartIn({ klines, fills, days, step, tz, fitKey, onOlder, phone = false, lower = !phone, height = 240, fitAll = false }: InstrumentProps) {
  const host = useRef<HTMLDivElement>(null);
  const chart = useRef<IChartApi | null>(null);
  const s = useRef<{
    candle: ISeriesApi<"Candlestick">;
    buyPx: ISeriesApi<"Line">;
    sellPx: ISeriesApi<"Line">;
    rings: ISeriesApi<"Line">[];
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
    const c = createChart(host.current!, chartOptions(tz, step, phone));
    chart.current = c;
    c.subscribeCrosshairMove(onMove);
    onLeftEdge(c, older);
    const candle = c.addSeries(CandlestickSeries, {
      upColor: C.up,
      downColor: C.down,
      borderVisible: false,
      wickUpColor: C.up,
      wickDownColor: C.down,
      // a phone's narrow axis: the last-price tag would cover its labels, and the legend has the close
      ...(phone && { lastValueVisible: false }),
    });
    candle.priceScale().applyOptions({ scaleMargins: { top: phone ? 0.08 : 0.14, bottom: 0.08 } });
    // our average buy and sell price in each bar, as dots on the candles. A phone colours them as its fill rows
    // do (buy gain colour, sell loss colour), each on a ring of the ground so it stays apart from a candle of
    // its own colour; the desk keeps colours apart from the candles'.
    const dots = (color: string, r = 2.5) =>
      c.addSeries(LineSeries, {
        color,
        lineVisible: false,
        pointMarkersVisible: true,
        pointMarkersRadius: r,
        crosshairMarkerVisible: false,
        lastValueVisible: false,
        priceLineVisible: false,
      });
    const rings = phone ? [dots(C.panel, 4), dots(C.panel, 4)] : [];
    const buyPx = dots(phone ? C.up : BUY);
    const sellPx = dots(phone ? C.down : SELL);
    const off = lower ? {} : OFF_PANE;
    const buys = c.addSeries(HistogramSeries, { color: BUY, priceFormat: usdFmt, ...quiet, ...off }, lower ? 1 : 0);
    const sells = c.addSeries(HistogramSeries, { color: SELL, priceFormat: usdFmt, ...quiet, ...off }, lower ? 1 : 0);
    const vol = c.addSeries(
      HistogramSeries,
      {
        color: VOL,
        priceFormat: usdFmt,
        ...quiet,
        ...off,
        autoscaleInfoProvider: (orig: () => AutoscaleInfo | null) => {
          const r = orig();
          const cap = volCap.current;
          return r && cap != null && r.priceRange && r.priceRange.maxValue > cap ? { ...r, priceRange: { minValue: 0, maxValue: cap } } : r;
        },
      },
      lower ? 2 : 0,
    );
    buys.priceScale().applyOptions({ scaleMargins: { top: 0.2, bottom: 0.04 } });
    vol.priceScale().applyOptions({ scaleMargins: { top: 0.25, bottom: 0 } });
    const panes = c.panes();
    panes[0]!.setStretchFactor(3.4);
    panes[1]?.setStretchFactor(1.1);
    panes[2]?.setStretchFactor(0.8);
    if (lower) {
      paneLabel(c, 1, "Our fills USDT, buys up / sells down");
      paneLabel(c, 2, "Market volume USDT");
    }
    const seps = (lower ? [candle, buys, vol] : [candle]).map((x) => {
      const p = new DaySeparators();
      x.attachPrimitive(p);
      return p;
    });
    s.current = { candle, buyPx, sellPx, rings, buys, sells, vol, seps };
    return () => {
      c.remove();
      chart.current = null;
      s.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    chart.current?.applyOptions(chartOptions(tz, step, phone));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tz, step]);

  const viewN = fitAll ? Infinity : phone ? VIEW_BARS_PHONE : VIEW_BARS;
  const n = useRef(0);
  n.current = klines.length;
  const [moved, setMoved] = useMoved(chart, host, phone);
  const reset = () => {
    const c = chart.current;
    if (!c) return;
    fitLatest(c, n.current, viewN, phone ? PHONE_LEAD : 0);
    autoScaleAll(c);
    setMoved(false);
  };

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
    const buyAt = keys.flatMap((t) => (ag.get(t)!.bq ? [{ time: sec(t), value: ag.get(t)!.bv / ag.get(t)!.bq }] : []));
    const sellAt = keys.flatMap((t) => (ag.get(t)!.sq ? [{ time: sec(t), value: ag.get(t)!.sv / ag.get(t)!.sq }] : []));
    x.buyPx.setData(buyAt);
    x.sellPx.setData(sellAt);
    x.rings[0]?.setData(buyAt);
    x.rings[1]?.setData(sellAt);
    if (fitKey !== lastFit.current) {
      lastFit.current = fitKey;
      fitLatest(chart.current, klines.length, viewN, phone ? PHONE_LEAD : 0);
      if (phone) setMoved(false);
    } else keepView(chart.current, first.current, klines.map((k) => k[0]));
    first.current = klines[0]?.[0] ?? null;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [klines, fills, days, step, fitKey]);

  const k = klines[hover ?? klines.length - 1];
  const a = k ? aggRef.current.get(k[0]) : undefined;
  const chg = k && k[1] ? (k[4] / k[1] - 1) * 1e4 : null;
  if (phone)
    return (
      <div className="lwc-phone">
        <div className="lwc-legend fig">
          {k && (
            <>
              <div className="hl-row">
                <span className="hl-time">{phoneTime(k[0], tz, step)}</span>
                <KV k="C">
                  <span className={sgn(chg)}>{price(k[4])}</span>
                </KV>
                <KV k="chg">
                  <span className={sgn(chg)}>{num(chg, 1, true)} bps</span>
                </KV>
              </div>
              <div className="hl-row">
                <KV k="buys" color={C.up}>{a?.bn ? `${a.bn} @ ${price(a.bv / a.bq)}` : DASH}</KV>
                <KV k="sells" color={C.down}>{a?.sn ? `${a.sn} @ ${price(a.sv / a.sq)}` : DASH}</KV>
              </div>
            </>
          )}
        </div>
        <div className="lwc-plot" style={{ height: phonePlotHeight(height, 120) }}>
          <div className="lwc-host" ref={host} />
          {moved && <ResetButton onClick={reset} />}
        </div>
      </div>
    );
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
