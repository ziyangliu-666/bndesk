// Today's desk on TradingView Lightweight Charts v5 (Apache-2.0; the attribution logo stays on).
// Per-minute bars from /api/history, refetched every minute; the websocket's 5 s series and fills move the
// current minute in between. Pane 0: P&L lines over session bands; pane 1: notional filled; pane 2: exposure.
import { useEffect, useRef, useState } from "react";
import { UnstyledButton } from "@mantine/core";
import {
  HistogramSeries,
  LineSeries,
  LineStyle,
  createChart,
  type AutoscaleInfo,
  type DeepPartial,
  type ChartOptions,
  type IChartApi,
  type IPrimitivePaneRenderer,
  type IPrimitivePaneView,
  type ISeriesApi,
  type ISeriesPrimitive,
  type Logical,
  type SeriesAttachedParameter,
  type SeriesType,
  type Time,
  type UTCTimestamp,
} from "lightweight-charts";
import { useStore, serverNow } from "../store";
import { hm, pnl, usdShort, type TzMode } from "../format";
import { FUT_COLOR, HEDGE_COLOR, INV_COLOR, INVPNL_COLOR, MM_COLOR, S1, S2, SANS } from "../theme";
import { getJSON, type HistBar, type History } from "../api";
import type { Fill, SeriesPoint, Summary } from "../protocol";
import { KV, capAt, chartOptions, quiet, usdFmt } from "./HistoryChart";
import { Panel, SeriesWord, useSeriesToggle } from "./ui";

export { timeAxis, usdTicks, usdAxis } from "./uplotAxes";

const MIN = 60_000;
const DAY_MIN = 1440;
const REFETCH = 60_000;
const HEDGE = HEDGE_COLOR;
const INV = INV_COLOR;
const FUT = FUT_COLOR;
const VOL = "rgba(163,173,189,0.42)";
const VOL_WORD = "#a3adbd";

interface Row {
  t: number; // minute start, ms
  day: number | null;
  trading: number | null;
  mm: number | null;
  invPnl: number | null; // trading − mm
  hedge: number | null;
  inv: number | null;
  fut: number | null;
  vol: number;
}

const minute = (ms: number) => Math.floor(ms / MIN) * MIN;
const ts = (ms: number) => Math.floor(ms / 1000) as UTCTimestamp;

function emptyRow(t: number): Row {
  return { t, day: null, trading: null, mm: null, invPnl: null, hedge: null, inv: null, fut: null, vol: 0 };
}
function fromBar(b: HistBar): Row {
  return { t: b.t, day: b.c, trading: b.pi, mm: b.mm, invPnl: b.pi != null && b.mm != null ? b.pi - b.mm : null, hedge: b.hedge, inv: b.inventory, fut: b.futures, vol: b.volume };
}
/** The live series is the desk's own 5 s grid: its last point in a minute sets that minute's lines. */
function applyPoint(r: Row, p: SeriesPoint) {
  r.day = p.pnl_day;
  if (p.trading != null) r.trading = p.trading;
  r.inv = p.inventory;
  r.fut = p.futures_notional;
}

/** All of today's minute rows: history bars, overlaid by the live series, with fills after the last bar. */
function buildRows(dayStart: number, bars: HistBar[], series: SeriesPoint[], fills: Fill[]): Map<number, Row> {
  const rows = new Map<number, Row>();
  for (const b of bars) if (b.t >= dayStart) rows.set(b.t, fromBar(b));
  for (const p of series) {
    if (p.t < dayStart) continue;
    const m = minute(p.t);
    let r = rows.get(m);
    if (!r) rows.set(m, (r = emptyRow(m)));
    applyPoint(r, p);
  }
  addFills(rows, bars, dayStart, fills);
  return new Map([...rows.entries()].sort((a, b) => a[0] - b[0]));
}

/** Notional filled per minute from the fills tape, for minutes the last history fetch has not covered. */
function addFills(rows: Map<number, Row>, bars: HistBar[], dayStart: number, fills: Fill[]) {
  const lastBar = bars.length ? bars[bars.length - 1]!.t : dayStart - MIN;
  const sums = new Map<number, number>();
  for (const f of fills) {
    if (f.ts < dayStart) continue;
    const m = minute(f.ts);
    if (m < lastBar) continue;
    sums.set(m, (sums.get(m) ?? 0) + f.price * f.qty);
  }
  for (const [m, v] of sums) {
    let r = rows.get(m);
    if (!r) rows.set(m, (r = emptyRow(m)));
    r.vol = m === lastBar ? Math.max(r.vol, v) : v;
  }
}

