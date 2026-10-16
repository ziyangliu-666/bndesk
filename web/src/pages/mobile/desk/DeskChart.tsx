// The phone Desk's P&L chart: Day PnL (a baseline at zero for Line, candles for 1m 5m 15m) with the split as
// lines (Trading, market making, inventory PnL, the hedge, rebates, other: the desktop's palette and strokes),
// notional filled in a volume pane, Today (the trading day so far) or 24h (the rolling last 24 hours). Long-press
// reads a bar, ⤢ opens #/chart/m-desk.
import { useMemo, useRef } from "react";
import { compact, pnl } from "../../../format";
import { ExChart, useExPref, type ExSeries } from "../../../components/ex";
import { C, PNL_COLORS as P, PNL_STROKES as S, rgba } from "../../../components/ex/palette";
import { useLive } from "../../../components/mobile";
import { useStore } from "../../../store";
import { maskFormat } from "../../../mask";
import { useLast24h, useTodayMinutes } from "../../desk/pnlData";
import { PNL_STEP, histBars, todayBars, toChart, type PnlData, type PnlIv } from "./pnl";

const IVS: { value: PnlIv; label: string }[] = [
  { value: "line", label: "Line" },
  { value: "1m", label: "1m" },
  { value: "5m", label: "5m" },
  { value: "15m", label: "15m" },
];
const RANGES = [
  { value: "today", label: "Today", title: "The trading day so far" },
  { value: "24h", label: "24h", title: "The last 24 hours, ending now" },
];
// bars in view after a load: the whole day for Line and 15m, the last two hours or so otherwise
const VIEW: Record<PnlIv, number | undefined> = { line: undefined, "1m": 90, "5m": 96, "15m": undefined };
const VOL = rgba(C.ink2, 0.38);

/** The Desk chart. `ms`: how often it takes the store's figures (the page's own pace). */
export function DeskChart({ ms }: { ms: number }) {
  const [iv, setIv] = useExPref<PnlIv>("m-desk", "interval", "line", IVS.map((i) => i.value));
  const [range, setRange] = useExPref<string>("m-desk", "range", "today", ["today", "24h"]);
  const hide = useStore((s) => s.hideAmounts);
  const dayStart = useLive((s) => s.snap?.summary.day_start, ms);
  const day = range === "today";
  const bars = useLive((s) => (day ? s.snap?.bars : undefined), ms, false, range);
  const series = useLive((s) => (day ? s.snap?.series : undefined), ms, false, range);
  const fills = useLive((s) => (day ? s.snap?.fills : undefined), ms, false, range);
  const step = PNL_STEP[iv];

  // the last 24 h (rolling, ending now): /api/history in bars of the interval, the desktop's own
  const last24 = useLast24h(day ? null : step);
  // today's rebates and fill counts by minute
  const mins = useTodayMinutes(day ? dayStart : null);

  const prev = useRef<{ k: string; d: PnlData } | null>(null);
  const k = `${range}:${iv}`;
  const data = useMemo(() => {
    const list = day ? (dayStart != null ? todayBars(dayStart, bars, series, fills, step, mins) : []) : histBars(last24.bars);
    const d = toChart(list, iv === "line", null, prev.current?.k === k ? prev.current.d : null, VOL);
    prev.current = { k, d };
    return d;
  }, [day, dayStart, bars, series, fills, step, last24.bars, iv, k, mins]);

  // masked with Hide amounts: ExChart re-reads a format that prints otherwise (no remount)
  const money = maskFormat(hide, (v: number) => pnl(v));
  const vol = maskFormat(hide, (v: number) => compact(v));
  const label = day ? "Day PnL" : "PnL 24h";
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
  // the last 24 h of another interval is still the old one: blank, and fit the view when the new one comes
  const loading = !day && last24.loading;

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
      modes={[{ label: "Range", value: range, onChange: setRange, options: RANGES }]}
      loading={loading}
      emptyText={last24.error && !day ? "Could not load the last 24 h" : "No P&L yet today"}
      height={300}
      initialBars={VIEW[iv]}
      // and again when earlier bars arrive (the first snapshot carries the last minutes only)
      resetKey={`${k}:${data.bars[0]?.time ?? ""}`}
      fullscreen
      touch
      chips={[...s.slice(1, -1).map((x) => ({ key: x.key, label: x.label, color: x.color, stroke: x.lineStyle })), "|", { key: "vol", label: "Vol" }]}
    />
  );
}
