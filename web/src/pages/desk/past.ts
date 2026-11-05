// The days before today on the Desk charts (desktop and phone): /api/history's bars at the chart's interval,
// each day's figures as stored (`per=day`: Day PnL and its parts restart at each day start). The chart opens with
// today and the bars before it keep arriving behind the view, nearest first, up to a budget of bars: a request
// for the most recent few thousand, then doubling, so the first bars are quick and the earlier ones are there
// by the time the view pans to them. Past the budget a page loads when the view nears the first bar. The days
// before today never change, so a page is fetched once and kept for the session; a new day only asks for the
// day that ended.
//
// The budget is memory, not bytes on the wire: a chart holds about 5 KB of the browser's memory per bar of the Desk
// chart (measured: 125 000 bars took 660 MB, most of it Lightweight Charts' own). A year kept is 8 760 bars at 1h,
// 35 040 at 15m, 105 120 at 5m and 525 600 at 1m, so the budget holds the year at 15m and above, seven months at 5m
// and six weeks at 1m; the phone, with more series on less memory, a year at 1h and five days at 1m.
import { useCallback, useEffect, useMemo, useState } from "react";
import { getJSON, type HistBar, type History } from "../../api";
import { MIN, type Row } from "./model";

const DAY = 86_400_000;
/** Nothing is asked for before this; the first kept day (`firstDay`) usually ends the walk long before. */
const MAX_BACK = 3650 * DAY;
/** /api/history answers at most this many bars (server history.rs MAX_BARS). */
const MAX_PAGE = 40_000;
/** Bars in the first request; each later one asks for twice as many, up to MAX_PAGE. */
const FIRST_PAGE = 3_000;
/** Bars kept loading behind the view without being asked for. */
export const PAST_BARS = 60_000;
/** The same on a phone. */
export const PAST_BARS_PHONE = 8_000;
const RETRY_MS = 15_000;

interface Past {
  stepS: number;
  dayStart: number;
  /** Bars before today, oldest first. */
  bars: HistBar[];
  /** The earliest time asked for so far. */
  from: number;
  /** Bars to ask for next. */
  page: number;
  /** Bars to load without being asked. */
  budget: number;
  /** Start of the days between an earlier load's end and this one's (carried over from the day before). */
  gap: number | null;
  /** Nothing older to ask for. */
  done: boolean;
  busy: boolean;
  error: string | null;
  subs: Set<() => void>;
  retry: ReturnType<typeof setTimeout> | null;
}
const loads = new Map<string, Past>();
const NO_BARS: HistBar[] = [];

/** The kept days' closes before `dayStart`, one request whoever asks (the walk below and the charts' offsets). */
const dayBars = new Map<number, Promise<HistBar[]>>();
function daysBefore(dayStart: number): Promise<HistBar[]> {
  let q = dayBars.get(dayStart);
  if (!q) {
    q = getJSON<History>("/api/history", { from: dayStart - MAX_BACK, to: dayStart, step: 86_400, per: "day" }).then((h) =>
      h.bars.filter((x) => x.t < dayStart).sort((x, y) => x.t - y.t),
    );
    q.catch(() => dayBars.delete(dayStart));
    dayBars.set(dayStart, q);
  }
  return q;
}

async function fetchBars(stepS: number, from: number, to: number, dayStart: number): Promise<HistBar[]> {
  const h = await getJSON<History>("/api/history", { from, to, step: stepS, per: "day" });
  return h.bars.filter((b) => b.t >= from && b.t < to && b.t < dayStart);
}

async function older(key: string) {
  const p = loads.get(key)!;
  if (p.busy || (p.done && p.gap == null)) return;
  p.busy = true;
  try {
    const stepMs = p.stepS * 1000;
    if (p.gap != null) {
      p.bars = p.bars.concat(await fetchBars(p.stepS, p.gap, p.dayStart, p.dayStart));
      p.gap = null;
    }
    const days = p.done ? [] : await daysBefore(p.dayStart);
    // the first kept day ends the walk, so a young desk asks for no more than it holds
    const floor = days.length ? Math.max(days[0]!.t, p.dayStart - MAX_BACK) : p.dayStart;
    if (p.from <= floor) p.done = true;
    // a gap (no desk rows for a while) gives an empty page: keep going back
    while (!p.done) {
      const to = p.from;
      const from = Math.max(floor, to - Math.min(p.page, MAX_PAGE) * stepMs);
      const got = await fetchBars(p.stepS, from, to, p.dayStart);
      p.from = from;
      if (got.length) p.bars = got.concat(p.bars);
      if (from <= floor) p.done = true;
      if (got.length) {
        p.page = Math.min(p.page * 2, MAX_PAGE);
        break;
      }
    }
    p.error = null;
  } catch (e) {
    p.error = (e as Error).message || "request failed";
  } finally {
    p.busy = false;
  }
  for (const f of p.subs) f();
}

