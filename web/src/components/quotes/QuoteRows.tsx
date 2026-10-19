// The light quote map: plain canvas, no chart library. One row per instrument, x in bps from fair (the centre
// line): the market's bid–ask as a grey band, our bids and asks as dots (area ~ notional against the largest
// order shown; a separate amber ring around an order through fair; a faded triangle on the edge when beyond
// the range), a missing side as an empty ring at the market's best price there, a row's status at the right
// of the plot (Not quoted, Wide), and optionally the inventory value as a neutral bar
// at the right. Redrawn on each store update (its live motion), at most once a frame.
import { useEffect, useLayoutEffect, useRef, useState, type MouseEvent } from "react";
import { C, SANS } from "../../theme";
import { MINUS } from "../../format";
import { BAND, BAND_EDGE, DOT_MAX, INV_FILL, THROUGH_GAP, clamp, dotSize, maxNotional, missingSide, off, rowStatus, short, wideCut, type QRow } from "./model";
import { MASK, useHide } from "../../mask";

export interface QuoteRowsProps {
  rows: readonly QRow[];
  /** Half-width of the x axis, bps. */
  range: number;
  /** Row pitch, px. */
  rowH?: number;
  /** Width of the symbol column, px; 0 hides it (the single-row band). */
  label?: number;
  /** The inventory value column at the right. */
  inv?: boolean;
  /** The bps ticks above the rows (18 px). */
  axis?: boolean;
  /** The symbol drawn in the accent colour (short form, `BTC`). */
  selected?: string;
  /** A tap or click on a row. */
  onRow?: (r: QRow) => void;
  /** Text when there are no rows. */
  empty?: string;
  /** Each row's status at the right of the plot: Not quoted, Wide (default on). */
  status?: boolean;
  /** The ticks stay under the page's top bar while a long map scrolls by (the phone's full map). */
  stickyAxis?: boolean;
  className?: string;
}

const AXIS_H = 18;
// the inventory column: bar, then figure (narrower on a phone-wide map)
const invW = (w: number) => (w < 520 ? 26 : 44);
const invTxt = (w: number) => (w < 520 ? 34 : 44);
const PAD = 8;

const tick = (v: number, r: number) => (v === 0 ? "fair" : (v > 0 ? "+" : MINUS) + Math.abs(v) + (v === r ? " bps" : ""));

/**
 * The quote map drawn on a canvas, `rows.length × rowH` (+ 18 px of ticks) tall, as wide as its parent. Cheap
 * enough for the phone: the mini map on the Desk, the full map in Markets, the band on an instrument page.
 */
export function QuoteRows({ rows, range, rowH = 28, label = 64, inv = false, axis = true, selected, onRow, empty, status = true, stickyAxis = false, className }: QuoteRowsProps) {
  const box = useRef<HTMLDivElement>(null);
  const cv = useRef<HTMLCanvasElement>(null);
  const ax = useRef<HTMLCanvasElement>(null);
  const split = axis && stickyAxis;
  const [w, setW] = useState(0);
  const top = axis ? AXIS_H : 0;
  const h = top + Math.max(1, rows.length) * rowH;
  // Hide amounts: the inventory column reads ••• with no bars
  const hide = useHide();
  const live = useRef({ rows, range, rowH, label, inv, top, selected, w, h, empty, hide, status, part: "all" as Part });
  live.current = { rows, range, rowH, label, inv, top, selected, w, h, empty, hide, status, part: "all" };

  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setW(Math.floor(el.clientWidth)));
    ro.observe(el);
    setW(Math.floor(el.clientWidth));
    return () => ro.disconnect();
  }, []);

  // one draw a frame, whatever the number of updates in it
  const raf = useRef(0);
  useLayoutEffect(() => {
    if (raf.current) return;
    raf.current = requestAnimationFrame(() => {
      raf.current = 0;
      const p = live.current;
      if (!split) {
        if (cv.current) draw(cv.current, p);
        return;
      }
      // the ticks on their own sticky canvas, the rows under them
      if (ax.current) draw(ax.current, { ...p, h: AXIS_H, part: "axis" });
      if (cv.current) draw(cv.current, { ...p, top: 0, h: p.h - AXIS_H, part: "rows" });
    });
  });
  useEffect(
    () => () => {
      cancelAnimationFrame(raf.current);
      raf.current = 0;
    },
    [],
  );

  const onClick = onRow
    ? (e: MouseEvent<HTMLCanvasElement>) => {
        const r = e.currentTarget.getBoundingClientRect();
        const i = Math.floor((e.clientY - r.top - top) / rowH);
        const row = rows[i];
        if (row) onRow(row);
      }
    : undefined;

  if (split)
    return (
      <div ref={box} className={"qrows" + (className ? " " + className : "")} style={{ height: h }}>
        <div className="qrows-axis" style={{ height: AXIS_H }}>
          <canvas ref={ax} style={{ width: w, height: AXIS_H, display: "block" }} />
        </div>
        <canvas ref={cv} style={{ width: w, height: h - AXIS_H, display: "block", cursor: onRow ? "pointer" : undefined }} onClick={onClick} />
      </div>
    );
  return (
    <div ref={box} className={"qrows" + (className ? " " + className : "")} style={{ height: h }}>
      <canvas ref={cv} style={{ width: w, height: h, cursor: onRow ? "pointer" : undefined }} onClick={onClick} />
    </div>
  );
}

