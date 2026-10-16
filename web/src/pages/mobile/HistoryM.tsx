import { useMemo } from "react";
import { useStore } from "../../store";
import { useThrottled } from "../../hooks";
import { bps, compact, int } from "../../format";
import {
  C,
  HEDGE_COLOR,
  INVPNL_COLOR,
  MM_COLOR,
  REBATE_COLOR,
} from "../../theme";
import {
  ExChart,
  rgba,
  useExPref,
  type ExBoxRow,
  type ExSeries,
} from "../../components/ex";
import type { DayPnl, SymbolRow } from "../../protocol";
import { dayTitle } from "./index";
import {
  Amt,
  Empty,
  MASK,
  PageTabs,
  Row,
  Sec,
  Stats,
  amt,
  useAmt,
} from "./rest/ui";
import "./history.css";

// ---- History: the desk's days (Daily | Cumulative over 7D 30D 90D All, then the list), or the instruments ----

type Tab = "desk" | "inst";
type Range = "7" | "30" | "90" | "all";
type View = "daily" | "cum";
const RANGES: { value: Range; label: string }[] = [
  { value: "7", label: "7D" },
  { value: "30", label: "30D" },
  { value: "90", label: "90D" },
  { value: "all", label: "All" },
];
const OTHER = "#6b7484";

/** A day's result: Day PnL, or Trading PnL on the old days kept before Day PnL was recorded. */
const dayPnl = (d: DayPnl) => d.pnl_day ?? d.trading ?? 0;
const dayMs = (d: DayPnl) => Date.parse(d.day + "T00:00:00Z");

export function HistoryM() {
  const [tab, setTab] = useExPref<Tab>("m-hist", "tab", "desk", [
    "desk",
    "inst",
  ]);
  return (
    <>
      <PageTabs
        items={[
          { value: "desk", label: "Desk" },
          { value: "inst", label: "Instruments" },
        ]}
        value={tab}
        onChange={setTab}
      />
      {tab === "desk" ? <DeskHistory /> : <Instruments />}
    </>
  );
}

