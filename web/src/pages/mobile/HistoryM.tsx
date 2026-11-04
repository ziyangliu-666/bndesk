import { useMemo } from "react";
import { navigate, useStore } from "../../store";
import { useThrottled } from "../../hooks";
import { bps, compact, int } from "../../format";
import { C } from "../../theme";
import {
  ExChart,
  useExPref,
  type ExBoxRow,
  type ExSeries,
} from "../../components/ex";
import type { SymbolRow } from "../../protocol";
import { useHedgePnl } from "../../selectors";
import { daySummary, deskRows, rangeFrom, summaryNote, useDeskHistory, useRangeDays, type DayRow, type Range as HRange } from "../history/data";
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
import { cur, earlierNote, useDesk, isHedge, venueTag } from "../../desk";

// ---- History: the desk's days (the running P&L as day candles, then the list), or the instruments. The chart holds every day
// kept (a year at most: a few KB), and the summary and the list cover all of them: no range to pick ----

type Tab = "desk" | "inst";
type Range = "7" | "30" | "90" | "all";
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
  const range: Range = "all";
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

  // the chart: the running P&L as day candles (each opens where the day before closed), from the day bars
  const bars = useDeskHistory(86_400, from);
  const kRows = useMemo(() => (dayStart == null ? [] : deskRows(bars.bars, "day", dayStart, null)), [bars.bars, dayStart]);
  const dayAt = useMemo(() => new Map(days.map((d) => [d.start, d])), [days]);
  const series = useMemo<ExSeries[]>(() => {
    const fmt = hide ? () => MASK : (x: number) => amt(x, "pnl");
    return [
      {
        key: "k",
        kind: "candles",
        label: "Cumulative PnL",
        toggle: false,
        format: fmt,
        data: kRows.map((r) => {
          const off = r.cum - r.c;
          return { time: r.t, open: r.o + off, high: Math.max(r.h, r.o, r.c) + off, low: Math.min(r.l, r.o, r.c) + off, close: r.cum };
        }),
      },
    ];
  }, [kRows, hide]);
  const boxRows = (t: number): ExBoxRow[] => {
    const k = kRows.find((r) => r.t === t);
    if (!k) return [];
    const d = dayAt.get(t);
    const r = (label: string, v: number | null | undefined): ExBoxRow => [
      label,
      money(v),
      hide ? C.muted : v! > 0 ? C.up : v! < 0 ? C.down : C.ink,
    ];
    return [
      ["Day", d?.day ?? new Date(t).toISOString().slice(0, 10)],
      r("Cumulative", k.cum),
      r("Day PnL", d?.pnl ?? k.pnl),
      ["Fills", int(d?.fills ?? k.fills)],
    ];
  };

  const label = `PnL, all days (${cur()})`;

  return (
    <>
      <div className="h-sum">
        <div className="h-sum-l">
          <div className="h-sum-label">{label}</div>
          <Amt v={sum.total} className="h-sum-v" />
          {rows.length > 0 && <div className="h-sum-note">{summaryNote(sum)}</div>}
          {earlierNote() && <div className="h-sum-note" title={earlierNote()!.title}>{earlierNote()!.text}</div>}
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
          id="m-hist-k"
          title="Desk PnL"
          series={series}
          height={280}
          loading={bars.loading}
          initialBars={Math.max(2, kRows.length)}
          resetKey={range}
          rightOffset={0.6}
          fixEdges
          fullscreen
          legendRest="names"
          boxRows={boxRows}
          emptyText="No days kept yet"
        />
      </div>

      <Sec
        title="By day"
        right={sum.missing ? `${sum.missing} without Day PnL` : cur()}
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
  const desk = useDesk();
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
            Trading {money(d.pi)}
            {desk.hedge && <> · Hedge {money(d.hedge)}</>}
          </>
        ) : (
          `${int(d.fills)} fills · Vol ${money(d.volume, "k")}`
        )
      }
      sub2={d.split}
      value={<Amt v={d.pnl} />}
      valueSub={d.split ? (desk.rebates ? `Rebates ${money(d.reb)}` : undefined) : d.pnl != null ? "No split kept" : `Trading ${money(d.pi)} · no Day PnL`}
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
  /** Its hedge leg today, for what hedges (it has no Trading PnL). */
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
          {venueTag(r.venue) && <span className="r-tag">{venueTag(r.venue)}</span>}
        </>
      }
      sub={`${int(r.fills_day)} fills · Vol ${money(r.volume_day, "k")}`}
      value={isHedge(r) ? <Amt v={hedge} /> : <Amt v={r.trading_pnl} />}
      valueSub={isHedge(r) ? "hedge leg" : edge != null ? `edge ${bps(edge)} bps` : undefined}
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
