// Fills on a kline chart: per bar and side, one small circle at our VWAP (owner rule), and the legend's
// `Fills B3 @ 2,480.64 · S1 @ 2,481.55`.
import { price as fmtPrice } from "../../format";
import { DOWN, UP, C } from "./palette";
import type { ExMarker } from "./ExChart";
import { barStart, type KInterval } from "./klines";

/** A fill from the snapshot (`ts`) or from /api/fills (`t`). */
export interface FillLike {
  side: "buy" | "sell";
  price: number;
  qty: number;
  t?: number;
  ts?: number;
}

export interface BarFills {
  buys: number;
  buyQty: number;
  buyVwap: number | null;
  sells: number;
  sellQty: number;
  sellVwap: number | null;
}

/** Fills grouped by the start of the bar they fall in (ms). `interval` is an interval name or a bar size in ms. */
export function fillsByBar(fills: readonly FillLike[], interval: KInterval | number): Map<number, BarFills> {
  const acc = new Map<number, { b: number; bq: number; bn: number; s: number; sq: number; sn: number }>();
  for (const f of fills) {
    const t = f.t ?? f.ts;
    if (t == null || !(f.qty > 0)) continue;
    const k = barStart(t, interval);
    let a = acc.get(k);
    if (!a) acc.set(k, (a = { b: 0, bq: 0, bn: 0, s: 0, sq: 0, sn: 0 }));
    if (f.side === "buy") {
      a.b++;
      a.bq += f.qty;
      a.bn += f.qty * f.price;
    } else {
      a.s++;
      a.sq += f.qty;
      a.sn += f.qty * f.price;
    }
  }
  const out = new Map<number, BarFills>();
  for (const [k, a] of [...acc.entries()].sort((x, y) => x[0] - y[0]))
    out.set(k, {
      buys: a.b,
      buyQty: a.bq,
      buyVwap: a.bq > 0 ? a.bn / a.bq : null,
      sells: a.s,
      sellQty: a.sq,
      sellVwap: a.sq > 0 ? a.sn / a.sq : null,
    });
  return out;
}

/**
 * Markers for ExChart: per bar per side at most one small circle at our VWAP (`atPriceMiddle`), buys in the up
 * colour, sells in the down colour, no text. ExChart hides all markers while bars are under 5 px apart.
 * `series` is the key of the candle (or line) series they sit on; `key` the chip/legend key that hides them.
 */
export function fillMarkers(byBar: Map<number, BarFills>, series: string, key = "fills"): ExMarker[] {
  const out: ExMarker[] = [];
  for (const [t, f] of byBar) {
    if (f.buyVwap != null) out.push({ series, key, time: t, price: f.buyVwap, color: UP, shape: "circle", size: 0.6 });
    if (f.sellVwap != null) out.push({ series, key, time: t, price: f.sellVwap, color: DOWN, shape: "circle", size: 0.6 });
  }
  return out;
}

/** The legend / value-box text for a bar's fills: `B3 @ 2,480.64 · S1 @ 2,481.55`, or `0`; coloured by the
 *  bigger side. `fmt` formats a price (default format.price). */
export function fillsText(f: BarFills | undefined, fmt: (v: number) => string = fmtPrice): [string, string] {
  if (!f || (!f.buys && !f.sells)) return ["0", C.muted];
  const b = f.buys ? `B${f.buys} @ ${fmt(f.buyVwap!)}` : "";
  const s = f.sells ? `S${f.sells} @ ${fmt(f.sellVwap!)}` : "";
  return [[b, s].filter(Boolean).join(" · "), f.buyQty >= f.sellQty ? UP : DOWN];
}

/** Short form for the touch value box: `B3 S1`. */
export function fillsShort(f: BarFills | undefined): string {
  if (!f || (!f.buys && !f.sells)) return "0";
  return [f.buys ? `B${f.buys}` : "", f.sells ? `S${f.sells}` : ""].filter(Boolean).join(" ");
}
