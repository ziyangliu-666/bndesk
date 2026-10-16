import { useSyncExternalStore } from "react";
import { create } from "zustand";
import type { AccountSeries, Alert, DayBars, Diff, Fill, Msg, Older, SeriesPoint, Snapshot, Venue } from "./protocol";
import type { TzMode } from "./format";
import { isPhoneLayout } from "./responsive";

export type Conn = "connecting" | "live" | "reconnecting";
/** The desktop's six pages, then the phone-only ones. Markets is the phone's instruments list. */
export type Page =
  | "desk"
  | "history"
  | "analysis"
  | "orders"
  | "assets"
  | "system"
  | "alerts"
  | "more"
  | "fills"
  | "markets";
export type DeskPage = "desk" | "history" | "analysis" | "orders" | "assets" | "system";
/** An instrument: `{ symbol, venue }`. */
export interface Instrument {
  symbol: string;
  venue: Venue;
}

/** A single thing a page drills into; on the phone each is a full page with a back button. */
export type Detail =
  | { kind: "instrument"; symbol: string; venue: Venue }
  | { kind: "account"; id: string }
  | { kind: "day"; date: string } // YYYY-MM-DD
  | { kind: "alert"; id: string }
  | { kind: "history-instrument"; symbol: string; venue: Venue };

/** A page in a tab's stack, with the scroll offset it was left at. */
export interface NavEntry {
  route: Route;
  scroll: number;
}

export interface Route {
  page: Page;
  detail?: Detail;
  /** Fills only: one account's fills (`#/fills/<account>`). */
  account?: string;
  /** Orders: one instrument's orders (`#/orders/<SYMBOL>/<venue>`). Desktop Desk: the selected instrument
   *  (`#/desk/<SYMBOL>/<venue>`; the store's `deskSymbol`). */
  symbol?: string;
  venue?: Venue;
}

/** One sample of the figures an alert page draws a trend of, kept on this device (none of them has a history
 *  on the wire): at most one every RING_STEP ms, for the last RING_SPAN ms. */
export interface RingPoint {
  t: number; // server time, ms
  gap: number | null;
  band: number | null;
  hedge: number; // hedge symbols' futures notional
}
const RING_STEP = 5_000;
const RING_SPAN = 3_600_000;

export const MAX_FILLS = 2000;

interface State {
  snap: Snapshot | null;
  conn: Conn;
  lastMsg: number; // local clock, ms
  skew: number; // server now - local now at last message
  tz: TzMode;
  /** route.page, kept as its own field for the desktop. */
  page: Page;
  route: Route;
  /** Phone: the tab shown, and each tab's stack of pages (its own page first, the route shown last). */
  tab: Tab;
  stacks: Record<Tab, NavEntry[]>;
  /** USD amounts show as ••• on the phone (signs and colors stay). */
  hideAmounts: boolean;
  /** Series names hidden per chart, from the legend words. */
  hidden: Record<string, string[]>;
  /** Alerts hidden on this browser, as alertKey()s; a key goes when its alert is no longer active. */
  hiddenAlerts: string[];
  /** Exposure samples since this page opened (last hour). */
  ring: RingPoint[];
  /** Desktop Desk: the instrument picked in the instruments list (null: the desk as a whole). Kept across page
   *  switches and reloads; the Desk's hash carries it (`#/desk/<SYMBOL>/<venue>`). Set it with selectInstrument. */
  deskSymbol: Instrument | null;
  /** The chart shown fullscreen (ExChart's `id`), or null. Its own history entry, `#/chart/<id>`: Back closes it.
   *  Open and close with openChart / closeChart. */
  chart: string | null;
  hideAlert: (a: Alert) => void;
  showAlert: (a: Alert) => void;
  showAllAlerts: () => void;
  setHidden: (chart: string, names: string[]) => void;
  setConn: (c: Conn) => void;
  setTz: (tz: TzMode) => void;
  setPage: (p: Page) => void;
  setHideAmounts: (v: boolean) => void;
  apply: (m: Msg) => void;
  /** Messages applied as one store update (ws.ts: the messages of one frame). Throws when a patch does not fit,
   *  after applying the ones before it. */
  applyBatch: (ms: Msg[]) => void;
}

// Fill events for grids that stream with transactions instead of re-rendering.
export type FillEvent = { kind: "reset"; fills: Fill[] } | { kind: "upsert"; add: Fill[]; update: Fill[]; remove: Fill[] };
const fillListeners = new Set<(e: FillEvent) => void>();
export function onFills(fn: (e: FillEvent) => void): () => void {
  fillListeners.add(fn);
  return () => fillListeners.delete(fn);
}

function upsertFills(cur: Fill[], incoming: Fill[]): { fills: Fill[]; add: Fill[]; update: Fill[]; remove: Fill[] } {
  const idx = new Map<string, number>();
  cur.forEach((f, i) => idx.set(f.id, i));
  const next = cur.slice();
  const add: Fill[] = [];
  const update: Fill[] = [];
  for (const f of incoming) {
    const i = idx.get(f.id);
    if (i === undefined) add.push(f);
    else {
      next[i] = f;
      update.push(f);
    }
  }
  if (add.length) {
    add.sort((a, b) => b.ts - a.ts);
    const merged = add.concat(next);
    // keep newest first even if a late fill arrives out of order
    merged.sort((a, b) => b.ts - a.ts);
    return { fills: merged.slice(0, MAX_FILLS), add, update, remove: merged.slice(MAX_FILLS) };
  }
  return { fills: next, add, update, remove: [] };
}

