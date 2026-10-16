// Small derived lists the pages share: each instrument's P&L today (the footer's marquee, top movers), and the
// busiest instruments (the phone Desk's live quotes block).
import { useCallback, useEffect, useMemo, useState } from "react";
import type { Fill, HedgeLeg, OpenOrder, SymbolRow, Venue } from "./protocol";
import { serverNow, useStore } from "./store";

/**
 * "Trading PnL" is market making + inventory PnL, fees included, and never the hedge, on every page and size.
 * A spot market has one (`trading_pnl`); a perp is the hedge and has none (null: shown as `--`), its P&L today
 * is its hedge leg's (`hedgePnl`: price P&L at mark − fees + funding), shown under a Hedge figure or column. The
 * desk's Day PnL = the Trading PnLs + the hedge legs + rebates + other.
 */
export function tradingPnl(r: SymbolRow): number | null {
  return r.venue === "usdm" ? null : r.trading_pnl;
}

/** A perp's hedge leg P&L today (null for spot, and for a perp with no leg today). */
export function hedgePnl(r: SymbolRow, legs: ReadonlyMap<string, number | null> | null | undefined): number | null {
  return r.venue === "usdm" ? (legs?.get(r.symbol) ?? null) : null;
}

/** What an instrument made today, whichever kind it is: a spot market's Trading PnL, a perp's hedge leg.
 *  For rankings across both (top movers, the marquee), always shown with its kind. */
export function instPnl(r: SymbolRow, legs: ReadonlyMap<string, number | null> | null | undefined): number {
  return (r.venue === "usdm" ? hedgePnl(r, legs) : r.trading_pnl) ?? 0;
}

const NO_LEGS: ReadonlyMap<string, number | null> = new Map();

/** Today's P&L of each hedge leg by perp symbol. */
export function legPnl(legs: readonly HedgeLeg[] | undefined): ReadonlyMap<string, number | null> {
  return legs?.length ? new Map(legs.map((l) => [l.symbol, l.pnl])) : NO_LEGS;
}

/** The hedge legs' P&L from the store (a new map only when the legs change). */
export function useLegPnl(): ReadonlyMap<string, number | null> {
  const legs = useStore((s) => s.snap?.exposure.hedge_day?.legs);
  return useMemo(() => legPnl(legs), [legs]);
}

/** `instPnl` bound to the store's hedge legs. */
export function useInstPnl(): (r: SymbolRow) => number {
  const legs = useLegPnl();
  return useCallback((r: SymbolRow) => instPnl(r, legs), [legs]);
}

/** `hedgePnl` bound to the store's hedge legs. */
export function useHedgePnl(): (r: SymbolRow) => number | null {
  const legs = useLegPnl();
  return useCallback((r: SymbolRow) => hedgePnl(r, legs), [legs]);
}

/** The legs at call time, for AG Grid getters. */
export const legPnlNow = () => legPnl(useStore.getState().snap?.exposure.hedge_day?.legs);

export interface InstrumentPnl {
  symbol: string;
  venue: Venue;
  /** What it made today (instPnl): a spot market's Trading PnL, a perp's hedge leg. USDT. */
  pnl: number;
  fills: number;
}

/**
 * Each instrument's P&L today (instPnl: Trading PnL, or a perp's hedge leg), largest first by size: the instruments that traded today or carry a
 * P&L (dust left out). `limit` caps the list.
 */
export function dayPnlList(symbols: readonly SymbolRow[] | undefined, legs: ReadonlyMap<string, number | null>, limit = Infinity): InstrumentPnl[] {
  return (symbols ?? [])
    .map((r) => ({ r, pnl: instPnl(r, legs) }))
    .filter(({ r, pnl }) => !r.dust && (r.fills_day > 0 || Math.abs(pnl) >= 0.005))
    .sort((a, b) => Math.abs(b.pnl) - Math.abs(a.pnl))
    .slice(0, limit)
    .map(({ r, pnl }) => ({ symbol: r.symbol, venue: r.venue, pnl, fills: r.fills_day }));
}

/** dayPnlList from the store (re-derived when the symbols or the legs change). */
export function useDayPnlList(limit = Infinity): InstrumentPnl[] {
  const symbols = useStore((s) => s.snap?.symbols);
  const legs = useLegPnl();
  return useMemo(() => dayPnlList(symbols, legs, limit), [symbols, legs, limit]);
}

const key = (symbol: string, venue: Venue) => `${venue}:${symbol}`;

/** Fills counted as "recent" for the busiest ranking. */
const RECENT_MS = 15 * 60_000;

/**
 * The `n` busiest quoted instruments, busiest first: those with resting orders, ranked by fills in the last
 * 15 minutes, then today's fills, then open orders. Spot only by default (the desk quotes spot; USD-M is the
 * hedge). Returns instrument keys, `"<venue>:<SYMBOL>"`.
 */
export function busiest(
  symbols: readonly SymbolRow[],
  orders: readonly OpenOrder[],
  fills: readonly Fill[],
  n: number,
  now: number,
  venue: Venue | null = "spot",
): string[] {
  const nOrders = new Map<string, number>();
  for (const o of orders) nOrders.set(key(o.symbol, o.venue), (nOrders.get(key(o.symbol, o.venue)) ?? 0) + 1);
  const recent = new Map<string, number>();
  for (const f of fills) {
    if (f.ts < now - RECENT_MS) break; // newest first
    recent.set(key(f.symbol, f.venue), (recent.get(key(f.symbol, f.venue)) ?? 0) + 1);
  }
  return symbols
    .filter((s) => (venue == null || s.venue === venue) && nOrders.has(key(s.symbol, s.venue)))
    .map((s) => {
      const k = key(s.symbol, s.venue);
      return { k, r: recent.get(k) ?? 0, d: s.fills_day, o: nOrders.get(k) ?? 0, name: s.symbol };
    })
    .sort((a, b) => b.r - a.r || b.d - a.d || b.o - a.o || a.name.localeCompare(b.name))
    .slice(0, n)
    .map((x) => x.k);
}

/** How often the busiest list is ranked again: rows keep their place in between while their dots move. */
const RERANK_MS = 30_000;

/**
 * `busiest(…)` from the store, ranked again every 30 s (and when the set of quoted instruments changes), so a
 * live list does not reshuffle under the finger. Returns `"<venue>:<SYMBOL>"` keys; pair with the live rows
 * (QuoteMapMini does).
 */
export function useBusiest(n: number, venue: Venue | null = "spot"): string[] {
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setTick((t) => t + 1), RERANK_MS);
    return () => clearInterval(id);
  }, []);
  // the quoted set, as a string: a new instrument quoted (or one gone) ranks again at once
  const quoted = useStore((s) => {
    const o = s.snap?.orders;
    if (!o) return "";
    const ks = new Set<string>();
    for (const x of o) if (venue == null || x.venue === venue) ks.add(key(x.symbol, x.venue));
    return [...ks].sort().join(",");
  });
  const ready = useStore((s) => s.snap != null);
  return useMemo(() => {
    const s = useStore.getState().snap;
    return s ? busiest(s.symbols, s.orders, s.fills, n, serverNow(), venue) : [];
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tick, quoted, ready, n, venue]);
}
