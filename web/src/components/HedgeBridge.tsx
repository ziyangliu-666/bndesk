import { useElementSize } from "@mantine/hooks";
import { pnl } from "../format";
import { C } from "../theme";
import type { HedgeDay } from "../protocol";

const ROW_H = 26;
const BAR_H = 14;
const PAD = 12;
const LABEL_W = 120 + PAD;
const VALUE_W = 96 + PAD;

/** Today's Inventory PnL (the Desk's), what the hedge legs made, and the net: three bars on one zero-based axis. */
export function HedgeBridge({ h, inventory }: { h: HedgeDay; inventory: number }) {
  const { ref, width } = useElementSize();
  const hedge = h.hedge_pnl ?? 0;
  const net = inventory + hedge;
  const rows = [
    { label: "Inventory PnL", from: 0, v: inventory, total: inventory },
    { label: "Hedge", from: inventory, v: hedge, total: h.hedge_pnl },
    { label: "Net", from: 0, v: net, total: net },
  ];
  const pts = [0, ...rows.flatMap((r) => [r.from, r.from + r.v])];
  const lo = Math.min(...pts);
  const span = Math.max(Math.max(...pts) - lo, 1e-9);
  const plotW = Math.max(40, width - LABEL_W - VALUE_W);
  const X = (v: number) => LABEL_W + ((v - lo) / span) * plotW;
  const height = rows.length * ROW_H;

  return (
    <div ref={ref} className="bridge">
      {width > 0 && (
        <svg width={width} height={height} style={{ display: "block" }} role="img" aria-label="Inventory PnL, hedge and net today">
          {rows.map((r, i) => {
            const y = i * ROW_H + (ROW_H - BAR_H) / 2;
            const a = X(r.from);
            const b = X(r.from + r.v);
            return (
              <g key={r.label}>
                <text x={PAD} y={y + BAR_H - 2} className="bridge-label">
                  {r.label}
                </text>
                <rect x={Math.min(a, b)} y={y} width={Math.max(1, Math.abs(b - a))} height={BAR_H} rx={2} fill={r.v >= 0 ? C.up : C.down} />
                <text x={width - PAD} y={y + BAR_H - 2} textAnchor="end" className="bridge-value fig">
                  {pnl(r.total)}
                  <tspan className="bridge-unit"> USDT</tspan>
                </text>
              </g>
            );
          })}
        </svg>
      )}
    </div>
  );
}
