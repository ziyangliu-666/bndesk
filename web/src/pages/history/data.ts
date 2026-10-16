// Desktop History: what the page loads and the rows it draws. The desk's P&L comes from /api/history (bars
// of cumulative P&L and its split, held in memory by the server), an instrument's from /api/klines and
// /api/fills. Every load is keyed by what it was asked for, and the page shows a load only under its own key:
// a switch of range, interval or instrument clears the chart at once and never shows the old bars under the
// new label.
import { useEffect, useMemo, useRef, useState } from "react";
import { getJSON, type HistBar, type HistDay, type HistFill, type History as Hist } from "../../api";
import { serverNow, useStore } from "../../store";
import type { DayPnl, Fill, Venue } from "../../protocol";
import { barStart } from "../../components/ex";

export const DAY = 86_400_000;
const HOUR = 3_600_000;

export type Range = "7d" | "30d" | "90d" | "all";
export type HInterval = "15m" | "1h" | "4h" | "1d" | "1w";
export type Mode = "daily" | "cum" | "candles";

export const RANGES: Range[] = ["7d", "30d", "90d", "all"];
export const INTERVALS: HInterval[] = ["15m", "1h", "4h", "1d", "1w"];
export const MODES: Mode[] = ["daily", "cum", "candles"];
export const RANGE_LABEL: Record<Range, string> = { "7d": "7D", "30d": "30D", "90d": "90D", all: "All" };
export const IV_LABEL: Record<HInterval, string> = { "15m": "15m", "1h": "1H", "4h": "4H", "1d": "1D", "1w": "1W" };
const RANGE_DAYS: Record<Range, number> = { "7d": 7, "30d": 30, "90d": 90, all: 3650 };
/** /api/history's bar size for an interval, seconds (a week is built here from days). */
export const STEP_S: Record<HInterval, number> = { "15m": 900, "1h": 3600, "4h": 14400, "1d": 86400, "1w": 86400 };
export const IV_MS: Record<HInterval, number> = { "15m": 900_000, "1h": HOUR, "4h": 4 * HOUR, "1d": DAY, "1w": 7 * DAY };

/** The range's first P&L day start: `dayStart` is today's. "All" asks for ten years; the server keeps what it has. */
export const rangeFrom = (range: Range, dayStart: number) => dayStart - (RANGE_DAYS[range] - 1) * DAY;

/** The P&L day a time falls in, from today's start (days are 24 h from the configured day start). */
export const dayOf = (t: number, dayStart: number) => t - ((((t - dayStart) % DAY) + DAY) % DAY);

/** The week of a day bar (Monday 00:00 UTC weeks; a day goes by its midday, whatever the day start). */
export const weekOf = (t: number) => barStart(t + DAY / 2, "1w");

// ================================ desk history ================================

interface Loaded {
  bars: HistBar[];
  days: HistDay[];
}
const cache = new Map<string, Loaded>();
const inflight = new Map<string, Promise<Loaded>>();
const CACHE_MAX = 12;

function put(key: string, v: Loaded) {
  cache.delete(key);
  cache.set(key, v);
  while (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value!);
}

function loadFull(key: string, step: number, from: number): Promise<Loaded> {
  let p = inflight.get(key);
  if (!p) {
    p = getJSON<Hist>("/api/history", { from, to: serverNow(), step }).then((h) => {
      const v = { bars: h.bars, days: h.days };
      put(key, v);
      return v;
    });
    p.finally(() => inflight.delete(key)).catch(() => {});
    inflight.set(key, p);
  }
  return p;
}

const same = (a: number | null, b: number | null) => (a == null || b == null ? a === b : Math.abs(a - b) < 1e-9);
function sameBar(a: HistBar, b: HistBar): boolean {
  return (
    a.t === b.t && same(a.o, b.o) && same(a.h, b.h) && same(a.l, b.l) && same(a.c, b.c) && same(a.pi, b.pi) && same(a.mm, b.mm) &&
    same(a.hedge, b.hedge) && same(a.rebates, b.rebates) && same(a.realized, b.realized) && same(a.inventory, b.inventory) &&
    same(a.futures, b.futures) && a.volume === b.volume && a.fills === b.fills
  );
}

/**
 * The full range's bars with a later fetch's bars (`tail`, from one of full's bars on) in place of its end.
 * Each running total of `tail` starts at 0 where it starts, so it differs from `full`'s by a constant, read
 * off the first bar both have complete. A bar that comes back unchanged keeps its object (the chart then
 * updates only the bars that moved); nothing changed gives `full` itself.
 */
