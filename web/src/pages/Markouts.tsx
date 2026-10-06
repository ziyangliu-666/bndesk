import { useMemo } from "react";
import { AgGridReact } from "ag-grid-react";
import type { ColDef, ColGroupDef, GetRowIdParams } from "ag-grid-community";
import { useStore } from "../store";
import { bps, int } from "../format";
import { gridTheme } from "../theme";
import { InstrumentName, Panel, refLabel } from "../components/ui";
import type { SymbolRow } from "../protocol";
import { fBps, fInt, fPnl, fUsd, flashOn, flexCols, signCls, tint, DEFAULT_COL } from "../grid";

// ---- toxicity D(h) ----

const TOX_DEF =
  "Toxicity D(h): how far the reference moved against the fill from 5 s before it to h after it, −side × (ref(t+h) / ref(t−5 s) − 1), " +
  "weighted by notional over today's fills with a reference. Positive = the reference moved against us. A rise between 0 and 0.2 s is a " +
  "price jump that picked off the quote before any hedge could trade";

const MK_TIP =
  "Markout at h: side × (mid(t+h) / price − 1); net subtracts the reference's move from τ = 1 s or 0.2 s after the fill. " +
  "Notional-weighted over today's fills. A diagnostic, not PnL. bps.";

type HzRow = { label: string; tip: string; h1: number | null; h10: number | null; h60: number | null; h300: number | null };
type HourRow = { hour: number; fills: number; mk10: number | null; mk60: number | null; pnl: number };
type ToxRow = { label: string; tip: string; v: (number | null)[] };

const rowIdHz = (p: GetRowIdParams<HzRow>) => p.data.label;
const rowIdTox = (p: GetRowIdParams<ToxRow>) => p.data.label;
const rowIdHour = (p: GetRowIdParams<HourRow>) => String(p.data.hour);

/** Markouts by horizon, toxicity and markouts by UTC hour: dense grids in place of two few-point charts. */
function MarkoutTables() {
  const mk = useStore((s) => s.snap?.markouts);
  const hz = useMemo<HzRow[]>(() => {
    if (!mk) return [];
    const r = (label: string, tip: string, v: (number | null)[]) => ({ label, tip, h1: v[0] ?? null, h10: v[1] ?? null, h60: v[2] ?? null, h300: v[3] ?? null });
    return [
      r("Net 1 s", "net of the reference move from 1 s after the fill", mk.all),
      r("Net 0.2 s", "net of the reference move from 0.2 s after the fill", mk.fast),
      r("Raw", "against the instrument's own mid only", mk.raw),
      r("Buys", "buys only, net 1 s", mk.buys),
      r("Sells", "sells only, net 1 s", mk.sells),
    ];
  }, [mk]);
  const tox = mk?.toxicity;
  const toxRows = useMemo<ToxRow[]>(
    () =>
      tox
        ? [
            { label: "D(h)", tip: TOX_DEF, v: tox.bps },
            { label: "Fills", tip: "Fills with a reference price at h", v: tox.fills },
          ]
        : [],
    [tox],
  );
  const toxKey = tox?.horizons_s.join(",") ?? "";
  const toxCols = useMemo<ColDef<ToxRow>[]>(() => {
    const hs = toxKey ? toxKey.split(",").map(Number) : [];
    return flexCols([
      { field: "label", headerName: "Toxicity", width: 84, tooltipField: "tip", sortable: false, headerTooltip: TOX_DEF },
      ...hs.map(
        (h, i): ColDef<ToxRow> => ({
          colId: `t${i}`,
          headerName: h === 0 ? "fill" : `${h} s`,
          type: "rightAligned",
          width: 56,
          sortable: false,
          valueGetter: (p) => p.data?.v[i] ?? null,
          valueFormatter: (p) => (p.data?.label === "Fills" ? int(p.value as number | null) : bps(p.value as number | null)),
          cellClass: (p) => (p.data?.label === "Fills" ? "num" : signCls(p)),
          cellStyle: (p) => (p.data?.label === "Fills" ? { backgroundColor: "transparent" } : tint(4)(p)),
        }),
      ),
    ]);
  }, [toxKey]);
  const hours = useMemo<HourRow[]>(() => (mk ? mk.by_hour.slice().sort((a, b) => a.hour - b.hour) : []), [mk]);
  const hzCols = useMemo<ColDef<HzRow>[]>(() => {
    const h = (field: "h1" | "h10" | "h60" | "h300", name: string, lim: number): ColDef<HzRow> => ({
      field, headerName: name, type: "rightAligned", width: 64, valueFormatter: fBps, cellClass: signCls, cellStyle: tint(lim),
    });
    return flexCols([
      { field: "label", headerName: "", width: 84, tooltipField: "tip", sortable: false },
      h("h1", "1 s", 3), h("h10", "10 s", 4), h("h60", "60 s", 6), h("h300", "300 s", 10),
    ]);
  }, []);
  const hourCols = useMemo<ColDef<HourRow>[]>(
    () =>
      flexCols([
        { field: "hour", headerName: "UTC", width: 56, valueFormatter: (p) => `${String(p.value).padStart(2, "0")}:00` },
        { field: "fills", headerName: "Fills", type: "rightAligned", width: 60, valueFormatter: fInt },
        { field: "mk10", headerName: "10 s", type: "rightAligned", width: 60, valueFormatter: fBps, cellClass: signCls, cellStyle: tint(4), headerTooltip: "Markout at 10 s, net 1 s, bps" },
        { field: "mk60", headerName: "60 s", type: "rightAligned", width: 60, valueFormatter: fBps, cellClass: signCls, cellStyle: tint(6), headerTooltip: "Markout at 60 s, net 1 s, bps" },
        { field: "pnl", headerName: "PnL 60 s", type: "rightAligned", width: 72, valueFormatter: fPnl, cellClass: signCls, headerTooltip: "60 s markout × notional, USDT: a diagnostic, not PnL" },
      ]),
    [],
  );
  return (
    <Panel
      className="curve-panel"
      title={
        <span title={MK_TIP}>
          Markouts <span className="title-unit">bps</span>
        </span>
      }
      bodyClass="mk-tables"
    >
      <div className="mk-stack">
        <AgGridReact<HzRow> theme={gridTheme} rowData={hz} columnDefs={hzCols} defaultColDef={DEFAULT_COL} getRowId={rowIdHz} suppressCellFocus tooltipShowDelay={300} />
        <AgGridReact<ToxRow> theme={gridTheme} rowData={toxRows} columnDefs={toxCols} defaultColDef={DEFAULT_COL} getRowId={rowIdTox} suppressCellFocus tooltipShowDelay={300} />
      </div>
      <AgGridReact<HourRow>
        theme={gridTheme}
        rowData={hours}
        columnDefs={hourCols}
        defaultColDef={DEFAULT_COL}
        getRowId={rowIdHour}
        suppressCellFocus
        tooltipShowDelay={300}
        overlayNoRowsTemplate="No fills today"
      />
    </Panel>
  );
}

