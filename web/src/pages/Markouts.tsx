// Desktop Analysis (was Markouts): tabs Markouts | By hour | By instrument. Charts with in-plot legends
// that show each line's value at the hovered point, the exact figures in plain tables under them; figures are
// coloured as text only, never as cell backgrounds.
import { useMemo } from "react";
import { selectInstrument, useStore } from "../store";
import { bps, compact, int, num, signClass } from "../format";
import { C, S1 } from "../theme";
import type { SymbolRow } from "../protocol";
import { Tabs, useExHidden, useExPref } from "../components/ex";
import { refLabel } from "../components/ui";
import { maskFormat, maskText } from "../mask";
import { Curve, type CurveSeries } from "./analysis/Curve";
import { SortTable, type SCol } from "./analysis/SortTable";
import "./analysis/analysis.css";

type Tab = "markouts" | "hour" | "inst";
const TABS: Tab[] = ["markouts", "hour", "inst"];

const MK_DEF =
  "Markout at h: side × (mid(t+h) / price − 1); net subtracts the reference's move from τ = 1 s or 0.2 s after the fill. " +
  "Notional-weighted over today's fills. A diagnostic, not PnL";
const TOX_DEF =
  "How far the reference moved against the fill from 5 s before it to h after it, −side × (ref(t+h) / ref(t−5 s) − 1), " +
  "weighted by notional over today's fills with a reference. Positive = the reference moved against us. A rise between 0 and 0.2 s is a " +
  "price jump that picked off the quote before any hedge could trade";

/** bps, signed; unknown is `--`. */
const bp = (v: number | null | undefined) => (v == null ? "--" : bps(v));
const fb = (v: number) => bp(v);
const hz = (h: number) => (h === 0 ? "fill" : `${h} s`);
const MK_HIDDEN = ["fast", "raw"];

export function Markouts() {
  const [tab, setTab] = useExPref<Tab>("analysis", "tab", "markouts", TABS);
  return (
    <div className="page an-page">
      <section className="panel an-main">
        <div className="an-head">
          <Tabs
            items={[
              { value: "markouts", label: "Markouts" },
              { value: "hour", label: "By hour" },
              { value: "inst", label: "By instrument" },
            ]}
            value={tab}
            onChange={setTab}
          />
          <span className="an-note muted">{tab === "inst" ? "Spot, today: PnL in USDT, edge and markouts in bps" : tab === "hour" ? "Today, UTC hours" : "Today's fills, bps"}</span>
        </div>
        <div className="an-body">{tab === "markouts" ? <MarkoutsTab /> : tab === "hour" ? <HourTab /> : <InstrumentTab />}</div>
      </section>
    </div>
  );
}

// ---------------- Markouts ----------------