export function joinTail(full: HistBar[], tail: HistBar[]): HistBar[] {
  if (!tail.length) return full;
  const j = full.findIndex((b) => b.t === tail[0]!.t);
  if (j < 0) return full;
  const off: Record<string, number> = { c: full[j]!.o - tail[0]!.o };
  for (const k of ["pi", "mm", "realized", "hedge", "rebates"] as const) {
    for (let i = j; i < full.length - 1 && i - j < tail.length; i++) {
      const a = full[i]![k],
        b = tail[i - j]![k];
      if (a != null && b != null) {
        off[k] = a - b;
        break;
      }
    }
    // a series that starts inside the tail starts there in the full range too
    if (off[k] == null && full.slice(j).every((b) => b[k] == null)) off[k] = 0;
  }
  const add = (v: number | null, k: string) => (v == null || off[k] == null ? null : v + off[k]!);
  const c = off.c!;
  let changed = full.length !== j + tail.length;
  const out = full.slice(0, j);
  tail.forEach((b, i) => {
    const n: HistBar = {
      ...b,
      o: b.o + c,
      h: b.h + c,
      l: b.l + c,
      c: b.c + c,
      pi: add(b.pi, "pi"),
      mm: add(b.mm, "mm"),
      realized: add(b.realized, "realized"),
      hedge: add(b.hedge, "hedge"),
      rebates: add(b.rebates, "rebates"),
    };
    const old = full[j + i];
    if (old && sameBar(old, n)) out.push(old);
    else {
      changed = true;
      out.push(n);
    }
  });
  return changed ? out : full;
}

const NO_BARS: HistBar[] = [];
const NO_DAYS: HistDay[] = [];
const TAIL_MS = 3000;

export interface DeskLoad {
  key: string;
  bars: HistBar[];
  days: HistDay[];
  loading: boolean;
  error: string | null;
}

/**
 * The desk's bars of `step` seconds from `from` to now, kept current: every few seconds the last bars are
 * fetched again and joined on. A key seen before (switching back) shows at once from memory.
 */
