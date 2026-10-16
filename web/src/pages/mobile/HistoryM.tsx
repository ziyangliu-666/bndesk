import { useMemo } from "react";
import { navigate, useStore } from "../../store";
import { useThrottled } from "../../hooks";
import { bps, compact, int } from "../../format";
import { C, PNL_COLORS as P, PNL_STROKES as S } from "../../theme";
import {
  ExChart,
  rgba,
  useExPref,
  type ExBoxRow,
  type ExSeries,
} from "../../components/ex";
import type { SymbolRow } from "../../protocol";
import { useHedgePnl } from "../../selectors";
import { daySummary, rangeFrom, summaryNote, useRangeDays, type DayRow, type Range as HRange } from "../history/data";
import { dayTitle } from "./index";
import {
  Amt,
  Empty,
  PageTabs,
  Row,
  Sec,
  Stats,
  amt,
  useAmt,
} from "./rest/ui";
import "./history.css";
import { MASK } from "../../mask";

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

const RANGE_OF: Record<Range, HRange> = { "7": "7d", "30": "30d", "90": "90d", all: "all" };

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
  const hide = useStore((s) => s.hideAmounts);
  const money = useAmt();
  // the range's days, as the desktop History has them (the snapshot's kept days and the day bars of
  // /api/history), summed the same way
  const dayStart = useStore((s) => s.snap?.summary.day_start ?? null);
  const from = dayStart == null ? null : rangeFrom(RANGE_OF[range], dayStart);
  const { rows, todayDay: todayKey } = useRangeDays(from);
  // oldest first
  const days = useMemo(() => rows.slice().reverse(), [rows]);
  const sum = useMemo(() => daySummary(rows, todayKey), [rows, todayKey]);

  const chart = useMemo(() => {
    const cum = view === "cum";
    const acc = { pnl: 0, pi: 0, mm: 0, inv: 0, hedge: 0, reb: 0, other: 0 };
    const pts = days.map((d) => {
      const v: Record<keyof typeof acc, number | null> = {
        pnl: d.pnl,
        pi: d.pi,
        mm: d.mm,
        inv: d.inv,
        hedge: d.hedge,
        reb: d.reb,
        other: d.other,
      };
      if (cum)
        for (const k of Object.keys(acc) as (keyof typeof acc)[])
          acc[k] += v[k] ?? 0;
      return { time: d.start, d, v: cum ? { ...acc } : v };
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
      width: 1.5,
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
            toggle: false,
            signColor: true,
            format: fmt,
            lastValue: true,
            data: chart.pts.map((p) => ({
              time: p.time,
              value: p.v.pnl,
              color: hide ? rgba(C.ink2, 0.5) : (p.v.pnl ?? 0) >= 0 ? rgba(C.up, 0.85) : rgba(C.down, 0.85),
            })),
          }
        : {
            key: "pnl",
            kind: "baseline",
            label: "Cumulative",
            toggle: false,
            signColor: true,
            format: fmt,
            data: chart.pts.map((p) => ({ time: p.time, value: p.v.pnl })),
          },
      line("pi", "Trading", P.trading),
      line("mm", "MM", P.mm, { lineStyle: S.mm }),
      line("inv", "Inv", P.inv, { lineStyle: S.inv }),
      line("hedge", "Hedge", P.hedge, { lineStyle: S.hedge }),
      line("reb", "Rebates", P.reb, { lineStyle: S.reb }),
      line("other", "Other", P.other, { lineStyle: S.other }),
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
      ["Day", p.d.day],
      r(view === "cum" ? "Cumulative" : "Day PnL", p.v.pnl),
      r("Trading", p.v.pi, P.trading),
      r("MM", p.v.mm, P.mm),
      r("Inv", p.v.inv, P.inv),
      r("Hedge", p.v.hedge, P.hedge),
      r("Rebates", p.v.reb, P.reb),
      r("Other", p.v.other, P.other),
      ["Fills", int(p.d.fills)],
    ];
  };

  const label = range === "all" ? "PnL, all days (USDT)" : `PnL, ${range} days (USDT)`;

  return (
    <>
      <div className="h-sum">
        <div className="h-sum-l">
          <div className="h-sum-label">{label}</div>
          <Amt v={sum.total} className="h-sum-v" />
          {rows.length > 0 && <div className="h-sum-note">{summaryNote(sum)}</div>}
        </div>
        <Stats
          cols={2}
          className="h-sum-r"
          items={[
            {
              label: "Days up",
              info: "Finished days that made money, of the finished days in the range. Today is still moving: it counts in the total, not here, nor as the best or worst day.",
              value: sum.finished ? `${sum.up} of ${sum.finished}` : "--",
            },
            {
              label: "Best day",
              value: <Amt v={sum.best?.pnl ?? null} />,
              // a tap opens the day (its page has the path and the split)
              onClick: sum.best ? () => navigate({ page: "history", detail: { kind: "day", date: sum.best!.day } }) : undefined,
            },
            { label: "Fills", value: rows.length ? compact(sum.fills) : "--" },
            {
              label: "Worst day",
              value: <Amt v={sum.worst?.pnl ?? null} />,
              onClick: sum.worst ? () => navigate({ page: "history", detail: { kind: "day", date: sum.worst!.day } }) : undefined,
            },
          ]}
        />
      </div>
      <div className="r-chart">
        <ExChart
          key={view}
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
            { key: "pi", label: "Trading", color: P.trading, stroke: S.trading },
            { key: "mm", label: "MM", color: P.mm, stroke: S.mm },
            { key: "inv", label: "Inv", color: P.inv, stroke: S.inv },
            { key: "hedge", label: "Hedge", color: P.hedge, stroke: S.hedge },
            { key: "reb", label: "Rebates", color: P.reb, stroke: S.reb },
            { key: "other", label: "Other", color: P.other, stroke: S.other },
          ]}
          boxRows={boxRows}
          emptyText="No days kept yet"
        />
      </div>

      <Sec
        title="By day"
        right={sum.missing ? `${sum.missing} without Day PnL` : "USDT"}
      >
        {days
          .slice()
          .reverse()
          .map((d) => (
            <DayItem key={d.day} d={d} today={d.day === todayKey} />
          ))}
        {!days.length && <Empty>No days kept yet</Empty>}
      </Sec>
    </>
  );
}

