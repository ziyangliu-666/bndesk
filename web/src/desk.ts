// How this desk is set up (`Snapshot.desk`): the name on its money figures, the asset its balances are quoted in, and
// which parts of the P&L it has. Pages read it to draw only what applies; no figure depends on it.
import { useStore } from "./store";
import type { Desk, InstRole, Market, Venue } from "./protocol";

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
/** What an instrument is for: its own role, else its market's, else its market's kind's. Ask this, not the kind, whether
 *  a figure is Trading PnL or Hedge; a spot role is its base asset's (`server/src/protocol.rs`, `Roles`). */
export function roleOf(symbol: string, venue: Venue | null | undefined): InstRole {
  const r = deskNow().roles;
  const spot = isSpot(venue);
  const k = spot ? (QUOTES.find((q) => symbol.endsWith(q)) ?? "") : "";
  return r?.instruments[`${venue}:${k ? symbol.slice(0, -k.length) : symbol}`] ?? r?.markets[String(venue)] ?? (isPerp(venue) ? "hedge" : "traded");
}
export const isHedge = (r: { symbol: string; venue: Venue }) => roleOf(r.symbol, r.venue) === "hedge";
export const isTraded = (r: { symbol: string; venue: Venue }) => roleOf(r.symbol, r.venue) === "traded";
/** The desk trades what spot alone does not say: any role set makes "spot" and "futures" the wrong words for its figures. */
export const roled = (d: Desk = deskNow()) =>
  !!d.roles &&
  (Object.keys(d.roles.markets).length > 0 || Object.entries(d.roles.instruments).some(([k, r]) => r !== (isPerp(k.split(":")[0]) ? "hedge" : "traded")));
/** "Spot inventory", "Inventory". */
export const inventoryWord = () => (roled() ? "Inventory" : "Spot inventory");
/** "futures", "hedge": what the exposure's other side is called. */
export const hedgeWord = () => (roled() ? "hedge" : "futures");
/** "Futures notional", "Hedge notional". */
export const notionalWord = () => (roled() ? "Hedge notional" : "Futures notional");
/** The futures columns and tabs: positions and margin, whichever role they have. */
export const hasPerps = (d: Desk) => d.perps ?? d.hedge;
/** The desk's spot market, where something with no market of its own (a quote balance, the busiest list) belongs. */
export const spotVenue = (): Venue => markets().find((m) => m.kind === "spot")?.id ?? "spot";
/** "Spot", "Perp": a market's word beside a symbol; its name when the kind alone would not tell two apart. */
export function kindWord(m: Market): string {
  if (markets().filter((x) => x.kind === m.kind).length > 1) return m.name;
  return m.kind === "spot" ? "Spot" : "Perp";
}
/** The word beside a symbol's name: "Perp", or a market's name where the kind alone would not tell two apart. Nothing on
 *  the desk's only spot market, whose rows have always gone untagged. */
export function venueTag(v: Venue | null | undefined): string {
  const m = marketOf(v);
  if (!m) return "";
  return m.kind === "spot" && markets().filter((x) => x.kind === "spot").length < 2 ? "" : kindWord(m);
}
/** Whose limit or rebate it is, where no one market says: the desk's one exchange, else "the exchange". */
export function exchangeWord(): string {
  const all = new Set(markets().map((m) => m.exchange));
  return all.size === 1 ? [...all][0]! : "the exchange";
}
/** The word on balances counted as cash: the quote while it is what the figures are in and the desk has one exchange, whose
 *  stablecoins are all that word has ever covered; else what it is. */
export function cashWord(): string {
  const d = deskNow();
  const named = d.currency === d.quote || d.currency === "USD";
  return named && new Set(markets().map((m) => m.exchange)).size === 1 ? d.quote : "Cash";
}
/** What a fill's or an order's own notional, and the volume stored with it, is called: each stays in what it is quoted in,
 *  all about a dollar on a desk in dollars, and on a desk in anything else not in its currency. */
export const notionalCur = () => (DOLLARS.includes(deskNow().currency) ? cur() : quoteAsset());
/** "EUR from 2 Nov", on a desk whose earlier figures are in another currency; and what became of them. */
export function earlierNote(d: Desk = deskNow()): { text: string; title: string } | null {
  if (!d.earlier) return null;
  const day = new Date(d.earlier.until).toLocaleDateString("en-GB", { day: "numeric", month: "short", timeZone: "UTC" });
  return { text: `${d.currency} from ${day}`, title: `Figures before this are in ${d.earlier.currency}: kept, and shown again if the desk's currency goes back to it.` };
}
/** Whose figure it is: the exchange of the market it came from. */
export const exchangeOf = (v: Venue | null | undefined) => marketOf(v)?.exchange ?? "The exchange";
/** "Spot", "USD-M perpetual". */
export function marketTitle(v: Venue | null | undefined): string {
  const m = marketOf(v);
  return !m ? String(v ?? "") : m.kind === "perp" ? `${m.name} perpetual` : m.name;
}

/** Quote assets a symbol can end in, longest first. */
const QUOTES = ["FDUSD", "USDT", "USDC", "TUSD", "USDP", "BUSD", "USD1", "DAI"];
const DOLLARS = ["USD", ...QUOTES];

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
  if (rule === "futures_margin") return hasPerps(deskNow());
  if (rule === "exposure_gap") return deskNow().hedge;
  if (rule === "orders_10s" || rule === "orders_1d") return useStore.getState().snap?.accounts.some((a) => !a.no_order_limits) ?? true;
  return true;
}
