// The Desk's centre chart with nothing picked: tabs P&L | Equity | Exposure on ExChart. Today from the snapshot
// (minute bars, 5 s on Line), the days before from /api/history at the interval, arriving behind the view (past.ts);
// Day PnL and its parts restart at each day start, marked by a faint rule. The view opens on today. The legend
// names the lines at rest (the header has the figures) and reads a hovered bar. What is drawn splits at today:
// the days before are built once per load, however many, and only today's bars are built again on a tick.
import { useMemo, useRef, type ReactNode } from "react";
import { serverNow, useStore } from "../../store";
import { compact, num, pnl } from "../../format";
import { ACCOUNT_SERIES, C, FUT_COLOR, INV_COLOR, PNL_COLORS, PNL_STROKES } from "../../theme";
import { ExChart, GAP, Tabs, TextToggle, rgba, useExPref, type ExLegendItem, type ExOhlc, type ExPoint, type ExSeries } from "../../components/ex";
import { MIN, Stable, accountOnGrid, bucket, liveRows, todayRows, sameOhlc, sameValue, type Row } from "./model";
import { rebatesAt, useTodayMinutes, withFills } from "./pnlData";
import { dayEnds, pastStep, usePast, type DayOffset } from "./past";
import { maskFormat, maskText, useHide } from "../../mask";
import { roled, useDesk, notionalCur } from "../../desk";

type Tab = "pnl" | "equity" | "exposure";
const TABS: { value: Tab; label: string; title: string }[] = [
  { value: "pnl", label: "P&L", title: "Day PnL and its parts, notional filled" },
  { value: "equity", label: "Equity", title: "Equity of all accounts, and each account's Day PnL" },
  { value: "exposure", label: "Exposure", title: "Inventory value, hedge notional and the net" },
];

const IVS = [
  { value: "line", label: "5s", title: "Every 5 s sample, no bars" },
  { value: "1m", label: "1m" },
  { value: "5m", label: "5m" },
  { value: "15m", label: "15m" },
  { value: "1h", label: "1H" },
  { value: "4h", label: "4H" },
  { value: "1d", label: "1D" },
];
const IV_VALUES = IVS.map((i) => i.value);
const STEP: Record<string, number> = { line: 0, "1m": MIN, "5m": 5 * MIN, "15m": 15 * MIN, "1h": 60 * MIN, "4h": 240 * MIN, "1d": 1440 * MIN };
const STYLE = [
  { value: "area", label: "Area" },
  { value: "candles", label: "Candles" },
];

const VOL = rgba(C.ink2, 0.38);
const NO_ENDS = new Set<number>();
const NO_ROWS: Row[] = [];
const NET = C.ink;

/** One series' points: the head built once per `head` array, the tail each tick, joined only when either changed. */
class Joined {
  private m = new Map<string, { src: Row[]; head: object[]; tail: object[] | null; out: object[] | null }>();
  constructor(private stable: Stable) {}
  get<T extends { time: number }>(key: string, head: Row[], tail: Row[], f: (r: Row) => T, same: (a: T, b: T) => boolean): T[] {
    let e = this.m.get(key);
    if (!e || e.src !== head) this.m.set(key, (e = { src: head, head: head.map(f), tail: null, out: null }));
    const t = this.stable.get(key, tail.map(f), same);
    if (e.tail !== t || !e.out) {
      e.tail = t;
      e.out = e.head.length ? e.head.concat(t) : t;
    }
    return e.out as T[];
  }
}

export function DeskChart({ head }: { head?: ReactNode }) {
  const [tab, setTab] = useExPref<Tab>("desk", "tab", "pnl", ["pnl", "equity", "exposure"]);
  const hide = useHide();
  return (
    <section className="dk-panel dk-centre">
      <div className="dk-head">
        <Tabs items={TABS} value={tab} onChange={setTab} />
        {head}
      </div>
      <DeskSeriesChart key={tab} tab={tab} hide={hide} />
    </section>
  );
}

