import { useMemo } from "react";
import { AgGridReact } from "ag-grid-react";
import type { ColDef, GetRowIdParams, ICellRendererParams, ValueFormatterParams } from "ag-grid-community";
import { useStore } from "../store";
import type { Account } from "../protocol";
import { gridTheme } from "../gridTheme";
import { fAge, fInt, signCls, DEFAULT_COL } from "../grid";
import { flexCols } from "../grid";
import { int, num, pct } from "../format";
import { Meter, StateTag } from "./ui";
import { amount, hideNow, money } from "../mask";

type Row = Account & { _total?: boolean };

// USD columns follow Hide amounts (the columns are rebuilt when it changes)
const v = (p: ValueFormatterParams) => p.value as number | null | undefined;
const fMoney = (p: ValueFormatterParams) => (amount(v(p), "money", hideNow()));
const fSigned = (p: ValueFormatterParams) => (amount(v(p), "pnlMoney", hideNow()));
const moneyCls = (hide: boolean) => (hide ? "num masked" : "num");
const signedCls = (hide: boolean) => (hide ? () => "num masked" : signCls);

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
    if (!l) return <span className="muted">--</span>;
    const r = v / l;
    return (
      <span className="meter-cell" title={`${int(v)} of ${int(l)} orders${kind === "10s" ? " in the last 10 s" : " today"} (${pct(r, 1)})`}>
        <Meter value={v} limit={l} />
        <span className={"fig meter-num " + (r > 0.8 ? "warn-text" : "")}>{kind === "10s" ? `${v}/${l}` : pct(r, 0)}</span>
      </span>
    );
  };
}
function UtilCell(p: ICellRendererParams<Row>) {
  const a = p.data;
  if (!a || a._total) return null;
  if (a.utilization == null || !Number.isFinite(a.utilization)) return <span className="muted">--</span>;
  const r = a.utilization;
  const hide = hideNow();
  return (
    <span
      className="meter-cell"
      title={hide ? "Resting bid notional / (free quote + resting bid notional)" : `resting bids ${money(a.bids_notional)} of ${money(a.bids_notional + a.quote_free)} USDT quote`}
    >
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
    if (!f) return <span className="muted">--</span>;
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
    rebates: sum("rebates"),
  };
}

const rowIdRow = (p: GetRowIdParams<Row>) => p.data.id;

/**
 * One row per account. Default (the Desk's Accounts tab): equity, day PnL, spot balances, futures, and the
 * order-rate and bid-use meters. `full` (Assets → Overview): the money side only, without a totals row (the
 * page's header carries the totals): equity, day PnL with its transfers and rebates, spot and futures balances,
 * open orders, fees, last update. The rate limits are on the Orders page. `wide` adds equity at the open and
 * the update age. Money follows Hide amounts.
 */