function DeskHistory() {
  const [range, setRange] = useExPref<Range>("m-hist", "range", "30", [
    "7",
    "30",
    "90",
    "all",
  ]);
  const [view, setView] = useExPref<View>("m-hist", "view", "daily", [
    "daily",
    "cum",
  ]);
  const allDays = useThrottled(
    useStore((s) => s.snap?.days),
    1000,
  );
  const hide = useStore((s) => s.hideAmounts);
  const money = useAmt();

  // oldest first, the range's last n days
  const days = useMemo(() => {
    const xs = allDays ?? [];
    return range === "all" ? xs : xs.slice(-Number(range));
  }, [allDays, range]);
  const todayKey = allDays?.[allDays.length - 1]?.day;

  const sum = useMemo(() => {
    let tot = 0;
    let up = 0;
    let fills = 0;
    let best: DayPnl | null = null;
    let worst: DayPnl | null = null;
    let done = 0;
    for (const d of days) {
      const v = dayPnl(d);
      tot += v;
      fills += d.fills;
      // today is not finished: it counts in the total, not among the days up, the best or the worst
      if (d.day === todayKey) continue;
      done++;
      if (v > 0) up++;
      if (!best || v > dayPnl(best)) best = d;
      if (!worst || v < dayPnl(worst)) worst = d;
    }
    return { tot, up, done, fills, best, worst };
  }, [days, todayKey]);

  const chart = useMemo(() => {
    const cum = view === "cum";
    const acc = { pnl: 0, pi: 0, mm: 0, inv: 0, hedge: 0, reb: 0, other: 0 };
    const pts = days.map((d) => {
      const v = {
        pnl: dayPnl(d),
        pi: d.trading,
        mm: d.mm,
        inv: d.inventory,
        hedge: d.hedge,
        reb: d.rebates,
        other: d.other,
      };
      if (cum)
        for (const k of Object.keys(acc) as (keyof typeof acc)[])
          acc[k] += v[k] ?? 0;
      return { time: dayMs(d), d, v: cum ? { ...acc } : v };
    });
    return { pts, by: new Map(pts.map((p) => [p.time, p])) };
  }, [days, view]);

  const series = useMemo<ExSeries[]>(() => {
    const fmt = hide ? () => MASK : (x: number) => amt(x, "pnl");
    const line = (
      key: keyof (typeof chart.pts)[number]["v"],
      label: string,
      color: string,
      more?: Partial<ExSeries>,
    ): ExSeries => ({
      key,
      kind: "line",
      label,
      color,
      format: fmt,
      data: chart.pts.map((p) => ({
        time: p.time,
        value: (p.v[key] as number | null) ?? null,
      })),
      lastValue: false,
      hiddenByDefault: true,
      options:
        view === "daily" && days.length <= 31
          ? { pointMarkersVisible: true, pointMarkersRadius: 2 }
          : undefined,
      ...more,
    });
    return [
      view === "daily"
        ? {
            key: "pnl",
            kind: "histogram",
            label: "Day PnL",
            signColor: true,
            format: fmt,
            lastValue: true,
            data: chart.pts.map((p) => ({
              time: p.time,
              value: p.v.pnl,
              color: p.v.pnl >= 0 ? rgba(C.up, 0.85) : rgba(C.down, 0.85),
            })),
          }
        : {
            key: "pnl",
            kind: "baseline",
            label: "Cumulative",
            signColor: true,
            format: fmt,
            data: chart.pts.map((p) => ({ time: p.time, value: p.v.pnl })),
          },
      line("pi", "Π", C.ink2, { width: 1 }),
      line("mm", "MM", MM_COLOR),
      line("inv", "Inv", INVPNL_COLOR),
      line("hedge", "Hedge", HEDGE_COLOR, { lineStyle: "dashed" }),
      line("reb", "Reb", REBATE_COLOR),
      line("other", "Other", OTHER),
    ];
  }, [chart, hide, view, days.length]);
  const boxRows = (t: number): ExBoxRow[] => {
    const p = chart.by.get(t);
    if (!p) return [];
    const r = (
      label: string,
      v: number | null | undefined,
      color?: string,
    ): ExBoxRow => [
      label,
      money(v),
      color ?? (hide ? C.muted : v! > 0 ? C.up : v! < 0 ? C.down : C.ink),
    ];
    return [
      ["Day", p.d.day.slice(5).replace("-", "/")],
      r(view === "cum" ? "Cumulative" : "Day PnL", p.v.pnl),
      r("MM", p.v.mm, MM_COLOR),
      r("Inv", p.v.inv, INVPNL_COLOR),
      r("Hedge", p.v.hedge, HEDGE_COLOR),
      r("Reb", p.v.reb, REBATE_COLOR),
      ["Fills", int(p.d.fills)],
    ];
  };

  const label =
    range === "all"
      ? `PnL, all ${days.length} days (USDT)`
      : days.length < Number(range)
        ? `PnL, ${days.length} days kept (USDT)`
        : `PnL, last ${range} days (USDT)`;
  const tradingOnly = days.filter((d) => d.pnl_day == null).length;

  return (
    <>
      <div className="h-sum">
        <div className="h-sum-l">
          <div className="h-sum-label">{label}</div>
          <Amt v={days.length ? sum.tot : null} className="h-sum-v" />
        </div>
        <Stats
          cols={2}
          className="h-sum-r"
          items={[
            {
              label: "Days up",
              info: "Finished days that made money, of the finished days in the range. Today is still moving: it counts in the total, not here, nor as the best or worst day.",
              value: sum.done ? `${sum.up} / ${sum.done}` : "--",
            },
            {
              label: "Best day",
              value: <Amt v={sum.best ? dayPnl(sum.best) : null} />,
            },
            { label: "Fills", value: days.length ? compact(sum.fills) : "--" },
            {
              label: "Worst day",
              value: <Amt v={sum.worst ? dayPnl(sum.worst) : null} />,
            },
          ]}
        />
      </div>
      <div className="r-chart">
        <ExChart
          key={view + (hide ? ":h" : "")}
          id={view === "cum" ? "m-hist-cum" : "m-hist-day"}
          title="Desk PnL"
          series={series}
          height={280}
          resetKey={range + view}
          rightOffset={0.6}
          fullscreen
          intervals={RANGES}
          interval={range}
          onInterval={(v) => setRange(v as Range)}
          modes={[
            {
              label: "Chart",
              value: view,
              onChange: (v) => setView(v as View),
              options: [
                { value: "daily", label: "Daily" },
                { value: "cum", label: "Cumulative" },
              ],
            },
          ]}
          chips={[
            {
              key: "pnl",
              label: view === "cum" ? "Cumulative" : "Day PnL",
              color: C.up,
            },
            { key: "pi", label: "Π", color: C.ink2 },
            { key: "mm", label: "MM", color: MM_COLOR },
            { key: "inv", label: "Inv", color: INVPNL_COLOR },
            { key: "hedge", label: "Hedge", color: HEDGE_COLOR },
            { key: "reb", label: "Reb", color: REBATE_COLOR },
            { key: "other", label: "Other", color: OTHER },
          ]}
          boxRows={boxRows}
          emptyText="No days kept yet"
        />
      </div>

      <Sec
        title="By day"
        right={tradingOnly ? `${tradingOnly} older days: Trading PnL only` : "USDT"}
      >
        {days
          .slice()
          .reverse()
          .map((d) => (
            <DayRow key={d.day} d={d} today={d.day === todayKey} />
          ))}
        {!days.length && <Empty>No days kept yet</Empty>}
      </Sec>
    </>
  );
}

