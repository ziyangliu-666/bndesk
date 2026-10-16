// Orders ≈ Binance "Open orders" with the book beside it: the accounts' rate limits in one strip on top, the live
// quote map (every instrument's bids and asks around fair), and the open orders in Binance's column order.
import { Suspense, useMemo, useState } from "react";
import { AgGridReact } from "ag-grid-react";
import type { ColDef, GetRowIdParams, ICellRendererParams, RowClickedEvent } from "ag-grid-community";
import { TextInput } from "@mantine/core";
import { IconSearch, IconX } from "@tabler/icons-react";
import { selectInstrument, useStore } from "../store";
import type { Account, OpenOrder } from "../protocol";
import { gridTheme } from "../gridTheme";
import { hms, int, pct } from "../format";
import { fBps, fPrice, DEFAULT_COL } from "../grid";
import { QuoteControls, QuoteLegend, QuoteMapEC, useQuoteMapState } from "../components/quotes";
import { TextToggle } from "../components/ex";
import { LimitBar, limitTone } from "./ops/LimitBar";
import { amount, hideNow, qtyText, useAmount, useHide } from "../mask";
import "./ops/ops.css";

const short = (s: string) => s.replace(/USDT$/, "");
const tradingAccounts = (accounts: Account[]) => accounts.filter((a) => a.role !== "master" && (a.open_orders > 0 || a.inventory_value > 1));

/** One cell per trading account: name and free USDT, then label-over-value pairs for what can run out (orders per
 *  10 s and per day against Binance's limits, bid use) and the resting notional on each side. Bars are neutral and
 *  turn amber, then red, only near a limit. */
