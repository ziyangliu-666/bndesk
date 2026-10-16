import { memo, useMemo, useState } from "react";
import { IconSearch, IconX } from "@tabler/icons-react";
import { selectInstrument, useStore } from "../../store";
import { useNow } from "../../hooks";
import { bps, hms, int, price } from "../../format";
import { Chips, Sheet, span, useHold, useLive } from "../../components/mobile";
import { TextToggle, useExPref } from "../../components/ex";
import { QuotesFull } from "./desk/QuoteTouch";
import "./desk.css";
import "./desk/mk.css";
import type { Account, OpenOrder } from "../../protocol";
import { TIP, pctDigits, useQty } from "./shared";
import { Empty, Meter, PageTabs, Row, Sec, Stats, useAmt } from "./rest/ui";
import "./rest/ops.css";

const base = (s: string) => s.replace(/USDT$/, "");
const MAX_ROWS = 200;
const NO_ORDERS: OpenOrder[] = [];
const NO_ACCOUNTS: Account[] = [];

type SideF = "all" | "buy" | "sell";
type Tab = "orders" | "quotes" | "rates";

/** Orders: the resting orders (search, account, side), the live quote map, and the order rates against
 *  Binance's limits. */
export function OrdersM() {
  const from = useStore((s) => s.route);
  const [tab, setTab] = useExPref<Tab>("m-orders", "tab", "orders", ["orders", "quotes", "rates"]);
  const n = useStore((s) => s.snap?.orders.length ?? 0);
  const accounts = useLive((s) => s.snap?.accounts, 1000) ?? NO_ACCOUNTS;
  const trading = accounts.filter((a) => a.role !== "master" && (a.open_orders > 0 || a.inventory_value > 1));
  // the busiest rate, so the tab says when a limit is near
  const worst = Math.max(0, ...trading.map((a) => Math.max(a.orders_10s_limit ? a.orders_10s / a.orders_10s_limit : 0, a.orders_1d_limit ? a.orders_1d / a.orders_1d_limit : 0)));
  // opened from an instrument (#/orders/BTCUSDT/spot): its orders, whatever tab was last
  const cur: Tab = from.symbol ? "orders" : tab;
  return (
    <>
      <PageTabs
        items={[
          { value: "orders", label: "Open orders", count: n || null },
          { value: "quotes", label: "Quotes" },
          { value: "rates", label: worst >= 0.8 ? <span className={worst >= 1 ? "crit-text" : "warn-text"}>Rate limits</span> : "Rate limits" },
        ]}
        value={cur}
        onChange={setTab}
      />
      {cur === "orders" ? (
        <OpenOrders accounts={trading} all={accounts} />
      ) : cur === "quotes" ? (
        <section className="o-qmap mk-quotes">
          <QuotesFull ms={250} />
        </section>
      ) : (
        <Rates accounts={trading} />
      )}
    </>
  );
}

