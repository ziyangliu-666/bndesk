// Who picks us off: each instrument's edge at the fill against its 10 s markout, the bubble's area its notional.
// Under zero the market took more than the edge; under the diagonal some of the edge went. Hover reads it (and
// lights the table row); a click opens the instrument.
import { useMemo, type PointerEvent } from "react";
import { useElementSize } from "@mantine/hooks";
import { bps, compact, int } from "../../format";
import { C } from "../../theme";
import { maskText } from "../../mask";
import type { MarkoutInst } from "../../protocol";
import { niceTicks } from "./scale";

export const instKey = (r: { symbol: string; venue: string }) => r.venue + ":" + r.symbol;
const base = (r: MarkoutInst) => r.symbol.replace(/(USDT|USDC|FDUSD)$/, "") + (r.venue === "usdm" ? " perp" : "");

export function Scatter({
  rows,
  j10,
  hide,
  hover,
  onHover,
  onPick,
}: {
  rows: MarkoutInst[];
  j10: number;
  hide: boolean;
  hover: string | null;
  onHover: (k: string | null) => void;
  onPick: (r: MarkoutInst) => void;
}) {
  const { ref, width, height } = useElementSize<HTMLDivElement>();
  const pts = useMemo(() => rows.filter((r) => r.edge != null && r.mean[j10] != null), [rows, j10]);
  const top = 30;
  const bottom = 22;
  const right = 48;
  const left = 10;
  const plotW = Math.max(10, width - right - left);
  const plotH = Math.max(10, height - top - bottom);
  const xs = pts.map((r) => r.edge!);
  const ys = pts.map((r) => r.mean[j10]!);
  const xt = niceTicks(Math.min(0, ...xs), Math.max(0, ...xs), 5);
  const yt = niceTicks(Math.min(0, ...ys), Math.max(0, ...ys), 4);
  const [xa, xb, ya, yb] = [xt[0]!, xt[xt.length - 1]!, yt[0]!, yt[yt.length - 1]!];
  const x = (v: number) => left + ((v - xa) / (xb - xa || 1)) * plotW;
  const y = (v: number) => top + ((yb - v) / (yb - ya || 1)) * plotH;
  const maxN = Math.max(1, ...pts.map((r) => r.notional));
  const rad = (r: MarkoutInst) => Math.max(2.5, Math.sqrt(r.notional / maxN) * Math.min(15, plotH / 9));
  // the largest names carry a label where it does not run into one already placed
  const labelled = useMemo(() => {
    const out = new Set<string>();
    const boxes: [number, number, number, number][] = [];
    for (const p of pts.slice().sort((a, b) => b.notional - a.notional).slice(0, 10)) {
      const w = base(p).length * 6.5;
      const bx = x(p.edge!) + rad(p) + 3;
      const by = y(p.mean[j10]!) - 7;
      if (bx + w > left + plotW + 40) continue;
      if (boxes.some(([a, b, c, d]) => bx < c && bx + w > a && by < d && by + 14 > b)) continue;
      boxes.push([bx, by, bx + w, by + 14]);
      out.add(instKey(p));
    }
    return out;
    // x, y and rad follow from the points and the size
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pts, width, height, j10]);
  const near = (e: PointerEvent<SVGSVGElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    const px = e.clientX - r.left;
    const py = e.clientY - r.top;
    let best: MarkoutInst | null = null;
    let bd = Infinity;
    for (const p of pts) {
      const d = Math.hypot(x(p.edge!) - px, y(p.mean[j10]!) - py) - rad(p);
      if (d < bd) {
        bd = d;
        best = p;
      }
    }
    return bd < 10 ? best : null;
  };
  const cur = pts.find((p) => instKey(p) === hover) ?? null;
  // the diagonal (markout = edge) across the plot where it is inside
  const d0 = Math.max(xa, ya);
  const d1 = Math.min(xb, yb);
  return (
    <div ref={ref} className="an-scatter">
      {width > 0 && height > 0 && (
        <svg
          width={width}
          height={height}
          onPointerMove={(e) => onHover((p => (p ? instKey(p) : null))(near(e)))}
          onPointerLeave={() => onHover(null)}
          onClick={(e) => {
            const p = near(e as unknown as PointerEvent<SVGSVGElement>);
            if (p) onPick(p);
          }}
          style={{ cursor: cur ? "pointer" : "default" }}
          role="img"
          aria-label="Edge at fill against 10 s markout by instrument"
        >
          {yt.map((t) => (
            <g key={"y" + t}>
              <line x1={left} x2={left + plotW} y1={Math.round(y(t)) + 0.5} y2={Math.round(y(t)) + 0.5} className={t === 0 ? "an-zero" : "an-grid"} />
              <text x={width - 4} y={y(t) + 4} textAnchor="end" className="an-ax">
                {bps(t).replace(".0", "")}
              </text>
            </g>
          ))}
          {xt.map((t) => (
            <g key={"x" + t}>
              {t === 0 && <line x1={Math.round(x(0)) + 0.5} x2={Math.round(x(0)) + 0.5} y1={top} y2={top + plotH} className="an-zero" />}
              <text x={x(t)} y={height - 6} textAnchor="middle" className="an-ax">
                {bps(t).replace(".0", "")}
              </text>
            </g>
          ))}
          <text x={width - 4} y={top - 8} textAnchor="end" className="an-ax">
            10 s
          </text>
          <text x={left + plotW - 2} y={top + plotH - 6} textAnchor="end" className="an-ax">
            Edge at fill →
          </text>
          {d1 > d0 && <line x1={x(d0)} y1={y(d0)} x2={x(d1)} y2={y(d1)} className="an-diag" />}
          {pts
            .slice()
            .sort((a, b) => b.notional - a.notional)
            .map((p) => {
              const k = instKey(p);
              const v = p.mean[j10]!;
              const on = k === hover;
              return (
                <g key={k}>
                  <circle cx={x(p.edge!)} cy={y(v)} r={rad(p)} fill={v < 0 ? C.down : C.up} fillOpacity={on ? 0.55 : 0.28} stroke={v < 0 ? C.down : C.up} strokeOpacity={on ? 1 : 0.7} />
                  {labelled.has(k) && (
                    <text x={x(p.edge!) + rad(p) + 3} y={y(v) + 4} className={"an-bub" + (on ? " on" : "")}>
                      {base(p)}
                    </text>
                  )}
                </g>
              );
            })}
        </svg>
      )}
      <div className="ex-legend" style={{ top: 6 }}>
        <div className="ex-lg-line an-lg-items">
          {cur ? (
            <>
              <span className="ex-lg-it">
                <span className="ex-lg-v an-lg-h">{cur.symbol + (cur.venue === "usdm" ? " perp" : "")}</span>
              </span>
              <span className="ex-lg-it">
                <span className="ex-lg-l">Edge</span>
                <span className="ex-lg-v">{bps(cur.edge)}</span>
              </span>
              <span className="ex-lg-it">
                <span className="ex-lg-l">10 s</span>
                <span className={"ex-lg-v " + (cur.mean[j10]! < 0 ? "down" : "up")}>{bps(cur.mean[j10])}</span>
              </span>
              <span className="ex-lg-it">
                <span className="ex-lg-l">Notional</span>
                <span className={"ex-lg-v" + (hide ? " masked" : "")}>{maskText(hide, compact(cur.notional))}</span>
              </span>
              <span className="ex-lg-it">
                <span className="ex-lg-l">Fills</span>
                <span className="ex-lg-v">{int(cur.fills)}</span>
              </span>
            </>
          ) : null}
        </div>
      </div>
    </div>
  );
}
