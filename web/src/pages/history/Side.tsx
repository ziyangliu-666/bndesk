// The History page's right column: the range in figures (label over value), the split, a calendar of the
// last five weeks and the best and worst days; for an instrument, our fills over the range and the market's.
import { useMemo } from "react";
import type { HistFill } from "../../api";
import type { Candle } from "../../components/ex";
import type { SymbolRow } from "../../protocol";
import { bps, compact, int, num, price, signClass } from "../../format";
import { PART_META } from "./DeskChart";
import { daySummary, sumDays, summaryNote, type DayRow, type Part } from "./data";
import { maskText, qtyText } from "../../mask";
import { instPnl, useLegPnl } from "../../selectors";

const sg = (v: number | null | undefined, d = 2) => (v == null ? "--" : num(v, d, true));

/** Label over value. `title` is a tooltip; `dot` marks a term a trader may not know (dotted, a definition). */
function Fig({ label, value, tone, title, big, dot }: { label: string; value: string; tone?: string; title?: string; big?: boolean; dot?: boolean }) {
  return (
    <div className={"hx-fig" + (big ? " big" : "")}>
      <span className={"hx-fig-l" + (dot ? " dotted" : "")} title={title}>
        {label}
      </span>
      <span className={"hx-fig-v " + (tone ?? "")}>{value}</span>
    </div>
  );
}

export function DeskSide({
  rows,
  title,
  todayDay,
  selected,
  day,
  onDay,
  onClearDay,
  intraday,
  onIntraday,
  hide,
}: {
  rows: DayRow[];
  title: string;
  todayDay: string | null;
  selected: string | null;
  /** The chosen day: its figures replace the range's at the top. */
  day: DayRow | null;
  onDay: (day: string) => void;
  onClearDay: () => void;
  /** The chart is on an intraday interval. */
  intraday: boolean;
  /** Switch the chart between the chosen day's intraday bars and the days. */
  onIntraday: () => void;
  hide: boolean;
}) {
  const tot = useMemo(() => (day ? day : sumDays(rows)), [rows, day]);
  // the same summary as the phone's: today counts in the total only; days without a Day PnL in none
  const sm = useMemo(() => daySummary(rows, todayDay), [rows, todayDay]);
  const ranked = rows.filter((r) => r.pnl != null && r.day !== todayDay).sort((a, b) => b.pnl! - a.pnl!);
  const best = ranked.length > 3 ? [...ranked.slice(0, 2), ...ranked.slice(-2)] : ranked;
  const parts: Part[] = ["mm", "inv", "hedge", "reb", "other", "pi"];
  const max = Math.max(1e-9, ...parts.filter((k) => k !== "pi").map((k) => Math.abs(tot[k] ?? 0)));
  const m = (s: string) => maskText(hide, s);
  const tone = (v: number | null | undefined) => (hide ? "masked" : signClass(v));
  return (
    <>
      {day ? (
        <>
          {/* the chosen day: its figures and split; the chart zooms to it and its legend reads it */}
          <div className="hx-side-head">
            <span className="hx-side-title">
              {day.day}
              {day.day === todayDay && <span className="hx-tag">Today</span>}
            </span>
            <button type="button" className="hx-link" onClick={onClearDay} title={`Back to ${title}`} aria-label={`Back to ${title}`}>
              ✕
            </button>
          </div>
          <div className="hx-figs">
            <Fig big label="Day PnL" value={m(sg(day.pnl))} tone={tone(day.pnl)} />
            <Fig label="Fills" value={int(day.fills)} />
            <Fig label="Volume" value={m(compact(day.volume))} tone={hide ? "masked" : undefined} title="Filled notional, USDT" />
            <div className="hx-fig">
              <span className="hx-fig-l">Chart</span>
              <button type="button" className="hx-link hx-fig-v" onClick={onIntraday} title={intraday ? "Back to one bar a day" : "The day in 15 minute bars, as on the phone's day page"}>
                {intraday ? "Days (1D)" : "Intraday (15m)"}
              </button>
            </div>
          </div>
          {!day.split && <div className="hx-note muted">The desk kept no split this day.</div>}
        </>
      ) : (
        <>
          <div className="hx-side-head">
            <span className="hx-side-title">{title}</span>
            <span className="muted">USDT</span>
          </div>
          <div className="hx-figs">
            <Fig big label="PnL" value={m(sg(sm.total))} tone={tone(sm.total)} title={summaryNote(sm)} dot={sm.missing > 0} />
            <Fig label="Average day" value={m(sg(sm.average))} tone={tone(sm.average)} title="Over the finished days (today left out)" />
            <Fig label="Days up" value={sm.finished ? `${sm.up} of ${sm.finished}` : "--"} title="Finished days that made money, of the finished days with a Day PnL" />
            <Fig label="Fills" value={rows.length ? int(sm.fills) : "--"} />
            <Fig label="Volume" value={rows.length ? m(compact(sm.volume)) : "--"} tone={hide ? "masked" : undefined} title="Filled notional, USDT" />
          </div>
          {sm.missing > 0 && <div className="hx-note muted">{sm.missing === 1 ? "1 day has" : `${sm.missing} days have`} no Day PnL (only trading PnL was kept): not in these figures.</div>}
        </>
      )}
      <div className="hx-sect" title={!day && sm.unsplit ? "The parts are kept only for the days the desk recorded its split" : undefined}>
        Split{!day && sm.unsplit > 0 && <span className="muted"> · {rows.length - sm.unsplit} of {rows.length} days</span>}
      </div>
      <div className="hx-split">
        {parts.map((k) => {
          const v = tot[k];
          const meta = PART_META[k];
          return (
            <div className="hx-split-row" key={k}>
              <span className="hx-sw" style={{ background: meta.color }} />
              <span className={meta.title && (k === "pi" || k === "other") ? "dotted" : undefined} title={meta.title}>
                {meta.long}
              </span>
              <span className="hx-bar-cell">{k !== "pi" && v != null && <span className="hx-bar" style={{ width: `${(Math.abs(v) / max) * 100}%` }} />}</span>
              <span className={"fig " + tone(v)}>{m(sg(v))}</span>
            </div>
          );
        })}
      </div>
      <div className="hx-sect">Last 5 weeks</div>
      <Calendar rows={rows} todayDay={todayDay} selected={selected} onDay={onDay} hide={hide} />
      {best.length > 0 && (
        <>
          <div className="hx-sect">Best and worst days</div>
          <div className="hx-best">
            {best.map((r) => (
              <button type="button" key={r.day} className={"hx-best-row" + (r.day === selected ? " on" : "")} onClick={() => onDay(r.day)}>
                <span>{r.day}</span>
                <span className="muted">{int(r.fills)} fills</span>
                <span className={"fig " + tone(r.pnl)}>{m(sg(r.pnl))}</span>
              </button>
            ))}
          </div>
        </>
      )}
    </>
  );
}

