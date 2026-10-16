import { useMemo, useRef, type ReactNode } from "react";
import { UnstyledButton } from "@mantine/core";
import { navigate, serverNow, useStore } from "../../store";
import { useNow } from "../../hooks";
import { bps, compact, hm, int, price, qtyDecimals } from "../../format";
import { refLabel } from "../../components/ui";
import { KV, ListRow, Money, Section, span, tone, useHold, useLive, useMoney, type KVItem } from "../../components/mobile";
import { Tabs, useExPref, useTicker24h, type Ticker24h } from "../../components/ex";
import { QuoteRows, type QRow } from "../../components/quotes";
import type { Fill, OpenOrder, SymbolRow, Venue } from "../../protocol";
import { FillRow, MkTable, useAccountLabel, useFillSheet, useQty } from "./shared";
import { qtyText, useHide } from "../../mask";
import { InstChart } from "./desk/InstChart";
import "./desk.css";
import "./desk/in.css";

type H = "1" | "10" | "60" | "300";
const HS: H[] = ["1", "10", "60", "300"];
type Tab = "quotes" | "fills" | "markouts" | "info";

/** Notional-weighted edge and markouts over some fills. */
function weigh(fills: Fill[]) {
  const acc = { edge: [0, 0], 1: [0, 0], 10: [0, 0], 60: [0, 0], 300: [0, 0] } as Record<string, [number, number]>;
  const add = (k: string, v: number | null, w: number) => {
    if (v == null || !Number.isFinite(v)) return;
    acc[k]![0] += v * w;
    acc[k]![1] += w;
  };
  for (const f of fills) {
    add("edge", f.edge_bps, f.notional);
    for (const h of HS) add(h, f.mk[h], f.notional);
  }
  const avg = (k: string) => (acc[k]![1] > 0 ? acc[k]![0] / acc[k]![1] : null);
  return { edge: avg("edge"), mk: HS.map((h) => avg(h)), n: fills.length };
}

/** "+1.83%" / "−0.40%" / "--". */
const pctText = (v: number | null | undefined) => (v == null || !Number.isFinite(v) ? "--" : (v > 0 ? "+" : v < 0 ? "−" : "") + Math.abs(v).toFixed(2) + "%");
const bpsUnit = (v: number | null | undefined, sign = true) => (v == null ? "--" : `${bps(v, sign)} bps`);

/** One instrument, the coin page: price and 24 h stats, our figures, our quotes live, the klines with our
 *  fills and quotes on them, then Quotes | Fills | Markouts | Info. */
export function InstrumentM({ symbol, venue }: { symbol: string; venue: Venue }) {
  const r = useLive((s) => s.snap?.symbols.find((x) => x.symbol === symbol && x.venue === venue), 250, false, symbol + venue);
  const [tab, setTab] = useExPref<Tab>("instrument", "tab", "quotes", ["quotes", "fills", "markouts", "info"]);
  const t = useTicker24h(symbol, venue);
  if (!r) {
    return (
      <Section>
        <div className="m-empty">
          {symbol} {venue === "usdm" ? "perp " : ""}is not tracked right now.
        </div>
      </Section>
    );
  }
  return (
    <>
      <Header r={r} t={t} />
      <OurStats r={r} />
      {venue === "spot" && <Band symbol={symbol} venue={venue} />}
      <section className="dk-chart-sec in-chart-sec">
        <InstChart symbol={symbol} venue={venue} />
      </section>
      <div className="in-tabs">
        <Tabs
          items={[
            { value: "quotes", label: "Quotes" },
            { value: "fills", label: "Fills" },
            { value: "markouts", label: "Markouts" },
            { value: "info", label: "Info" },
          ]}
          value={tab}
          onChange={setTab}
        />
      </div>
      {tab === "quotes" && <QuotesTab r={r} />}
      {tab === "fills" && <FillsTab r={r} />}
      {tab === "markouts" && <MarkoutsTab r={r} />}
      {tab === "info" && <InfoTab r={r} />}
    </>
  );
}

// ---- header: the mid big, coloured by its last move; Binance's 24 h figures at the right ----