function DayItem({ d, today }: { d: DayRow; today: boolean }) {
  const money = useAmt();
  return (
    <Row
      title={
        <>
          {dayTitle(d.day)}
          {today && <span className="r-tag">Today</span>}
        </>
      }
      // what made the day: Trading and Hedge under the counts, Rebates under the figure (Other is small)
      sub={
        d.split ? (
          <>
            {int(d.fills)} fills · Vol {money(d.volume, "k")}
            <br />
            Trading {money(d.pi)} · Hedge {money(d.hedge)}
          </>
        ) : (
          `${int(d.fills)} fills · Vol ${money(d.volume, "k")}`
        )
      }
      sub2={d.split}
      value={<Amt v={d.pnl} />}
      valueSub={d.split ? `Rebates ${money(d.reb)}` : d.pnl != null ? "No split kept" : `Trading ${money(d.pi)} · no Day PnL`}
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
  const hide = useStore((s) => s.hideAmounts);
  const hedgeOf = useHedgePnl();
  // by today's volume; by name while amounts are hidden (the order would give the volumes away)
  const rows = useMemo(
    () =>
      (symbols ?? [])
        .filter((r) => r.fills_day > 0 || Math.abs(r.inv_value) >= 1 || r.trading_pnl !== 0)
        .sort((a, b) => (hide ? 0 : b.volume_day - a.volume_day || Math.abs(b.trading_pnl) - Math.abs(a.trading_pnl)) || a.symbol.localeCompare(b.symbol) || a.venue.localeCompare(b.venue)),
    [symbols, hide],
  );
  return (
    <Sec title="Traded today" right={hide ? "by name · Trading PnL" : "by volume · Trading PnL"}>
      {rows.map((r) => (
        <InstRow key={r.venue + r.symbol} r={r} hedge={hedgeOf(r)} money={money} />
      ))}
      {!rows.length && <Empty>No instrument traded today</Empty>}
    </Sec>
  );
}

function InstRow({
  r,
  hedge,
  money,
}: {
  r: SymbolRow;
  /** A perp's hedge leg today (a perp has no Trading PnL). */
  hedge: number | null;
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
      value={r.venue === "usdm" ? <Amt v={hedge} /> : <Amt v={r.trading_pnl} />}
      valueSub={r.venue === "usdm" ? "hedge leg" : edge != null ? `edge ${bps(edge)} bps` : undefined}
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