const DOW = ["M", "T", "W", "T", "F", "S", "S"];
const DAYMS = 86_400_000;

/** Five weeks, Monday first, ending with this week; each day its P&L. Days outside the range are dim. */
function Calendar({ rows, todayDay, selected, onDay, hide }: { rows: DayRow[]; todayDay: string | null; selected: string | null; onDay: (d: string) => void; hide: boolean }) {
  const byDay = useMemo(() => new Map(rows.map((r) => [r.day, r])), [rows]);
  if (!todayDay) return null;
  const today = Date.parse(todayDay + "T00:00:00Z");
  const dow = (new Date(today).getUTCDay() + 6) % 7;
  const start = today - (dow + 28) * DAYMS;
  const cells = [];
  for (let i = 0; i < 35; i++) {
    const t = start + i * DAYMS;
    const day = new Date(t).toISOString().slice(0, 10);
    const r = byDay.get(day);
    const future = t > today;
    cells.push(
      <button
        type="button"
        key={day}
        disabled={!r}
        className={"hx-cal-c" + (r ? "" : " out") + (day === todayDay ? " today" : "") + (day === selected ? " on" : "")}
        onClick={() => r && onDay(day)}
        title={r ? `${day}: ${hide ? "" : sg(r.pnl) + " USDT, "}${int(r.fills)} fills` : day}
      >
        <i>{new Date(t).getUTCDate()}</i>
        <b className={r ? (hide ? "masked" : signClass(r.pnl)) : ""}>{future ? "" : r && r.pnl != null ? maskText(hide, num(r.pnl, 0, true)) : "--"}</b>
      </button>,
    );
  }
  return (
    <div className="hx-cal">
      {DOW.map((d, i) => (
        <span key={i} className="hx-cal-h">
          {d}
        </span>
      ))}
      {cells}
    </div>
  );
}

// ---------------- instrument ----------------

export interface InstStats {
  fills: number;
  buys: number;
  sells: number;
  buyQty: number;
  sellQty: number;
  buyNotional: number;
  sellNotional: number;
  maker: number;
}

