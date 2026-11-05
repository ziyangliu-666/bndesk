// The phone History's desk parts: the summary, the split (adding up to the PnL), the last five weeks and the
// best and worst days. The same sums as the desktop's right column (pages/history/Side.tsx).
import { useMemo } from "react";
import { navigate, useStore } from "../../../store";
import { compact, int, num, signClass } from "../../../format";
import { maskText } from "../../../mask";
import { SeriesKey } from "../../../components/ex";
import { PART_META } from "../../history/DeskChart";
import { sumDays, type DayRow, type DaySummary, type Part } from "../../history/data";
import { cur, earlierNote, useDesk } from "../../../desk";
import { dayTitle } from "../index";
import { Amt, Row, Sec } from "../rest/ui";

const openDay = (day: string) => navigate({ page: "history", detail: { kind: "day", date: day } });
const sg = (v: number | null | undefined) => (v == null ? "--" : num(v, 2, true));

/** The PnL large, then four quieter figures on one line, then what the figures cover. */
export function Summary({ sum, rows }: { sum: DaySummary; rows: DayRow[] }) {
  const hide = useStore((s) => s.hideAmounts);
  const m = (s: string) => maskText(hide, s);
  const tone = (v: number | null | undefined) => (hide ? "masked" : signClass(v));
  const has = rows.length > 0;
  const early = earlierNote();
  return (
    <div className="hm-sum">
      <div className="hm-sum-l">PnL, all days ({cur()})</div>
      <Amt v={sum.total} className="hm-sum-v" />
      <div className="hm-figs">
        <div>
          <span>Average day</span>
          <b className={tone(sum.average)}>{m(sg(sum.average))}</b>
        </div>
        <div>
          <span>Days up</span>
          <b>{sum.finished ? `${sum.up} of ${sum.finished}` : "--"}</b>
        </div>
        <div>
          <span>Fills</span>
          <b>{has ? compact(sum.fills) : "--"}</b>
        </div>
        <div>
          <span>Volume</span>
          <b className={hide ? "masked" : ""}>{has ? m(compact(sum.volume)) : "--"}</b>
        </div>
      </div>
      {has && (
        <div className="hm-note">
          {sum.days} day{sum.days === 1 ? "" : "s"}
          {sum.today ? ", today so far included" : ""}
          {sum.missing > 0 && ` · ${sum.missing} without Day PnL, not counted`}
          {early && <> · {early.text}</>}
        </div>
      )}
    </div>
  );
}

/** The split over every day: market making and inventory PnL (with no split kept: the trading P&L), then hedge,
 *  rebates and other; the days from
 *  before the desk kept a split as one row, so the rows add up to the PnL. */
export function Split({ rows, sum }: { rows: DayRow[]; sum: DaySummary }) {
  const hide = useStore((s) => s.hideAmounts);
  const d = useDesk();
  const tot = useMemo(() => sumDays(rows), [rows]);
  const unsplit = useMemo(() => {
    const xs = rows.filter((r) => !r.split && r.pnl != null);
    return xs.length ? xs.reduce((k, r) => k + r.pnl!, 0) : null;
  }, [rows]);
  const parts: Part[] = (["pi", "mm", "inv", "hedge", "reb", "other"] as Part[]).filter((k) =>
    k === "hedge" ? d.hedge : k === "reb" ? d.rebates : k === "mm" || k === "inv" ? d.mm : k === "pi" ? !d.mm : true,
  );
  const max = Math.max(1e-9, ...parts.map((k) => Math.abs(tot[k] ?? 0)), Math.abs(unsplit ?? 0));
  if (!rows.length) return null;
  const line = (key: string, label: string, v: number | null, opts: { color?: string; stroke?: (typeof PART_META)[Part]["style"]; sub?: boolean; bar?: boolean }) => (
    <div className={"hm-split-r" + (opts.sub ? " sub" : "")} key={key}>
      <span className="hm-split-k">{opts.color ? <SeriesKey color={opts.color} stroke={opts.stroke} /> : null}</span>
      <span className="hm-split-n">{label}</span>
      <span className="hm-split-bar">{opts.bar && v != null && !hide && <i style={{ width: `${(Math.abs(v) / max) * 100}%` }} />}</span>
      <Amt v={v} className="hm-split-v" />
    </div>
  );
  return (
    <Sec title="Split" right={cur()}>
      <div className="hm-split">
        {parts.map((k) => line(k, PART_META[k].long, tot[k], { color: PART_META[k].color, stroke: PART_META[k].style, bar: true }))}
        {unsplit != null && line("before", `Before the split (${sum.unsplit} d)`, unsplit, { bar: true })}
      </div>
    </Sec>
  );
}

