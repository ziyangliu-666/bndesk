// uPlot axis helpers shared by the Accounts and PnL-days charts.
import type uPlot from "uplot";
import { hm, num, type TzMode } from "../format";
import { axis } from "./UPlot";

export function timeAxis(tz: TzMode, extra: Partial<uPlot.Axis> = {}): uPlot.Axis {
  return axis({
    values: (_u, splits) => splits.map((s) => hm(s * 1000, tz)),
    space: 60,
    incrs: [60, 300, 900, 1800, 3600, 7200, 10800, 21600],
    ...extra,
  });
}

/** Tick labels with decimals only when the tick step needs them; signed unless told otherwise. */
export function usdTicks(signed = true) {
  return (_u: uPlot, splits: number[], _ax: number, _space: number, incr: number) =>
    splits.map((v) => {
      if (v === 0) return "0";
      const a = Math.abs(v);
      if (incr >= 1000 && a >= 10_000) return num(v / 1000, incr >= 10_000 ? 0 : 1, signed) + "k";
      return num(v, incr >= 1 ? 0 : 2, signed);
    });
}

export function usdAxis(extra: Partial<uPlot.Axis> = {}): uPlot.Axis {
  return axis({
    values: usdTicks(true),
    size: 62,
    ...extra,
  });
}
