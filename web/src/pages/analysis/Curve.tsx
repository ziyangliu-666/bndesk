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
  heading,
  className,
}: {
  categories: string[];
  series: CurveSeries[];
  hidden: string[];
  onToggle: (k: string) => void;
  axisFormat: (v: number) => string;
  axis2Format?: (v: number) => string;
  /** The first legend item: the hovered category's name (`10 s`, `09:00`). */
  heading?: (cat: string) => string;
  className?: string;
}) {
  const chart = useRef<EChartsType | null>(null);
  const [hover, setHover] = useState<number | null>(null);
  const shown = useMemo(() => series.filter((s) => !hidden.includes(s.key)), [series, hidden]);
  const twoAxes = shown.some((s) => s.axis === 1);

  const option = useMemo(
    () => ({
      animation: false,
      textStyle: { fontFamily: SANS },
      grid: { left: twoAxes ? 52 : 12, right: 64, top: 44, bottom: 28 },
      tooltip: {
        trigger: "axis",
        showContent: false,
        axisPointer: { type: "line", lineStyle: { color: "rgba(195,202,213,0.38)", type: "dashed", width: 1 }, label: { show: false } },
      },
      xAxis: {
        type: "category",
        data: categories,
        boundaryGap: shown.some((s) => s.kind === "bar"),
        axisLine: { lineStyle: { color: C.rule } },
        axisTick: { show: false },
        axisLabel: { color: C.muted, fontSize: 11, margin: 10 },
        splitLine: { show: false },
      },
      yAxis: [
        {
          type: "value",
          position: "right",
          scale: false,
          axisLabel: { color: C.muted, fontSize: 11, formatter: axisFormat },
          splitLine: { lineStyle: { color: GRID } },
          axisLine: { show: false },
        },
        {
          type: "value",
          position: "left",
          show: twoAxes,
          axisLabel: { color: C.muted, fontSize: 11, formatter: axis2Format ?? axisFormat },
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
    [categories, shown, axisFormat, axis2Format, twoAxes],
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

  const i = hover ?? categories.length - 1;
  const cat = categories[i];
  return (
    <div className={"an-curve " + (className ?? "")}>
      <EChart onInit={onInit} />
      {cat != null && (
        <div className="ex-legend" style={{ top: 6, left: twoAxes ? 52 : 8 }}>
          <div className="ex-lg-line">
            <span className="ex-lg-it">
              <span className="ex-lg-v" style={{ color: C.muted }}>
                {heading ? heading(cat) : cat}
              </span>
            </span>
            {series.map((s) => {
              const v = s.data[i];
              const off = hidden.includes(s.key);
              return (
                <span key={s.key} className={"ex-lg-it tog" + (off ? " off" : "")} onClick={() => onToggle(s.key)} title={s.title ?? "Click to hide or show"}>
                  <span className="ex-lg-l">{s.label}</span>
                  <span className="ex-lg-v" style={{ color: s.signValue ? sign(v) : s.color }}>
                    {v == null ? "--" : s.format(v)}
                  </span>
                </span>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
