// A plain table with sortable columns (a click on a header sorts by it, again reverses), figures coloured as
// text only. Used by Analysis.
import { useMemo, useState, type ReactNode } from "react";

export interface SCol<R> {
  key: string;
  label: ReactNode;
  title?: string;
  /** A term a trader may not know: dotted, its title is the definition. */
  dot?: boolean;
  left?: boolean;
  cell: (r: R) => ReactNode;
  cls?: (r: R) => string;
  /** Sort value; no sort when absent. */
  sort?: (r: R) => number | string | null;
}

export function SortTable<R>({
  cols,
  rows,
  rowKey,
  initial,
  onRow,
  hover,
  onHover,
  empty,
  className,
}: {
  cols: SCol<R>[];
  rows: R[];
  rowKey: (r: R) => string;
  initial?: { key: string; desc: boolean };
  onRow?: (r: R) => void;
  /** The row lit from elsewhere (a chart), by key; `onHover` reports the row under the pointer. */
  hover?: string | null;
  onHover?: (key: string | null) => void;
  empty: string;
  className?: string;
}) {
  const [by, setBy] = useState(initial ?? null);
  const sorted = useMemo(() => {
    const c = by && cols.find((x) => x.key === by.key);
    if (!c?.sort) return rows;
    const f = c.sort;
    return rows.slice().sort((a, b) => {
      const x = f(a),
        y = f(b);
      // unknowns last either way
      if (x == null) return y == null ? 0 : 1;
      if (y == null) return -1;
      const d = typeof x === "string" ? x.localeCompare(y as string) : x - (y as number);
      return by!.desc ? -d : d;
    });
  }, [rows, by, cols]);
  return (
    <table className={"an-t " + (className ?? "")}>
      <thead>
        <tr>
          {cols.map((c) => {
            const on = by?.key === c.key;
            return (
              <th
                key={c.key}
                className={(c.left ? "l" : "") + (c.sort ? " sortable" : "") + (on ? " on" : "")}
                onClick={c.sort ? () => setBy(on ? { key: c.key, desc: !by!.desc } : { key: c.key, desc: true }) : undefined}
                aria-sort={on ? (by!.desc ? "descending" : "ascending") : undefined}
              >
                <span className={c.dot ? "dotted" : undefined} title={c.title}>
                  {c.label}
                </span>
                {on && <span className="an-sort">{by!.desc ? "↓" : "↑"}</span>}
              </th>
            );
          })}
        </tr>
      </thead>
      <tbody>
        {sorted.length === 0 ? (
          <tr className="an-t-empty">
            <td colSpan={cols.length}>{empty}</td>
          </tr>
        ) : (
          sorted.map((r) => (
            <tr
              key={rowKey(r)}
              className={(onRow ? "click" : "") + (hover === rowKey(r) ? " lit" : "")}
              onClick={onRow ? () => onRow(r) : undefined}
              onMouseEnter={onHover ? () => onHover(rowKey(r)) : undefined}
              onMouseLeave={onHover ? () => onHover(null) : undefined}
            >
              {cols.map((c) => (
                <td key={c.key} className={(c.left ? "l " : "") + (c.cls?.(r) ?? "")}>
                  {c.cell(r)}
                </td>
              ))}
            </tr>
          ))
        )}
      </tbody>
    </table>
  );
}
