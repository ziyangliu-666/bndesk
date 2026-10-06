import { useEffect, useMemo, useRef, useState } from "react";
import { AgGridReact } from "ag-grid-react";
import type { ColDef, ColGroupDef, GetRowIdParams, GridApi, ICellRendererParams } from "ag-grid-community";
import { TextInput } from "@mantine/core";
import { useElementSize } from "@mantine/hooks";
import { IconSearch } from "@tabler/icons-react";
import { useStore } from "../store";
import type { SymbolRow } from "../protocol";
import { gridTheme } from "../theme";
import { fAge, fBps, fBpsU, fInt, fPnl, fPrice, fQtyS, fUsd, signCls, tint, DEFAULT_COL } from "../grid";
import { flashOn, flexCols } from "../grid";
import { Panel, refLabel } from "./ui";

type Row = SymbolRow & { _total?: boolean };

function SymbolCell(p: ICellRendererParams<Row>) {
  const r = p.data;
  if (!r) return null;
  if (r._total) return <span className="sym total">Total</span>;
  const tip = [r.reference != null ? `reference ${refLabel(r.reference)}` : "", r.dust ? "balance below min notional" : ""]
    .filter(Boolean)
    .join("; ");
  return (
    <span className={"sym" + (r.dust ? " dust" : "")} title={tip || undefined}>
      {r.symbol}
      {r.venue === "usdm" && <span className="sym-suffix">perp</span>}
    </span>
  );
}

const absDesc = (a: number | null, b: number | null) => Math.abs(a ?? 0) - Math.abs(b ?? 0);