// ---- per instrument ----

function SymbolMarkouts() {
  const rows = useStore((s) => s.snap?.symbols);
  const spot = useMemo(() => rows?.filter((r) => r.venue === "spot" && (r.fills_day > 0 || r.trading_pnl !== 0)) ?? [], [rows]);
  const cols = useMemo<(ColDef<SymbolRow> | ColGroupDef<SymbolRow>)[]>(() => {
    const n = (c: ColDef<SymbolRow>): ColDef<SymbolRow> => ({ type: "rightAligned", cellClass: "num", ...c });
    return [
      {
        field: "symbol",
        headerName: "Instrument",
        headerTooltip: "Spot instruments with fills or PnL today",
        width: 108,
        pinned: "left",
        cellRenderer: (p: { data?: SymbolRow }) => (p.data ? <InstrumentName symbol={p.data.symbol} venue={p.data.venue} /> : null),
      },
      { field: "reference", headerName: "Reference", headerTooltip: "Reference instrument the net markouts use", width: 100, valueFormatter: (p) => refLabel(p.value), cellClass: "muted" },
      n({ field: "fills_day", headerName: "Fills", headerTooltip: "Number of fills today", width: 48, valueFormatter: fInt }),
      {
        headerName: "PnL USDT",
        headerTooltip: "Today, USDT",
        children: [
          n({ field: "realized_pnl", headerName: "Realized", headerTooltip: "Sells matched FIFO to buys, incl. day-start inventory, minus fees, USDT", width: 72, valueFormatter: fPnl, cellClass: signCls, initialSort: "desc", ...flashOn(fPnl) }),
          n({ field: "float_pnl", headerName: "Float", headerTooltip: "Inventory left, at mid vs cost, USDT", width: 62, valueFormatter: fPnl, cellClass: signCls, ...flashOn(fPnl) }),
          n({ field: "volume_day", headerName: "Volume", headerTooltip: "Filled notional today, USDT", width: 70, valueFormatter: fUsd }),
          n({ field: "inv_value", headerName: "Inventory", headerTooltip: "Quantity held across accounts × mid, USDT", width: 74, valueFormatter: fUsd }),
        ],
      },
      {
        headerName: "Edge and markout bps",
        headerTooltip: "Diagnostics, not PnL. Volume-weighted over today's fills; markouts net of the reference move from 1 s after the fill, bps",
        children: [
          n({ field: "edge_bps", headerName: "Edge", headerTooltip: "Edge at fill: side × (fair − price) / fair, bps", width: 52, valueFormatter: fBps }),
          n({ field: "mk10_bps", headerName: "10 s", headerTooltip: "Markout 10 s after the fill, net 1 s, bps", width: 52, valueFormatter: fBps, cellStyle: tint(4) }),
          n({ field: "mk60_bps", headerName: "60 s", headerTooltip: "Markout 60 s after the fill, net 1 s, bps", width: 52, valueFormatter: fBps, cellStyle: tint(6) }),
          n({ field: "mk300_bps", headerName: "300 s", headerTooltip: "Markout 300 s after the fill, net 1 s, bps", width: 52, valueFormatter: fBps, cellStyle: tint(10) }),
        ],
      },
    ];
  }, []);
  const fitted = useMemo(() => flexCols(cols), [cols]);
  return (
    <Panel className="symmk-panel" title={<span title="Markouts net of the reference move from 1 s after the fill">By instrument, sorted by realized</span>} bodyClass="grid-body">
      <AgGridReact<SymbolRow>
        theme={gridTheme}
        rowData={spot}
        columnDefs={fitted}
        defaultColDef={DEFAULT_COL}
        getRowId={rowIdSymbol}
        suppressCellFocus
        animateRows={false}
        cellFlashDuration={200}
        cellFadeDuration={500}
        tooltipShowDelay={300}
      />
    </Panel>
  );
}

const rowIdSymbol = (p: GetRowIdParams<SymbolRow>) => `${p.data.venue}:${p.data.symbol}`;

export function Markouts() {
  return (
    <div className="page markouts">
      <MarkoutTables />
      <SymbolMarkouts />
    </div>
  );
}
