import { useEffect, useMemo, useRef } from "react";
import type { Venue } from "../protocol";
import { useStore } from "../store";
import { C, SANS } from "../theme";
import { bps, MINUS, price, usd } from "../format";
import { MASK, hideNow, maskText, useHide } from "../mask";
import { EChart, phoneDpr, type EChartsType } from "./EChart";
import { BAND, BAND_EDGE, INV_FILL, LADDER, THROUGH_GAP, clamp, dotSize, off, quoteRows, rowStatus, short, sidesOf, wideCut, widthOf, type MapSort, type QRow } from "./quotes/model";

export type { MapSort };

/** One row per instrument, x in bps from fair. The market's bid-ask is a thin bar, own bids and asks
 *  are dots with area ~ notional, orders through fair carry an amber ring, orders beyond the x range
 *  sit on the edge as triangles. Inventory value is a narrow bar column on the right. */

type Row = QRow;

const ROW_H = 17; // target row pitch when the list scrolls
const ROW_MAX = 34; // tallest row when the list fits
const ROW_PHONE = 28; // a phone shows every row at this pitch and the page scrolls
const TOP = 22;
const BOTTOM = 4;
const LEFT = 66;
const INV_W = 56; // inventory bars
const INV_LABEL = 50; // inventory figures right of the bars
const SLIDER = 10;
const GAP = 16;


/** A touch screen drags the rows: there is no wheel and the slider is too thin for a finger. */
const coarse = () => typeof window !== "undefined" && window.matchMedia("(pointer: coarse)").matches;


const tick = (v: number, r: number) => (v === 0 ? "fair" : (v > 0 ? "+" : MINUS) + Math.abs(v) + (v === r ? " bps" : ""));

const TD = "padding:1px 4px";
const TH = "padding:0 4px 2px;font-weight:400;font-size:10.5px";
const R = ";text-align:right";

/** The tip's title suffix: a missing side, or our width. */
function tipStatus(r: Row): string {
  const s = sidesOf(r);
  const t = s === "noask" ? "No ask" : s === "nobid" ? "No bid" : s === "none" ? "Not quoted" : `Width ${bps(widthOf(r), false)} bps`;
  return ` <span class="muted" style="font-weight:400">· ${t}</span>`;
}

