import { useEffect, useMemo, useRef } from "react";
import type { OpenOrder, SymbolRow } from "../protocol";
import { useStore } from "../store";
import { C, SANS } from "../theme";
import { bps, MINUS, price, usd } from "../format";
import { EChart, type EChartsType } from "./EChart";

/** One row per instrument, x in bps from fair. The market's bid-ask is a thin bar, own bids and asks
 *  are dots with area ~ notional, orders through fair carry an amber ring, orders beyond the x range
 *  sit on the edge as triangles. Inventory value is a narrow bar column on the right. */

interface Row {
  sym: SymbolRow;
  orders: OpenOrder[];
}

export type MapSort = "activity" | "name" | "inventory";

function rowsOf(symbols: SymbolRow[], orders: OpenOrder[], sort: MapSort): Row[] {
  const by = new Map<string, OpenOrder[]>();
  for (const o of orders) {
    const k = `${o.venue}:${o.symbol}`;
    (by.get(k) ?? by.set(k, []).get(k)!).push(o);
  }
  const rows = symbols
    .filter((s) => s.venue === "spot" && (by.has(`spot:${s.symbol}`) || Math.abs(s.inv_value) >= 5))
    .map((s) => ({ sym: s, orders: by.get(`spot:${s.symbol}`) ?? [] }));
  const name = (r: Row) => r.sym.symbol;
  if (sort === "name") rows.sort((a, b) => name(a).localeCompare(name(b)));
  else if (sort === "inventory") rows.sort((a, b) => Math.abs(b.sym.inv_value) - Math.abs(a.sym.inv_value));
  else
    rows.sort(
      (a, b) =>
        // today's fills only grow, so rows keep their place while orders churn
        b.sym.fills_day - a.sym.fills_day || name(a).localeCompare(name(b)),
    );
  return rows;
}

const short = (s: string) => s.replace(/USDT$/, "");
const off = (px: number, fair: number) => ((px - fair) / fair) * 1e4;
const clamp = (v: number, r: number) => Math.max(-r, Math.min(r, v));

const ROW_H = 17; // target row pitch when the list scrolls
const ROW_MAX = 34; // tallest row when the list fits
const TOP = 22;
const BOTTOM = 4;
const LEFT = 66;
const INV_W = 56; // inventory bars
const INV_LABEL = 50; // inventory figures right of the bars
const SLIDER = 10;
const GAP = 16;

// bps ranges ctrl + wheel steps through; the preset buttons are three of them
const LADDER = [2, 4, 6, 10, 16, 25, 35, 50, 75, 100, 150, 200];

const BAND = "rgba(195,202,213,0.14)";
const BAND_EDGE = "rgba(195,202,213,0.6)";
const INV_FILL = "rgba(138,148,165,0.45)";

const tick = (v: number, r: number) => (v === 0 ? "fair" : (v > 0 ? "+" : MINUS) + Math.abs(v) + (v === r ? " bps" : ""));

const TD = "padding:1px 4px";
const TH = "padding:0 4px 2px;font-weight:400;font-size:10.5px";
const R = ";text-align:right";

function tipHtml(r: Row): string {
  const s = r.sym;
  const os = [...r.orders].sort((a, b) => b.price - a.price);
  const td = (v: string, cls = "", right = false) => `<td class="${cls}" style="${TD}${right ? R : ""}">${v}</td>`;
  const th = (v: string, right = false) => `<th style="${TH}${right ? R : ";text-align:left"}">${v}</th>`;
  const kv = (k: string, v: string) => `<tr>${td(k, "muted")}${td(v, "", true)}</tr>`;
  const table = (body: string, extra = "") => `<table class="fig" style="width:100%;border-collapse:collapse;${extra}">${body}</table>`;
  const orders = os.length
    ? table(
        `<thead><tr class="muted">${th("Side")}${th("Acct")}${th("Price", true)}${th("USDT", true)}${th("bps", true)}</tr></thead><tbody>` +
          os
            .map(
              (o) =>
                "<tr>" +
                td(o.side === "buy" ? "bid" : "ask", o.side === "buy" ? "up" : "down") +
                td(o.account) +
                td(price(o.price), "", true) +
                td(usd(o.notional), "", true) +
                td(bps(o.dist_bps), o.dist_bps != null && o.dist_bps < 0 ? "warn-text" : "", true) +
                "</tr>",
            )
            .join("") +
          "</tbody>",
      )
    : `<div class="muted" style="padding:0 4px 3px">No resting orders</div>`;
  return (
    `<div style="font-weight:600;padding:0 4px 4px">${short(s.symbol)}</div>` +
    orders +
    table(
      "<tbody>" +
        kv("Mid", price(s.mid)) +
        kv("Bid", price(s.bid)) +
        kv("Ask", price(s.ask)) +
        kv("Fair", price(s.fair)) +
        kv("Inventory", usd(s.inv_value) + " USDT") +
        "</tbody>",
      `border-top:1px solid ${C.rule};margin-top:4px`,
    )
  );
}

