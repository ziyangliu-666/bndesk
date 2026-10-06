import { lazy, Suspense, useEffect, useMemo, useRef, useState } from "react";
import { AgGridReact } from "ag-grid-react";
import type { ColDef, GetRowIdParams, GridApi, ICellRendererParams } from "ag-grid-community";
import { SegmentedControl, TextInput } from "@mantine/core";
import { IconSearch, IconX } from "@tabler/icons-react";
import { useStore } from "../store";
import type { Account, OpenOrder } from "../protocol";
import { gridTheme } from "../theme";
import { pct, usd } from "../format";
import { fAge, fBps, fPrice, fUsd, DEFAULT_COL } from "../grid";
import { Meter, Panel } from "../components/ui";
import type { MapSort } from "../components/QuoteMap";

// ECharts is only needed here; the chart loads as its own chunk when the page opens
const QuoteMap = lazy(() => import("../components/QuoteMap").then((m) => ({ default: m.QuoteMap })));
const short = (s: string) => s.replace(/USDT$/, "");

/** One cell per account: bid and ask notional as bars on a shared scale, then bid use and the
 *  10 s order count against Binance's limit. Labels, bars and figures sit in fixed columns. */
function AccountStrip({ accounts, orders }: { accounts: Account[]; orders: OpenOrder[] }) {
  const rows = accounts.map((a) => {
    const mine = orders.filter((o) => o.account === a.id);
    const bids = mine.filter((o) => o.side === "buy");
    const asks = mine.filter((o) => o.side === "sell");
    const sum = (xs: OpenOrder[]) => xs.reduce((s, o) => s + o.notional, 0);
    return { a, bid: sum(bids), ask: sum(asks), nb: bids.length, na: asks.length };
  });
  const scale = Math.max(1, ...rows.map((r) => Math.max(r.bid, r.ask)));
  const bar = (v: number, cls: string) => (
    <div className="hbar">
      <div className={cls} style={{ width: `${(v / scale) * 100}%` }} />
    </div>
  );
  return (
    <div className="acct-strip">
      {rows.map(({ a, bid, ask, nb, na }) => {
        const lim = a.orders_10s_limit || 100;
        return (
          <div className="acct-cell" key={a.id}>
            <div className="acct-cell-head">
              <span className="acct-name">{a.label}</span>
              <span className="muted fig" title="Free spot quote balance">
                free {usd(a.quote_free)} USDT
              </span>
            </div>
            <div className="acct-grid fig">
              <span className="muted">Bids</span>
              {bar(bid, "fill-up")}
              <span title="Resting bid notional, USDT">
                {usd(bid)}
              </span>
              <span className="muted" title="Resting bid orders">
                {nb}
              </span>
              <span className="muted">Asks</span>
              {bar(ask, "fill-down")}
              <span title="Resting ask notional, USDT">
                {usd(ask)}
              </span>
              <span className="muted" title="Resting ask orders">
                {na}
              </span>
              <span className="muted">Bid use</span>
              <Meter value={a.utilization} limit={1} />
              <span
                className={a.utilization > 0.8 ? "warn-text" : ""}
                title="Resting bid notional / (free quote + resting bid notional)"
              >
                {pct(a.utilization)}
              </span>
              <span />
              <span className="muted">10 s</span>
              <Meter value={a.orders_10s} limit={lim} />
              <span
                className={a.orders_10s > lim * 0.8 ? "warn-text" : ""}
                title="Orders placed in the last 10 s / Binance limit"
              >
                {a.orders_10s}/{lim}
              </span>
              <span />
            </div>
          </div>
        );
      })}
    </div>
  );
}

function SideCell(p: ICellRendererParams<OpenOrder>) {
  const o = p.data;
  if (!o) return null;
  return <span className={o.side === "buy" ? "up" : "down"}>{o.side === "buy" ? "bid" : "ask"}</span>;
}

/** The filter box takes free text, or a symbol picked on the quote map; a symbol's exact base name
 *  shows only that symbol's orders (BTC does not also match BTCDOM). */