function appendSeries(cur: SeriesPoint[], pts: SeriesPoint[]): SeriesPoint[] {
  if (!pts.length) return cur;
  const last = cur.length ? cur[cur.length - 1]!.t : -Infinity;
  const fresh = pts.filter((p) => p.t > last);
  // a point re-sent for the same grid slot replaces the last one
  const same = pts.find((p) => p.t === last);
  let base = cur;
  if (same) base = cur.slice(0, -1).concat(same);
  return fresh.length ? base.concat(fresh) : base;
}

/** A value with a patch's edits made: changed rows are new objects, the others stay as they were (a grid or a
 *  memoized row sees which changed). Edits that do not fit (a row past the end) throw: ws.ts reconnects. */
function edit<T>(cur: T, e: [number, Record<string, unknown>][] | Record<string, unknown>): T {
  if (!Array.isArray(cur)) return { ...cur, ...(e as Record<string, unknown>) };
  const out = cur.slice();
  for (const [i, f] of e as [number, Record<string, unknown>][]) {
    if (!(i >= 0 && i < out.length)) throw new Error(`patch: row ${i} of ${out.length}`);
    out[i] = { ...out[i], ...f };
  }
  return out as T;
}

const MINUTE = 60_000;

/** The series with the minutes before its first point taken from the minute bars (the WebSocket's snapshot
 *  carries the last minutes only): one point a minute, at the minute's start. */
function withBars(series: SeriesPoint[], bars: DayBars | undefined): SeriesPoint[] {
  if (!bars?.t.length) return series;
  const first = series.length ? series[0]!.t : Infinity;
  const cut = first - (((first % MINUTE) + MINUTE) % MINUTE);
  const head: SeriesPoint[] = [];
  for (let i = 0; i < bars.t.length && bars.t[i]! < cut; i++) {
    head.push({
      t: bars.t[i]!,
      equity: bars.equity[i]!,
      pnl_day: bars.pnl_day[i]!,
      trading: bars.trading[i] ?? null,
      hedged: null,
      inventory: bars.inventory[i]!,
      futures_notional: bars.futures[i]!,
    });
  }
  return head.length ? head.concat(series) : series;
}

const BAR_KEYS = ["t", "equity", "pnl_day", "trading", "mm", "hedge", "inventory", "futures", "volume"] as const;

/** The bars with `add`'s minutes (ascending, one run) in place of the store's over the same span. */
function mergeBars(cur: DayBars, add: DayBars): DayBars {
  if (!add.t.length) return cur;
  const from = add.t[0]!;
  const to = add.t[add.t.length - 1]!;
  let a = 0;
  while (a < cur.t.length && cur.t[a]! < from) a++;
  let b = a;
  while (b < cur.t.length && cur.t[b]! <= to) b++;
  const out = {} as Record<(typeof BAR_KEYS)[number], unknown[]>;
  for (const k of BAR_KEYS) out[k] = [...cur[k].slice(0, a), ...add[k], ...cur[k].slice(b)];
  return out as unknown as DayBars;
}

/** What the snapshot left out goes under what came since: fills the store does not have (any it has are as new
 *  or newer), each account's points before its first. */
function mergeOlder(cur: Snapshot, o: Older): { fills: Fill[]; add: Fill[]; remove: Fill[]; account_series: AccountSeries[] } {
  const have = new Set(cur.fills.map((f) => f.id));
  let add = o.fills.filter((f) => !have.has(f.id));
  let fills = cur.fills;
  let remove: Fill[] = [];
  if (add.length) {
    const merged = cur.fills.concat(add).sort((a, b) => b.ts - a.ts);
    fills = merged.slice(0, MAX_FILLS);
    // listeners hear of the rows they have: added ones that made the cut, held ones that did not
    const dropped = merged.slice(MAX_FILLS);
    const gone = new Set(dropped.map((f) => f.id));
    add = add.filter((f) => !gone.has(f.id));
    remove = dropped.filter((f) => have.has(f.id));
  }
  let account_series = cur.account_series;
  for (const a of o.account_series) {
    if (!a.t.length) continue;
    if (account_series === cur.account_series) account_series = account_series.slice();
    const i = account_series.findIndex((x) => x.account === a.account);
    if (i < 0) {
      account_series.push(a);
      continue;
    }
    const c = account_series[i]!;
    const first = c.t.length ? c.t[0]! : Infinity;
    let k = 0;
    while (k < a.t.length && a.t[k]! < first) k++;
    if (!k) continue;
    account_series[i] = {
      account: c.account,
      t: a.t.slice(0, k).concat(c.t),
      equity: a.equity.slice(0, k).concat(c.equity),
      pnl_day: a.pnl_day.slice(0, k).concat(c.pnl_day),
    };
  }
  return { fills, add, remove, account_series };
}

