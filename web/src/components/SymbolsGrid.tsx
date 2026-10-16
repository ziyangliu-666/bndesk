// The Desk's Inventory tab: every tracked instrument on one row, flat columns (no group expanders, no heat
// tints), a total row; a click picks the instrument. Money masks with Hide amounts.
import { useEffect, useMemo, useRef } from "react";
import { AgGridReact } from "ag-grid-react";
import type { ColDef, GetRowIdParams, GridApi, ICellRendererParams, RowClickedEvent, ValueFormatterParams } from "ag-grid-community";
import { selectInstrument, useStore, type Instrument } from "../store";
import type { SymbolRow } from "../protocol";
import { gridTheme } from "../gridTheme";
import { fAge, fBps, fBpsU, fInt, fPnl, fPrice, fQtyS, fUsd, signCls, DEFAULT_COL } from "../grid";
import { flashOn, flexCols } from "../grid";
import { refLabel } from "./ui";
import { MASK } from "../pages/desk/mask";

type Row = SymbolRow & { _total?: boolean };

function SymbolCell(p: ICellRendererParams<Row>) {
  const r = p.data;
  if (!r) return null;
  if (r._total) return <span className="sym total">Total</span>;
  const tip = [r.reference != null ? `reference ${refLabel(r.reference)}` : "", r.dust ? "balance below min notional" : ""].filter(Boolean).join("; ");
  return (
    <span className={"sym" + (r.dust ? " dust" : "")} title={tip || undefined}>
      {r.symbol}
      {r.venue === "usdm" && <span className="dk-tag">Perp</span>}
    </span>
  );
}

const absDesc = (a: number | null, b: number | null) => Math.abs(a ?? 0) - Math.abs(b ?? 0);

function totals(rows: SymbolRow[]): Row {
  let inv = 0;
  let fills = 0;
  let vol = 0;
  let tp = 0;
  let mp = 0;
  let ip = 0;
  let bids = 0;
  let asks = 0;
  const w = { mk10: [0, 0], edge: [0, 0] };
  for (const r of rows) {
    inv += r.venue === "spot" ? r.inv_value : 0;
    fills += r.fills_day;
    vol += r.volume_day;
    tp += r.trading_pnl;
    mp += r.mm_pnl;
    ip += r.inv_pnl;
    bids += r.open_bids;
    asks += r.open_asks;
    const acc = (k: keyof typeof w, x: number | null) => {
      if (x != null) {
        w[k][0]! += x * r.volume_day;
        w[k][1]! += r.volume_day;
      }
    };
    acc("mk10", r.mk10_bps);
    acc("edge", r.edge_bps);
  }
  const avg = (k: keyof typeof w) => (w[k][1]! > 0 ? w[k][0]! / w[k][1]! : null);
  return {
    _total: true,
    symbol: "Total",
    venue: "spot",
    reference: null,
    mid: null,
    ref_mid: null,
    spread_bps: null,
    basis_bps: null,
    inv_qty: NaN,
    inv_value: inv,
    avg_cost: null,
    upnl: null,
    fills_day: fills,
    buys_day: 0,
    sells_day: 0,
    volume_day: vol,
    edge_bps: avg("edge"),
    mk10_bps: avg("mk10"),
    mk60_bps: null,
    mk300_bps: null,
    trading_pnl: tp,
    hedged_pnl: 0,
    realized_pnl: 0,
    float_pnl: 0,
    mm_pnl: mp,
    inv_pnl: ip,
    open_bids: bids,
    open_asks: asks,
    bid_dist_bps: null,
    ask_dist_bps: null,
    last_fill: null,
    dust: false,
    fair: null,
    bid: null,
    ask: null,
  };
}

const rowIdSymbol = (p: GetRowIdParams<Row>) => `${p.data.venue}:${p.data.symbol}`;

type VF = (p: ValueFormatterParams<Row>) => string;
/** Money: masked while Hide amounts is on (the grid refreshes its cells when it flips). */
const money = (f: VF): VF => (p) => (useStore.getState().hideAmounts ? MASK : f(p));
const blankTotal = (f: VF): VF => (p) => (p.data?._total ? "" : f(p));

