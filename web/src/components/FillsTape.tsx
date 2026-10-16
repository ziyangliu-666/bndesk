// The Desk's Fills tab: today's fills, newest first, in an exchange's trade-history column order (Time, Symbol,
// Side, Price, Qty, Notional, Account), then edge and markouts without heat tints. A click picks the instrument;
// `symbol` keeps one instrument's rows. Money masks with Hide amounts.
import { useCallback, useEffect, useMemo, useRef } from "react";
import { AgGridReact } from "ag-grid-react";
import type { ColDef, GetRowIdParams, GridApi, GridReadyEvent, ICellRendererParams, IRowNode, RowClickedEvent } from "ag-grid-community";
import { onFills, selectInstrument, useStore, type Instrument } from "../store";
import type { Fill } from "../protocol";
import { gridTheme } from "../gridTheme";
import { fBps, fPrice, fTime, fUsd, DEFAULT_COL } from "../grid";
import { qty } from "../format";
import { flashOn, flexCols } from "../grid";
import { MASK } from "../pages/desk/mask";
import type { Option } from "./ex";

function SideCell(p: ICellRendererParams<Fill>) {
  const f = p.data;
  if (!f) return null;
  return (
    <span className={f.side === "buy" ? "up" : "down"}>
      {f.side === "buy" ? "Buy" : "Sell"}
      {!f.maker && <span className="muted"> taker</span>}
    </span>
  );
}

export type MarkoutBasis = "net" | "fast" | "raw";
const MODES: Record<MarkoutBasis, { key: "mk" | "mk_fast" | "mk_raw"; basis: string }> = {
  net: { key: "mk", basis: "net of the reference move from 1 s after the fill to the horizon, where a reference exists" },
  fast: { key: "mk_fast", basis: "net of the reference move from 0.2 s after the fill to the horizon, where a reference exists" },
  raw: { key: "mk_raw", basis: "raw, without the reference adjustment" },
};
/** The markout basis toggle's options (a TextToggle in the panel's tab row). */
export const MARKOUT_BASIS: Option<MarkoutBasis>[] = [
  { value: "net", label: "Net 1 s", title: `Markouts ${MODES.net.basis}` },
  { value: "fast", label: "Net 0.2 s", title: `Markouts ${MODES.fast.basis}` },
  { value: "raw", label: "Raw", title: `Markouts ${MODES.raw.basis}` },
];

const rowIdFill = (p: GetRowIdParams<Fill>) => p.data.id;
const masked = (f: (p: { value: unknown }) => string) => (p: { value: unknown }) => (useStore.getState().hideAmounts ? MASK : f(p));

export function FillsTape({ mode = "net", symbol = null }: { mode?: MarkoutBasis; symbol?: Instrument | null }) {
  const api = useRef<GridApi<Fill> | null>(null);
  const hide = useStore((s) => s.hideAmounts);

  const cols = useMemo<ColDef<Fill>[]>(() => {
    const n = (c: ColDef<Fill>): ColDef<Fill> => ({ type: "rightAligned", cellClass: "num", ...c });
    const key = MODES[mode].key;
    const basis = MODES[mode].basis;
    const mk = (h: "1" | "10" | "60" | "300"): ColDef<Fill> =>
      n({
        colId: `mk${h}`,
        headerName: `${h} s`,
        headerTooltip: `Markout ${h} s after the fill: side × (mid / price − 1), ${basis}, bps. Diagnostic, not PnL`,
        width: 52,
        valueGetter: (p) => (p.data ? p.data[key][h] : null),
        valueFormatter: fBps,
        ...flashOn(fBps),
      });
    return [
      { field: "ts", headerName: "Time", width: 72, valueFormatter: fTime, initialSort: "desc", cellClass: "fig", headerTooltip: "Fill time (exchange event time)" },
      {
        field: "symbol",
        headerName: "Symbol",
        width: 104,
        cellRenderer: (p: ICellRendererParams<Fill>) =>
          p.data ? (
            <span className="sym">
              {p.data.symbol}
              {p.data.venue === "usdm" && <span className="dk-tag">Perp</span>}
            </span>
          ) : null,
      },
      { field: "side", headerName: "Side", width: 78, cellRenderer: SideCell, headerTooltip: "Our side; taker fills are marked, the rest are maker" },
      n({ field: "price", headerName: "Price", width: 84, valueFormatter: fPrice }),
      n({ field: "qty", headerName: "Qty", width: 80, valueFormatter: masked((p) => qty(p.value as number)), headerTooltip: "Base-asset units" }),
      n({ field: "notional", headerName: "Notional", width: 76, valueFormatter: masked(fUsd as never), headerTooltip: "Price × quantity, USDT" }),
      { field: "account", headerName: "Account", width: 70 },
      n({ field: "edge_bps", headerName: "Edge", width: 54, valueFormatter: fBps, headerTooltip: "Edge at fill: side × (fair − price) / fair, bps" }),
      mk("1"),
      mk("10"),
      mk("60"),
      mk("300"),
    ];
  }, [mode]);
  const fitted = useMemo(() => flexCols(cols), [cols]);

  const symRef = useRef(symbol);
  symRef.current = symbol;
  const onReady = useCallback((e: GridReadyEvent<Fill>) => {
    api.current = e.api;
    e.api.setGridOption("rowData", useStore.getState().snap?.fills ?? []);
  }, []);
  useEffect(() => {
    api.current?.onFilterChanged();
  }, [symbol]);
  useEffect(() => {
    api.current?.refreshCells({ force: true, columns: ["qty", "notional"] });
  }, [hide]);
  const isFiltered = useCallback(() => symRef.current != null, []);
  const passes = useCallback((n: IRowNode<Fill>) => {
    const s = symRef.current;
    return !s || (n.data?.symbol === s.symbol && n.data.venue === s.venue);
  }, []);

  useEffect(
    () =>
      onFills((ev) => {
        const a = api.current;
        if (!a) return;
        if (ev.kind === "reset") a.setGridOption("rowData", ev.fills);
        else a.applyTransactionAsync({ add: ev.add, update: ev.update, remove: ev.remove });
      }),
    [],
  );

  return (
    <AgGridReact<Fill>
      theme={gridTheme}
      columnDefs={fitted}
      defaultColDef={DEFAULT_COL}
      getRowId={rowIdFill}
      onGridReady={onReady}
      onGridPreDestroyed={() => (api.current = null)}
      isExternalFilterPresent={isFiltered}
      doesExternalFilterPass={passes}
      onRowClicked={(e: RowClickedEvent<Fill>) => e.data && selectInstrument({ symbol: e.data.symbol, venue: e.data.venue })}
      asyncTransactionWaitMillis={100}
      suppressCellFocus
      animateRows={false}
      cellFlashDuration={350}
      cellFadeDuration={650}
      tooltipShowDelay={300}
    />
  );
}
