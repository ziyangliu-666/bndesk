// Desktop Analysis: today's post-trade markouts on one screen. Controls, a KPI strip, the price path around our
// fills (−10 s to 5 min, per side, ±2 SE) next to the distribution at the chosen horizon, the day in 15-minute
// buckets, then the instruments as a table with their own curves next to edge against 10 s markout. Everything
// comes from /api/markouts over all of today's fills (analysis/data.ts) and follows the controls.
import { useMemo, useState, type ReactNode } from "react";
import { selectInstrument, useStore } from "../store";
import { bps, compact, int, pct, signClass } from "../format";
import { C, S1 } from "../theme";
import { TextToggle, TickerStrip, useExHidden, type TickerItem } from "../components/ex";
import { maskText, money, useHide } from "../mask";
import type { MarkoutInst, MarkoutReport } from "../protocol";
import { MAIN_H, MK_DEF, REF_OPTS, TOX_DEF, hIdx, everyLine, hLabel, pathCover, useMarkouts, useView, type SideF, type VenueF, type Weight } from "./analysis/data";
import { PathChart, type PathLineDef } from "./analysis/PathChart";
import { Dist } from "./analysis/Dist";
import { DayChart } from "./analysis/DayChart";
import { Scatter, instKey } from "./analysis/Scatter";
import { Spark } from "./analysis/Spark";
import { SortTable, type SCol } from "./analysis/SortTable";
import "./analysis/analysis.css";

const SIDES = [
  { value: "all" as SideF, label: "All" },
  { value: "buy" as SideF, label: "Buys" },
  { value: "sell" as SideF, label: "Sells" },
];
const VENUES = [
  { value: "all" as VenueF, label: "All" },
  { value: "spot" as VenueF, label: "Spot" },
  { value: "usdm" as VenueF, label: "Perp" },
];
const WEIGHTS = [
  { value: "notional" as Weight, label: "By notional" },
  { value: "fill" as Weight, label: "By fill" },
];

export function Markouts() {
  const c = useView("analysis");
  const v = c.view;
  const { r, error } = useMarkouts(v);
  const accounts = useStore((s) => s.snap?.accounts);
  const hide = useHide();
  const [hover, setHover] = useState<string | null>(null);
  const of = v.weight === "fill" ? "fills" : "notional";

  return (
    <div className="page an-page">
      <section className="panel an-main">
        <div className="an-ctl">
          <Group label="Reference">
            <TextToggle label="Reference" options={REF_OPTS} value={v.ref} onChange={c.setRef} />
          </Group>
          <Group label="Side">
            <TextToggle label="Side" options={SIDES} value={v.side} onChange={c.setSide} />
          </Group>
          <Group label="Account">
            <TextToggle
              label="Account"
              options={[{ value: "", label: "All" }, ...(accounts ?? []).map((a) => ({ value: a.id, label: a.label || a.id }))]}
              value={v.account}
              onChange={c.setAccount}
            />
          </Group>
          <Group label="Venue">
            <TextToggle label="Venue" options={VENUES} value={v.venue} onChange={c.setVenue} />
          </Group>
          <Group label="Weight">
            <TextToggle label="Weight" options={WEIGHTS} value={v.weight} onChange={c.setWeight} />
          </Group>
          <span className="an-ctl-note muted">{error ? <span className="warn-text">{error}</span> : "Today, all fills"}</span>
        </div>
        <Kpis r={r} side={v.side} hide={hide} />
        <div className="an-grid">
          <div className="an-cell an-c-path">
            <div className="an-sub">
              <span className="dotted" title={MK_DEF}>
                Price path around our fills
              </span>
              <span className="an-sub-r muted">{pathCover(r) ?? "Click a horizon for its distribution"}</span>
            </div>
            <Path r={r} side={v.side} h={v.h} onH={c.setH} />
          </div>
          <div className="an-cell an-c-dist">
            <div className="an-sub">
              <span>Distribution</span>
              <TextToggle
                className="an-sub-r"
                label="Horizon"
                value={String(v.h)}
                onChange={(x) => c.setH(Number(x))}
                options={[...new Set([...MAIN_H, v.h])].sort((a, b) => a - b).map((h) => ({ value: String(h), label: hLabel(h) }))}
              />
            </div>
            <Dist d={r?.dist ?? null} of={of} />
          </div>
          <div className="an-cell an-c-day">
            <div className="an-fillbox">
              <DayChart
                id="an-day"
                buckets={r?.by_time ?? []}
                hide={hide}
                fill
                title={
                  <span className="an-tb-title">
                    Markout through the day <span className="muted">15 min, bps</span>
                  </span>
                }
              />
            </div>
          </div>
          <div className="an-cell an-c-inst">
            <Instruments r={r} hide={hide} hover={hover} onHover={setHover} of={of} />
          </div>
          <div className="an-cell an-c-scatter">
            <div className="an-sub">
              <span className="dotted" title="Each instrument's edge at the fill (x) against its 10 s markout (y), bps; the bubble's area is its notional. Under zero the market took more than the edge; under the dashed diagonal some of the edge went.">
                Edge vs 10 s markout
              </span>
            </div>
            <Scatter
              rows={r?.by_instrument ?? []}
              j10={hIdx(r, 10)}
              hide={hide}
              hover={hover}
              onHover={setHover}
              onPick={(x) => selectInstrument({ symbol: x.symbol, venue: x.venue })}
            />
          </div>
        </div>
      </section>
    </div>
  );
}

function Group({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="an-ctl-g">
      <span className="an-ctl-l">{label}</span>
      {children}
    </div>
  );
}