function totals(rows: SymbolRow[]): Row {
  let inv = 0;
  let upnl = 0;
  let fills = 0;
  let buys = 0;
  let sells = 0;
  let vol = 0;
  let tp = 0;
  let hp = 0;
  let mp = 0;
  let ip = 0;
  let bids = 0;
  let asks = 0;
  const w = { mk10: [0, 0], mk60: [0, 0], mk300: [0, 0], edge: [0, 0] };
  for (const r of rows) {
    inv += r.venue === "spot" ? r.inv_value : 0;
    upnl += r.upnl ?? 0;
    fills += r.fills_day;
    buys += r.buys_day;
    sells += r.sells_day;
    vol += r.volume_day;
    tp += r.trading_pnl;
    hp += r.hedged_pnl;
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
    acc("mk60", r.mk60_bps);
    acc("mk300", r.mk300_bps);
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
    upnl,
    fills_day: fills,
    buys_day: buys,
    sells_day: sells,
    volume_day: vol,
    edge_bps: avg("edge"),
    mk10_bps: avg("mk10"),
    mk60_bps: avg("mk60"),
    mk300_bps: avg("mk300"),
    trading_pnl: tp,
    hedged_pnl: hp,
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

type Cols = (ColDef<Row> | ColGroupDef<Row>)[];

/** Columns that show when there is room, most useful first; the rest wait behind their group's expander. */
const OPTIONAL: { field: string; width: number }[] = [
  { field: "mk300_bps", width: 56 },
  { field: "volume_day", width: 74 },
  { field: "last_fill", width: 60 },
  { field: "spread_bps", width: 58 },
  { field: "bid_dist_bps", width: 58 },
  { field: "ask_dist_bps", width: 58 },
  { field: "basis_bps", width: 58 },
];

function columns(shown: Set<string>): Cols {
  const opt = (f: string) => (shown.has(f) ? undefined : ("open" as const));
  const n = (c: ColDef<Row>): ColDef<Row> => ({ type: "rightAligned", cellClass: "num", ...c });
  return [
    {
      field: "symbol",
      headerName: "Instrument",
      headerTooltip: "Symbol; perp = USD-M perpetual. Muted rows: balance below min notional (dust). Hover a symbol for its reference",
      pinned: "left",
      width: 140,
      cellRenderer: SymbolCell,
      getQuickFilterText: (p) => `${p.data?.symbol} ${p.data?.venue}`,
    },
    {
      headerName: "Inventory",
      headerTooltip: "Holdings across accounts; value and PnL in USDT, quantity in base-asset units",
      children: [
        n({
          field: "inv_value",
          headerName: "Value",
          width: 80,
          valueFormatter: fUsd,
          comparator: absDesc,
          initialSort: "desc",
          headerTooltip: "Quantity × mid, USDT; sorted by absolute value. Total counts spot only",
        }),
        n({ field: "inv_qty", headerName: "Qty", width: 92, valueFormatter: (p) => (p.data?._total ? "" : fQtyS(p)), cellClass: signCls, headerTooltip: "Quantity held, free + locked, base-asset units", columnGroupShow: "open" }),
        n({ field: "avg_cost", headerName: "Avg cost", width: 88, valueFormatter: fPrice, headerTooltip: "Average cost from today's fills, USDT per unit", columnGroupShow: "open" }),
      ],
    },
    {
      headerName: "PnL USDT",
      headerTooltip: "Today's spot P&L per name, USDT",
      children: [
        n({ field: "mm_pnl", headerName: "MM", width: 64, valueFormatter: fPnl, cellClass: signCls, headerTooltip: "Market making: each fill against the mid 60 s later, minus fees, USDT", ...flashOn(fPnl) }),
        n({ field: "inv_pnl", headerName: "Inventory", width: 76, valueFormatter: fPnl, cellClass: signCls, headerTooltip: "Trading PnL minus market making: what the held inventory made after those 60 s, USDT", ...flashOn(fPnl) }),
      ],
    },
    {
      headerName: "Fills",
      headerTooltip: "Since the day start; volume in USDT",
      children: [
        n({ field: "fills_day", headerName: "Fills", width: 56, valueFormatter: fInt, headerTooltip: "Number of fills today", ...flashOn(fInt) }),
        n({ field: "buys_day", headerName: "Buys", width: 58, valueFormatter: fInt, headerTooltip: "Number of buy fills today", columnGroupShow: "open" }),
        n({ field: "sells_day", headerName: "Sells", width: 58, valueFormatter: fInt, headerTooltip: "Number of sell fills today", columnGroupShow: "open" }),
        n({ field: "volume_day", headerName: "Volume", width: 74, valueFormatter: fUsd, headerTooltip: "Filled notional today, USDT", columnGroupShow: opt("volume_day") }),
        n({ field: "last_fill", headerName: "Last", width: 60, valueFormatter: fAge, headerTooltip: "Time since the last fill", columnGroupShow: opt("last_fill") }),
      ],
    },
    {
      headerName: "Markout bps",
      headerTooltip: "Diagnostics, not PnL. Volume-weighted over today's fills, net of the reference move from 1 s after the fill where a reference exists, bps",
      children: [
        n({ field: "edge_bps", headerName: "Edge", width: 54, valueFormatter: fBps, headerTooltip: "Edge at fill: side × (fair − price) / fair, bps" }),
        n({ field: "mk10_bps", headerName: "10 s", width: 54, valueFormatter: fBps, cellStyle: tint(4), headerTooltip: "Markout 10 s after the fill: side × (mid(t+10 s) / price − 1) − side × (ref(t+10 s) / ref(t+1 s) − 1), bps", ...flashOn(fBps) }),
        n({ field: "mk60_bps", headerName: "60 s", width: 54, valueFormatter: fBps, cellStyle: tint(6), headerTooltip: "Markout 60 s after the fill, net of the reference move from 1 s after the fill, bps", ...flashOn(fBps) }),
        n({ field: "mk300_bps", headerName: "300 s", width: 56, columnGroupShow: opt("mk300_bps"), valueFormatter: fBps, cellStyle: tint(10), headerTooltip: "Markout 300 s after the fill, net of the reference move from 1 s after the fill, bps", ...flashOn(fBps) }),
      ],
    },
    {
      headerName: "Quotes",
      headerTooltip: "Own resting orders; distances in bps from fair",
      children: [
        n({
          colId: "orders",
          headerName: "Bid / ask",
          width: 72,
          valueGetter: (p) => (p.data ? `${p.data.open_bids} / ${p.data.open_asks}` : ""),
          headerTooltip: "Number of open bid / ask orders",
        }),
        n({ field: "bid_dist_bps", headerName: "Bid dist", width: 58, valueFormatter: fBpsU, headerTooltip: "Best own bid below fair: (fair − bid) / fair, bps", columnGroupShow: opt("bid_dist_bps") }),
        n({ field: "ask_dist_bps", headerName: "Ask dist", width: 58, valueFormatter: fBpsU, headerTooltip: "Best own ask above fair: (ask − fair) / fair, bps", columnGroupShow: opt("ask_dist_bps") }),
      ],
    },
    {
      headerName: "Market",
      headerTooltip: "Market prices in USDT, spread and basis in bps",
      children: [
        n({ field: "mid", headerName: "Mid", width: 84, valueFormatter: fPrice, headerTooltip: "Mid: (best bid + best ask) / 2, USDT" }),
        n({ field: "spread_bps", headerName: "Spread", width: 58, valueFormatter: fBpsU, headerTooltip: "Spread: (ask − bid) / mid, bps", columnGroupShow: opt("spread_bps") }),
        n({ field: "basis_bps", headerName: "Basis", width: 58, valueFormatter: fBps, headerTooltip: "Basis: mid / reference mid − 1, bps", columnGroupShow: opt("basis_bps") }),
        n({ field: "ref_mid", headerName: "Ref mid", width: 92, valueFormatter: fPrice, headerTooltip: "Mid of the reference instrument, USDT", columnGroupShow: "open" }),
      ],
    },
  ];
}

/** Width the columns shown with every group closed need, px. */
function shownWidth(cols: Cols): number {
  let w = 0;
  for (const c of cols) {
    if ("children" in c) w += shownWidth(c.children as Cols);
    else if (c.columnGroupShow !== "open") w += c.width ?? 0;
  }
  return w;
}

const SCROLLBAR = 14;
const DUST_ROW = { "dust-row": (p: { data?: Row }) => !!p.data?.dust && !p.data._total };

/** As many columns as the panel holds, in order of use; the others sit behind their group's expander
 *  instead of running past the panel's edge, and no column is stretched. */
export function SymbolsGrid() {
  const rows = useStore((s) => s.snap?.symbols);
  const { ref: box, width } = useElementSize();
  const [q, setQ] = useState("");
  const api = useRef<GridApi<Row> | null>(null);
  useEffect(() => {
    const id = setInterval(() => api.current?.refreshCells({ columns: ["last_fill"] }), 1000);
    return () => clearInterval(id);
  }, []);

  // the core columns, then each optional one while it still fits; spare width goes to the names
  const shown = useMemo(() => {
    const out = new Set<string>();
    let w = shownWidth(columns(out)) + SCROLLBAR;
    for (const o of OPTIONAL) {
      if (width > 0 && w + o.width > width) break;
      out.add(o.field);
      w += o.width;
    }
    return out;
  }, [width]);
  const key = [...shown].join(",");
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const cols = useMemo(() => columns(shown), [key]);
  // with every column showing, the little width left is shared out; before that nothing stretches
  const all = shown.size === OPTIONAL.length;
  const fitted = useMemo(() => (all ? flexCols(cols) : cols), [cols, all]);

  const pinned = useMemo(() => (rows ? [totals(rows)] : []), [rows]);
  const count = rows?.length ?? 0;
  const held = rows?.filter((r) => Math.abs(r.inv_value) >= 1).length ?? 0;

  return (
    <Panel
      className="symbols-panel"
      title="Instruments"
      right={
        <>
          <span className="muted fig" title={`${count} instruments tracked`}>
            {held} held
          </span>
          <TextInput
            size="xs"
            placeholder="Filter"
            value={q}
            onChange={(e) => setQ(e.currentTarget.value)}
            leftSection={<IconSearch size={12} />}
            className="quick-filter"
            aria-label="Filter instruments"
          />
        </>
      }
      bodyClass="grid-body"
    >
      <div ref={box} className="grid-fill">
        <AgGridReact<Row>
          theme={gridTheme}
          rowData={rows ?? []}
          columnDefs={fitted}
          defaultColDef={DEFAULT_COL}
          getRowId={rowIdSymbol}
          pinnedBottomRowData={pinned}
          rowClassRules={DUST_ROW}
          quickFilterText={q}
          onGridReady={(e) => (api.current = e.api)}
          animateRows={false}
          suppressCellFocus
          cellFlashDuration={200}
          cellFadeDuration={500}
          tooltipShowDelay={300}
          enableBrowserTooltips={false}
        />
      </div>
    </Panel>
  );
}
