import { useMemo } from "react";
import { useStore, serverNow } from "../../store";
import { getJSON, type History as Hist } from "../../api";
import { int, num } from "../../format";
import { C, HEDGE_COLOR, INVPNL_COLOR, MM_COLOR, REBATE_COLOR } from "../../theme";
import { ExChart, type ExBoxRow, type ExSeries } from "../../components/ex";
import { showInfo } from "../../components/mobile";
import { DAY, PART_INFO, useLoad } from "./shared";
import { Amt, Big, MASK, Row, Sec, Stats, amt, useAmt } from "./rest/ui";
import "./history.css";

const DEF_SE =
  "± is the likely error of the figure: its standard error, from how much the day's hourly results varied (Newey–West, lag 3).";
const OTHER = "#6b7484";

const PARTS = [
  { key: "mm", label: "Market making", short: "MM", color: MM_COLOR },
  { key: "inventory", label: "Inventory PnL", short: "Inv", color: INVPNL_COLOR },
  { key: "hedge", label: "Hedge", short: "Hedge", color: HEDGE_COLOR },
  { key: "rebates", label: "Rebates", short: "Reb", color: REBATE_COLOR },
  { key: "other", label: "Other", short: "Other", color: OTHER },
] as const;

/** One PnL day: its result, its path through the day on a chart, the split, the hedged views and the activity. */
export function DayM({ date }: { date: string }) {
  const days = useStore((s) => s.snap?.days);
  const dayStart = useStore((s) => s.snap?.summary.day_start ?? 0);
  const today = days?.[days.length - 1]?.day;
  const d = days?.find((x) => x.day === date);
  const money = useAmt();
  // the day's start: today's, moved back by whole days
  const start = today ? dayStart - Math.round((Date.parse(today + "T00:00:00Z") - Date.parse(date + "T00:00:00Z")) / DAY) * DAY : 0;
  if (!d) return <div className="r-empty">This day is not among the {days?.length ?? 0} the desk keeps.</div>;
  const live = date === today;
  const kept = d.pnl_day != null;
  const h = (s: number) => num(s / 3600, 1);

  return (
    <>
      <Big
        label={kept ? `Day PnL${live ? ", so far" : ""} (USDT)` : "Trading PnL (USDT)"}
        value={<Amt v={kept ? d.pnl_day : d.trading} />}
        sub={kept ? undefined : <>Day PnL was not recorded this day · ± {money(d.trading_se, "full")}</>}
      />
      <DayPath start={start} live={live} />

      {kept && (
        <Sec title="Split" right="USDT">
          {PARTS.map((p) => (
            <Row
              key={p.key}
              dense
              title={
                <>
                  <span className="h-sw" style={{ background: p.color }} />
                  {p.label}
                </>
              }
              value={<Amt v={d[p.key]} />}
              onClick={() => showInfo(p.label, PART_INFO[p.key])}
            />
          ))}
        </Sec>
      )}

      <Sec title="Hedged views" info={`Trading PnL: market making plus inventory PnL, fees included, not hedged. Ref-hedged and beta-hedged take off what the inventory would have made on its references, or on the beta instrument. ${DEF_SE}`} right="± likely error">
        <Stats
          cols={3}
          items={[
            ...(kept ? [{ label: "Trading PnL", value: <SeVal v={d.trading} se={d.trading_se} /> }] : []),
            {
              label: "Ref-hedged",
              info: "Trading PnL minus what the inventory would have made on each instrument's own reference, hedged with a 0–1 s delay. USDT. " + DEF_SE,
              value: <SeVal v={d.hedged} se={d.hedged_se} />,
            },
            {
              label: "Beta-hedged",
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
      </Sec>
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

type PathPt = { time: number; pnl: number; mm: number | null; inv: number | null; hedge: number | null; reb: number | null };

/** The day's PnL through the day, 5 min bars, with its parts as lines (chips). */
function DayPath({ start, live }: { start: number; live: boolean }) {
  const hide = useStore((s) => s.hideAmounts);
  const money = useAmt();
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
      mm: b.mm,
      inv: b.pi != null && b.mm != null ? b.pi - b.mm : null,
      hedge: b.hedge,
      reb: b.rebates,
    }));
  }, [data, start]);
  const by = useMemo(() => new Map(pts.map((p) => [p.time, p])), [pts]);
  const series = useMemo<ExSeries[]>(() => {
    const fmt = hide ? () => MASK : (x: number) => amt(x, "pnl");
    const line = (k: keyof PathPt, label: string, color: string, dashed?: boolean): ExSeries => ({
      key: k,
      kind: "line",
      label,
      color,
      format: fmt,
      lastValue: false,
      lineStyle: dashed ? "dashed" : "solid",
      data: pts.map((p) => ({ time: p.time, value: p[k] as number | null })),
    });
    return [
      { key: "pnl", kind: "baseline", label: "Day PnL", signColor: true, format: fmt, toggle: false, data: pts.map((p) => ({ time: p.time, value: p.pnl })) },
      line("mm", "MM", MM_COLOR),
      line("inv", "Inv", INVPNL_COLOR),
      line("hedge", "Hedge", HEDGE_COLOR, true),
      line("reb", "Reb", REBATE_COLOR),
    ];
  }, [pts, hide]);
  const boxRows = (t: number): ExBoxRow[] => {
    const p = by.get(t);
    if (!p) return [];
    const r = (label: string, v: number | null, color: string): ExBoxRow => [label, money(v), color];
    return [
      r("Day PnL", p.pnl, hide ? C.muted : p.pnl > 0 ? C.up : p.pnl < 0 ? C.down : C.ink),
      r("MM", p.mm, MM_COLOR),
      r("Inv", p.inv, INVPNL_COLOR),
      r("Hedge", p.hedge, HEDGE_COLOR),
      r("Reb", p.reb, REBATE_COLOR),
    ];
  };
  return (
    <div className="r-chart">
      <ExChart
        id="m-day"
        title="Day PnL"
        series={series}
        height={240}
        fullscreen
        chips
        loading={hist.loading && !data}
        emptyText={hist.err ? "Could not load the day's path" : "No path kept for this day"}
        resetKey={start}
        boxRows={boxRows}
      />
    </div>
  );
}
