// ExChart: the one wrapper over TradingView Lightweight Charts v5 for every time-series chart, desktop and
// phone. It owns the toolbar (intervals, modes, ⤢), the in-plot legend with values, the right axis with its
// last-value tag, `>>` back to live, the touch value box, the chip row, loading, markers and price lines.
// See README.md in this folder for the API in short.
import {
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type CSSProperties,
  type ReactNode,
} from "react";
import {
  AreaSeries,
  BaselineSeries,
  CandlestickSeries,
  ColorType,
  CrosshairMode,
  HistogramSeries,
  LineSeries,
  LineStyle,
  TrackingModeExitMode,
  createChart,
  createSeriesMarkers,
  type ChartOptions,
  type DeepPartial,
  type IChartApi,
  type IPriceLine,
  type ISeriesApi,
  type ISeriesMarkersPluginApi,
  type MouseEventParams,
  type SeriesMarker,
  type SeriesType,
  type Time,
  type UTCTimestamp,
} from "lightweight-charts";
import { num, price as fmtPrice } from "../../format";
import { MASK } from "../../mask";
import { closeChart, openChart, useStore } from "../../store";
import type { TzMode } from "../../format";
import type { Stroke } from "../../theme";
import { C, CROSSHAIR, DOWN, GRID, PLOT_BG, SANS, UP, rgba, signColor } from "./palette";
import { barLabel, boxLabel, tickLabel } from "./time";
import { ChipRow, SeriesKey, TextToggle, useScrollFade, type Chip, type Option } from "./controls";
import { useExHidden, useExPref } from "./prefs";
import { ChartFullscreen, goFullscreen } from "./fullscreen";
import { AxisGuard, DayDividers, FillRings, type Ring } from "./rings";
import "./ex.css";

// ================================ public types ================================

export type ExKind = "line" | "area" | "baseline" | "histogram" | "candles";

/** A value point; `value: null` leaves a gap. `color` (histogram) colours that bar. Time in ms. */
export interface ExPoint {
  time: number;
  value: number | null;
  color?: string;
}
/** A candle. Time in ms (bar start). Extra fields (volume) are ignored. */
export interface ExOhlc {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
}

export interface ExSeries {
  /** Stable id: legend clicks and chips toggle it, `hidden` lists it, markers and price lines name it. */
  key: string;
  kind: ExKind;
  /** Legend label (plain, short: `Day PnL`, `MM`, `Vol(USDT)`). */
  label: string;
  /** Oldest first. Keep earlier points' object identity across live updates (append, or replace the last)
   *  and ExChart updates only the tail instead of resetting the series. */
  data: readonly ExPoint[] | readonly ExOhlc[];
  /** Line colour (line, area, histogram default). Baseline and candles use up/down unless given `colors`. */
  color?: string;
  /** Baseline / candles: [up, down]. */
  colors?: [string, string];
  /** Pane index, 0 = the main one; panes must be contiguous. */
  pane?: number;
  /** Axis and legend number format. Default: candles format.price, else 2 decimals. */
  format?: (v: number) => string;
  /** Legend value coloured by sign (P&L). */
  signColor?: boolean;
  /** Legend line within its pane (1 = first). Default: the first series of pane 0 on line 1, the others on 2;
   *  other panes line 1. `false` keeps it out of the legend. */
  legend?: number | false;
  /** May the user hide it (legend click, chips). Default true. */
  toggle?: boolean;
  /** Hidden until the user shows it (when no choice is stored yet). */
  hiddenByDefault?: boolean;
  /** Line width (line, area, baseline). Default 1.5 (2 for baseline). */
  width?: number;
  /** Stroke (theme.ts Stroke): solid, dashed, dotted, large (long dashes), sparse (spaced dots). */
  lineStyle?: Stroke;
  /** Baseline: the base value. Default 0. */
  base?: number;
  /** Axis tag with the last value (and its dotted price line). Default: the first series of each pane, unless
   *  it is a histogram. */
  lastValue?: boolean;
  /** Price scale id. Default the pane's right scale; any other id is an invisible overlay scale. */
  scale?: string;
  /** Margins of this series' scale, fractions of the pane height. */
  margins?: { top: number; bottom: number };
  /** In the touch value box. Default true. */
  box?: boolean;
  /** Raw Lightweight Charts series options, applied last. */
  options?: Record<string, unknown>;
}

export interface ExMarker {
  /** Key of the series it sits on. */
  series: string;
  time: number;
  /** For `atPrice*` positions. */
  price?: number;
  color: string;
  /** "ring": a hollow ring at `price` (our fills), drawn by a primitive (rings.ts); the rest are Lightweight
   *  Charts' own markers. */
  shape?: "circle" | "square" | "arrowUp" | "arrowDown" | "ring";
  /** Rings: −1 left of the bar's centre, +1 right (a buy and a sell in one bar never overlap). */
  offset?: -1 | 0 | 1;
  position?: "aboveBar" | "belowBar" | "inBar" | "atPriceTop" | "atPriceMiddle" | "atPriceBottom";
  size?: number;
  text?: string;
  /** Overlay key (chip / hidden): hidden with it. */
  key?: string;
}

export interface ExPriceLine {
  series: string;
  price: number;
  color: string;
  /** Short text on the line at the axis: `Bid sub-a`, `Avg cost`. */
  title?: string;
  style?: "solid" | "dashed" | "dotted" | "large";
  width?: number;
  /** Price box on the axis. Default true. */
  axisLabel?: boolean;
  labelColor?: string;
  labelTextColor?: string;
  key?: string;
}

/** A value for the legend or the value box: text, or [text, colour]. */
export type ExValue = string | [string, string | undefined];

export interface ExLegendItem {
  label: string;
  /** `t`: the hovered bar's time (ms), else the latest bar's. */
  value: (t: number) => ExValue;
  color?: string;
  pane?: number;
  line?: number;
  /** Clicking toggles this key (a series or an overlay). */
  key?: string;
  /** Also a row in the touch value box (`true`, or a value for the box only). */
  box?: boolean | ((t: number) => ExValue);
  title?: string;
}

export interface ExMode {
  /** Accessible name. */
  label: string;
  options: Option[];
  value: string;
  onChange: (v: string) => void;
}

export type ExBoxRow = [label: string, value: string, color?: string];

/**
 * A view the page owns: a logical range (bar indexes, fractions allowed) or a time range (ms). ExChart applies it
 * instead of its own fit, after every (re)load and whenever the value changes, and holds it while new bars come
 * (no shift to the live edge). `null` / undefined: ExChart fits the data itself.
 */
export type ExView = { logical: { from: number; to: number } } | { time: { from: number; to: number } };

