import { memo, useMemo, useState } from "react";
import { UnstyledButton } from "@mantine/core";
import { IconSearch, IconX } from "@tabler/icons-react";
import { useStore } from "../../store";
import { useNow } from "../../hooks";
import { bps, hms, int, price } from "../../format";
import {
  Chips,
  KV,
  ListRow,
  Section,
  Segmented,
  Sheet,
  Side,
  Tag,
  span,
  useHold,
  useLive,
  useMoney,
} from "../../components/mobile";
import type { Account, OpenOrder } from "../../protocol";
import { RateSections, useQty } from "./shared";
import "./ops.css";

const base = (s: string) => s.replace(/USDT$/, "");
const MAX_ROWS = 200;
const NO_ORDERS: OpenOrder[] = [];
const NO_ACCOUNTS: Account[] = [];

type SideF = "all" | "buy" | "sell";

/** Orders: each trading account's order rate against Binance's limits, then the resting orders. */
export function OrdersM() {
  // The page renders when a list is handed over (4 a second at most), not on every message, and the order
  // list holds still while a finger rests on it.
  const [held, hold] = useHold();
  const orders = useLive((s) => s.snap?.orders, 250, held) ?? NO_ORDERS;
  const accounts = useLive((s) => s.snap?.accounts, 1000) ?? NO_ACCOUNTS;
  const tz = useStore((s) => s.tz);
  const now = useNow(1000) + useStore.getState().skew;
  const money = useMoney();
  const qOf = useQty();
  // opened from an instrument (#/orders/BTCUSDT/spot): its orders, by name and venue
  const from = useStore((s) => s.route);
  const [acct, setAcct] = useState("all");
  const [side, setSide] = useState<SideF>("all");
  const [q, setQ] = useState(() => (from.symbol ? `${from.symbol} ${from.venue === "usdm" ? "perp" : "spot"}` : ""));
  const [open, setOpen] = useState<OpenOrder | null>(null);
  const [ratesOpen, setRatesOpen] = useState(false);

  const trading = accounts.filter((a) => a.role !== "master" && (a.open_orders > 0 || a.inventory_value > 1));

  // the search and the side, before the account: the account chips count what the search leaves
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
  const labelOf = (id: string) => accounts.find((a) => a.id === id)?.label ?? id;

  // a symbol filter (typed, or opened from an instrument) is a question about those orders: they come first and
  // the rate limits fold into one line under them
  const filtered = q.trim() !== "";
  const rates = (
    <>
      <RateSections accounts={trading} />
      {trading.length === 0 && (
        <Section title="Order rate">
          <div className="m-empty">No account is trading</div>
        </Section>
      )}
    </>
  );

  return (
    <>
      {!filtered && rates}

      <Section
        title="Open orders"
        info="Resting orders, newest first. At the right: the limit price and its distance from fair, bps (positive is passive, negative is through fair, amber); notional is price × remaining quantity, USDT."
        card={false}
        right={
          through > 0 ? <span className="warn-text">{int(through)} through fair</span> : "newest first"
        }
      >
        <div className="m-ops-search">
          <IconSearch size={16} stroke={1.75} className="m-ops-search-icon" />
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
            <UnstyledButton className="m-ops-search-clear" onClick={() => setQ("")} aria-label="Clear filter">
              <IconX size={18} stroke={2} />
            </UnstyledButton>
          )}
        </div>
        <div className="m-ops-filters">
          <Chips
            value={acct}
            onChange={setAcct}
            label="Account"
            data={[{ id: "all", label: "All" }, ...trading.map((a) => ({ id: a.id, label: a.label }))].map((o) => ({
              value: o.id,
              label: o.label,
              count: count((x) => o.id === "all" || x.account === o.id),
            }))}
          />
          <Segmented
            value={side}
            onChange={setSide}
            label="Side"
            data={[
              { value: "all", label: "Both" },
              { value: "buy", label: "Bids" },
              { value: "sell", label: "Asks" },
            ]}
          />
        </div>
      </Section>

      <div className="m-hold" {...hold}>
      <Section>
        {rows.slice(0, MAX_ROWS).map((o) => (
          <OrderRow
            key={o.id}
            o={o}
            label={labelOf(o.account)}
            ago={o.since != null ? span(now - o.since) : "—"}
            notional={money(o.notional, "short")}
            onOpen={setOpen}
          />
        ))}
        {rows.length > MAX_ROWS && <div className="m-empty">{int(rows.length - MAX_ROWS)} more; narrow the filter.</div>}
        {rows.length === 0 && <div className="m-empty">{orders.length ? "No order matches." : "No open orders."}</div>}
      </Section>
      </div>

      {filtered && (ratesOpen ? rates : <RateLine accounts={trading} onOpen={() => setRatesOpen(true)} />)}

      <Sheet
        opened={sel != null}
        onClose={() => setOpen(null)}
        title={
          sel ? (
            <>
              {sel.symbol} <Side side={sel.side} words={["bid", "ask"]} />
            </>
          ) : null
        }
      >
        {sel && (
          <div className="m-body">
            <KV
              cols={2}
              items={[
                { label: "Price", value: price(sel.price) },
                { label: "Fair", value: price(sel.fair) },
                {
                  label: "From fair",
                  value: `${bps(sel.dist_bps)} bps`,
                  tone: sel.dist_bps != null && sel.dist_bps < 0 ? "warn" : undefined,
                },
                { label: "Quantity", value: qOf(sel.qty) },
                { label: "Notional (USDT)", value: money(sel.notional, "usd") },
                { label: "Account", value: labelOf(sel.account) },
                { label: "Placed", value: sel.since != null ? hms(sel.since, tz) + (tz === "utc" ? " UTC" : "") : "—" },
                { label: "Age", value: sel.since != null ? span(now - sel.since) : "—" },
              ]}
            />
            <ListRow
              dense
              title={
                <>
                  Open {sel.symbol}
                  {sel.venue === "usdm" && <Tag>perp</Tag>}
                </>
              }
              to={{ page: "desk", detail: { kind: "instrument", symbol: sel.symbol, venue: sel.venue } }}
            />
          </div>
        )}
      </Sheet>
    </>
  );
}

