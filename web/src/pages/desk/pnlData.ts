// What the Desk P&L charts (desktop and phone) take from /api/history for today besides the snapshot: the rebates
// and fill counts by minute (the snapshot's minute bars carry neither, and the fills tape does not reach back over
// a busy day). The days before today: past.ts.
import { useMemo } from "react";
import { useDeskHistory } from "../history/data";
import { MIN, valueAt, type Row } from "./model";


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
