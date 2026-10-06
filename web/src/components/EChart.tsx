import { useEffect, useRef } from "react";
import * as echarts from "echarts/core";
import { BarChart, CustomChart, ScatterChart } from "echarts/charts";
import { DataZoomInsideComponent, DataZoomSliderComponent, GridComponent, MarkLineComponent, TooltipComponent } from "echarts/components";
import { CanvasRenderer } from "echarts/renderers";

echarts.use([
  BarChart,
  CustomChart,
  ScatterChart,
  DataZoomInsideComponent,
  DataZoomSliderComponent,
  GridComponent,
  MarkLineComponent,
  TooltipComponent,
  CanvasRenderer,
]);

export type EChartsType = echarts.EChartsType;

/** A canvas ECharts instance that fills its parent and follows its size. `onInit` runs once with the
 *  instance (wire events there); options are pushed by the caller with setOption. */
export function EChart({
  onInit,
  onResize,
  className,
}: {
  onInit: (c: EChartsType) => void | (() => void);
  onResize?: (w: number, h: number) => void;
  className?: string;
}) {
  const box = useRef<HTMLDivElement>(null);
  const init = useRef(onInit);
  const resize = useRef(onResize);
  resize.current = onResize;

  useEffect(() => {
    const el = box.current!;
    const chart = echarts.init(el, null, { renderer: "canvas" });
    const off = init.current(chart);
    const ro = new ResizeObserver(() => {
      chart.resize();
      resize.current?.(el.clientWidth, el.clientHeight);
    });
    ro.observe(el);
    return () => {
      ro.disconnect();
      off?.();
      chart.dispose();
    };
  }, []);

  return <div ref={box} className={className} style={{ width: "100%", height: "100%" }} />;
}
