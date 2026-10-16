// Phone Analysis: the desktop page's content stacked. Reference and side on top (the rest of the view in a
// sheet), the KPI grid, the price path around our fills (a tap picks a horizon, a sideways drag reads the
// others), the distribution at that horizon, the day in 15-minute buckets, then the instruments with their own
// curves. All of it from /api/markouts over today's fills (analysis/data.ts).
import { useState } from "react";
import { useStore } from "../../store";
import { bps, compact, int, pct, signClass } from "../../format";
import { C, S1 } from "../../theme";
import { useExHidden } from "../../components/ex";
import { Chips, Segmented, Sheet } from "../../components/mobile";
import { maskText, money, useHide } from "../../mask";
import type { MarkoutReport } from "../../protocol";
import { MAIN_H, MK_DEF, REF_OPTS, TOX_DEF, hIdx, everyLine, hLabel, pathCover, useMarkouts, useView, type SideF, type VenueF, type Weight } from "../analysis/data";
import { PathChart, type PathLineDef } from "../analysis/PathChart";
import { Dist } from "../analysis/Dist";
import { DayChart } from "../analysis/DayChart";
import { Spark } from "../analysis/Spark";
import { Empty, Row, Sec, Stats, type Stat } from "./rest/ui";
import "../analysis/analysis.css";
import "./rest/ops.css";

const SIDES: { value: SideF; label: string }[] = [
  { value: "all", label: "All" },
  { value: "buy", label: "Buys" },
  { value: "sell", label: "Sells" },
];
const VENUES: { value: VenueF; label: string }[] = [
  { value: "all", label: "All" },
  { value: "spot", label: "Spot" },
  { value: "usdm", label: "Perp" },
];
const WEIGHTS: { value: Weight; label: string }[] = [
  { value: "notional", label: "By notional" },
  { value: "fill", label: "By fill" },
];

export function MarkoutsM() {
  const c = useView("m-analysis");
  const v = c.view;
  const { r, error } = useMarkouts(v);
  const hide = useHide();
  const accounts = useStore((s) => s.snap?.accounts);
  const [sheet, setSheet] = useState(false);
  const { hidden, toggle } = useExHidden("m-an-path");
  const of = v.weight === "fill" ? "fills" : "notional";
  const acctLabel = v.account ? (accounts?.find((a) => a.id === v.account)?.label ?? v.account) : "All accounts";
  const venueLabel = v.venue === "all" ? "all venues" : v.venue === "spot" ? "spot" : "perp";

  const lines: PathLineDef[] = !r
    ? []
    : [
        ...(v.side === "all" ? [{ key: "all", label: "All", color: C.ink, line: r.all, band: true }] : []),
        ...(v.side !== "sell" ? [{ key: "buy", label: "Buys", color: C.up, line: r.buy, band: v.side === "buy" }] : []),
        ...(v.side !== "buy" ? [{ key: "sell", label: "Sells", color: C.down, line: r.sell, band: v.side === "sell" }] : []),
        { key: "tox", label: "Ref move", color: S1, line: r.tox, dashed: true, title: TOX_DEF },
      ];

  return (
    <div className="o-page m-an">
      <div className="m-an-ctl">
        <Chips label="Reference" value={v.ref} onChange={c.setRef} data={REF_OPTS.map((o) => ({ value: o.value, label: o.label }))} />
        <Chips label="Side" value={v.side} onChange={c.setSide} data={SIDES} />
        <button type="button" className="m-an-filter" onClick={() => setSheet(true)}>
          <span>
            {acctLabel} · {venueLabel} · {v.weight === "fill" ? "by fill" : "by notional"}
          </span>
          <span className="muted">Change</span>
        </button>
      </div>
      {error && <div className="m-an-err warn-text">{error}</div>}
      <Stats cols={3} items={kpis(r, v.side, hide)} className="m-an-kpi" />
      <Sec title="Price path around our fills" info={MK_DEF + ".\n\nTap a horizon to see its distribution; drag sideways to read the others."}>
        {r ? (
          <>
            {pathCover(r) && <div className="muted m-an-cover">{pathCover(r)}</div>}
            <PathChart horizons={r.horizons_s} lines={lines} hidden={hidden} onToggle={toggle} selected={v.h} onSelect={c.setH} touch height={280} />
          </>
        ) : (
          <Empty>Loading</Empty>
        )}
      </Sec>
      <Sec title={`Distribution at ${hLabel(v.h)}`} info={`Each fill's markout at the horizon, as a share of ${of}. The end bins hold the 1 % tails. Mean (solid), median (dashed), 10th and 90th percentiles (dotted).`}>
        <Chips
          label="Horizon"
          value={String(v.h)}
          onChange={(x) => c.setH(Number(x))}
          data={[...new Set([...MAIN_H, v.h])].sort((a, b) => a - b).map((h) => ({ value: String(h), label: hLabel(h) }))}
        />
        <Dist d={r?.dist ?? null} of={of} touch height={210} />
      </Sec>
      <Sec>
        <DayChart
          id="m-an-day"
          buckets={r?.by_time ?? []}
          hide={hide}
          height={200}
          touch
          title={
            <span className="an-tb-title m">
              Through the day <span className="muted">15 min, bps</span>
            </span>
          }
        />
      </Sec>
      <Instruments r={r} hide={hide} />
      <Sheet opened={sheet} onClose={() => setSheet(false)} title="View">
        <div className="m-an-sheet">
          <div className="m-an-sheet-l">Account</div>
          <Chips
            label="Account"
            value={v.account || "*"}
            onChange={(x) => c.setAccount(x === "*" ? "" : x)}
            data={[{ value: "*", label: "All" }, ...(accounts ?? []).map((a) => ({ value: a.id, label: a.label || a.id }))]}
          />
          <div className="m-an-sheet-l">Venue</div>
          <Segmented label="Venue" value={v.venue} onChange={c.setVenue} data={VENUES} />
          <div className="m-an-sheet-l">Weight</div>
          <Segmented label="Weight" value={v.weight} onChange={c.setWeight} data={WEIGHTS} />
        </div>
      </Sheet>
    </div>
  );
}