const DOW = ["M", "T", "W", "T", "F", "S", "S"];
const DAYMS = 86_400_000;

/** Five weeks, Monday first, ending with this week; each kept day its P&L, a tap opens it. */
export function Calendar({ rows, todayDay }: { rows: DayRow[]; todayDay: string | null }) {
  const hide = useStore((s) => s.hideAmounts);
  const byDay = useMemo(() => new Map(rows.map((r) => [r.day, r])), [rows]);
  if (!todayDay || !rows.length) return null;
  const today = Date.parse(todayDay + "T00:00:00Z");
  const dow = (new Date(today).getUTCDay() + 6) % 7;
  // five weeks, less the leading weeks before the first day kept (a young desk has no row of blanks)
  const first = rows.reduce((m, r) => Math.min(m, Date.parse(r.day + "T00:00:00Z")), Infinity);
  let weeks = 5;
  while (weeks > 1 && today - (dow + (weeks - 1) * 7) * DAYMS + 7 * DAYMS <= first) weeks--;
  const start = today - (dow + (weeks - 1) * 7) * DAYMS;
  const cells = [];
  for (let i = 0; i < weeks * 7; i++) {
    const t = start + i * DAYMS;
    const day = new Date(t).toISOString().slice(0, 10);
    const r = byDay.get(day);
    const future = t > today;
    const cls = "hm-cal-c" + (r ? "" : " out") + (day === todayDay ? " today" : "");
    const fig = future ? "" : r && r.pnl != null ? maskText(hide, num(r.pnl, 0, true)) : r ? "--" : "";
    cells.push(
      <button type="button" key={day} disabled={!r} className={cls} onClick={() => r && openDay(day)} aria-label={dayTitle(day)}>
        <i>{new Date(t).getUTCDate()}</i>
        <b className={r ? (hide ? "masked" : signClass(r.pnl)) : ""}>{fig}</b>
      </button>,
    );
  }
  return (
    <Sec title={`Last ${weeks} weeks`} right={cur()}>
      <div className="hm-cal">
        {DOW.map((d, i) => (
          <span key={i} className="hm-cal-h">
            {d}
          </span>
        ))}
        {cells}
      </div>
    </Sec>
  );
}

/** The two best and two worst finished days (today is still moving). Not shown with amounts hidden: the order
 *  would tell them. */
export function BestWorst({ rows, todayDay }: { rows: DayRow[]; todayDay: string | null }) {
  const hide = useStore((s) => s.hideAmounts);
  const ranked = useMemo(() => rows.filter((r) => r.pnl != null && r.day !== todayDay).sort((a, b) => b.pnl! - a.pnl!), [rows, todayDay]);
  if (hide || !ranked.length) return null;
  const nb = Math.min(2, Math.ceil(ranked.length / 2));
  const best = ranked.slice(0, nb);
  const worst = ranked.slice(nb).slice(-2).reverse();
  const item = (r: DayRow) => (
    <Row key={r.day} dense title={dayTitle(r.day)} sub={`${int(r.fills)} fills`} value={<Amt v={r.pnl} />} onClick={() => openDay(r.day)} />
  );
  return (
    <>
      <Sec title="Best days">{best.map(item)}</Sec>
      {worst.length > 0 && <Sec title="Worst days">{worst.map(item)}</Sec>}
    </>
  );
}
