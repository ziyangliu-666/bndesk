// Markout through the day: 15-minute buckets since the day start, the 10 s and 60 s markouts as lines (bps) over
// bars of the bucket's fills or notional. One ExChart, so it reads and moves like every other time chart.
import { useMemo, type ReactNode } from "react";
import { ExChart, rgba, useExPref, type ExSeries } from "../../components/ex";
import { bps, compact, int } from "../../format";
import { maskFormat } from "../../mask";
import { C, S1 } from "../../theme";
import type { MarkoutBucket } from "../../protocol";

type Bars = "fills" | "notional";

export function DayChart({ id, buckets, hide, height, fill, touch, title }: { id: string; buckets: MarkoutBucket[]; hide: boolean; height?: number; fill?: boolean; touch?: boolean; title?: ReactNode }) {
  const [bars, setBars] = useExPref<Bars>(id, "bars", "fills", ["fills", "notional"]);
  const series = useMemo<ExSeries[]>(() => {
    const fNotional = maskFormat(hide, (v: number) => compact(v));
    return [
      { key: "mk10", kind: "line", label: "10 s", color: C.ink, format: (v) => bps(v), data: buckets.map((b) => ({ time: b.t, value: b.mk10 })) },
      { key: "mk60", kind: "line", label: "60 s", color: S1, format: (v) => bps(v), data: buckets.map((b) => ({ time: b.t, value: b.mk60 })) },
      bars === "fills"
        ? { key: "bars", kind: "histogram", label: "Fills", pane: 1, color: rgba(C.ink2, 0.38), lastValue: false, toggle: false, format: (v) => int(v), data: buckets.map((b) => ({ time: b.t, value: b.fills })) }
        : { key: "bars", kind: "histogram", label: "Notional", pane: 1, color: rgba(C.ink2, 0.38), lastValue: false, toggle: false, format: fNotional, data: buckets.map((b) => ({ time: b.t, value: b.notional })) },
    ];
  }, [buckets, bars, hide]);
  return (
    <ExChart
      id={id}
      series={series}
      paneStretch={[1, 0.3]}
      toolbarLeft={title}
      modes={[
        {
          label: "Bars",
          value: bars,
          onChange: (v) => setBars(v as Bars),
          options: [
            { value: "fills", label: "Fills" },
            { value: "notional", label: "Notional" },
          ],
        },
      ]}
      priceLines={[{ series: "mk10", price: 0, color: rgba(C.ink2, 0.35), style: "solid", axisLabel: false }]}
      rightOffset={1}
      height={height}
      fill={fill}
      touch={touch}
      emptyText={buckets.some((b) => b.fills > 0) ? undefined : "No fills today"}
    />
  );
}
