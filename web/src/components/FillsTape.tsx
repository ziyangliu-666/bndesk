import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AgGridReact } from "ag-grid-react";
import type { ColDef, ColGroupDef, GetRowIdParams, GridApi, GridReadyEvent, ICellRendererParams } from "ag-grid-community";
import { SegmentedControl } from "@mantine/core";
import { onFills, useStore } from "../store";
import type { Fill } from "../protocol";
import { gridTheme } from "../theme";
import { fBps, fTime, fUsd, tint, DEFAULT_COL } from "../grid";
import { price, qty } from "../format";
import { flashOn, flexCols } from "../grid";
import { Panel } from "./ui";

function SideCell(p: ICellRendererParams<Fill>) {
  const f = p.data;
  if (!f) return null;
  return (
    <span className={"side " + (f.side === "buy" ? "up" : "down")}>
      {f.side === "buy" ? "+ buy" : "− sell"}
      {!f.maker && <span className="sym-suffix"> taker</span>}
    </span>
  );
}

type Mode = "net" | "fast" | "raw";
const MODES: Record<Mode, { key: "mk" | "mk_fast" | "mk_raw"; basis: string }> = {
  net: { key: "mk", basis: "net of the reference move from 1 s after the fill to the horizon, where a reference exists" },
  fast: { key: "mk_fast", basis: "net of the reference move from 0.2 s after the fill to the horizon, where a reference exists" },
  raw: { key: "mk_raw", basis: "raw, without the reference adjustment" },
};

const rowIdFill = (p: GetRowIdParams<Fill>) => p.data.id;

export function FillsTape({ showAccount = true, title = "Fills" }: { showAccount?: boolean; title?: string }) {
  const api = useRef<GridApi<Fill> | null>(null);
  const [mode, setMode] = useState<Mode>("net");

  const cols = useMemo<(ColDef<Fill> | ColGroupDef<Fill>)[]>(() => {
    const n = (c: ColDef<Fill>): ColDef<Fill> => ({ type: "rightAligned", cellClass: "num", ...c });
    const key = MODES[mode].key;
    const basis = MODES[mode].basis;
    const mk = (h: "1" | "10" | "60" | "300", lim: number): ColDef<Fill> =>
      n({
        colId: `mk${h}`,
        headerName: `${h} s`,
        headerTooltip: `Markout ${h} s after the fill: side × (mid / price − 1), ${basis}, bps. Diagnostic, not PnL`,
        width: h === "1" ? 46 : 47,
        valueGetter: (p) => (p.data ? p.data[key][h] : null),
        valueFormatter: fBps,
        cellStyle: tint(lim),
        ...flashOn(fBps),
      });
    return [
      n({ field: "ts", headerName: "Time", width: 66, valueFormatter: fTime, initialSort: "desc", type: undefined, cellClass: "num", headerTooltip: "Fill time (exchange event time)" }),
      ...(showAccount ? [{ field: "account", headerName: "Acct", width: 48, headerTooltip: "Account" } as ColDef<Fill>] : []),
      { field: "symbol", headerName: "Symbol", width: 50, valueFormatter: (p) => String(p.value).replace(/USDT$/, ""), headerTooltip: "Base asset; quote is USDT" },
      // fixed, wide enough for "− sell taker"; the leftover width goes to the other columns
      { field: "side", headerName: "Side", width: 80, minWidth: 80, flex: 0, resizable: false, cellRenderer: SideCell, headerTooltip: "Own side of the fill; taker fills are marked, the rest are maker" },
      n({
        field: "notional",
        headerName: "Notional",
        width: 54,
        valueFormatter: fUsd,
        headerTooltip: "Price × quantity, USDT; hover a cell for the price and quantity",
        tooltipValueGetter: (p) => (p.data ? `${qty(p.data.qty)} at ${price(p.data.price)} USDT` : undefined),
      }),
      {
        headerName: "Edge and markout bps",
        headerTooltip: `Edge at fill vs fair, and markouts after the fill (${basis}), bps.`,
        children: [
          n({ field: "edge_bps", headerName: "Edge", width: 42, valueFormatter: fBps, headerTooltip: "Edge at fill: side × (fair − price) / fair, bps" }),
          mk("1", 3),
          mk("10", 4),
          mk("60", 6),
          mk("300", 10),
        ],
      },
    ];
  }, [mode, showAccount]);
  const fitted = useMemo(() => flexCols(cols), [cols]);

  const onReady = useCallback((e: GridReadyEvent<Fill>) => {
    api.current = e.api;
    e.api.setGridOption("rowData", useStore.getState().snap?.fills ?? []);
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
    <Panel
      className="fills-panel"
      title={title}
      right={
        <>
          <SegmentedControl
            size="xs"
            value={mode}
            onChange={(v) => setMode(v as Mode)}
            data={[
              { value: "net", label: "net 1 s" },
              { value: "fast", label: "net 0.2 s" },
              { value: "raw", label: "raw" },
            ]}
            title={`Markout basis: ${MODES[mode].basis}`}
            className="mini-seg"
            aria-label="Markout basis"
          />
        </>
      }
      bodyClass="grid-body"
    >
      <AgGridReact<Fill>
        theme={gridTheme}
        columnDefs={fitted}
        defaultColDef={DEFAULT_COL}
        getRowId={rowIdFill}
        onGridReady={onReady}
        asyncTransactionWaitMillis={100}
        suppressCellFocus
        animateRows={false}
        cellFlashDuration={350}
        cellFadeDuration={650}
        tooltipShowDelay={300}
      />
    </Panel>
  );
}
