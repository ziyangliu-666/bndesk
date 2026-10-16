// A category-axis chart for Analysis (markouts by horizon, by UTC hour) on ECharts, framed like ExChart: right
// axis, faint horizontal grid, a dashed crosshair line, and the in-plot legend with each line's value at the
// hovered category (the last one at rest). A click on a legend item hides or shows its series.
import { useEffect, useMemo, useRef, useState } from "react";
import * as echarts from "echarts/core";
import { LineChart } from "echarts/charts";
import { EChart, type EChartsType } from "../../components/EChart";
import { C, SANS } from "../../theme";
import "../../components/ex/ex.css";

// the line series is only needed here (EChart registers bars, scatter and custom for the quote map)
echarts.use([LineChart]);

export interface CurveSeries {
  key: string;
  label: string;
  color: string;
  data: (number | null)[];
  kind?: "line" | "bar";
  dashed?: boolean;
  /** 0: the right axis, 1: a second axis on the left (counts). */
  axis?: 0 | 1;
  /** Bars coloured by sign (up / down). */
  signBars?: boolean;
  format: (v: number) => string;
  /** Legend value by sign (P&L, markouts) instead of the series colour. */
  signValue?: boolean;
  title?: string;
}

const GRID = "rgba(32,38,47,0.55)";
const sign = (v: number | null | undefined) => (v == null || !Number.isFinite(v) || v === 0 ? C.ink : v > 0 ? C.up : C.down);

