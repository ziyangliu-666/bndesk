// The phone Desk's chart, the desktop's three views as the toolbar's own tabs: P&L | Equity | Exposure, the
// interval behind one menu beside them. P&L is the day's P&L (a baseline at zero for Line, candles for 1m 5m 15m
// 1H) with the split as lines in the desktop's palette and strokes, notional filled in a volume pane. Each day
// starts again at zero, a faint rule between days: the axis tag is today's P&L, never a running total over the
// days. Today from the store; the days before from /api/history, arriving behind the view (desk/past.ts), built
// once per load and only today's bars each tick. Long-press reads a bar, ⤢ opens #/chart/m-desk.
import { useMemo, useRef, type ReactNode } from "react";
import { compact, num, pnl } from "../../../format";
import { ExChart, TextToggle, useExPref, type ExPoint, type ExSeries } from "../../../components/ex";
import { C, PNL_COLORS as P, PNL_STROKES as S, rgba } from "../../../components/ex/palette";
import { INV_COLOR, FUT_COLOR } from "../../../theme";
import { useLive } from "../../../components/mobile";
import { useStore } from "../../../store";
import { maskFormat } from "../../../mask";
import { useTodayMinutes } from "../../desk/pnlData";
import { MIN, bucket, todayRows, type Row } from "../../desk/model";
import { PAST_BARS_PHONE, dayEnds, pastStep, usePast } from "../../desk/past";
import { PNL_STEP, histBars, joinChart, todayBars, toChart, type PnlData, type PnlIv } from "./pnl";
import { useDesk, notionalCur, roled } from "../../../desk";

type Tab = "pnl" | "equity" | "exposure";
const TABS: { value: Tab; label: string }[] = [
  { value: "pnl", label: "P&L" },
  { value: "equity", label: "Equity" },
  { value: "exposure", label: "Exposure" },
];

const IVS: { value: PnlIv; label: string }[] = [
  { value: "line", label: "Line" },
  { value: "1m", label: "1m" },
  { value: "5m", label: "5m" },
  { value: "15m", label: "15m" },
  { value: "1h", label: "1H" },
];
// bars in view after a load at most: the last two hours or so at 1m and 5m; else the day so far
const VIEW: Record<PnlIv, number | undefined> = { line: undefined, "1m": 90, "5m": 96, "15m": undefined, "1h": undefined };
const VOL = rgba(C.ink2, 0.38);
const NO_ROWS: Row[] = [];

/** The Desk chart. `ms`: how often it takes the store's figures (the page's own pace). */
export function DeskChart({ ms }: { ms: number }) {
  const [tab, setTab] = useExPref<Tab>("m-desk", "tab", "pnl", TABS.map((t) => t.value));
  const [iv, setIv] = useExPref<PnlIv>("m-desk", "interval", "line", IVS.map((i) => i.value));
  const tabs = <TextToggle className="dk-ctabs" label="Chart" options={TABS} value={tab} onChange={setTab} />;
  return tab === "pnl" ? <PnlChart ms={ms} iv={iv} setIv={setIv} tabs={tabs} /> : <LevelChart key={tab} tab={tab} ms={ms} iv={iv} setIv={setIv} tabs={tabs} />;
}

type ChartProps = { ms: number; iv: PnlIv; setIv: (v: PnlIv) => void; tabs: ReactNode };