export function QuoteMap({
  range,
  onRange,
  sort,
  account,
  selected,
  onSelect,
}: {
  range: number;
  onRange: (r: number) => void;
  sort: MapSort;
  account: string | null;
  selected: string;
  onSelect: (name: string) => void;
}) {
  const symbols = useStore((s) => s.snap?.symbols);
  const orders = useStore((s) => s.snap?.orders);
  const rows = useMemo(
    () =>
      rowsOf(
        symbols ?? [],
        (orders ?? []).filter((o) => account == null || o.account === account),
        sort,
      ),
    [symbols, orders, sort, account],
  );
  const chart = useRef<EChartsType | null>(null);
  const top = useRef(0); // first visible row, kept across updates
  const live = useRef({ rows, range, onRange, onSelect, span: 0, n: 0 });
  live.current.rows = rows;
  live.current.range = range;
  live.current.onRange = onRange;
  live.current.onSelect = onSelect;

  // a new ordering or account starts at the top
  useEffect(() => {
    top.current = 0;
  }, [sort, account]);

  /** Builds and applies the whole option (base settings, axes, zoom, data) on the live instance. Runs
   *  after every React render, right after init and after every resize, so a fresh or re-created
   *  instance never waits for the next data tick, and setOption's synchronous flush repaints even
   *  where requestAnimationFrame is paused (background tabs). */
  const render = () => {
    const c = chart.current;
    if (!c || c.isDisposed()) return;
    const size = { w: c.getWidth(), h: c.getHeight() };
    if (!size.h || !size.w) return;
    const n = rows.length;
    const avail = Math.max(ROW_H, size.h - TOP - BOTTOM);
    const fit = Math.max(1, Math.floor(avail / ROW_H));
    const scroll = n > fit;
    const span = scroll ? fit : Math.max(n, 1);
    const plotH = scroll ? avail : Math.min(avail, span * ROW_MAX);
    const bottom = size.h - TOP - plotH;
    top.current = Math.max(0, Math.min(top.current, n - span));
    live.current.span = span;
    live.current.n = n;

    const right = SLIDER + (scroll ? 6 : 0);
    const invLeft = size.w - right - INV_LABEL - INV_W;
    const names = rows.map((r) => short(r.sym.symbol));
    const invs = rows.map((r) => r.sym.inv_value);
    const invLo = Math.min(0, ...invs);
    const invHi = Math.max(0, ...invs);
    const invPad = Math.max(50, invHi - invLo) - (invHi - invLo);
    const half = range >= 10 ? Math.max(5, Math.floor(range / 10) * 5) : range / 2;
    const ticks = [-range, -half, 0, half, range];

    const market: number[][] = [];
    const bids: object[] = [];
    const asks: object[] = [];
    rows.forEach((r, i) => {
      const s = r.sym;
      const fair = s.fair ?? s.mid;
      if (!fair) return;
      if (s.bid && s.ask) market.push([clamp(off(s.bid, fair), range), clamp(off(s.ask, fair), range), i]);
      for (const o of r.orders) {
        const b = off(o.price, fair);
        const out = Math.abs(b) > range;
        const through = o.dist_bps != null && o.dist_bps < 0;
        const item = {
          value: [clamp(b, range), i],
          symbol: out ? "triangle" : "circle",
          symbolRotate: out ? (b > 0 ? -90 : 90) : 0,
          // a ring needs room inside it for the side colour
          symbolSize: out ? 8 : Math.max(through ? 8 : 5, Math.min(11, Math.sqrt(o.notional / 60) * 5.6)),
          itemStyle: {
            opacity: out ? 0.55 : 0.9,
            borderColor: through ? C.warn : "transparent",
            borderWidth: through ? 1.5 : 0,
          },
        };
        (o.side === "buy" ? bids : asks).push(item);
      }
    });

    const label = (sel: boolean, has: boolean) => (sel ? "sel" : has ? "on" : "off");
    const yAxis = (gridIndex: number) => ({
      id: `y${gridIndex}`,
      gridIndex,
      type: "category" as const,
      inverse: true,
      data: names,
      axisLine: { show: false },
      axisTick: { show: false },
      axisPointer: {
        type: "shadow" as const,
        shadowStyle: { color: "rgba(126,166,246,0.07)" },
      },
    });

    c.setOption({
      animation: false,
      textStyle: { fontFamily: SANS },
      axisPointer: { link: [{ yAxisIndex: "all" }] },
      tooltip: {
        trigger: "axis",
        axisPointer: { type: "shadow", axis: "y" },
        className: "qmap-etip",
        backgroundColor: C.raised,
        borderColor: C.rule,
        borderWidth: 1,
        padding: [6, 6],
        extraCssText: "width:300px;box-shadow:0 4px 14px rgba(0,0,0,0.35);border-radius:4px",
        textStyle: { color: C.ink, fontSize: 11.5, fontFamily: SANS },
        transitionDuration: 0,
        confine: true,
        formatter: (ps: any) => {
          const p = Array.isArray(ps) ? ps[0] : ps;
          const r = p && live.current.rows.find((x) => short(x.sym.symbol) === p.axisValue);
          return r ? tipHtml(r) : "";
        },
      },
      grid: [
        {
          id: "map",
          left: LEFT,
          right: size.w - invLeft + GAP,
          top: TOP,
          bottom,
        },
        {
          id: "inv",
          left: invLeft,
          right: right + INV_LABEL,
          top: TOP,
          bottom,
        },
      ],
      xAxis: [
        {
          id: "x0",
          gridIndex: 0,
          type: "value",
          position: "top",
          min: -range,
          max: range,
          axisLine: { show: false },
          axisTick: { show: false, customValues: ticks },
          axisLabel: {
            customValues: ticks,
            color: C.muted,
            fontSize: 10.5,
            fontFamily: SANS,
            margin: 6,
            alignMinLabel: "left",
            alignMaxLabel: "right",
            formatter: (v: number) => tick(v, range),
          },
          splitLine: { lineStyle: { color: "#161b22" } },
        },
        {
          id: "x1",
          gridIndex: 1,
          type: "value",
          position: "top",
          min: invLo,
          max: invHi + invPad,
          axisLine: { show: false },
          axisTick: { show: false },
          axisLabel: { show: false },
          splitLine: { show: false },
          name: "Inventory",
          nameLocation: "end",
          nameGap: 6,
          nameTextStyle: {
            color: C.muted,
            fontSize: 10.5,
            fontFamily: SANS,
            align: "right",
            verticalAlign: "bottom",
            padding: [0, -INV_LABEL, 6, 0],
          },
        },
      ],
      yAxis: [
        {
          ...yAxis(0),
          splitArea: {
            show: true,
            areaStyle: { color: ["transparent", "rgba(255,255,255,0.025)"] },
          },
          axisLabel: {
            margin: 8,
            align: "left",
            padding: [0, 0, 0, -LEFT + 10],
            formatter: (v: string, i: number) => `{${label(v === selected, !!rows[i]?.orders.length)}|${v}}`,
            rich: {
              on: {
                color: C.ink,
                fontSize: 11,
                fontWeight: 500,
                fontFamily: SANS,
              },
              off: {
                color: C.muted,
                fontSize: 11,
                fontWeight: 500,
                fontFamily: SANS,
              },
              sel: {
                color: C.accent,
                fontSize: 11,
                fontWeight: 600,
                fontFamily: SANS,
              },
            },
          },
        },
        {
          ...yAxis(1),
          position: "right",
          axisLabel: {
            margin: 6,
            align: "right",
            padding: [0, -INV_LABEL + 2, 0, 0],
            color: C.ink2,
            fontSize: 11,
            fontFamily: SANS,
            formatter: (_: string, i: number) => {
              const v = rows[i]?.sym.inv_value ?? 0;
              return Math.abs(v) >= 1 ? (v < 0 ? MINUS : "") + Math.round(Math.abs(v)).toLocaleString("en-US") : "";
            },
          },
        },
      ],
      dataZoom: [
        {
          id: "yin",
          type: "inside",
          yAxisIndex: [0, 1],
          startValue: top.current,
          endValue: top.current + span - 1,
          zoomOnMouseWheel: false,
          moveOnMouseWheel: true,
          moveOnMouseMove: false,
          disabled: !scroll,
        },
        {
          id: "yslider",
          type: "slider",
          yAxisIndex: [0, 1],
          show: scroll,
          startValue: top.current,
          endValue: top.current + span - 1,
          zoomLock: true,
          right: 0,
          top: TOP,
          bottom,
          width: 6,
          showDetail: false,
          showDataShadow: false,
          brushSelect: false,
          borderColor: "transparent",
          backgroundColor: "rgba(255,255,255,0.03)",
          fillerColor: "rgba(195,202,213,0.22)",
          handleSize: 0,
          handleStyle: { opacity: 0 },
          moveHandleSize: 0,
          emphasis: { handleStyle: { opacity: 0 } },
        },
      ],
      series: [
        {
          id: "market",
          type: "custom",
          xAxisIndex: 0,
          yAxisIndex: 0,
          clip: true,
          silent: true,
          encode: { x: [0, 1], y: 2 },
          data: market,
          renderItem: (_: unknown, api: any) => {
            const row = api.value(2);
            const a = api.coord([api.value(0), row]);
            const b = api.coord([api.value(1), row]);
            const h = Math.min(6, api.size([0, 1])[1] * 0.4);
            const w = Math.max(1.5, b[0] - a[0]);
            const y = a[1] - h / 2;
            return {
              type: "group",
              children: [
                {
                  type: "rect",
                  shape: { x: a[0], y, width: w, height: h },
                  style: { fill: BAND },
                },
                {
                  type: "rect",
                  shape: { x: a[0], y, width: 1, height: h },
                  style: { fill: BAND_EDGE },
                },
                {
                  type: "rect",
                  shape: {
                    x: Math.max(a[0] + 1, b[0] - 1),
                    y,
                    width: 1,
                    height: h,
                  },
                  style: { fill: BAND_EDGE },
                },
              ],
            };
          },
          markLine: {
            silent: true,
            symbol: "none",
            label: { show: false },
            lineStyle: { color: "#3b4453", type: "solid", width: 1 },
            data: [{ xAxis: 0 }],
          },
        },
        {
          id: "bids",
          type: "scatter",
          xAxisIndex: 0,
          yAxisIndex: 0,
          color: C.up,
          data: bids,
          z: 3,
        },
        {
          id: "asks",
          type: "scatter",
          xAxisIndex: 0,
          yAxisIndex: 0,
          color: C.down,
          data: asks,
          z: 3,
        },
        {
          id: "inv",
          type: "bar",
          xAxisIndex: 1,
          yAxisIndex: 1,
          barWidth: "45%",
          barMaxWidth: 9,
          itemStyle: { color: INV_FILL },
          data: rows.map((r) => r.sym.inv_value),
        },
      ],
    });
  };
  const renderRef = useRef(render);
  renderRef.current = render;
  useEffect(render);

  const onInit = (c: EChartsType) => {
    chart.current = c;
    c.on("datazoom", () => {
      // the y axis extent is the visible window of row indices
      const ext = (c as any).getModel().getComponent("yAxis", 0)?.axis?.scale?.getExtent();
      if (ext) top.current = Math.max(0, Math.round(ext[0]));
    });
    // clicks anywhere on a row (name, plot or inventory) pick that symbol
    c.getZr().on("click", (e: any) => {
      const { n } = live.current;
      if (!n || e.offsetX > c.getWidth() - SLIDER - 2 || e.offsetY < TOP) return;
      const v = c.convertFromPixel({ yAxisIndex: 0 }, e.offsetY) as unknown as number;
      const i = Math.round(v);
      const r = live.current.rows[i];
      if (r && i >= top.current && i < top.current + live.current.span) live.current.onSelect(short(r.sym.symbol));
    });
    // ctrl + wheel (and trackpad pinch) widens or narrows the bps range
    const el = c.getDom();
    let acc = 0;
    const wheel = (e: WheelEvent) => {
      if (!e.ctrlKey) return;
      e.preventDefault();
      e.stopPropagation();
      acc += e.deltaY;
      if (Math.abs(acc) < 40) return;
      const cur = live.current.range;
      const next = acc > 0 ? LADDER.find((v) => v > cur) : [...LADDER].reverse().find((v) => v < cur);
      acc = 0;
      if (next != null) live.current.onRange(next);
    };
    el.addEventListener("wheel", wheel, { capture: true, passive: false });
    renderRef.current();
    return () => {
      el.removeEventListener("wheel", wheel, { capture: true });
      if (chart.current === c) chart.current = null;
    };
  };

  return (
    <div className="qmap">
      <EChart onInit={onInit} onResize={() => renderRef.current()} />
    </div>
  );
}
