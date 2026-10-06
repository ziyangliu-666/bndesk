import { useEffect, useRef } from "react";
import uPlot from "uplot";
import "uplot/dist/uPlot.min.css";
import { C } from "../theme";

export const AXIS_FONT = `11px "IBM Plex Sans", system-ui, sans-serif`;

export function axis(extra: Partial<uPlot.Axis> = {}): uPlot.Axis {
  return {
    stroke: C.muted,
    font: AXIS_FONT,
    grid: { stroke: "#151a21", width: 1 },
    ticks: { show: false },
    gap: 4,
    size: 26,
    ...extra,
  };
}

export interface TipRow {
  color?: string; // swatch; rows of a single-series readout leave it out
  labelColor?: string; // the label in its series colour, for readouts without swatches
  label: string;
  value: string;
  dash?: boolean;
}

/** Crosshair tooltip: one readout listing every series at the cursor x. */
export function tooltipPlugin(read: (u: uPlot, idx: number) => { title: string; rows: TipRow[] } | null): uPlot.Plugin {
  let tip: HTMLDivElement;
  return {
    hooks: {
      init: (u) => {
        tip = document.createElement("div");
        tip.className = "u-tip";
        tip.style.display = "none";
        u.over.appendChild(tip);
        u.over.addEventListener("mouseleave", () => (tip.style.display = "none"));
      },
      setCursor: (u) => {
        const idx = u.cursor.idx;
        const left = u.cursor.left ?? -1;
        if (idx == null || left < 0) {
          tip.style.display = "none";
          return;
        }
        const r = read(u, idx);
        if (!r) {
          tip.style.display = "none";
          return;
        }
        tip.replaceChildren();
        const t = document.createElement("div");
        t.className = "u-tip-title";
        t.textContent = r.title;
        tip.appendChild(t);
        for (const row of r.rows) {
          const line = document.createElement("div");
          line.className = "u-tip-row";
          const key = document.createElement("span");
          key.className = "u-tip-key";
          key.style.background = row.color ?? "";
          const v = document.createElement("span");
          v.className = "u-tip-val";
          v.textContent = row.value;
          const l = document.createElement("span");
          l.className = "u-tip-lab";
          l.textContent = row.label;
          if (row.labelColor) l.style.color = row.labelColor;
          if (row.color) line.append(key);
          line.append(v, l);
          tip.appendChild(line);
        }
        tip.style.display = "block";
        const w = u.over.clientWidth;
        const tw = tip.offsetWidth;
        const x = left + 14 + tw > w ? left - 14 - tw : left + 14;
        const top = u.cursor.top ?? 0;
        const th = tip.offsetHeight;
        const y = Math.max(0, Math.min(top - th / 2, u.over.clientHeight - th));
        tip.style.transform = `translate(${x}px, ${y}px)`;
      },
    },
  };
}

interface Props {
  options: (width: number, height: number) => uPlot.Options;
  data: uPlot.AlignedData;
  className?: string;
}

/** uPlot bound to its container size. Options identity rebuilds the chart; data identity calls setData. */
export function UPlot({ options, data, className }: Props) {
  const ref = useRef<HTMLDivElement>(null);
  const plot = useRef<uPlot | null>(null);
  const dataRef = useRef(data);
  dataRef.current = data;

  useEffect(() => {
    const el = ref.current!;
    const w = Math.max(50, el.clientWidth);
    const h = Math.max(50, el.clientHeight);
    const u = new uPlot(options(w, h), dataRef.current, el);
    plot.current = u;
    const ro = new ResizeObserver(() => {
      const nw = Math.max(50, el.clientWidth);
      const nh = Math.max(50, el.clientHeight);
      if (nw !== u.width || nh !== u.height) u.setSize({ width: nw, height: nh });
    });
    ro.observe(el);
    return () => {
      ro.disconnect();
      u.destroy();
      plot.current = null;
    };
  }, [options]);

  useEffect(() => {
    const u = plot.current;
    if (u && u.data !== data) u.setData(data, true);
  }, [data]);

  return <div ref={ref} className={"uplot-host " + (className ?? "")} />;
}

/** Bars as two series (gains, losses) so sign is carried by the axis and the color agrees. */
export function barsPaths(radius = 0.15) {
  return uPlot.paths.bars!({ size: [0.7, 24], radius, gap: 2 });
}