function appendAccountSeries(cur: AccountSeries[], add: AccountSeries[]): AccountSeries[] {
  const next = cur.slice();
  for (const a of add) {
    const i = next.findIndex((x) => x.account === a.account);
    if (i < 0) {
      next.push(a);
      continue;
    }
    const c = next[i]!;
    const last = c.t.length ? c.t[c.t.length - 1]! : -Infinity;
    const k = a.t.findIndex((t) => t > last);
    if (k < 0) continue;
    next[i] = {
      account: c.account,
      t: c.t.concat(a.t.slice(k)),
      equity: c.equity.concat(a.equity.slice(k)),
      pnl_day: c.pnl_day.concat(a.pnl_day.slice(k)),
    };
  }
  return next;
}

/** The ring with the snapshot's exposure added, when a step has passed since the last sample. */
function sample(ring: RingPoint[], s: Snapshot): { ring: RingPoint[] } | null {
  const last = ring[ring.length - 1];
  if (last && s.now - last.t < RING_STEP && s.now >= last.t) return null;
  const x = s.exposure;
  const keep = last && s.now >= last.t ? ring.filter((p) => p.t > s.now - RING_SPAN) : [];
  keep.push({ t: s.now, gap: x.gap, band: x.band, hedge: x.hedge_notional });
  return { ring: keep };
}

function savedHidden(): Record<string, string[]> {
  try {
    const v = JSON.parse((typeof localStorage !== "undefined" && localStorage.getItem("desk.hidden")) || "{}");
    return v && typeof v === "object" ? v : {};
  } catch {
    return {};
  }
}

// ---- hidden alerts: a warning or info the desk has seen leaves the banner, badge and Desk on this browser ----

/** One firing of an alert: the same key while it holds (its text's figures change at each check), a new one
 *  when it clears and fires again. */
export const alertKey = (a: Alert) => `${a.id}|${a.since}`;
/** A critical alert is never hidden. */
export const canHide = (a: Alert) => a.level !== "crit" && a.active;
export const isHidden = (a: Alert, keys: string[]) => canHide(a) && keys.includes(alertKey(a));

const HIDDEN_ALERTS_KEY = "desk.hiddenAlerts";
function savedHiddenAlerts(): string[] {
  try {
    const v = JSON.parse((typeof localStorage !== "undefined" && localStorage.getItem(HIDDEN_ALERTS_KEY)) || "[]");
    return Array.isArray(v) ? v.filter((k): k is string => typeof k === "string") : [];
  } catch {
    return [];
  }
}
function saveHiddenAlerts(keys: string[]) {
  try {
    localStorage.setItem(HIDDEN_ALERTS_KEY, JSON.stringify(keys));
  } catch {
    /* private mode */
  }
}
/** The keys whose alert is still active and hideable; null when none went. */
function pruneHidden(keys: string[], alerts: Alert[]): { hiddenAlerts: string[] } | null {
  if (!keys.length) return null;
  const live = new Set(alerts.filter(canHide).map(alertKey));
  const keep = keys.filter((k) => live.has(k));
  if (keep.length === keys.length) return null;
  saveHiddenAlerts(keep);
  return { hiddenAlerts: keep };
}

const DESK_SYMBOL_KEY = "desk.deskSymbol";
function savedDeskSymbol(): Instrument | null {
  try {
    const v = JSON.parse((typeof localStorage !== "undefined" && localStorage.getItem(DESK_SYMBOL_KEY)) || "null") as Instrument | null;
    return v && typeof v.symbol === "string" && (v.venue === "spot" || v.venue === "usdm") ? { symbol: v.symbol, venue: v.venue } : null;
  } catch {
    return null;
  }
}

const savedTz = (typeof localStorage !== "undefined" && localStorage.getItem("desk.tz")) as TzMode | null;
const savedHide = typeof localStorage !== "undefined" && localStorage.getItem("desk.hideAmounts") === "1";

// ---- Markets (phone): List | Quotes, remembered on this browser ----

export type MarketsView = "list" | "quotes";
const MARKETS_VIEW_KEY = "desk.marketsView";
let marketsView: MarketsView = (() => {
  try {
    return typeof localStorage !== "undefined" && localStorage.getItem(MARKETS_VIEW_KEY) === "quotes" ? "quotes" : "list";
  } catch {
    return "list";
  }
})();
const marketsViewSubs = new Set<() => void>();
function setMarketsView(v: MarketsView) {
  if (v === marketsView) return;
  marketsView = v;
  try {
    localStorage.setItem(MARKETS_VIEW_KEY, v);
  } catch {
    /* private mode */
  }
  marketsViewSubs.forEach((f) => f());
}

/** Markets' top toggle, `List | Quotes`: `[view, setView]`, remembered on this browser. `#/markets/quotes` sets it. */
export function useMarketsView(): [MarketsView, (v: MarketsView) => void] {
  const v = useSyncExternalStore(
    (f) => (marketsViewSubs.add(f), () => void marketsViewSubs.delete(f)),
    () => marketsView,
    () => marketsView,
  );
  return [v, setMarketsView];
}

// ---- a chart fullscreen: #/chart/<id> (openChart, below) ----

const CHART_OWNER_KEY = "desk.chartOwner";
const chartSheet = (id: string) => "chart:" + id;
const chartOf = (st: NavState): string | null => (st?.sheet?.startsWith("chart:") ? st.sheet.slice(6) : null);

/** The page a `#/chart/<id>` link (a reload) opens on: the one the chart was opened from on this tab, else the
 *  Desk. */
