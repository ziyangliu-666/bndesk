// What the Desk P&L charts (desktop and phone) take from /api/history besides the snapshot: today's rebates and
// fill counts by minute (the snapshot's minute bars carry neither, and the fills tape does not reach back over a
// busy day), and the rolling last 24 h.
import { useMemo } from "react";
import type { HistBar } from "../../api";
import { serverNow } from "../../store";
import { useDeskHistory } from "../history/data";
import { MIN, valueAt, type Row } from "./model";

const DAY = 86_400_000;

export interface TodayMinutes {
  /** Cumulative rebates today, by minute (they are credited hourly). */
  reb: { t: number[]; v: number[] };
  /** Fills in each minute of today. */
  fills: Map<number, number>;
}

/** Today's minute bars from /api/history, again each minute: rebates and fill counts. */
export function useTodayMinutes(dayStart: number | null | undefined): TodayMinutes {
  const h = useDeskHistory(60, dayStart ? dayStart : null, 60_000);
  return useMemo(() => {
    const t: number[] = [];
    const v: number[] = [];
    const fills = new Map<number, number>();
    for (const b of h.bars) {
      if (!dayStart || b.t < dayStart) continue;
      fills.set(b.t, b.fills);
      if (b.rebates != null) {
        t.push(b.t);
        v.push(b.rebates);
      }
    }
    return { reb: { t, v }, fills };
  }, [h.bars, dayStart]);
}

/** Rows with the fill counts the tape does not reach filled in from the minute history (one-minute rows). */
export function withFills(rows: Row[], m: TodayMinutes): Row[] {
  if (!m.fills.size) return rows;
  for (const r of rows) if (r.fills == null && r.t % MIN === 0) r.fills = m.fills.get(r.t) ?? null;
  return rows;
}

/** Rebates at a row: the last minute's figure inside it. */
export const rebatesAt = (m: TodayMinutes, t: number, step: number) => valueAt(m.reb.t, m.reb.v, step > MIN ? t + step - MIN : t);

// one start per bar size, kept while it stays within a few hours of "24 h ago": the load (and its cache) is
// keyed by it, and the bars after it come by the tail
const anchors = new Map<number, number>();
function anchor(stepMs: number): number {
  const want = Math.floor((serverNow() - DAY) / stepMs) * stepMs;
  const a = anchors.get(stepMs);
  if (a != null && a <= want && want - a < 6 * 3_600_000) return a;
  anchors.set(stepMs, want);
  return want;
}

export interface Last24h {
  /** Bars of the last 24 h, the running figures from 0 where the window starts. */
  bars: HistBar[];
  loading: boolean;
  error: string | null;
}

/**
 * The rolling last 24 h, ending now, in bars of `stepMs` (null: not wanted), from /api/history and fetched again
 * every 15 s: the same meaning on desktop and phone ("24h"; "Today" is the trading day so far).
 */
export function useLast24h(stepMs: number | null): Last24h {
  const from = useMemo(() => (stepMs == null ? null : anchor(stepMs)), [stepMs]);
  const h = useDeskHistory((stepMs ?? MIN) / 1000, from, 15_000);
  const minute = Math.floor(serverNow() / MIN);
  const bars = useMemo(() => window24(h.bars, minute * MIN), [h.bars, minute]);
  return { bars, loading: h.loading, error: h.error };
}

/** The bars that start within 24 h of `now`, rebased so each running figure starts at 0 with the window. */
function window24(all: HistBar[], now: number): HistBar[] {
  const i = all.findIndex((b) => b.t >= now - DAY);
  if (i < 0) return [];
  if (i === 0) return all;
  const prev = all[i - 1]!;
  const base = prev.c;
  const off = (k: "pi" | "mm" | "realized" | "hedge" | "rebates") => {
    // the last value before the window (a series that starts inside it starts at 0 there anyway)
    for (let j = i - 1; j >= 0; j--) if (all[j]![k] != null) return all[j]![k]!;
    return 0;
  };
  const o = { pi: off("pi"), mm: off("mm"), realized: off("realized"), hedge: off("hedge"), rebates: off("rebates") };
  const sub = (v: number | null, k: keyof typeof o) => (v == null ? null : v - o[k]);
  return all.slice(i).map((b) => ({
    ...b,
    o: b.o - base,
    h: b.h - base,
    l: b.l - base,
    c: b.c - base,
    pi: sub(b.pi, "pi"),
    mm: sub(b.mm, "mm"),
    realized: sub(b.realized, "realized"),
    hedge: sub(b.hedge, "hedge"),
    rebates: sub(b.rebates, "rebates"),
  }));
}

/** History bars as the Desk chart's rows (24h): P&L and its split, volume and fills. */
export function histRows(bars: readonly HistBar[]): Row[] {
  return bars.map((b) => ({
    t: b.t,
    o: b.o,
    h: b.h,
    l: b.l,
    c: b.c,
    equity: 0,
    trading: b.pi,
    mm: b.mm,
    hedge: b.hedge,
    inv: b.inventory ?? 0,
    fut: b.futures ?? 0,
    vol: b.volume,
    fills: b.fills,
  }));
}