export interface ExChartProps {
  /** Chart id: remembers hidden series (store `hidden["ex.<id>"]`) and the legend's collapse. Use the same id in
   *  `useExPref(id, "interval", …)` for the interval and modes. */
  id: string;
  series: ExSeries[];
  /** Pane heights relative to each other (stretch factors). Default pane 0: 1, others 0.25. */
  paneStretch?: number[];
  /** Interval text toggles at the left of the toolbar (`Line 1m 5m 15m 1H`). */
  intervals?: Option[];
  interval?: string;
  onInterval?: (v: string) => void;
  /** The rest of the intervals, behind `More ▾` (a short menu); the button shows the chosen one when it is
   *  among them (`4H ▾`). */
  moreIntervals?: Option[];
  /** Text-toggle groups at the right of the toolbar (`Today 24h`, `Area Candles`). */
  modes?: ExMode[];
  /** Content at the left of the toolbar, before the intervals. */
  toolbarLeft?: ReactNode;
  /** ⤢: `true` opens the built-in fullscreen (ChartFullscreen with this chart in it); a function handles it. */
  fullscreen?: boolean | (() => void);
  /** Title of the fullscreen header (symbol, chart name). */
  title?: ReactNode;
  /** Chip row under the chart: `true` = a chip per toggleable series; or the chips to show (overlay keys too). */
  chips?: boolean | (Chip | "|")[];
  /** Plot height (px or CSS length), toolbar and chips excluded. Ignored with `fill`. Default 300. */
  height?: number | string;
  /** The chart fills its parent's height (flex column). */
  fill?: boolean;
  /** Data is on its way: the old bars go at once and "Loading" shows in the plot. ExChart also does this by
   *  itself when `interval` changes and the data has not changed yet. */
  loading?: boolean;
  /** Shown in the plot when there is no data and nothing is loading. Default "No data". */
  emptyText?: string;
  markers?: ExMarker[];
  priceLines?: ExPriceLine[];
  /** More legend items (`Fills B3 @ 2,480.64`, `Band ±215.73`). */
  legendExtra?: ExLegendItem[];
  /** The touch value box's rows for bar time `t`; default from the series and legend items. */
  boxRows?: (t: number) => ExBoxRow[];
  /** Touch layout (long-press tracking, value box, pinch). Default: a coarse pointer. */
  touch?: boolean;
  /** Bars in view after a (re)load; default all of them, fitted. */
  initialBars?: number;
  /** The page's own view (24h on the Desk, a day zoomed on History). See ExView. */
  view?: ExView | null;
  /** The bar the legend shows at rest (a chosen day, ms); default the latest one. */
  legendTime?: number | null;
  /** Bars of space right of the latest one. Default 3 on touch, 5 with a mouse (a few daily bars want less; a
   *  history of days wants 1). */
  rightOffset?: number;
  /** A change of this value resets the view (a new symbol). */
  resetKey?: string | number;
  /** The legend while nothing is hovered: each line's value at the latest bar (default), or the series' names
   *  only, where the page's header already carries the values. */
  legendRest?: "values" | "names";
  /** Day starts (ms) on a chart that runs over several days: a faint rule at each. */
  dividers?: readonly number[];
  /** Called when the view comes within a few dozen bars of the first one (load older data). */
  onNearStart?: () => void;
  /** Controlled hidden keys (else per-id in the store). */
  hidden?: string[];
  onToggle?: (key: string) => void;
  /** The hovered bar's time (ms), null when the crosshair leaves. */
  onCrosshair?: (t: number | null) => void;
  /** A click (a tap) on a bar: its time, ms. */
  onBarClick?: (t: number) => void;
  /** The chart's API once created (null on unmount), for anything this wrapper does not cover. */
  chartRef?: (c: IChartApi | null) => void;
  className?: string;
  style?: CSSProperties;
  /** @internal set on the copy inside the fullscreen overlay. */
  inFullscreen?: boolean;
  onCloseFullscreen?: () => void;
}

// ================================ helpers ================================

/** The rule at each day start on a chart over several days: there, not loud. */
const DIVIDER = rgba(C.ink2, 0.18);
const sec = (ms: number) => Math.floor(ms / 1000) as UTCTimestamp;
const STYLE = { solid: LineStyle.Solid, dashed: LineStyle.Dashed, dotted: LineStyle.Dotted, large: LineStyle.LargeDashed, sparse: LineStyle.SparseDotted } as const;
const isOhlc = (p: ExPoint | ExOhlc): p is ExOhlc => (p as ExOhlc).open !== undefined;
const coarse = () => typeof window !== "undefined" && window.matchMedia("(pointer: coarse)").matches;

/** Decimals format.price shows for a price of this size. */
function priceDecimals(v: number): number {
  const a = Math.abs(v);
  return a >= 1000 ? 2 : a >= 10 ? 3 : a >= 1 ? 4 : a >= 0.01 ? 5 : 7;
}
/** Price precision as format.price picks it. */
function minMoveFor(v: number): number {
  const a = Math.abs(v);
  return a >= 1000 ? 0.01 : a >= 10 ? 0.001 : a >= 1 ? 0.0001 : a >= 0.01 ? 0.00001 : 0.0000001;
}
const defaultFormat = (s: ExSeries) => s.format ?? (s.kind === "candles" ? (v: number) => fmtPrice(v) : (v: number) => num(v, 2));
/** What a format prints for a few probes: a page's new format function that prints the same keeps the axis as it
 *  is; one that prints otherwise (Hide amounts flipped) is applied without a remount. */
const formatSig = (s: ExSeries) => {
  if (!s.format) return "";
  try {
    return s.format(-1234.567) + "|" + s.format(0.5);
  } catch {
    return "?";
  }
};

function chartOptions(touch: boolean, tz: TzMode, step: number, rightOffset?: number): DeepPartial<ChartOptions> {
  return {
    autoSize: true,
    layout: {
      background: { type: ColorType.Solid, color: PLOT_BG },
      textColor: C.muted,
      fontFamily: SANS,
      fontSize: 11,
      // the attribution is a link in the footer / About (TvAttribution), as the licence allows
      attributionLogo: false,
      panes: { separatorColor: C.rule, separatorHoverColor: "rgba(126,166,246,0.18)", enableResize: false },
    },
    grid: { vertLines: { visible: false }, horzLines: { color: GRID } },
    crosshair: {
      mode: CrosshairMode.Normal,
      vertLine: { color: CROSSHAIR, style: LineStyle.Dashed, width: 1, labelBackgroundColor: C.raised },
      horzLine: { color: CROSSHAIR, style: LineStyle.Dashed, width: 1, labelBackgroundColor: C.raised },
    },
    rightPriceScale: { borderVisible: false, minimumWidth: touch ? 52 : 64, entireTextOnly: true, scaleMargins: { top: 0.2, bottom: 0.08 } },
    leftPriceScale: { visible: false },
    timeScale: {
      borderVisible: true,
      borderColor: C.rule,
      timeVisible: true,
      secondsVisible: step < 60_000,
      rightOffset: rightOffset ?? (touch ? 3 : 5),
      minBarSpacing: 0.3,
      tickMarkFormatter: (t: Time, kind: number) => tickLabel((t as number) * 1000, tz, kind),
    },
    localization: { timeFormatter: (t: Time) => barLabel((t as number) * 1000, tz, step, touch) },
    // desktop: drag pans, the wheel zooms; touch: a sideways drag pans, a pinch zooms, a vertical swipe scrolls
    // the page, and a long press holds the crosshair until the next tap
    handleScroll: { mouseWheel: false, pressedMouseMove: true, horzTouchDrag: true, vertTouchDrag: false },
    handleScale: { mouseWheel: !touch, pinch: true, axisPressedMouseMove: { time: true, price: !touch }, axisDoubleClickReset: true },
    kineticScroll: { touch: true, mouse: false },
    // tracking ends when the finger lifts (the value box stays up until the next touch): a vertical swipe after
    // it scrolls the page, as on an exchange app. The long press itself is 380 ms (vite.config.ts patches the
    // library's 240 ms, which caught a thumb resting before a scroll).
    trackingMode: { exitMode: TrackingModeExitMode.OnTouchEnd },
  };
}

/** A series whose format prints the Hide amounts mask: its sign colours go too (mask.tsx's rule). */
const isMasked = (s: ExSeries) => formatSig(s).includes(MASK);

