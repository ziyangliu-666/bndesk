// The Desk's centre chart with nothing picked: tabs P&L | Equity | Exposure on ExChart, today's minute bars
// (5 s on Line), intervals, Today | 24h, and legends that show each line's value.
import { useMemo, useRef, type ReactNode } from "react";
import { useStore } from "../../store";
import { compact, num, pnl } from "../../format";
import { ACCOUNT_SERIES, C, FUT_COLOR, INV_COLOR, PNL_COLORS, PNL_STROKES } from "../../theme";
import { ExChart, Tabs, rgba, useExPref, type ExLegendItem, type ExSeries } from "../../components/ex";
import { MIN, Stable, accountOnGrid, bucket, todayRows, sameOhlc, sameValue, type Row } from "./model";
import { histRows, rebatesAt, useLast24h, useTodayMinutes, withFills } from "./pnlData";
import { maskFormat, maskText, useHide } from "../../mask";

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
  { value: "today", label: "Today", title: "The trading day so far" },
  { value: "24h", label: "24h", title: "The last 24 hours, ending now" },
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
      <DeskSeriesChart key={tab} tab={tab} hide={hide} />
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
  // 24h (the P&L tab only): the rolling last 24 h from /api/history, in bars of the interval (Line: minutes)
  const r24 = tab === "pnl" && range === "24h";
  const last24 = useLast24h(r24 ? step || MIN : null);
  const stable = useRef(new Stable()).current;
  // today's rebates and fill counts by minute (the snapshot's minute bars do not carry them)
  const mins = useTodayMinutes(tab === "pnl" && !r24 ? dayStart : null);

  // minute rows (the volume pane at every interval), and the 5 s rows for Line
  const minRows = useMemo(
    () => (r24 ? histRows(last24.bars) : withFills(todayRows(bars, series, fills, dayStart, MIN), mins)),
    [r24, last24.bars, bars, series, fills, dayStart, mins],
  );
  const rows = useMemo(
    () => (r24 ? minRows : step === 0 ? todayRows(bars, series, fills, dayStart, 0) : bucket(minRows, step)),
    [r24, step, minRows, bars, series, fills, dayStart],
  );
  // 24h: the rebates are in the bars themselves
  const rebByT = useMemo(() => new Map(r24 ? last24.bars.filter((b) => b.rebates != null).map((b) => [b.t, b.rebates!] as const) : []), [r24, last24.bars]);
  const volRows = step === 0 && !r24 ? minRows : rows;
  const volByT = useMemo(() => new Map(volRows.map((r) => [r.t, r])), [volRows]);

  // the axis, tags and legend read ••• with Hide amounts (ExChart re-reads a format that prints otherwise)
  const money = (f: (v: number) => string) => maskFormat(hide, f);
  const fPnl = money(pnl);
  const fBig = money((v) => compact(v));
  // exposure is signed (long +, short −), on the axis, the tags and the legend
  const fSigned = money((v) => compact(v, 2, true));
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
    // on Line the bars are 5 s and the volume minutes: its legend reads the minute of the bar (below)
    legend: step === 0 && !r24 ? false : undefined,
  };
  const volAt = (t: number) => volByT.get(step === 0 && !r24 ? Math.floor(t / MIN) * MIN : t);
  const volLegend: ExLegendItem[] =
    step === 0 && !r24 && tab !== "equity" && tab !== "exposure"
      ? [{ pane: 1, key: "vol", label: "Vol(USDT)", value: (t) => { const r = volAt(t); return r ? [fBig(r.vol), C.ink] : "--"; } }]
      : [];

  let list: ExSeries[];
  let extra: ExLegendItem[] = [];
  let stretch = [1, 0.22];
  if (tab === "pnl") {
    const dayLabel = r24 ? "PnL 24h" : "Day PnL";
    const day: ExSeries =
      style === "candles"
        ? {
            key: "day",
            kind: "candles",
            label: dayLabel,
            toggle: false,
            format: fPnl,
            data: stable.get(
              "dayc" + iv,
              rows.map((r) => ({ time: r.t, open: r.o, high: r.h, low: r.l, close: r.c })),
              sameOhlc,
            ),
          }
        : { key: "day", kind: "baseline", label: dayLabel, toggle: false, format: fPnl, signColor: true, data: pts("day", (r) => r.c) };
    const has = (k: "mm" | "hedge") => rows.some((r) => r[k] != null);
    // rebates at a row: the last minute's figure inside it; Other is what the parts leave of Day PnL
    const rebAt = (r: Row) => (r24 ? (rebByT.get(r.t) ?? null) : rebatesAt(mins, r.t, step));
    const anyReb = r24 ? rebByT.size > 0 : mins.reb.t.length > 0;
    const P = PNL_COLORS;
    const S = PNL_STROKES;
    list = [
      day,
      { key: "trading", kind: "line", label: "Trading", color: P.trading, width: 1.5, format: fPnl, signColor: false, data: pts("trading", (r) => r.trading) },
      ...(has("mm")
        ? [
            { key: "mm", kind: "line", label: "Market making", color: P.mm, lineStyle: S.mm, width: 1.5, format: fPnl, data: pts("mm", (r) => r.mm) } as ExSeries,
            { key: "inv", kind: "line", label: "Inventory PnL", color: P.inv, lineStyle: S.inv, width: 1.5, format: fPnl, data: pts("invp", (r) => (r.trading != null && r.mm != null ? r.trading - r.mm : null)) } as ExSeries,
          ]
        : []),
      ...(has("hedge") ? [{ key: "hedge", kind: "line", label: "Hedge", color: P.hedge, width: 1.5, lineStyle: S.hedge, format: fPnl, data: pts("hedge", (r) => r.hedge) } as ExSeries] : []),
      ...(anyReb
        ? [
            { key: "reb", kind: "line", label: "Rebates", color: P.reb, width: 1.5, lineStyle: S.reb, format: fPnl, data: pts("reb", rebAt) } as ExSeries,
            {
              key: "other",
              kind: "line",
              label: "Other",
              color: P.other,
              width: 1.5,
              lineStyle: S.other,
              format: fPnl,
              data: pts("other", (r) => {
                const b = rebAt(r);
                return r.trading == null || b == null ? null : r.c - r.trading - (r.hedge ?? 0) - b;
              }),
            } as ExSeries,
          ]
        : []),
      vol,
    ];
    extra = [
      ...volLegend,
      {
        pane: 1,
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
        data: stable.get("acc" + a.account + iv, accountOnGrid(a, rows, dayStart), sameValue),
      });
    });
    stretch = [1, 0.6];
  } else {
    list = [
      { key: "net", kind: "line", label: "Net", color: NET, width: 1.5, format: fSigned, data: pts("net", (r) => r.inv + r.fut) },
      { key: "spot", kind: "line", label: "Spot", color: INV_COLOR, width: 1, format: fSigned, data: pts("spot", (r) => r.inv), lastValue: false },
      { key: "fut", kind: "line", label: "Futures", color: FUT_COLOR, width: 1, format: fSigned, data: pts("fut", (r) => r.fut), lastValue: false },
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

  // Today fits the day so far; a few wide bars get one bar of room after the last, not five
  const right = step >= 15 * MIN ? 1 : step >= 5 * MIN ? 2 : undefined;

  return (
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
      modes={tab === "pnl" ? [
        { label: "Style", value: style, onChange: setStyle, options: STYLE },
        { label: "Range", value: range, onChange: setRange, options: RANGE },
      ] : []}
      legendExtra={extra}
      fullscreen
      rightOffset={right}
      resetKey={r24 ? "24h" : "today"}
      loading={r24 && last24.loading}
      emptyText={r24 && last24.error ? "Could not load the last 24 h" : "No data yet today"}
      style={{ flex: 1, minHeight: 0 }}
    />
  );
}
