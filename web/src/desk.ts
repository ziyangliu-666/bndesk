// How this desk is set up (`Snapshot.desk`): the name on its money figures, the asset its balances are quoted in, and
// which parts of the P&L it has. Pages read it to draw only what applies; no figure depends on it.
import { useStore } from "./store";
import type { Desk, Market, Venue } from "./protocol";

/** A desk that has not said: Binance's two, the only markets before `desk.markets`. */
const MARKETS: Market[] = [
  { id: "spot", exchange: "Binance", kind: "spot", name: "Spot" },
  { id: "usdm", exchange: "Binance", kind: "perp", name: "USD-M" },
];

/** Before the first snapshot, and from a server without `desk`: everything, in USDT. */
const DEFAULT: Desk = { currency: "USDT", quote: "USDT", markets: MARKETS, hedge: true, rebates: true, mm: true };

export const useDesk = () => useStore((s) => s.snap?.desk ?? DEFAULT);
export const deskNow = () => useStore.getState().snap?.desk ?? DEFAULT;

/** The name on money figures, for text built while rendering. The first page renders after the first snapshot. */
export const cur = () => deskNow().currency;
/** The asset the accounts' free and locked quote balances are of. */
export const quoteAsset = () => deskNow().quote;

/** The markets a `venue` field can name. */
export const markets = (): Market[] => deskNow().markets ?? MARKETS;
export const marketOf = (v: Venue | null | undefined) => markets().find((m) => m.id === v);
/** Ask these, not a market's id: a perp tag, a funding row, a mark price go with the kind. */
export const isPerp = (v: Venue | null | undefined) => marketOf(v)?.kind === "perp";
export const isSpot = (v: Venue | null | undefined) => marketOf(v)?.kind === "spot";
/** The desk's spot market, where something with no market of its own (a quote balance, the busiest list) belongs. */
export const spotVenue = (): Venue => markets().find((m) => m.kind === "spot")?.id ?? "spot";
/** "Spot", "Perp": a market's word beside a symbol; its name when the kind alone would not tell two apart. */
export function kindWord(m: Market): string {
  if (markets().filter((x) => x.kind === m.kind).length > 1) return m.name;
  return m.kind === "spot" ? "Spot" : "Perp";
}
/** "Spot", "USD-M perpetual". */
export function marketTitle(v: Venue | null | undefined): string {
  const m = marketOf(v);
  return !m ? String(v ?? "") : m.kind === "perp" ? `${m.name} perpetual` : m.name;
}

/** Quote assets a symbol can end in, longest first. */
const QUOTES = ["FDUSD", "USDT", "USDC", "TUSD", "USDP", "BUSD", "USD1", "DAI"];

/** BTCUSDT -> USDT; "" when the symbol ends in no known quote. */
export function quoteOf(symbol: string): string {
  const q = deskNow().quote;
  if (symbol.endsWith(q)) return q;
  return QUOTES.find((x) => symbol.endsWith(x)) ?? "";
}

/** A market's name without the desk's quote: BTCUSDT -> BTC, BTCUSDC stays (it is not the usual market). */
export const baseOf = (symbol: string) => {
  const q = deskNow().quote;
  return symbol.endsWith(q) ? symbol.slice(0, -q.length) : symbol;
};

/** Alert rules that cannot fire on this desk, left out of the lists of checks. */
export function ruleApplies(rule: string): boolean {
  if (rule === "engine" || rule === "engine_latency") return !!useStore.getState().snap?.engines.length;
  if (rule === "futures_margin" || rule === "exposure_gap") return deskNow().hedge;
  return true;
}
