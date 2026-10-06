import { useMemo } from "react";
import { AgGridReact } from "ag-grid-react";
import type { ColDef, GetRowIdParams, ICellRendererParams } from "ag-grid-community";
import { useStore } from "../store";
import type { Account } from "../protocol";
import { gridTheme } from "../theme";
import { fAge, fInt, fPnl, fUsd, signCls, DEFAULT_COL } from "../grid";
import { flexCols } from "../grid";
import { int, num, pct, usd } from "../format";
import { Meter, StateTag } from "./ui";

type Row = Account & { _total?: boolean };

function AccountCell(p: ICellRendererParams<Row>) {
  const a = p.data;
  if (!a) return null;
  if (a._total) return <span className="sym total">Total</span>;
  return (
    <span className="sym" title={a.email}>
      {a.label}
      {a.role === "master" && <span className="sym-suffix">master</span>}
    </span>
  );
}

function MeterCell(kind: "10s" | "1d") {
  return function Cell(p: ICellRendererParams<Row>) {
    const a = p.data;
    if (!a || a._total) return null;
    const v = kind === "10s" ? a.orders_10s : a.orders_1d;
    const l = kind === "10s" ? a.orders_10s_limit : a.orders_1d_limit;
    if (!l) return <span className="muted">—</span>;
    const r = v / l;
    return (
      <span className="meter-cell" title={`${int(v)} of ${int(l)} orders${kind === "10s" ? " in the last 10 s" : " today"} (${pct(r, 1)})`}>
        <Meter value={v} limit={l} />
        <span className={"fig meter-num " + (r > 0.8 ? "warn-text" : "")}>
          {kind === "10s" ? `${v}/${l}` : pct(r, 0)}
        </span>
      </span>
    );
  };
}
function UtilCell(p: ICellRendererParams<Row>) {
  const a = p.data;
  if (!a || a._total) return null;
  if (a.utilization == null || !Number.isFinite(a.utilization)) return <span className="muted">—</span>;
  const r = a.utilization;
  return (
    <span className="meter-cell" title={`resting bids ${usd(a.bids_notional)} of ${usd(a.bids_notional + a.quote_free)} USDT quote`}>
      <Meter value={r} limit={1} />
      <span className={"fig meter-num " + (r > 0.8 ? "warn-text" : "")}>{pct(r, 0)}</span>
    </span>
  );
}
const M10 = MeterCell("10s");
const M1d = MeterCell("1d");

function StreamCell(p: ICellRendererParams<Row>) {
  if (!p.data || p.data._total) return null;
  return <StateTag state={p.data.user_stream} />;
}

function feeFor(venue: "spot" | "usdm") {
  return function FeeCell(p: ICellRendererParams<Row>) {
    const a = p.data;
    if (!a || a._total) return null;
    const f = a.fees.find((x) => x.venue === venue);
    if (!f) return <span className="muted">—</span>;
    return (
      <span className={"fig " + (f.changed ? "warn-text" : "")} title={`maker / taker, bps${f.changed ? "; changed since first seen" : ""}`}>
        {f.changed ? "! " : ""}
        {num(f.maker_bps, 1)} / {num(f.taker_bps, 1)}
      </span>
    );
  };
}
const FeeSpot = feeFor("spot");
const FeeUsdm = feeFor("usdm");

function total(rows: Account[]): Row {
  const sum = (k: keyof Account) => rows.reduce((a, r) => a + (r[k] as number), 0);
  return {
    _total: true,
    id: "_total",
    label: "Total",
    email: "",
    role: "sub",
    equity: sum("equity"),
    equity_open: sum("equity_open"),
    pnl_day: sum("pnl_day"),
    transfers_day: sum("transfers_day"),
    quote_free: sum("quote_free"),
    quote_locked: sum("quote_locked"),
    inventory_value: sum("inventory_value"),
    fut_wallet: sum("fut_wallet"),
    fut_upnl: sum("fut_upnl"),
    fut_available: sum("fut_available"),
    positions: [],
    orders_10s: sum("orders_10s"),
    orders_10s_limit: 0,
    orders_1d: sum("orders_1d"),
    orders_1d_limit: 0,
    open_orders: sum("open_orders"),
    bids_notional: sum("bids_notional"),
    asks_notional: sum("asks_notional"),
    utilization: 0,
    fees: [],
    user_stream: "n/a",
    updated: 0,
  };
}

const rowIdRow = (p: GetRowIdParams<Row>) => p.data.id;