function Header({ r, t }: { r: SymbolRow; t: Ticker24h | null }) {
  const last = useRef<{ mid: number | null; dir: "" | "up" | "down" }>({ mid: null, dir: "" });
  const m = last.current;
  if (r.mid != null && m.mid != null && r.mid !== m.mid) m.dir = r.mid > m.mid ? "up" : "down";
  m.mid = r.mid;
  const asset = r.symbol.replace(/USDT$/, "");
  const chg = t?.changePct ?? null;
  return (
    <section className="in-head">
      <div className="in-head-l">
        <div className={"in-mid m-fig " + m.dir}>{r.mid == null ? "--" : price(r.mid)}</div>
        <div className="in-mid-sub m-fig">
          {/* the big figure is the book's mid: the chart's last close and the fair (legend) are the other two prices */}
          <span>Mid</span>
          <span className="in-venue">{r.venue === "usdm" ? "Perp" : "Spot"}</span>
          <span>
            24h <span className={tone(chg, pctText(chg))}>{pctText(chg)}</span>
          </span>
        </div>
      </div>
      <dl className="in-24">
        <div>
          <dt>24h High</dt>
          <dd>{t ? price(t.high) : "--"}</dd>
        </div>
        <div>
          <dt>24h Vol({asset})</dt>
          <dd>{t ? compact(t.volume) : "--"}</dd>
        </div>
        <div>
          <dt>24h Low</dt>
          <dd>{t ? price(t.low) : "--"}</dd>
        </div>
        <div>
          <dt>24h Vol(USDT)</dt>
          <dd>{t ? compact(t.quoteVolume) : "--"}</dd>
        </div>
      </dl>
    </section>
  );
}

// ---- our figures: one row, label over value ----

function OurStats({ r }: { r: SymbolRow }) {
  const q = useQty();
  const leg = useStore((s) => s.snap?.exposure.hedge_day?.legs.find((l) => l.symbol === r.symbol));
  const funding = useStore((s) => s.snap?.exposure.funding.find((f) => f.symbol === r.symbol));
  const hide = useHide();
  const asset = r.symbol.replace(/USDT$/, "");
  const perp = r.venue === "usdm";
  const items: { label: string; value: ReactNode }[] = perp
    ? [
        { label: `Position (${asset})`, value: q(r.inv_qty, true) },
        { label: "Entry", value: price(r.avg_cost) },
        // a perp is the hedge: its leg's P&L today (it has no Trading PnL, as on the Desk and Markets)
        { label: "Hedge", value: <Money v={leg?.pnl ?? null} /> },
        {
          label: "Funding",
          value: funding?.rate != null ? <span className={tone(-funding.rate * Math.sign(r.inv_qty), bps(funding.rate * 1e4))}>{bpsUnit(funding.rate * 1e4)}</span> : "--",
        },
      ]
    : [
        { label: `Inventory (${asset})`, value: r.inv_qty === 0 && !hide ? "flat" : q(r.inv_qty, true) },
        { label: "Avg cost", value: r.inv_qty === 0 ? "--" : price(r.avg_cost) },
        { label: "Trading PnL", value: <Money v={r.trading_pnl} /> },
        { label: "Edge", value: <span className={tone(r.edge_bps, bps(r.edge_bps))}>{bpsUnit(r.edge_bps)}</span> },
      ];
  return (
    <dl className="in-stats">
      {items.map((it) => (
        <div key={it.label}>
          <dt>{it.label}</dt>
          <dd className="m-fig">{it.value}</dd>
        </div>
      ))}
    </dl>
  );
}

// ---- the live band: our bids and asks around fair, the market's bid–ask ----