function DayRow({ d, today }: { d: DayPnl; today: boolean }) {
  const money = useAmt();
  const kept = d.pnl_day != null;
  return (
    <Row
      title={
        <>
          {dayTitle(d.day)}
          {today && <span className="r-tag">Today</span>}
        </>
      }
      sub={`${int(d.fills)} fills · Vol ${money(d.volume, "k")}`}
      value={<Amt v={kept ? d.pnl_day : d.trading} />}
      valueSub={
        kept
          ? `MM ${money(d.mm)} · Inv ${money(d.inventory)}`
          : "Trading PnL only"
      }
      to={{ page: "history", detail: { kind: "day", date: d.day } }}
    />
  );
}

// ---- instruments: today's figures; a tap opens the instrument's candles with our fills ----

function Instruments() {
  const symbols = useThrottled(
    useStore((s) => s.snap?.symbols),
    1000,
  );
  const money = useAmt();
  const rows = useMemo(
    () =>
      (symbols ?? [])
        .filter(
          (r) =>
            r.fills_day > 0 ||
            Math.abs(r.inv_value) >= 1 ||
            r.trading_pnl !== 0,
        )
        .sort(
          (a, b) =>
            b.volume_day - a.volume_day ||
            Math.abs(b.trading_pnl) - Math.abs(a.trading_pnl),
        ),
    [symbols],
  );
  return (
    <Sec title="Traded today" right="by volume · Day PnL">
      {rows.map((r) => (
        <InstRow key={r.venue + r.symbol} r={r} money={money} />
      ))}
      {!rows.length && <Empty>No instrument traded today</Empty>}
    </Sec>
  );
}

function InstRow({
  r,
  money,
}: {
  r: SymbolRow;
  money: (
    v: number | null | undefined,
    k?: "pnl" | "full" | "k" | "pnlK",
  ) => string;
}) {
  const edge = r.edge_bps;
  return (
    <Row
      title={
        <>
          {r.symbol}
          {r.venue === "usdm" && <span className="r-tag">Perp</span>}
        </>
      }
      sub={`${int(r.fills_day)} fills · Vol ${money(r.volume_day, "k")}`}
      value={<Amt v={r.trading_pnl} />}
      valueSub={edge != null ? `edge ${bps(edge)} bps` : undefined}
      to={{
        page: "history",
        detail: {
          kind: "history-instrument",
          symbol: r.symbol,
          venue: r.venue,
        },
      }}
    />
  );
}