// ---- session bands and event hairlines, under the series ----
class SessionBands implements ISeriesPrimitive<Time> {
  private chart: IChartApi | null = null;
  private request: (() => void) | null = null;
  private sm: Summary | undefined;
  constructor(private labels: boolean) {}
  // bands and hairlines under the grid; labels above it, so an hour line never cuts through a name
  private view: IPrimitivePaneView = { zOrder: () => "bottom", renderer: () => this.renderer(false) };
  private labelView: IPrimitivePaneView = { zOrder: () => "normal", renderer: () => this.renderer(true) };
  private renderer(labelsOnly: boolean): IPrimitivePaneRenderer {
    return {
      draw: (target) => {
        const sm = this.sm;
        const scale = this.chart?.timeScale();
        if (!sm || !scale) return;
        // index 0 is the day start minute: the axis series holds every minute of the day. Fractional
        // logicals map to 0, so step back half a bar from the minute's centre instead.
        const half = scale.options().barSpacing / 2;
        const x = (ms: number) => {
          const c = scale.logicalToCoordinate(Math.round((ms - sm.day_start) / MIN) as Logical);
          return c == null ? null : c - half;
        };
        target.useBitmapCoordinateSpace(({ context: ctx, bitmapSize, horizontalPixelRatio: hpr, verticalPixelRatio: vpr }) => {
          ctx.font = `${10 * vpr}px ${SANS}`;
          ctx.textBaseline = "top";
          sm.sessions.forEach((s, i) => {
            const x0 = x(s.start);
            const x1 = x(s.end);
            if (x0 == null || x1 == null) return;
            const a = Math.round(x0 * hpr);
            const b = Math.round(x1 * hpr);
            if (!labelsOnly) {
              ctx.fillStyle = i % 2 === 0 ? "rgba(163,173,189,0.055)" : "rgba(163,173,189,0.025)";
              ctx.fillRect(a, 0, b - a, bitmapSize.height);
              return;
            }
            if (!this.labels) return;
            const l = Math.max(a, 0) + 5 * hpr;
            const r = Math.min(b, bitmapSize.width);
            if (r - l < ctx.measureText(s.name).width + 6 * hpr) return;
            ctx.fillStyle = "rgba(138,148,165,0.7)";
            ctx.fillText(s.name, l, 4 * vpr);
          });
          if (labelsOnly) return;
          ctx.fillStyle = "rgba(163,173,189,0.22)";
          const w = Math.max(1, Math.floor(hpr));
          for (const e of sm.events) {
            const ex = x(e.at);
            if (ex == null) continue;
            ctx.fillRect(Math.round(ex * hpr - w / 2), 0, w, bitmapSize.height);
          }
        });
      },
    };
  }
  attached(p: SeriesAttachedParameter<Time, SeriesType>) {
    this.chart = p.chart as IChartApi;
    this.request = p.requestUpdate;
  }
  detached() {
    this.chart = null;
    this.request = null;
  }
  paneViews() {
    return [this.view, this.labelView];
  }
  set(sm: Summary | undefined) {
    this.sm = sm;
    this.request?.();
  }
}

function options(tz: TzMode): DeepPartial<ChartOptions> {
  const o = chartOptions(tz, 60);
  return {
    ...o,
    timeScale: { ...o.timeScale, rightOffset: 0, tickMarkFormatter: (t: Time) => hm((t as number) * 1000, tz) },
    localization: { timeFormatter: (t: Time) => hm((t as number) * 1000, tz) },
  };
}

type Line = ISeriesApi<"Line">;
interface Series {
  axis: Line;
  day: Line;
  trading: Line;
  mm: Line;
  invPnl: Line;
  hedge: Line;
  vol: ISeriesApi<"Histogram">;
  inv: Line;
  fut: Line;
  bands: SessionBands[];
}

