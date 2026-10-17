// The phone Desk's P&L chart: Day PnL (a baseline at zero for Line, candles for 1m 5m 15m) with the split as
// lines (Trading, market making, inventory PnL, the hedge, rebates, other: the desktop's palette and strokes),
// notional filled in a volume pane. Today from the store; the days before from /api/history, a pan away (loaded
// further back as the view nears the first bar), each day from its own start with a faint rule between days.
// Long-press reads a bar, ⤢ opens #/chart/m-desk.
import { useMemo, useRef } from "react";
import { compact, pnl } from "../../../format";
import { ExChart, useExPref, type ExSeries } from "../../../components/ex";
import { C, PNL_COLORS as P, PNL_STROKES as S, rgba } from "../../../components/ex/palette";
import { useLive } from "../../../components/mobile";
import { useStore } from "../../../store";
import { maskFormat } from "../../../mask";
import { useTodayMinutes } from "../../desk/pnlData";
import { dayEnds, pastStep, useDayOffsets, usePast, type DayOffset } from "../../desk/past";
import { PNL_STEP, histBars, todayBars, toChart, type PnlBar, type PnlData, type PnlIv } from "./pnl";

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

/** The Desk chart. `ms`: how often it takes the store's figures (the page's own pace). */
export function DeskChart({ ms }: { ms: number }) {
  const [iv, setIv] = useExPref<PnlIv>("m-desk", "interval", "line", IVS.map((i) => i.value));
  const hide = useStore((s) => s.hideAmounts);
  const dayStart = useLive((s) => s.snap?.summary.day_start, ms);
  const bars = useLive((s) => s.snap?.bars, ms);
  const series = useLive((s) => s.snap?.series, ms);
  const fills = useLive((s) => s.snap?.fills, ms);
  const step = PNL_STEP[iv];
  // today's rebates and fill counts by minute; the days before at the interval
  const mins = useTodayMinutes(dayStart);
  const past = usePast(pastStep(step), dayStart ?? 0);
  const pastBars = useMemo(() => histBars(past.bars), [past.bars]);
  // the P&L runs on over the days: each day's stored figures plus the earlier days' closes (null until those are in)
  const offAt = useDayOffsets(dayStart);

  const prev = useRef<{ k: string; d: PnlData } | null>(null);
  const k = iv;
  const nToday = useRef(0);
  const data = useMemo(() => {
    const today = dayStart != null ? todayBars(dayStart, bars, series, fills, step, mins) : [];
    nToday.current = today.length;
    const perDay = pastBars.length ? pastBars.concat(today) : today;
    const all = offAt ? perDay.map((b) => runOn(b, offAt(b.time))) : perDay;
    const ends = offAt ? new Set<number>() : dayEnds(all.map((b) => b.time), dayStart ?? 0);
    const d = toChart(all, iv === "line", null, prev.current?.k === k ? prev.current.d : null, VOL, ends);
    prev.current = { k, d };
    return d;
  }, [dayStart, bars, series, fills, step, pastBars, iv, k, mins, offAt]);

  // masked with Hide amounts: ExChart re-reads a format that prints otherwise (no remount)
  const money = maskFormat(hide, (v: number) => pnl(v));
  const vol = maskFormat(hide, (v: number) => compact(v));
  const label = offAt ? "Cumulative PnL" : "Day PnL";
  // at rest the legend has two lines: Day PnL, then Trading, Hedge and Rebates (with Other they make Day PnL); the
  // two parts of Trading and Other are a chip away
  const line = (key: keyof typeof P, label: string, pts: PnlData["mm"]): ExSeries => ({
    key,
    kind: "line",
    label,
    color: P[key],
    lineStyle: S[key],
    width: 1.5,
    data: pts,
    format: money,
    signColor: false,
    lastValue: false,
    hiddenByDefault: key === "mm" || key === "inv" || key === "other",
  });
  const s: ExSeries[] = [
    iv === "line"
      ? { key: "day", kind: "baseline", label, data: data.main, format: money, signColor: true, toggle: false }
      : { key: "day", kind: "candles", label, data: data.main, format: money, toggle: false },
    line("trading", "Trading", data.trading),
    line("mm", "MM", data.mm),
    line("inv", "Inv", data.inv),
    line("hedge", "Hedge", data.hedge),
    ...(data.rebates.length ? [line("reb", "Rebates", data.rebates), line("other", "Other", data.other)] : []),
    { key: "vol", kind: "histogram", label: "Vol(USDT)", pane: 1, color: VOL, data: data.vol, format: vol, lastValue: false },
  ];
  // the view opens on today (and opens again once the first snapshot's earlier minutes and the days before are in)
  const view = Math.max(Math.min(VIEW[iv] ?? Infinity, nToday.current), 30);
  const todayFirst = data.bars.find((b) => b.time >= (dayStart ?? 0))?.time ?? "";

  return (
    <ExChart
      id="m-desk"
      title="Desk PnL"
      className="dk-chart"
      series={s}
      paneStretch={[1, 0.24]}
      intervals={IVS}
      interval={iv}
      onInterval={(v) => setIv(v as PnlIv)}
      emptyText="No P&L yet today"
      height={300}
      initialBars={view}
      resetKey={`${k}:${todayFirst}:${past.bars.length > 0}`}
      dividers={past.days}
      onNearStart={past.loadOlder}
      legendRest="names"
      fullscreen
      touch
      chips={[...s.slice(1, -1).map((x) => ({ key: x.key, label: x.label, color: x.color, stroke: x.lineStyle })), "|", { key: "vol", label: "Vol" }]}
    />
  );
}

/** A bar's P&L figures run on from the earlier days' closes (`o`). */
function runOn(b: PnlBar, o: DayOffset): PnlBar {
  const add = (v: number | null, d: number) => (v == null ? v : v + d);
  return {
    ...b,
    open: b.open + o.c,
    high: b.high + o.c,
    low: b.low + o.c,
    close: b.close + o.c,
    trading: add(b.trading, o.trading),
    mm: add(b.mm, o.mm),
    inv: add(b.inv, o.trading - o.mm),
    hedge: add(b.hedge, o.hedge),
    rebates: add(b.rebates, o.reb),
    other: add(b.other, o.c - o.trading - o.hedge - o.reb),
  };
}
