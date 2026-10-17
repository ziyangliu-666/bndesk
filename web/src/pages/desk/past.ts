// The days before today on the Desk charts (desktop and phone): /api/history's bars at the chart's interval,
// each day's figures as stored (`per=day`: Day PnL and its parts restart at each day start), loaded a span at a
// time from today's start backwards. The first span loads with the chart; an older one when the view nears the
// first bar (loadOlder), as an exchange chart loads older candles. The days before today never change, so a
// span is fetched once and kept for the session.
import { useCallback, useEffect, useMemo, useState } from "react";
import { getJSON, type HistBar, type History } from "../../api";
import { MIN, type Row } from "./model";

const DAY = 86_400_000;
/** History kept by the server at most (keep_days is a year): no span is asked for before this. */
const MAX_BACK = 400 * DAY;

/** Days of history per request, by bar size (s): a few thousand bars each. */
function spanFor(stepS: number): number {
  if (stepS <= 60) return 2 * DAY;
  if (stepS <= 300) return 8 * DAY;
  if (stepS <= 900) return 24 * DAY;
  if (stepS <= 3600) return 90 * DAY;
  return MAX_BACK;
}

interface Past {
  /** Bars before today, oldest first. */
  bars: HistBar[];
  /** The earliest time asked for so far. */
  from: number;
  /** Nothing older to ask for. */
  done: boolean;
  busy: boolean;
  error: string | null;
  subs: Set<() => void>;
}
const loads = new Map<string, Past>();
const NO_BARS: HistBar[] = [];

async function older(key: string, stepS: number, dayStart: number) {
  const p = loads.get(key)!;
  if (p.busy || p.done) return;
  p.busy = true;
  try {
    let span = spanFor(stepS);
    // a gap (no desk rows for a while) gives an empty span: look further back until there is something or the
    // server's retention is passed
    for (;;) {
      const to = p.from;
      const from = Math.max(dayStart - MAX_BACK, to - span);
      const h = await getJSON<History>("/api/history", { from, to, step: stepS, per: "day" });
      const got = h.bars.filter((b) => b.t >= from && b.t < to && b.t < dayStart);
      p.from = from;
      if (got.length) p.bars = got.concat(p.bars.filter((b) => b.t >= to));
      if (from <= dayStart - MAX_BACK) p.done = true;
      if (got.length || p.done) break;
      span *= 2;
    }
    p.error = null;
  } catch (e) {
    p.error = (e as Error).message || "request failed";
  } finally {
    p.busy = false;
  }
  for (const f of p.subs) f();
}

export interface PastRows {
  /** The days before today as chart rows, oldest first. */
  rows: Row[];
  /** The same as /api/history's bars. */
  bars: HistBar[];
  /** Ask for the span before the earliest loaded (no-op while one is loading or nothing older is kept). */
  loadOlder: () => void;
  loading: boolean;
  /** The day starts within the loaded range and today's (for the chart's day rules). */
  days: number[];
}

/** The days before `dayStart` in bars of `stepS` seconds (null: not wanted). */
export function usePast(stepS: number | null, dayStart: number): PastRows {
  const key = stepS && dayStart ? `${stepS}|${dayStart}` : "";
  const [, bump] = useState(0);
  useEffect(() => {
    if (!key) return;
    let p = loads.get(key);
    if (!p) loads.set(key, (p = { bars: [], from: dayStart, done: false, busy: false, error: null, subs: new Set() }));
    const cb = () => bump((n) => n + 1);
    p.subs.add(cb);
    if (!p.bars.length && !p.done && !p.busy) void older(key, stepS!, dayStart);
    return () => void p.subs.delete(cb);
  }, [key, stepS, dayStart]);
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
    if (key && stepS) void older(key, stepS, dayStart);
  }, [key, stepS, dayStart]);
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
