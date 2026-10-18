// The desk's day as rows for ExChart (the desktop Desk chart and the phone Desk chart alike): today's minute bars (in the snapshot, then one `bars` message a minute),
// the 5 s series over the minutes they cover, and the fills tape for the volume and fill counts after the last
// bar. Bucketed to the chart's interval, and kept as the same objects where nothing changed, so ExChart only
// updates the forming bar.
import type { AccountSeries, DayBars, Fill, SeriesPoint } from "../../protocol";

export const MIN = 60_000;

export interface Row {
  /** Bar start, ms. */
  t: number;
  /** Day PnL: open (the previous bar's close), high, low, close. */
  o: number;
  h: number;
  l: number;
  c: number;
  equity: number;
  trading: number | null;
  mm: number | null;
  hedge: number | null;
  inv: number;
  fut: number;
  /** Notional filled in the bar, USDT. */
  vol: number;
  /** Fills in the bar; null where the fills tape does not reach back. */
  fills: number | null;
  /** Rebates so far in the day, where the row carries them (days before today). */
  reb?: number | null;
}

const minute = (ms: number) => Math.floor(ms / MIN) * MIN;

/** Today's rows at one minute (`step` 60 000) or at the 5 s grid (`step` 0: the series' own points). */
export function todayRows(bars: DayBars | undefined, series: readonly SeriesPoint[] | undefined, fills: readonly Fill[] | undefined, dayStart: number, step: number): Row[] {
  const rows = new Map<number, Row>();
  const b = bars;
  // the minute bars
  if (b)
    for (let i = 0; i < b.t.length; i++) {
      const t = b.t[i]!;
      if (t < dayStart) continue;
      const c = b.pnl_day[i]!;
      rows.set(t, { t, o: c, h: c, l: c, c, equity: b.equity[i]!, trading: b.trading[i] ?? null, mm: b.mm[i] ?? null, hedge: b.hedge[i] ?? null, inv: b.inventory[i]!, fut: b.futures[i]!, vol: b.volume[i]!, fills: null });
    }
  const lastBar = b?.t.length ? b.t[b.t.length - 1]! : dayStart - MIN;
  // the 5 s series: at one minute it moves the minute's close, high and low; on the 5 s grid each point is a row
  const pts: Row[] = [];
  for (const p of series ?? []) {
    if (p.t < dayStart) continue;
    const m = minute(p.t);
    if (step === 0) {
      pts.push({ t: p.t, o: p.pnl_day, h: p.pnl_day, l: p.pnl_day, c: p.pnl_day, equity: p.equity, trading: p.trading, mm: null, hedge: null, inv: p.inventory, fut: p.futures_notional, vol: 0, fills: null });
      continue;
    }
    let r = rows.get(m);
    if (!r) rows.set(m, (r = { t: m, o: p.pnl_day, h: p.pnl_day, l: p.pnl_day, c: p.pnl_day, equity: p.equity, trading: p.trading, mm: null, hedge: null, inv: p.inventory, fut: p.futures_notional, vol: 0, fills: null }));
    if (m >= lastBar) {
      r.c = p.pnl_day;
      r.equity = p.equity;
      if (p.trading != null) r.trading = p.trading;
      r.inv = p.inventory;
      r.fut = p.futures_notional;
    }
    r.h = Math.max(r.h, p.pnl_day);
    r.l = Math.min(r.l, p.pnl_day);
  }
  let list = [...rows.values()].sort((x, y) => x.t - y.t);
  // the minute's market making and hedge carry to the minutes the bars have not reached yet
  let mm: number | null = null;
  let hedge: number | null = null;
  for (const r of list) {
    if (r.mm != null) mm = r.mm;
    else r.mm = mm;
    if (r.hedge != null) hedge = r.hedge;
    else r.hedge = hedge;
  }
  if (step === 0) {
    // the 5 s points take the minute bars' market making and hedge, and the bars stand in before the series
    const byMin = new Map(list.map((r) => [r.t, r]));
    const first = pts.length ? pts[0]!.t : Infinity;
    const head = list.filter((r) => r.t < minute(first));
    for (const p of pts) {
      const r = byMin.get(minute(p.t)) ?? byMin.get(minute(p.t) - MIN);
      p.mm = r?.mm ?? mm;
      p.hedge = r?.hedge ?? hedge;
    }
    list = head.concat(pts);
  }
  // open = the previous close
  for (let i = 1; i < list.length; i++) {
    const r = list[i]!;
    r.o = list[i - 1]!.c;
    r.h = Math.max(r.h, r.o, r.c);
    r.l = Math.min(r.l, r.o, r.c);
  }
  // fills: counts where the tape reaches, and the volume after the last bar
  const tape = fills ?? [];
  const oldest = tape.length ? tape[tape.length - 1]!.ts : Infinity;
  const vol = new Map<number, number>();
  const cnt = new Map<number, number>();
  for (const f of tape) {
    if (f.ts < dayStart) break; // newest first
    if (f.conversion) continue; // a stablecoin conversion is not desk volume
    const m = minute(f.ts);
    cnt.set(m, (cnt.get(m) ?? 0) + 1);
    if (m >= lastBar) vol.set(m, (vol.get(m) ?? 0) + f.notional);
  }
  const full = oldest <= dayStart; // the tape holds the whole day
  for (const r of list) {
    const m = minute(r.t);
    if (step === 0 && r.t !== m) {
      r.fills = null;
      continue;
    }
    r.fills = full || m >= minute(oldest) + MIN ? (cnt.get(m) ?? 0) : null;
    const v = vol.get(m);
    if (v != null) r.vol = m === lastBar ? Math.max(r.vol, v) : v;
  }
  return list;
}

