import { create } from "zustand";
import type { AccountSeries, Fill, Msg, SeriesPoint, Snapshot } from "./protocol";
import type { TzMode } from "./format";

export type Conn = "connecting" | "live" | "reconnecting";
export type Page = "desk" | "history" | "markouts" | "orders" | "accounts" | "engine";

export const MAX_FILLS = 2000;

interface State {
  snap: Snapshot | null;
  conn: Conn;
  lastMsg: number; // local clock, ms
  skew: number; // server now - local now at last message
  tz: TzMode;
  page: Page;
  /** Series names hidden per chart, from the legend words. */
  hidden: Record<string, string[]>;
  setHidden: (chart: string, names: string[]) => void;
  setConn: (c: Conn) => void;
  setTz: (tz: TzMode) => void;
  setPage: (p: Page) => void;
  apply: (m: Msg) => void;
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

function savedHidden(): Record<string, string[]> {
  try {
    const v = JSON.parse((typeof localStorage !== "undefined" && localStorage.getItem("desk.hidden")) || "{}");
    return v && typeof v === "object" ? v : {};
  } catch {
    return {};
  }
}

const savedTz = (typeof localStorage !== "undefined" && localStorage.getItem("desk.tz")) as TzMode | null;

export const useStore = create<State>((set, get) => ({
  snap: null,
  conn: "connecting",
  lastMsg: 0,
  skew: 0,
  tz: savedTz === "local" ? "local" : "utc",
  page: "desk",
  hidden: savedHidden(),
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
  setPage: (page) => set({ page }),
  apply: (m) => {
    const now = Date.now();
    const snap = get().snap;
    switch (m.type) {
      case "snapshot": {
        const s = m.data;
        set({ snap: s, lastMsg: now, skew: s.now - now, conn: "live" });
        fillListeners.forEach((fn) => fn({ kind: "reset", fills: s.fills }));
        return;
      }
      case "patch": {
        if (!snap) return;
        const next = { ...snap, ...m.data };
        set({ snap: next, lastMsg: now, skew: m.data.now != null ? m.data.now - now : get().skew });
        if (m.data.fills) fillListeners.forEach((fn) => fn({ kind: "reset", fills: next.fills }));
        return;
      }
      case "fills": {
        if (!snap) return;
        const r = upsertFills(snap.fills, m.data);
        set({ snap: { ...snap, fills: r.fills }, lastMsg: now });
        fillListeners.forEach((fn) => fn({ kind: "upsert", add: r.add, update: r.update, remove: r.remove }));
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
    }
  },
}));

/** Server time estimate, ms. */
export const serverNow = () => Date.now() + useStore.getState().skew;