function MarkoutsTab() {
  const mk = useStore((s) => s.snap?.markouts);
  // Net 0.2 s and Raw run on top of Net 1 s most days: off until asked for, so the lines read apart
  const mkHidden = useExHidden("an-mk", MK_HIDDEN);
  const toxHidden = useExHidden("an-tox");
  const cats = useMemo(() => (mk?.horizons ?? [1, 10, 60, 300]).map(hz), [mk?.horizons]);
  const series = useMemo<CurveSeries[]>(
    () => [
      { key: "all", label: "Net 1 s", color: C.ink, data: mk?.all ?? [], format: fb, title: "Net of the reference's move from 1 s after the fill" },
      { key: "fast", label: "Net 0.2 s", color: S1, data: mk?.fast ?? [], format: fb, title: "Net of the reference's move from 0.2 s after the fill" },
      { key: "raw", label: "Raw", color: C.muted, dashed: true, data: mk?.raw ?? [], format: fb, title: "Against the instrument's own mid only" },
      { key: "buys", label: "Buys", color: C.up, data: mk?.buys ?? [], format: fb, title: "Buys only, net 1 s" },
      { key: "sells", label: "Sells", color: C.down, data: mk?.sells ?? [], format: fb, title: "Sells only, net 1 s" },
    ],
    [mk],
  );
  const tox = mk?.toxicity;
  const toxCats = useMemo(() => (tox?.horizons_s ?? []).map(hz), [tox?.horizons_s]);
  const toxSeries = useMemo<CurveSeries[]>(
    () => [
      { key: "d", label: "D(h)", color: C.ink, data: tox?.bps ?? [], format: fb, title: TOX_DEF },
    ],
    [tox],
  );

  type HRow = { key: string; label: string; title: string; v: (number | null)[] };
  const rows: HRow[] = series.map((s) => ({ key: s.key, label: s.label, title: s.title ?? "", v: s.data }));
  const cols: SCol<HRow>[] = [
    { key: "l", label: "", left: true, cell: (r) => <span title={r.title}>{r.label}</span> },
    ...cats.map((c, i): SCol<HRow> => ({ key: c, label: c, cell: (r) => bp(r.v[i]), cls: (r) => "fig " + signClass(r.v[i]) })),
  ];
  type TRow = { key: string; label: string; v: (number | null)[]; fills?: boolean };
  const toxRows: TRow[] = tox ? [{ key: "d", label: "D(h)", v: tox.bps }, { key: "n", label: "Fills", v: tox.fills, fills: true }] : [];
  const toxCols: SCol<TRow>[] = [
    { key: "l", label: "", left: true, cell: (r) => (r.fills ? r.label : <span title={TOX_DEF}>{r.label}</span>) },
    ...toxCats.map((c, i): SCol<TRow> => ({
      key: c,
      label: c,
      cell: (r) => (r.fills ? int(r.v[i]) : bp(r.v[i])),
      cls: (r) => "fig " + (r.fills ? "" : signClass(r.v[i])),
    })),
  ];

  return (
    <div className="an-mk">
      <div className="an-cell an-mk-chart">
        <div className="an-sub">
          <span className="dotted" title={MK_DEF}>
            Markout by horizon
          </span>
        </div>
        <Curve categories={cats} series={series} hidden={mkHidden.hidden} onToggle={mkHidden.toggle} axisFormat={(v) => num(v, 1, true)} unit="bps" heading={(c) => `At ${c}`} />
      </div>
      <div className="an-cell an-tox-chart">
        <div className="an-sub">
          <span className="dotted" title={TOX_DEF}>
            Toxicity D(h)
          </span>
        </div>
        <Curve
          categories={toxCats}
          series={toxSeries}
          hidden={toxHidden.hidden}
          onToggle={toxHidden.toggle}
          axisFormat={(v) => num(v, 1, true)}
          unit="bps"
          heading={(c) => (c === "fill" ? "At the fill" : `At ${c}`)}
        />
      </div>
      <div className="an-cell an-mk-table">
        <SortTable cols={cols} rows={rows} rowKey={(r) => r.key} empty="No fills today" />
      </div>
      <div className="an-cell an-tox-table">
        <SortTable cols={toxCols} rows={toxRows} rowKey={(r) => r.key} empty="No fills today" />
      </div>
    </div>
  );
}

// ---------------- By hour ----------------

type Hour = { hour: number; fills: number; mk10: number | null; mk60: number | null; pnl: number };

function HourTab() {
  const mk = useStore((s) => s.snap?.markouts);
  const hidden = useExHidden("an-hour");
  const hide = useStore((s) => s.hideAmounts);
  // the hours so far today, empty ones included (a gap in the bars reads as a quiet hour)
  const hours = useMemo<Hour[]>(() => {
    const by = new Map((mk?.by_hour ?? []).map((h) => [h.hour, h]));
    const last = Math.max(-1, ...(mk?.by_hour ?? []).filter((h) => h.fills > 0).map((h) => h.hour), new Date().getUTCHours());
    const out: Hour[] = [];
    for (let h = 0; h <= last; h++) out.push(by.get(h) ?? { hour: h, fills: 0, mk10: null, mk60: null, pnl: 0 });
    return out;
  }, [mk?.by_hour]);
  const cats = hours.map((h) => `${String(h.hour).padStart(2, "0")}:00`);
  const series = useMemo<CurveSeries[]>(
    () => [
      { key: "pnl", label: "PnL 60 s", kind: "bar", signBars: !hide, signValue: !hide, color: hide ? C.muted : C.up, data: hours.map((h) => (h.fills ? h.pnl : null)), format: maskFormat(hide, (v) => num(v, 2, true)), title: "60 s markout × notional, USDT: a diagnostic, not PnL" },
      { key: "fills", label: "Fills", color: S1, data: hours.map((h) => h.fills), format: (v) => int(v), axis: 1, title: "Fills in the hour, on the left axis" },
    ],
    [hours, hide],
  );
  const cols: SCol<Hour>[] = [
    { key: "h", label: "Hour", title: "UTC hour", left: true, cell: (h) => `${String(h.hour).padStart(2, "0")}:00`, sort: (h) => h.hour },
    { key: "f", label: "Fills", cell: (h) => int(h.fills), cls: () => "fig", sort: (h) => h.fills },
    { key: "m10", label: "10 s", title: "Markout at 10 s, net 1 s, bps", cell: (h) => bp(h.mk10), cls: (h) => "fig " + signClass(h.mk10), sort: (h) => h.mk10 },
    { key: "m60", label: "60 s", title: "Markout at 60 s, net 1 s, bps", cell: (h) => bp(h.mk60), cls: (h) => "fig " + signClass(h.mk60), sort: (h) => h.mk60 },
    { key: "p", label: "PnL 60 s", dot: true, title: "60 s markout × notional, USDT: a diagnostic, not PnL", cell: (h) => (h.fills ? maskText(hide, num(h.pnl, 2, true)) : "--"), cls: (h) => "fig " + (hide ? "masked" : signClass(h.pnl)), sort: hide ? undefined : (h) => (h.fills ? h.pnl : null) },
  ];
  const rows = hours.filter((h) => h.fills > 0);
  return (
    <div className="an-hour">
      <div className="an-cell an-hour-chart">
        <div className="an-sub">
          <span>
            <span className="dotted" title="Each fill's 60 s markout × its notional, summed per UTC hour, USDT: a diagnostic, not PnL">
              PnL 60 s
            </span>{" "}
            and fills by UTC hour
          </span>
        </div>
        <Curve
          categories={cats}
          series={series}
          hidden={hidden.hidden}
          onToggle={hidden.toggle}
          axisFormat={maskFormat(hide, (v) => num(v, 2, true))}
          unit="USDT"
          unit2="Fills"
          axis2Format={(v) => compact(v, 1)}
          heading={(c) => `${c} UTC`}
        />
      </div>
      <div className="an-cell an-hour-table">
        <SortTable cols={cols} rows={rows} rowKey={(h) => String(h.hour)} initial={{ key: "h", desc: true }} empty="No fills today" />
      </div>
    </div>
  );
}

