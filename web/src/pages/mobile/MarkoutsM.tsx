import { useMemo, useState, type PointerEvent } from "react";
import { useElementSize } from "@mantine/hooks";
import { useStore } from "../../store";
import { useThrottled } from "../../hooks";
import { bps, int } from "../../format";
import { refLabel } from "../../components/ui";
import { Money, Section, tone } from "../../components/mobile";
import type { SymbolRow } from "../../protocol";
import { MkTable, type MkRowData } from "./shared";
import "./history.css";
import "./rest/ops.css";
import { useExPref } from "../../components/ex";
import { Amt, Empty, PageTabs, Row, Sec } from "./rest/ui";

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

const ROWS_TIP =
  "Net 1 s: all fills, net of the reference move from 1 s after the fill. Buys, Sells: one side only, net 1 s. " +
  "Net 0.2 s: net from 0.2 s after the fill. Raw: against the instrument's own mid only.";

/** The horizon curve under the table: Edge at the fill, then each horizon, one line per row (Binance-style
 *  legend on top). Plain SVG, 160 px. */
function MkCurve({
  horizons,
  lines,
}: {
  horizons: number[];
  lines: { label: string; color: string; edge: number | null; v: (number | null)[] }[];
}) {
  const { ref, width } = useElementSize<HTMLDivElement>();
  const xs = ["Edge", ...horizons.map((h) => `${h} s`)];
  const pts = lines.map((l) => [l.edge, ...l.v]);
  const all = pts.flat().filter((v): v is number => v != null && Number.isFinite(v));
  if (!all.length) return null;
  const H = 150;
  const AX = 18;
  const R = 40; // right axis
  const plotH = H - AX - 8;
  let lo = Math.min(0, ...all);
  let hi = Math.max(0, ...all);
  const pad = (hi - lo || 1) * 0.12;
  lo -= lo < 0 ? pad : 0;
  hi += pad;
  const w = Math.max(1, width - R);
  const x = (i: number) => 10 + (i / (xs.length - 1)) * (w - 20);
  const y = (v: number) => 4 + ((hi - v) / (hi - lo)) * plotH;
  const ticks = [hi - pad, 0, ...(lo < 0 ? [lo + (lo < 0 ? pad : 0)] : [])];
  return (
    <div className="mk-curve">
      <div className="mk-curve-lg">
        {lines.map((l, i) => (
          <span key={l.label}>
            <i style={{ background: l.color }} />
            {l.label}
            <b className={tone(pts[i]![pts[i]!.length - 1], bps(pts[i]![pts[i]!.length - 1]))}>{bps(pts[i]![pts[i]!.length - 1])}</b>
          </span>
        ))}
        <span className="muted">at {horizons[horizons.length - 1]} s</span>
      </div>
      <div ref={ref} className="mk-curve-plot" style={{ height: H }} role="img" aria-label="Markout by horizon">
        {width > 0 && (
          <svg width={width} height={H}>
            {ticks.map((t, i) => (
              <g key={i}>
                <line x1={0} x2={w} y1={y(t) + 0.5} y2={y(t) + 0.5} stroke={t === 0 ? "#3b4453" : "#161b22"} />
                <text x={width - 2} y={y(t) + 4} textAnchor="end">
                  {bps(t)}
                </text>
              </g>
            ))}
            {xs.map((t, i) => (
              <text key={t} x={x(i)} y={H - 4} textAnchor={i === 0 ? "start" : i === xs.length - 1 ? "end" : "middle"}>
                {t}
              </text>
            ))}
            {lines.map((l, li) => {
              const p = pts[li]!.map((v, i) => (v == null ? null : [x(i), y(v)] as const)).filter((q): q is readonly [number, number] => q != null);
              return (
                <g key={l.label}>
                  <polyline points={p.map((q) => q.join(",")).join(" ")} fill="none" stroke={l.color} strokeWidth={1.5} />
                  {p.map((q, i) => (
                    <circle key={i} cx={q[0]} cy={q[1]} r={2.5} fill={l.color} />
                  ))}
                </g>
              );
            })}
          </svg>
        )}
      </div>
    </div>
  );
}

/** The spot instruments the market moved against most 10 s after our fills (20 fills or more), worst first. */
function PickedOff({ rows }: { rows: SymbolRow[] }) {
  const worst = useMemo(
    () =>
      rows
        .filter((r) => r.venue === "spot" && r.fills_day >= 20 && r.mk10_bps != null && r.mk10_bps < 0)
        .sort((a, b) => a.mk10_bps! - b.mk10_bps!)
        .slice(0, 4),
    [rows],
  );
  return (
    <Sec title="Worst 10 s markouts" right="today, bps">
      {worst.map((r) => (
        <Row
          key={r.symbol}
          dense
          title={r.symbol}
          sub={`${int(r.fills_day)} fills · edge ${bps(r.edge_bps)}`}
          value={<span className={"r-fig " + tone(r.mk10_bps, bps(r.mk10_bps))}>{bps(r.mk10_bps)}</span>}
          valueSub={`60 s ${bps(r.mk60_bps)}`}
          to={{ page: "desk", detail: { kind: "instrument", symbol: r.symbol, venue: r.venue } }}
        />
      ))}
      {!worst.length && <Empty>No instrument has a negative 10 s markout today</Empty>}
    </Sec>
  );
}