export function instStats(fills: HistFill[]): InstStats {
  const s: InstStats = { fills: fills.length, buys: 0, sells: 0, buyQty: 0, sellQty: 0, buyNotional: 0, sellNotional: 0, maker: 0 };
  for (const f of fills) {
    if (f.maker) s.maker++;
    if (f.side === "buy") {
      s.buys++;
      s.buyQty += f.qty;
      s.buyNotional += f.qty * f.price;
    } else {
      s.sells++;
      s.sellQty += f.qty;
      s.sellNotional += f.qty * f.price;
    }
  }
  return s;
}

export function InstSide({ title, fills, bars, loading, hide, today }: { title: string; fills: HistFill[]; bars: Candle[]; loading: boolean; hide: boolean; today: SymbolRow | undefined }) {
  const s = useMemo(() => instStats(fills), [fills]);
  const last = bars[bars.length - 1]?.close ?? null;
  const first = bars[0]?.open ?? null;
  let hi: number | null = null,
    lo: number | null = null;
  for (const b of bars) {
    hi = hi == null ? b.high : Math.max(hi, b.high);
    lo = lo == null ? b.low : Math.min(lo, b.low);
  }
  const net = s.buyQty - s.sellQty;
  const pnl = last != null && !loading ? s.sellNotional - s.buyNotional + net * last : null;
  const chg = first && last ? (last - first) / first : null;
  const m = (x: string) => maskText(hide, x);
  const tone = (v: number | null | undefined) => (hide ? "masked" : signClass(v));
  const dash = loading;
  const legs = useLegPnl();
  const tp = today ? instPnl(today, legs) : null;
  return (
    <>
      <div className="hx-side-head">
        <span className="hx-side-title">{title}</span>
        <span className="muted">USDT</span>
      </div>
      <div className="hx-figs">
        <Fig
          big
          dot
          label="Trading PnL"
          title="Our fills in the range marked at the last price: what they made, fees not included. Inventory held before the range is not counted"
          value={m(sg(pnl))}
          tone={tone(pnl)}
        />
        <Fig label="Fills" value={dash ? "--" : int(s.fills)} />
        <Fig label="Volume" value={dash ? "--" : m(compact(s.buyNotional + s.sellNotional))} tone={hide ? "masked" : undefined} title="Filled notional, USDT" />
        <Fig label="Buys" value={dash ? "--" : int(s.buys)} tone="up" />
        <Fig label="Sells" value={dash ? "--" : int(s.sells)} tone="down" />
        <Fig label="Avg buy" value={s.buyQty > 0 ? price(s.buyNotional / s.buyQty) : "--"} />
        <Fig label="Avg sell" value={s.sellQty > 0 ? price(s.sellNotional / s.sellQty) : "--"} />
        <Fig label="Net qty" value={dash ? "--" : qtyText(net, hide, true)} tone={hide ? "masked" : undefined} title="Bought minus sold over the range, base asset" />
        <Fig label="Maker" value={s.fills ? num((s.maker / s.fills) * 100, 0) + "%" : "--"} title="Share of the fills that were maker fills" />
      </div>
      <div className="hx-sect">Market over the range</div>
      <div className="hx-figs">
        <Fig label="Change" value={chg == null ? "--" : num(chg * 100, 2, true) + "%"} tone={signClass(chg)} />
        <Fig label="Last" value={price(last)} />
        <Fig label="High" value={price(hi)} />
        <Fig label="Low" value={price(lo)} />
      </div>
      <div className="hx-sect">Today</div>
      <div className="hx-figs">
        <Fig label="Trading PnL" value={m(sg(tp))} tone={tone(tp)} title="Today: market making + inventory PnL, fees included (a perp's: its hedge leg)" />
        <Fig label="Fills" value={today ? int(today.fills_day) : "--"} />
        <Fig label="Inventory" value={today ? qtyText(today.inv_qty, hide) : "--"} tone={hide ? "masked" : undefined} />
        <Fig label="Value" value={m(today ? num(today.inv_value, 2) : "--")} tone={hide ? "masked" : undefined} />
        <Fig label="Avg cost" value={price(today?.avg_cost)} />
        <Fig dot label="Edge" value={today?.edge_bps == null ? "--" : bps(today.edge_bps) + " bps"} title="Edge at fill against fair, volume-weighted, bps" />
        <Fig dot label="Markout 10 s" value={today?.mk10_bps == null ? "--" : bps(today.mk10_bps) + " bps"} tone={signClass(today?.mk10_bps)} title="Each fill against the mid 10 s later, net of the reference's move, volume-weighted, bps" />
        <Fig label="Spread" value={today?.spread_bps == null ? "--" : num(today.spread_bps, 1) + " bps"} />
      </div>
    </>
  );
}