function OrderList({ orders, q, setQ }: { orders: OpenOrder[]; q: string; setQ: (q: string) => void }) {
  const exact = useMemo(() => {
    const k = q.trim().toUpperCase();
    return k && orders.some((o) => short(o.symbol) === k) ? k : null;
  }, [q, orders]);
  const rows = useMemo(() => (exact ? orders.filter((o) => short(o.symbol) === exact) : orders), [exact, orders]);
  const api = useRef<GridApi<OpenOrder> | null>(null);
  useEffect(() => {
    const t = setInterval(() => api.current?.refreshCells({ columns: ["since"] }), 1000);
    return () => clearInterval(t);
  }, []);
  const cols = useMemo<ColDef<OpenOrder>[]>(() => {
    const n = (c: ColDef<OpenOrder>): ColDef<OpenOrder> => ({ type: "rightAligned", cellClass: "num", ...c });
    return [
      n({ field: "since", headerName: "Age", headerTooltip: "Time since the order was placed", width: 50, valueFormatter: fAge, initialSort: "asc", comparator: (a, b) => (b ?? 0) - (a ?? 0) }),
      { field: "account", headerName: "Acct", headerTooltip: "Account", width: 50 },
      { field: "side", headerName: "Side", headerTooltip: "bid = buy order, ask = sell order", width: 44, cellRenderer: SideCell },
      { field: "symbol", headerName: "Symbol", headerTooltip: "Base asset; quote is USDT", flex: 1, minWidth: 64, valueFormatter: (p) => String(p.value).replace(/USDT$/, "") },
      n({ field: "price", headerName: "Price", headerTooltip: "Limit price, USDT", width: 76, valueFormatter: fPrice }),
      n({ field: "notional", headerName: "Notional", headerTooltip: "Price × remaining quantity, USDT", width: 66, valueFormatter: fUsd }),
      n({
        field: "dist_bps",
        headerName: "Dist bps",
        width: 58,
        valueFormatter: fBps,
        headerTooltip: "Distance from fair, bps; positive = passive, negative = through fair",
        cellClassRules: { "warn-text": (p) => p.value != null && p.value < 0 },
      }),
    ];
  }, []);
  return (
    <Panel
      className="olist"
      title="Orders"
      right={
        <TextInput
          size="xs"
          placeholder="Filter"
          leftSection={<IconSearch size={12} />}
          value={q}
          onChange={(e) => setQ(e.currentTarget.value)}
          rightSection={q ? <IconX size={12} style={{ cursor: "pointer" }} onClick={() => setQ("")} aria-label="Clear filter" /> : null}
          rightSectionPointerEvents="all"
          className="quick-filter"
          aria-label="Filter orders"
        />
      }
      bodyClass="grid-body"
    >
      <AgGridReact<OpenOrder>
        theme={gridTheme}
        rowData={rows}
        columnDefs={cols}
        quickFilterText={exact ? "" : q}
        defaultColDef={DEFAULT_COL}
        getRowId={rowIdOpenOrder}
        onGridReady={(e) => (api.current = e.api)}
        suppressCellFocus
        animateRows={false}
        tooltipShowDelay={300}
      />
    </Panel>
  );
}

const rowIdOpenOrder = (p: GetRowIdParams<OpenOrder>) => p.data.id;

export function Orders() {
  const orders = useStore((s) => s.snap?.orders) ?? [];
  const accounts = useStore((s) => s.snap?.accounts) ?? [];
  const [acct, setAcct] = useState("all");
  const [range, setRange] = useState(25);
  const [q, setQ] = useState("");
  const pick = (name: string) => setQ((cur) => (cur.trim().toUpperCase() === name ? "" : name));
  const [sort, setSort] = useState<MapSort>("activity");
  const trading = accounts.filter((a) => a.role !== "master" && (a.open_orders > 0 || a.inventory_value > 1));
  const shown = acct === "all" ? orders : orders.filter((o) => o.account === acct);
  const through = shown.filter((o) => o.dist_bps != null && o.dist_bps < 0).length;

  return (
    <div className="page orders">
      <AccountStrip accounts={trading} orders={orders} />
      <Panel
        className="qmap-panel"
        title="Quotes against fair"
        right={
          <>
            <span className="muted fig">
              {shown.length} orders
            </span>
            {through ? <span className="warn-text fig">{through} through fair</span> : null}
            <SegmentedControl
              size="xs"
              value={acct}
              onChange={setAcct}
              data={[{ value: "all", label: "all" }, ...trading.map((a) => ({ value: a.id, label: a.id }))]}
              className="mini-seg"
              aria-label="Account"
            />
            <SegmentedControl
              size="xs"
              value={sort}
              onChange={(v) => setSort(v as MapSort)}
              data={[
                { value: "activity", label: "busiest" },
                { value: "inventory", label: "inventory" },
                { value: "name", label: "a–z" },
              ]}
              className="mini-seg"
              aria-label="Sort"
            />
            <SegmentedControl
              size="xs"
              value={String(range)}
              onChange={(v) => setRange(Number(v))}
              data={["10", "25", "50"].map((v) => ({ value: v, label: `±${v}` }))}
              className="mini-seg"
              aria-label="Range in bps"
            />
          </>
        }
        bodyClass="qmap-body"
      >
        <Suspense fallback={null}>
          <QuoteMap
            range={range}
            onRange={setRange}
            sort={sort}
            account={acct === "all" ? null : acct}
            selected={q.trim().toUpperCase()}
            onSelect={pick}
          />
        </Suspense>
        <div className="qmap-legend">
          <span>
            <i className="lg-band" /> Market bid–ask
          </span>
          <span>
            <i className="lg-dot up" /> Our bid
          </span>
          <span>
            <i className="lg-dot down" /> Our ask
          </span>
          <span>
            <i className="lg-dot ring" /> Through fair
          </span>
          <span>
            <i className="lg-tri" /> Beyond range
          </span>
        </div>
      </Panel>
      <OrderList orders={shown} q={q} setQ={setQ} />
    </div>
  );
}