/** Rows bucketed to `step` ms: last values, the bucket's high and low, summed volume and fills. */
export function bucket(rows: readonly Row[], step: number): Row[] {
  if (step <= MIN) return rows as Row[];
  const out: Row[] = [];
  for (const r of rows) {
    const t = Math.floor(r.t / step) * step;
    const last = out[out.length - 1];
    if (last && last.t === t) {
      last.h = Math.max(last.h, r.h);
      last.l = Math.min(last.l, r.l);
      last.c = r.c;
      last.equity = r.equity;
      last.trading = r.trading;
      last.mm = r.mm;
      last.hedge = r.hedge;
      last.inv = r.inv;
      last.fut = r.fut;
      last.vol += r.vol;
      last.fills = last.fills == null || r.fills == null ? null : last.fills + r.fills;
    } else out.push({ ...r, t, o: last?.c ?? r.o });
  }
  return out;
}

/** The last value at or before `t` of a series with ascending times `ts`; null before its first point. */
export function valueAt(ts: readonly number[], vs: readonly number[], t: number): number | null {
  let lo = 0;
  let hi = ts.length;
  while (lo < hi) {
    const m = (lo + hi) >> 1;
    if (ts[m]! <= t) lo = m + 1;
    else hi = m;
  }
  return lo ? vs[lo - 1]! : null;
}

/** Each account's Day PnL (its 45 s points) on the chart's own bar times: each bar the last point before the
 *  next bar starts, the forming bar the latest point; today only. */
export function accountOnGrid(a: AccountSeries, rows: readonly Row[], dayStart: number): { time: number; value: number | null }[] {
  const first = a.t.findIndex((t) => t >= dayStart);
  if (first < 0) return [];
  const ts = a.t.slice(first);
  const vs = a.pnl_day.slice(first);
  return rows.map((r, i) => {
    const next = rows[i + 1]?.t;
    return { time: r.t, value: valueAt(ts, vs, next == null ? Infinity : next - 1) };
  });
}

/**
 * Points that keep the earlier call's objects where time and value are the same, so ExChart sees an unchanged
 * head and updates only the tail. One per series key.
 */
export class Stable {
  private prev = new Map<string, object[]>();
  get<T extends { time: number }>(key: string, next: T[], same: (a: T, b: T) => boolean): T[] {
    const prev = (this.prev.get(key) ?? []) as T[];
    let changed = prev.length !== next.length;
    const out = next.map((n, i) => {
      const p = prev[i];
      if (p && p.time === n.time && same(p, n)) return p;
      changed = true;
      return n;
    });
    const res = changed ? out : prev;
    this.prev.set(key, res);
    return res;
  }
}

export const sameValue = (a: { value: number | null; color?: string }, b: { value: number | null; color?: string }) => a.value === b.value && a.color === b.color;
export const sameOhlc = (a: { open: number; high: number; low: number; close: number }, b: { open: number; high: number; low: number; close: number }) =>
  a.open === b.open && a.high === b.high && a.low === b.low && a.close === b.close;