export function Curve({
  categories,
  series,
  hidden,
  onToggle,
  axisFormat,
  axis2Format,
  unit,
  unit2,
  heading,
  className,
}: {
  categories: string[];
  series: CurveSeries[];
  hidden: string[];
  onToggle: (k: string) => void;
  axisFormat: (v: number) => string;
  axis2Format?: (v: number) => string;
  /** Units over the right and the left axis (`bps`, `USDT`, `Fills`). */
  unit?: string;
  unit2?: string;
  /** The first legend item: the hovered category's name (`10 s`, `09:00`). */
  heading?: (cat: string) => string;
  className?: string;
}) {
  const chart = useRef<EChartsType | null>(null);
  const [hover, setHover] = useState<number | null>(null);
  const shown = useMemo(() => series.filter((s) => !hidden.includes(s.key)), [series, hidden]);
  const twoAxes = shown.some((s) => s.axis === 1);
  // two axes share their zero (a count under a signed figure would read as negative otherwise): the right axis
  // spans its data and 0, the left one is stretched below 0 by the same share, with no labels there
  const ranges = useMemo(() => {
    if (!twoAxes) return null;
    const vals = (a: 0 | 1) => shown.filter((s) => (s.axis ?? 0) === a).flatMap((s) => s.data.filter((v): v is number => v != null && Number.isFinite(v)));
    const r = vals(0);
    const l = vals(1);
    const lo = Math.min(0, ...r) * 1.1;
    const hi = Math.max(0, ...r) * 1.1 || 1;
    const lhi = Math.max(0, ...l) * 1.1 || 1;
    const share = -lo / (hi - lo);
    return { r: [lo, hi], l: [share >= 1 ? -lhi : (-share / (1 - share)) * lhi, lhi] };
  }, [twoAxes, shown]);

  const option = useMemo(
    () => ({
      animation: false,
      textStyle: { fontFamily: SANS },
      grid: { left: twoAxes ? 56 : 12, right: 64, top: 52, bottom: 28 },
      tooltip: {
        trigger: "axis",
        showContent: false,
        axisPointer: { type: "line", lineStyle: { color: "rgba(195,202,213,0.38)", type: "dashed", width: 1 }, label: { show: false } },
      },
      xAxis: {
        type: "category",
        data: categories,
        // half a category of room at each end: the first and last points are not cut by the plot edge
        boundaryGap: true,
        axisLine: { lineStyle: { color: C.rule } },
        axisTick: { show: false },
        axisLabel: { color: C.muted, fontSize: 11, margin: 10 },
        splitLine: { show: false },
      },
      yAxis: [
        {
          type: "value",
          position: "right",
          name: unit,
          nameLocation: "end",
          nameGap: 14,
          nameTextStyle: { color: C.muted, fontSize: 11, align: "left" },
          scale: false,
          ...(ranges ? { min: ranges.r[0], max: ranges.r[1] } : {}),
          axisLabel: { color: C.muted, fontSize: 11, formatter: axisFormat, showMinLabel: !ranges, showMaxLabel: !ranges },
          splitLine: { lineStyle: { color: GRID } },
          axisLine: { show: false },
        },
        {
          type: "value",
          position: "left",
          name: unit2,
          nameLocation: "end",
          nameGap: 14,
          nameTextStyle: { color: C.muted, fontSize: 11, align: "right" },
          show: twoAxes,
          ...(ranges ? { min: ranges.l[0], max: ranges.l[1] } : {}),
          axisLabel: { color: C.muted, fontSize: 11, formatter: (v: number) => (v < 0 ? "" : (axis2Format ?? axisFormat)(v)), showMinLabel: !ranges, showMaxLabel: !ranges },
          splitLine: { show: false },
          axisLine: { show: false },
        },
      ],
      series: shown.map((s) =>
        s.kind === "bar"
          ? {
              id: s.key,
              type: "bar",
              yAxisIndex: s.axis ?? 0,
              barMaxWidth: 28,
              data: s.data.map((v) => ({ value: v, itemStyle: { color: s.signBars ? (v != null && v < 0 ? C.down : C.up) : s.color, opacity: 0.85 } })),
              emphasis: { disabled: true },
            }
          : {
              id: s.key,
              type: "line",
              yAxisIndex: s.axis ?? 0,
              data: s.data,
              connectNulls: false,
              showSymbol: true,
              symbol: "circle",
              symbolSize: 5,
              lineStyle: { color: s.color, width: 1.5, type: s.dashed ? "dashed" : "solid" },
              itemStyle: { color: s.color },
              emphasis: { disabled: true },
              z: 3,
            },
      ),
    }),
    [categories, shown, axisFormat, axis2Format, twoAxes, unit, unit2, ranges],
  );

  useEffect(() => {
    chart.current?.setOption(option, { notMerge: true });
  }, [option]);

  const onInit = (c: EChartsType) => {
    chart.current = c;
    c.setOption(option);
    const move = (e: unknown) => {
      const info = (e as { axesInfo?: { axisDim: string; value: number }[] }).axesInfo?.find((a) => a.axisDim === "x");
      setHover(info ? info.value : null);
    };
    c.on("updateAxisPointer", move);
    const zr = c.getZr();
    const out = () => setHover(null);
    zr.on("globalout", out);
    return () => {
      c.off("updateAxisPointer", move);
      zr.off("globalout", out);
      chart.current = null;
    };
  };

  // values while hovering only: at rest the legend names the lines in their colours (the table under the chart
  // holds the figures, so they are not printed twice)
  const cat = hover == null ? null : categories[hover];
  return (
    <div className={"an-curve " + (className ?? "")}>
      <EChart onInit={onInit} />
      {categories.length > 0 && (
        <div className="ex-legend" style={{ top: 6, left: twoAxes ? 56 : 8 }}>
          <div className="ex-lg-line">
            {cat != null && (
              <span className="ex-lg-it">
                <span className="ex-lg-v" style={{ color: C.muted }}>
                  {heading ? heading(cat) : cat}
                </span>
              </span>
            )}
            {series.map((s) => {
              const v = hover == null ? null : s.data[hover];
              const off = hidden.includes(s.key);
              return (
                <span key={s.key} className={"ex-lg-it tog" + (off ? " off" : "")} onClick={() => onToggle(s.key)} title={s.title ?? "Click to hide or show"}>
                  <span className="ex-lg-l" style={cat == null && !s.signBars ? { color: s.color } : undefined}>
                    {s.label}
                  </span>
                  {cat != null && (
                    <span className="ex-lg-v" style={{ color: s.signValue ? sign(v) : s.color }}>
                      {v == null ? "--" : s.format(v)}
                    </span>
                  )}
                </span>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
