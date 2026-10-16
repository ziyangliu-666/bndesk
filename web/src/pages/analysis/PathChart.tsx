// The price path around our fills: the markout at each horizon from 10 s before the fill to 5 min after it, one
// line per side with its ±2 SE band, the reference's move D(h) as an optional dashed line. Horizons sit at equal
// steps (a log-like axis: the sub-second steps get as much room as the minutes). The legend reads the hovered
// horizon (the selected one at rest) with its standard error and fill count; a click (a tap on the phone)
// selects a horizon for the distribution. Plain SVG, so desktop and phone draw the same thing.
import { useMemo, useRef, useState, type PointerEvent } from "react";
import { useElementSize } from "@mantine/hooks";
import { bps, compact, num } from "../../format";
import type { MarkoutLine } from "../../protocol";
import { hLabel } from "./data";
import { niceTicks } from "./scale";

export interface PathLineDef {
  key: string;
  label: string;
  color: string;
  line: MarkoutLine;
  band?: boolean;
  dashed?: boolean;
  title?: string;
}

const PAD_X = 22;

export function PathChart({
  horizons,
  lines,
  hidden,
  onToggle,
  selected,
  onSelect,
  touch = false,
  height,
}: {
  horizons: number[];
  lines: PathLineDef[];
  hidden: string[];
  onToggle: (k: string) => void;
  selected: number;
  onSelect: (h: number) => void;
  touch?: boolean;
  /** Fixed height (phone); fills its box otherwise. */
  height?: number;
}) {
  const { ref, width, height: boxH } = useElementSize<HTMLDivElement>();
  const H = height ?? boxH;
  const [hover, setHover] = useState<number | null>(null);
  const drag = useRef<{ x: number; moved: boolean } | null>(null);
  const shown = lines.filter((l) => !hidden.includes(l.key));
  const N = horizons.length;
  const top = touch ? 62 : 30;
  const bottom = 22;
  const right = touch ? 40 : 48;
  const plotW = Math.max(10, width - right);
  const plotH = Math.max(10, H - top - bottom);
  const x = (i: number) => PAD_X + (i * (plotW - 2 * PAD_X)) / Math.max(1, N - 1);
  const iFill = horizons.indexOf(0);
  const iSel = horizons.indexOf(selected);

  const { lo, hi, ticks } = useMemo(() => {
    const vals: number[] = [0];
    for (const l of shown)
      l.line.mean.forEach((m, i) => {
        if (m == null) return;
        const se = l.band ? (l.line.se[i] ?? 0) : 0;
        vals.push(m - 2 * se, m + 2 * se);
      });
    const t = niceTicks(Math.min(...vals), Math.max(...vals), touch ? 4 : 6);
    return { lo: t[0]!, hi: t[t.length - 1]!, ticks: t };
  }, [shown, touch]);
  const y = (v: number) => top + ((hi - v) / (hi - lo || 1)) * plotH;

  const idxAt = (clientX: number, el: Element) => {
    const r = el.getBoundingClientRect();
    const px = clientX - r.left;
    const i = Math.round(((px - PAD_X) / Math.max(1, plotW - 2 * PAD_X)) * (N - 1));
    return Math.max(0, Math.min(N - 1, i));
  };
  const onMove = (e: PointerEvent<SVGSVGElement>) => {
    if (e.pointerType === "mouse") return setHover(idxAt(e.clientX, e.currentTarget));
    const d = drag.current;
    if (!d) return;
    if (Math.abs(e.clientX - d.x) > 6) d.moved = true;
    if (d.moved) setHover(idxAt(e.clientX, e.currentTarget));
  };
  const onDown = (e: PointerEvent<SVGSVGElement>) => {
    if (e.pointerType !== "mouse") drag.current = { x: e.clientX, moved: false };
  };
  const onUp = (e: PointerEvent<SVGSVGElement>) => {
    const i = idxAt(e.clientX, e.currentTarget);
    if (e.pointerType !== "mouse") {
      drag.current = null;
      setHover(null);
    }
    onSelect(horizons[i]!);
  };

  const cur = hover ?? (iSel >= 0 ? iSel : null);
  // narrow: a few anchor horizons, the selected one always, nothing next to it
  const ANCHORS = [-10, -1, 0, 1, 10, 60, 300];
  const narrow = plotW / N < 34;
  const showLabel = (i: number) => i === iSel || !narrow || (Math.abs(i - iSel) > 1 && ANCHORS.includes(horizons[i]!));

  return (
    <div ref={ref} className={"an-path" + (touch ? " touch" : "")} style={height ? { height } : undefined}>
      {width > 0 && H > 0 && (
        <svg
          width={width}
          height={H}
          onPointerMove={onMove}
          onPointerLeave={() => !touch && setHover(null)}
          onPointerDown={onDown}
          onPointerUp={onUp}
          onPointerCancel={() => {
            drag.current = null;
            setHover(null);
          }}
          role="img"
          aria-label="Markout by horizon around the fill"
        >
          {/* before the fill */}
          {iFill > 0 && <rect x={0} y={top} width={x(iFill)} height={plotH} className="an-pre" />}
          {ticks.map((t) => (
            <g key={t}>
              <line x1={0} x2={plotW} y1={Math.round(y(t)) + 0.5} y2={Math.round(y(t)) + 0.5} className={t === 0 ? "an-zero" : "an-grid"} />
              <text x={width - 4} y={y(t) + 4} textAnchor="end" className="an-ax">
                {num(t, Math.abs(hi - lo) < 4 ? 1 : 0, true)}
              </text>
            </g>
          ))}
          <text x={width - 4} y={top - 8} textAnchor="end" className="an-ax">
            bps
          </text>
          {iFill >= 0 && <line x1={Math.round(x(iFill)) + 0.5} x2={Math.round(x(iFill)) + 0.5} y1={top} y2={top + plotH} className="an-fill-line" />}
          {iSel >= 0 && <line x1={Math.round(x(iSel)) + 0.5} x2={Math.round(x(iSel)) + 0.5} y1={top} y2={top + plotH} className="an-sel-line" />}
          {hover != null && hover !== iSel && (
            <line x1={Math.round(x(hover)) + 0.5} x2={Math.round(x(hover)) + 0.5} y1={top} y2={top + plotH} className="an-hover-line" />
          )}
          {horizons.map((h, i) =>
            showLabel(i) ? (
              <text key={h} x={x(i)} y={H - 6} textAnchor="middle" className={"an-ax" + (i === iSel ? " sel" : i === iFill ? " fill" : "")}>
                {hLabel(h, true)}
              </text>
            ) : null,
          )}
          {shown.map((l) => (l.band ? <Band key={"b" + l.key} l={l} x={x} y={y} /> : null))}
          {shown.map((l) => {
            const segs = segments(l.line.mean, x, y);
            return (
              <g key={l.key}>
                {segs.map((d, k) => (
                  <path key={k} d={d} fill="none" stroke={l.color} strokeWidth={1.5} strokeDasharray={l.dashed ? "4 3" : undefined} strokeLinejoin="round" />
                ))}
                {l.line.mean.map((m, i) => (m == null ? null : <circle key={i} cx={x(i)} cy={y(m)} r={cur === i ? 3.5 : 2} fill={l.color} />))}
              </g>
            );
          })}
        </svg>
      )}
      <div className="ex-legend an-path-lg" style={{ top: 6 }}>
        <div className="ex-lg-line an-lg-items">
          <span className="ex-lg-it">
            <span className="ex-lg-v an-lg-h">{cur == null ? "--" : (cur === iFill ? "At the fill" : "At " + hLabel(horizons[cur]!))}</span>
          </span>
          {lines.map((l) => {
            const off = hidden.includes(l.key);
            const v = cur == null ? null : l.line.mean[cur];
            const se = cur == null ? null : l.line.se[cur];
            const n = cur == null ? null : l.line.n[cur];
            return (
              <span key={l.key} className={"ex-lg-it tog" + (off ? " off" : "")} onClick={() => onToggle(l.key)} title={l.title ?? "Click to hide or show"}>
                <span className="ex-lg-l" style={{ color: l.color }}>
                  {l.label}
                </span>
                <span className="ex-lg-v" style={{ color: l.color }}>
                  {v == null ? "--" : bps(v)}
                </span>
                {se != null && <span className="ex-lg-l">±{num(2 * se, 2 * se < 0.95 ? 2 : 1)}</span>}
                {!touch && n != null && n > 0 && <span className="ex-lg-l">n {compact(n, n < 1000 ? 0 : 1)}</span>}
              </span>
            );
          })}
        </div>
      </div>
    </div>
  );
}