export function useDeskHistory(step: number, from: number | null): DeskLoad {
  const key = from == null ? "" : `${step}|${from}`;
  const [st, setSt] = useState<{ key: string; v: Loaded | null; error: string | null }>({ key: "", v: null, error: null });
  const cur = useRef(key);
  cur.current = key;

  useEffect(() => {
    if (from == null) return;
    let alive = true;
    const show = (v: Loaded) => alive && cur.current === key && setSt({ key, v, error: null });
    const hit = cache.get(key);
    if (hit) show(hit);
    else
      loadFull(key, step, from).then(show, (e: unknown) => {
        if (alive && cur.current === key) setSt({ key, v: { bars: NO_BARS, days: NO_DAYS }, error: (e as Error).message || "request failed" });
      });
    let busy = false;
    const tick = async () => {
      const c = cache.get(key);
      if (busy || document.visibilityState === "hidden" || !c || c.bars.length < 2) return;
      busy = true;
      try {
        const t = await getJSON<Hist>("/api/history", { from: c.bars[c.bars.length - 2]!.t, to: serverNow(), step });
        const now = cache.get(key);
        if (!alive || now !== c) return; // another tick or load replaced it meanwhile
        const bars = joinTail(c.bars, t.bars);
        if (bars !== c.bars) {
          const v = { bars, days: t.days.length && t.days[t.days.length - 1]!.start !== c.days[c.days.length - 1]?.start ? mergeDays(c.days, t.days) : c.days };
          put(key, v);
          show(v);
        }
      } catch {
        /* the next tick tries again */
      } finally {
        busy = false;
      }
    };
    const id = setInterval(tick, TAIL_MS);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, [key, step, from]);

  const ok = st.key === key && !!key;
  return {
    key,
    bars: ok ? st.v!.bars : NO_BARS,
    days: ok ? st.v!.days : NO_DAYS,
    loading: !!key && !ok,
    error: ok ? st.error : null,
  };
}

function mergeDays(a: HistDay[], b: HistDay[]): HistDay[] {
  const m = new Map(a.map((d) => [d.start, d]));
  for (const d of b) m.set(d.start, d);
  return [...m.values()].sort((x, y) => x.start - y.start);
}

// ================================ desk rows ================================

/** One bar of the desk chart, derived: P&L per bar and running, each part of the split per bar and running,
 *  the bar's candle of P&L since its day (week) start, and the flows and levels. */
export interface Row {
  t: number;
  /** P&L in this bar. */
  pnl: number;
  /** Running P&L since the range start. */
  cum: number;
  /** Candle of the P&L since the bar's day start (week start for weeks). */
  o: number;
  h: number;
  l: number;
  c: number;
  bar: Split;
  run: Split;
  volume: number;
  fills: number;
  inventory: number | null;
  futures: number | null;
}
export interface Split {
  pi: number | null;
  mm: number | null;
  inv: number | null;
  hedge: number | null;
  reb: number | null;
  other: number | null;
}
export const PARTS = ["pi", "mm", "inv", "hedge", "reb", "other"] as const;
export type Part = (typeof PARTS)[number];

/** Week bars from day bars: running totals are taken at the week's last day, flows summed. */
export function weekBars(days: HistBar[]): HistBar[] {
  const out: HistBar[] = [];
  let wk = NaN;
  for (const b of days) {
    const w = weekOf(b.t);
    const last = out[out.length - 1];
    if (last && w === wk) {
      last.h = Math.max(last.h, b.h);
      last.l = Math.min(last.l, b.l);
      last.c = b.c;
      last.pi = b.pi ?? last.pi;
      last.mm = b.mm ?? last.mm;
      last.realized = b.realized ?? last.realized;
      last.hedge = b.hedge ?? last.hedge;
      last.rebates = b.rebates ?? last.rebates;
      last.inventory = b.inventory ?? last.inventory;
      last.futures = b.futures ?? last.futures;
      last.volume += b.volume;
      last.fills += b.fills;
    } else {
      wk = w;
      out.push({ ...b });
    }
  }
  return out;
}

const sameSplit = (a: Split, b: Split) => PARTS.every((k) => same(a[k], b[k]));
function sameRow(a: Row, b: Row): boolean {
  return (
    a.t === b.t && same(a.pnl, b.pnl) && same(a.cum, b.cum) && same(a.o, b.o) && same(a.h, b.h) && same(a.l, b.l) && same(a.c, b.c) &&
    a.volume === b.volume && a.fills === b.fills && same(a.inventory, b.inventory) && same(a.futures, b.futures) &&
    sameSplit(a.bar, b.bar) && sameSplit(a.run, b.run)
  );
}

/**
 * Rows from bars. `period` sets where a candle starts at 0: "day" (each P&L day, from `dayStart`'s offset) or
 * "week". `prev` (the last result) lends its objects to the rows that came out the same, so a live tick
 * changes only the last rows' identity.
 */
export function deskRows(bars: HistBar[], period: "day" | "week", dayStart: number, prev: Row[] | null): Row[] {
  const out: Row[] = [];
  const periodOf = period === "week" ? weekOf : (t: number) => dayOf(t, dayStart);
  let prevC = bars[0]?.o ?? 0;
  let base = prevC; // the running P&L at the current period's start
  let per = NaN;
  const last: Record<"pi" | "mm" | "hedge" | "reb" | "other", number | null> = { pi: null, mm: null, hedge: null, reb: null, other: null };
  // Other = P&L − (Π + hedge + rebates), from the first bar that has all three (the P&L before it is not split)
  let otherOff: number | null = null;
  for (let i = 0; i < bars.length; i++) {
    const b = bars[i]!;
    const p = periodOf(b.t);
    if (p !== per) {
      per = p;
      base = prevC;
    }
    const pi = b.pi,
      mm = b.mm,
      hedge = b.hedge,
      reb = b.rebates;
    let other: number | null = null;
    if (pi != null && hedge != null && reb != null) {
      if (otherOff == null) otherOff = i > 0 ? bars[i - 1]!.c : b.o;
      other = b.c - otherOff - (pi + hedge + reb);
    }
    const run: Split = { pi, mm, inv: pi != null && mm != null ? pi - mm : null, hedge, reb, other };
    const d = (k: keyof typeof last, v: number | null) => {
      if (v == null) return null;
      const x = v - (last[k] ?? 0);
      last[k] = v;
      return x;
    };
    const bpi = d("pi", pi);
    const bmm = d("mm", mm);
    const bar: Split = { pi: bpi, mm: bmm, inv: bpi != null && bmm != null ? bpi - bmm : null, hedge: d("hedge", hedge), reb: d("reb", reb), other: d("other", other) };
    const row: Row = {
      t: b.t,
      pnl: b.c - prevC,
      cum: b.c,
      o: b.o - base,
      h: b.h - base,
      l: b.l - base,
      c: b.c - base,
      bar,
      run,
      volume: b.volume,
      fills: b.fills,
      inventory: b.inventory,
      futures: b.futures,
    };
    const old = prev?.[i];
    out.push(old && sameRow(old, row) ? old : row);
    prevC = b.c;
  }
  return out;
}

// ================================ day rows (tables, calendar, summary) ================================

/** A P&L day as the tables show it. `se`: Π's standard error when the desk kept it. */
export interface DayRow {
  day: string;
  start: number;
  pnl: number | null;
  mm: number | null;
  inv: number | null;
  hedge: number | null;
  reb: number | null;
  other: number | null;
  pi: number | null;
  se: number | null;
  fills: number;
  volume: number;
}

/**
 * The days from `from` on, newest first: the snapshot's days list (the desk's own closing split, the last 60)
 * and, for older days, the day bars of /api/history.
 */
export function dayRows(snapDays: DayPnl[] | undefined, dayBars: HistBar[], days: HistDay[], from: number): DayRow[] {
  const byDay = new Map<string, DayRow>();
  const nameOf = new Map(days.map((d) => [d.start, d.day]));
  const rows = deskRows(dayBars, "day", from, null);
  for (const r of rows) {
    const day = nameOf.get(r.t) ?? new Date(r.t).toISOString().slice(0, 10);
    byDay.set(day, {
      day,
      start: r.t,
      pnl: r.pnl,
      mm: r.bar.mm,
      inv: r.bar.inv,
      hedge: r.bar.hedge,
      reb: r.bar.reb,
      other: r.bar.other,
      pi: r.bar.pi,
      se: null,
      fills: r.fills,
      volume: r.volume,
    });
  }
  const startOf = new Map(days.map((d) => [d.day, d.start]));
  for (const d of snapDays ?? []) {
    const start = startOf.get(d.day) ?? byDay.get(d.day)?.start ?? Date.parse(d.day + "T00:00:00Z");
    if (start < from) continue;
    byDay.set(d.day, {
      day: d.day,
      start,
      pnl: d.pnl_day,
      mm: d.mm,
      inv: d.inventory,
      hedge: d.hedge,
      reb: d.rebates,
      other: d.other,
      pi: d.trading,
      se: d.trading_se,
      fills: d.fills,
      volume: d.volume,
    });
  }
  return [...byDay.values()].filter((r) => r.start >= from).sort((a, b) => b.start - a.start);
}

/** Sums of day rows (null where no day had the figure); `se` combined as independent. */
export function sumDays(rows: DayRow[]): Omit<DayRow, "day" | "start"> {
  const s = (k: "pnl" | "mm" | "inv" | "hedge" | "reb" | "other" | "pi") => {
    const xs = rows.map((r) => r[k]).filter((x): x is number => x != null);
    return xs.length ? xs.reduce((a, x) => a + x, 0) : null;
  };
  const ses = rows.map((r) => r.se).filter((x): x is number => x != null);
  return {
    pnl: s("pnl"),
    mm: s("mm"),
    inv: s("inv"),
    hedge: s("hedge"),
    reb: s("reb"),
    other: s("other"),
    pi: s("pi"),
    se: ses.length ? Math.sqrt(ses.reduce((a, x) => a + x * x, 0)) : null,
    fills: rows.reduce((a, r) => a + r.fills, 0),
    volume: rows.reduce((a, r) => a + r.volume, 0),
  };
}

// ================================ instrument fills ================================

const FILLS_PAGE = 20_000; // the server's MAX_FILLS: a full page means there may be more after it
const FILLS_PAGES = 5;

export interface FillsLoad {
  key: string;
  fills: HistFill[];
  loading: boolean;
}

/** Our fills on an instrument from `from` to now (/api/fills, paged), then the live ones after it. */
export function useInstrumentFills(symbol: string | null, venue: Venue, from: number | null): FillsLoad {
  const key = symbol && from != null ? `${symbol}|${venue}|${from}` : "";
  const [st, setSt] = useState<{ key: string; to: number; fills: HistFill[] }>({ key: "", to: 0, fills: [] });
  const cur = useRef(key);
  cur.current = key;
  useEffect(() => {
    if (!symbol || from == null) return;
    const ac = new AbortController();
    const to = serverNow();
    (async () => {
      const out: HistFill[] = [];
      let f = from;
      for (let i = 0; i < FILLS_PAGES; i++) {
        const page = await getJSON<HistFill[]>("/api/fills", { symbol, from: f, to }, ac.signal);
        out.push(...page);
        if (page.length < FILLS_PAGE) break;
        f = page[page.length - 1]!.t + 1;
      }
      if (cur.current === key) setSt({ key, to, fills: out.filter((x) => x.venue === venue) });
    })().catch(() => {
      if (cur.current === key && !ac.signal.aborted) setSt({ key, to, fills: [] });
    });
    return () => ac.abort();
  }, [key, symbol, venue, from]);
  const live = useStore((s) => s.snap?.fills);
  const ok = st.key === key && !!key;
  const fills = useMemo(() => {
    if (!ok) return NO_FILLS;
    const extra = liveAfter(live, symbol!, venue, st.to);
    return extra.length ? st.fills.concat(extra) : st.fills;
  }, [ok, st, live, symbol, venue]);
  return { key, fills, loading: !!key && !ok };
}

const NO_FILLS: HistFill[] = [];
function liveAfter(live: Fill[] | undefined, symbol: string, venue: Venue, to: number): HistFill[] {
  return (live ?? [])
    .filter((f) => f.symbol === symbol && f.venue === venue && f.ts > to)
    .map((f): HistFill => ({ t: f.ts, side: f.side, price: f.price, qty: f.qty, account: f.account, venue: f.venue, maker: f.maker }))
    .sort((a, b) => a.t - b.t);
}