function seriesOptions(s: ExSeries, lastValue: boolean, visible: boolean): Record<string, unknown> {
  const fmt = defaultFormat(s);
  const masked = isMasked(s);
  const color = s.color ?? C.ink;
  const [up, down] = s.colors ?? [UP, DOWN];
  const width = s.width ?? (s.kind === "baseline" ? 2 : 1.5);
  const common: Record<string, unknown> = {
    visible,
    lastValueVisible: lastValue,
    priceLineVisible: lastValue,
    priceLineStyle: LineStyle.Dotted,
    priceFormat: { type: "custom", formatter: fmt, minMove: 0.01 },
    ...(s.scale && s.scale !== "right" ? { priceScaleId: s.scale } : null),
  };
  let o: Record<string, unknown>;
  switch (s.kind) {
    case "line":
      o = { color, lineWidth: width, lineStyle: STYLE[s.lineStyle ?? "solid"], crosshairMarkerRadius: 3 };
      break;
    case "area":
      o = { lineColor: color, topColor: rgba(color, 0.18), bottomColor: rgba(color, 0.0), lineWidth: width, crosshairMarkerRadius: 3 };
      break;
    case "baseline": {
      // masked: one neutral colour above and below the base, so the line does not tell a gain from a loss
      // (muted, not ink: an ink area would read as the Trading line)
      const [u, d] = masked ? [C.muted, C.muted] : [up, down];
      o = {
        baseValue: { type: "price", price: s.base ?? 0 },
        lineWidth: width,
        topLineColor: u,
        topFillColor1: rgba(u, masked ? 0.08 : 0.16),
        topFillColor2: rgba(u, 0.02),
        bottomLineColor: d,
        bottomFillColor1: rgba(d, 0.02),
        bottomFillColor2: rgba(d, masked ? 0.08 : 0.16),
        crosshairMarkerRadius: 3,
      };
      break;
    }
    case "histogram":
      o = { color: s.color ?? rgba(C.ink2, 0.4) };
      break;
    case "candles":
      o = { upColor: up, downColor: down, borderVisible: false, wickUpColor: up, wickDownColor: down };
      break;
  }
  return { ...common, ...o, ...s.options };
}

const DEF = { line: LineSeries, area: AreaSeries, baseline: BaselineSeries, histogram: HistogramSeries, candles: CandlestickSeries } as const;

/** Lightweight Charts' point for ours, cached by object so a live tail converts once. */
const conv = new WeakMap<object, unknown>();
/** A point's colour that leaves the segment to the next point undrawn (a line, an area, a baseline): where a
 *  figure restarts (a new day), so the drop to 0 is not drawn as a move. */
export const GAP = "transparent";
const GAP_COLORS = Object.fromEntries(
  ["color", "lineColor", "topColor", "bottomColor", "topLineColor", "bottomLineColor", "topFillColor1", "topFillColor2", "bottomFillColor1", "bottomFillColor2"].map((k) => [k, GAP]),
);
function toLwc(p: ExPoint | ExOhlc): unknown {
  let v = conv.get(p);
  if (v) return v;
  if (isOhlc(p)) v = { time: sec(p.time), open: p.open, high: p.high, low: p.low, close: p.close };
  else if (p.value == null || !Number.isFinite(p.value)) v = { time: sec(p.time) };
  else if (p.color === GAP) v = { time: sec(p.time), value: p.value, ...GAP_COLORS };
  else v = p.color ? { time: sec(p.time), value: p.value, color: p.color } : { time: sec(p.time), value: p.value };
  conv.set(p, v);
  return v;
}

/** The index from which `next` differs from `prev` when it only grew or changed its tail; -1 for a reset. */
function tailFrom(prev: readonly object[] | null, next: readonly object[]): number {
  if (!prev || !prev.length || !next.length) return -1;
  if (next.length < prev.length || next.length > prev.length + 5) return -1;
  if (prev[0] !== next[0]) return -1;
  const k = prev.length - 2;
  if (k > 0 && prev[k] !== next[k]) return -1;
  return Math.max(0, prev.length - 1);
}

/** The bar size of a series: the smallest gap among its last points. */
function stepOf(data: readonly { time: number }[]): number {
  let step = Infinity;
  for (let i = Math.max(1, data.length - 30); i < data.length; i++) {
    const d = data[i]!.time - data[i - 1]!.time;
    if (d > 0 && d < step) step = d;
  }
  return Number.isFinite(step) ? step : 60_000;
}

interface Live {
  def: ExSeries;
  api: ISeriesApi<SeriesType>;
  data: readonly (ExPoint | ExOhlc)[] | null;
  byTime: Map<number, ExPoint | ExOhlc>;
  sig: string;
  /** Its last value has an axis tag. */
  lv: boolean;
}

/** Hover state outside React's render path: only the legend and the box re-render on a crosshair move. */
interface Hover {
  t: number | null;
  x: number;
  v: number; // bumps when data changes, so the legend reads the new latest bar
  /** Touch: the finger lifted after a long press; the box keeps this bar until the next touch. */
  pinned: boolean;
}
function hoverStore() {
  let cur: Hover = { t: null, x: 0, v: 0, pinned: false };
  const subs = new Set<() => void>();
  return {
    get: () => cur,
    set: (h: Partial<Hover>) => {
      cur = { ...cur, ...h };
      subs.forEach((f) => f());
    },
    sub: (f: () => void) => {
      subs.add(f);
      return () => void subs.delete(f);
    },
  };
}
type HoverStore = ReturnType<typeof hoverStore>;

// ================================ component ================================

/**
 * One chart: series in panes, a toolbar, a legend per pane, the right axis, `>>`, gestures, and optionally
 * chips and fullscreen. Data goes in with each series (`series[i].data`), times in ms.
 */