/** Markouts: the horizon summary, toxicity behind a disclosure, by UTC hour, then by instrument. */
export function MarkoutsM() {
  const [tab, setTab] = useExPref<"markouts" | "hour" | "inst">("m-analysis", "tab", "markouts", ["markouts", "hour", "inst"]);
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
  // the rows are defined once, in the section's definition (a dotted label on every row reads as clutter)
  const rows: MkRowData[] = [
    { label: "Net 1 s", edge: edge.all, v: mk.all },
    { label: "Buys", edge: edge.buy, v: mk.buys },
    { label: "Sells", edge: edge.sell, v: mk.sells },
    { label: "Net 0.2 s", v: mk.fast },
    { label: "Raw", v: mk.raw },
  ];

  return (
    <div className="o-page">
      <PageTabs
        items={[
          { value: "markouts", label: "Markouts" },
          { value: "hour", label: "By hour" },
          { value: "inst", label: "By instrument" },
        ]}
        value={tab}
        onChange={setTab}
      />
      {tab === "markouts" ? (
        <>
          <Section title="By horizon" info={`${MK_TIP}\n\n${ROWS_TIP}\n\n${EDGE_TIP}`} right="bps">
            <MkTable rows={rows} horizons={mk.horizons} />
            <MkCurve
              horizons={mk.horizons}
              lines={[
                { label: "Net 1 s", color: "var(--ink)", edge: edge.all, v: mk.all },
                { label: "Buys", color: "var(--up)", edge: edge.buy, v: mk.buys },
                { label: "Sells", color: "var(--down)", edge: edge.sell, v: mk.sells },
              ]}
            />
          </Section>
          <Section title="Toxicity" info={TOX_DEF} right="from 5 s before the fill">
            <ToxTable tox={mk.toxicity} />
          </Section>
          <PickedOff rows={symbols ?? []} />
        </>
      ) : tab === "hour" ? (
        <>
        <Section
          title="By UTC hour"
          info="Markout 10 s after the fill, net 1 s, notional-weighted over each UTC hour's fills today; hours without fills are left out. Tap or drag across the bars for an hour's figures. PnL 60 s is the 60 s markout × notional, USDT: a diagnostic, not PnL."
          right="10 s, bps"
        >
          <HourBars hours={mk.by_hour} />
        </Section>
        <HourList hours={mk.by_hour} />
        </>
      ) : (
        <ByInstrument rows={symbols ?? []} />
      )}
    </div>
  );
}

function ToxTable({ tox }: { tox: { horizons_s: number[]; bps: (number | null)[]; fills: number[] } }) {
  const at = (h: number) => `${h} s`;
  return (
    <>
      {(
        <div className="m-mk-wrap">
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
                <th scope="row">Against us</th>
                {tox.bps.map((v, i) => (
                  <td key={i} className={tone(v == null ? v : -v, bps(v))}>
                    {bps(v)}
                  </td>
                ))}
              </tr>
              <tr className="sub">
                <th scope="row">Fills</th>
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
  const H = 160;
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

/** The hours as rows, newest first: fills, the 10 s and 60 s markouts, PnL 60 s. */
function HourList({ hours }: { hours: Hour[] }) {
  const xs = useMemo(() => hours.filter((h) => h.fills > 0).sort((a, b) => b.hour - a.hour), [hours]);
  if (!xs.length) return null;
  const hh = (h: number) => String(h).padStart(2, "0");
  return (
    <Sec title="Hours" right="10 s · 60 s, bps">
      {xs.map((h) => (
        <Row
          key={h.hour}
          dense
          title={`${hh(h.hour)}:00`}
          sub={`${int(h.fills)} fills`}
          value={
            <span className="r-fig">
              <span className={tone(h.mk10, bps(h.mk10))}>{bps(h.mk10)}</span>
              <span className="muted"> · </span>
              <span className={tone(h.mk60, bps(h.mk60))}>{bps(h.mk60)}</span>
            </span>
          }
          valueSub={<>PnL 60 s <Amt v={h.pnl} /></>}
        />
      ))}
    </Sec>
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
    <Sec
      flush
      title="Realized today"
      info="Spot instruments with fills or PnL today, sorted by realized PnL: sells matched FIFO to buys, including the day-start inventory, minus fees, USDT. Float is the inventory left, at mid against its cost. Edge and markouts are volume-weighted over today's fills; markouts net of the reference move from 1 s after the fill, bps."
      right={<Amt v={total} />}
    >
      {spot.map((r) => {
        const ref = !r.reference ? null : r.reference === `usdm:${r.symbol}` || r.reference === r.symbol ? null : refLabel(r.reference);
        return (
          <Row
            key={r.symbol}
            title={
              <>
                {r.symbol}
                {ref && <span className="r-tag">vs {ref}</span>}
              </>
            }
            sub={`${int(r.fills_day)} fills · edge ${bps(r.edge_bps)} · 10 s ${bps(r.mk10_bps)} · 60 s ${bps(r.mk60_bps)}`}
            value={<Amt v={r.realized_pnl} />}
            valueSub={
              <>
                float <Amt v={r.float_pnl} />
              </>
            }
            to={{ page: "desk", detail: { kind: "instrument", symbol: r.symbol, venue: r.venue } }}
          />
        );
      })}
      {!spot.length && <Empty>No spot fills today</Empty>}
    </Sec>
  );
}
