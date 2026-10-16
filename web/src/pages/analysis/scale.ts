// Axis helpers for the Analysis charts' own SVG plots.

/** A round step for about `count` intervals over `span`. */
export function niceStep(span: number, count: number): number {
  const raw = Math.max(1e-9, span / Math.max(1, count));
  const mag = 10 ** Math.floor(Math.log10(raw));
  for (const k of [1, 2, 2.5, 5, 10]) if (k * mag >= raw) return k * mag;
  return 10 * mag;
}

/** Round ticks covering [lo, hi] (both widened to a tick), about `count` intervals. */
export function niceTicks(lo: number, hi: number, count: number): number[] {
  if (!Number.isFinite(lo) || !Number.isFinite(hi)) return [0, 1];
  if (hi - lo < 1e-9) {
    lo -= 1;
    hi += 1;
  }
  const step = niceStep(hi - lo, count);
  const a = Math.floor(lo / step + 1e-9) * step;
  const b = Math.ceil(hi / step - 1e-9) * step;
  const out: number[] = [];
  for (let v = a; v <= b + step / 2; v += step) out.push(Math.abs(v) < step / 1e6 ? 0 : +v.toFixed(10));
  return out;
}