function columns(): ColDef<Row>[] {
  const n = (c: ColDef<Row>): ColDef<Row> => ({ type: "rightAligned", cellClass: "num", ...c });
  return [
    {
      field: "symbol",
      headerName: "Symbol",
      headerTooltip: "Perp = USD-M perpetual. Muted rows: balance below min notional (dust). Hover a symbol for its reference",
      pinned: "left",
      width: 128,
      cellRenderer: SymbolCell,
    },
    n({ field: "inv_qty", headerName: "Inventory", width: 92, valueFormatter: money(blankTotal(fQtyS as VF)), cellClass: signCls, headerTooltip: "Quantity held, free + locked, base-asset units" }),
    n({ field: "inv_value", headerName: "Value", width: 84, valueFormatter: money(fUsd as VF), comparator: absDesc, initialSort: "desc", headerTooltip: "Quantity × mid, USDT; sorted by size. The total counts spot only" }),
    n({ field: "avg_cost", headerName: "Avg cost", width: 86, valueFormatter: fPrice, headerTooltip: "Average cost from today's fills, USDT per unit" }),
    n({ field: "mid", headerName: "Mid", width: 86, valueFormatter: fPrice, headerTooltip: "(best bid + best ask) / 2, USDT" }),
    n({ field: "trading_pnl", headerName: "Day PnL", width: 74, valueFormatter: money(fPnl as VF), cellClass: signCls, headerTooltip: "Trading PnL today (Π), USDT", ...flashOn(fPnl) }),
    n({ field: "mm_pnl", headerName: "Market making", width: 96, valueFormatter: money(fPnl as VF), cellClass: signCls, headerTooltip: "Each fill against the mid 60 s later, minus fees, USDT" }),
    n({ field: "inv_pnl", headerName: "Inventory PnL", width: 96, valueFormatter: money(fPnl as VF), cellClass: signCls, headerTooltip: "Trading PnL minus market making, USDT" }),
    n({ field: "fills_day", headerName: "Fills", width: 56, valueFormatter: fInt, headerTooltip: "Fills today", ...flashOn(fInt) }),
    n({ field: "volume_day", headerName: "Volume", width: 74, valueFormatter: money(fUsd as VF), headerTooltip: "Filled notional today, USDT" }),
    n({ field: "edge_bps", headerName: "Edge", width: 56, valueFormatter: fBps, headerTooltip: "Edge at fill: side × (fair − price) / fair, volume-weighted, bps" }),
    n({ field: "mk10_bps", headerName: "Markout 10 s", width: 86, valueFormatter: fBps, headerTooltip: "10 s after the fill, net of the reference move, volume-weighted, bps. Diagnostic, not PnL" }),
    n({
      colId: "orders",
      headerName: "Bids / Asks",
      width: 80,
      valueGetter: (p) => (p.data ? `${p.data.open_bids} / ${p.data.open_asks}` : ""),
      headerTooltip: "Our open bid / ask orders",
    }),
    n({ field: "spread_bps", headerName: "Spread", width: 60, valueFormatter: fBpsU, headerTooltip: "(ask − bid) / mid, bps" }),
    n({ field: "last_fill", headerName: "Last fill", width: 66, valueFormatter: blankTotal(fAge as VF), headerTooltip: "Time since the last fill" }),
  ];
}

const DUST_ROW = { "dust-row": (p: { data?: Row }) => !!p.data?.dust && !p.data._total, "dk-sel-row": () => false };

/** The Inventory tab. `hideDust` leaves out balances below the min notional with no fills today. */
export function SymbolsGrid({ selected, hideDust = false }: { selected?: Instrument | null; hideDust?: boolean }) {
  const all = useStore((s) => s.snap?.symbols);
  const hide = useStore((s) => s.hideAmounts);
  const api = useRef<GridApi<Row> | null>(null);
  useEffect(() => {
    const id = setInterval(() => api.current?.refreshCells({ columns: ["last_fill"] }), 1000);
    return () => clearInterval(id);
  }, []);
  useEffect(() => {
    api.current?.refreshCells({ force: true });
  }, [hide]);
  const rows = useMemo(() => (hideDust ? (all ?? []).filter((r) => !r.dust || r.fills_day > 0) : (all ?? [])), [all, hideDust]);
  const cols = useMemo(() => flexCols(columns()), []);
  const pinned = useMemo(() => (rows.length ? [totals(rows)] : []), [rows]);
  const selKey = selected ? `${selected.venue}:${selected.symbol}` : "";
  const rules = useMemo(
    () => ({ ...DUST_ROW, "dk-sel-row": (p: { data?: Row }) => !!p.data && !p.data._total && `${p.data.venue}:${p.data.symbol}` === selKey }),
    [selKey],
  );
  useEffect(() => {
    const a = api.current;
    if (!a) return;
    a.redrawRows();
    const node = selKey ? a.getRowNode(selKey) : undefined;
    if (node) a.ensureNodeVisible(node, "middle");
  }, [selKey]);

  return (
    <AgGridReact<Row>
      theme={gridTheme}
      rowData={rows}
      columnDefs={cols}
      defaultColDef={DEFAULT_COL}
      getRowId={rowIdSymbol}
      pinnedBottomRowData={pinned}
      rowClassRules={rules}
      onGridReady={(e) => (api.current = e.api)}
      onGridPreDestroyed={() => (api.current = null)}
      onRowClicked={(e: RowClickedEvent<Row>) => e.data && !e.data._total && selectInstrument({ symbol: e.data.symbol, venue: e.data.venue })}
      animateRows={false}
      suppressCellFocus
      cellFlashDuration={200}
      cellFadeDuration={500}
      tooltipShowDelay={300}
      enableBrowserTooltips={false}
    />
  );
}