/** The order rates in one line: the busiest account on each limit; tapping it shows every account's meters. */
function RateLine({ accounts, onOpen }: { accounts: Account[]; onOpen: () => void }) {
  const worst = (f: (a: Account) => number) =>
    accounts.reduce<Account | null>((m, a) => (f(a) > (m ? f(m) : -1) ? a : m), null);
  const r10 = (a: Account) => (a.orders_10s_limit > 0 ? a.orders_10s / a.orders_10s_limit : 0);
  const r1d = (a: Account) => (a.orders_1d_limit > 0 ? a.orders_1d / a.orders_1d_limit : 0);
  const w10 = worst(r10);
  const w1d = worst(r1d);
  const tone = Math.max(w10 ? r10(w10) : 0, w1d ? r1d(w1d) : 0);
  const parts = [
    w10 && w10.orders_10s_limit > 0 ? `10 s ${w10.label} ${int(w10.orders_10s)} / ${int(w10.orders_10s_limit)}` : null,
    w1d && w1d.orders_1d_limit > 0 ? `1 d ${w1d.label} ${Math.round(100 * r1d(w1d))}%` : null,
  ].filter(Boolean);
  return (
    <Section>
      <ListRow
        dense
        title="Order rates"
        tone={tone >= 1 ? "crit" : tone >= 0.8 ? "warn" : undefined}
        primary={<span className="m-fig m-ops-rateline">{parts.length ? parts.join(" · ") : "no account trading"}</span>}
        onClick={onOpen}
      />
    </Section>
  );
}

type RowProps = { o: OpenOrder; label: string; ago: string; notional: string; onOpen: (o: OpenOrder) => void };

/** One resting order. Re-renders only when what it shows changes, not with each hand-over of the list. */
const OrderRow = memo(
  function OrderRow({ o, label, ago, notional, onOpen }: RowProps) {
    return (
      <ListRow
        chevron={false}
        title={
          <>
            {o.symbol}
            {o.venue === "usdm" && <Tag>perp</Tag>}
            <Side side={o.side} words={["bid", "ask"]} />
          </>
        }
        subtitle={`${label} · ${ago}`}
        primary={
          <>
            {price(o.price)}
            <span className={"m-ops-dist " + (o.dist_bps != null && o.dist_bps < 0 ? "warn-text" : "muted")}>
              {bps(o.dist_bps)}
              <span className="m-unit">bps from fair</span>
            </span>
          </>
        }
        secondary={`notional ${notional}`}
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