function kpis(r: MarkoutReport | null, side: SideF, hide: boolean): Stat[] {
  const l = r ? everyLine(r, side) : null;
  const mk = (h: number): Stat => {
    const x = l ? l.mean[hIdx(r, h)] : null;
    return { label: `${h} s`, value: bps(x), tone: signClass(x) as Stat["tone"] };
  };
  const adv = l ? l.adverse[hIdx(r, 10)] : null;
  return [
    { label: "Fills", value: r ? int(r.fills) : "--" },
    { label: "Notional", value: r ? maskText(hide, compact(r.notional)) : "--" },
    { label: "Edge at fill", value: bps(r?.edge) },
    mk(1),
    mk(10),
    mk(60),
    mk(300),
    {
      label: "Markout PnL",
      info: "Σ notional × 60 s markout, USDT: what the fills were worth a minute later. A diagnostic, not P&L.",
      value: r ? maskText(hide, money(r.pnl, true)) : "--",
      tone: hide || !r ? "" : (signClass(r.pnl) as Stat["tone"]),
    },
    { label: "Adverse 10 s", value: adv == null ? "--" : pct(adv, 1) },
  ];
}

function Instruments({ r, hide }: { r: MarkoutReport | null; hide: boolean }) {
  const [all, setAll] = useState(false);
  const every = r?.by_instrument ?? [];
  const rows = all ? every : every.slice(0, 12);
  const i10 = hIdx(r, 10);
  const i60 = hIdx(r, 60);
  const iFill = hIdx(r, 0);
  return (
    <Sec flush title="Instruments" right="10 s · 60 s, bps" info="Today's instruments by notional. The curve is the instrument's own markout path, −10 s to 5 min, as in the chart above; ±2 SE is the 10 s figure's uncertainty (wide on a name with few fills).">
      {rows.map((x) => (
        <Row
          key={x.venue + ":" + x.symbol}
          className="m-an-inst"
          title={
            <>
              {x.symbol}
              {x.venue === "usdm" && <span className="r-tag">Perp</span>}
            </>
          }
          sub={`${int(x.fills)} fills · ${maskText(hide, compact(x.notional))} · edge ${bps(x.edge)}`}
          value={
            <span className="m-an-v">
              <Spark vals={x.mean} iFill={iFill} w={64} h={22} />
              <span className={"r-fig " + signClass(x.mean[i10])}>{bps(x.mean[i10])}</span>
            </span>
          }
          valueSub={
            <>
              {bps(x.mean[i60])} · ±{x.se10 == null ? "--" : (2 * x.se10).toFixed(1)}
            </>
          }
          to={{ page: "desk", detail: { kind: "instrument", symbol: x.symbol, venue: x.venue } }}
        />
      ))}
      {every.length > 12 && (
        <button type="button" className="m-an-more" onClick={() => setAll(!all)}>
          {all ? "Show the top 12" : `Show all ${every.length}`}
        </button>
      )}
      {r && !rows.length && <Empty>No fills today</Empty>}
    </Sec>
  );
}
