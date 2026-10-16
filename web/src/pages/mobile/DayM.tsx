import { useMemo } from "react";
import { useStore, serverNow } from "../../store";
import { getJSON, type History as Hist } from "../../api";
import { int, num } from "../../format";
import { C, PNL_COLORS as P, PNL_STROKES as S, type Stroke } from "../../theme";
import { ExChart, SeriesKey, type ExBoxRow, type ExSeries } from "../../components/ex";
import { showInfo } from "../../components/mobile";
import { DAY, PART_INFO, useLoad } from "./shared";
import { Amt, Big, Row, Sec, Stats, amt, useAmt } from "./rest/ui";
import { MASK } from "../../mask";
import "./rest/assets.css";
import "./history.css";

const DEF_SE =
  "± is the likely error of the figure: its standard error, from how much the day's hourly results varied (Newey–West, lag 3).";
// the split as the desk lists it: Trading PnL as the subtotal of its two parts, then the rest
const PARTS = [
  { key: "trading", label: "Trading PnL", color: P.trading, stroke: S.trading, sub: false },
  { key: "mm", label: "Market making", color: P.mm, stroke: S.mm, sub: true },
  { key: "inventory", label: "Inventory PnL", color: P.inv, stroke: S.inv, sub: true },
  { key: "hedge", label: "Hedge", color: P.hedge, stroke: S.hedge, sub: false },
  { key: "rebates", label: "Rebates", color: P.reb, stroke: S.reb, sub: false },
  { key: "other", label: "Other", color: P.other, stroke: S.other, sub: false },
] as const satisfies readonly { key: string; label: string; color: string; stroke: Stroke; sub: boolean }[];
const TRADING_INFO = "Market making plus inventory PnL, fees included; not hedged. USDT.";

/** One PnL day: its result, its path through the day on a chart, the split, the hedged views and the activity. */
export function DayM({ date }: { date: string }) {
  const days = useStore((s) => s.snap?.days);
  const dayStart = useStore((s) => s.snap?.summary.day_start ?? 0);
  const today = days?.[days.length - 1]?.day;
  const d = days?.find((x) => x.day === date);
  const money = useAmt();
  // the day's start: today's, moved back by whole days
  const start = today ? dayStart - Math.round((Date.parse(today + "T00:00:00Z") - Date.parse(date + "T00:00:00Z")) / DAY) * DAY : 0;
  const live = date === today;
  const path = useDayPath(start, live);
  const kept = d?.pnl_day != null;
  // Day PnL as the History list has it: the desk's own figure, else the day's change on the equity history
  const fromPath = path.pts.length ? path.pts[path.pts.length - 1]!.pnl : null;
  const pnl = kept ? d!.pnl_day : fromPath;
  if (!d && !path.pts.length) {
    if (path.loading) return <DayPath start={start} path={path} />;
    return <div className="r-empty">This day is not among the {days?.length ?? 0} the desk keeps.</div>;
  }
  const h = (s: number) => num(s / 3600, 1);

  return (
    <>
      <Big
        label={`Day PnL${live ? ", so far" : ""} (USDT)`}
        value={<Amt v={pnl} />}
        sub={
          kept ? undefined : pnl != null ? (
            <>From the equity history: the split was not kept this day</>
          ) : (
            <>No Day PnL this day · Trading {money(d?.trading)} ± {money(d?.trading_se, "full")}</>
          )
        }
      />
      <DayPath start={start} path={path} />
      {!d && <div className="r-empty">Only the equity history is kept for this day.</div>}

      {d && kept && (
        <Sec title="Split" right="USDT">
          {PARTS.map((p) => (
            <Row
              key={p.key}
              dense
              title={
                <span className={"h-part" + (p.sub ? " sub" : "")}>
                  <SeriesKey color={p.color} stroke={p.stroke} />
                  {p.label}
                </span>
              }
              value={<Amt v={d![p.key]} />}
              onClick={() => showInfo(p.label, p.key === "trading" ? TRADING_INFO : PART_INFO[p.key])}
            />
          ))}
        </Sec>
      )}
      {d && !kept && d.trading != null && (
        <Sec title="Split" right="USDT">
          <Row dense title="Trading PnL" value={<Amt v={d.trading} />} onClick={() => showInfo("Trading PnL", TRADING_INFO + " The rest of the split was not kept this day.")} />
        </Sec>
      )}

      {d && <><Sec title="Trading PnL if hedged" info={`Trading PnL minus what the inventory would have made on its references (hedged on refs), or on the beta instrument (hedged on beta). ${DEF_SE}`} right="± likely error">
        <Stats
          cols={3}
          items={[
            { label: "Not hedged", value: <SeVal v={d.trading} se={d.trading_se} /> },
            {
              label: "On refs",
              info: "Trading PnL minus what the inventory would have made on each instrument's own reference, hedged with a 0–1 s delay. USDT. " + DEF_SE,
              value: <SeVal v={d.hedged} se={d.hedged_se} />,
            },
            {
              label: "On beta",
              info: "Trading PnL minus what the inventory would have made on the beta instrument, each market weighted by its beta. USDT. " + DEF_SE,
              value: <SeVal v={d.factor} se={d.factor_se} />,
            },
          ]}
        />
      </Sec>

      <Sec title="Activity">
        <Stats
          cols={3}
          items={[
            { label: "Fills", value: int(d.fills) },
            { label: "Volume (USDT)", value: money(d.volume, "k") },
            {
              label: "Hours covered",
              info:
                `Hours of the day the trading figures cover: ${h(d.covered_s)} h recorded live` +
                (d.backfilled_s > 0 ? `, ${h(d.backfilled_s)} h rebuilt from 1-minute candles where the monitor was down.` : "."),
              value: `${h(d.covered_s + d.backfilled_s)} h`,
            },
          ]}
        />
      </Sec></>}
    </>
  );
}

