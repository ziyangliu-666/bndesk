// The tables under the History chart: the desk by day (or by hour today), an instrument's fills by day (or by
// hour today). Plain rows, figures coloured as text only.
import type { ReactNode } from "react";
import type { HistFill } from "../../api";
import { compact, hm, int, num, price, qty, se, signClass, type TzMode } from "../../format";
import { PART_META } from "./DeskChart";
import { dayOf, sumDays, type DayRow, type Row } from "./data";

export interface Col<R> {
  key: string;
  label: ReactNode;
  title?: string;
  /** A term a trader may not know: its label gets the dotted underline of a definition. */
  dot?: boolean;
  left?: boolean;
  cell: (r: R) => ReactNode;
  cls?: (r: R) => string;
}

export function Table<R>({
  cols,
  rows,
  rowKey,
  foot,
  onRow,
  selected,
  empty,
}: {
  cols: Col<R>[];
  rows: R[];
  rowKey: (r: R) => string;
  foot?: R | null;
  onRow?: (r: R) => void;
  selected?: string | null;
  empty: string;
}) {
  return (
    <table className="hx-t">
      <thead>
        <tr>
          {cols.map((c) => (
            <th key={c.key} className={c.left ? "l" : undefined}>
              <span className={c.dot ? "dotted" : undefined} title={c.title}>
                {c.label}
              </span>
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {rows.length === 0 ? (
          <tr className="hx-t-empty">
            <td colSpan={cols.length}>{empty}</td>
          </tr>
        ) : (
          rows.map((r) => {
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
      {foot && rows.length > 1 && (
        <tfoot>
          <tr>
            {cols.map((c) => (
              <td key={c.key} className={(c.left ? "l " : "") + (c.cls?.(foot) ?? "")}>
                {c.cell(foot)}
              </td>
            ))}
          </tr>
        </tfoot>
      )}
    </table>
  );
}

const sg = (v: number | null | undefined) => (v == null ? "--" : num(v, 2, true));

type PnlRow = { label: ReactNode; key: string; pnl: number | null; mm: number | null; inv: number | null; hedge: number | null; reb: number | null; other: number | null; pi: number | null; se: number | null; fills: number; volume: number };

function pnlCols(first: string, firstTitle: string, pnlLabel: string, hide: boolean): Col<PnlRow>[] {
  const m = (s: string) => (hide ? "•••" : s);
  const p = (k: "pnl" | "mm" | "inv" | "hedge" | "reb" | "other", label: string, title?: string): Col<PnlRow> => ({
    key: k,
    label,
    title,
    dot: k === "other",
    cell: (r) => m(sg(r[k])),
    cls: (r) => "fig " + (hide ? "" : signClass(r[k])),
  });
  return [
    { key: "d", label: first, title: firstTitle, left: true, cell: (r) => r.label },
    p("pnl", pnlLabel),
    p("mm", "Market making", PART_META.mm.title),
    p("inv", "Inventory PnL", PART_META.inv.title),
    p("hedge", "Hedge", PART_META.hedge.title),
    p("reb", "Rebates"),
    p("other", "Other", PART_META.other.title),
    {
      key: "pi",
      label: "Π",
      dot: true,
      title: "Trading PnL: market making plus inventory PnL; the standard error is in each figure's tooltip",
      cell: (r) => <span title={r.se != null ? se(r.se) + " (Newey–West standard error)" : undefined}>{m(sg(r.pi))}</span>,
      cls: (r) => "fig " + (hide ? "" : signClass(r.pi)),
    },
    { key: "f", label: "Fills", cell: (r) => int(r.fills), cls: () => "fig" },
    { key: "v", label: "Volume", title: "Filled notional, USDT", cell: (r) => compact(r.volume), cls: () => "fig" },
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
  const t = sumDays(rows);
  const foot: PnlRow = { ...t, key: "total", label: rows.length === 1 ? "1 day" : `${rows.length} days` };
  return (
    <Table
      cols={pnlCols("Day", "PnL day, newest first; the last row sums the days shown", "Day PnL", hide)}
      rows={data}
      rowKey={(r) => r.key}
      foot={foot}
      onRow={(r) => onDay(r.key)}
      selected={selected}
      empty="No days in this range"
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

const fillCols = (first: string, title: string): Col<FillGroup>[] => [
  { key: "d", label: first, title, left: true, cell: (g) => g.label },
  { key: "f", label: "Fills", cell: (g) => int(g.fills), cls: () => "fig" },
  { key: "b", label: "Buys", cell: (g) => int(g.buys), cls: () => "fig up" },
  { key: "s", label: "Sells", cell: (g) => int(g.sells), cls: () => "fig down" },
  { key: "v", label: "Volume", title: "Filled notional, USDT", cell: (g) => compact(g.bn + g.sn), cls: () => "fig" },
  { key: "ab", label: "Avg buy", cell: (g) => (g.bq > 0 ? price(g.bn / g.bq) : "--"), cls: () => "fig" },
  { key: "as", label: "Avg sell", cell: (g) => (g.sq > 0 ? price(g.sn / g.sq) : "--"), cls: () => "fig" },
  { key: "n", label: "Net qty", title: "Bought minus sold, base asset", cell: (g) => qty(g.bq - g.sq, true), cls: (g) => "fig " + signClass(g.bq - g.sq) },
];

export function InstDays({ fills, dayStart }: { fills: HistFill[]; dayStart: number }) {
  // a P&L day is named by the UTC date of its start, as the server names it
  const rows = group(fills, (t) => dayOf(t, dayStart), (t) => new Date(t).toISOString().slice(0, 10));
  return <Table cols={fillCols("Day", "PnL day, newest first")} rows={rows} rowKey={(g) => g.key} empty="No fills in this range" />;
}

export function InstHours({ fills, dayStart, tz }: { fills: HistFill[]; dayStart: number; tz: TzMode }) {
  const rows = group(
    fills.filter((f) => f.t >= dayStart),
    (t) => Math.floor(t / 3_600_000) * 3_600_000,
    (t) => hm(t, tz),
  );
  return <Table cols={fillCols("Hour", tz === "utc" ? "Hour start, UTC" : "Hour start, local time")} rows={rows} rowKey={(g) => g.key} empty="No fills today" />;
}
