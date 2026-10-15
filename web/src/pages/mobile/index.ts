import { lazy, memo, type ComponentType, type LazyExoticComponent } from "react";
import type { Detail, Page, Route } from "../../store";
import type { Snapshot } from "../../protocol";
import { RULES, levelWord } from "./rules";

// The phone's pages, one lazy chunk each. A page agent owns its own file; this table only maps routes to
// them. A detail page gets its detail's fields as props (InstrumentM gets { symbol, venue }, and so on).

type Lazy<P> = LazyExoticComponent<ComponentType<P>>;
type DetailProps<K extends Detail["kind"]> = Omit<Extract<Detail, { kind: K }>, "kind">;

// Memoized: a page renders for its own data (useLive, store selectors), not each time the shell above it does
// (the shell's own state changes rarely; the freshness clock re-renders only the pill and the stale mark).
const page = <K extends string>(load: () => Promise<Record<K, ComponentType>>, name: K): Lazy<object> =>
  lazy(() => load().then((m) => ({ default: memo(m[name]) as unknown as ComponentType })));
const detail = <K extends Detail["kind"], N extends string>(
  load: () => Promise<Record<N, ComponentType<DetailProps<K>>>>,
  name: N,
): Lazy<DetailProps<K>> =>
  lazy(() => load().then((m) => ({ default: memo(m[name]) as unknown as ComponentType<DetailProps<K>> })));

export const PAGES: Record<Page, { title: string; C: Lazy<object> }> = {
  desk: { title: "Desk", C: page(() => import("./DeskM"), "DeskM") },
  alerts: { title: "Alerts", C: page(() => import("./AlertsM"), "AlertsM") },
  accounts: { title: "Accounts", C: page(() => import("./AccountsM"), "AccountsM") },
  history: { title: "History", C: page(() => import("./HistoryM"), "HistoryM") },
  more: { title: "More", C: page(() => import("./MoreM"), "MoreM") },
  markouts: { title: "Markouts", C: page(() => import("./MarkoutsM"), "MarkoutsM") },
  orders: { title: "Orders", C: page(() => import("./OrdersM"), "OrdersM") },
  engine: { title: "Engine", C: page(() => import("./EngineM"), "EngineM") },
  fills: { title: "Fills", C: page(() => import("./FillsM"), "FillsM") },
  instruments: { title: "Instruments", C: page(() => import("./InstrumentsM"), "InstrumentsM") },
};

export const DETAILS: { [K in Detail["kind"]]: Lazy<DetailProps<K>> } = {
  instrument: detail<"instrument", "InstrumentM">(() => import("./InstrumentM"), "InstrumentM"),
  account: detail<"account", "AccountM">(() => import("./AccountM"), "AccountM"),
  day: detail<"day", "DayM">(() => import("./DayM"), "DayM"),
  alert: detail<"alert", "AlertM">(() => import("./AlertM"), "AlertM"),
  "history-instrument": detail<"history-instrument", "HistoryInstrumentM">(
    () => import("./HistoryInstrumentM"),
    "HistoryInstrumentM",
  ),
};

const WEEKDAY = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTH = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "Tue 14 Oct" for 2026-10-14 (a desk day is a date, not a moment: read in UTC). */
export function dayTitle(date: string): string {
  const d = new Date(date + "T00:00:00Z");
  if (Number.isNaN(d.getTime())) return date;
  return `${WEEKDAY[d.getUTCDay()]} ${d.getUTCDate()} ${MONTH[d.getUTCMonth()]}`;
}

/** The top bar's title for a route: [title, muted suffix]. */
export function titleOf(r: Route, snap: Snapshot | null): [string, string?] {
  const d = r.detail;
  if (!d) return [PAGES[r.page].title];
  switch (d.kind) {
    case "instrument":
      return [d.symbol, d.venue === "usdm" ? "perp" : undefined];
    case "history-instrument":
      return [d.symbol, d.venue === "usdm" ? "perp history" : "history"];
    case "account":
      return [snap?.accounts.find((a) => a.id === d.id)?.label ?? d.id, "account"];
    case "day":
      return [dayTitle(d.date)];
    case "alert": {
      const a = snap?.alerts.find((x) => x.id === d.id);
      return [a ? levelWord(a.level) : "Alert", a ? (RULES[a.rule]?.name ?? a.rule) : undefined];
    }
  }
}