function SeVal({ v, se }: { v: number | null; se: number | null }) {
  const money = useAmt();
  return (
    <>
      <Amt v={v} />
      <span className="h-se"> ±{se == null ? "--" : money(se, "full")}</span>
    </>
  );
}

type PathPt = { time: number; pnl: number; trading: number | null; mm: number | null; inv: number | null; hedge: number | null; reb: number | null; other: number | null };

type DayPathLoad = { pts: PathPt[]; loading: boolean; err: string | null };

/** The day's 5 min bars from /api/history: Day PnL from the day's start and its parts. */
function useDayPath(start: number, live: boolean): DayPathLoad {
  const key = start ? `day|${start}` : null;
  const hist = useLoad<Hist>(
    key,
    (signal) => getJSON<Hist>("/api/history", { from: start, to: Math.min(start + DAY, serverNow()), step: 300 }, signal),
    live ? 60_000 : 0,
  );
  const data = hist.key === key ? hist.data : null;
  const pts = useMemo<PathPt[]>(() => {
    const bars = (data?.bars ?? []).filter((b) => b.t < start + DAY);
    const o = bars[0]?.o ?? 0;
    return bars.map((b) => ({
      time: b.t,
      pnl: b.c - o,
      trading: b.pi,
      mm: b.mm,
      inv: b.pi != null && b.mm != null ? b.pi - b.mm : null,
      hedge: b.hedge,
      reb: b.rebates,
      other: b.pi != null && b.rebates != null ? b.c - o - b.pi - (b.hedge ?? 0) - b.rebates : null,
    }));
  }, [data, start]);
  return { pts, loading: hist.loading && !data, err: hist.err };
}

/** The day's PnL through the day, 5 min bars, with its parts as lines (chips). */
function DayPath({ start, path }: { start: number; path: DayPathLoad }) {
  const hide = useStore((s) => s.hideAmounts);
  const money = useAmt();
  const pts = path.pts;
  const by = useMemo(() => new Map(pts.map((p) => [p.time, p])), [pts]);
  const series = useMemo<ExSeries[]>(() => {
    const fmt = hide ? () => MASK : (x: number) => amt(x, "pnl");
    const line = (k: keyof PathPt, label: string, color: string, stroke: Stroke): ExSeries => ({
      key: k,
      kind: "line",
      label,
      color,
      format: fmt,
      lastValue: false,
      width: 1.5,
      lineStyle: stroke,
      data: pts.map((p) => ({ time: p.time, value: p[k] as number | null })),
    });
    // a day kept without its split: only the lines it has (no chips that switch nothing)
    const has = (k: keyof PathPt) => pts.some((p) => p[k] != null);
    return [
      { key: "pnl", kind: "baseline", label: "Day PnL", signColor: true, format: fmt, toggle: false, data: pts.map((p) => ({ time: p.time, value: p.pnl })) },
      ...(has("trading") ? [line("trading", "Trading", P.trading, S.trading)] : []),
      ...(has("mm") ? [line("mm", "MM", P.mm, S.mm), line("inv", "Inv", P.inv, S.inv)] : []),
      ...(has("hedge") ? [line("hedge", "Hedge", P.hedge, S.hedge)] : []),
      ...(has("reb") ? [line("reb", "Rebates", P.reb, S.reb), line("other", "Other", P.other, S.other)] : []),
    ];
  }, [pts, hide]);
  const boxRows = (t: number): ExBoxRow[] => {
    const p = by.get(t);
    if (!p) return [];
    const r = (label: string, v: number | null, color: string): ExBoxRow => [label, money(v), color];
    const rows: ExBoxRow[] = [r("Day PnL", p.pnl, hide ? C.muted : p.pnl > 0 ? C.up : p.pnl < 0 ? C.down : C.ink)];
    if (p.trading != null) rows.push(r("Trading", p.trading, P.trading));
    if (p.mm != null) rows.push(r("MM", p.mm, P.mm), r("Inv", p.inv, P.inv));
    if (p.hedge != null) rows.push(r("Hedge", p.hedge, P.hedge));
    if (p.reb != null) rows.push(r("Rebates", p.reb, P.reb), r("Other", p.other, P.other));
    return rows;
  };
  return (
    <div className="r-chart">
      <ExChart
        id="m-day"
        title="Day PnL through the day, 5 min"
        toolbarLeft={<span className="a-chart-t">Through the day, 5 min</span>}
        series={series}
        height={240}
        fullscreen
        chips={series.length > 1}
        loading={path.loading}
        emptyText={path.err ? "Could not load the day's path" : "No path kept for this day"}
        resetKey={start}
        boxRows={boxRows}
      />
    </div>
  );
}
