import { Fragment, useMemo, useRef } from "react";
import { useStore } from "../../store";
import { useThrottled } from "../../hooks";
import { bps, compact, hm, int } from "../../format";
import { C } from "../../theme";
import { ExChart, Tabs, rgba, useExPref, type ExBoxRow, type ExLegendItem, type ExSeries } from "../../components/ex";
import { REF_LINE } from "../../components/ex/palette";
import type { SymbolRow } from "../../protocol";
import { oneCol, oneColWord, useHedgePnl } from "../../selectors";
import { IV_LABEL, STEP_S, daySummary, deskRows, rangeFrom, useDeskHistory, useRangeDays, weekBars, type DayRow, type HInterval, type Row as KRow } from "../history/data";
import { dayTitle } from "./index";
import { Amt, Empty, PageTabs, Row, Sec, amt, useAmt } from "./rest/ui";
import { BestWorst, Calendar, Split, Summary } from "./history/DeskParts";
import "./history.css";
import { MASK } from "../../mask";
import { cur, useDesk, isHedge, notionalCur, venueTag } from "../../desk";

// ---- History: the desk's days (the running P&L as day candles, then the list), or the instruments. The chart holds every day
// kept (a year at most: a few KB), and the summary and the list cover all of them: no range to pick ----

type Tab = "desk" | "inst";
// the phone's intervals: hours (today's and the last days'), days, weeks; 15 minutes are too fine to read here
const IVS: HInterval[] = ["1h", "4h", "1d", "1w"];
const IV_OPTS = IVS.map((v) => ({ value: v, label: IV_LABEL[v] }));

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
  const hide = useStore((s) => s.hideAmounts);
  const tz = useStore((s) => s.tz);
  const money = useAmt();
  // every day kept, as the desktop History has them (the snapshot's kept days and the day bars of /api/history)
  const dayStart = useStore((s) => s.snap?.summary.day_start ?? null);
  const from = dayStart == null ? null : rangeFrom("all", dayStart);
  const { rows, todayDay: todayKey } = useRangeDays(from);
  const sum = useMemo(() => daySummary(rows, todayKey), [rows, todayKey]);

  // the chart: the running P&L as candles (each opens where the one before closed), volume under it
  const [iv, setIv] = useExPref<HInterval>("m-hist", "interval", "1d", IVS);
  const bars = useDeskHistory(STEP_S[iv], from);
  const prev = useRef<KRow[] | null>(null);
  const kRows = useMemo(() => {
    if (dayStart == null || !bars.bars.length) return (prev.current = []);
    const r = iv === "1w" ? deskRows(weekBars(bars.bars), "week", dayStart, null) : deskRows(bars.bars, "day", dayStart, prev.current);
    prev.current = r;
    return r;
  }, [bars.bars, iv, dayStart]);
  const byT = useMemo(() => new Map(kRows.map((r) => [r.t, r])), [kRows]);
  const dayAt = useMemo(() => new Map(rows.map((d) => [d.start, d])), [rows]);
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
      {
        key: "vol",
        kind: "histogram",
        label: `Vol(${notionalCur()})`,
        pane: 1,
        toggle: false,
        color: rgba(C.ink2, 0.32),
        lastValue: false,
        format: hide ? () => MASK : (v: number) => compact(v),
        data: kRows.map((r) => ({ time: r.t, value: r.volume })),
      },
    ];
  }, [kRows, hide]);
  const word = iv === "1w" ? "Week" : iv === "1d" ? "Day" : "Bar";
  const boxRows = (t: number): ExBoxRow[] => {
    const k = byT.get(t);
    if (!k) return [];
    const d = iv === "1d" ? dayAt.get(t) : undefined;
    const tone = (v: number | null | undefined): string => (hide ? C.muted : v! > 0 ? C.up : v! < 0 ? C.down : C.ink);
    return [
      [word, iv === "1d" ? (d?.day ?? new Date(t).toISOString().slice(0, 10)) : iv === "1w" ? `from ${new Date(t).toISOString().slice(0, 10)}` : hm(t, tz)],
      ["Cumulative", money(k.cum), tone(k.cum)],
      [`${word} PnL`, money(d?.pnl ?? k.pnl), tone(d?.pnl ?? k.pnl)],
      ["Fills", int(d?.fills ?? k.fills)],
    ];
  };
  const legendExtra = useMemo<ExLegendItem[]>(() => [{ label: "Fills", pane: 1, line: 1, value: (t) => [int(byT.get(t)?.fills), C.ink] }], [byT]);
  const zeroLine = useMemo(() => [{ series: "k", price: 0, color: REF_LINE, style: "solid" as const, axisLabel: false }], []);
  // intraday bars open on the last days (a year of hours does not read on a phone); days and weeks on all of them
  const initial = iv === "1h" ? 72 : iv === "4h" ? 42 : kRows.length;

  // By day | By hour (today)
  const [tab, setTab] = useExPref<"day" | "hour">("m-hist", "table", "day", ["day", "hour"]);
  const hours = useDeskHistory(3600, tab === "hour" ? dayStart : null);
  const hourRows = useMemo(() => (dayStart == null ? [] : deskRows(hours.bars, "day", dayStart, null).slice().reverse()), [hours.bars, dayStart]);
  // the first day (newest first) from before the desk kept a split: the list says so once, there
  const firstUnsplit = rows.findIndex((d) => !d.split && d.pnl != null);

  return (
    <>
      <Summary sum={sum} rows={rows} />
      <div className="r-chart hm-chart">
        <ExChart
          id="m-hist-k"
          title="Desk PnL"
          series={series}
          paneStretch={[1, 0.22]}
          height={300}
          intervals={IV_OPTS}
          interval={iv}
          onInterval={(v) => setIv(v as HInterval)}
          loading={bars.loading || from == null}
          initialBars={Math.max(2, Math.min(initial, kRows.length))}
          resetKey={iv}
          rightOffset={0.6}
          fixEdges
          fullscreen
          legendRest="names"
          legendExtra={legendExtra}
          priceLines={zeroLine}
          boxRows={boxRows}
          emptyText={bars.error ? "Could not load the history" : "No days kept yet"}
        />
      </div>

      <Split rows={rows} sum={sum} />
      <Calendar rows={rows} todayDay={todayKey} />
      <BestWorst rows={rows} todayDay={todayKey} />

      <Sec className="hm-tables">
        <div className="hm-tabs">
          <Tabs
            items={[
              { value: "day", label: "By day" },
              { value: "hour", label: "By hour (today)" },
            ]}
            value={tab}
            onChange={setTab}
            right={<span className="hm-tabs-r">{tab === "day" && sum.missing ? `${sum.missing} without Day PnL` : cur()}</span>}
          />
        </div>
        {tab === "day" ? (
          <>
            {rows.map((d, i) => (
              <Fragment key={d.day}>
                {i === firstUnsplit && <div className="hm-div">Before the split was kept: Day PnL only</div>}
                <DayItem d={d} today={d.day === todayKey} />
              </Fragment>
            ))}
            {!rows.length && <Empty>No days kept yet</Empty>}
          </>
        ) : (
          <>
            {hourRows.map((r) => (
              <Row key={r.t} dense title={hm(r.t, tz)} sub={`${int(r.fills)} fills · Vol ${money(r.volume, "k")}`} value={<Amt v={r.pnl} />} />
            ))}
            {!hourRows.length && <Empty>{hours.loading ? "Loading" : "No hours yet today"}</Empty>}
          </>
        )}
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
      // what made the day: market making and inventory (or the trading P&L) and the hedge under the counts, the rebates
      // under the figure (Other is small)
      sub={
        d.split ? (
          <>
            {int(d.fills)} fills · Vol {money(d.volume, "k")}
            <br />
            {desk.mm ? (
              <>
                MM {money(d.mm)} · Inv {money(d.inv)}
              </>
            ) : (
              <>Trading {money(d.pi)}</>
            )}
            {desk.hedge && <> · Hedge {money(d.hedge)}</>}
          </>
        ) : (
          `${int(d.fills)} fills · Vol ${money(d.volume, "k")}`
        )
      }
      sub2={d.split}
      value={<Amt v={d.pnl} />}
      valueSub={d.split ? (desk.rebates ? `Rebates ${money(d.reb)}` : undefined) : d.pnl == null ? `Trading ${money(d.pi)} · no Day PnL` : undefined}
      to={{ page: "history", detail: { kind: "day", date: d.day } }}
    />
  );
}

// ---- instruments: today's figures; a tap opens the instrument's candles with our fills ----

function Instruments() {
  const desk = useDesk();
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
    <Sec title="Traded today" right={`${hide ? "by name" : "by volume"} · ${oneColWord(desk.mm)}`}>
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
  const desk = useDesk();
  return (
    <Row
      title={
        <>
          {r.symbol}
          {venueTag(r.venue) && <span className="r-tag">{venueTag(r.venue)}</span>}
        </>
      }
      sub={`${int(r.fills_day)} fills · Vol ${money(r.volume_day, "k")}`}
      value={isHedge(r) ? <Amt v={hedge} /> : <Amt v={oneCol(r, desk.mm)} />}
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
