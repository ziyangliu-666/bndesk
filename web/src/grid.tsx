import { AllCommunityModule, ModuleRegistry, type CellClassParams, type ValueFormatterParams } from "ag-grid-community";
import { age, bps, hms, int, pnl, price, qty, usd, signClass } from "./format";
import { useStore } from "./store";

ModuleRegistry.registerModules([AllCommunityModule]);

type VF = (p: ValueFormatterParams) => string;
const v = (p: ValueFormatterParams) => p.value as number | null | undefined;

export const fUsd: VF = (p) => usd(v(p));
export const fPnl: VF = (p) => pnl(v(p));
export const fBps: VF = (p) => bps(v(p));
export const fBpsU: VF = (p) => bps(v(p), false);
export const fInt: VF = (p) => int(v(p));
export const fPrice: VF = (p) => price(v(p));
export const fQty: VF = (p) => qty(v(p));
export const fQtyS: VF = (p) => qty(v(p), true);
export const fTime: VF = (p) => hms(v(p), useStore.getState().tz);
export const fAge: VF = (p) => {
  const t = v(p);
  return t == null ? "—" : age(Date.now() + useStore.getState().skew - t);
};

/**
 * Flash a cell only when its shown text changes (not on every tick of the raw number); the pinned
 * total row never flashes (styles.css).
 */
export function flashOn(fmt: VF) {
  const f = (value: unknown) => fmt({ value } as ValueFormatterParams);
  return { enableCellChangeFlash: true, equals: (a: unknown, b: unknown) => f(a) === f(b) };
}

/** Text color follows sign (the sign is in the text too). */
export const signCls = (p: CellClassParams) => "num " + signClass(p.value as number | null);

/** Diverging tint for markout cells: teal for positive, coral for negative, saturating at ±limit bps. */
export function tint(limit = 4) {
  return (p: CellClassParams) => {
    const x = p.value as number | null | undefined;
    if (x == null || !Number.isFinite(x) || p.node.rowPinned) return { backgroundColor: "transparent" };
    const a = Math.min(1, Math.abs(x) / limit) * 0.32;
    const rgb = x >= 0 ? "61,191,150" : "238,107,94";
    return { backgroundColor: `rgba(${rgb},${a.toFixed(3)})` };
  };
}

/** One stable object for every grid: an inline literal is a new prop each render and resets the columns. */
export const DEFAULT_COL = { sortable: true, resizable: true, suppressHeaderMenuButton: true, cellDataType: false } as const;

export const numCol = { type: "rightAligned", cellClass: "num" } as const;

/** Turn fixed widths into minimum widths that share leftover space, so grids fill their panel. */
export function flexCols<T extends object>(cols: T[]): T[] {
  return cols.map((c) => {
    const d = c as { width?: number; minWidth?: number; flex?: number | null; children?: object[] };
    if (Array.isArray(d.children)) return { ...c, children: flexCols(d.children) };
    if (d.width == null || d.flex != null) return c;
    return { ...c, minWidth: d.minWidth ?? d.width, flex: d.width };
  });
}
