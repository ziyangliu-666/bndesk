// The alert rules' names and meanings: the alert pages and the top bar's title read them.
import type { Alert } from "../../protocol";
import { span } from "../../components/mobile/figures";

/** A rule in a few words, and what it means (DESIGN.md, "Alerts"). */
export const RULES: Record<string, { name: string; means: string }> = {
  stream_down: {
    name: "Feed down",
    means: "A feed has been disconnected for more than 10 s. A user data stream is critical: fills, orders and balances stop arriving.",
  },
  stream_silent: {
    name: "Feed silent",
    means: "A public market data connection has sent nothing for 45 s while the session is open. The watchdog reconnects it; this says it is still silent.",
  },
  user_stream: {
    name: "User stream",
    means: "An account's user data stream dropped or reconnected; its fills and balances may lag while it does.",
  },
  stale_quote: {
    name: "Stale quotes",
    means: "No top-of-book update on a tracked instrument for longer than the limit (60 s by default) while its session is open. Thin markets can sit unchanged for tens of seconds.",
  },
  orders_10s: {
    name: "Orders 10 s",
    means: "An account's orders in the last 10 s passed 80 % of Binance's limit. At the limit the venue rejects new orders.",
  },
  orders_1d: {
    name: "Orders 1 d",
    means: "An account's orders today passed 80 % of Binance's daily limit. At the limit the venue rejects new orders until the day rolls.",
  },
  rest_ban: {
    name: "Rate limit",
    means: "Binance answered 418 or 429 (rate limit or ban), or an engine entered rate-limit cooldowns. During a ban REST requests are paused.",
  },
  fee_change: {
    name: "Fee change",
    means: "An account's commission differs from the first value seen, or the fee arrangement ends within 7 days.",
  },
  drawdown: {
    name: "Drawdown",
    means: "Day PnL is below the drawdown limit, or it fell by more than the limit within 15 minutes.",
  },
  pnl_1h: { name: "Hour loss", means: "The last hour's PnL is below the limit." },
  inventory: { name: "Inventory", means: "Total inventory value is over its cap, or one asset is over the per-asset cap." },
  exposure_gap: {
    name: "Exposure gap",
    means:
      "The hedge has been off its target by more than the band for over a minute. During a planned hedge pause (the weekend, say) the target is 0: the alert then only reports, as info, the futures still open that are to be closed.",
  },
  reconcile: {
    name: "Reconcile",
    means: "Day PnL minus trading PnL, the hedge legs and the rebates has been over 1 USDT for more than 5 minutes: a fill, transfer or asset the desk does not see.",
  },
  markout: {
    name: "Markout",
    means: "The volume-weighted 10 s net markout of the last 30 minutes is below the floor, over at least 30 fills: the fills are being picked off.",
  },
  dust: { name: "Dust", means: "A balance below the symbol's minimum notional: it can't be sold as it is." },
  engine: {
    name: "Engine",
    means: "An engine's kill switch is on, its state is not running, its metrics are more than 5 s old, or its venue rejects spiked.",
  },
  engine_latency: { name: "Engine latency", means: "An engine's p99 latency is above the limit." },
  futures_margin: {
    name: "Futures margin",
    means: "An account holding futures positions has less futures balance available than the minimum.",
  },
  quote_idle: {
    name: "Quote idle",
    means: "An account's free quote has been below the minimum for too long, so it can barely bid.",
  },
};

/** How long an alert has held, as a row's figure: "for 42 s", "for 12 min", "for 2 h 5 min". */
export const heldFor = (ms: number): string => `for ${span(ms)}`;

const RANK = { crit: 0, warn: 1, info: 2 } as const;

/** The phone's alert order: active first, then by level, then the oldest first (the one that has held longest
 *  is the one not going away on its own); cleared ones newest first. */
export function byUrgency(a: Alert, b: Alert): number {
  if (a.active !== b.active) return a.active ? -1 : 1;
  if (!a.active) return b.since - a.since;
  return RANK[a.level] - RANK[b.level] || a.since - b.since;
}

export const levelWord = (l: Alert["level"]) => (l === "crit" ? "Critical" : l === "warn" ? "Warning" : "Info");

// rules whose texts carry USD amounts (Hide amounts masks them)
const MONEY_RULES = new Set(["drawdown", "pnl_1h", "inventory", "exposure_gap", "reconcile", "quote_idle", "futures_margin"]);

// a number standing alone (not part of a name like 1000PEPE, not a duration, count or rate)
const AMOUNT = /(^|[\s(=<>:])([+\-−]?)(\d(?:[\d,]*\d)?(?:\.\d+)?)(?![\w%.])(?! ?(?:min|bps|fills|orders|times|d|h|s|us)\b)/g;

/** An alert's text as the phone shows it: the typographic minus before figures, and with Hide amounts on, the
 *  USD amounts of money rules as •••. */
export function alertText(a: Pick<Alert, "rule" | "text">, hide: boolean): string {
  let t = a.text.replace(/(^|[\s(=<>:])-(?=\d)/g, "$1−");
  if (hide && MONEY_RULES.has(a.rule)) {
    // a list's " +3" (names not shown) is a count
    const more = / \+\d+$/.exec(t)?.[0] ?? "";
    t = t.slice(0, t.length - more.length).replace(AMOUNT, (_m, pre: string, sign: string) => pre + sign + "•••") + more;
  }
  return t;
}
