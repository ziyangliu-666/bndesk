import { useMemo, useState, type PointerEvent } from "react";
import { useElementSize } from "@mantine/hooks";
import { IconChevronDown } from "@tabler/icons-react";
import { useStore } from "../../store";
import { useThrottled } from "../../hooks";
import { bps, int } from "../../format";
import { refLabel } from "../../components/ui";
import { InfoLabel, ListRow, Money, Section, Tag, tone } from "../../components/mobile";
import type { SymbolRow } from "../../protocol";
import { MkTable, type MkRowData } from "./shared";
import "./history.css";

const MK_TIP =
  "Markout at h: side × (mid(t+h) / price − 1); net subtracts the reference's move from τ = 1 s or 0.2 s after the fill. " +
  "Notional-weighted over today's fills. A diagnostic, not PnL. bps.";
const EDGE_TIP =
  "Edge is the edge at the fill: side × (fair − price) / fair, notional-weighted over the spot fills the desk holds for today " +
  "(the latest 2,000). It does not depend on the reference, so the Net 0.2 s and Raw rows leave it out.";
const TOX_DEF =
  "Toxicity: how far the reference moved against the fill from 5 s before it to h after it, −side × (ref(t+h) / ref(t−5 s) − 1), " +
  "weighted by notional over today's fills with a reference. Positive = the reference moved against us. A rise between 0 and 0.2 s is a " +
  "price jump that picked off the quote before any hedge could trade.";

/** Markouts: the horizon summary, toxicity behind a disclosure, by UTC hour, then by instrument. */
export function MarkoutsM() {
  const mk = useThrottled(useStore((s) => s.snap?.markouts), 1000);
  const fills = useThrottled(useStore((s) => s.snap?.fills), 1000);
  const symbols = useThrottled(useStore((s) => s.snap?.symbols), 1000);

  // edge at the fill, all spot fills held and per side
  const edge = useMemo(() => {
    const acc = { all: [0, 0], buy: [0, 0], sell: [0, 0] } as Record<"all" | "buy" | "sell", [number, number]>;
    for (const f of fills ?? []) {
      if (f.venue !== "spot" || f.edge_bps == null) continue;
      for (const k of ["all", f.side] as const) {
        acc[k][0] += f.edge_bps * f.notional;
        acc[k][1] += f.notional;
      }
    }
    const v = (k: "all" | "buy" | "sell") => (acc[k][1] > 0 ? acc[k][0] / acc[k][1] : null);
    return { all: v("all"), buy: v("buy"), sell: v("sell") };
  }, [fills]);

  if (!mk) return null;
  const rows: MkRowData[] = [
    { label: "Net 1 s", info: "All fills, net of the reference move from 1 s after the fill.", edge: edge.all, v: mk.all },
    { label: "Buys", info: "Buys only, net 1 s.", edge: edge.buy, v: mk.buys },
    { label: "Sells", info: "Sells only, net 1 s.", edge: edge.sell, v: mk.sells },
    { label: "Net 0.2 s", info: "All fills, net of the reference move from 0.2 s after the fill.", v: mk.fast },
    { label: "Raw", info: "All fills, against the instrument's own mid only.", v: mk.raw },
  ];

  return (
    <>
      <Section title="By horizon" info={`${MK_TIP}\n\n${EDGE_TIP}`}>
        <MkTable rows={rows} horizons={mk.horizons} />
        <Toxicity tox={mk.toxicity} />
      </Section>

      <Section
        title="By UTC hour"
        info="Markout 10 s after the fill, net 1 s, notional-weighted over each UTC hour's fills today; hours without fills are left out. Tap or drag across the bars for an hour's figures. PnL 60 s is the 60 s markout × notional, USDT: a diagnostic, not PnL."
        right="10 s, bps"
      >
        <HourBars hours={mk.by_hour} />
      </Section>

      <ByInstrument rows={symbols ?? []} />
    </>
  );
}