/** Keep loading behind the view while someone watches, up to the budget. */
function walk(key: string) {
  const p = loads.get(key);
  if (!p || !p.subs.size || p.busy || p.retry) return;
  if (p.error) {
    p.error = null;
    p.retry = setTimeout(() => {
      p.retry = null;
      walk(key);
    }, RETRY_MS);
    return;
  }
  if (p.gap == null && (p.done || p.bars.length >= p.budget)) return;
  void older(key).then(() => walk(key));
}

/** A load for a new day takes over the last day's bars, and only asks for the day between. */
function open(key: string, stepS: number, dayStart: number, budget: number): Past {
  let last: Past | null = null;
  for (const p of loads.values())
    if (p.stepS === stepS && p.dayStart < dayStart && !p.subs.size && !p.busy && p.gap == null && (!last || p.dayStart > last.dayStart)) last = p;
  if (last) loads.delete(`${stepS}|${last.dayStart}`);
  const p: Past = last
    ? { ...last, dayStart, budget, gap: last.dayStart, subs: new Set(), retry: null, error: null }
    : { stepS, dayStart, bars: [], from: dayStart, page: FIRST_PAGE, budget, gap: null, done: false, busy: false, error: null, subs: new Set(), retry: null };
  loads.set(key, p);
  return p;
}

export interface PastRows {
  /** The days before today as chart rows, oldest first. */
  rows: Row[];
  /** The same as /api/history's bars. */
  bars: HistBar[];
  /** Ask for the page before the earliest loaded (no-op while one is loading or nothing older is kept). */
  loadOlder: () => void;
  loading: boolean;
  /** The day starts within the loaded range and today's (for the chart's day rules). */
  days: number[];
}

/** The days before `dayStart` in bars of `stepS` seconds (null: not wanted). `budget`: bars to load unasked. */
export function usePast(stepS: number | null, dayStart: number, budget = PAST_BARS): PastRows {
  const key = stepS && dayStart ? `${stepS}|${dayStart}` : "";
  const [, bump] = useState(0);
  useEffect(() => {
    if (!key) return;
    const p = loads.get(key) ?? open(key, stepS!, dayStart, budget);
    const cb = () => bump((n) => n + 1);
    p.subs.add(cb);
    walk(key);
    return () => {
      p.subs.delete(cb);
      if (!p.subs.size && p.retry) {
        clearTimeout(p.retry);
        p.retry = null;
      }
    };
  }, [key, stepS, dayStart, budget]);
  const p = key ? loads.get(key) : undefined;
  const bars = p?.bars;
  const rows = useMemo(() => (bars ? bars.map(pastRow) : []), [bars]);
  const days = useMemo(() => {
    if (!rows.length) return [];
    const out: number[] = [];
    for (let d = Math.floor(rows[0]!.t / DAY) * DAY + DAY; d <= dayStart; d += DAY) out.push(d);
    return out;
  }, [rows, dayStart]);
  const loadOlder = useCallback(() => {
    if (key) void older(key);
  }, [key]);
  return { rows, bars: bars ?? NO_BARS, loadOlder, loading: !!p?.busy, days };
}

function pastRow(b: HistBar): Row {
  return {
    t: b.t,
    o: b.o,
    h: b.h,
    l: b.l,
    c: b.c,
    equity: b.equity ?? 0,
    trading: b.pi,
    mm: b.mm,
    hedge: b.hedge,
    inv: b.inventory ?? 0,
    fut: b.futures ?? 0,
    vol: b.volume,
    fills: b.fills,
    reb: b.rebates,
  };
}

