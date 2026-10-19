// The quote map's rows and geometry, shared by the desktop map (ECharts, QuoteMap.tsx) and the light canvas
// maps (QuoteRows: the phone's full map, the mini map, the single-row band).
import type { OpenOrder, SymbolRow, Venue } from "../../protocol";

/** One instrument's row: the instrument and its resting orders. */
export interface QRow {
  sym: SymbolRow;
  orders: OpenOrder[];
}

export type MapSort = "activity" | "wide" | "oneside" | "inventory" | "name";
/** Every sort, for remembered choices. */
export const SORTS: MapSort[] = ["activity", "wide", "oneside", "inventory", "name"];

/** A row's quoting state: both sides, one side missing, nothing resting. */
export type Sides = "both" | "noask" | "nobid" | "none";
export function sidesOf(r: QRow): Sides {
  let b = false;
  let a = false;
  for (const o of r.orders) {
    if (o.side === "buy") b = true;
    else a = true;
  }
  return b && a ? "both" : b ? "noask" : a ? "nobid" : "none";
}

/** Our quoted width, bps of fair: best ask − best bid (null unless both sides rest). */
export function widthOf(r: QRow): number | null {
  const fair = r.sym.fair ?? r.sym.mid;
  if (!fair) return null;
  let bid = -Infinity;
  let ask = Infinity;
  for (const o of r.orders) {
    if (o.side === "buy") bid = Math.max(bid, o.price);
    else ask = Math.min(ask, o.price);
  }
  return Number.isFinite(bid) && Number.isFinite(ask) ? ((ask - bid) / fair) * 1e4 : null;
}

/** "Wide": our width is over twice the median width of the two-sided rows (and at least 4 bps). */
export function wideCut(rows: readonly QRow[]): number {
  const ws = rows
    .map(widthOf)
    .filter((w): w is number => w != null)
    .sort((a, b) => a - b);
  if (!ws.length) return Infinity;
  return Math.max(4, 2 * ws[Math.floor(ws.length / 2)]!);
}

/** What the map says in words at the right of a row's plot: nothing resting, a wide quote. A missing side is
 *  drawn instead (`missingSide`). */
export function rowStatus(r: QRow, cut: number): string | null {
  const s = sidesOf(r);
  if (s === "noask" || s === "nobid") return null;
  if (s === "none") return "Not quoted";
  const w = widthOf(r);
  return w != null && w > cut ? "Wide" : null;
}

/** A one-sided row's missing side and where it is drawn: an empty ring at the market's best price on that side,
 *  bps from fair (null when the row is two-sided, unquoted, or the market has no price on that side). */
export function missingSide(r: QRow): { side: "buy" | "sell"; bps: number } | null {
  const s = sidesOf(r);
  if (s !== "noask" && s !== "nobid") return null;
  const fair = r.sym.fair ?? r.sym.mid;
  const px = s === "nobid" ? r.sym.bid : r.sym.ask;
  if (!fair || !px) return null;
  return { side: s === "nobid" ? "buy" : "sell", bps: off(px, fair) };
}

/** The largest resting order on the map, USDT: the dots' sizes are relative to it. */
export function maxNotional(rows: readonly QRow[]): number {
  let m = 0;
  for (const r of rows) for (const o of r.orders) m = Math.max(m, o.notional);
  return m;
}

/** The map's counts: rows with one side missing, rows quoted wide, orders through fair. */
export function mapCounts(rows: readonly QRow[]) {
  const cut = wideCut(rows);
  let oneSide = 0;
  let wide = 0;
  let orders = 0;
  let through = 0;
  for (const r of rows) {
    const s = sidesOf(r);
    if (s === "noask" || s === "nobid") oneSide++;
    const w = widthOf(r);
    if (w != null && w > cut) wide++;
    orders += r.orders.length;
    for (const o of r.orders) if (o.dist_bps != null && o.dist_bps < 0) through++;
  }
  return { rows: rows.length, orders, oneSide, wide, through, cut };
}

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
export function quoteRows(symbols: readonly SymbolRow[], orders: readonly OpenOrder[], sort: MapSort, account: string | null = null, hide = false): QRow[] {
  const by = ordersBy(orders, account);
  const rows = symbols
    .filter((s) => s.venue === "spot" && (by.has(key(s.symbol, "spot")) || Math.abs(s.inv_value) >= 5))
    .map((s) => ({ sym: s, orders: by.get(key(s.symbol, "spot")) ?? [] }));
  const name = (r: QRow) => r.sym.symbol;
  const busy = (a: QRow, b: QRow) => b.sym.fills_day - a.sym.fills_day || name(a).localeCompare(name(b));
  if (sort === "name") rows.sort((a, b) => name(a).localeCompare(name(b)));
  // by inventory while amounts are hidden would give the hidden sizes away: the names' order instead
  else if (sort === "inventory") rows.sort(hide ? (a, b) => name(a).localeCompare(name(b)) : (a, b) => Math.abs(b.sym.inv_value) - Math.abs(a.sym.inv_value));
  else if (sort === "wide") {
    // widest first; one-sided and unquoted rows after the two-sided ones
    const w = new Map(rows.map((r) => [r, widthOf(r) ?? -1]));
    rows.sort((a, b) => w.get(b)! - w.get(a)! || busy(a, b));
  } else if (sort === "oneside") {
    // a missing side first (the busiest of them first), then nothing resting, then the two-sided
    const rank = (r: QRow) => ({ noask: 0, nobid: 0, none: 1, both: 2 })[sidesOf(r)];
    rows.sort((a, b) => rank(a) - rank(b) || busy(a, b));
  } else rows.sort(busy);
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

/** A dot's diameter, px: area ~ the order's notional against the largest order on the map (`max`), which is
 *  DOT_MAX across. An order through fair keeps its size and gets a separate amber ring THROUGH_GAP px outside
 *  it, so size and "through fair" never look alike. A missing side's empty ring is DOT_MAX across too. */
export const DOT_MAX = 9;
export const dotSize = (notional: number, max: number) =>
  max > 0 ? Math.max(3, DOT_MAX * Math.sqrt(Math.max(0, notional) / max)) : DOT_MAX;
export const THROUGH_GAP = 2.5;

/** The market band's fill and edges, and the inventory bars: neutral (they are not gains or losses). */
export const BAND = "rgba(195,202,213,0.14)";
export const BAND_EDGE = "rgba(195,202,213,0.6)";
export const INV_FILL = "rgba(138,148,165,0.45)";