function segments(vals: (number | null)[], x: (i: number) => number, y: (v: number) => number): string[] {
  const out: string[] = [];
  let d = "";
  vals.forEach((v, i) => {
    if (v == null) {
      if (d) out.push(d);
      d = "";
      return;
    }
    d += (d ? "L" : "M") + x(i).toFixed(1) + "," + y(v).toFixed(1);
  });
  if (d) out.push(d);
  return out;
}

/** mean ± 2 SE as a filled band, broken where a horizon has no SE yet. */
function Band({ l, x, y }: { l: PathLineDef; x: (i: number) => number; y: (v: number) => number }) {
  const runs: number[][] = [];
  let run: number[] = [];
  l.line.mean.forEach((m, i) => {
    if (m != null && l.line.se[i] != null) run.push(i);
    else if (run.length) {
      runs.push(run);
      run = [];
    }
  });
  if (run.length) runs.push(run);
  return (
    <>
      {runs
        .filter((r) => r.length > 1)
        .map((r, k) => {
          const up = r.map((i) => `${x(i).toFixed(1)},${y(l.line.mean[i]! + 2 * l.line.se[i]!).toFixed(1)}`);
          const dn = r
            .slice()
            .reverse()
            .map((i) => `${x(i).toFixed(1)},${y(l.line.mean[i]! - 2 * l.line.se[i]!).toFixed(1)}`);
          return <polygon key={k} points={[...up, ...dn].join(" ")} fill={l.color} opacity={0.13} />;
        })}
    </>
  );
}