function OpenOrders({ accounts, all }: { accounts: Account[]; all: Account[] }) {
  // the list renders when it is handed over (4 a second at most) and holds still under a resting finger
  const [held, hold] = useHold();
  const orders = useLive((s) => s.snap?.orders, 250, held) ?? NO_ORDERS;
  const tz = useStore((s) => s.tz);
  const now = useNow(1000) + useStore.getState().skew;
  const money = useAmt();
  const qOf = useQty();
  const from = useStore((s) => s.route);
  const [acct, setAcct] = useState(() => (from.account && all.some((a) => a.id === from.account) ? from.account : "all"));
  const [side, setSide] = useState<SideF>("all");
  const [q, setQ] = useState(() => (from.symbol ? `${from.symbol} ${from.venue === "usdm" ? "perp" : "spot"}` : ""));
  const [open, setOpen] = useState<OpenOrder | null>(null);

  // the search and the side before the account: the account pills count what the search leaves
  const found = useMemo(() => {
    const match = matcher(q, orders);
    return orders.filter((o) => (side === "all" || o.side === side) && match(o));
  }, [orders, side, q]);
  const rows = useMemo(
    () => found.filter((o) => acct === "all" || o.account === acct).sort((a, b) => (b.since ?? -Infinity) - (a.since ?? -Infinity)),
    [found, acct],
  );
  const through = rows.filter((o) => o.dist_bps != null && o.dist_bps < 0).length;
  const count = (f: (o: OpenOrder) => boolean) => found.filter(f).length;
  // the order as tapped, refreshed while it rests; it stays on screen after it fills or is replaced
  const sel = open ? (orders.find((o) => o.id === open.id) ?? open) : null;
  const labelOf = (id: string) => all.find((a) => a.id === id)?.label ?? id;

  return (
    <>
      <div className="o-search">
        <IconSearch size={16} stroke={1.75} />
        <input
          type="search"
          inputMode="search"
          enterKeyHint="search"
          autoCapitalize="characters"
          autoCorrect="off"
          spellCheck={false}
          placeholder="Symbol or account"
          value={q}
          onChange={(e) => setQ(e.currentTarget.value)}
          onKeyDown={(e) => e.key === "Enter" && e.currentTarget.blur()}
          aria-label="Filter orders"
        />
        {q && (
          <button type="button" onClick={() => setQ("")} aria-label="Clear filter">
            <IconX size={18} stroke={2} />
          </button>
        )}
      </div>
      <div className="o-filters">
        {/* a row that runs past the edge fades there, so a cut name reads as more to scroll to */}
        <Chips
          label="Account"
          value={acct}
          onChange={setAcct}
          data={[{ id: "all", label: "All" }, ...accounts.map((a) => ({ id: a.id, label: a.label }))].map((o) => ({
            value: o.id,
            label: o.label,
            count: count((x) => o.id === "all" || x.account === o.id),
          }))}
        />
      </div>
      <div className="m-hold" {...hold}>
        <Sec
          title={`${int(rows.length)} orders`}
          info="Resting orders, newest first. At the right: the limit price, and its distance from fair in bps (positive is passive; negative is through fair, amber) with the notional, USDT."
          right={
            <>
              {through > 0 && <span className="warn-text">{int(through)} through</span>}
              <TextToggle
                label="Side"
                className="o-tt"
                value={side}
                onChange={setSide}
                options={[
                  { value: "all", label: "Both" },
                  { value: "buy", label: "Buy" },
                  { value: "sell", label: "Sell" },
                ]}
              />
            </>
          }
        >
          {rows.slice(0, MAX_ROWS).map((o) => (
            <OrderRow key={o.id} o={o} label={labelOf(o.account)} ago={o.since != null ? span(now - o.since) : "--"} notional={money(o.notional, "k")} onOpen={setOpen} />
          ))}
          {rows.length > MAX_ROWS && <Empty>{int(rows.length - MAX_ROWS)} more; narrow the filter.</Empty>}
          {rows.length === 0 && <Empty>{orders.length ? "No order matches." : "No open orders."}</Empty>}
        </Sec>
      </div>

      <Sheet
        opened={sel != null}
        onClose={() => setOpen(null)}
        title={
          sel ? (
            <>
              {sel.symbol} <span className={sel.side === "buy" ? "o-buy" : "o-sell"}>{sel.side === "buy" ? "Buy" : "Sell"}</span>
            </>
          ) : null
        }
      >
        {sel && (
          <div className="o-sheet">
            <Stats
              cols={2}
              items={[
                { label: "Price", value: price(sel.price) },
                { label: "Fair", value: price(sel.fair) },
                { label: "From fair", value: `${bps(sel.dist_bps)} bps`, tone: sel.dist_bps != null && sel.dist_bps < 0 ? "warn" : "" },
                { label: "Amount", value: qOf(sel.qty) },
                { label: "Notional (USDT)", value: money(sel.notional, "full") },
                { label: "Account", value: labelOf(sel.account) },
                { label: "Placed", value: sel.since != null ? hms(sel.since, tz) + (tz === "utc" ? " UTC" : "") : "--" },
                { label: "Age", value: sel.since != null ? span(now - sel.since) : "--" },
              ]}
            />
            <Row
              title={
                <>
                  {sel.symbol}
                  {sel.venue === "usdm" && <span className="r-tag">Perp</span>}
                </>
              }
              sub="The instrument's page"
              value={<span className="o-open-l">Open</span>}
              onClick={() => {
                setOpen(null);
                selectInstrument({ symbol: sel.symbol, venue: sel.venue });
              }}
            />
          </div>
        )}
      </Sheet>
    </>
  );
}