/** What a canvas holds: everything, the ticks only (the sticky axis), or the rows only (under it). */
type Part = "all" | "axis" | "rows";

function draw(
  cv: HTMLCanvasElement,
  p: { rows: readonly QRow[]; range: number; rowH: number; label: number; inv: boolean; top: number; selected?: string; w: number; h: number; empty?: string; hide: boolean; status: boolean; part: Part },
) {
  const { rows, range, rowH, label, inv, top, w, h } = p;
  if (!w) return;
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  if (cv.width !== Math.round(w * dpr) || cv.height !== Math.round(h * dpr)) {
    cv.width = Math.round(w * dpr);
    cv.height = Math.round(h * dpr);
  }
  const g = cv.getContext("2d");
  if (!g) return;
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.clearRect(0, 0, w, h);
  g.textBaseline = "middle";

  const x0 = label ? label + PAD : PAD / 2;
  const INV_W = invW(w);
  const INV_TXT = invTxt(w);
  const x1 = w - (inv ? INV_W + INV_TXT + PAD * 2 : PAD / 2);
  const span = Math.max(10, x1 - x0);
  const xOf = (bps: number) => x0 + ((clamp(bps, range) + range) / (2 * range)) * span;
  const half = range >= 10 ? Math.max(5, Math.floor(range / 10) * 5) : range / 2;
  const ticks = [-range, -half, 0, half, range];

  // ticks and their grid lines
  g.font = `400 11px ${SANS}`;
  for (const v of ticks) {
    const x = Math.round(xOf(v)) + 0.5;
    if (v !== 0) {
      g.fillStyle = "#161b22";
      g.fillRect(x - 0.5, top, 1, h - top);
    }
  }
  if (top) {
    // the labels' extents: the ends and fair always, the half ticks only with 8 px clear on both sides of both
    // (one dropped and not the other reads as a lopsided scale)
    const lab = ticks.map((v) => {
      const t = tick(v, range);
      const tw = g.measureText(t).width;
      const x = v === -range ? x0 : v === range ? x1 : xOf(v);
      const a = v === -range ? x : v === range ? x - tw : x - tw / 2;
      return { v, t, x, a, b: a + tw, align: (v === -range ? "left" : v === range ? "right" : "center") as CanvasTextAlign };
    });
    const crowded = lab.some((l, i) => {
      if (Math.abs(l.v) !== half || l.v === 0 || half === range) return false;
      const prev = lab[i - 1];
      const next = lab[i + 1];
      return (prev && l.a < prev.b + 8) || (next && l.b > next.a - 8);
    });
    g.fillStyle = C.muted;
    lab.forEach((l) => {
      if (crowded && Math.abs(l.v) === half && l.v !== 0 && half !== range) return;
      g.textAlign = l.align;
      g.fillText(l.t, l.x, top / 2);
    });
  }
  if (inv && top) {
    g.textAlign = "right";
    g.fillText(w < 520 ? "USDT" : "Inventory (USDT)", w - PAD / 2, top / 2);
  }
  if (p.part === "axis") return;

  if (!rows.length) {
    g.fillStyle = C.muted;
    g.font = `400 12px ${SANS}`;
    g.textAlign = "center";
    g.fillText(p.empty ?? "No quoted instruments", (x0 + x1) / 2, top + rowH / 2);
    return;
  }

  // fair, under the rows' marks
  g.fillStyle = "#3b4453";
  g.fillRect(Math.round(xOf(0)), top, 1, h - top);

  // inventory scale
  let invLo = 0;
  let invHi = 0;
  if (inv) for (const r of rows) (invLo = Math.min(invLo, r.sym.inv_value)), (invHi = Math.max(invHi, r.sym.inv_value));
  const invSpan = Math.max(50, invHi - invLo);
  const ix0 = w - PAD / 2 - INV_TXT - INV_W;
  const ixOf = (v: number) => ix0 + ((v - invLo) / invSpan) * INV_W;
  const cut = wideCut(rows);
  const maxN = maxNotional(rows);

  rows.forEach((r, i) => {
    const y0 = top + i * rowH;
    const yc = y0 + rowH / 2;
    if (i % 2 === 1) {
      g.fillStyle = "rgba(255,255,255,0.025)";
      g.fillRect(0, y0, w, rowH);
    }
    const s = r.sym;
    const name = short(s.symbol);
    if (label) {
      g.font = `500 12px ${SANS}`;
      g.textAlign = "left";
      g.fillStyle = name === p.selected ? C.accent : r.orders.length ? C.ink : C.muted;
      g.fillText(name, 0, yc, label);
    }
    // the row's status at the right of the plot, under the marks (an order out there stays on top)
    const st = p.status ? rowStatus(r, cut) : null;
    if (st) {
      g.font = `400 11px ${SANS}`;
      g.textAlign = "right";
      g.fillStyle = st === "Wide" ? C.ink2 : C.muted;
      g.fillText(st, x1 - 2, yc);
    }
    const fair = s.fair ?? s.mid;
    if (fair) {
      // market bid–ask
      if (s.bid && s.ask) {
        const a = xOf(off(s.bid, fair));
        const b = xOf(off(s.ask, fair));
        const bh = Math.min(6, rowH * 0.4);
        const bw = Math.max(1.5, b - a);
        g.fillStyle = BAND;
        g.fillRect(a, yc - bh / 2, bw, bh);
        g.fillStyle = BAND_EDGE;
        g.fillRect(a, yc - bh / 2, 1, bh);
        g.fillRect(Math.max(a + 1, b - 1), yc - bh / 2, 1, bh);
      }
      // a missing side: an empty ring in its colour at the market's best price on that side
      const miss = missingSide(r);
      if (miss) {
        // filled with the ground, so the band's edge does not run through it
        g.fillStyle = C.ground;
        g.strokeStyle = miss.side === "buy" ? C.up : C.down;
        g.lineWidth = 1.25;
        g.beginPath();
        g.arc(xOf(miss.bps), yc, Math.min(DOT_MAX, rowH - 4) / 2, 0, Math.PI * 2);
        g.fill();
        g.stroke();
      }
      // our orders: the larger first, so a small one stays visible on top
      const os = r.orders.slice().sort((x, y) => y.notional - x.notional);
      for (const o of os) {
        const bps = off(o.price, fair);
        const out = Math.abs(bps) > range;
        const through = o.dist_bps != null && o.dist_bps < 0;
        const col = o.side === "buy" ? C.up : C.down;
        const x = xOf(bps);
        if (out) {
          g.globalAlpha = 0.55;
          g.fillStyle = col;
          g.beginPath();
          const d = bps > 0 ? 1 : -1;
          g.moveTo(x + d * 4, yc);
          g.lineTo(x - d * 3, yc - 4);
          g.lineTo(x - d * 3, yc + 4);
          g.closePath();
          g.fill();
          g.globalAlpha = 1;
          continue;
        }
        const rad = Math.min(dotSize(o.notional, maxN), rowH - 4 - 2 * THROUGH_GAP) / 2;
        g.globalAlpha = 0.9;
        g.fillStyle = col;
        g.beginPath();
        g.arc(x, yc, rad, 0, Math.PI * 2);
        g.fill();
        g.globalAlpha = 1;
        if (through) {
          // a ring clear of the dot: "through fair" whatever the order's size
          g.strokeStyle = C.warn;
          g.lineWidth = 1.25;
          g.beginPath();
          g.arc(x, yc, rad + THROUGH_GAP, 0, Math.PI * 2);
          g.stroke();
        }
      }
    }
    if (inv) {
      const v = s.inv_value;
      const a = ixOf(0);
      const b = ixOf(v);
      g.fillStyle = INV_FILL;
      if (!p.hide && Math.abs(v) >= 1) g.fillRect(Math.min(a, b), yc - Math.min(4.5, rowH * 0.22), Math.max(1, Math.abs(b - a)), Math.min(9, rowH * 0.45));
      // hidden: every row reads the same (a blank one would tell it holds nothing)
      if (Math.abs(v) >= 1 || p.hide) {
        g.font = `400 11px ${SANS}`;
        g.textAlign = "right";
        g.fillStyle = p.hide ? C.muted : C.ink2;
        g.fillText(p.hide ? MASK : (v < 0 ? MINUS : "") + Math.round(Math.abs(v)).toLocaleString("en-US"), w - PAD / 2, yc);
      }
    }
  });

}
