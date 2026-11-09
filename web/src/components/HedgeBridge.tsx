import { useElementSize } from "@mantine/hooks";
import { pnl } from "../format";
import { C } from "../theme";
import type { HedgeDay, HedgeTrack, PnlSummary } from "../protocol";
import { cur } from "../desk";

const ROW_H = 26;
const BAR_H = 14;
const PAD = 12;
const LABEL_W = 120 + PAD;
const VALUE_W = 96 + PAD;

/** A bar of the bridge: from `from` by `v`; `total` is the figure printed at the right. */
export interface BridgeRow {
  label: string;
  from: number;
  v: number;
  total: number | null;
  title?: string;
}

/** The hedge against the engine's target: what a hedge held at it would have made, then each part of the gap to
 *  what the hedge made. */
export function trackRows(t: HedgeTrack): BridgeRow[] {
  const h = Math.round(t.horizon_s);
  const parts: [string, number, string][] = [
    ["Position lag", t.lag, "The hedge's position away from the target as the hedge instrument moved"],
    ["Fill markout", t.fill_markout, `The hedge's fills against the mid ${h} s after each`],
    ["Funding", t.funding, "Funding paid or received by the hedge legs"],
    ["Fees", -t.fees, "The hedge legs' trading fees"],
  ];
  const rows: BridgeRow[] = [{ label: "At target", from: 0, v: t.ideal, total: t.ideal, title: "What a hedge held at the engine's target all day would have made, at mid" }];
  let at = t.ideal;
  for (const [label, v, title] of parts) {
    rows.push({ label, from: at, v, total: v, title });
    at += v;
  }
  rows.push({ label: "Hedge", from: 0, v: t.actual, total: t.actual, title: "What the hedge made: price at mid, plus funding, minus fees" });
  return rows;
}

/** The Inventory PnL (holding, on its own mid) today, in its parts: the beta factor, each name beyond it, and each name's
 *  own mid against its reference. */
export function inventoryRows(p: PnlSummary): BridgeRow[] {
  const parts: [string, number, string][] = [
    ["Factor", p.factor_part, "Each name's beta times the beta instrument's move"],
    ["Single-name", p.single_name, "Each name's reference (its perp) beyond the factor"],
    ["Basis", p.basis, "Each name's own mid against its reference"],
  ];
  const rows: BridgeRow[] = [];
  let at = 0;
  for (const [label, v, title] of parts) {
    rows.push({ label, from: at, v, total: v, title });
    at += v;
  }
  rows.push({ label: "Inventory", from: 0, v: p.holding, total: p.holding, title: "Inventory PnL: what the held inventory made after the first 60 s of each fill, on its own mid" });
  return rows;
}

/** Without an engine's target: the inventory, the hedge legs and the net. */
export function plainRows(h: HedgeDay, inventory: number): BridgeRow[] {
  const hedge = h.hedge_pnl ?? 0;
  const net = inventory + hedge;
  return [
    { label: "Inventory PnL", from: 0, v: inventory, total: inventory },
    { label: "Hedge", from: inventory, v: hedge, total: h.hedge_pnl },
    { label: "Net", from: 0, v: net, total: net },
  ];
}

/** 1 − the inventory's hourly SD with the hedge over it alone: how much of the inventory's risk the hedge took. */
export function riskCut(t: HedgeTrack | null): number | null {
  return t?.sd_alone != null && t.sd_hedged != null && t.sd_alone > 1e-9 ? 1 - t.sd_hedged / t.sd_alone : null;
}

export function riskTitle(t: HedgeTrack, hide: boolean): string {
  const v = (x: number | null) => (hide ? "**" : x == null ? "--" : x.toFixed(1));
  return `Standard deviation of the inventory's P&L per hour, over today's ${t.hours} whole hours: ${v(t.sd_alone)} ${cur()} alone, ${v(t.sd_hedged)} with the hedge`;
}

/** Bars on one axis with 0 in it, each figure at the right. */
export function HedgeBridge({ rows, label }: { rows: BridgeRow[]; label: string }) {
  const { ref, width } = useElementSize();
  const pts = [0, ...rows.flatMap((r) => [r.from, r.from + r.v])];
  const lo = Math.min(...pts);
  const span = Math.max(Math.max(...pts) - lo, 1e-9);
  const plotW = Math.max(40, width - LABEL_W - VALUE_W);
  const X = (v: number) => LABEL_W + ((v - lo) / span) * plotW;
  const height = rows.length * ROW_H;

  return (
    <div ref={ref} className="bridge">
      {width > 0 && (
        <svg width={width} height={height} style={{ display: "block" }} role="img" aria-label={label}>
          <line x1={X(0)} x2={X(0)} y1={0} y2={height} stroke={C.rule} />
          {rows.map((r, i) => {
            const y = i * ROW_H + (ROW_H - BAR_H) / 2;
            const a = X(r.from);
            const b = X(r.from + r.v);
            return (
              <g key={r.label}>
                {r.title && <title>{r.title}</title>}
                <text x={PAD} y={y + BAR_H - 2} className="bridge-label">
                  {r.label}
                </text>
                <rect x={Math.min(a, b)} y={y} width={Math.max(1, Math.abs(b - a))} height={BAR_H} rx={2} fill={r.v >= 0 ? C.up : C.down} />
                <text x={width - PAD} y={y + BAR_H - 2} textAnchor="end" className="bridge-value fig">
                  {pnl(r.total)}
                  <tspan className="bridge-unit"> {cur()}</tspan>
                </text>
              </g>
            );
          })}
        </svg>
      )}
    </div>
  );
}