function RateLimits({ accounts, orders }: { accounts: Account[]; orders: OpenOrder[] }) {
  const m = useAmount();
  const hide = useHide();
  const rows = accounts.map((a) => {
    let bid = 0;
    let ask = 0;
    let nb = 0;
    let na = 0;
    for (const o of orders) {
      if (o.account !== a.id) continue;
      if (o.side === "buy") (bid += o.notional), nb++;
      else (ask += o.notional), na++;
    }
    return { a, bid, ask, nb, na };
  });
  const scale = Math.max(1, ...rows.map((r) => Math.max(r.bid, r.ask)));
  return (
    <div className="ops-limits" style={{ gridTemplateColumns: `repeat(${Math.max(1, rows.length)}, minmax(0, 1fr))` }}>
      {rows.length === 0 && <div className="ops-limit muted">No trading accounts</div>}
      {rows.map(({ a, bid, ask, nb, na }) => {
        const l10 = a.orders_10s_limit || 100;
        const r10 = a.orders_10s / l10;
        const r1d = a.orders_1d_limit ? a.orders_1d / a.orders_1d_limit : 0;
        return (
          <div className="ops-limit" key={a.id}>
            <div className="ops-limit-head">
              <span className="ops-limit-name" title={a.email}>
                {a.label}
              </span>
              <span className="muted fig" title="Free spot quote balance">
                Free {m(a.quote_free)} USDT
              </span>
            </div>
            <div className="ops-limit-pairs fig">
              <div title={`Orders placed in the last 10 s, of Binance's ${int(l10)}`}>
                <span className="ops-l">Orders 10 s</span>
                <span className={limitTone(r10)}>
                  {a.orders_10s}/{l10}
                </span>
                <LimitBar value={a.orders_10s} limit={l10} />
              </div>
              <div title={a.orders_1d_limit ? `${int(a.orders_1d)} of ${int(a.orders_1d_limit)} orders today` : "No daily limit known"}>
                <span className="ops-l">Orders 1 d</span>
                <span className={limitTone(r1d)}>{a.orders_1d_limit ? pct(r1d) : "--"}</span>
                <LimitBar value={a.orders_1d} limit={a.orders_1d_limit} />
              </div>
              <div title="Resting bid notional / (free quote + resting bid notional)">
                <span className="ops-l">Bid use</span>
                <span className={limitTone(a.utilization)}>{Number.isFinite(a.utilization) ? pct(a.utilization) : "--"}</span>
                <LimitBar value={a.utilization} limit={1} />
              </div>
              <div title={`${nb} resting bids, USDT`}>
                <span className="ops-l">Bids {nb}</span>
                <span className={"ops-v-side up" + (hide ? " masked" : "")}>{m(bid)}</span>
                <LimitBar value={bid} limit={scale} empty={hide} neutral />
              </div>
              <div title={`${na} resting asks, USDT`}>
                <span className="ops-l">Asks {na}</span>
                <span className={"ops-v-side down" + (hide ? " masked" : "")}>{m(ask)}</span>
                <LimitBar value={ask} limit={scale} empty={hide} neutral />
              </div>
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
  return <span className={o.side === "buy" ? "up" : "down"}>{o.side === "buy" ? "Buy" : "Sell"}</span>;
}

function SymbolCell(p: ICellRendererParams<OpenOrder>) {
  const o = p.data;
  if (!o) return null;
  return (
    <span className="ops-sym">
      {o.symbol}
      {o.venue === "usdm" && <span className="ops-perp">Perp</span>}
    </span>
  );
}

const rowIdOpenOrder = (p: GetRowIdParams<OpenOrder>) => p.data.id;
const openRow = (e: RowClickedEvent<OpenOrder>) => e.data && selectInstrument({ symbol: e.data.symbol, venue: e.data.venue });

/** Open orders in Binance's order: Time Symbol Side Price Amount Notional Dist (bps) Account. A row opens its
 *  instrument on the Desk. The filter takes free text; a base name alone (ETH) shows only that symbol. */
function OpenOrders({ orders }: { orders: OpenOrder[] }) {
  const [q, setQ] = useState("");
  const tz = useStore((s) => s.tz);
  const hide = useHide();
  const exact = useMemo(() => {
    const k = q.trim().toUpperCase();
    return k && orders.some((o) => short(o.symbol) === k || o.symbol === k) ? k : null;
  }, [q, orders]);
  const rows = useMemo(() => (exact ? orders.filter((o) => short(o.symbol) === exact || o.symbol === exact) : orders), [exact, orders]);
  const cols = useMemo<ColDef<OpenOrder>[]>(() => {
    const n = (c: ColDef<OpenOrder>): ColDef<OpenOrder> => ({ type: "rightAligned", cellClass: "num", ...c });
    return [
      {
        field: "since",
        headerName: "Time",
        headerTooltip: "When the order was placed",
        width: 66,
        minWidth: 66,
        flex: 66,
        cellClass: "num muted-cell",
        valueFormatter: (p) => hms(p.value as number | null, tz),
        initialSort: "desc",
      },
      { field: "symbol", headerName: "Symbol", width: 96, minWidth: 92, flex: 96, cellRenderer: SymbolCell },
      { field: "side", headerName: "Side", width: 44, minWidth: 40, flex: 44, cellRenderer: SideCell },
      n({ field: "price", headerName: "Price", headerTooltip: "Limit price, USDT", width: 78, minWidth: 72, flex: 78, valueFormatter: fPrice }),
      n({ field: "qty", headerName: "Amount", headerTooltip: "Remaining quantity, base asset", width: 66, minWidth: 60, flex: 66, valueFormatter: (p) => qtyText(p.value as number, hideNow()), cellClass: hide ? "num masked" : "num" }),
      n({
        field: "notional",
        headerName: "Notional",
        headerTooltip: "Price × remaining amount, USDT",
        width: 68,
        minWidth: 62,
        flex: 68,
        valueFormatter: (p) => amount(p.value as number, "money", hideNow()),
        cellClass: hide ? "num masked" : "num",
      }),
      n({
        field: "dist_bps",
        headerName: "Dist (bps)",
        width: 70,
        minWidth: 68,
        flex: 70,
        valueFormatter: fBps,
        headerTooltip: "Distance from fair, bps; positive = passive, negative = through fair",
        cellClassRules: { "warn-text": (p) => p.value != null && p.value < 0 },
      }),
      { field: "account", headerName: "Account", width: 60, minWidth: 56, flex: 60, cellClass: "muted-cell" },
    ];
  }, [tz, hide]);
  return (
    <section className="ops-panel ops-olist">
      <header className="ops-head">
        <span className="ops-title">
          Open orders <span className="ops-count fig">{rows.length}</span>
        </span>
        <TextInput
          size="xs"
          placeholder="Symbol"
          leftSection={<IconSearch size={12} />}
          value={q}
          onChange={(e) => setQ(e.currentTarget.value)}
          rightSection={q ? <IconX size={12} style={{ cursor: "pointer" }} onClick={() => setQ("")} aria-label="Clear filter" /> : null}
          rightSectionPointerEvents="all"
          className="quick-filter ops-filter"
          aria-label="Filter orders"
        />
      </header>
      <div className="ops-body ops-grid">
        <AgGridReact<OpenOrder>
          theme={gridTheme}
          rowData={rows}
          columnDefs={cols}
          quickFilterText={exact ? "" : q}
          defaultColDef={DEFAULT_COL}
          getRowId={rowIdOpenOrder}
          onRowClicked={openRow}
          rowClass="ops-click"
          suppressCellFocus
          animateRows={false}
          tooltipShowDelay={300}
          overlayNoRowsTemplate="No open orders"
        />
      </div>
    </section>
  );
}

export function Orders() {
  const orders = useStore((s) => s.snap?.orders) ?? [];
  const accounts = useStore((s) => s.snap?.accounts) ?? [];
  const desk = useStore((s) => s.deskSymbol);
  const st = useQuoteMapState();
  const trading = tradingAccounts(accounts);
  const acct = st.account != null && trading.some((a) => a.id === st.account) ? st.account : null;
  const shown = acct == null ? orders : orders.filter((o) => o.account === acct);
  const through = shown.filter((o) => o.dist_bps != null && o.dist_bps < 0).length;

  return (
    <div className="page ops-orders">
      <RateLimits accounts={trading} orders={orders} />
      <section className="ops-panel ops-qmap">
        <header className="ops-head">
          <span className="ops-title">Quote map</span>
          {trading.length > 1 && (
            <TextToggle
              label="Account"
              className="ops-acct"
              value={acct ?? "all"}
              onChange={(v) => st.setAccount(v === "all" ? null : v)}
              options={[{ value: "all", label: "All accounts" }, ...trading.map((a) => ({ value: a.id, label: a.label }))]}
            />
          )}
          <span className="ops-head-right fig">
            <span className="muted">{shown.length} orders</span>
            {through ? <span className="warn-text">{through} through fair</span> : null}
          </span>
        </header>
        <div className="ops-qmap-legend">
          <QuoteLegend />
          <QuoteControls st={st} accounts={[]} />
        </div>
        <div className="q-ec ops-qmap-plot">
          <Suspense fallback={null}>
            <QuoteMapEC
              range={st.range}
              onRange={st.setRange}
              sort={st.sort}
              account={acct}
              selected={desk?.symbol ?? null}
              onSelect={(symbol, venue) => selectInstrument({ symbol, venue })}
            />
          </Suspense>
        </div>
      </section>
      <OpenOrders orders={shown} />
    </div>
  );
}