function Band({ symbol, venue }: { symbol: string; venue: Venue }) {
  const sym = useLive((s) => s.snap?.symbols.find((x) => x.symbol === symbol && x.venue === venue), 250, false, symbol + venue);
  const orders = useLive((s) => s.snap?.orders, 250);
  const rows: QRow[] = useMemo(
    () => (sym ? [{ sym, orders: (orders ?? []).filter((o) => o.symbol === symbol && o.venue === venue) }] : []),
    [sym, orders, symbol, venue],
  );
  // the band's reading, always up: our best bid and ask from fair (signed as the axis), the market's spread
  const nb = rows[0]?.orders.some((o) => o.side === "buy") ?? false;
  const na = rows[0]?.orders.some((o) => o.side === "sell") ?? false;
  const d = (v: number | null | undefined, neg: boolean) => (v == null ? "--" : `${bps(neg ? -v : v)} bps`);
  return (
    <section className="in-band">
      <div className="q-legend in-band-legend m-fig">
        <span>
          <i className="q-lg-dot up" /> Our bid <b className={nb ? "up" : "muted"}>{nb ? d(sym?.bid_dist_bps, true) : "None"}</b>
        </span>
        <span>
          <i className="q-lg-dot down" /> Our ask <b className={na ? "down" : "muted"}>{na ? d(sym?.ask_dist_bps, false) : "None"}</b>
        </span>
        <span>
          <i className="q-lg-band" /> Spread <b>{sym?.spread_bps == null ? "--" : `${bps(sym.spread_bps, false)} bps`}</b>
        </span>
      </div>
      <QuoteRows rows={rows} range={25} rowH={30} label={0} status={false} empty="No quotes" />
    </section>
  );
}

// ---- tabs ----

function QuotesTab({ r }: { r: SymbolRow }) {
  const orders = useLive((s) => s.snap?.orders, 500);
  const ours = (orders ?? []).filter((o) => o.symbol === r.symbol && o.venue === r.venue);
  const bids = ours.filter((o) => o.side === "buy").sort((a, b) => b.price - a.price);
  const asks = ours.filter((o) => o.side === "sell").sort((a, b) => a.price - b.price);
  const max = Math.max(1, ...ours.map((o) => o.notional));
  // one precision down the sizes (fixed: they line up), the largest order's
  const qd = qtyDecimals(Math.max(0, ...ours.map((o) => o.qty)));
  const n = Math.max(bids.length, asks.length);
  // our distances from fair and the spread are in the band above, the fair in the chart's legend
  const items: KVItem[] = [
    { label: "Market bid", value: <span className="up">{price(r.bid)}</span> },
    { label: "Market ask", value: <span className="down">{price(r.ask)}</span> },
  ];
  return (
    <section className="in-tab">
      {n > 0 ? (
        <div className="in-ladder">
          <div className="in-ladder-h">
            <span>Our bids</span>
            <span>Our asks</span>
          </div>
          {Array.from({ length: Math.min(n, 8) }, (_, i) => (
            <div key={i} className="in-ladder-row">
              <LadderCell o={bids[i]} max={max} side="buy" qd={qd} />
              <LadderCell o={asks[i]} max={max} side="sell" qd={qd} />
            </div>
          ))}
        </div>
      ) : (
        <div className="m-empty">No resting orders on {r.symbol} right now.</div>
      )}
      {ours.length > 0 && (
        <UnstyledButton className="m-link in-more" onClick={() => navigate({ page: "orders", symbol: r.symbol, venue: r.venue })}>
          All {ours.length} open order{ours.length === 1 ? "" : "s"} on the Orders page
        </UnstyledButton>
      )}
      <div className="in-kv">
        <KV cols={2} items={items} />
      </div>
    </section>
  );
}

function LadderCell({ o, max, side, qd }: { o: OpenOrder | undefined; max: number; side: "buy" | "sell"; qd: number }) {
  const hide = useHide();
  const q = (v: number) => qtyText(v, hide, false, qd);
  const label = useAccountLabel(o?.account ?? "");
  if (!o) return <span className={"in-lc " + side} />;
  return (
    <span className={"in-lc " + side}>
      <i className="in-lc-bar" style={{ width: `${Math.max(4, (o.notional / max) * 100)}%` }} aria-hidden />
      {side === "buy" ? (
        <>
          <span className="in-lc-q">
            <span className="in-lc-a">{label}</span> {q(o.qty)}
          </span>
          <span className="in-lc-p up">{price(o.price)}</span>
        </>
      ) : (
        <>
          <span className="in-lc-p down">{price(o.price)}</span>
          <span className="in-lc-q">
            {q(o.qty)} <span className="in-lc-a">{label}</span>
          </span>
        </>
      )}
    </span>
  );
}

