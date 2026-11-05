// Small derived lists the pages share: each instrument's P&L today (the footer's marquee, top movers), and the
// busiest instruments (the phone Desk's live quotes block).
import { useCallback, useEffect, useMemo, useState } from "react";
import type { Fill, HedgeLeg, OpenOrder, SymbolRow, Venue } from "./protocol";
import { serverNow, useStore } from "./store";
import { int } from "./format";
import { maskText, money } from "./mask";
import { cur, isHedge, isTraded } from "./desk";

/**
 * "Trading PnL" is market making + inventory PnL, fees included, and never the hedge, on every page and size.
 * What the desk trades has one (`trading_pnl`); what hedges has none (null: shown as `--`), its P&L today is its
 * hedge leg's (`hedgePnl`: price P&L at mark − fees + funding), shown under a Hedge figure or column. Which is which is
 * the instrument's role, whatever its market's kind (a perp hedges and spot is traded only until a desk says). The
 * desk's Day PnL = the Trading PnLs + the hedge legs + rebates + other.
 */
export function tradingPnl(r: SymbolRow): number | null {
  return isHedge(r) ? null : r.trading_pnl;
}

/** What hedges: its leg's P&L today (null for what is traded, and with no leg today). */
export function hedgePnl(r: SymbolRow, legs: ReadonlyMap<string, number | null> | null | undefined): number | null {
  return isHedge(r) ? (legs?.get(`${r.venue}:${r.symbol}`) ?? null) : null;
}

/** What an instrument made today, whichever role it has: its Trading PnL or its hedge leg.
 *  For rankings across both (top movers, the marquee), always shown with its kind. */
export function instPnl(r: SymbolRow, legs: ReadonlyMap<string, number | null> | null | undefined): number {
  return (isHedge(r) ? hedgePnl(r, legs) : r.trading_pnl) ?? 0;
}

const NO_LEGS: ReadonlyMap<string, number | null> = new Map();

/** Today's P&L of each hedge leg, by `venue:symbol`. */
export function legPnl(legs: readonly HedgeLeg[] | undefined): ReadonlyMap<string, number | null> {
  return legs?.length ? new Map(legs.map((l) => [`${l.venue}:${l.symbol}`, l.pnl])) : NO_LEGS;
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

const key = (symbol: string, venue: Venue) => `${venue}:${symbol}`;

/** Fills counted as "recent" for the busiest ranking. */
const RECENT_MS = 15 * 60_000;

/**
 * The `n` busiest quoted instruments, busiest first: those with resting orders, ranked by fills in the last
 * 15 minutes, then today's fills, then open orders. What the desk trades by default, not what hedges; a market's alone
 * given `venue`, any with null. Returns instrument keys, `"<venue>:<SYMBOL>"`.
 */
export function busiest(
  symbols: readonly SymbolRow[],
  orders: readonly OpenOrder[],
  fills: readonly Fill[],
  n: number,
  now: number,
  venue?: Venue | null,
): string[] {
  const nOrders = new Map<string, number>();
  for (const o of orders) nOrders.set(key(o.symbol, o.venue), (nOrders.get(key(o.symbol, o.venue)) ?? 0) + 1);
  const recent = new Map<string, number>();
  for (const f of fills) {
    if (f.ts < now - RECENT_MS) break; // newest first
    recent.set(key(f.symbol, f.venue), (recent.get(key(f.symbol, f.venue)) ?? 0) + 1);
  }
  return symbols
    .filter((s) => (venue === undefined ? isTraded(s) : venue === null || s.venue === venue) && nOrders.has(key(s.symbol, s.venue)))
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
export function useBusiest(n: number, venue?: Venue | null): string[] {
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

/** The fills Market making leaves out for want of a price 60 s after them, as a sentence ("" when none). */
export function unpriced(p: { mm_unmarked_fills: number; mm_unmarked_notional: number } | undefined, hide: boolean): string {
  const n = p?.mm_unmarked_fills ?? 0;
  if (!n) return "";
  return ` ${int(n)} fill${n === 1 ? "" : "s"} without a 60 s price (${maskText(hide, money(p!.mm_unmarked_notional))} ${cur()} notional) left out: none taken live, none from the exchange's klines (yet).`;
}

/** Where a list has one column for an instrument's P&L: its market making (the inventory's part is on its page),
 *  or with no split kept, the trading P&L. What hedges has neither (its leg is shown in its place). */
export const oneCol = (r: SymbolRow, mm: boolean): number => (mm ? r.mm_pnl : r.trading_pnl);
/** That column's heading. */
export const oneColWord = (mm: boolean) => (mm ? "MM" : "Trading");
