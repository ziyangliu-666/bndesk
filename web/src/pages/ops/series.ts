// Today's series (the 5 s desk grid, the 45 s account grid) as ExChart points at a chosen interval: the last value
// in each bar. Earlier points keep their objects between updates, so ExChart only updates the tail.
import { useCallback, useEffect, useRef } from "react";
import type { IChartApi } from "lightweight-charts";
import type { ExPoint } from "../../components/ex";

export const IVS = [
  { value: "line", label: "Line", title: "Every point" },
  { value: "1m", label: "1m" },
  { value: "5m", label: "5m" },
  { value: "15m", label: "15m" },
  { value: "1h", label: "1H" },
];
export const IV_KEYS = IVS.map((i) => i.value);
export const STEP: Record<string, number> = { line: 0, "1m": 60_000, "5m": 300_000, "15m": 900_000, "1h": 3_600_000 };

function bucket(ts: readonly number[], vs: readonly (number | null)[], step: number, prev: ExPoint[]): ExPoint[] {
  const out: ExPoint[] = [];
  for (let i = 0; i < ts.length; i++) {
    const v = vs[i];
    if (v == null || !Number.isFinite(v)) continue;
    const t = step ? Math.floor(ts[i]! / step) * step : ts[i]!;
    const last = out[out.length - 1];
    if (last && last.time === t) last.value = v;
    else out.push({ time: t, value: v });
  }
  // keep the objects of unchanged points (all but the tail, as a rule)
  for (let i = 0; i < out.length && i < prev.length; i++) {
    const a = prev[i]!;
    const b = out[i]!;
    if (a.time === b.time && a.value === b.value) out[i] = a;
  }
  return out;
}

/** A hook per series: `const pts = useBucketed(); pts(ts, vs, step)` inside a render. */
export function useBucketed() {
  const prev = useRef<Map<string, { ts: readonly number[]; vs: readonly (number | null)[]; step: number; out: ExPoint[] }>>(new Map());
  return (key: string, ts: readonly number[], vs: readonly (number | null)[], step: number): ExPoint[] => {
    const p = prev.current.get(key);
    if (p && p.ts === ts && p.vs === vs && p.step === step) return p.out;
    const out = bucket(ts, vs, step, p && p.step === step ? p.out : []);
    prev.current.set(key, { ts, vs, step, out });
    return out;
  };
}

/**
 * Fit the whole day into view when the interval (or mode) changes. ExChart keeps the previous logical range when
 * the bar count changes under it (5m after 1m showed the day in the right third), so this refits a frame later.
 * Pass the result as ExChart's `chartRef`.
 */
export function useRefit(...deps: unknown[]): (c: IChartApi | null) => void {
  const chart = useRef<IChartApi | null>(null);
  const key = JSON.stringify(deps);
  const first = useRef(true);
  useEffect(() => {
    if (first.current) return void (first.current = false);
    let id = requestAnimationFrame(() => (id = requestAnimationFrame(() => chart.current?.timeScale().fitContent())));
    return () => cancelAnimationFrame(id);
  }, [key]);
  return useCallback((c: IChartApi | null) => {
    chart.current = c;
  }, []);
}
