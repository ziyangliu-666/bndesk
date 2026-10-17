// The desk's P&L history on ExChart: Daily (P&L per bar, green / red, or the split stacked), Cumulative (a
// baseline area with the split as lines) or Candles (each bar's P&L since its day start); volume and the
// inventory under it, each pane with its legend.
import { useMemo, type ReactNode } from "react";
import { ExChart, rgba, signColor, UP, DOWN, type ExLegendItem, type ExPoint, type ExOhlc, type ExSeries, type ExView, type Chip } from "../../components/ex";
import { MASK, maskFormat } from "../../mask";
import { REF_LINE } from "../../components/ex/palette";
import { C, FUT_COLOR, INV_COLOR, PNL_COLORS, PNL_STROKES, type Stroke } from "../../theme";
import { compact, num, int } from "../../format";
import { PARTS, type HInterval, type Mode, type Part, type Row } from "./data";

export const PART_META: Record<Part, { label: string; long: string; color: string; title?: string; style: Stroke }> = {
  pi: { label: "Trading", long: "Trading PnL", color: PNL_COLORS.trading, style: PNL_STROKES.trading, title: "Trading PnL: market making plus inventory PnL, fees included; not hedged" },
  mm: { label: "Market making", long: "Market making", color: PNL_COLORS.mm, style: PNL_STROKES.mm, title: "Market making: each fill against the mid 60 s later, minus fees" },
  inv: { label: "Inventory PnL", long: "Inventory PnL", color: PNL_COLORS.inv, style: PNL_STROKES.inv, title: "Inventory PnL: what the held inventory made after those 60 s" },
  hedge: { label: "Hedge", long: "Hedge", color: PNL_COLORS.hedge, style: PNL_STROKES.hedge, title: "Futures legs: price, fees, funding" },
  reb: { label: "Rebates", long: "Rebates", color: PNL_COLORS.reb, style: PNL_STROKES.reb, title: "Market-maker rebates" },
  other: { label: "Other", long: "Other", color: PNL_COLORS.other, style: PNL_STROKES.other, title: "What the split does not explain: Day PnL − trading − hedge − rebates" },
};
/** The parts that add up to the P&L (Trading is MM + Inv). */
const STACK: Part[] = ["mm", "inv", "hedge", "reb", "other"];
/** The inventory pane's line: the inventory hue (the Desk's Exposure tab and Assets draw spot inventory so too). */
const HELD = INV_COLOR;

const sign2 = (v: number) => num(v, 2, true);
const val2 = (v: number | null | undefined) => (v == null ? "--" : num(v, 2, true));

// one cache per drawn series: a row object gives the same point object, so a live tick redraws only the tail
const caches = new Map<string, WeakMap<Row, ExPoint | ExOhlc>>();
function points<P extends ExPoint | ExOhlc>(key: string, rows: Row[], f: (r: Row) => P): P[] {
  let m = caches.get(key);
  if (!m) caches.set(key, (m = new WeakMap()));
  return rows.map((r) => {
    let p = m!.get(r) as P | undefined;
    if (!p) m!.set(r, (p = f(r)));
    return p;
  });
}

export function periodWord(iv: HInterval): string {
  return iv === "1w" ? "Week" : iv === "1d" ? "Day" : "Bar";
}

