// The tables under the History chart: the desk by day (or by hour today), an instrument's fills by day (or by
// hour today). Plain rows, figures coloured as text only.
import { useMemo, useState, type ReactNode } from "react";
import type { HistFill } from "../../api";
import { compact, hm, int, num, price, qtyDecimals, se, signClass, type TzMode } from "../../format";
import { maskText, qtyText } from "../../mask";
import { PART_META } from "./DeskChart";
import { dayOf, type DayRow, type Row } from "./data";

export interface Col<R> {
  key: string;
  label: ReactNode;
  title?: string;
  /** A term a trader may not know: its label gets the dotted underline of a definition. */
  dot?: boolean;
  left?: boolean;
  cell: (r: R) => ReactNode;
  cls?: (r: R) => string;
  /** Sort value: a click on the header sorts by it (largest first), again reverses, a third time back to the
   *  table's own order. Unknowns last. */
  sort?: (r: R) => number | string | null;
}

export function Table<R>({
  cols,
  rows,
  rowKey,
  onRow,
  selected,
  empty,
  last,
}: {
  cols: Col<R>[];
  rows: R[];
  rowKey: (r: R) => string;
  onRow?: (r: R) => void;
  selected?: string | null;
  empty: string;
  /** Rows a sort by a figure always puts last (today, still moving, is no finished day to rank). */
  last?: (r: R) => boolean;
}) {
  const [by, setBy] = useState<{ key: string; desc: boolean } | null>(null);
  const sorted = useMemo(() => {
    const f = by && cols.find((x) => x.key === by.key)?.sort;
    if (!f) return rows;
    const byDate = by.key === cols[0]?.key;
    return rows.slice().sort((a, b) => {
      if (last && !byDate) {
        const la = last(a),
          lb = last(b);
        if (la !== lb) return la ? 1 : -1;
      }
      const x = f(a);
      const y = f(b);
      if (x == null) return y == null ? 0 : 1;
      if (y == null) return -1;
      const d = typeof x === "string" ? x.localeCompare(y as string) : x - (y as number);
      return by.desc ? -d : d;
    });
  }, [rows, by, cols, last]);
  const click = (k: string) => setBy((b) => (b?.key !== k ? { key: k, desc: true } : b.desc ? { key: k, desc: false } : null));
  return (
    <table className="hx-t">
      <thead>
        <tr>
          {cols.map((c) => {
            const on = by?.key === c.key;
            return (
              <th
                key={c.key}
                className={(c.left ? "l" : "") + (c.sort ? " sortable" : "") + (on ? " on" : "")}
                onClick={c.sort ? () => click(c.key) : undefined}
                aria-sort={on ? (by!.desc ? "descending" : "ascending") : undefined}
              >
                <span className={c.dot ? "dotted" : undefined} title={c.title}>
                  {c.label}
                </span>
                {c.sort && <span className="hx-sort">{on ? (by!.desc ? "↓" : "↑") : ""}</span>}
              </th>
            );
          })}
        </tr>
      </thead>
      <tbody>
        {rows.length === 0 ? (
          <tr className="hx-t-empty">
            <td colSpan={cols.length}>{empty}</td>
          </tr>
        ) : (
          sorted.map((r) => {
            const k = rowKey(r);
            return (
              <tr key={k} className={(onRow ? "click" : "") + (k === selected ? " on" : "")} onClick={onRow ? () => onRow(r) : undefined}>
                {cols.map((c) => (
                  <td key={c.key} className={(c.left ? "l " : "") + (c.cls?.(r) ?? "")}>
                    {c.cell(r)}
                  </td>
                ))}
              </tr>
            );
          })
        )}
      </tbody>
    </table>
  );
}

const sg = (v: number | null | undefined) => (v == null ? "--" : num(v, 2, true));

type PnlRow = { label: ReactNode; key: string; split?: boolean; pnl: number | null; mm: number | null; inv: number | null; hedge: number | null; reb: number | null; other: number | null; pi: number | null; se: number | null; fills: number; volume: number };

function pnlCols(first: string, firstTitle: string, pnlLabel: string, hide: boolean): Col<PnlRow>[] {
  const m = (s: string) => maskText(hide, s);
  const p = (k: "pnl" | "mm" | "inv" | "hedge" | "reb" | "other", label: string, title?: string): Col<PnlRow> => ({
    key: k,
    label,
    title,
    dot: k === "other",
    cell: (r) => m(sg(r[k])),
    // colour for the Day PnL only (did the day make money); the parts in ink, the sign in the text
    cls: (r) => "fig " + (hide ? "masked" : k === "pnl" ? signClass(r[k]) : ""),
    // no sort by a hidden figure (the order would tell it)
    sort: hide ? undefined : (r) => r[k],
  });
  // Day PnL, then Trading PnL with its two parts after it, then the hedge, the rebates and the rest
  return [
    { key: "d", label: first, title: firstTitle, left: true, cell: (r) => r.label, sort: (r) => r.key },
    p("pnl", pnlLabel),
    {
      key: "pi",
      label: "Trading PnL",
      title: "Market making plus inventory PnL, fees included; the standard error is in each figure's tooltip",
      cell: (r) => (
        <span title={r.split === false ? "No split kept this day: not in the total" : r.se != null ? se(r.se) + " (Newey–West standard error)" : undefined}>{m(sg(r.pi))}</span>
      ),
      cls: (r) => "fig " + (hide ? "masked" : r.split === false ? "muted" : ""),
      sort: hide ? undefined : (r) => r.pi,
    },
    p("mm", "Market making", PART_META.mm.title),
    p("inv", "Inventory PnL", PART_META.inv.title),
    p("hedge", "Hedge", PART_META.hedge.title),
    p("reb", "Rebates"),
    p("other", "Other", PART_META.other.title),
    { key: "f", label: "Fills", cell: (r) => int(r.fills), cls: () => "fig", sort: (r) => r.fills },
    { key: "v", label: "Volume", title: "Filled notional, USDT", cell: (r) => m(compact(r.volume)), cls: () => "fig" + (hide ? " masked" : ""), sort: hide ? undefined : (r) => r.volume },
  ];
}

