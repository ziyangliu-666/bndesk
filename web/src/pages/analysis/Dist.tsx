// Per-fill markouts at one horizon as a histogram (weight shares: of fills or of notional), with the mean, the
// median and the 10th / 90th percentiles drawn over it. The legend gives those figures at rest and the hovered
// bin's range and share otherwise. The end bins hold the 1 % tails.
import { useState, type PointerEvent } from "react";
import { useElementSize } from "@mantine/hooks";
import { bps, compact, num } from "../../format";
import { C } from "../../theme";
import type { MarkoutDist } from "../../protocol";
import { niceTicks } from "./scale";

export function Dist({ d, of, touch = false, height }: { d: MarkoutDist | null; of: string; touch?: boolean; height?: number }) {
  const { ref, width, height: boxH } = useElementSize<HTMLDivElement>();
  const H = height ?? boxH;
  const [hover, setHover] = useState<number | null>(null);
  const top = touch ? 62 : 30;
  const bottom = 22;
  const right = touch ? 40 : 48;
  const bins = d?.bins ?? [];
  const nb = bins.length;
  const x0 = d?.lo ?? 0;
  const x1 = x0 + nb * (d?.width ?? 1);
  const plotW = Math.max(10, width - right - 8);
  const plotH = Math.max(10, H - top - bottom);
  const x = (v: number) => 8 + ((v - x0) / (x1 - x0 || 1)) * plotW;
  const maxS = Math.max(0.01, ...bins);
  const yt = niceTicks(0, maxS, touch ? 2 : 3);
  const yMax = yt[yt.length - 1]!;
  const y = (s: number) => top + plotH - (s / yMax) * plotH;
  const xt = nb ? niceTicks(x0, x1, touch ? 4 : 6).filter((t) => t >= x0 - 1e-9 && t <= x1 + 1e-9) : [];
  const pick = (e: PointerEvent<SVGSVGElement>) => {
    if (!nb) return;
    const r = e.currentTarget.getBoundingClientRect();
    const k = Math.floor(((e.clientX - r.left - 8) / plotW) * nb);
    setHover(k >= 0 && k < nb ? k : null);
  };
  const tone = (k: number) => {
    const c = x0 + (k + 0.5) * d!.width;
    return Math.abs(c) < d!.width / 2 ? C.ink2 : c > 0 ? C.up : C.down;
  };
  const mark = (v: number | null, cls: string) =>
    v == null ? null : <line x1={Math.round(x(v)) + 0.5} x2={Math.round(x(v)) + 0.5} y1={top - 4} y2={top + plotH} className={cls} />;
  const lo = (k: number) => x0 + k * d!.width;
  return (
    <div ref={ref} className={"an-dist" + (touch ? " touch" : "")} style={height ? { height } : undefined}>
      {width > 0 && H > 0 && d && nb > 0 && (
        <svg width={width} height={H} onPointerMove={pick} onPointerDown={pick} onPointerLeave={() => setHover(null)} role="img" aria-label="Distribution of per-fill markouts">
          {yt.map((t) => (
            <g key={t}>
              <line x1={0} x2={plotW + 8} y1={Math.round(y(t)) + 0.5} y2={Math.round(y(t)) + 0.5} className={t === 0 ? "an-base" : "an-grid"} />
              <text x={width - 4} y={y(t) + 4} textAnchor="end" className="an-ax">
                {num(t * 100, Number.isInteger(+((yt[1]! - yt[0]!) * 100).toFixed(6)) ? 0 : 1)}%
              </text>
            </g>
          ))}
          {bins.map((s, k) => {
            const xa = x(lo(k));
            const w = Math.max(1, x(lo(k + 1)) - xa - 1);
            return <rect key={k} x={xa + 0.5} y={y(s)} width={w} height={Math.max(0, y(0) - y(s))} fill={tone(k)} opacity={hover === k ? 0.95 : 0.6} />;
          })}
          {x0 < 0 && x1 > 0 && <line x1={Math.round(x(0)) + 0.5} x2={Math.round(x(0)) + 0.5} y1={top} y2={top + plotH} className="an-zero" />}
          {mark(d.p10, "an-q")}
          {mark(d.p90, "an-q")}
          {mark(d.median, "an-med")}
          {mark(d.mean, "an-mean")}
          {xt.map((t) => (
            <text key={t} x={x(t)} y={H - 6} textAnchor="middle" className="an-ax">
              {num(t, Number.isInteger(xt[1]! - xt[0]!) ? 0 : 1, true)}
            </text>
          ))}
        </svg>
      )}
      <div className="ex-legend" style={{ top: 6 }}>
        <div className="ex-lg-line">
          {hover != null && d ? (
            <>
              <span className="ex-lg-it">
                <span className="ex-lg-v an-lg-h">
                  {hover === 0 ? "Below " + num(lo(1), 1, true) : hover === nb - 1 ? "From " + num(lo(hover), 1, true) : `${num(lo(hover), 1, true)} to ${num(lo(hover + 1), 1, true)}`} bps
                </span>
              </span>
              <span className="ex-lg-it">
                <span className="ex-lg-v">{num(bins[hover]! * 100, 1)}%</span>
                <span className="ex-lg-l">of {of}</span>
              </span>
            </>
          ) : (
            <>
              <span className="ex-lg-it">
                <span className="ex-lg-l">n</span>
                <span className="ex-lg-v">{d ? compact(d.n, d.n < 1000 ? 0 : 1) : "--"}</span>
              </span>
              <span className="ex-lg-it">
                <span className="ex-lg-l an-k-mean">Mean</span>
                <span className="ex-lg-v">{bps(d?.mean)}</span>
              </span>
              <span className="ex-lg-it">
                <span className="ex-lg-l an-k-med">Median</span>
                <span className="ex-lg-v">{bps(d?.median)}</span>
              </span>
              <span className="ex-lg-it">
                <span className="ex-lg-l an-k-q">p10</span>
                <span className="ex-lg-v">{bps(d?.p10)}</span>
              </span>
              <span className="ex-lg-it">
                <span className="ex-lg-l an-k-q">p90</span>
                <span className="ex-lg-v">{bps(d?.p90)}</span>
              </span>
            </>
          )}
        </div>
      </div>
      {d && nb === 0 && <div className="an-empty">No fills at this horizon yet</div>}
    </div>
  );
}