export function AccountsGrid({ full = false, wide = true }: { full?: boolean; wide?: boolean }) {
  const rows = useStore((s) => s.snap?.accounts);
  const cols = useMemo<ColDef<Row>[]>(() => {
    const n = (c: ColDef<Row>): ColDef<Row> => ({ type: "rightAligned", cellClass: "num", ...c });
    const c: ColDef<Row>[] = [
      { field: "label", headerName: "Account", headerTooltip: "Account label; hover a name for its email", width: 112, pinned: "left", cellRenderer: AccountCell },
      { field: "user_stream", headerName: "Stream", headerTooltip: "User data stream state (fills, orders, balances)", width: 76, cellRenderer: StreamCell },
      n({ field: "equity", headerName: "Equity", headerTooltip: "Spot balances at mid (stablecoins at 1) plus futures margin balance, USDT", width: 80, valueFormatter: fUsd }),
      n({ field: "pnl_day", headerName: "Day PnL", headerTooltip: "Equity now − equity at the day start − net transfers in since then, USDT", width: 74, valueFormatter: fPnl, cellClass: signCls }),
      n({ field: "transfers_day", headerName: "Transfers", headerTooltip: "Net transfers in since the day start, USDT", width: 80, valueFormatter: fPnl, hide: !full }),
      n({ field: "equity_open", headerName: "Equity open", headerTooltip: "Equity at the day start, USDT", width: 90, valueFormatter: fUsd, hide: !full || !wide }),
      n({ field: "quote_free", headerName: "USDT free", headerTooltip: "Free spot quote balance, USDT", width: 80, valueFormatter: fUsd }),
      n({ field: "quote_locked", headerName: "Locked", headerTooltip: "Spot quote balance locked in open orders, USDT", width: 70, valueFormatter: fUsd }),
      n({ field: "inventory_value", headerName: "Inventory", headerTooltip: "Non-quote spot assets, free + locked, at mid, USDT", width: 80, valueFormatter: fUsd }),
      n({ field: "fut_wallet", headerName: "Fut wallet", headerTooltip: "USD-M futures wallet balance, USDT", width: 78, valueFormatter: (p) => (p.value ? usd(p.value) : "—") }),
      n({ field: "fut_upnl", headerName: "Fut uPnL", headerTooltip: "Unrealized PnL of futures positions at mark, USDT", width: 72, valueFormatter: (p) => (p.data?.fut_wallet || p.data?._total ? fPnl(p) : "—"), cellClass: signCls }),
      n({ field: "fut_available", headerName: "Fut avail", headerTooltip: "Futures available balance, USDT", width: 74, valueFormatter: (p) => (p.value ? usd(p.value) : "—"), hide: !full }),
      { colId: "o10", headerName: "Orders 10 s", headerTooltip: "Orders placed in the last 10 s / Binance limit", width: 104, cellRenderer: M10, valueGetter: (p) => (p.data ? p.data.orders_10s / (p.data.orders_10s_limit || 1) : 0) },
      { colId: "o1d", headerName: "Orders 1 d", headerTooltip: "Orders placed today as a share of the Binance daily limit, %", width: 90, cellRenderer: M1d, valueGetter: (p) => (p.data ? p.data.orders_1d / (p.data.orders_1d_limit || 1) : 0) },
      { colId: "util", headerName: "Bid use", width: 90, cellRenderer: UtilCell, valueGetter: (p) => p.data?.utilization ?? 0, headerTooltip: "Resting bid notional / (free quote + resting bid notional), %" },
      n({ field: "open_orders", headerName: "Open", headerTooltip: "Number of open orders", width: 52, valueFormatter: fInt }),
      n({ field: "bids_notional", headerName: "Bids", width: 76, valueFormatter: fUsd, hide: !full || !wide, headerTooltip: "Resting bid notional, USDT" }),
      n({ field: "asks_notional", headerName: "Asks", width: 76, valueFormatter: fUsd, hide: !full || !wide, headerTooltip: "Resting ask notional, USDT" }),
    ];
    if (full) {
      c.push(
        { colId: "fee_spot", headerName: "Spot fee bps", width: 86, cellRenderer: FeeSpot, sortable: false, cellClass: "num", type: "rightAligned", headerTooltip: "Spot commission, maker / taker, bps of notional" },
        { colId: "fee_usdm", headerName: "USD-M fee bps", width: 92, cellRenderer: FeeUsdm, sortable: false, cellClass: "num", type: "rightAligned", headerTooltip: "USD-M futures commission, maker / taker, bps of notional" },
        n({ field: "updated", headerName: "Updated", headerTooltip: "Time since the account was last updated", width: 70, valueFormatter: (p) => (p.data?._total ? "" : fAge(p)), hide: !wide }),
      );
    }
    return c;
  }, [full, wide]);
  const fitted = useMemo(() => flexCols(cols), [cols]);
  const pinned = useMemo(() => (rows && rows.length > 1 ? [total(rows)] : []), [rows]);

  return (
    <AgGridReact<Row>
      theme={gridTheme}
      rowData={rows ?? []}
      columnDefs={fitted}
      defaultColDef={DEFAULT_COL}
      getRowId={rowIdRow}
      pinnedBottomRowData={pinned}
      suppressCellFocus
      animateRows={false}
      tooltipShowDelay={300}
    />
  );
}