/** The bar size past days are loaded in for a chart step (ms; 0 is the 5 s line, whose past is minutes). */
export const pastStep = (stepMs: number) => Math.max(MIN, stepMs) / 1000;

/** The times of the last bar of each day that has a later day after it in `times` (ascending): where a running
 *  day figure's line stops before it restarts at 0. Days start at `dayStart` mod 24 h. */
export function dayEnds(times: readonly number[], dayStart: number): Set<number> {
  const out = new Set<number>();
  const day = (t: number) => Math.floor((t - dayStart) / DAY);
  for (let i = 0; i + 1 < times.length; i++) if (day(times[i]!) !== day(times[i + 1]!)) out.add(times[i]!);
  return out;
}

/** What the days before a day add to each P&L figure: the sum of their closing values. */
export interface DayOffset {
  c: number;
  trading: number;
  mm: number;
  hedge: number;
  reb: number;
}
const ZERO: DayOffset = { c: 0, trading: 0, mm: 0, hedge: 0, reb: 0 };

interface Closes {
  /** Day start → the offset of the days before it, ascending by day. */
  days: [number, DayOffset][];
  /** All kept days' closes summed: today's offset. */
  total: DayOffset;
  subs: Set<() => void>;
  busy: boolean;
  /** The closes have come back (none kept is an answer too). */
  loaded: boolean;
}
const closes = new Map<number, Closes>();

async function loadCloses(dayStart: number) {
  const c = closes.get(dayStart)!;
  c.busy = true;
  try {
    const run = { ...ZERO };
    const days: [number, DayOffset][] = [];
    for (const b of await daysBefore(dayStart)) {
      days.push([b.t, { ...run }]);
      run.c += b.c;
      run.trading += b.pi ?? 0;
      run.mm += b.mm ?? 0;
      run.hedge += b.hedge ?? 0;
      run.reb += b.rebates ?? 0;
    }
    c.days = days;
    c.total = run;
    c.loaded = true;
  } catch {
    setTimeout(() => void loadCloses(dayStart), 15_000);
    return;
  } finally {
    c.busy = false;
  }
  for (const f of c.subs) f();
}

/**
 * The Desk P&L charts run on over the days: each figure there is the sum of the earlier days' closing values plus
 * the day's own (stored per day, restarting at each day start). Returns the offset of the day holding `t`; null
 * when no earlier day is kept (the figures are the day's own); undefined until the days' closes are in, so a
 * chart waits for them rather than draw the day's own figures first and jump to the running ones.
 */
export function useDayOffsets(dayStart: number | null | undefined): ((t: number) => DayOffset) | null | undefined {
  const [, bump] = useState(0);
  useEffect(() => {
    if (!dayStart) return;
    let c = closes.get(dayStart);
    if (!c) closes.set(dayStart, (c = { days: [], total: ZERO, subs: new Set(), busy: false, loaded: false }));
    const cb = () => bump((n) => n + 1);
    c.subs.add(cb);
    if (!c.loaded && !c.busy) void loadCloses(dayStart);
    return () => void c.subs.delete(cb);
  }, [dayStart]);
  const c = dayStart ? closes.get(dayStart) : undefined;
  const loaded = !!c?.loaded;
  const days = c?.days;
  const total = c?.total;
  return useMemo(() => {
    if (!dayStart) return null;
    if (!loaded || !days || !total) return undefined;
    if (!days.length) return null;
    return (t: number) => {
      if (t >= dayStart) return total;
      const d = dayStart + Math.floor((t - dayStart) / DAY) * DAY;
      // the last kept day at or before d (a day without rows adds nothing)
      let lo = 0;
      let hi = days.length - 1;
      let at = -1;
      while (lo <= hi) {
        const m = (lo + hi) >> 1;
        if (days[m]![0] <= d) (at = m), (lo = m + 1);
        else hi = m - 1;
      }
      if (at < 0) return ZERO;
      const [day, off] = days[at]!;
      return day === d ? off : nextOff(days, at, total);
    };
  }, [loaded, days, total, dayStart]);
}

/** The offset after the kept day at `i` (the day before d had rows, d itself none). */
function nextOff(days: [number, DayOffset][], i: number, total: DayOffset): DayOffset {
  return days[i + 1]?.[1] ?? total;
}