function Toxicity({ tox }: { tox: { horizons_s: number[]; bps: (number | null)[]; fills: number[] } }) {
  const [open, setOpen] = useState(false);
  // its own horizons (from the fill on), written as By horizon writes them
  const at = (h: number) => `${h} s`;
  return (
    <>
      <button type="button" className="m-disc" aria-expanded={open} onClick={() => setOpen(!open)}>
        Toxicity
        <span className="m-disc-right">from 5 s before the fill</span>
        <IconChevronDown size={18} stroke={1.75} />
      </button>
      {open && (
        <div className="m-disc-body m-mk-wrap">
          <table className="m-mk">
            <thead>
              <tr>
                <th scope="col">bps</th>
                {tox.horizons_s.map((h) => (
                  <th key={h} scope="col">
                    {at(h)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              <tr>
                <th scope="row">
                  <InfoLabel label="Against us" info={TOX_DEF} />
                </th>
                {tox.bps.map((v, i) => (
                  <td key={i} className={tone(v, bps(v))}>
                    {bps(v)}
                  </td>
                ))}
              </tr>
              <tr className="sub">
                <th scope="row">
                  <InfoLabel label="Fills" info="Fills with a reference price at h." />
                </th>
                {tox.fills.map((v, i) => (
                  <td key={i}>{int(v)}</td>
                ))}
              </tr>
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}

type Hour = { hour: number; fills: number; mk10: number | null; mk60: number | null; pnl: number };

/** One bar per UTC hour with fills: the 10 s markout, from a zero line. The readout follows a tap or a drag,
 *  and shows the latest hour otherwise. */
function HourBars({ hours }: { hours: Hour[] }) {
  const xs = useMemo(() => hours.filter((h) => h.fills > 0).sort((a, b) => a.hour - b.hour), [hours]);
  // the chosen hour, by its number: it stays put when a new hour's bar appears
  const [sel, setSel] = useState<number | null>(null);
  const { ref, width } = useElementSize<HTMLDivElement>();
  if (!xs.length) return <div className="m-empty">No fills today</div>;
  const H = 132;
  const AX = 18; // hour labels
  const plotH = H - AX;
  let lo = 0;
  let hi = 0;
  for (const h of xs) {
    lo = Math.min(lo, h.mk10 ?? 0);
    hi = Math.max(hi, h.mk10 ?? 0);
  }
  if (hi === lo) hi = lo + 1;
  const pad = (hi - lo) * 0.08;
  const a = lo < 0 ? lo - pad : 0;
  const b = hi > 0 ? hi + pad : 0;
  const y = (v: number) => ((b - v) / (b - a || 1)) * plotH;
  const n = xs.length;
  const cw = width / n;
  const bw = Math.max(2, Math.min(18, cw * 0.62));
  const cur = xs.find((h) => h.hour === sel) ?? xs[n - 1]!;
  const curI = xs.indexOf(cur);
  const every = n <= 12 ? 1 : n <= 18 ? 2 : 3;
  const pick = (e: PointerEvent<HTMLDivElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    const i = Math.floor(((e.clientX - r.left) / Math.max(1, width)) * n);
    setSel(xs[Math.max(0, Math.min(n - 1, i))]!.hour);
  };
  const hh = (h: number) => String(h).padStart(2, "0");
  return (
    <div className="m-hb">
      <div className="m-hb-read">
        <b>{hh(cur.hour)}:00</b>
        <span>
          10 s<span className={"v " + tone(cur.mk10, bps(cur.mk10))}>{bps(cur.mk10)}</span>
        </span>
        <span>
          60 s<span className={"v " + tone(cur.mk60, bps(cur.mk60))}>{bps(cur.mk60)}</span>
        </span>
        <span />
        <span>
          fills<span className="v">{int(cur.fills)}</span>
        </span>
        <span>
          PnL 60 s
          <span className="v">
            <Money v={cur.pnl} />
          </span>
        </span>
      </div>
      <div className="m-hb-plot">
        <div
          ref={ref}
          className="m-hb-svg m-dim"
          style={{ height: H }}
          onPointerDown={(e) => {
            pick(e);
            // keep the drag for scrubbing only when it starts sideways; the page still scrolls vertically (pan-y)
            e.currentTarget.setPointerCapture?.(e.pointerId);
          }}
          onPointerMove={(e) => e.buttons && pick(e)}
          role="img"
          aria-label="10 s markout by UTC hour"
        >
          {width > 0 && (
            <svg width={width} height={H}>
              <line x1={0} x2={width} y1={y(0) + 0.5} y2={y(0) + 0.5} stroke="#4a5870" />
              {xs.map((h, i) => {
                const v = h.mk10 ?? 0;
                const top = Math.min(y(v), y(0));
                const ht = Math.max(1, Math.abs(y(v) - y(0)));
                const cx = cw * i + cw / 2;
                const on = i === curI;
                return (
                  <g key={h.hour}>
                    {on && <rect x={cw * i} y={0} width={cw} height={plotH} fill="rgba(126,166,246,0.10)" />}
                    <rect
                      x={cx - bw / 2}
                      y={top}
                      width={bw}
                      height={ht}
                      rx={1}
                      fill={{ up: "var(--up)", down: "var(--down)", "": "var(--ink-2)" }[tone(v, bps(v))]}
                      opacity={on ? 1 : 0.7}
                    />
                    {(i % every === 0 || on) && (
                      <text x={cx} y={H - 4} textAnchor="middle" style={on ? { fill: "var(--ink)" } : undefined}>
                        {hh(h.hour)}
                      </text>
                    )}
                  </g>
                );
              })}
            </svg>
          )}
        </div>
        <div className="m-hb-axis" aria-hidden>
          <span>{b > 0 ? bps(b - pad) : ""}</span>
          <span>{a < 0 ? bps(a + pad) : ""}</span>
        </div>
      </div>
    </div>
  );
}

/** Spot instruments with fills or PnL today, by realized PnL. */
function ByInstrument({ rows }: { rows: SymbolRow[] }) {
  const spot = useMemo(
    () => rows.filter((r) => r.venue === "spot" && (r.fills_day > 0 || r.trading_pnl !== 0)).sort((a, b) => b.realized_pnl - a.realized_pnl),
    [rows],
  );
  const total = spot.reduce((s, r) => s + r.realized_pnl, 0);
  return (
    <Section
      title="By instrument"
      info="Spot instruments with fills or PnL today, sorted by realized PnL: sells matched FIFO to buys, including the day-start inventory, minus fees, USDT. Float is the inventory left, at mid against its cost. Edge and markouts are volume-weighted over today's fills; markouts net of the reference move from 1 s after the fill, bps."
      right={
        <>
          realized <Money v={total} />
        </>
      }
    >
      {spot.map((r) => {
        const ref = !r.reference ? null : r.reference === `usdm:${r.symbol}` || r.reference === r.symbol ? null : refLabel(r.reference);
        return (
          <ListRow
            key={r.symbol}
            title={
              <>
                {r.symbol}
                {ref && <Tag>vs {ref}</Tag>}
              </>
            }
            subtitle={`${int(r.fills_day)} fills · edge ${bps(r.edge_bps)} · 10 s ${bps(r.mk10_bps)} · 60 s ${bps(r.mk60_bps)}`}
            primary={<Money v={r.realized_pnl} />}
            secondary={
              <>
                float <Money v={r.float_pnl} />
              </>
            }
            to={{ page: "desk", detail: { kind: "instrument", symbol: r.symbol, venue: r.venue } }}
          />
        );
      })}
      {!spot.length && <div className="m-empty">No spot fills today</div>}
    </Section>
  );
}