function tipHtml(r: Row, hide: boolean): string {
  const s = r.sym;
  const os = [...r.orders].sort((a, b) => b.price - a.price);
  const td = (v: string, cls = "", right = false) => `<td class="${cls}" style="${TD}${right ? R : ""}">${v}</td>`;
  const th = (v: string, right = false) => `<th style="${TH}${right ? R : ";text-align:left"}">${v}</th>`;
  const kv = (k: string, v: string) => `<tr>${td(k, "muted")}${td(v, "", true)}</tr>`;
  const table = (body: string, extra = "") => `<table class="fig" style="width:100%;border-collapse:collapse;${extra}">${body}</table>`;
  const orders = os.length
    ? table(
        `<thead><tr class="muted">${th("Side")}${th("Account")}${th("Price", true)}${th("USDT", true)}${th("bps", true)}</tr></thead><tbody>` +
          os
            .map(
              (o) =>
                "<tr>" +
                td(o.side === "buy" ? "Bid" : "Ask", o.side === "buy" ? "up" : "down") +
                td(o.account) +
                td(price(o.price), "", true) +
                td(maskText(hide, usd(o.notional)), hide ? "masked" : "", true) +
                // signed from fair, as the axis: a bid below it is negative
                td(bps(o.dist_bps == null ? null : o.side === "buy" ? -o.dist_bps : o.dist_bps), o.dist_bps != null && o.dist_bps < 0 ? "warn-text" : "", true) +
                "</tr>",
            )
            .join("") +
          "</tbody>",
      )
    : `<div class="muted" style="padding:0 4px 3px">No resting orders</div>`;
  return (
    `<div style="font-weight:500;padding:0 4px 4px">${short(s.symbol)}${tipStatus(r)}</div>` +
    orders +
    table(
      "<tbody>" +
        kv("Mid", price(s.mid)) +
        kv("Bid", price(s.bid)) +
        kv("Ask", price(s.ask)) +
        kv("Fair", price(s.fair)) +
        kv("Inventory", hide ? MASK : usd(s.inv_value) + " USDT") +
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
  phone = false,
}: {
  range: number;
  onRange: (r: number) => void;
  sort: MapSort;
  account: string | null;
  /** The instrument drawn in the accent colour (full symbol, `BTCUSDT`). */
  selected?: string | null;
  onSelect: (symbol: string, venue: Venue) => void;
  /** Every row at a fixed pitch with the box as tall as the rows (the page scrolls, no zoom or slider), no
   *  tooltip (a tap calls onSelect), canvas at 2× at most. Off: the desktop map. Fixed per mount. */
  phone?: boolean;
}) {
  const symbols = useStore((s) => s.snap?.symbols);
  const orders = useStore((s) => s.snap?.orders);
  // Hide amounts: the inventory column and the tip's notionals read ••• (bars empty)
  const hide = useHide();
  const rows = useMemo(
    () =>
      quoteRows(symbols ?? [], orders ?? [], sort, account),
    [symbols, orders, sort, account],
  );
  const chart = useRef<EChartsType | null>(null);
  const top = useRef(0); // first visible row, kept across updates
  const touch = useRef(coarse()).current;
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
    const scroll = !phone && n > fit;
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
    const rings: object[] = [];
    const status: [number, number, string][] = [];
    const cut = wideCut(rows);
    rows.forEach((r, i) => {
      const st = rowStatus(r, cut);
      if (st) status.push([range, i, st]);
      const s = r.sym;
      const fair = s.fair ?? s.mid;
      if (!fair) return;
      if (s.bid && s.ask) market.push([clamp(off(s.bid, fair), range), clamp(off(s.ask, fair), range), i]);
      for (const o of r.orders) {
        const b = off(o.price, fair);
        const out = Math.abs(b) > range;
        const through = o.dist_bps != null && o.dist_bps < 0;
        const size = out ? 8 : dotSize(o.notional);
        const item = {
          value: [clamp(b, range), i],
          symbol: out ? "triangle" : "circle",
          symbolRotate: out ? (b > 0 ? -90 : 90) : 0,
          symbolSize: size,
          itemStyle: { opacity: out ? 0.55 : 0.9 },
        };
        (o.side === "buy" ? bids : asks).push(item);
        // through fair: a hollow amber ring clear of the dot, whatever its size
        if (through && !out) rings.push({ value: [clamp(b, range), i], symbolSize: size + 2 * THROUGH_GAP + 1.5 });
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
      // a phone taps a row instead (onSelect); the tip would cover the screen
      tooltip: phone ? { show: false, triggerOn: "none" } : {
        trigger: "axis",
        axisPointer: { type: "shadow", axis: "y" },
        className: "qmap-etip",
        backgroundColor: C.raised,
        borderColor: C.rule,
        borderWidth: 1,
        padding: [6, 6],
        extraCssText: "width:300px;box-shadow:none;border-radius:4px",
        textStyle: { color: C.ink, fontSize: 11.5, fontFamily: SANS },
        transitionDuration: 0,
        confine: true,
        formatter: (ps: any) => {
          const p = Array.isArray(ps) ? ps[0] : ps;
          const r = p && live.current.rows.find((x) => short(x.sym.symbol) === p.axisValue);
          return r ? tipHtml(r, hideNow()) : "";
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
            fontSize: 11,
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
            fontSize: 11,
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
            formatter: (v: string, i: number) => `{${label(rows[i]?.sym.symbol === selected, !!rows[i]?.orders.length)}|${v}}`,
            rich: {
              on: {
                color: C.ink,
                fontSize: 12,
                fontWeight: 500,
                fontFamily: SANS,
              },
              off: {
                color: C.muted,
                fontSize: 12,
                fontWeight: 500,
                fontFamily: SANS,
              },
              sel: {
                color: C.accent,
                fontSize: 12,
                fontWeight: 500,
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
              if (Math.abs(v) < 1) return "";
              return hide ? MASK : (v < 0 ? MINUS : "") + Math.round(Math.abs(v)).toLocaleString("en-US");
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
          moveOnMouseMove: touch,
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
          id: "through",
          type: "scatter",
          xAxisIndex: 0,
          yAxisIndex: 0,
          silent: true,
          symbol: "circle",
          itemStyle: { color: "transparent", borderColor: C.warn, borderWidth: 1.25 },
          data: rings,
          z: 2,
        },
        {
          // a row's status at the right of the plot (No ask, No bid, Not quoted, Wide), under the marks
          id: "status",
          type: "custom",
          xAxisIndex: 0,
          yAxisIndex: 0,
          silent: true,
          clip: true,
          encode: { x: 0, y: 1 },
          data: status,
          z: 1,
          renderItem: (params: any, api: any) => {
            const p = api.coord([api.value(0), api.value(1)]);
            const t = status[params.dataIndex]?.[2] ?? "";
            return {
              type: "text",
              x: p[0] - 4,
              y: p[1],
              style: { text: t, fill: t === "Wide" ? C.ink2 : C.muted, font: `400 11px ${SANS}`, align: "right", verticalAlign: "middle" },
            };
          },
        },
        {
          id: "inv",
          type: "bar",
          xAxisIndex: 1,
          yAxisIndex: 1,
          barWidth: "45%",
          barMaxWidth: 9,
          itemStyle: { color: INV_FILL },
          data: rows.map((r) => (hide ? 0 : r.sym.inv_value)),
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
      if (r && i >= top.current && i < top.current + live.current.span) live.current.onSelect(r.sym.symbol, r.sym.venue);
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

  if (phone)
    return (
      <div className="qmap qmap-phone" style={{ height: TOP + BOTTOM + Math.max(1, rows.length) * ROW_PHONE }}>
        <EChart onInit={onInit} onResize={() => renderRef.current()} devicePixelRatio={phoneDpr()} />
      </div>
    );
  return (
    <div className="qmap">
      <EChart onInit={onInit} onResize={() => renderRef.current()} />
    </div>
  );
}
