// A row's own markout curve, the path chart in small: the same horizons, a zero line, a tick at the fill, the
// line ending in a dot coloured by the last horizon's sign.
import { C } from "../../theme";

export function Spark({ vals, iFill, w = 96, h = 22 }: { vals: (number | null)[]; iFill: number; w?: number; h?: number }) {
  const xs = vals.map((v, i) => [i, v] as const).filter((p): p is readonly [number, number] => p[1] != null);
  if (xs.length < 2) return <svg width={w} height={h} className="an-spark" aria-hidden />;
  const lo = Math.min(0, ...xs.map((p) => p[1]));
  const hi = Math.max(0, ...xs.map((p) => p[1]));
  const span = hi - lo || 1;
  const n = vals.length;
  const x = (i: number) => 2 + (i * (w - 6)) / (n - 1);
  const y = (v: number) => 2 + ((hi - v) / span) * (h - 4);
  const last = xs[xs.length - 1]!;
  return (
    <svg width={w} height={h} className="an-spark" aria-hidden>
      <line x1={0} x2={w} y1={Math.round(y(0)) + 0.5} y2={Math.round(y(0)) + 0.5} stroke={C.rule} />
      {iFill >= 0 && <line x1={Math.round(x(iFill)) + 0.5} x2={Math.round(x(iFill)) + 0.5} y1={1} y2={h - 1} stroke={C.rule} />}
      <polyline points={xs.map(([i, v]) => `${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(" ")} fill="none" stroke={C.ink2} strokeWidth={1.25} strokeLinejoin="round" />
      <circle cx={x(last[0])} cy={y(last[1])} r={2} fill={last[1] < 0 ? C.down : C.up} />
    </svg>
  );
}
