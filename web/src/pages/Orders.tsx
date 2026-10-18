// Orders ≈ Binance "Open orders" with the book beside it: the accounts' rate limits in one strip on top, the live
// quote map (every instrument's bids and asks around fair), and the open orders in Binance's column order.
import { Suspense, useMemo, useRef, useState } from "react";
import { AgGridReact } from "ag-grid-react";
import type { ColDef, GetRowIdParams, ICellRendererParams, RowClickedEvent } from "ag-grid-community";
import { TextInput } from "@mantine/core";
import { IconSearch, IconX } from "@tabler/icons-react";
import { selectInstrument, useStore } from "../store";
import type { Account, OpenOrder } from "../protocol";
import { gridTheme } from "../gridTheme";
import { hms, int, pct } from "../format";
import { fBps, fPrice, DEFAULT_COL } from "../grid";
import { QuoteControls, QuoteLegend, QuoteMapEC, RANGES, useMapCounts, useQuoteMapState, type QuoteMapState } from "../components/quotes";
import { TextToggle, useExPref } from "../components/ex";
import { LimitBar, limitTone } from "./ops/LimitBar";
import { amount, hideNow, qtyText, useAmount, useHide } from "../mask";
import "./ops/ops.css";

const short = (s: string) => s.replace(/USDT$/, "");

/** The quote map's range for these orders: the smallest of RANGES over 1.05 × the 95th percentile of |distance|.
 *  It steps down only when the quotes sit well inside the next smaller range, so a live wobble does not flip it. */
function useFitRange(orders: OpenOrder[]): number {
  const cur = useRef<number>(RANGES[1]);
  // what the map draws: spot orders with a known distance (an unknown one is not 0 bps)
  const d = orders
    .filter((o) => o.venue === "spot" && o.dist_bps != null)
    .map((o) => Math.abs(o.dist_bps!))
    .sort((a, b) => a - b);
  if (!d.length) return cur.current;
  const p95 = d[Math.min(d.length - 1, Math.floor(d.length * 0.95))]! * 1.05;
  const want: number = RANGES.find((r) => r >= p95) ?? 100;
  if (want > cur.current) cur.current = want;
  else if (want < cur.current) {
    const lower = RANGES[RANGES.indexOf(cur.current as (typeof RANGES)[number]) - 1];
    if (lower != null && p95 < lower * 0.85) cur.current = want;
  }
  return cur.current;
}
const tradingAccounts = (accounts: Account[]) => accounts.filter((a) => a.role !== "master" && (a.open_orders > 0 || a.inventory_value > 1));

/** One cell per trading account: name and free USDT, then what can run out as a small table (orders per 10 s and
 *  per day against Binance's limits, bid use: label, bar, figure) and the resting notional on each side in a quiet
 *  line. Bars are neutral and turn amber, then red, only near a limit. */
/** How the counts were had when not from Binance's own /api/v3/rateLimit/order. */
const streamNote = (a: Account) =>
  a.orders_source === "stream" ? " Counted from the user stream (the key cannot read Binance's own count): orders Binance rejected are not in it." : "";

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
              <span className="muted fig" title="Free spot quote balance, USDT">
                Free {m(a.quote_free)}
              </span>
            </div>
            {/* what can run out, a row each: label, how near the limit (the bar), the figure */}
            <div className="ops-limit-rows fig">
              <span className="ops-l" title={`Orders placed in the last 10 s, of Binance's ${int(l10)}.${streamNote(a)}`}>Orders 10 s</span>
              <LimitBar value={a.orders_10s} limit={l10} />
              <span className={limitTone(r10)}>
                {int(a.orders_10s)} / {int(l10)}
              </span>
              <span className="ops-l" title={(a.orders_1d_limit ? `${int(a.orders_1d)} of ${int(a.orders_1d_limit)} orders today.` : "No daily limit known.") + streamNote(a)}>
                Orders today
              </span>
              <LimitBar value={a.orders_1d} limit={a.orders_1d_limit} />
              <span className={limitTone(r1d)}>{a.orders_1d_limit ? pct(r1d) : "--"}</span>
              <span className="ops-l" title="Resting bid notional / (free quote + resting bid notional)">
                Bid use
              </span>
              <LimitBar value={a.utilization} limit={1} />
              <span className={limitTone(a.utilization)}>{Number.isFinite(a.utilization) ? pct(a.utilization) : "--"}</span>
            </div>
            {/* the resting notional on each side: a quiet line under the limits */}
            <div className="ops-limit-rest fig" title="Resting notional of our open orders, USDT">
              <span>
                {nb} bids <span className={"ops-v-side" + (hide ? " masked" : "")}>{m(bid)}</span>
              </span>
              <span>
                {na} asks <span className={"ops-v-side" + (hide ? " masked" : "")}>{m(ask)}</span>
              </span>
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
  const saved = useQuoteMapState();
  const trading = tradingAccounts(accounts);
  const acct = saved.account != null && trading.some((a) => a.id === saved.account) ? saved.account : null;
  const shown = acct == null ? orders : orders.filter((o) => o.account === acct);
  const counts = useMapCounts(acct);
  // the map's own count (spot): the perps' hedge orders are not on it
  const through = counts.through;

  // the range fits the quotes until a range is picked here (Fit goes back): the smallest of ±10 ±25 ±50 ±100
  // that holds 95 % of the orders, so dots within ±8 get ±10, not an empty ±25
  const [picked, setPicked] = useExPref<boolean>("qmap.desk", "rangePicked", false);
  const fit = useFitRange(shown);
  const st: QuoteMapState = {
    ...saved,
    range: picked ? saved.range : fit,
    setRange: (r) => {
      saved.setRange(r);
      setPicked(true);
    },
  };

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
            {through ? <span className="warn-text">{through} through fair</span> : null}
            {counts.oneSide ? <span className="muted">{counts.oneSide} one side</span> : null}
            {counts.wide ? <span className="muted">{counts.wide} wide</span> : null}
          </span>
        </header>
        <div className="ops-qmap-legend">
          <QuoteLegend />
          <QuoteControls st={st} accounts={[]} />
          <button
            type="button"
            className={"ops-fit" + (picked ? "" : " on")}
            aria-pressed={!picked}
            onClick={() => setPicked(false)}
            title="Fit the range to the quotes (it follows them until a range is picked)"
          >
            Fit
          </button>
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