export function ExChart(p: ExChartProps) {
  const touch = p.touch ?? coarse();
  const tz = useStore((s) => s.tz);
  const host = useRef<HTMLDivElement>(null);
  const plot = useRef<HTMLDivElement>(null);
  const chart = useRef<IChartApi | null>(null);
  const live = useRef(new Map<string, Live>());
  const markersApi = useRef(new Map<string, ISeriesMarkersPluginApi<Time>>());
  const ringsApi = useRef(new Map<string, FillRings>());
  const dividersApi = useRef<DayDividers | null>(null);
  const lines = useRef<[ISeriesApi<SeriesType>, IPriceLine][]>([]);
  const hov = useMemo(hoverStore, []);
  const [paneTops, setPaneTops] = useState<number[]>([0]);
  const [axisW, setAxisW] = useState(64);
  const [axisH, setAxisH] = useState(26);
  const [away, setAway] = useState(false); // panned away from the latest bar
  const [dense, setDense] = useState(false); // bars under 5 px apart: no markers
  const [awaiting, setAwaiting] = useState(false);
  const [drawn, setDrawn] = useState(0); // bumps once new data is in the chart: the legend reads it then
  const moved = useRef(false); // the user moved the view since the last fit: queued re-fits give way
  // with an id, the fullscreen is a route (#/chart/<id>: Back closes it, a reload keeps it); else local state
  const routed = !!p.id && !p.inFullscreen;
  const [fsLocal, setFsLocal] = useState(false);
  const routeChart = useStore((s) => (routed ? s.chart : null));
  const fs = routed ? routeChart === p.id : fsLocal;
  const setFs = (v: boolean) => (routed ? (v ? openChart(p.id!) : closeChart()) : setFsLocal(v));
  const [closed, setClosed] = useExPref<boolean>(p.id, "legendClosed", false);

  // hidden keys: controlled, or per id in the store
  const defaults = useMemo(() => p.series.filter((s) => s.hiddenByDefault).map((s) => s.key), [p.series]);
  const own = useExHidden(p.id, defaults);
  const hidden = p.hidden ?? own.hidden;
  const toggle = p.onToggle ?? own.toggle;
  const off = useCallback((k: string | undefined) => k != null && hidden.includes(k), [hidden]);
  // a series the user may not hide is always drawn (a key stored hidden before it became fixed stays shown)
  const offS = (s: ExSeries) => s.toggle !== false && off(s.key);

  const step = useMemo(() => stepOf(p.series[0]?.data ?? []), [p.series]);
  const stepRef = useRef(step);
  stepRef.current = step;
  const cbs = useRef(p);
  cbs.current = p;

  // ---- mount ----
  useLayoutEffect(() => {
    const el = host.current!;
    const c = createChart(el, chartOptions(touch, tz, stepRef.current, p.rightOffset));
    chart.current = c;
    cbs.current.chartRef?.(c);
    const fingerUp = { current: true }; // no finger on the screen
    const onMove = (e: MouseEventParams<Time>) => {
      const t = e.time == null ? null : (e.time as number) * 1000;
      // touch: when tracking ends on the finger's lift, the box keeps the last bar until the next touch
      if (t == null && touch && fingerUp.current && hov.get().t != null) {
        hov.set({ pinned: true });
        return;
      }
      hov.set({ t, x: e.point?.x ?? 0, pinned: false });
      cbs.current.onCrosshair?.(t);
    };
    // a finger down anywhere ends a kept reading; the user's own pan or zoom cancels the queued re-fits
    const onDocDown = () => {
      fingerUp.current = false;
      if (hov.get().pinned) {
        hov.set({ t: null, pinned: false });
        cbs.current.onCrosshair?.(null);
      }
    };
    const onDocUp = (e: TouchEvent) => {
      if (e.touches.length === 0) fingerUp.current = true;
    };
    const onUser = () => (moved.current = true);
    document.addEventListener("touchstart", onDocDown, { capture: true, passive: true });
    document.addEventListener("touchend", onDocUp, { capture: true, passive: true });
    document.addEventListener("touchcancel", onDocUp, { capture: true, passive: true });
    el.addEventListener("pointerdown", onUser, { passive: true });
    el.addEventListener("wheel", onUser, { passive: true });
    c.subscribeCrosshairMove(onMove);
    const onClick = (e: MouseEventParams<Time>) => {
      if (e.time != null) cbs.current.onBarClick?.((e.time as number) * 1000);
    };
    c.subscribeClick(onClick);
    const ts = c.timeScale();
    const onRange = () => {
      const r = ts.getVisibleLogicalRange();
      // with a page's own view (a chosen day) `>>` goes back to that view once the user has moved it; else to
      // the latest bar once it is out of sight
      setAway(cbs.current.view ? moved.current : ts.scrollPosition() < -2);
      if (r) setDense(ts.width() / Math.max(1, r.to - r.from) < 5);
      if (r && r.from < 40 && moved.current) cbs.current.onNearStart?.();
    };
    ts.subscribeVisibleLogicalRangeChange(onRange);
    const measure = () => {
      if (chart.current !== c) return; // a frame queued before the chart was removed
      const top = el.getBoundingClientRect().top;
      setPaneTops(c.panes().map((pn) => (pn.getHTMLElement()?.getBoundingClientRect().top ?? top) - top));
      setAxisW(c.priceScale("right", 0).width() || 64);
      setAxisH(ts.height() || 26);
    };
    const ro = new ResizeObserver(() => requestAnimationFrame(measure));
    ro.observe(el);
    ts.subscribeSizeChange(measure);
    const liveMap = live.current;
    const mk = markersApi.current;
    return () => {
      ro.disconnect();
      document.removeEventListener("touchstart", onDocDown, { capture: true });
      document.removeEventListener("touchend", onDocUp, { capture: true });
      document.removeEventListener("touchcancel", onDocUp, { capture: true });
      el.removeEventListener("pointerdown", onUser);
      el.removeEventListener("wheel", onUser);
      c.unsubscribeCrosshairMove(onMove);
      c.unsubscribeClick(onClick);
      ts.unsubscribeVisibleLogicalRangeChange(onRange);
      ts.unsubscribeSizeChange(measure);
      c.remove();
      chart.current = null;
      needFit.current = true; // a chart made again (a remount) fits its data again
      liveMap.clear();
      mk.clear();
      ringsApi.current.clear();
      lines.current = [];
      cbs.current.chartRef?.(null);
    };
    // the layout (touch) is fixed per mount
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const c = chart.current;
    if (!c) return;
    // only the labels: applying the time scale's spacing options again would undo a fit just made (the bar
    // spacing goes back to its default and the view scrolls to the end), as on a switch of interval
    const o = chartOptions(touch, tz, step, p.rightOffset);
    c.applyOptions({ timeScale: { secondsVisible: o.timeScale!.secondsVisible, tickMarkFormatter: o.timeScale!.tickMarkFormatter }, localization: o.localization });
  }, [tz, step, touch, p.rightOffset]);
  // the right offset only when the prop changes: setting it scrolls to the live edge
  const offRef = useRef(p.rightOffset);
  useEffect(() => {
    if (p.rightOffset === offRef.current) return;
    offRef.current = p.rightOffset;
    chart.current?.timeScale().applyOptions({ rightOffset: p.rightOffset ?? (touch ? 3 : 5) });
  }, [p.rightOffset, touch]);

  // the prices with an axis tag in a pane: the last values shown, the price lines with an axis label
  const tagPrices = (pane: number): number[] => {
    const out: number[] = [];
    for (const l of live.current.values()) {
      if ((l.def.pane ?? 0) !== pane || !l.lv || !l.data?.length || (l.def.scale && l.def.scale !== "right")) continue;
      if (l.def.toggle !== false && hiddenRef.current.includes(l.def.key)) continue;
      const last = l.data[l.data.length - 1]!;
      const v = isOhlc(last) ? last.close : last.value;
      if (v != null && Number.isFinite(v)) out.push(v);
    }
    for (const [api, pl] of lines.current) {
      const l = [...live.current.values()].find((x) => x.api === api);
      if (!l || (l.def.pane ?? 0) !== pane) continue;
      const o = pl.options();
      if (o.axisLabelVisible) out.push(o.price);
    }
    return out;
  };
  const hiddenRef = useRef(hidden);
  hiddenRef.current = hidden;

  // ---- series: structure, options, data ----
  const structure = p.series.map((s) => `${s.key}:${s.kind}:${s.pane ?? 0}:${s.scale ?? ""}`).join("|");
  const ivRef = useRef(p.interval);
  const dataRefs = useRef<unknown[]>([]);
  const needFit = useRef(true);
  const resetRef = useRef(p.resetKey);
  const loadRef = useRef(!!p.loading);

  const fitView = useCallback(() => {
    const c = chart.current;
    if (!c) return;
    let n = 0;
    for (const l of live.current.values()) n = Math.max(n, l.data?.length ?? 0);
    if (!n) return;
    const want = cbs.current.initialBars;
    const right = cbs.current.rightOffset ?? (touch ? 3 : 5);
    const ts = c.timeScale();
    const apply = () => {
      const v = cbs.current.view;
      ts.applyOptions({ shiftVisibleRangeOnNewBar: !v });
      if (v && "logical" in v) ts.setVisibleLogicalRange(v.logical);
      else if (v) ts.setVisibleRange({ from: sec(v.time.from), to: sec(v.time.to) });
      else if (want && n > want) ts.setVisibleLogicalRange({ from: n - want, to: n - 1 + right });
      // all bars, the first one whole (fitContent cuts it at the left edge), `right` bars of room after the last
      else ts.setVisibleLogicalRange({ from: -0.6, to: n - 1 + right });
    };
    moved.current = false;
    apply();
    // the chart takes new data on its next frame and clamps a range set before it to the old bars, and a chart
    // created with its data at hand is laid out (autoSize) a frame or two later: fit again after each, unless the
    // user has moved the view in between
    requestAnimationFrame(() => {
      if (chart.current !== c || moved.current) return;
      apply();
      requestAnimationFrame(() => chart.current === c && !moved.current && apply());
    });
  }, [touch]);
  // a new view from the page: applied at once (and again over the next frames)
  const viewKey = p.view ? JSON.stringify(p.view) : "";
  const viewRef = useRef(viewKey);
  useEffect(() => {
    if (viewKey === viewRef.current) return;
    viewRef.current = viewKey;
    fitView();
  }, [viewKey, fitView]);

  useLayoutEffect(() => {
    const c = chart.current;
    if (!c) return;
    const map = live.current;
    // structure changed: rebuild every series (and the panes), keeping the view
    const keys = new Set(p.series.map((s) => s.key));
    const sameStructure = map.size === p.series.length && [...map.keys()].every((k) => keys.has(k)) && [...map.values()].every((l) => {
      const s = p.series.find((x) => x.key === l.def.key)!;
      return s.kind === l.def.kind && (s.pane ?? 0) === (l.def.pane ?? 0) && (s.scale ?? "") === (l.def.scale ?? "");
    });
    if (!sameStructure) {
      const view = map.size ? c.timeScale().getVisibleLogicalRange() : null;
      for (const l of map.values()) c.removeSeries(l.api);
      map.clear();
      markersApi.current.clear();
      ringsApi.current.clear();
      lines.current = [];
      while (c.panes().length > 1) c.removePane(c.panes().length - 1);
      const firstInPane = new Set<number>();
      for (const s of p.series) {
        const pane = s.pane ?? 0;
        const lv = s.lastValue ?? (s.kind !== "histogram" && !firstInPane.has(pane));
        firstInPane.add(pane);
        const api = c.addSeries(DEF[s.kind] as never, seriesOptions(s, lv, !offS(s)) as never, pane) as ISeriesApi<SeriesType>;
        if (s.margins) api.priceScale().applyOptions({ scaleMargins: s.margins });
        else if (pane > 0 && !s.scale) api.priceScale().applyOptions({ scaleMargins: { top: 0.25, bottom: 0 } });
        if (s.scale && s.scale !== "right") api.priceScale().applyOptions({ visible: false });
        map.set(s.key, { def: s, api, data: null, byTime: new Map(), sig: "", lv });
      }
      // per pane: the axis cleared around its tags (rings.ts AxisGuard)
      const guarded = new Set<number>();
      for (const s of p.series) {
        const pane = s.pane ?? 0;
        if (guarded.has(pane) || (s.scale && s.scale !== "right")) continue;
        guarded.add(pane);
        map.get(s.key)!.api.attachPrimitive(new AxisGuard(() => tagPrices(pane)));
      }
      const first = map.values().next().value;
      dividersApi.current = null;
      if (first) first.api.attachPrimitive((dividersApi.current = new DayDividers(DIVIDER)));
      if (view) needFit.current = false;
      requestAnimationFrame(() => {
        if (view && chart.current) chart.current.timeScale().setVisibleLogicalRange(view);
      });
    }
    // pane heights; a pane whose series are all hidden folds away
    const panes = c.panes();
    panes.forEach((pn, i) => {
      const inPane = p.series.filter((s) => (s.pane ?? 0) === i);
      const allOff = i > 0 && inPane.length > 0 && inPane.every((s) => offS(s));
      pn.setStretchFactor(allOff ? 0.001 : (p.paneStretch?.[i] ?? (i === 0 ? 1 : 0.25)));
    });

    // options (cheap signature compare; functions by identity are not compared)
    const firstInPane = new Set<number>();
    for (const s of p.series) {
      const l = map.get(s.key)!;
      const pane = s.pane ?? 0;
      const lv = s.lastValue ?? (s.kind !== "histogram" && !firstInPane.has(pane));
      firstInPane.add(pane);
      const sig = JSON.stringify([s.color, s.colors, s.width, s.lineStyle, s.base, lv, offS(s), s.options, s.margins, formatSig(s)]);
      if (sig !== l.sig) {
        const o = seriesOptions(s, lv, !offS(s));
        // candles keep the precision their data set (below)
        if (s.kind === "candles" && l.data?.length) o.priceFormat = { type: "custom", formatter: defaultFormat(s), minMove: minMoveFor((l.data[l.data.length - 1] as ExOhlc).close) };
        l.api.applyOptions(o as never);
        if (s.margins) l.api.priceScale().applyOptions({ scaleMargins: s.margins });
        l.sig = sig;
      }
      l.def = s;
      l.lv = lv;
    }

    // interval switched and the data is still the old one: clear at once, wait for the new
    const refs = p.series.map((s) => s.data);
    const dataSame = refs.length === dataRefs.current.length && refs.every((r, i) => r === dataRefs.current[i]);
    let wait = awaiting;
    const loadDone = loadRef.current && !p.loading;
    loadRef.current = !!p.loading;
    if (p.interval !== ivRef.current) {
      ivRef.current = p.interval;
      needFit.current = true;
      if (dataSame && refs.some((r) => r.length)) wait = true;
    } else if (wait && (!dataSame || loadDone)) wait = false;
    if (p.resetKey !== resetRef.current) {
      resetRef.current = p.resetKey;
      needFit.current = true;
    }
    dataRefs.current = refs;
    if (wait !== awaiting) setAwaiting(wait);
    const blank = wait || !!p.loading;

    // data
    let changed = false;
    for (const s of p.series) {
      const l = map.get(s.key)!;
      const data = blank ? EMPTY : (s.data as readonly (ExPoint | ExOhlc)[]);
      if (data === l.data) continue;
      changed = true;
      const from = tailFrom(l.data, data);
      if (from < 0) {
        l.api.setData(data.map(toLwc) as never);
        l.byTime = new Map(data.map((d) => [d.time, d]));
        if (s.kind === "candles" && data.length) {
          const mm = minMoveFor((data[data.length - 1] as ExOhlc).close);
          l.api.applyOptions({ priceFormat: { type: "custom", formatter: defaultFormat(s), minMove: mm } } as never);
        }
      } else {
        for (let i = from; i < data.length; i++) {
          if (l.data && data[i] === l.data[i]) continue;
          l.api.update(toLwc(data[i]!) as never);
          l.byTime.set(data[i]!.time, data[i]!);
        }
      }
      l.data = data;
    }
    if (changed) {
      if (blank) needFit.current = true;
      else if (needFit.current && [...map.values()].some((l) => l.data?.length)) {
        needFit.current = false;
        fitView();
      }
      hov.set({ v: hov.get().v + 1 });
      setDrawn((n) => n + 1);
    }
  });

  useLayoutEffect(() => {
    dividersApi.current?.set(awaiting || p.loading ? [] : (p.dividers ?? []).map(sec));
  });

  // the wait for a new interval's data never outlasts 4 s: then it shows what there is
  useEffect(() => {
    if (!awaiting) return;
    const id = setTimeout(() => setAwaiting(false), 4000);
    return () => clearTimeout(id);
  }, [awaiting]);

  // ---- markers (one plugin per series), hidden while bars are dense ----
  useLayoutEffect(() => {
    const map = live.current;
    const by = new Map<string, SeriesMarker<Time>[]>();
    const rings = new Map<string, Ring[]>();
    if (!dense && !awaiting && !p.loading)
      for (const m of p.markers ?? []) {
        // a marker needs its bar in the series (a fill before the first bar, or in a bar not drawn yet, waits)
        if (off(m.key) || off(m.series) || !map.get(m.series)?.byTime.has(m.time)) continue;
        if (m.shape === "ring") {
          if (m.price == null) continue;
          const list = rings.get(m.series) ?? [];
          list.push({ time: sec(m.time), price: m.price, color: m.color, side: m.offset ?? 0 });
          rings.set(m.series, list);
          continue;
        }
        const list = by.get(m.series) ?? [];
        list.push({
          time: sec(m.time),
          position: m.position ?? (m.price != null ? "atPriceMiddle" : "inBar"),
          price: m.price,
          color: m.color,
          shape: m.shape ?? "circle",
          size: m.size ?? 0.7,
          text: m.text,
        } as SeriesMarker<Time>);
        by.set(m.series, list);
      }
    for (const [k, l] of map) {
      const list = (by.get(k) ?? []).sort((a, b) => (a.time as number) - (b.time as number));
      let api = markersApi.current.get(k);
      if (!api && !list.length) continue;
      if (!api) markersApi.current.set(k, (api = createSeriesMarkers(l.api, [], { autoScale: false })));
      api.setMarkers(list);
    }
    for (const [k, l] of map) {
      const list = rings.get(k) ?? [];
      let prim = ringsApi.current.get(k);
      if (!prim && !list.length) continue;
      if (!prim) {
        prim = new FillRings();
        l.api.attachPrimitive(prim);
        ringsApi.current.set(k, prim);
      }
      prim.set(list);
    }
    // `drawn`: a marker whose bar came after it is placed once the bar is in
  }, [p.markers, dense, awaiting, p.loading, off, structure, drawn]);

  // ---- price lines ----
  useLayoutEffect(() => {
    for (const [s, pl] of lines.current) s.removePriceLine(pl);
    lines.current = [];
    if (awaiting || p.loading) return;
    for (const pl of p.priceLines ?? []) {
      const l = live.current.get(pl.series);
      if (!l || off(pl.key) || !Number.isFinite(pl.price)) continue;
      lines.current.push([
        l.api,
        l.api.createPriceLine({
          price: pl.price,
          color: pl.color,
          lineWidth: (pl.width ?? 1) as 1,
          lineStyle: STYLE[pl.style ?? "dashed"],
          title: pl.title ?? "",
          axisLabelVisible: pl.axisLabel ?? true,
          ...(pl.labelColor && { axisLabelColor: pl.labelColor }),
          ...(pl.labelTextColor && { axisLabelTextColor: pl.labelTextColor }),
        }),
      ]);
    }
  }, [p.priceLines, awaiting, p.loading, off, structure]);

  // re-measure the panes when their layout may have changed
  const hiddenKey = hidden.join("|");
  useEffect(() => {
    const c = chart.current;
    const el = host.current;
    if (!c || !el) return;
    const id = requestAnimationFrame(() => {
      const top = el.getBoundingClientRect().top;
      setPaneTops(c.panes().map((pn) => (pn.getHTMLElement()?.getBoundingClientRect().top ?? top) - top));
      setAxisW(c.priceScale("right", 0).width() || 64);
    });
    return () => cancelAnimationFrame(id);
  }, [structure, hiddenKey, p.paneStretch?.join(",")]);

  // ---- legend model ----
  const lookup = useCallback((key: string, t: number) => live.current.get(key)?.byTime.get(t), []);
  // the latest bar the chart holds (not the props' data, which runs one layout pass ahead of it: a legend drawn
  // from it would look up bars the chart does not have yet and show dashes)
  const latest = useCallback(() => {
    let t = -Infinity;
    for (const l of live.current.values()) {
      const d = l.data;
      if (d?.length) t = Math.max(t, d[d.length - 1]!.time);
    }
    return Number.isFinite(t) ? t : null;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [drawn]);

  const restAt = useCallback(() => p.legendTime ?? latest(), [p.legendTime, latest]);
  // panes below the main one whose series are all hidden: folded away, without a legend
  const folded = useMemo(() => {
    const out = new Set<number>();
    const panes = new Set(p.series.map((s) => s.pane ?? 0));
    for (const i of panes) if (i > 0 && p.series.filter((s) => (s.pane ?? 0) === i).every((s) => offS(s))) out.add(i);
    return out;
  }, [p.series, off]);

  const legend = useMemo(
    () => buildLegend(p.series, p.legendExtra ?? [], lookup, touch, tz, step),
    [p.series, p.legendExtra, lookup, touch, tz, step],
  );

  const boxRows = useCallback(
    (t: number): ExBoxRow[] => {
      if (p.boxRows) return p.boxRows(t);
      const rows: ExBoxRow[] = [["Time", boxLabel(t, tz, step)]];
      for (const s of p.series) {
        if (s.box === false || offS(s)) continue;
        const pt = lookup(s.key, t);
        const fmt = defaultFormat(s);
        if (s.kind === "candles") {
          if (!pt || !isOhlc(pt)) continue;
          const dir = pt.close >= pt.open ? UP : DOWN;
          rows.push(["Open", fmt(pt.open)], ["High", fmt(pt.high)], ["Low", fmt(pt.low)], ["Close", fmt(pt.close)]);
          const priceLike = !s.format || s.format === fmtPrice;
          rows.push(["Chg", priceLike ? num(pt.close - pt.open, priceDecimals(pt.close), true) : fmt(pt.close - pt.open), dir]);
          if (priceLike) {
            rows.push(["%Chg", pctText((pt.close - pt.open) / pt.open), dir]);
            rows.push(["Range", num(((pt.high - pt.low) / pt.low) * 100, 2) + "%"]);
          }
        } else {
          const v = pt && !isOhlc(pt) ? pt.value : null;
          rows.push([s.label, v == null ? "--" : fmt(v), s.signColor ? signColor(v) : (s.color ?? C.ink)]);
        }
      }
      for (const it of p.legendExtra ?? []) {
        if (!it.box || off(it.key)) continue;
        const r = (typeof it.box === "function" ? it.box : it.value)(t);
        const [txt, col] = Array.isArray(r) ? r : [r, undefined];
        rows.push([it.label, txt, col ?? it.color]);
      }
      return rows;
    },
    [p.boxRows, p.series, p.legendExtra, tz, step, off, lookup],
  );

  // ---- chips ----
  const chipItems: (Chip | "|")[] | null =
    p.chips === true
      ? p.series
          .filter((s) => s.toggle !== false)
          .map((s) => ({ key: s.key, label: s.label, color: s.kind === "candles" ? undefined : s.color, stroke: s.lineStyle, bar: s.kind === "histogram" }))
      : p.chips || null;

  const anyData = p.series.some((s) => s.data.length);
  const showLoading = awaiting || !!p.loading;
  const hasToolbar = !!(p.intervals?.length || p.modes?.length || p.fullscreen || p.toolbarLeft || p.inFullscreen);
  const onFs = () => {
    if (typeof p.fullscreen === "function") return p.fullscreen();
    goFullscreen();
    setFs(true);
  };

  // the interval row scrolls sideways when it does not fit (a phone, fullscreen upright): it fades at the edge it
  // continues past
  const [tbScroll, tbFade, measureTb] = useScrollFade<HTMLDivElement>();

  const plotStyle: CSSProperties = p.fill || p.inFullscreen ? { flex: 1, minHeight: 0 } : { height: p.height ?? 300 };

  return (
    <div className={"ex-chart" + (touch ? " touch" : "") + (p.fill || p.inFullscreen ? " fill" : "") + (p.className ? " " + p.className : "")} style={p.style}>
      {p.inFullscreen && p.title != null && <div className="ex-fs-titlerow">{p.title}</div>}
      {hasToolbar && (
        <div className="ex-tb">
          <div className={"ex-tb-scroll" + tbFade} ref={tbScroll} onScroll={measureTb}>
            {p.inFullscreen && p.title != null && <span className="ex-fs-title">{p.title}</span>}
            {p.toolbarLeft}
            {!!p.intervals?.length && (
              <TextToggle className="ex-iv" label="Interval" options={p.intervals} value={p.interval ?? ""} onChange={(v) => p.onInterval?.(v)} />
            )}
          </div>
          {!!p.moreIntervals?.length && (
            <MoreIntervals options={p.moreIntervals} value={p.interval ?? ""} onChange={(v) => p.onInterval?.(v)} />
          )}
          <span className="ex-tb-gap" />
          {p.modes?.map((m) => <TextToggle key={m.label} label={m.label} options={m.options} value={m.value} onChange={m.onChange} />)}
          {p.inFullscreen ? (
            <button type="button" className="ex-icon" onClick={p.onCloseFullscreen} title="Close" aria-label="Close fullscreen">
              <CloseIcon />
            </button>
          ) : (
            p.fullscreen && (
              <button type="button" className="ex-icon" onClick={onFs} title="Fullscreen" aria-label="Fullscreen">
                <FsIcon />
              </button>
            )
          )}
        </div>
      )}
      <div className="ex-plot" ref={plot} style={plotStyle}>
        <div className="ex-host" ref={host} />
        {!showLoading && anyData && (
          <LegendLayer
            model={legend}
            hov={hov}
            latest={restAt}
            tops={paneTops}
            off={off}
            folded={folded}
            toggle={toggle}
            touch={touch}
            closed={closed}
            setClosed={setClosed}
            axisW={axisW}
            names={p.legendRest === "names"}
          />
        )}
        {touch && !showLoading && <ValueBox hov={hov} rows={boxRows} axisW={axisW} axisH={axisH} top={paneTops[0] ?? 0} host={plot} />}
        {showLoading ? (
          <div className="ex-center" style={{ right: axisW }}>
            Loading
          </div>
        ) : (
          !anyData && (
            <div className="ex-center" style={{ right: axisW }}>
              {p.emptyText ?? "No data"}
            </div>
          )
        )}
        {away && !showLoading && (
          <button
            type="button"
            className="ex-live"
            style={{ right: axisW + 8, bottom: axisH + 8 }}
            onClick={() => {
              // at once, not animated: an animation after a long pan could end short of the edge and leave `>>` up
              const ts = chart.current?.timeScale();
              if (!ts) return;
              if (cbs.current.view) {
                fitView();
                setAway(false);
                return;
              }
              ts.scrollToPosition(cbs.current.rightOffset ?? (touch ? 3 : 5), false);
              setAway(ts.scrollPosition() < -2);
            }}
            title={p.view ? "Back to the chosen range" : "Back to the latest bar"}
            aria-label={p.view ? "Back to the chosen range" : "Back to the latest bar"}
          >
            »
          </button>
        )}
      </div>
      {chipItems && <ChipRow items={chipItems} isOn={(k) => !off(k)} onToggle={toggle} />}
      {fs && !p.inFullscreen && (
        <ChartFullscreen onClose={() => setFs(false)} routed={routed}>
          <ExChart {...p} inFullscreen onCloseFullscreen={() => setFs(false)} fullscreen={false} chartRef={undefined} />
        </ChartFullscreen>
      )}
    </div>
  );
}

const EMPTY: readonly (ExPoint | ExOhlc)[] = [];

function pctText(r: number): string {
  if (!Number.isFinite(r)) return "--";
  return (r > 0 ? "+" : "") + num(r * 100, 2, false) + "%";
}

// ================================ legend ================================

interface LegendEntry {
  key?: string;
  label: string;
  color?: string;
  /** A line series: its key (colour and stroke) before the label, with a mouse (the phone's chips carry it). */
  stroke?: Stroke;
  value: (t: number) => ExValue;
  title?: string;
  /** A series' own entry (its name stays in a names-only legend at rest). */
  series?: boolean;
}
type LegendModel = { pane: number; lines: LegendEntry[][] }[];

function buildLegend(
  series: ExSeries[],
  extra: ExLegendItem[],
  lookup: (key: string, t: number) => ExPoint | ExOhlc | undefined,
  touch: boolean,
  tz: TzMode,
  step: number,
): LegendModel {
  const panes = new Map<number, Map<number, LegendEntry[]>>();
  const add = (pane: number, line: number, e: LegendEntry) => {
    let m = panes.get(pane);
    if (!m) panes.set(pane, (m = new Map()));
    const l = m.get(line) ?? [];
    l.push(e);
    m.set(line, l);
  };
  // touch: the clock only for intraday bars (the value box has the date)
  add(0, 1, { label: "", color: C.muted, value: (t) => [touch && step < 86_400_000 ? barLabel(t, tz, step, touch).split(" ").pop()! : barLabel(t, tz, step, touch), C.muted] });
  const seen = new Set<number>();
  for (const s of series) {
    const pane = s.pane ?? 0;
    const first = !seen.has(pane);
    seen.add(pane);
    if (s.legend === false) continue;
    const line = typeof s.legend === "number" ? s.legend : pane === 0 && !first ? 2 : 1;
    const fmt = defaultFormat(s);
    const key = s.toggle === false ? undefined : s.key;
    if (s.kind === "candles") {
      const bar = (t: number) => {
        const p = lookup(s.key, t);
        return p && isOhlc(p) ? p : null;
      };
      const dir = (b: ExOhlc) => (b.close >= b.open ? UP : DOWN);
      const f = (pick: (b: ExOhlc) => number) => (t: number): ExValue => {
        const b = bar(t);
        return b ? [fmt(pick(b)), dir(b)] : "--";
      };
      if (touch) {
        // a phone's line holds the close and the bar's change; the long-press box has open, high, low, close
        const pctOk = !s.format || s.format === fmtPrice;
        add(pane, line, { label: "Close", value: f((b) => b.close) });
        add(pane, line, {
          label: "Chg",
          value: (t) => {
            const b = bar(t);
            return b ? [pctOk ? pctText((b.close - b.open) / b.open) : fmt(b.close - b.open), dir(b)] : "--";
          },
        });
        continue;
      }
      add(pane, line, { label: "Open", value: f((b) => b.open) });
      add(pane, line, { label: "High", value: f((b) => b.high) });
      add(pane, line, { label: "Low", value: f((b) => b.low) });
      add(pane, line, { label: "Close", value: f((b) => b.close) });
      const priceLike = !s.format || s.format === fmtPrice;
      if (!touch && !priceLike)
        add(pane, line, {
          label: "Chg",
          value: (t) => {
            const b = bar(t);
            return b ? [fmt(b.close - b.open), dir(b)] : "--";
          },
        });
      if (!touch && priceLike) {
        add(pane, line, {
          label: "Chg",
          value: (t) => {
            const b = bar(t);
            return b ? [pctText((b.close - b.open) / b.open), dir(b)] : "--";
          },
        });
        add(pane, line, {
          label: "Range",
          value: (t) => {
            const b = bar(t);
            return b ? [num(((b.high - b.low) / b.low) * 100, 2) + "%", dir(b)] : "--";
          },
        });
      }
      continue;
    }
    add(pane, line, {
      key,
      series: true,
      label: s.label,
      color: s.kind === "baseline" || s.kind === "histogram" ? undefined : s.color,
      stroke: s.kind === "line" && !touch ? (s.lineStyle ?? "solid") : undefined,
      value: (t) => {
        const p = lookup(s.key, t);
        const v = p && !isOhlc(p) ? p.value : null;
        if (v == null) return "--";
        return [fmt(v), s.signColor || s.kind === "baseline" ? signColor(v) : s.kind === "histogram" ? C.ink : (s.color ?? C.ink)];
      },
    });
  }
  for (const it of extra) add(it.pane ?? 0, it.line ?? 2, { key: it.key, label: it.label, color: it.color, value: it.value, title: it.title });
  return [...panes.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([pane, m]) => ({ pane, lines: [...m.entries()].sort((a, b) => a[0] - b[0]).map(([, l]) => l) }));
}

const LegendLayer = memo(function LegendLayer({
  model,
  hov,
  latest,
  tops,
  off,
  folded,
  toggle,
  touch,
  closed,
  setClosed,
  axisW,
  names,
}: {
  names: boolean;
  model: LegendModel;
  hov: HoverStore;
  latest: () => number | null;
  tops: number[];
  off: (k: string | undefined) => boolean;
  folded: ReadonlySet<number>;
  toggle: (k: string) => void;
  touch: boolean;
  closed: boolean;
  setClosed: (v: boolean) => void;
  axisW: number;
}) {
  const h = useSyncExternalStore(hov.sub, hov.get);
  const t = h.t ?? latest();
  if (t == null) return null;
  // at rest with names only: each series' name and key, no figures, no clock, no chevron
  const rest = names && h.t == null;
  // a phone has the names in its chips under the chart: nothing over the plot at rest
  if (rest && touch) return null;
  return (
    <>
      {model.map(({ pane, lines }) => {
        // a folded pane (every series hidden) shows no legend
        if (tops[pane] == null || folded.has(pane)) return null;
        return (
          <div key={pane} className="ex-legend" style={{ top: tops[pane]! + 4, maxWidth: `calc(100% - ${axisW + 16}px)` }}>
            {lines.map((items, i) => {
              if (pane === 0 && i > 0 && closed && !rest) return null;
              const shown = (touch ? items.filter((it) => !off(it.key)) : items).filter((it) => !rest || it.series);
              if (!shown.length) return null;
              return (
                <div key={i} className="ex-lg-line">
                  {pane === 0 && lines.length > 1 && !rest && (
                    <span
                      className={"ex-chev" + (i === 0 ? (closed ? " closed" : "") : " blank")}
                      onClick={i === 0 ? () => setClosed(!closed) : undefined}
                      role={i === 0 ? "button" : undefined}
                      aria-label={i === 0 ? (closed ? "Show all legend lines" : "Show the first legend line only") : undefined}
                    >
                      {i === 0 ? "⌄" : ""}
                    </span>
                  )}
                  {/* the items wrap under the first one, not under the chevron */}
                  <span className="ex-lg-items">
                  {shown.map((it, j) => {
                    const r = it.value(t);
                    const [txt, c0] = Array.isArray(r) ? r : [r, undefined];
                    const col = txt === MASK ? C.muted : c0;
                    const isOff = off(it.key);
                    return (
                      <span
                        key={j}
                        className={"ex-lg-it" + (it.key ? " tog" : "") + (isOff ? " off" : "")}
                        onClick={it.key ? () => toggle(it.key!) : undefined}
                        title={it.title ?? (it.key ? "Click to hide or show" : undefined)}
                      >
                        {it.stroke && it.color && <SeriesKey color={it.color} stroke={it.stroke} on={!isOff} />}
                        {it.label && <span className={"ex-lg-l" + (rest ? " rest" : "")}>{it.label}</span>}
                        {!rest && (
                          <span className="ex-lg-v" style={{ color: col ?? it.color ?? C.ink }}>
                            {txt}
                          </span>
                        )}
                      </span>
                    );
                  })}
                  </span>
                </div>
              );
            })}
          </div>
        );
      })}
    </>
  );
});

// ================================ More ▾ ================================

function MoreIntervals({ options, value, onChange }: { options: Option[]; value: string; onChange: (v: string) => void }) {
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const away = (e: PointerEvent) => box.current && !box.current.contains(e.target as Node) && setOpen(false);
    const esc = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("pointerdown", away);
    document.addEventListener("keydown", esc);
    return () => {
      document.removeEventListener("pointerdown", away);
      document.removeEventListener("keydown", esc);
    };
  }, [open]);
  const cur = options.find((o) => o.value === value);
  return (
    <div className="ex-more" ref={box}>
      <button type="button" className={"ex-more-btn" + (cur ? " on" : "")} aria-expanded={open} aria-haspopup="menu" onClick={() => setOpen(!open)}>
        {cur ? cur.label : "More"} <span className="ex-caret">▾</span>
      </button>
      {open && (
        <div className="ex-more-menu" role="menu">
          {options.map((o) => (
            <button
              key={o.value}
              type="button"
              role="menuitemradio"
              aria-checked={o.value === value}
              className={o.value === value ? "on" : ""}
              onClick={() => {
                onChange(o.value);
                setOpen(false);
              }}
            >
              {o.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

// ================================ touch value box ================================

const BOX_ROW = 17;

function ValueBox({
  hov,
  rows,
  axisW,
  axisH,
  top,
  host,
}: {
  hov: HoverStore;
  rows: (t: number) => ExBoxRow[];
  axisW: number;
  axisH: number;
  top: number;
  host: { current: HTMLDivElement | null };
}) {
  const h = useSyncExternalStore(hov.sub, hov.get);
  if (h.t == null) return null;
  const el = host.current;
  const w = el?.clientWidth ?? 0;
  const ht = el?.clientHeight ?? 0;
  // under the main pane's legend, so it never covers the legend lines
  const lg = el?.querySelector<HTMLElement>(".ex-legend");
  const y = Math.max(top + 4, lg ? lg.offsetTop + lg.offsetHeight + 4 : top + 30);
  const list = rows(h.t);
  // on the side away from the finger; two columns where one would not fit above the time axis (a phone held
  // sideways)
  const left = h.x > (w - axisW) / 2;
  const two = ht > 0 && y + list.length * BOX_ROW + 14 > ht - axisH;
  return (
    <div className={"ex-box fig" + (two ? " two" : "")} style={{ top: two ? Math.max(top + 4, Math.min(y, ht - axisH - Math.ceil(list.length / 2) * BOX_ROW - 16)) : y, ...(left ? { left: 6 } : { right: axisW + 6 }) }}>
      {list.map(([l, v, c0], i) => {
        const c = v === MASK ? C.muted : c0;
        return (
        <div key={i}>
          <span>{l}</span>
          <span style={{ color: c ?? C.ink }}>{v}</span>
        </div>
        );
      })}
    </div>
  );
}

// ================================ icons ================================

function FsIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.4" aria-hidden="true">
      <path d="M1 5V1h4M9 1h4v4M13 9v4H9M5 13H1V9" />
    </svg>
  );
}
function CloseIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true">
      <path d="M2 2l10 10M12 2L2 12" />
    </svg>
  );
}

// ================================ data helpers ================================

/** Candles → ExOhlc points (the same objects: a Candle already is one). */
export const candlePoints = <T extends ExOhlc>(bars: readonly T[]): readonly T[] => bars;

const volCache = [new WeakMap<object, ExPoint>(), new WeakMap<object, ExPoint>()];
/**
 * A volume histogram from candles, coloured by the bar's direction at 45 % alpha; `quote` multiplies by the
 * close (quote volume). Cached per candle object, so a live tail keeps earlier points' identity.
 */
export function volumePoints(bars: readonly (ExOhlc & { volume: number })[], quote = false): ExPoint[] {
  const cache = volCache[quote ? 1 : 0]!;
  return bars.map((b) => {
    let p = cache.get(b);
    if (!p) cache.set(b, (p = { time: b.time, value: quote ? b.volume * b.close : b.volume, color: rgba(b.close >= b.open ? UP : DOWN, 0.45) }));
    return p;
  });
}

const closeCache = new WeakMap<object, ExPoint>();
/** A line on closes (the `Line` interval mode), cached per candle. */
export function closePoints(bars: readonly ExOhlc[]): ExPoint[] {
  return bars.map((b) => {
    let p = closeCache.get(b);
    if (!p) closeCache.set(b, (p = { time: b.time, value: b.close }));
    return p;
  });
}
