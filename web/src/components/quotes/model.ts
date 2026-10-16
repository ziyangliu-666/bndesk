// The quote map's rows and geometry, shared by the desktop map (ECharts, QuoteMap.tsx) and the light canvas
// maps (QuoteRows: the phone's full map, the mini map, the single-row band).
import type { OpenOrder, SymbolRow, Venue } from "../../protocol";

/** One instrument's row: the instrument and its resting orders. */
export interface QRow {
  sym: SymbolRow;
  orders: OpenOrder[];
}

export type MapSort = "activity" | "name" | "inventory";

const key = (symbol: string, venue: Venue) => `${venue}:${symbol}`;

/** Orders by instrument key `"<venue>:<SYMBOL>"`. */
export function ordersBy(orders: readonly OpenOrder[], account: string | null = null): Map<string, OpenOrder[]> {
  const by = new Map<string, OpenOrder[]>();
  for (const o of orders) {
    if (account != null && o.account !== account) continue;
    const k = key(o.symbol, o.venue);
    (by.get(k) ?? by.set(k, []).get(k)!).push(o);
  }
  return by;
}

/**
 * The map's rows: spot instruments with resting orders or inventory worth 5 USDT or more, sorted by today's
 * fills (they only grow, so rows keep their place while orders churn), by inventory value, or by name.
 */
export function quoteRows(symbols: readonly SymbolRow[], orders: readonly OpenOrder[], sort: MapSort, account: string | null = null): QRow[] {
  const by = ordersBy(orders, account);
  const rows = symbols
    .filter((s) => s.venue === "spot" && (by.has(key(s.symbol, "spot")) || Math.abs(s.inv_value) >= 5))
    .map((s) => ({ sym: s, orders: by.get(key(s.symbol, "spot")) ?? [] }));
  const name = (r: QRow) => r.sym.symbol;
  if (sort === "name") rows.sort((a, b) => name(a).localeCompare(name(b)));
  else if (sort === "inventory") rows.sort((a, b) => Math.abs(b.sym.inv_value) - Math.abs(a.sym.inv_value));
  else rows.sort((a, b) => b.sym.fills_day - a.sym.fills_day || name(a).localeCompare(name(b)));
  return rows;
}

/** The rows for these instrument keys, in their order (keys whose instrument is gone are skipped). */
export function rowsFor(keys: readonly string[], symbols: readonly SymbolRow[], orders: readonly OpenOrder[]): QRow[] {
  const by = ordersBy(orders);
  const sym = new Map(symbols.map((s) => [key(s.symbol, s.venue), s]));
  const out: QRow[] = [];
  for (const k of keys) {
    const s = sym.get(k);
    if (s) out.push({ sym: s, orders: by.get(k) ?? [] });
  }
  return out;
}

/** BTCUSDT → BTC. */
export const short = (s: string) => s.replace(/USDT$/, "");
/** A price's distance from fair, bps. */
export const off = (px: number, fair: number) => ((px - fair) / fair) * 1e4;
export const clamp = (v: number, r: number) => Math.max(-r, Math.min(r, v));

/** bps ranges ctrl + wheel steps through on the desktop. */
export const LADDER = [2, 4, 6, 10, 16, 25, 35, 50, 75, 100, 150, 200];
/** The range choices the controls offer. */
export const RANGES = [10, 25, 50, 100] as const;

/** A dot's diameter for an order's notional (area ~ notional), px. */
export const dotSize = (notional: number, through: boolean) => Math.max(through ? 8 : 5, Math.min(11, Math.sqrt(notional / 60) * 5.6));

/** The market band's fill and edges, and the inventory bars: neutral (they are not gains or losses). */
export const BAND = "rgba(195,202,213,0.14)";
export const BAND_EDGE = "rgba(195,202,213,0.6)";
export const INV_FILL = "rgba(138,148,165,0.45)";
