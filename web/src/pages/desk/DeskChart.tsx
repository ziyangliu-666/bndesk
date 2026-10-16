// The Desk's centre chart with nothing picked: tabs P&L | Equity | Exposure on ExChart, today's minute bars
// (5 s on Line), intervals, Today | 24h, and legends that show each line's value.
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { IChartApi } from "lightweight-charts";
import { useStore } from "../../store";
import { compact, num, pnl } from "../../format";
import { ACCOUNT_SERIES, C, FUT_COLOR, HEDGE_COLOR, INV_COLOR, INVPNL_COLOR, MM_COLOR, S1 } from "../../theme";
import { ExChart, Tabs, rgba, useExPref, type ExLegendItem, type ExSeries } from "../../components/ex";
import { MIN, Stable, accountRows, bucket, dayRows, sameOhlc, sameValue, type Row } from "./model";
import { MASK, useHide } from "./mask";

type Tab = "pnl" | "equity" | "exposure";
const TABS: { value: Tab; label: string; title: string }[] = [
  { value: "pnl", label: "P&L", title: "Day PnL and its parts, notional filled" },
  { value: "equity", label: "Equity", title: "Equity of all accounts, and each account's Day PnL" },
  { value: "exposure", label: "Exposure", title: "Spot inventory value, futures notional and the net" },
];

const IVS = [
  { value: "line", label: "Line", title: "The 5 s series" },
  { value: "1m", label: "1m" },
  { value: "5m", label: "5m" },
  { value: "15m", label: "15m" },
  { value: "1h", label: "1H" },
];
const IV_VALUES = IVS.map((i) => i.value);
const STEP: Record<string, number> = { line: 0, "1m": MIN, "5m": 5 * MIN, "15m": 15 * MIN, "1h": 60 * MIN };
const RANGE = [
  { value: "today", label: "Today", title: "The day so far" },
  { value: "24h", label: "24h", title: "The whole day, start to end" },
];
const STYLE = [
  { value: "area", label: "Area" },
  { value: "candles", label: "Candles" },
];

const VOL = rgba(C.ink2, 0.38);
const NET = C.ink;

export function DeskChart({ head }: { head?: ReactNode }) {
  const [tab, setTab] = useExPref<Tab>("desk", "tab", "pnl", ["pnl", "equity", "exposure"]);
  const hide = useHide();
  return (
    <section className="dk-panel dk-centre">
      <div className="dk-head">
        <Tabs items={TABS} value={tab} onChange={setTab} />
        {head}
      </div>
      {/* a new chart when Hide amounts flips: the axis, tags and legend take the masked format */}
      <DeskSeriesChart key={tab + (hide ? ":h" : "")} tab={tab} hide={hide} />
    </section>
  );
}