function Kpis({ r, side, hide }: { r: MarkoutReport | null; side: SideF; hide: boolean }) {
  const l = r ? everyLine(r, side) : null;
  const at = (h: number) => (l ? l.mean[hIdx(r, h)] : null);
  const mk = (h: number): TickerItem => {
    const x = at(h);
    return { label: `Markout ${h} s`, value: bps(x), tone: (signClass(x) || undefined) as TickerItem["tone"] };
  };
  const adv = l ? l.adverse[hIdx(r, 10)] : null;
  const items: (TickerItem | "|")[] = [
    { label: "Fills", value: r ? int(r.fills) : "--" },
    { label: "Notional", value: r ? maskText(hide, compact(r.notional)) : "--", tone: hide ? "muted" : undefined },
    { label: "Edge at fill", value: bps(r?.edge) },
    "|",
    mk(1),
    mk(10),
    mk(60),
    mk(300),
    "|",
    {
      label: "Markout PnL",
      title: "Σ notional × 60 s markout, USDT: what the fills were worth a minute later. A diagnostic, not P&L",
      value: r ? maskText(hide, money(r.pnl, true)) : "--",
      tone: hide || !r ? (hide ? "muted" : undefined) : ((signClass(r.pnl) || undefined) as TickerItem["tone"]),
    },
    { label: "Adverse at 10 s", value: adv == null ? "--" : pct(adv, 1) },
  ];
  return <TickerStrip className="an-kpi" size="md" items={items} />;
}

function Path({ r, side, h, onH }: { r: MarkoutReport | null; side: SideF; h: number; onH: (h: number) => void }) {
  const { hidden, toggle } = useExHidden("an-path");
  const lines = useMemo<PathLineDef[]>(() => {
    if (!r) return [];
    const out: PathLineDef[] = [];
    if (side === "all") out.push({ key: "all", label: "All", color: C.ink, line: r.all, band: true });
    if (side !== "sell") out.push({ key: "buy", label: "Buys", color: C.up, line: r.buy, band: side === "buy" });
    if (side !== "buy") out.push({ key: "sell", label: "Sells", color: C.down, line: r.sell, band: side === "sell" });
    out.push({ key: "tox", label: "Ref move", color: S1, line: r.tox, dashed: true, title: TOX_DEF });
    return out;
  }, [r, side]);
  return (
    <div className="an-fillbox">
      {r ? <PathChart horizons={r.horizons_s} lines={lines} hidden={hidden} onToggle={toggle} selected={h} onSelect={onH} /> : <div className="an-empty">Loading</div>}
    </div>
  );
}

function Instruments({ r, hide, hover, onHover, of }: { r: MarkoutReport | null; hide: boolean; hover: string | null; onHover: (k: string | null) => void; of: string }) {
  const rows = r?.by_instrument ?? [];
  const ix = (h: number) => hIdx(r, h);
  const iFill = ix(0);
  const mkCol = (h: number): SCol<MarkoutInst> => ({
    key: "m" + h,
    label: `${h} s`,
    title: `Markout ${h} s after the fill, bps`,
    cell: (x) => bps(x.mean[ix(h)]),
    cls: (x) => "fig " + signClass(x.mean[ix(h)]),
    sort: (x) => x.mean[ix(h)] ?? null,
  });
  const cols: SCol<MarkoutInst>[] = [
    {
      key: "sym",
      label: "Instrument",
      left: true,
      cell: (x) => (
        <span className="an-sym">
          {x.symbol}
          {x.venue === "usdm" && <span className="an-tag">Perp</span>}
        </span>
      ),
      sort: (x) => x.symbol,
    },
    { key: "f", label: "Fills", cell: (x) => int(x.fills), cls: () => "fig", sort: (x) => x.fills },
    { key: "n", label: "Notional", title: "Filled notional today, USDT", cell: (x) => maskText(hide, compact(x.notional)), cls: () => "fig" + (hide ? " masked" : ""), sort: (x) => x.notional },
    { key: "e", label: "Edge", title: "Edge at fill, bps", cell: (x) => bps(x.edge), cls: (x) => "fig " + signClass(x.edge), sort: (x) => x.edge },
    ...MAIN_H.map(mkCol),
    {
      key: "se",
      label: "±2 SE",
      title: "Two standard errors of the 10 s markout: a name with few fills reads wide",
      cell: (x) => (x.se10 == null ? "--" : "±" + (2 * x.se10).toFixed(1)),
      cls: () => "fig muted",
      sort: (x) => x.se10,
    },
    {
      key: "p",
      label: "Markout PnL",
      title: "Σ notional × 60 s markout, USDT. A diagnostic, not P&L",
      cell: (x) => maskText(hide, money(x.pnl, true)),
      cls: (x) => "fig " + (hide ? "masked" : signClass(x.pnl)),
      sort: hide ? undefined : (x) => x.pnl,
    },
    { key: "a", label: "Adverse", title: `Share of ${of} whose 10 s markout is below zero`, cell: (x) => (x.adverse10 == null ? "--" : pct(x.adverse10, 0)), cls: () => "fig", sort: (x) => x.adverse10 },
    { key: "c", label: "−10 s … 5 min", title: "The instrument's own markout path, the same horizons as the chart above", cell: (x) => <Spark vals={x.mean} iFill={iFill} />, cls: () => "an-spark-td" },
  ];
  return (
    <div className="an-tbox">
      <SortTable
        className="sticky"
        cols={cols}
        rows={rows}
        rowKey={instKey}
        initial={{ key: "n", desc: true }}
        onRow={(x) => selectInstrument({ symbol: x.symbol, venue: x.venue })}
        hover={hover}
        onHover={onHover}
        empty={r ? "No fills today" : "Loading"}
      />
    </div>
  );
}