export function DeskChart({
  rows,
  interval,
  mode,
  hidden,
  onToggle,
  loading,
  error,
  toolbarLeft,
  intervals,
  onInterval,
  modes,
  view,
  legendTime,
  chosen,
  onBarClick,
  hide,
}: {
  rows: Row[];
  interval: HInterval;
  mode: Mode;
  hidden: string[];
  onToggle: (k: string) => void;
  loading: boolean;
  error: string | null;
  toolbarLeft: ReactNode;
  intervals: { value: string; label: string }[];
  onInterval: (v: string) => void;
  modes: { label: string; options: { value: string; label: string; title?: string }[]; value: string; onChange: (v: string) => void }[];
  /** A range the page zooms to (a chosen day). */
  view: ExView | null;
  /** The bar the legend shows at rest (the chosen day's). */
  legendTime?: number | null;
  /** The chosen day's (week's) bar, ms: marked on the chart. */
  chosen?: number | null;
  /** A click on a bar. */
  onBarClick?: (t: number) => void;
  /** Hide amounts: the axis and legend figures read •••. */
  hide: boolean;
}) {
  // Hide amounts: the axes, tags and legend read ••• (ExChart re-reads a format that prints otherwise)
  const sgn = maskFormat(hide, sign2);
  const val = (v: number | null | undefined) => (v == null ? "--" : hide ? MASK : val2(v));
  const amt = maskFormat(hide, (v: number) => num(v, 0));
  const vol = maskFormat(hide, (v: number) => compact(v));
  const stack = !hidden.includes("stack") && mode === "daily";
  const word = periodWord(interval);
  const pnlLabel = word === "Bar" ? "PnL" : `${word} PnL`;
  const byT = useMemo(() => new Map(rows.map((r) => [r.t, r])), [rows]);
  const at = (t: number) => byT.get(t);

  // the stacked parts depend on which are shown
  const stackKey = STACK.filter((k) => !hidden.includes(k)).join(",");
  const shownStack = useMemo(() => (stackKey ? (stackKey.split(",") as Part[]) : []), [stackKey]);

  const series = useMemo<ExSeries[]>(() => {
    const out: ExSeries[] = [];
    if (mode === "daily" && !stack) {
      out.push({
        key: "pnl",
        kind: "histogram",
        label: pnlLabel,
        toggle: false,
        signColor: true,
        lastValue: true,
        format: sgn,
        // a chosen day: its bar full, the others dimmed
        data: points(`d.pnl.${hide ? "h" : ""}.${chosen ?? ""}`, rows, (r) => ({
          time: r.t,
          value: r.pnl,
          color: hide ? rgba(C.ink2, chosen == null || r.t === chosen ? 0.5 : 0.25) : rgba(r.pnl >= 0 ? UP : DOWN, chosen == null || r.t === chosen ? 0.85 : 0.35),
        })),
      });
    } else if (mode === "daily") {
      // stacked: the positive parts upwards and the negative ones downwards, each bar drawn from the top of the
      // stack down so the smaller sums paint over it
      for (const side of [1, -1] as const) {
        for (let i = shownStack.length - 1; i >= 0; i--) {
          const k = shownStack[i]!;
          const keys = shownStack.slice(0, i + 1);
          out.push({
            key: `stk${side}${k}`,
            kind: "histogram",
            label: PART_META[k].label,
            color: PART_META[k].color,
            legend: false,
            toggle: false,
            lastValue: false,
            box: false,
            format: sgn,
            data: points(`s${side}${keys.join("")}`, rows, (r) => {
              let s = 0;
              // a bar from before the split was recorded is all Other
              const unsplit = STACK.every((x) => r.bar[x] == null);
              for (const kk of keys) {
                const v = unsplit && kk === "other" ? r.pnl : r.bar[kk];
                if (v != null && v * side > 0) s += v;
              }
              // nothing on this side: a gap, not a hairline along zero
              return { time: r.t, value: s === 0 ? null : s };
            }),
          });
        }
      }
      // the bar's net P&L as a dot over its stack
      if (out.length)
        out.push({
          key: "net",
          kind: "line",
          label: pnlLabel,
          color: C.ink,
          legend: false,
          toggle: false,
          lastValue: false,
          box: false,
          format: sgn,
          options: { lineVisible: false, pointMarkersVisible: true, pointMarkersRadius: 2.5, crosshairMarkerVisible: false },
          data: points("stk.net", rows, (r) => ({ time: r.t, value: r.pnl })),
        });
      if (!out.length)
        out.push({ key: "pnl", kind: "histogram", label: pnlLabel, toggle: false, signColor: true, format: sgn, data: points(hide ? "d.pnl.h" : "d.pnl", rows, (r) => ({ time: r.t, value: r.pnl, color: hide ? rgba(C.ink2, 0.5) : rgba(r.pnl >= 0 ? UP : DOWN, 0.85) })) });
    } else if (mode === "cum") {
      out.push({ key: "cum", kind: "baseline", label: "Cumulative PnL", toggle: false, format: sgn, data: points("c.cum", rows, (r) => ({ time: r.t, value: r.cum })) });
      for (const k of PARTS) {
        const m = PART_META[k];
        out.push({
          key: k,
          kind: "line",
          label: m.label,
          color: m.color,
          width: 1.5,
          lineStyle: m.style,
          lastValue: false,
          legend: 2,
          format: sgn,
          options: { crosshairMarkerVisible: false },
          data: points("c." + k, rows, (r) => ({ time: r.t, value: r.run[k] })),
        });
      }
    } else {
      out.push({
        key: "k",
        kind: "candles",
        label: pnlLabel,
        toggle: false,
        format: sgn,
        data: points("k", rows, (r) => ({ time: r.t, open: r.o, high: Math.max(r.h, r.o, r.c), low: Math.min(r.l, r.o, r.c), close: r.c })),
      });
    }
    out.push({
      key: "vol",
      kind: "histogram",
      label: "Vol(USDT)",
      pane: 1,
      color: rgba(C.ink2, 0.32),
      format: vol,
      data: points("vol", rows, (r) => ({ time: r.t, value: r.volume })),
    });
    out.push({ key: "held", kind: "line", label: "Inventory", pane: 2, color: HELD, format: amt, lastValue: true, data: points("held", rows, (r) => ({ time: r.t, value: r.inventory })) });
    out.push({ key: "fut", kind: "line", label: "Futures", pane: 2, color: FUT_COLOR, format: amt, lastValue: true, data: points("fut", rows, (r) => ({ time: r.t, value: r.futures })) });
    return out;
  }, [rows, mode, stack, shownStack, pnlLabel, hide, chosen]);
  // the chosen bar also gets a mark under it (whatever the chart type)
  const markers = useMemo(
    () => (chosen != null && rows.some((r) => r.t === chosen) && series[0] ? [{ series: series[0].key, time: chosen, color: C.accent, shape: "arrowUp" as const, position: "belowBar" as const, size: 1 }] : []),
    [chosen, rows, series],
  );

  const legendExtra = useMemo<ExLegendItem[]>(() => {
    const out: ExLegendItem[] = [];
    if (mode === "daily" && stack)
      out.push({ label: pnlLabel, line: 1, value: (t) => { const r = at(t); return r ? [sgn(r.pnl), signColor(r.pnl)] : "--"; } });
    if (mode === "cum")
      out.push({ label: word, line: 1, title: `What this ${word.toLowerCase()} made`, value: (t) => { const r = at(t); return r ? [sgn(r.pnl), signColor(r.pnl)] : "--"; } });
    if (mode === "daily")
      for (const k of PARTS) {
        if (stack && k === "pi") continue;
        const m = PART_META[k];
        out.push({
          key: stack ? k : undefined,
          label: m.label,
          color: m.color,
          line: 2,
          title: m.title,
          value: (t) => [val(at(t)?.bar[k]), undefined],
        });
      }
    out.push({ label: "Fills", pane: 1, line: 1, value: (t) => [int(at(t)?.fills), C.ink] });
    out.push({
      label: "Net",
      pane: 2,
      line: 1,
      title: "Inventory plus futures notional",
      value: (t) => {
        const r = at(t);
        return r && r.inventory != null && r.futures != null ? [hide ? MASK : num(r.inventory + r.futures, 0, true), C.ink] : "--";
      },
    });
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [byT, mode, stack, pnlLabel, word, hide]);

  const chips = useMemo<(Chip | "|")[]>(() => {
    const out: (Chip | "|")[] = [];
    if (mode === "daily") out.push({ key: "stack", label: "Stack split", title: "Draw each bar as its parts, stacked" });
    const parts = mode === "cum" ? PARTS : stack ? STACK : [];
    if (parts.length && out.length) out.push("|");
    for (const k of parts) out.push({ key: k, label: PART_META[k].label, color: PART_META[k].color, stroke: mode === "cum" ? PART_META[k].style : undefined, bar: mode !== "cum", title: PART_META[k].title });
    if (out.length) out.push("|");
    out.push({ key: "vol", label: "Vol" }, { key: "held", label: "Inventory", color: HELD }, { key: "fut", label: "Futures", color: FUT_COLOR });
    return out;
  }, [mode, stack]);

  const zeroOn = mode === "cum" ? "cum" : mode === "candles" ? "k" : (series[0]?.key ?? "pnl");
  const zeroLine = useMemo(() => [{ series: zeroOn, price: 0, color: REF_LINE, style: "solid" as const, axisLabel: false }], [zeroOn]);

  return (
    <ExChart
      id="hist"
      fill
      series={series}
      paneStretch={[1, 0.2, 0.24]}
      hidden={hidden}
      onToggle={onToggle}
      toolbarLeft={toolbarLeft}
      intervals={intervals}
      interval={interval}
      onInterval={onInterval}
      modes={modes}
      fullscreen
      legendRest="names"
      title="Desk PnL"
      loading={loading}
      emptyText={error ? "Could not load the history" : "No data in this range"}
      legendExtra={legendExtra}
      priceLines={zeroLine}
      chips={chips}
      initialBars={interval === "15m" ? 700 : undefined}
      resetKey={mode}
      rightOffset={1}
      view={view}
      legendTime={legendTime}
      markers={markers}
      onBarClick={onBarClick}
    />
  );
}