function DeskSeriesChart({ tab, hide }: { tab: Tab; hide: boolean }) {
  const id = "desk." + tab;
  const [iv, setIv] = useExPref<string>(id, "interval", "1m", IV_VALUES);
  const [range, setRange] = useExPref<string>("desk", "range", "today", ["today", "24h"]);
  const [style, setStyle] = useExPref<string>("desk.pnl", "style", "area", ["area", "candles"]);
  const bars = useStore((s) => s.snap?.bars);
  const series = useStore((s) => s.snap?.series);
  const fills = useStore((s) => s.snap?.fills);
  const accSeries = useStore((s) => (tab === "equity" ? s.snap?.account_series : undefined));
  const dayStart = useStore((s) => s.snap?.summary.day_start ?? 0);
  const exposure = useStore((s) => (tab === "exposure" ? s.snap?.exposure : undefined));
  const step = STEP[iv] ?? MIN;
  const stable = useRef(new Stable()).current;

  // minute rows (the volume pane at every interval), and the 5 s rows for Line
  const minRows = useMemo(() => dayRows(bars, series, fills, dayStart, MIN), [bars, series, fills, dayStart]);
  const rows = useMemo(() => (step === 0 ? dayRows(bars, series, fills, dayStart, 0) : bucket(minRows, step)), [step, minRows, bars, series, fills, dayStart]);
  const volRows = step === 0 ? minRows : rows;
  const volByT = useMemo(() => new Map(volRows.map((r) => [r.t, r])), [volRows]);

  const money = (f: (v: number) => string) => (hide ? () => MASK : f);
  const fPnl = money(pnl);
  const fBig = money((v) => compact(v));
  const pts = (k: string, pick: (r: Row) => number | null, list: Row[] = rows) =>
    stable.get(
      k + iv,
      list.map((r) => ({ time: r.t, value: pick(r) })),
      sameValue,
    );

  const vol: ExSeries = {
    key: "vol",
    kind: "histogram",
    label: "Vol(USDT)",
    color: VOL,
    pane: 1,
    data: pts("vol", (r) => r.vol, volRows),
    format: fBig,
    lastValue: false,
  };

  let list: ExSeries[];
  let extra: ExLegendItem[] = [];
  let stretch = [1, 0.22];
  if (tab === "pnl") {
    const day: ExSeries =
      style === "candles"
        ? {
            key: "day",
            kind: "candles",
            label: "Day PnL",
            toggle: false,
            format: fPnl,
            data: stable.get(
              "dayc" + iv,
              rows.map((r) => ({ time: r.t, open: r.o, high: r.h, low: r.l, close: r.c })),
              sameOhlc,
            ),
          }
        : { key: "day", kind: "baseline", label: "Day PnL", toggle: false, format: fPnl, signColor: true, data: pts("day", (r) => r.c) };
    const has = (k: "mm" | "hedge") => rows.some((r) => r[k] != null);
    list = [
      day,
      { key: "trading", kind: "line", label: "Π", color: S1, width: 1, format: fPnl, signColor: false, data: pts("trading", (r) => r.trading) },
      ...(has("mm")
        ? [
            { key: "mm", kind: "line", label: "MM", color: MM_COLOR, width: 1, format: fPnl, data: pts("mm", (r) => r.mm) } as ExSeries,
            { key: "inv", kind: "line", label: "Inv", color: INVPNL_COLOR, width: 1, format: fPnl, data: pts("invp", (r) => (r.trading != null && r.mm != null ? r.trading - r.mm : null)) } as ExSeries,
          ]
        : []),
      ...(has("hedge") ? [{ key: "hedge", kind: "line", label: "Hedge", color: HEDGE_COLOR, width: 1, lineStyle: "dashed", format: fPnl, data: pts("hedge", (r) => r.hedge) } as ExSeries] : []),
      vol,
    ];
    extra = [
      {
        pane: 1,
        label: "Fills",
        color: C.ink2,
        value: (t) => {
          const n = volByT.get(t)?.fills;
          return n == null ? "--" : String(n);
        },
      },
    ];
  } else if (tab === "equity") {
    list = [{ key: "equity", kind: "area", label: "Equity", color: S1, format: money((v) => num(v, 2)), data: pts("equity", (r) => r.equity), margins: { top: 0.2, bottom: 0.1 } }];
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
        data: stable.get("acc" + a.account + iv, accountRows(a, dayStart, step), sameValue),
      });
    });
    stretch = [1, 0.6];
  } else {
    list = [
      { key: "net", kind: "line", label: "Net", color: NET, width: 1.5, format: fBig, data: pts("net", (r) => r.inv + r.fut) },
      { key: "spot", kind: "line", label: "Spot", color: INV_COLOR, width: 1, format: fBig, data: pts("spot", (r) => r.inv), lastValue: false },
      { key: "fut", kind: "line", label: "Futures", color: FUT_COLOR, width: 1, format: fBig, data: pts("fut", (r) => r.fut), lastValue: false },
    ];
    const x = exposure;
    if (x?.gap != null)
      extra = [
        {
          label: "Gap now",
          title: "Exposure gap: the hedge target minus the hedge symbols' futures notional; the band is its allowed size",
          value: () => [hide ? MASK : `${pnl(x.gap)} / ±${compact(x.band, 2)}`, x.band != null && Math.abs(x.gap!) > x.band ? C.warn : C.ink2],
        },
      ];
  }

  // 24h: the whole day on the axis, start to end; Today: the part so far (ExChart's fit)
  const chart = useRef<IChartApi | null>(null);
  const first = rows[0]?.t;
  const [ready, setReady] = useState(false);
  useEffect(() => {
    const c = chart.current;
    if (!c || !ready || first == null || !dayStart) return;
    c.timeScale().applyOptions({ shiftVisibleRangeOnNewBar: range !== "24h" });
    if (range !== "24h") {
      c.timeScale().fitContent();
      return;
    }
    const s = step || 5_000;
    const lead = (first - dayStart) / s;
    c.timeScale().setVisibleLogicalRange({ from: -lead - 0.5, to: 86_400_000 / s - lead });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [range, iv, ready, first == null, dayStart]);

  return (
    <ExChart
      id={id}
      className="dk-chart"
      fill
      title={TABS.find((t) => t.value === tab)!.label}
      series={list}
      paneStretch={stretch}
      intervals={IVS}
      interval={iv}
      onInterval={setIv}
      modes={[
        ...(tab === "pnl" ? [{ label: "Style", value: style, onChange: setStyle, options: STYLE }] : []),
        { label: "Range", value: range, onChange: setRange, options: RANGE },
      ]}
      legendExtra={extra}
      fullscreen
      chartRef={(c) => {
        chart.current = c;
        setReady(c != null);
      }}
      emptyText="No data yet today"
      style={{ flex: 1, minHeight: 0 }}
    />
  );
}
