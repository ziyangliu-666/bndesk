// The Desk's Open orders tab: every resting order of ours, in an exchange's column order (Time, Symbol, Side,
// Price, Amount, Notional, Dist(bps), Account). A click picks the instrument; `symbol` keeps one instrument's.
import { useEffect, useMemo, useRef } from "react";
import { AgGridReact } from "ag-grid-react";
import type { ColDef, GetRowIdParams, GridApi, ICellRendererParams, RowClickedEvent } from "ag-grid-community";
import { selectInstrument, useStore, type Instrument } from "../../store";
import type { OpenOrder } from "../../protocol";
import { gridTheme } from "../../gridTheme";
import { fBpsU, fPrice, fTime, fUsd, DEFAULT_COL, flexCols } from "../../grid";
import { qty } from "../../format";
import { MASK } from "./mask";

const rowId = (p: GetRowIdParams<OpenOrder>) => p.data.id;
const masked = (f: (p: { value: unknown }) => string) => (p: { value: unknown }) => (useStore.getState().hideAmounts ? MASK : f(p));

function cols(): ColDef<OpenOrder>[] {
  const n = (c: ColDef<OpenOrder>): ColDef<OpenOrder> => ({ type: "rightAligned", cellClass: "num", ...c });
  return [
    { field: "since", headerName: "Time", width: 72, valueFormatter: (p) => (p.value == null ? "--" : fTime(p)), cellClass: "fig", headerTooltip: "When the order was placed" },
    {
      field: "symbol",
      headerName: "Symbol",
      width: 110,
      cellRenderer: (p: ICellRendererParams<OpenOrder>) =>
        p.data ? (
          <span className="sym">
            {p.data.symbol}
            {p.data.venue === "usdm" && <span className="dk-tag">Perp</span>}
          </span>
        ) : null,
    },
    {
      field: "side",
      headerName: "Side",
      width: 60,
      cellRenderer: (p: ICellRendererParams<OpenOrder>) => (p.data ? <span className={p.data.side === "buy" ? "up" : "down"}>{p.data.side === "buy" ? "Buy" : "Sell"}</span> : null),
    },
    n({ field: "price", headerName: "Price", width: 90, valueFormatter: fPrice }),
    n({ field: "qty", headerName: "Amount", width: 90, valueFormatter: masked((p) => qty(p.value as number)), headerTooltip: "Base-asset units" }),
    n({ field: "notional", headerName: "Notional", width: 84, valueFormatter: masked(fUsd as never), headerTooltip: "Price × amount, USDT" }),
    n({
      field: "dist_bps",
      headerName: "Dist(bps)",
      width: 76,
      valueFormatter: fBpsU,
      cellClassRules: { "warn-text": (p) => p.value != null && (p.value as number) < 0 },
      headerTooltip: "Distance from fair, bps; through fair (negative) in amber",
      initialSort: "asc",
    }),
    { field: "account", headerName: "Account", width: 80 },
  ];
}

export function OrdersGrid({ symbol = null }: { symbol?: Instrument | null }) {
  const all = useStore((s) => s.snap?.orders);
  const hide = useStore((s) => s.hideAmounts);
  const api = useRef<GridApi<OpenOrder> | null>(null);
  const rows = useMemo(() => (symbol ? (all ?? []).filter((o) => o.symbol === symbol.symbol && o.venue === symbol.venue) : (all ?? [])), [all, symbol]);
  const c = useMemo(() => flexCols(cols()), []);
  useEffect(() => {
    api.current?.refreshCells({ force: true, columns: ["qty", "notional"] });
  }, [hide]);
  return (
    <AgGridReact<OpenOrder>
      theme={gridTheme}
      rowData={rows}
      columnDefs={c}
      defaultColDef={DEFAULT_COL}
      getRowId={rowId}
      onGridReady={(e) => (api.current = e.api)}
      onGridPreDestroyed={() => (api.current = null)}
      onRowClicked={(e: RowClickedEvent<OpenOrder>) => e.data && selectInstrument({ symbol: e.data.symbol, venue: e.data.venue })}
      overlayNoRowsTemplate='<span class="muted">No open orders</span>'
      animateRows={false}
      suppressCellFocus
      tooltipShowDelay={300}
    />
  );
}