export function DayChart() {
  const summary = useStore((s) => s.snap?.summary);
  const series = useStore((s) => s.snap?.series);
  const fills = useStore((s) => s.snap?.fills);
  const dayStart = summary?.day_start ?? 0;
  const tz = useStore((s) => s.tz);
  const [full, setFull] = useState(false);
  const [bars, setBars] = useState<{ dayStart: number; bars: HistBar[] } | null>(null);
  const [hover, setHover] = useState<number | null>(null);

  const host = useRef<HTMLDivElement>(null);
  const chart = useRef<IChartApi | null>(null);
  const s = useRef<Series | null>(null);
  const rows = useRef(new Map<number, Row>());
  const volCap = useRef<number | null>(null); // the volume scale ignores the odd huge minute
  const applied = useRef(0); // last minute pushed to the chart, ms
  const userView = useRef(false); // the user zoomed or scrolled: stop following the default view
  const fullRef = useRef(full);
  fullRef.current = full;

  const defaultView = () => {
    const c = chart.current;
    if (!c || !dayStart) return;
    const last = (applied.current - dayStart) / MIN;
    const to = fullRef.current || applied.current < dayStart ? DAY_MIN - 0.5 : last + 2;
    c.timeScale().setVisibleLogicalRange({ from: -0.5 - to * 0.012, to });
  };

  // ---- mount ----
  useEffect(() => {
    const el = host.current!;
    const c = createChart(el, options(tz));
    chart.current = c;
    c.subscribeCrosshairMove((p) => setHover(p.time == null ? null : (p.time as number) * 1000));
    const axis = c.addSeries(LineSeries, { visible: false, ...quiet });
    const line = (color: string, pane: number, width: 1 | 2 = 1) =>
      c.addSeries(LineSeries, { color, lineWidth: width, priceFormat: usdFmt, crosshairMarkerRadius: 2.5, ...quiet }, pane);
    const invPnl = line(INVPNL_COLOR, 0);
    const mm = line(MM_COLOR, 0);
    const hedge = line(HEDGE, 0);
    const trading = line(S2, 0, 2);
    const day = line(S1, 0, 2);
    // the zero line on every P&L line, so it stays while any of them is shown
    for (const x of [invPnl, mm, hedge, trading, day])
      x.createPriceLine({ price: 0, color: "#4a5870", lineWidth: 1, lineStyle: LineStyle.Solid, axisLabelVisible: false });
    day.priceScale().applyOptions({ scaleMargins: { top: 0.16, bottom: 0.06 } });
    const vol = c.addSeries(
      HistogramSeries,
      {
        color: VOL,
        priceFormat: usdFmt,
        ...quiet,
        autoscaleInfoProvider: (orig: () => AutoscaleInfo | null) => {
          const r = orig();
          return r && volCap.current != null && r.priceRange && r.priceRange.maxValue > volCap.current
            ? { ...r, priceRange: { minValue: 0, maxValue: volCap.current } }
            : r;
        },
      },
      1,
    );
    vol.priceScale().applyOptions({ scaleMargins: { top: 0.15, bottom: 0 } });
    const inv = line(INV, 2);
    const fut = line(FUT, 2);
    inv.priceScale().applyOptions({ scaleMargins: { top: 0.15, bottom: 0.1 } });
    const panes = c.panes();
    panes[0]!.setStretchFactor(4.5);
    panes[1]!.setStretchFactor(1);
    panes[2]!.setStretchFactor(1.2);
    const bands = [day, vol, inv].map((x, i) => {
      const p = new SessionBands(i === 0);
      x.attachPrimitive(p);
      return p;
    });
    s.current = { axis, day, trading, mm, invPnl, hedge, vol, inv, fut, bands };

    const touched = () => (userView.current = true);
    const drag = (e: PointerEvent) => e.buttons && touched();
    const reset = () => {
      userView.current = false;
      c.panes().forEach((_, i) => c.priceScale("right", i).applyOptions({ autoScale: true }));
      defaultView();
    };
    el.addEventListener("wheel", touched, { capture: true, passive: true });
    el.addEventListener("pointermove", drag, { capture: true });
    el.addEventListener("dblclick", reset);
    const ro = new ResizeObserver(() => userView.current || requestAnimationFrame(defaultView));
    ro.observe(el);
    return () => {
      ro.disconnect();
      el.removeEventListener("wheel", touched, { capture: true });
      el.removeEventListener("pointermove", drag, { capture: true });
      el.removeEventListener("dblclick", reset);
      c.remove();
      chart.current = null;
      s.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    chart.current?.applyOptions(options(tz));
  }, [tz]);

  // ---- history: today so far at one minute, every minute ----
  useEffect(() => {
    if (!dayStart) return;
    const ac = new AbortController();
    const load = () =>
      getJSON<History>("/api/history", { from: dayStart, to: serverNow(), step: 60 }, ac.signal)
        .then((h) => setBars({ dayStart, bars: h.bars }))
        .catch(() => {});
    load();
    const id = setInterval(load, REFETCH);
    return () => {
      clearInterval(id);
      ac.abort();
    };
  }, [dayStart]);

  // session bands follow the summary
  useEffect(() => {
    s.current?.bands.forEach((b) => b.set(summary));
  }, [summary]);

  // ---- full rebuild: on a history fetch or a new day ----
  const histBars = bars && bars.dayStart === dayStart ? bars.bars : null;
  useEffect(() => {
    const x = s.current;
    if (!x || !dayStart) return;
    const st = useStore.getState().snap;
    const r = buildRows(dayStart, histBars ?? [], st?.series ?? [], st?.fills ?? []);
    rows.current = r;
    const list = [...r.values()];
    x.axis.setData(Array.from({ length: DAY_MIN }, (_, i) => ({ time: ts(dayStart + i * MIN) })));
    const ln = (k: "day" | "trading" | "mm" | "invPnl" | "hedge" | "inv" | "fut") =>
      list.flatMap((w) => (w[k] == null ? [] : [{ time: ts(w.t), value: w[k]! }]));
    x.day.setData(ln("day"));
    x.trading.setData(ln("trading"));
    x.mm.setData(ln("mm"));
    x.invPnl.setData(ln("invPnl"));
    x.hedge.setData(ln("hedge"));
    x.inv.setData(ln("inv"));
    x.fut.setData(ln("fut"));
    volCap.current = capAt(list.map((w) => w.vol));
    x.vol.setData(list.map((w) => ({ time: ts(w.t), value: w.vol })));
    applied.current = list.length ? list[list.length - 1]!.t : dayStart - MIN;
    x.bands.forEach((b) => b.set(useStore.getState().snap?.summary));
    if (!userView.current) defaultView();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [histBars, dayStart, !!series]);

  // ---- live: the 5 s series and the fills tape move the current minute ----
  useEffect(() => {
    const x = s.current;
    if (!x || !dayStart || !series?.length) return;
    const from = applied.current;
    const touchedRows = new Map<number, Row>();
    for (let i = series.length - 1; i >= 0 && series[i]!.t >= from; i--) {
      const p = series[i]!;
      const m = minute(p.t);
      if (touchedRows.has(m)) continue; // later point of the same minute already applied
      const r = rows.current.get(m) ?? emptyRow(m);
      applyPoint(r, p);
      rows.current.set(m, r);
      touchedRows.set(m, r);
    }
    // the fills tape fills in volume after the last history bar
    const lastBar = histBars?.length ? histBars[histBars.length - 1]! : null;
    const sums = new Map<number, number>();
    for (const f of fills ?? []) {
      if (f.ts < from) break; // newest first
      const m = minute(f.ts);
      sums.set(m, (sums.get(m) ?? 0) + f.price * f.qty);
    }
    for (const [m, v] of sums) {
      const r = rows.current.get(m) ?? emptyRow(m);
      r.vol = lastBar && m === lastBar.t ? Math.max(lastBar.volume, v) : v;
      rows.current.set(m, r);
      touchedRows.set(m, r);
    }
    const prev = applied.current;
    for (const r of [...touchedRows.values()].sort((a, b) => a.t - b.t)) {
      if (r.t < applied.current) continue;
      const time = ts(r.t);
      if (r.day != null) x.day.update({ time, value: r.day });
      if (r.trading != null) x.trading.update({ time, value: r.trading });
      if (r.inv != null) x.inv.update({ time, value: r.inv });
      if (r.fut != null) x.fut.update({ time, value: r.fut });
      x.vol.update({ time, value: r.vol });
      applied.current = r.t;
    }
    if (applied.current !== prev && !userView.current) defaultView();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [series, fills]);

  const r = hover != null ? rows.current.get(hover) : undefined;
  const list = [...rows.current.values()];
  const has = (k: "mm" | "hedge") => list.some((w) => w[k] != null);
  const words: [string, string][] = [
    ["Day PnL", S1],
    ["Trading PnL", S2],
    ...(has("mm") ? [["Market making", MM_COLOR] as [string, string], ["Inventory PnL", INVPNL_COLOR] as [string, string]] : []),
    ...(has("hedge") ? [["Hedge", HEDGE] as [string, string]] : []),
    ["Volume", VOL_WORD],
    ["Inventory", INV],
    ["Futures", FUT],
  ];
  const tog = useSeriesToggle("day", words.map(([w]) => w));
  const shown = (name: string) => !tog.off(name);

  // legend words show and hide series; each price axis rescales to what is shown
  const hiddenKey = tog.hidden.join("|");
  useEffect(() => {
    const x = s.current;
    const c = chart.current;
    if (!x || !c) return;
    const by: Record<string, { applyOptions: (o: { visible: boolean }) => void }> = {
      "Day PnL": x.day,
      "Trading PnL": x.trading,
      "Market making": x.mm,
      "Inventory PnL": x.invPnl,
      Hedge: x.hedge,
      Volume: x.vol,
      Inventory: x.inv,
      Futures: x.fut,
    };
    for (const [name, ser] of Object.entries(by)) ser.applyOptions({ visible: !tog.hidden.includes(name) });
    // a pane with nothing shown folds away
    const off = (...n: string[]) => n.every((x) => tog.hidden.includes(x));
    const panes = c.panes();
    panes[1]?.setStretchFactor(off("Volume") ? 0.001 : 1);
    panes[2]?.setStretchFactor(off("Inventory", "Futures") ? 0.001 : 1.2);
    panes.forEach((_, i) => c.priceScale("right", i).applyOptions({ autoScale: true }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hiddenKey]);

  // a view toggle returns to the default view
  useEffect(() => {
    userView.current = false;
    defaultView();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [full]);


  return (
    <Panel
      className="day-panel"
      title={
        <span
          title={
            "Day PnL: equity change since the day start, net of transfers. " +
            "Trading PnL: market making plus inventory PnL. Market making: each fill against the mid 60 s later, minus fees. " +
            "Inventory PnL: trading PnL minus market making. Volume: notional filled per minute. " +
            "Inventory and futures: notional. Double-click the chart to reset the view."
          }
        >
          The day <span className="title-unit">USDT</span>
        </span>
      }
      right={
        <>
          <div className="legend">
            {words.map(([w, c]) => (
              <SeriesWord key={w} name={w} color={c} t={tog} />
            ))}
          </div>
          <UnstyledButton className="tz-toggle" onClick={() => setFull(!full)} title="Show the whole day or only the part with data">
            <span className={full ? "" : "on"}>so far</span>
            <span className={full ? "on" : ""}>24h</span>
          </UnstyledButton>
        </>
      }
      bodyClass="chart-body"
    >
      <div style={{ position: "relative", flex: 1, minHeight: 0 }}>
        <div ref={host} style={{ position: "absolute", inset: 0 }} />
        {r && (
          <div className="hist-legend fig" style={{ background: "rgba(7,9,12,0.88)", padding: "0 6px", left: 2, top: 2 }}>
            <div className="hl-row">
              <span className="hl-time">{hm(r.t, tz)}</span>
              {shown("Day PnL") && <KV k="Day PnL" color={S1}>{pnl(r.day)}</KV>}
              {shown("Trading PnL") && <KV k="Trading PnL" color={S2}>{pnl(r.trading)}</KV>}
              {r.mm != null && shown("Market making") && <KV k="Market making" color={MM_COLOR}>{pnl(r.mm)}</KV>}
              {r.invPnl != null && shown("Inventory PnL") && <KV k="Inventory PnL" color={INVPNL_COLOR}>{pnl(r.invPnl)}</KV>}
              {r.hedge != null && shown("Hedge") && <KV k="Hedge" color={HEDGE}>{pnl(r.hedge)}</KV>}
              {shown("Volume") && <KV k="Volume" color={VOL_WORD}>{usdShort(r.vol)}</KV>}
              {shown("Inventory") && <KV k="Inventory" color={INV}>{usdShort(r.inv)}</KV>}
              {shown("Futures") && <KV k="Futures" color={FUT}>{usdShort(r.fut)}</KV>}
            </div>
          </div>
        )}
      </div>
    </Panel>
  );
}
