// The phone Desk's P&L chart: Day PnL (a baseline at zero for Line, candles for 1m 5m 15m) with its parts as
// lines (Π, market making, inventory PnL, the hedge; rebates on 24h), notional filled in a volume pane, Today or
// the last 24 h. Long-press reads a bar, ⤢ opens #/chart/m-desk.
import { useMemo, useRef } from "react";
import { getJSON, type History } from "../../../api";
import { compact, pnl } from "../../../format";
import { serverNow, useStore } from "../../../store";
import { ExChart, useExPref, type ExSeries } from "../../../components/ex";
import { C, HEDGE_COLOR, INVPNL_COLOR, MM_COLOR, REBATE_COLOR, rgba } from "../../../components/ex/palette";
import { useLive } from "../../../components/mobile";
import { useLoad } from "../shared";
import { PNL_STEP, histBars, todayBars, toChart, type PnlData, type PnlIv } from "./pnl";

const IVS: { value: PnlIv; label: string }[] = [
  { value: "line", label: "Line" },
  { value: "1m", label: "1m" },
  { value: "5m", label: "5m" },
  { value: "15m", label: "15m" },
];
const RANGES = [
  { value: "today", label: "Today" },
  { value: "24h", label: "24h" },
];
// bars in view after a load: the whole day for Line and 15m, the last two hours or so otherwise
const VIEW: Record<PnlIv, number | undefined> = { line: undefined, "1m": 90, "5m": 96, "15m": undefined };
const VOL = rgba(C.ink2, 0.38);
const MASK = "•••";

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

  // the last 24 h: /api/history in bars of the interval, again each minute
  const hist = useLoad<History>(
    day ? null : `24h:${step}`,
    (signal) => {
      const to = serverNow();
      return getJSON<History>("/api/history", { from: to - 86_400_000, to, step: step / 1000 }, signal);
    },
    60_000,
  );

  const prev = useRef<{ k: string; d: PnlData } | null>(null);
  const k = `${range}:${iv}`;
  const data = useMemo(() => {
    const list = day ? (dayStart != null ? todayBars(dayStart, bars, series, fills, step) : []) : hist.key === `24h:${step}` ? histBars(hist.data?.bars) : [];
    const d = toChart(list, iv === "line", null, prev.current?.k === k ? prev.current.d : null, VOL);
    prev.current = { k, d };
    return d;
  }, [day, dayStart, bars, series, fills, step, hist, iv, k]);

  const money = (v: number) => (hide ? MASK : pnl(v));
  const vol = (v: number) => (hide ? MASK : compact(v));
  const label = day ? "Day PnL" : "PnL 24h";
  const s: ExSeries[] = [
    iv === "line"
      ? { key: "day", kind: "baseline", label, data: data.main, format: money, signColor: true, toggle: false }
      : { key: "day", kind: "candles", label, data: data.main, format: money, toggle: false },
    { key: "trading", kind: "line", label: "Π", color: C.ink2, width: 1, data: data.trading, format: money, signColor: false, lastValue: false },
    { key: "mm", kind: "line", label: "MM", color: MM_COLOR, data: data.mm, format: money, lastValue: false },
    { key: "inv", kind: "line", label: "Inv", color: INVPNL_COLOR, data: data.inv, format: money, lastValue: false },
    { key: "hedge", kind: "line", label: "Hedge", color: HEDGE_COLOR, data: data.hedge, format: money, lastValue: false, lineStyle: "dotted", width: 2 },
    ...(data.rebates.length
      ? [{ key: "reb", kind: "line" as const, label: "Reb", color: REBATE_COLOR, data: data.rebates, format: money, lastValue: false }]
      : []),
    { key: "vol", kind: "histogram", label: "Vol(USDT)", pane: 1, color: VOL, data: data.vol, format: vol, lastValue: false },
  ];
  // the last 24 h of another interval is still the old one: blank, and fit the view when the new one comes
  const loading = !day && hist.err == null && (hist.key !== `24h:${step}` || hist.data == null);

  return (
    <ExChart
      // a remount when amounts hide or show: the axis takes its formatter at creation
      key={hide ? "masked" : "shown"}
      id="m-desk"
      title="Desk P&L"
      className="dk-chart"
      series={s}
      paneStretch={[1, 0.24]}
      intervals={IVS}
      interval={iv}
      onInterval={(v) => setIv(v as PnlIv)}
      modes={[{ label: "Range", value: range, onChange: setRange, options: RANGES }]}
      loading={loading}
      emptyText={hist.err && !day ? "Could not load the last 24 h" : "No P&L yet today"}
      height={300}
      initialBars={VIEW[iv]}
      // and again when earlier bars arrive (the first snapshot carries the last minutes only)
      resetKey={`${k}:${data.bars[0]?.time ?? ""}`}
      fullscreen
      touch
      chips={[
        { key: "trading", label: "Π", color: C.ink2 },
        { key: "mm", label: "MM", color: MM_COLOR },
        { key: "inv", label: "Inv", color: INVPNL_COLOR },
        { key: "hedge", label: "Hedge", color: HEDGE_COLOR },
        ...(data.rebates.length ? [{ key: "reb", label: "Reb", color: REBATE_COLOR }] : []),
        "|",
        { key: "vol", label: "Vol" },
      ]}
    />
  );
}