function chartOwner(): Route {
  try {
    const h = typeof sessionStorage !== "undefined" ? sessionStorage.getItem(CHART_OWNER_KEY) : null;
    if (h && !h.startsWith("#/chart")) return routeFromHash(h);
  } catch {
    /* private mode */
  }
  return { page: "desk" };
}

// ---- routes: the page lives in the URL hash, so a reload, a shared link or the back button keeps it ----

const PAGES: Page[] = ["desk", "history", "analysis", "orders", "assets", "system", "alerts", "more", "fills", "markets"];
/** The pages' former names: old links and bookmarks still land. */
const ALIAS: Record<string, Page> = { markouts: "analysis", accounts: "assets", engine: "system", instruments: "markets" };
const DETAIL_PAGE: Record<Detail["kind"], Page> = {
  instrument: "desk",
  account: "assets",
  day: "history",
  alert: "alerts",
  "history-instrument": "history",
};
// The desktop has no page for these: the nearest one.
const ON_DESKTOP: Record<Page, DeskPage> = {
  desk: "desk",
  history: "history",
  analysis: "analysis",
  orders: "orders",
  assets: "assets",
  system: "system",
  alerts: "system",
  more: "desk",
  fills: "desk",
  markets: "desk",
};
export const deskPage = (p: Page): DeskPage => ON_DESKTOP[p];

/** The bottom-bar tab a route belongs to (opened on its own: a link, a reload). Alerts have no tab: the bell
 *  pushes them on the current tab; a link to one opens on the Desk's. */
export type Tab = "desk" | "markets" | "history" | "assets" | "more";
export function tabOf(r: Route): Tab {
  switch (r.page) {
    case "desk":
    case "alerts":
      return "desk";
    case "markets":
    case "assets":
    case "history":
      return r.page;
    default:
      return "more";
  }
}

/** A route below a tab's own page: it gets a back button, and opening it pushes a history entry. */
export const isSub = (r: Route) => r.detail != null || !["desk", "markets", "assets", "history", "more"].includes(r.page);

const venueOf = (v: string | undefined): Venue => (v === "usdm" || v === "perp" ? "usdm" : "spot");
const enc = encodeURIComponent;

