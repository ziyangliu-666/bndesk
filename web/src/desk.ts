// How this desk is set up (`Snapshot.desk`): the name on its money figures, the asset its balances are quoted in, and
// which parts of the P&L it has. Pages read it to draw only what applies; no figure depends on it.
import { useStore } from "./store";
import type { Desk } from "./protocol";

/** Before the first snapshot, and from a server without `desk`: everything, in USDT. */
const DEFAULT: Desk = { currency: "USDT", quote: "USDT", hedge: true, rebates: true, mm: true };

export const useDesk = () => useStore((s) => s.snap?.desk ?? DEFAULT);
export const deskNow = () => useStore.getState().snap?.desk ?? DEFAULT;

/** The name on money figures, for text built while rendering. The first page renders after the first snapshot. */
export const cur = () => deskNow().currency;
/** The asset the accounts' free and locked quote balances are of. */
export const quoteAsset = () => deskNow().quote;

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