function PnlChart({ ms, iv, setIv, tabs }: ChartProps) {
  const hide = useStore((s) => s.hideAmounts);
  const desk = useDesk();
  const dayStart = useLive((s) => s.snap?.summary.day_start, ms);
  const bars = useLive((s) => s.snap?.bars, ms);
  const series = useLive((s) => s.snap?.series, ms);
  const fills = useLive((s) => s.snap?.fills, ms);
  const step = PNL_STEP[iv];
  // today's rebates and fill counts by minute; the days before at the interval
  const mins = useTodayMinutes(dayStart);
  const past = usePast(pastStep(step), dayStart ?? 0, PAST_BARS_PHONE);

  // the days before, each from its own start: a line stops at each day's last bar (today follows from 0)
  const pastData = useMemo(() => {
    const b = histBars(past.bars);
    const ends = dayEnds([...b.map((x) => x.time), dayStart ?? 0], dayStart ?? 0);
    return toChart(b, iv === "line", null, null, VOL, ends, true);
  }, [past.bars, iv, dayStart]);
  const pastReb = useMemo(() => past.bars.some((b) => b.rebates != null), [past.bars]);

  const prev = useRef<{ k: string; d: PnlData } | null>(null);
  const nToday = useRef(0);
  const todayFirst = useRef<number | "">("");
  const data = useMemo(() => {
    const today = dayStart != null ? todayBars(dayStart, bars, series, fills, step, mins) : [];
    nToday.current = today.length;
    todayFirst.current = today[0]?.time ?? "";
    // the rebates' lines run the whole chart once either side has any
    const reb = pastReb || today.some((b) => b.rebates != null);
    const d = toChart(today, iv === "line", null, prev.current?.k === iv ? prev.current.d : null, VOL, undefined, reb);
    prev.current = { k: iv, d };
    return pastData.bars.length ? joinChart(reb ? pastData : { ...pastData, rebates: [], other: [] }, d) : d;
  }, [dayStart, bars, series, fills, step, pastReb, pastData, iv, mins]);

  // masked with Hide amounts: ExChart re-reads a format that prints otherwise (no remount)
  const money = maskFormat(hide, (v: number) => pnl(v));
  const vol = maskFormat(hide, (v: number) => compact(v));
  // at rest the legend has Day, then market making, inventory, hedge and rebates (with Other they make Day); Other
  // is a chip away. The trading P&L (their first two summed) only where the desk keeps no split
  const line = (key: keyof typeof P, label: string, pts: PnlData["mm"]): ExSeries => ({
    key,
    kind: "line",
    label,
    color: P[key],
    lineStyle: S[key],
    width: 1.5,
    pane: 1,
    margins: { top: 0.12, bottom: 0.08 },
    data: pts,
    format: money,
    signColor: false,
    lastValue: false,
    hiddenByDefault: key === "other",
  });
  const s: ExSeries[] = [
    iv === "line"
      ? { key: "day", kind: "baseline", label: "Day", data: data.main, format: money, signColor: true, toggle: false }
      : { key: "day", kind: "candles", label: "Day", data: data.main, format: money, toggle: false },
    ...(desk.mm ? [line("mm", "MM", data.mm), line("inv", "Inv", data.inv)] : [line("trading", "Trading", data.trading)]),
    ...(desk.hedge ? [line("hedge", "Hedge", data.hedge)] : []),
    ...(desk.rebates && data.rebates.length ? [line("reb", "Rebates", data.rebates)] : []),
    { key: "vol", kind: "histogram", label: `Vol(${notionalCur()})`, pane: 2, color: VOL, data: data.vol, format: vol, lastValue: false },
  ];
  // the view opens on today (and opens again once the first snapshot's earlier minutes and the days before are in)
  const view = Math.max(Math.min(VIEW[iv] ?? Infinity, nToday.current), 30);

  return (
    <ExChart
      id="m-desk"
      title="Desk PnL"
      className="dk-chart"
      series={s}
      paneStretch={[1, 0.5, 0.2]}
      toolbarLeft={tabs}
      moreIntervals={IVS}
      interval={iv}
      onInterval={(v) => setIv(v as PnlIv)}
      emptyText="No P&L yet today"
      height={340}
      initialBars={view}
      resetKey={`${iv}:${todayFirst.current}:${past.bars.length > 0}`}
      dividers={past.days}
      onNearStart={past.loadOlder}
      legendRest="names"
      fullscreen
      touch
      chips={[...s.slice(1, -1).map((x) => ({ key: x.key, label: x.label, color: x.color, stroke: x.lineStyle })), "|", { key: "vol", label: "Vol" }]}
    />
  );
}

/** Equity of all accounts, or the exposure (inventory value, hedge notional, the net): levels, not a day's figure,
 *  so they run on over the days. */
function LevelChart({ tab, ms, iv, setIv, tabs }: ChartProps & { tab: "equity" | "exposure" }) {
  const hide = useStore((s) => s.hideAmounts);
  const desk = useDesk();
  const dayStart = useLive((s) => s.snap?.summary.day_start, ms) ?? 0;
  const bars = useLive((s) => s.snap?.bars, ms);
  const series = useLive((s) => s.snap?.series, ms);
  const fills = useLive((s) => s.snap?.fills, ms);
  const step = PNL_STEP[iv];
  const past = usePast(pastStep(step), dayStart, PAST_BARS_PHONE);
  const today = useMemo(() => (dayStart ? bucket(todayRows(bars, series, fills, dayStart, MIN), step) : NO_ROWS), [bars, series, fills, dayStart, step]);
  const rows = useMemo(() => (past.rows.length ? past.rows.concat(today) : today), [past.rows, today]);
  const pts = (f: (r: Row) => number | null): ExPoint[] => rows.map((r) => ({ time: r.t, value: f(r) }));

  let list: ExSeries[];
  if (tab === "equity") {
    list = [{ key: "equity", kind: "area", label: "Equity", color: C.ink2, format: maskFormat(hide, (v: number) => num(v, 2)), data: pts((r) => r.equity || null), margins: { top: 0.2, bottom: 0.1 }, toggle: false }];
  } else {
    // signed (long +, short −), on the axis, the tags and the legend
    const f = maskFormat(hide, (v: number) => compact(v, 2, true));
    list = [
      { key: "net", kind: "line", label: "Net", color: C.ink, width: 1.5, format: f, data: pts((r) => r.inv + r.fut), toggle: false },
      ...(desk.hedge
        ? ([
            { key: "spot", kind: "line", label: roled() ? "Inventory" : "Spot", color: INV_COLOR, width: 1, format: f, data: pts((r) => r.inv), lastValue: false },
            { key: "fut", kind: "line", label: "Futures", color: FUT_COLOR, width: 1, format: f, data: pts((r) => r.fut), lastValue: false },
          ] as ExSeries[])
        : []),
    ];
  }
  const view = Math.max(Math.min(VIEW[iv] ?? Infinity, today.length), 30);
  return (
    <ExChart
      id="m-desk"
      title={tab === "equity" ? "Desk equity" : "Desk exposure"}
      className="dk-chart"
      series={list}
      toolbarLeft={tabs}
      moreIntervals={IVS}
      interval={iv}
      onInterval={(v) => setIv(v as PnlIv)}
      emptyText="No data yet today"
      height={340}
      initialBars={view}
      resetKey={`${tab}:${iv}:${today[0]?.t ?? ""}:${past.rows.length > 0}`}
      dividers={past.days}
      onNearStart={past.loadOlder}
      legendRest="names"
      fullscreen
      touch
      chips={list.length > 1 ? list.slice(1).map((x) => ({ key: x.key, label: x.label, color: x.color })) : false}
    />
  );
}