export function routeFromHash(hash: string): Route {
  const [head = "", a, b] = hash
    .replace(/^#\/?/, "")
    .split("/")
    .map((x) => {
      try {
        return decodeURIComponent(x);
      } catch {
        return x;
      }
    });
  const detail = (d: Detail): Route => ({ page: DETAIL_PAGE[d.kind], detail: d });
  const phone = isPhoneLayout();
  // an instrument is a page of its own on the phone, the Desk's selection on the desktop
  if ((head === "instrument" || head === "desk") && a)
    return phone ? detail({ kind: "instrument", symbol: a, venue: venueOf(b) }) : { page: "desk", symbol: a, venue: venueOf(b) };
  if (head === "chart") return chartOwner();
  if (head === "markets" && (a === "quotes" || a === "list")) setMarketsView(a);
  if (head === "account" && a) return detail({ kind: "account", id: a });
  if (head === "day" && a && /^\d{4}-\d{2}-\d{2}$/.test(a)) return detail({ kind: "day", date: a });
  if (head === "alert" && a) return detail({ kind: "alert", id: a });
  if (head === "history" && a) return detail({ kind: "history-instrument", symbol: a, venue: venueOf(b) });
  if (head === "fills" && a) return { page: "fills", account: a };
  if (head === "orders" && a) return { page: "orders", symbol: a, venue: venueOf(b) };
  const page = ALIAS[head] ?? head;
  return { page: PAGES.includes(page as Page) ? (page as Page) : "desk" };
}

export function hashOf(r: Route): string {
  const d = r.detail;
  if (!d) {
    if ((r.page === "orders" || r.page === "desk") && r.symbol) return `#/${r.page}/${enc(r.symbol)}/${r.venue ?? "spot"}`;
    return "#/" + r.page + (r.page === "fills" && r.account ? "/" + enc(r.account) : "");
  }
  switch (d.kind) {
    case "instrument":
      return `#/instrument/${enc(d.symbol)}/${d.venue}`;
    case "account":
      return `#/account/${enc(d.id)}`;
    case "day":
      return `#/day/${d.date}`;
    case "alert":
      return `#/alert/${enc(d.id)}`;
    case "history-instrument":
      return `#/history/${enc(d.symbol)}/${d.venue}`;
  }
}

/** Same page and detail: hash round-trip is the identity. */
export const sameRoute = (a: Route, b: Route) => hashOf(a) === hashOf(b);

/** Where back goes when there is no entry of ours to go back to (a deep link opened cold). */
export function parentOf(r: Route): Route {
  if (r.detail) return { page: r.page };
  if (r.page === "alerts") return { page: "desk" };
  if (isSub(r)) return { page: "more" };
  return r;
}

const initialChart = typeof location !== "undefined" && location.hash.startsWith("#/chart/") ? decodeURIComponent(location.hash.slice(8)) : null;
const initialRoute: Route = typeof location !== "undefined" ? routeFromHash(location.hash) : { page: "desk" };

export const useStore = create<State>((set, get) => ({
  snap: null,
  conn: "connecting",
  lastMsg: 0,
  skew: 0,
  tz: savedTz === "local" ? "local" : "utc",
  page: initialRoute.page,
  route: initialRoute,
  tab: tabOf(initialRoute), // and stacks: set from the saved ones below (initialNav)
  stacks: {} as Record<Tab, NavEntry[]>,
  hideAmounts: savedHide,
  hidden: savedHidden(),
  hiddenAlerts: savedHiddenAlerts(),
  ring: [],
  deskSymbol: initialRoute.page === "desk" && initialRoute.symbol ? { symbol: initialRoute.symbol, venue: initialRoute.venue ?? "spot" } : savedDeskSymbol(),
  chart: null,
  hideAlert: (a) => {
    const keys = get().hiddenAlerts;
    const k = alertKey(a);
    if (!canHide(a) || keys.includes(k)) return;
    const hiddenAlerts = keys.concat(k);
    saveHiddenAlerts(hiddenAlerts);
    set({ hiddenAlerts });
  },
  showAlert: (a) => {
    const k = alertKey(a);
    const hiddenAlerts = get().hiddenAlerts.filter((x) => x !== k);
    saveHiddenAlerts(hiddenAlerts);
    set({ hiddenAlerts });
  },
  showAllAlerts: () => {
    saveHiddenAlerts([]);
    set({ hiddenAlerts: [] });
  },
  setHidden: (chart, names) => {
    const hidden = { ...get().hidden, [chart]: names };
    localStorage.setItem("desk.hidden", JSON.stringify(hidden));
    set({ hidden });
  },
  setConn: (conn) => set({ conn }),
  setTz: (tz) => {
    localStorage.setItem("desk.tz", tz);
    set({ tz });
  },
  // the Desk comes back with its instrument picked (Binance keeps the pair)
  setPage: (page) => navigate(page === "desk" && !isPhoneLayout() && get().deskSymbol ? { page, ...get().deskSymbol! } : { page }, { push: false }),
  setHideAmounts: (hideAmounts) => {
    localStorage.setItem("desk.hideAmounts", hideAmounts ? "1" : "0");
    set({ hideAmounts });
  },
  apply: (m) => get().applyBatch([m]),
  applyBatch: (ms) => {
    const s0 = get();
    let draft: Partial<State> = {};
    const read = () => ({ ...s0, ...draft }) as State;
    const write = (p: Partial<State>) => void (draft = { ...draft, ...p });
    const events: FillEvent[] = [];
    let error: unknown = null;
    for (const m of ms) {
      try {
        reduce(m, read, write, events);
      } catch (e) {
        error = e;
        break;
      }
    }
    // the clocks move on every message; what draws them reads to the second: hold them still in between
    if (draft.skew != null) skewNow = draft.skew;
    if (s0.lastMsg && draft.conn == null && s0.conn === "live") {
      if (draft.lastMsg != null && draft.lastMsg - s0.lastMsg < LAST_MSG_STEP) delete draft.lastMsg;
      if (draft.skew != null && Math.abs(draft.skew - s0.skew) < SKEW_STEP) delete draft.skew;
    }
    if (Object.keys(draft).length) set(draft);
    for (const e of events) fillListeners.forEach((fn) => fn(e));
    if (error) throw error;
  },
}));

/** lastMsg in the store moves in steps this long at most (the freshness pills read seconds). */
const LAST_MSG_STEP = 1000;
/** skew in the store changes when it moved this much (clocks show seconds); serverNow() has it exact. */
const SKEW_STEP = 250;
let skewNow = 0;

/** One message into the state: `get` reads it as changed so far, `set` changes it, fill events go to `events`. */
function reduce(m: Msg, get: () => State, set: (p: Partial<State>) => void, events: FillEvent[]) {
  const now = Date.now();
  const snap = get().snap;
  switch (m.type) {
    case "snapshot": {
      const s = { ...m.data, series: withBars(m.data.series, m.data.bars) };
      set({ snap: s, lastMsg: now, skew: s.now - now, conn: "live", ...sample(get().ring, s), ...pruneHidden(get().hiddenAlerts, s.alerts) });
      events.push({ kind: "reset", fills: s.fills });
      return;
    }
    case "patch": {
      if (!snap) return;
      const { diff, ...whole } = m.data;
      const next = { ...snap, ...whole };
      if (diff) for (const k of Object.keys(diff) as (keyof Diff)[]) Object.assign(next, { [k]: edit(snap[k], diff[k]!) });
      set({
        snap: next,
        lastMsg: now,
        skew: m.data.now != null ? m.data.now - now : get().skew,
        ...(m.data.exposure || diff?.exposure ? sample(get().ring, next) : null),
        ...(m.data.alerts || diff?.alerts ? pruneHidden(get().hiddenAlerts, next.alerts) : null),
      });
      if (m.data.fills) events.push({ kind: "reset", fills: next.fills });
      return;
    }
    case "fills": {
      if (!snap) return;
      const r = upsertFills(snap.fills, m.data);
      set({ snap: { ...snap, fills: r.fills }, lastMsg: now });
      events.push({ kind: "upsert", add: r.add, update: r.update, remove: r.remove });
      return;
    }
    case "series": {
      if (!snap) return;
      set({ snap: { ...snap, series: appendSeries(snap.series, m.data) }, lastMsg: now });
      return;
    }
    case "account_series": {
      if (!snap) return;
      set({ snap: { ...snap, account_series: appendAccountSeries(snap.account_series, m.data) }, lastMsg: now });
      return;
    }
    case "bars": {
      if (!snap) return;
      set({ snap: { ...snap, bars: mergeBars(snap.bars, m.data) }, lastMsg: now });
      return;
    }
    case "older": {
      if (!snap) return;
      const r = mergeOlder(snap, m.data);
      set({ snap: { ...snap, fills: r.fills, account_series: r.account_series }, lastMsg: now });
      if (r.add.length) events.push({ kind: "upsert", add: r.add, update: [], remove: r.remove });
      return;
    }
  }
}

/** Server time estimate, ms. */
export const serverNow = () => Date.now() + skewNow;

// ---- navigation ----

/**
 * Phone navigation: each tab keeps its own stack of pages (with the scroll offset each was left at), like an
 * app's tab bar. Coming back to a tab shows the page it was left on; back steps down the current tab's stack,
 * then to the Desk's own page, then leaves the app.
 *
 * The browser's history always holds the current tab's stack only: the Desk's own page at the bottom (depth 0),
 * then, for another tab, that tab's pages above it; for the Desk, the Desk's pages. A tab switch drops the
 * entries above the bottom one (history.go, async: it completes on its popstate) and pushes the new tab's
 * stack, so back never lands on another tab's page. An open sheet adds an entry of its own (`sheet`), so back
 * closes it first. Each entry carries its depth (`bn`: our entries below it) and its tab.
 */
export type NavState = { bn?: number; sheet?: string; tab?: Tab } | null;
const navState = () => history.state as NavState;
const depth = () => navState()?.bn ?? 0;

const TABS: Tab[] = ["desk", "markets", "history", "assets", "more"];
const rootOf = (tab: Tab): Route => ({ page: tab });
const isRoot = (r: Route, tab: Tab) => sameRoute(r, rootOf(tab));

/** The stack a route opened on its own (a link, a reload without a saved stack) sits on: its tab's page below. */
const chainOf = (r: Route, tab: Tab): NavEntry[] =>
  isRoot(r, tab) ? [{ route: r, scroll: 0 }] : [{ route: rootOf(tab), scroll: 0 }, { route: r, scroll: 0 }];

const freshStacks = (): Record<Tab, NavEntry[]> =>
  Object.fromEntries(TABS.map((t) => [t, [{ route: rootOf(t), scroll: 0 }]])) as Record<Tab, NavEntry[]>;

const STACKS_KEY = "desk.navStacks";

/** The tab and stacks at load: the saved ones when this is an entry of ours (a reload, back into the app),
 *  cut at the page shown; else the route on its tab. */
function initialNav(r: Route): { tab: Tab; stacks: Record<Tab, NavEntry[]> } {
  const stacks = freshStacks();
  if (typeof window === "undefined") return { tab: tabOf(r), stacks };
  const st = navState();
  const tab = st?.tab && TABS.includes(st.tab) ? st.tab : tabOf(r);
  if (st?.bn != null) {
    try {
      const saved = JSON.parse(sessionStorage.getItem(STACKS_KEY) ?? "null") as Record<Tab, NavEntry[]> | null;
      if (saved) {
        for (const t of TABS) if (Array.isArray(saved[t]) && saved[t].length && isRoot(saved[t][0]!.route, t)) stacks[t] = saved[t];
        const i = findRoute(stacks[tab], r);
        if (i >= 0) {
          stacks[tab] = stacks[tab].slice(0, i + 1);
          return { tab, stacks };
        }
      }
    } catch {
      /* no saved stacks */
    }
  }
  stacks[tab] = chainOf(r, tab);
  return { tab, stacks };
}

function findRoute(stack: NavEntry[], r: Route): number {
  for (let i = stack.length - 1; i >= 0; i--) if (sameRoute(stack[i]!.route, r)) return i;
  return -1;
}

const initialStacks = initialNav(initialRoute);
useStore.setState({ tab: initialStacks.tab, stacks: initialStacks.stacks });
if (typeof window !== "undefined") {
  // tag the entry the app opened on (a cold link has nothing of ours below it)
  if (navState()?.bn == null) history.replaceState({ ...(history.state ?? {}), bn: 0, tab: initialStacks.tab } satisfies NavState, "", location.href);
  // an old page name (#/markouts) or a layout's other form of an instrument: the hash says where we are
  if (!initialChart && location.hash && location.hash !== hashOf(initialRoute)) history.replaceState(history.state, "", hashOf(initialRoute));
  // a fullscreen chart's link (a reload): its page below, the chart's entry over it (its ExChart opens on mount)
  if (initialChart && chartOf(navState()) === initialChart) useStore.setState({ chart: initialChart });
  else if (initialChart) {
    const st = navState();
    history.replaceState({ ...st, sheet: undefined } satisfies NavState, "", hashOf(initialRoute));
    history.pushState({ ...st, sheet: chartSheet(initialChart) } satisfies NavState, "", "#/chart/" + enc(initialChart));
    useStore.setState({ chart: initialChart });
  }
  useStore.subscribe((s, prev) => {
    if (s.stacks === prev.stacks) return;
    try {
      sessionStorage.setItem(STACKS_KEY, JSON.stringify(s.stacks));
    } catch {
      /* private mode */
    }
  });
}

let lastNav: "push" | "replace" | "pop" | "tab" = "replace";

/** Remember the current page's scroll offset in its stack entry (no re-render: nothing draws it). */
function leave() {
  const s = useStore.getState();
  const stack = s.stacks[s.tab];
  const top = stack[stack.length - 1];
  if (top && sameRoute(top.route, s.route)) top.scroll = window.scrollY;
}

/** How the current route was reached, and its scroll offset when last left (back and tabs restore it). */
export function arrival(r: Route) {
  const s = useStore.getState();
  const stack = s.stacks[s.tab];
  const top = stack[stack.length - 1];
  return { how: lastNav, scroll: top && sameRoute(top.route, r) ? top.scroll : 0 };
}

/** Show the top of a tab's stack. */
function show(tab: Tab, stack: NavEntry[]) {
  const s = useStore.getState();
  const to = stack[stack.length - 1]!.route;
  const sel = to.page === "desk" && !to.detail && !isPhoneLayout() ? deskSymbolOf(to) : undefined;
  useStore.setState({ tab, stacks: { ...s.stacks, [tab]: stack }, route: to, page: to.page, ...(sel !== undefined && keepDeskSymbol(sel)) });
}

const deskSymbolOf = (r: Route): Instrument | null => (r.symbol ? { symbol: r.symbol, venue: r.venue ?? "spot" } : null);

function keepDeskSymbol(v: Instrument | null): { deskSymbol: Instrument | null } | null {
  const cur = useStore.getState().deskSymbol;
  if (cur?.symbol === v?.symbol && cur?.venue === v?.venue) return null;
  try {
    localStorage.setItem(DESK_SYMBOL_KEY, JSON.stringify(v));
  } catch {
    /* private mode */
  }
  return { deskSymbol: v };
}

/** The same place on this layout: an instrument is the Desk's selection on the desktop and a page of its own on
 *  the phone. */
function forLayout(r: Route): Route {
  const d = r.detail;
  if (!isPhoneLayout()) return d?.kind === "instrument" ? { page: "desk", symbol: d.symbol, venue: d.venue } : r;
  return r.page === "desk" && !d && r.symbol ? { page: "desk", detail: { kind: "instrument", symbol: r.symbol, venue: r.venue ?? "spot" } } : r;
}

/**
 * Open an instrument from any row: on the desktop the Desk with it picked (its chart, ladder and ticker), on the
 * phone its own page (pushed on the current tab). `null` (desktop): back to the desk as a whole.
 */
export function selectInstrument(i: Instrument | null) {
  if (!i) return navigate({ page: "desk" }, { push: false });
  navigate({ page: "desk", detail: { kind: "instrument", symbol: i.symbol, venue: i.venue } });
}

/** Go to the Markets tab showing `view` (the phone Desk's quotes block: "All" opens the full map). */
export function openMarkets(view: MarketsView) {
  setMarketsView(view);
  switchTab("markets", { page: "markets" });
}

// ---- a chart fullscreen: #/chart/<id> ----

/**
 * Show the chart `id` (ExChart's id) fullscreen: a history entry of its own, `#/chart/<id>`, over the page it
 * was opened from, so Back closes it and a reload comes back to it. ExChart calls this from its ⤢ (after
 * goFullscreen, inside the click); an ExChart whose id is `chart` shows its fullscreen copy.
 */
export function openChart(id: string) {
  const s = useStore.getState();
  if (s.chart === id) return;
  try {
    sessionStorage.setItem(CHART_OWNER_KEY, hashOf(s.route));
  } catch {
    /* private mode */
  }
  const st = navState();
  if (chartOf(st)) history.replaceState({ ...st, sheet: chartSheet(id) } satisfies NavState, "", "#/chart/" + enc(id));
  else history.pushState({ ...(st ?? {}), sheet: chartSheet(id) } satisfies NavState, "", "#/chart/" + enc(id));
  useStore.setState({ chart: id });
}

/** Close the fullscreen chart: back off its history entry. */
export function closeChart() {
  const id = useStore.getState().chart;
  if (id == null) return;
  if (chartOf(navState()) === id) history.back();
  else useStore.setState({ chart: null });
}

/**
 * Go to a route. On a phone, opening something below a tab (a detail, an instrument list) pushes it on the
 * current tab's stack, with a history entry so the phone's back gesture returns; a tab's own page goes
 * through switchTab (its stack starts again there). `push: false` replaces the current page. The desktop
 * never adds entries: its pages are tabs.
 */
export function navigate(to: Route, opts: { push?: boolean } = {}) {
  to = forLayout(to);
  const hash = hashOf(to);
  const overSheet = navState()?.sheet != null;
  if (!isPhoneLayout()) {
    lastNav = "replace";
    const tab = tabOf(to);
    if (hash !== location.hash) history.replaceState({ bn: 0, tab } satisfies NavState, "", hash);
    return show(tab, chainOf(to, tab));
  }
  if (opts.push == null && !isSub(to)) return switchTab(tabOf(to), to);
  const s = useStore.getState();
  if (sameRoute(to, s.route)) {
    // the page asked for is the one under the open sheet: going there is closing the sheet
    if (overSheet) history.back();
    return;
  }
  const push = opts.push ?? true;
  leave();
  lastNav = push ? "push" : "replace";
  const stack = s.stacks[s.tab];
  const entry = { route: to, scroll: 0 };
  // from inside an open sheet, the page replaces the sheet's entry: back then skips the closed sheet
  if (push && !overSheet) history.pushState({ bn: depth() + 1, tab: s.tab } satisfies NavState, "", hash);
  else history.replaceState({ bn: overSheet && push ? depth() + 1 : depth(), tab: s.tab } satisfies NavState, "", hash);
  show(s.tab, push ? stack.concat(entry) : stack.slice(0, -1).concat(entry));
}

// A tab switch waiting for history.go to land on the bottom entry.
let pending: { tab: Tab; stack: NavEntry[] } | null = null;

/** The browser's entries for a tab's stack, from the bottom one (which must be current): the Desk's own page,
 *  then the stack's pages. */
function writeEntries(tab: Tab, stack: NavEntry[]) {
  const routes = stack.map((e) => e.route);
  const list = tab === "desk" ? routes : [rootOf("desk"), ...routes];
  list.forEach((r, bn) => {
    const st = { bn, tab: bn === 0 && tab !== "desk" ? "desk" : tab } satisfies NavState;
    if (bn === 0) history.replaceState(st, "", hashOf(r));
    else history.pushState(st, "", hashOf(r));
  });
}

/**
 * Phone: go to a tab. Without `to`, the tab shows the page it was left on; with it (a link to a tab's own
 * page, a tap on the current tab), its stack starts again at `to`.
 */
export function switchTab(tab: Tab, to?: Route) {
  const s = useStore.getState();
  const stack = to ? chainOf(to, tab) : s.stacks[tab];
  if (pending) {
    // a second tap while the first switch is under way: it wins
    pending = { tab, stack };
    return show(tab, stack);
  }
  const st = navState();
  const top = stack[stack.length - 1]!.route;
  if (tab === s.tab && sameRoute(top, s.route) && st?.sheet == null) return;
  leave();
  lastNav = "tab";
  // our entries above the bottom one, counting an open sheet's
  const at = (st?.bn ?? 0) + (st?.sheet != null ? 1 : 0);
  show(tab, stack);
  if (at > 0) {
    pending = { tab, stack };
    history.go(-at);
    return;
  }
  writeEntries(tab, stack);
}

/** Back one step in the current tab, then to the Desk: the browser's own back when the entry below is ours,
 *  else (a link opened cold) the page below, in place. */
export function back() {
  if (depth() > 0) return history.back();
  const s = useStore.getState();
  const stack = s.stacks[s.tab];
  leave();
  lastNav = "pop";
  if (stack.length > 1) {
    const below = stack.slice(0, -1);
    history.replaceState({ bn: 0, tab: s.tab } satisfies NavState, "", hashOf(below[below.length - 1]!.route));
    return show(s.tab, below);
  }
  if (s.tab !== "desk") {
    history.replaceState({ bn: 0, tab: "desk" } satisfies NavState, "", hashOf(rootOf("desk")));
    show("desk", [s.stacks.desk[0]!]);
  }
}

if (typeof window !== "undefined") {
  history.scrollRestoration = "manual";
  window.addEventListener("popstate", () => {
    // a fullscreen chart's entry: the chart shows while it is the current entry
    const fs = chartOf(navState());
    if (useStore.getState().chart !== fs) useStore.setState({ chart: fs });
    const p = pending;
    if (fs && !p) return;
    if (p) {
      // the drop for a tab switch has landed (or, under a sheet, not yet all the way)
      const at = depth() + (navState()?.sheet != null ? 1 : 0);
      if (at > 0) return history.go(-at);
      pending = null;
      writeEntries(p.tab, p.stack);
      const s = useStore.getState();
      if (s.tab !== p.tab || !sameRoute(s.route, p.stack[p.stack.length - 1]!.route)) show(p.tab, p.stack);
      return;
    }
    const r = routeFromHash(location.hash);
    const st = navState();
    const s = useStore.getState();
    if (st?.bn == null) {
      // a link or a typed hash: a new entry above the current one, on the route's own tab (alert → Alerts,
      // account → Accounts, instrument → Desk, day → History, orders → More): on top of that tab's stack when
      // it is the current tab, else the tab starts again below it
      if (sameRoute(r, s.route)) return;
      const bn = s.stacks[s.tab].length - (s.tab === "desk" ? 1 : 0) + 1;
      const tab = tabOf(r);
      history.replaceState({ bn, tab } satisfies NavState, "", hashOf(r));
      leave();
      lastNav = "push";
      return show(tab, tab === s.tab && isSub(r) ? s.stacks[tab].concat({ route: r, scroll: 0 }) : chainOf(r, tab));
    }
    const tab = st.tab && TABS.includes(st.tab) ? st.tab : tabOf(r);
    if (tab === s.tab && sameRoute(r, s.route)) return; // a sheet's entry came and went
    leave();
    lastNav = "pop";
    // back to the bottom entry from another tab: the Desk's own page
    if (st.bn === 0 && tab === "desk" && isRoot(r, "desk")) return show("desk", [s.stacks.desk[0]!]);
    const stack = s.stacks[tab];
    const i = findRoute(stack, r);
    // forward to a page dropped from the stack: it goes back on top
    show(tab, i >= 0 ? stack.slice(0, i + 1) : stack.concat({ route: r, scroll: 0 }));
  });
}
