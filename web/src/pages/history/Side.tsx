// The History page's right column: the range in figures (label over value), the split, a calendar of the
// last five weeks and the best and worst days; for an instrument, our fills over the range and the market's.
import { useMemo } from "react";
import type { HistFill } from "../../api";
import type { Candle } from "../../components/ex";
import type { SymbolRow } from "../../protocol";
import { bps, compact, int, num, price, qty, signClass } from "../../format";
import { PART_META } from "./DeskChart";
import { sumDays, type DayRow, type Part } from "./data";

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
  onDay,
  hide,
}: {
  rows: DayRow[];
  title: string;
  todayDay: string | null;
  selected: string | null;
  onDay: (day: string) => void;
  hide: boolean;
}) {
  const tot = useMemo(() => sumDays(rows), [rows]);
  const known = rows.filter((r) => r.pnl != null);
  const up = known.filter((r) => r.pnl! > 0).length;
  const ranked = known.slice().sort((a, b) => b.pnl! - a.pnl!);
  const best = ranked.length > 3 ? [...ranked.slice(0, 2), ...ranked.slice(-2)] : ranked;
  const parts: Part[] = ["mm", "inv", "hedge", "reb", "other", "pi"];
  const max = Math.max(1e-9, ...parts.filter((k) => k !== "pi").map((k) => Math.abs(tot[k] ?? 0)));
  const m = (s: string) => (hide ? "•••" : s);
  const tone = (v: number | null | undefined) => (hide ? "" : signClass(v));
  return (
    <>
      <div className="hx-side-head">
        <span className="hx-side-title">{title}</span>
        <span className="muted">USDT</span>
      </div>
      <div className="hx-figs">
        <Fig big label="PnL" value={m(sg(tot.pnl))} tone={tone(tot.pnl)} />
        <Fig label="Average day" value={m(known.length ? sg(tot.pnl! / known.length) : "--")} tone={tone(tot.pnl)} />
        <Fig label="Days up" value={known.length ? `${up} of ${known.length}` : "--"} />
        <Fig label="Fills" value={rows.length ? int(tot.fills) : "--"} />
        <Fig label="Volume" value={rows.length ? compact(tot.volume) : "--"} title="Filled notional, USDT" />
      </div>
      <div className="hx-sect">Split</div>
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
        title={r ? `${day}: ${sg(r.pnl)} USDT, ${int(r.fills)} fills` : day}
      >
        <i>{new Date(t).getUTCDate()}</i>
        <b className={r && !hide ? signClass(r.pnl) : ""}>{future ? "" : r && r.pnl != null ? (hide ? "•••" : num(r.pnl, 0, true)) : "--"}</b>
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
  const m = (x: string) => (hide ? "•••" : x);
  const tone = (v: number | null | undefined) => (hide ? "" : signClass(v));
  const dash = loading;
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
        <Fig label="Volume" value={dash ? "--" : compact(s.buyNotional + s.sellNotional)} title="Filled notional, USDT" />
        <Fig label="Buys" value={dash ? "--" : int(s.buys)} tone="up" />
        <Fig label="Sells" value={dash ? "--" : int(s.sells)} tone="down" />
        <Fig label="Avg buy" value={s.buyQty > 0 ? price(s.buyNotional / s.buyQty) : "--"} />
        <Fig label="Avg sell" value={s.sellQty > 0 ? price(s.sellNotional / s.sellQty) : "--"} />
        <Fig label="Net qty" value={dash ? "--" : qty(net, true)} title="Bought minus sold over the range, base asset" />
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
        <Fig label="Day PnL" value={m(sg(today?.trading_pnl))} tone={tone(today?.trading_pnl)} title="Trading PnL today: realized plus the inventory at mid, fees included" />
        <Fig label="Fills" value={today ? int(today.fills_day) : "--"} />
        <Fig label="Inventory" value={today ? qty(today.inv_qty) : "--"} />
        <Fig label="Value" value={m(today ? num(today.inv_value, 2) : "--")} />
        <Fig label="Avg cost" value={price(today?.avg_cost)} />
        <Fig dot label="Edge" value={today?.edge_bps == null ? "--" : bps(today.edge_bps) + " bps"} title="Edge at fill against fair, volume-weighted, bps" />
        <Fig dot label="Markout 10s" value={today?.mk10_bps == null ? "--" : bps(today.mk10_bps) + " bps"} tone={signClass(today?.mk10_bps)} title="Each fill against the mid 10 s later, net of the reference's move, volume-weighted, bps" />
        <Fig label="Spread" value={today?.spread_bps == null ? "--" : num(today.spread_bps, 1) + " bps"} />
      </div>
    </>
  );
}