export function AccountsGrid({ full = false, wide = true, totals = !full }: { full?: boolean; wide?: boolean; totals?: boolean }) {
  const rows = useStore((s) => s.snap?.accounts);
  const hide = useStore((s) => s.hideAmounts);
  const cols = useMemo<ColDef<Row>[]>(() => {
    const n = (c: ColDef<Row>): ColDef<Row> => ({ type: "rightAligned", cellClass: moneyCls(hide), ...c });
    const futOnly = (p: ValueFormatterParams<Row>) => (p.data?.fut_wallet || p.data?._total ? fMoney(p) : "--");
    const account: ColDef<Row> = { field: "label", headerName: "Account", headerTooltip: "Account label; hover a name for its email", width: 112, pinned: "left", cellRenderer: AccountCell };
    const stream: ColDef<Row> = { field: "user_stream", headerName: "Stream", headerTooltip: "User data stream state (fills, orders, balances)", width: 76, cellRenderer: StreamCell };
    const equity = n({ field: "equity", headerName: "Equity", headerTooltip: "Spot balances at mid (stablecoins at 1) plus futures margin balance, USDT", width: 92, valueFormatter: fMoney });
    const day = n({ field: "pnl_day", headerName: "Day PnL", headerTooltip: "Equity now − equity at the day start − net transfers in since then, USDT", width: 80, valueFormatter: fSigned, cellClass: signedCls(hide) });
    const open = n({ field: "open_orders", headerName: "Open", headerTooltip: "Number of open orders", width: 56, valueFormatter: fInt, cellClass: "num" });
    if (full) {
      const c: ColDef<Row>[] = [
        account,
        equity,
        day,
        n({ field: "transfers_day", headerName: "Transfers", headerTooltip: "Net transfers in since the day start, USDT", width: 86, valueFormatter: fSigned }),
        n({ field: "rebates", headerName: "Rebates", headerTooltip: "Market-maker rebates credited since the day start, part of Day PnL, USDT", width: 76, valueFormatter: fSigned, cellClass: signedCls(hide) }),
        n({ field: "equity_open", headerName: "Equity open", headerTooltip: "Equity at the day start, USDT", width: 92, valueFormatter: fMoney, hide: !wide }),
        n({ field: "quote_free", headerName: "USDT free", headerTooltip: "Free spot quote balance, USDT", width: 86, valueFormatter: fMoney }),
        n({ field: "quote_locked", headerName: "In orders", headerTooltip: "Spot quote balance locked in open bids, USDT", width: 80, valueFormatter: fMoney }),
        n({ field: "inventory_value", headerName: "Inventory", headerTooltip: "Non-quote spot assets, free + locked, at mid, USDT", width: 86, valueFormatter: fMoney }),
        n({ field: "fut_wallet", headerName: "Futures wallet", headerTooltip: "USD-M futures wallet balance, USDT", width: 100, valueFormatter: futOnly }),
        n({ field: "fut_upnl", headerName: "Futures uPnL", headerTooltip: "Unrealized PnL of futures positions at mark, USDT", width: 96, valueFormatter: (p) => (p.data?.fut_wallet || p.data?._total ? fSigned(p) : "--"), cellClass: signedCls(hide) }),
        open,
        { colId: "fee_spot", headerName: "Spot fee (bps)", width: 96, cellRenderer: FeeSpot, sortable: false, cellClass: "num", type: "rightAligned", headerTooltip: "Spot commission, maker / taker, bps of notional" },
        { colId: "fee_usdm", headerName: "USD-M fee (bps)", width: 104, cellRenderer: FeeUsdm, sortable: false, cellClass: "num", type: "rightAligned", headerTooltip: "USD-M futures commission, maker / taker, bps of notional" },
        { ...stream, width: 72 },
        n({ field: "updated", headerName: "Updated", headerTooltip: "Time since the account was last updated", width: 70, cellClass: "num", valueFormatter: (p) => (p.data?._total ? "" : fAge(p)), hide: !wide }),
      ];
      return c;
    }
    return [
      account,
      stream,
      equity,
      day,
      n({ field: "quote_free", headerName: "USDT free", headerTooltip: "Free spot quote balance, USDT", width: 80, valueFormatter: fMoney }),
      n({ field: "quote_locked", headerName: "Locked", headerTooltip: "Spot quote balance locked in open orders, USDT", width: 70, valueFormatter: fMoney }),
      n({ field: "inventory_value", headerName: "Inventory", headerTooltip: "Non-quote spot assets, free + locked, at mid, USDT", width: 80, valueFormatter: fMoney }),
      n({ field: "fut_wallet", headerName: "Fut wallet", headerTooltip: "USD-M futures wallet balance, USDT", width: 78, valueFormatter: futOnly }),
      n({ field: "fut_upnl", headerName: "Fut uPnL", headerTooltip: "Unrealized PnL of futures positions at mark, USDT", width: 72, valueFormatter: (p) => (p.data?.fut_wallet || p.data?._total ? fSigned(p) : "--"), cellClass: signedCls(hide) }),
      { colId: "o10", headerName: "Orders 10 s", headerTooltip: "Orders placed in the last 10 s / Binance limit", width: 104, cellRenderer: M10, valueGetter: (p) => (p.data ? p.data.orders_10s / (p.data.orders_10s_limit || 1) : 0) },
      { colId: "o1d", headerName: "Orders 1 d", headerTooltip: "Orders placed today as a share of the Binance daily limit, %", width: 90, cellRenderer: M1d, valueGetter: (p) => (p.data ? p.data.orders_1d / (p.data.orders_1d_limit || 1) : 0) },
      { colId: "util", headerName: "Bid use", width: 90, cellRenderer: UtilCell, valueGetter: (p) => p.data?.utilization ?? 0, headerTooltip: "Resting bid notional / (free quote + resting bid notional), %" },
      open,
    ];
  }, [full, wide, hide]);
  const fitted = useMemo(() => flexCols(cols), [cols]);
  const pinned = useMemo(() => (totals && rows && rows.length > 1 ? [total(rows)] : []), [rows, totals]);

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