type RowProps = { o: OpenOrder; label: string; ago: string; notional: string; onOpen: (o: OpenOrder) => void };

/** One resting order, in the exchange's order: symbol and side, account and age; price, then distance and
 *  notional. Re-renders only when what it shows changes. */
const OrderRow = memo(
  function OrderRow({ o, label, ago, notional, onOpen }: RowProps) {
    const through = o.dist_bps != null && o.dist_bps < 0;
    return (
      <Row
        title={
          <>
            {o.symbol}
            {o.venue === "usdm" && <span className="r-tag">Perp</span>}
            <span className={"o-side " + (o.side === "buy" ? "o-buy" : "o-sell")}>{o.side === "buy" ? "Buy" : "Sell"}</span>
          </>
        }
        sub={`${label} · ${ago}`}
        value={<span className="r-fig">{price(o.price)}</span>}
        valueSub={
          <>
            <span className={through ? "warn-text" : ""}>{bps(o.dist_bps)} bps</span> · {notional}
          </>
        }
        onClick={() => onOpen(o)}
      />
    );
  },
  (a, b) =>
    a.label === b.label &&
    a.ago === b.ago &&
    a.notional === b.notional &&
    a.onOpen === b.onOpen &&
    a.o.id === b.o.id &&
    a.o.price === b.o.price &&
    a.o.dist_bps === b.o.dist_bps &&
    a.o.side === b.o.side,
);

/** Each trading account's order rate: 10 s as `17 / 100`, the day as a share of the daily limit. */
function Rates({ accounts }: { accounts: Account[] }) {
  if (!accounts.length) return <Empty>No account is trading</Empty>;
  const lim1d = accounts.find((a) => a.orders_1d_limit > 0)?.orders_1d_limit;
  const digits = pctDigits(accounts.filter((a) => a.orders_1d_limit > 0).map((a) => a.orders_1d / a.orders_1d_limit));
  return (
    <>
      <Sec flush title="Orders 10 s" info={`${TIP.o10} Amber from 80 %, red at the limit.`}>
        {accounts.map((a) => (
          <Meter key={a.id} label={a.label} value={a.orders_10s} limit={a.orders_10s_limit} />
        ))}
      </Sec>
      <Sec
        title="Orders today"
        info={`${TIP.o1d}${lim1d ? ` The limit is ${int(lim1d)} orders a day.` : ""} Amber from 80 %, red at the limit.`}
        right={lim1d ? `of ${int(lim1d)}` : undefined}
      >
        {accounts.map((a) => (
          <Meter key={a.id} label={a.label} sub={int(a.orders_1d)} value={a.orders_1d} limit={a.orders_1d_limit} pct digits={digits} />
        ))}
      </Sec>
    </>
  );
}

/** The search as a test: words "spot" / "perp" pick the venue; the rest matches a symbol or an account. A base
 *  name that some order has exactly shows only that symbol (BTC does not also match BTCDOM). */
function matcher(q: string, orders: OpenOrder[]): (o: OpenOrder) => boolean {
  const words = q.trim().toUpperCase().split(/\s+/).filter(Boolean);
  const venue = words.includes("PERP") ? "usdm" : words.includes("SPOT") ? "spot" : null;
  const k = words.filter((w) => w !== "PERP" && w !== "SPOT").join(" ");
  const exact = k && orders.some((o) => base(o.symbol) === k);
  return (o) =>
    (!venue || o.venue === venue) &&
    (!k || (exact ? base(o.symbol) === k : o.symbol.includes(k) || o.account.toUpperCase().includes(k)));
}