// ---------------- By instrument ----------------

function InstrumentTab() {
  const symbols = useStore((s) => s.snap?.symbols);
  const rows = useMemo(() => symbols?.filter((r) => r.venue === "spot" && (r.fills_day > 0 || r.trading_pnl !== 0)) ?? [], [symbols]);
  const hide = useStore((s) => s.hideAmounts);
  const m = (s: string) => maskText(hide, s);
  const p2 = (v: number | null) => (v == null ? "--" : m(num(v, 2, true)));
  const cols: SCol<SymbolRow>[] = [
    { key: "sym", label: "Instrument", left: true, cell: (r) => <span className="an-sym">{r.symbol}</span>, sort: (r) => r.symbol },
    {
      key: "ref",
      label: "Reference",
      title: "The instrument the net markouts are taken against",
      left: true,
      cell: (r) => <span className="muted">{!r.reference ? "--" : r.reference === `usdm:${r.symbol}` || r.reference === r.symbol ? "Perp" : refLabel(r.reference)}</span>,
    },
    { key: "f", label: "Fills", cell: (r) => int(r.fills_day), cls: () => "fig", sort: (r) => r.fills_day },
    { key: "re", label: "Realized", title: "Sells matched FIFO to buys, day-start inventory included, minus fees, USDT", cell: (r) => p2(r.realized_pnl), cls: (r) => "fig " + (hide ? "masked" : signClass(r.realized_pnl)), sort: (r) => r.realized_pnl },
    { key: "fl", label: "Float", title: "Inventory left, at mid against cost, USDT", cell: (r) => p2(r.float_pnl), cls: (r) => "fig " + (hide ? "masked" : signClass(r.float_pnl)), sort: (r) => r.float_pnl },
    { key: "v", label: "Volume", title: "Filled notional today, USDT", cell: (r) => m(compact(r.volume_day)), cls: () => "fig" + (hide ? " masked" : ""), sort: (r) => r.volume_day },
    { key: "inv", label: "Inventory", title: "Quantity held across accounts × mid, USDT", cell: (r) => m(compact(r.inv_value)), cls: () => "fig" + (hide ? " masked" : ""), sort: (r) => r.inv_value },
    { key: "e", label: "Edge", dot: true, title: "Edge at fill: side × (fair − price) / fair, volume-weighted, bps", cell: (r) => bp(r.edge_bps), cls: (r) => "fig " + signClass(r.edge_bps), sort: (r) => r.edge_bps },
    { key: "m10", label: "10 s", title: "Markout 10 s after the fill, net 1 s, bps", cell: (r) => bp(r.mk10_bps), cls: (r) => "fig " + signClass(r.mk10_bps), sort: (r) => r.mk10_bps },
    { key: "m60", label: "60 s", title: "Markout 60 s after the fill, net 1 s, bps", cell: (r) => bp(r.mk60_bps), cls: (r) => "fig " + signClass(r.mk60_bps), sort: (r) => r.mk60_bps },
    { key: "m300", label: "300 s", title: "Markout 300 s after the fill, net 1 s, bps", cell: (r) => bp(r.mk300_bps), cls: (r) => "fig " + signClass(r.mk300_bps), sort: (r) => r.mk300_bps },
  ];
  return (
    <div className="an-inst">
      <SortTable
        className="sticky"
        cols={cols}
        rows={rows}
        rowKey={(r) => r.venue + ":" + r.symbol}
        initial={{ key: "re", desc: true }}
        onRow={(r) => selectInstrument({ symbol: r.symbol, venue: r.venue })}
        empty="No fills today"
      />
    </div>
  );
}
