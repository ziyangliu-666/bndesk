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

type Read = (u: uPlot, idx: number) => { title: string; rows: TipRow[] } | null;

export interface TipOptions {
  /** "float" (default): a tip beside the cursor. "strip": one line above the plot (phones: a floating tip covers
   *  half the chart and the finger the rest), showing the latest point when there is no cursor. */
  mode?: "float" | "strip";
  /** Strip mode: the element to write into. Default: the `<UPlot strip>` line above the plot, else a line laid
   *  over the top of the plot. */
  strip?: HTMLElement | null;
  /** Strip mode, what the line shows while no finger (or pointer) reads a point:
   *  "latest" (default): the latest point, as a readout with its time;
   *  "key": a key, each series' swatch and name with its latest value, no time (a chart of several lines);
   *  "none": nothing (the latest values are on the page already). A finger on the plot replaces it with the
   *  readout at that point, in the same line, so the plot never moves. */
  rest?: "latest" | "key" | "none";
}

/** Crosshair tooltip: one readout listing every series at the cursor x. */
export function tooltipPlugin(read: Read, opts: TipOptions = {}): uPlot.Plugin {
  if (opts.mode === "strip") return stripPlugin(read, opts.strip ?? null, opts.rest ?? "latest");
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

/** The readout as one line: title, then each series' swatch, value and label. */
function stripPlugin(read: Read, given: HTMLElement | null, rest: "latest" | "key" | "none"): uPlot.Plugin {
  let el: HTMLElement;
  let own = false;
  const fill = (u: uPlot) => {
    const n = u.data[0]?.length ?? 0;
    const left = u.cursor.left ?? -1;
    const reading = u.cursor.idx != null && left >= 0;
    const idx = reading ? u.cursor.idx! : n - 1;
    const r = idx >= 0 && (reading || rest !== "none") ? read(u, idx) : null;
    const key = !reading && rest === "key";
    el.replaceChildren();
    el.classList.toggle("u-strip-key", key);
    if (!r) return;
    if (!key) {
      const t = document.createElement("span");
      t.className = "u-strip-title";
      t.textContent = r.title;
      el.appendChild(t);
    }
    for (const row of r.rows) {
      const item = document.createElement("span");
      item.className = "u-strip-item";
      if (row.color) {
        const key = document.createElement("span");
        key.className = "u-tip-key";
        key.style.background = row.color;
        item.append(key);
      }
      const l = document.createElement("span");
      l.className = "u-tip-lab";
      l.textContent = row.label;
      // a key names each line in its colour
      const lc = row.labelColor ?? (key ? row.color : undefined);
      if (lc) l.style.color = lc;
      const v = document.createElement("span");
      // Hide amounts: a masked figure reads muted, like the pages' masked money
      v.className = row.value.includes("•••") ? "u-strip-val masked" : "u-strip-val";
      v.textContent = row.value;
      item.append(l, v);
      el.appendChild(item);
    }
  };
  return {
    hooks: {
      init: (u) => {
        const sib = u.root.parentElement?.previousElementSibling;
        if (given) el = given;
        else if (sib instanceof HTMLElement && sib.classList.contains("u-strip")) el = sib;
        else {
          el = document.createElement("div");
          el.className = "u-strip over";
          u.over.appendChild(el);
          own = true;
        }
      },
      ready: (u) => fill(u),
      setData: (u) => fill(u),
      setCursor: (u) => fill(u),
      destroy: () => {
        if (own) el.remove();
        else el.replaceChildren();
      },
    },
  };
}

/** Touch: a finger dragged sideways scrubs the cursor and a vertical swipe scrolls the page; a tap elsewhere
 *  clears it (touch has no mouseleave). Mouse input is left to uPlot. */
export function touchCursorPlugin(): uPlot.Plugin {
  let away: (e: PointerEvent) => void = () => {};
  let raf = 0;
  return {
    hooks: {
      init: (u) => {
        const o = u.over;
        o.style.touchAction = "pan-y";
        const move = (e: PointerEvent) => {
          if (e.pointerType === "mouse") return;
          const r = o.getBoundingClientRect();
          const left = Math.max(0, Math.min(r.width, e.clientX - r.left));
          const top = Math.max(0, Math.min(r.height, e.clientY - r.top));
          cancelAnimationFrame(raf);
          raf = requestAnimationFrame(() => u.setCursor({ left, top }));
        };
        o.addEventListener("pointerdown", move);
        o.addEventListener("pointermove", move);
        away = (e) => {
          if (e.pointerType !== "mouse" && !o.contains(e.target as Node)) u.setCursor({ left: -10, top: -10 });
        };
        document.addEventListener("pointerdown", away, { passive: true });
      },
      destroy: () => {
        cancelAnimationFrame(raf);
        document.removeEventListener("pointerdown", away);
      },
    },
  };
}

interface Props {
  options: (width: number, height: number) => uPlot.Options;
  data: uPlot.AlignedData;
  className?: string;
  /** A one-line readout above the plot, for `tooltipPlugin(read, { mode: "strip" })`. */
  strip?: boolean;
}

/** uPlot bound to its container size. Options identity rebuilds the chart; data identity calls setData. */
export function UPlot({ options, data, className, strip }: Props) {
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

  const host = <div ref={ref} className={"uplot-host " + (className ?? "")} />;
  return strip ? (
    <>
      <div className="u-strip fig" />
      {host}
    </>
  ) : (
    host
  );
}

/** Bars as two series (gains, losses) so sign is carried by the axis and the color agrees. */
export function barsPaths(radius = 0.15) {
  return uPlot.paths.bars!({ size: [0.7, 24], radius, gap: 2 });
}