function DeskSeriesChart({ tab, hide }: { tab: Tab; hide: boolean }) {
  const id = "desk." + tab;
  const [iv, setIv] = useExPref<string>(id, "interval", "1m", IV_VALUES);
  const [style, setStyle] = useExPref<string>("desk.pnl", "style", "area", ["area", "candles"]);
  const [part, setPart] = useExPref<string>("desk.pnl", "part", "mm", ["trading", "mm", "inv", "hedge", "reb"]);
  const bars = useStore((s) => s.snap?.bars);
  const series = useStore((s) => s.snap?.series);
  const fills = useStore((s) => s.snap?.fills);
  const accSeries = useStore((s) => (tab === "equity" ? s.snap?.account_series : undefined));
  const dayStart = useStore((s) => s.snap?.summary.day_start ?? 0);
  const exposure = useStore((s) => (tab === "exposure" ? s.snap?.exposure : undefined));
  const step = STEP[iv] ?? MIN;
  const desk = useDesk();
  const stable = useRef(new Stable()).current;
  const joined = useRef(new Joined(stable)).current;
  // today's rebates and fill counts by minute (the snapshot's minute bars do not carry them)
  const mins = useTodayMinutes(tab === "pnl" ? dayStart : null);
  // the days before today at the interval (Line: minutes)
  const past = usePast(pastStep(step), dayStart);

  // today's minute rows (the volume pane at every interval), and the 5 s rows for Line; the past days before
  const minRows = useMemo(() => withFills(todayRows(bars, series, fills, dayStart, MIN), mins), [bars, series, fills, dayStart, mins]);
  const built = useMemo(
    () => (step === 0 ? todayRows(bars, series, fills, dayStart, 0) : bucket(minRows, step)),
    [step, minRows, bars, series, fills, dayStart],
  );
  // the forming bar follows the figures above the chart (8 a second), between the 5 s points and the minute bars
  const livePnl = useStore((s) => s.snap?.summary.pnl_day ?? null);
  const liveEq = useStore((s) => s.snap?.summary.equity ?? null);
  const liveTr = useStore((s) => s.snap?.summary.pnl.trading ?? null);
  const liveMm = useStore((s) => s.snap?.summary.pnl.quoting ?? null);
  const liveHedge = useStore((s) => s.snap?.exposure.hedge_day?.hedge_pnl ?? null);
  const today = useMemo(
    () => liveRows(built, { pnl: livePnl, equity: liveEq, trading: liveTr, mm: liveMm, hedge: liveHedge }, dayStart, step, serverNow()),
    [built, livePnl, liveEq, liveTr, liveMm, liveHedge, dayStart, step],
  );
  // each day from 0, as the phone's Desk: the Desk is today's P&L (History has the running total over the days)
  const offAt = null as ((t: number) => DayOffset) | null | undefined;
  // until the closes are in, nothing: the day's own figures first would jump to the running ones a moment later
  const head = useMemo(() => (offAt === undefined ? NO_ROWS : offAt ? past.rows.map((r) => runOn(r, offAt(r.t))) : past.rows), [past.rows, offAt]);
  const tail = useMemo(() => (offAt === undefined ? NO_ROWS : offAt ? today.map((r) => runOn(r, offAt(r.t))) : today), [today, offAt]);
  const rows = useMemo(() => (head.length ? head.concat(tail) : tail), [head, tail]);
  // the volume pane's bars: minutes under the 5 s Line, else the chart's own
  const volTail = step === 0 ? minRows : tail;
  const pastByT = useMemo(() => new Map(past.rows.map((r) => [r.t, r])), [past.rows]);
  const volByT = useMemo(() => new Map(volTail.map((r) => [r.t, r])), [volTail]);

  // the axis, tags and legend read ••• with Hide amounts (ExChart re-reads a format that prints otherwise)
  const money = (f: (v: number) => string) => maskFormat(hide, f);
  const fPnl = money(pnl);
  const fBig = money((v) => compact(v));
  // exposure is signed (long +, short −), on the axis, the tags and the legend
  const fSigned = money((v) => compact(v, 2, true));
  // P&L lines stop at each day's last bar: the figures restart at 0 with the next day (step < 1 day)
  const ends = useMemo(() => (tab === "pnl" && !offAt && step < 1440 * MIN ? dayEnds(rows.map((r) => r.t), dayStart) : NO_ENDS), [tab, offAt, step, rows, dayStart]);
  const pts = (k: string, pick: (r: Row) => number | null, h: Row[] = head, t: Row[] = tail) =>
    joined.get<ExPoint>(k + iv, h, t, (r) => (ends.has(r.t) ? { time: r.t, value: pick(r), color: GAP } : { time: r.t, value: pick(r) }), sameValue);

  const vol: ExSeries = {
    key: "vol",
    kind: "histogram",
    label: `Vol(${notionalCur()})`,
    color: VOL,
    pane: 1,
    data: pts("vol", (r) => r.vol, step === 0 ? past.rows : head, volTail),
    format: fBig,
    lastValue: false,
    // on Line the bars are 5 s and the volume minutes: its legend reads the minute of the bar (below)
    legend: step === 0 ? false : undefined,
  };
  const volAt = (t: number) => {
    const m = step === 0 ? Math.floor(t / MIN) * MIN : t;
    return volByT.get(m) ?? pastByT.get(m);
  };
  const volLegend: ExLegendItem[] =
    step === 0 && tab !== "equity" && tab !== "exposure"
      ? [{ pane: 1, key: "vol", label: `Vol(${notionalCur()})`, value: (t) => { const r = volAt(t); return r ? [fBig(r.vol), C.ink] : "--"; } }]
      : [];

  let list: ExSeries[];
  let parts: ExSeries[] = [];
  let selectedPart: ExSeries | undefined;
  let extra: ExLegendItem[] = [];
  let stretch = [1, 0.22];
  if (tab === "pnl") {
    const dayLabel = offAt !== null ? "Cumulative PnL" : "Day PnL";
    const day: ExSeries =
      style === "candles"
        ? {
            key: "day",
            kind: "candles",
            label: dayLabel,
            toggle: false,
            format: fPnl,
            data: joined.get<ExOhlc>("dayc" + iv, head, tail, (r) => ({ time: r.t, open: r.o, high: r.h, low: r.l, close: r.c }), sameOhlc),
          }
        : { key: "day", kind: "baseline", label: dayLabel, toggle: false, format: fPnl, signColor: true, data: pts("day", (r) => r.c) };
    const has = (k: "mm" | "hedge") => (k === "mm" ? desk.mm : desk.hedge) && (tail.some((r) => r[k] != null) || head.some((r) => r[k] != null));
    // rebates at a row: the last minute's figure inside it; Other is what the parts leave of Day PnL
    const rebAt = (r: Row) => {
      if (!desk.rebates) return 0;
      if (r.reb !== undefined) return r.reb;
      if (r.t < dayStart) return null;
      const v = rebatesAt(mins, r.t, step);
      return v == null ? null : v + (offAt ? offAt(r.t).reb : 0);
    };
    // Other reads against the rebates, so it needs their history; a desk with none has nothing to wait for
    const anyReb = !desk.rebates || mins.reb.t.length > 0 || past.rows.some((r) => r.reb != null);
    const P = PNL_COLORS;
    const S = PNL_STROKES;
    parts = [
      // market making and inventory PnL, not their sum: the trading P&L only where the desk keeps no split
      ...(has("mm")
        ? [
            { key: "mm", kind: "line", pane: 1, label: "Market making", color: P.mm, lineStyle: S.mm, width: 1.5, format: fPnl, signColor: false, margins: { top: 0.12, bottom: 0.08 }, data: pts("mm", (r) => r.mm) } as ExSeries,
            { key: "inv", kind: "line", pane: 1, label: "Inventory PnL", color: P.inv, lineStyle: S.inv, width: 1.5, format: fPnl, data: pts("invp", (r) => (r.trading != null && r.mm != null ? r.trading - r.mm : null)) } as ExSeries,
          ]
        : [{ key: "trading", kind: "line", pane: 1, label: "Trading", color: P.trading, width: 1.5, format: fPnl, signColor: false, margins: { top: 0.12, bottom: 0.08 }, data: pts("trading", (r) => r.trading) } as ExSeries]),
      ...(has("hedge") ? [{ key: "hedge", kind: "line", pane: 1, label: "Hedge", color: P.hedge, width: 1.5, lineStyle: S.hedge, format: fPnl, data: pts("hedge", (r) => r.hedge) } as ExSeries] : []),
      ...(desk.rebates && anyReb ? [{ key: "reb", kind: "line", pane: 1, label: "Rebates", color: P.reb, width: 1.5, lineStyle: S.reb, format: fPnl, data: pts("reb", rebAt) } as ExSeries] : []),
    ];
    selectedPart = parts.find((s) => s.key === part) ?? parts[0]!;
    // Each component fits its own visible range, without larger components flattening it.
    list = [
      day,
      { ...selectedPart, width: 2, lineStyle: "solid", toggle: false, lastValue: true, margins: { top: 0.22, bottom: 0.12 } },
      { ...vol, pane: 2 },
    ];
    stretch = [1, 0.8, 0.2];
    extra = [
      ...volLegend.map((x) => ({ ...x, pane: 2 })),
      {
        pane: 2,
        label: "Fills",
        color: C.ink2,
        value: (t) => {
          const n = volAt(t)?.fills;
          return n == null ? "--" : String(n);
        },
      },
    ];
  } else if (tab === "equity") {
    list = [{ key: "equity", kind: "area", label: "Equity", color: C.ink2, format: money((v) => num(v, 2)), data: pts("equity", (r) => r.equity), margins: { top: 0.2, bottom: 0.1 } }];
    (accSeries ?? []).forEach((a, i) => {
      list.push({
        key: "acc:" + a.account,
        kind: "line",
        label: a.account,
        color: ACCOUNT_SERIES[i % ACCOUNT_SERIES.length],
        pane: 1,
        width: 1,
        format: fPnl,
        lastValue: false,
        // on the main pane's bar times: the legend then has each account's value at every bar, at rest too
        // today's only: blank over the days before
        data: pts("acc" + a.account, ((byT) => (r: Row) => byT.get(r.t) ?? null)(new Map(accountOnGrid(a, tail, dayStart).map((p) => [p.time, p.value])))),
      });
    });
    stretch = [1, 0.6];
  } else {
    list = [
      { key: "net", kind: "line", label: "Net", color: NET, width: 1.5, format: fSigned, data: pts("net", (r) => r.inv + r.fut) },
      ...(desk.hedge
        ? ([
            { key: "spot", kind: "line", label: roled() ? "Inventory" : "Spot", color: INV_COLOR, width: 1, format: fSigned, data: pts("spot", (r) => r.inv), lastValue: false },
            { key: "fut", kind: "line", label: "Futures", color: FUT_COLOR, width: 1, format: fSigned, data: pts("fut", (r) => r.fut), lastValue: false },
          ] as ExSeries[])
        : []),
    ];
    const x = exposure;
    if (x?.gap != null)
      extra = [
        {
          label: "Gap now",
          title: "Exposure gap: the hedge target minus the hedge symbols' futures notional; the band is its allowed size",
          value: () => [maskText(hide, `${pnl(x.gap)} / ±${num(x.band, 0)}`), x.band != null && Math.abs(x.gap!) > x.band ? C.warn : C.ink2],
        },
      ];
  }

  // a few wide bars get one bar of room after the last, not five
  const right = step >= 15 * MIN ? 1 : step >= 5 * MIN ? 2 : undefined;

  return (
    <>
      {tab === "pnl" && (
        <div className="dk-pnl-parts">
          <span className="dk-pnl-parts-label">Breakdown</span>
          <TextToggle
            label="P&L breakdown"
            options={parts.map((s) => ({ value: s.key, label: s.label }))}
            value={selectedPart?.key ?? parts[0]?.key ?? "mm"}
            onChange={setPart}
          />
        </div>
      )}
      <ExChart
        id={id}
        className="dk-chart"
        fill
        title={tab === "pnl" ? "Desk PnL" : tab === "equity" ? "Desk equity" : "Desk exposure"}
        series={list}
        paneStretch={stretch}
        intervals={IVS}
        interval={iv}
        onInterval={setIv}
        modes={tab === "pnl" ? [{ label: "Style", value: style, onChange: setStyle, options: STYLE }] : []}
        legendExtra={extra}
        legendRest="names"
        fullscreen
        rightOffset={right}
        // the view opens on today; the days before are a pan (or a zoom) away
        initialBars={Math.max(today.length, 30)}
        dividers={step < 1440 * MIN ? past.days : undefined}
        onNearStart={past.loadOlder}
        // fitted again when the days before first come in under today's bars
        resetKey={past.rows.length > 0 ? "past" : "today"}
        emptyText="No data yet today"
        style={{ flex: 1, minHeight: 0 }}
      />
    </>
  );
}

/** A row's P&L figures run on from the earlier days' closes (`o`). */
function runOn(r: Row, o: DayOffset): Row {
  const add = (v: number | null | undefined, d: number) => (v == null ? v : v + d);
  return {
    ...r,
    o: r.o + o.c,
    h: r.h + o.c,
    l: r.l + o.c,
    c: r.c + o.c,
    trading: add(r.trading, o.trading) ?? null,
    mm: add(r.mm, o.mm) ?? null,
    hedge: add(r.hedge, o.hedge) ?? null,
    reb: r.reb === undefined ? undefined : add(r.reb, o.reb),
  };
}