function FillsTab({ r }: { r: SymbolRow }) {
  const [held, hold] = useHold();
  const all = useLive((s) => s.snap?.fills, 500, held);
  const mine = useMemo(() => (all ?? []).filter((f) => f.symbol === r.symbol && f.venue === r.venue), [all, r.symbol, r.venue]);
  const fill = useFillSheet();
  useNow(1000);
  return (
    <section className="in-tab">
      <KV
        cols={3}
        items={[
          { label: "Buys", value: int(r.buys_day) },
          { label: "Sells", value: int(r.sells_day) },
          { label: "Volume", value: <Money v={r.volume_day} kind="short" />, info: "Filled notional today, USDT." },
        ]}
      />
      <div className="in-rows">
        <div className="m-hold" {...hold}>
          {mine.slice(0, 30).map((f) => (
            <FillRow key={f.id} f={f} onOpen={fill.open} symbol={false} />
          ))}
        </div>
        {mine.length === 0 && <div className="m-empty">No fills today.</div>}
      </div>
      <div className="in-link">
        <ListRow dense title="Fill history" secondary="by day" to={{ page: "history", detail: { kind: "history-instrument", symbol: r.symbol, venue: r.venue } }} />
      </div>
      {fill.sheet}
    </section>
  );
}

function MarkoutsTab({ r }: { r: SymbolRow }) {
  const all = useLive((s) => s.snap?.fills, 1000);
  const mine = useMemo(() => (all ?? []).filter((f) => f.symbol === r.symbol && f.venue === r.venue), [all, r.symbol, r.venue]);
  const mk = useMemo(
    () => ({ all: weigh(mine), buy: weigh(mine.filter((f) => f.side === "buy")), sell: weigh(mine.filter((f) => f.side === "sell")) }),
    [mine],
  );
  return (
    <section className="in-tab">
      <MkTable
        rows={[
          { label: "Today", edge: r.edge_bps, v: [mk.all.mk[0], r.mk10_bps, r.mk60_bps, r.mk300_bps] },
          { label: "Buys", edge: mk.buy.edge, v: mk.buy.mk },
          { label: "Sells", edge: mk.sell.edge, v: mk.sell.mk },
        ]}
      />
      <p className="in-note">
        Edge: side × (fair − price) / fair at the fill. 1 s … 300 s: side × (mid that long after / price − 1), net of the reference move.
        Notional-weighted, bps. Buys and sells: the {int(mk.all.n)} recent fills.
      </p>
    </section>
  );
}

function InfoTab({ r }: { r: SymbolRow }) {
  const money = useMoney();
  const tz = useStore((s) => s.tz);
  const funding = useStore((s) => s.snap?.exposure.funding.find((f) => f.symbol === r.symbol));
  const mark = useStore((s) => {
    for (const a of s.snap?.accounts ?? []) for (const p of a.positions) if (p.symbol === r.symbol) return p.mark;
    return null;
  });
  useNow(5000);
  const perp = r.venue === "usdm";
  const items: KVItem[] = [
    { label: perp ? "Notional" : "Inventory value", value: money(r.inv_value, "usd") },
    { label: "Market making", value: <Money v={r.mm_pnl} />, info: "Each fill against the mid 60 s later, minus fees, USDT." },
    { label: "Inventory PnL", value: <Money v={r.inv_pnl} />, info: "Trading PnL minus market making, USDT." },
    { label: "Realized", value: <Money v={r.realized_pnl} /> },
    { label: "Floating", value: <Money v={r.float_pnl} /> },
    { label: "Last fill", value: r.last_fill != null ? `${span(serverNow() - r.last_fill)} ago` : "--" },
  ];
  if (r.reference != null)
    items.push(
      { label: "Reference", value: refLabel(r.reference), info: "The instrument whose move markouts are netted against." },
      { label: "Ref mid", value: price(r.ref_mid) },
      { label: "Basis", value: bpsUnit(r.basis_bps), info: "mid / reference mid − 1, bps." },
    );
  if (perp) {
    items.push({ label: "Mark", value: price(mark) });
    items.push({
      label: "Next funding",
      value: funding?.next != null ? `${hm(funding.next, tz)}${tz === "utc" ? " UTC" : ""}` : "--",
    });
  }
  return (
    <section className="in-tab">
      <KV cols={3} items={items} />
    </section>
  );
}