export function DeskDays({ rows, todayDay, selected, onDay, hide }: { rows: DayRow[]; todayDay: string | null; selected: string | null; onDay: (d: string) => void; hide: boolean }) {
  const data: PnlRow[] = rows.map((r) => ({
    ...r,
    key: r.day,
    label: (
      <>
        {r.day}
        {r.day === todayDay && <span className="hx-tag">Today</span>}
      </>
    ),
  }));
  // no sum row: the range's sums are the summary at the right
  return (
    <Table
      cols={pnlCols("Day", "PnL day, newest first; a click on a header sorts by it", "Day PnL", hide)}
      rows={data}
      rowKey={(r) => r.key}
      onRow={(r) => onDay(r.key)}
      selected={selected}
      empty="No days in this range"
      last={(r) => r.key === todayDay}
    />
  );
}

/** Today's hours from the desk's hour bars. */
export function DeskHours({ rows, tz, hide }: { rows: Row[]; tz: TzMode; hide: boolean }) {
  const data: PnlRow[] = rows
    .map((r) => ({ key: String(r.t), label: hm(r.t, tz), pnl: r.pnl, ...r.bar, se: null, fills: r.fills, volume: r.volume }))
    .reverse();
  return <Table cols={pnlCols("Hour", tz === "utc" ? "Hour start, UTC" : "Hour start, local time", "PnL", hide)} rows={data} rowKey={(r) => r.key} empty="No hours yet today" />;
}

// ---------------- instrument ----------------

interface FillGroup {
  key: string;
  label: string;
  t: number;
  fills: number;
  buys: number;
  sells: number;
  bq: number;
  sq: number;
  bn: number;
  sn: number;
}

function group(fills: HistFill[], keyOf: (t: number) => number, label: (t: number) => string): FillGroup[] {
  const m = new Map<number, FillGroup>();
  for (const f of fills) {
    const k = keyOf(f.t);
    let g = m.get(k);
    if (!g) m.set(k, (g = { key: String(k), label: label(k), t: k, fills: 0, buys: 0, sells: 0, bq: 0, sq: 0, bn: 0, sn: 0 }));
    g.fills++;
    if (f.side === "buy") {
      g.buys++;
      g.bq += f.qty;
      g.bn += f.qty * f.price;
    } else {
      g.sells++;
      g.sq += f.qty;
      g.sn += f.qty * f.price;
    }
  }
  return [...m.values()].sort((a, b) => b.t - a.t);
}

/** One precision down the Net qty column: the largest net's. */
const netDecimals = (rows: FillGroup[]) => qtyDecimals(Math.max(0, ...rows.map((g) => Math.abs(g.bq - g.sq))));

const fillCols = (first: string, title: string, hide: boolean, nd: number): Col<FillGroup>[] => [
  { key: "d", label: first, title, left: true, cell: (g) => g.label, sort: (g) => g.t },
  { key: "f", label: "Fills", cell: (g) => int(g.fills), cls: () => "fig", sort: (g) => g.fills },
  { key: "b", label: "Buys", cell: (g) => int(g.buys), cls: () => "fig", sort: (g) => g.buys },
  { key: "s", label: "Sells", cell: (g) => int(g.sells), cls: () => "fig", sort: (g) => g.sells },
  { key: "v", label: "Volume", title: "Filled notional, USDT", cell: (g) => maskText(hide, compact(g.bn + g.sn)), cls: () => "fig" + (hide ? " masked" : "") },
  { key: "ab", label: "Avg buy", cell: (g) => (g.bq > 0 ? price(g.bn / g.bq) : "--"), cls: () => "fig" },
  { key: "as", label: "Avg sell", cell: (g) => (g.sq > 0 ? price(g.sn / g.sq) : "--"), cls: () => "fig" },
  { key: "n", label: "Net qty", title: "Bought minus sold, base asset", cell: (g) => qtyText(g.bq - g.sq, hide, true, nd), cls: () => "fig" + (hide ? " masked" : "") },
];

export function InstDays({ fills, dayStart, hide }: { fills: HistFill[]; dayStart: number; hide: boolean }) {
  // a P&L day is named by the UTC date of its start, as the server names it
  const rows = group(fills, (t) => dayOf(t, dayStart), (t) => new Date(t).toISOString().slice(0, 10));
  return <Table cols={fillCols("Day", "PnL day, newest first", hide, netDecimals(rows))} rows={rows} rowKey={(g) => g.key} empty="No fills in this range" />;
}

export function InstHours({ fills, dayStart, tz, hide }: { fills: HistFill[]; dayStart: number; tz: TzMode; hide: boolean }) {
  const rows = group(
    fills.filter((f) => f.t >= dayStart),
    (t) => Math.floor(t / 3_600_000) * 3_600_000,
    (t) => hm(t, tz),
  );
  return <Table cols={fillCols("Hour", tz === "utc" ? "Hour start, UTC" : "Hour start, local time", hide, netDecimals(rows))} rows={rows} rowKey={(g) => g.key} empty="No fills today" />;
}
