import { useMemo } from "react";
import { serverNow, useStore } from "../../store";
import { useNow } from "../../hooks";
import { bps, hm, int, price } from "../../format";
import { refLabel } from "../../components/ui";
import { Hero, KV, ListRow, Money, Section, SplitRows, span, tone, useHold, useLive, type KVItem } from "../../components/mobile";
import type { Fill, Venue } from "../../protocol";
import { FillRow, instPnl, MkTable, useFillSheet, useQty } from "./shared";
import "./desk.css";

type H = "1" | "10" | "60" | "300";
const HS: H[] = ["1", "10", "60", "300"];

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

/** One instrument: its PnL and what made it, the inventory, markouts, quotes and its latest fills. */
export function InstrumentM({ symbol, venue }: { symbol: string; venue: Venue }) {
  const r = useLive((s) => s.snap?.symbols.find((x) => x.symbol === symbol && x.venue === venue), 250, false, symbol + venue);
  const leg = useStore((s) => s.snap?.exposure.hedge_day?.legs.find((l) => l.symbol === symbol));
  const funding = useStore((s) => s.snap?.exposure.funding.find((f) => f.symbol === symbol));
  const tz = useStore((s) => s.tz);
  // the mark price of the position, where an account holds it (a perp's book mid is not its mark)
  const mark = useStore((s) => {
    for (const a of s.snap?.accounts ?? []) for (const p of a.positions) if (p.symbol === symbol) return p.mark;
    return null;
  });
  const [held, hold] = useHold();
  const all = useLive((s) => s.snap?.fills, 500, held);
  const q = useQty();
  useNow(1000);
  const mine = useMemo(() => (all ?? []).filter((f) => f.symbol === symbol && f.venue === venue), [all, symbol, venue]);
  const mk = useMemo(
    () => ({ all: weigh(mine), buy: weigh(mine.filter((f) => f.side === "buy")), sell: weigh(mine.filter((f) => f.side === "sell")) }),
    [mine],
  );
  const fill = useFillSheet();
  if (!r) {
    return (
      <Section>
        <div className="m-empty">
          {symbol} {venue === "usdm" ? "perp " : ""}is not tracked right now.
        </div>
      </Section>
    );
  }
  const perp = venue === "usdm";
  const last = r.last_fill != null ? `last fill ${span(serverNow() - r.last_fill)} ago` : undefined;
  const asset = symbol.replace(/USDT$/, "");

  const quotes: KVItem[] = [
    {
      label: "Bid below fair",
      value: <>{bps(r.bid_dist_bps, false)}{r.bid_dist_bps != null && <span className="m-unit">bps</span>}</>,
      info: "Best own bid below fair: (fair − bid) / fair, bps.",
    },
    {
      label: "Ask above fair",
      value: <>{bps(r.ask_dist_bps, false)}{r.ask_dist_bps != null && <span className="m-unit">bps</span>}</>,
      info: "Best own ask above fair: (ask − fair) / fair, bps.",
    },
    { label: "Fair", value: price(r.fair), info: "The fair price the quotes are set around, USDT." },
    { label: "Best bid", value: price(r.bid), info: "The market's best bid, USDT." },
    { label: "Best ask", value: price(r.ask), info: "The market's best ask, USDT." },
    { label: "Spread", value: <>{bps(r.spread_bps, false)}<span className="m-unit">bps</span></>, info: "(ask − bid) / mid, bps." },
  ];
  if (r.reference != null) {
    quotes.push(
      { label: "Reference", value: refLabel(r.reference), span: 1, info: "The instrument whose move markouts are netted against." },
      { label: "Ref mid", value: price(r.ref_mid), info: "Mid of the reference instrument, USDT." },
      { label: "Basis", value: <>{bps(r.basis_bps)}{r.basis_bps != null && <span className="m-unit">bps</span>}</>, info: "mid / reference mid − 1, bps." },
    );
  }

  const fillsList = (
    <div className="m-hold" {...hold}>
      <Section
        title="Fills"
        right={mine.length > 0 ? `latest ${Math.min(20, mine.length)}` : undefined}
        link={{ label: "History", to: { page: "history", detail: { kind: "history-instrument", symbol, venue } } }}
      >
        <KV
          cols={3}
          items={[
            { label: "Buys", value: int(r.buys_day) },
            { label: "Sells", value: int(r.sells_day) },
            { label: "Volume", value: <Money v={r.volume_day} kind="short" />, info: "Filled notional today, USDT." },
          ]}
        />
        {mine.slice(0, 20).map((f) => (
          <FillRow key={f.id} f={f} onOpen={fill.open} symbol={false} />
        ))}
        {mine.length === 0 && <div className="m-empty">No recent fills</div>}
      </Section>
    </div>
  );

  if (perp) {
    const fundingTone = funding?.rate != null ? -funding.rate * Math.sign(r.inv_qty) : undefined;
    return (
      <>
        <Section>
          <Hero
            label="PnL today"
            info="This futures leg since the day start: price at mark, minus fees, plus funding (the Desk counts it as Hedge). Before the leg's first mark of the day: the position's unrealized PnL. USDT."
            v={leg?.pnl ?? r.upnl}
            sub={last && <span className="muted">{last}</span>}
          />
        </Section>
        <Section title="Position">
          <KV
            cols={3}
            items={[
              { label: `Qty ${asset}`, value: q(r.inv_qty, true), info: "Position size, all accounts; negative = short." },
              { label: "Notional", value: <Money v={r.inv_value} kind="usd" color={false} />, info: "Quantity × mark, USDT." },
              { label: "Entry", value: price(r.avg_cost), info: "Entry price of the position, USDT." },
              mark != null
                ? { label: "Mark", value: price(mark), info: "The futures mark price, USDT." }
                : { label: "Mid", value: price(r.mid), info: "(best bid + best ask) / 2 of the futures book, USDT." },
              { label: "Spread", value: <>{bps(r.spread_bps, false)}<span className="m-unit">bps</span></>, info: "(ask − bid) / mid, bps." },
              {
                label: "Funding",
                value: funding?.rate != null ? <span className={tone(fundingTone, bps(funding.rate * 1e4))}>{bps(funding.rate * 1e4)}<span className="m-unit">bps</span></span> : "—",
                info:
                  "The current funding rate, bps per period; longs pay shorts when it is positive. Green when it pays this position." +
                  (funding?.next != null ? ` Next at ${hm(funding.next, tz)}${tz === "utc" ? " UTC" : ""}.` : ""),
              },
            ]}
          />
        </Section>
        {fillsList}
        {fill.sheet}
      </>
    );
  }

  return (
    <>
      <Section>
        <Hero label="PnL today" info="Market making plus inventory PnL today, all accounts, USDT." v={instPnl(r)} sub={last && <span className="muted">{last}</span>} />
        <SplitRows
          waterfall
          rows={[
            { key: "mm", label: "Market making", info: "Each fill against the mid 60 s later, minus fees, USDT.", v: r.mm_pnl },
            {
              key: "inv",
              label: "Inventory PnL",
              info: "Trading PnL minus market making: what the held inventory made after those 60 s, USDT.",
              v: r.inv_pnl,
            },
          ]}
        />
      </Section>

      {r.inv_qty === 0 ? (
        <Section title="Inventory" right="flat" card={false}>
          {null}
        </Section>
      ) : (
        <Section title="Inventory" right="all accounts">
          <KV
            cols={3}
            items={[
              { label: `Qty ${asset}`, value: q(r.inv_qty, true), info: "Quantity held, free + locked, all accounts." },
              { label: "Value", value: <Money v={r.inv_value} kind="usd" color={false} />, info: "Quantity × mid, USDT." },
              { label: "Avg cost", value: price(r.avg_cost), info: "Average cost from today's fills, USDT per unit." },
            ]}
          />
        </Section>
      )}

      <Section
        title="Markouts"
        info={
          "Edge: side × (fair − price) / fair at the fill. 1 s … 300 s: side × (mid that long after the fill / price − 1), net of the reference move from 1 s after the fill where a reference exists. Notional-weighted, bps; a diagnostic, not PnL." +
          `\n\nToday: the instrument's whole day (its 1 s from the recent fills). Buys and sells: the ${int(mk.all.n)} recent fills.`
        }
      >
        <MkTable
          rows={[
            { label: "Today", edge: r.edge_bps, v: [mk.all.mk[0], r.mk10_bps, r.mk60_bps, r.mk300_bps] },
            { label: "Buys", edge: mk.buy.edge, v: mk.buy.mk },
            { label: "Sells", edge: mk.sell.edge, v: mk.sell.mk },
          ]}
        />
      </Section>

      <Section title="Quotes">
        <KV cols={3} items={quotes} />
        <OrdersRow symbol={symbol} venue={venue} bids={r.open_bids} asks={r.open_asks} />
      </Section>

      {fillsList}
      {fill.sheet}
    </>
  );
}

/** The instrument's resting orders, all accounts: opens Orders filtered to it. */
function OrdersRow({ symbol, venue, bids, asks }: { symbol: string; venue: Venue; bids: number; asks: number }) {
  return (
    <ListRow
      dense
      title="Open orders"
      primary={
        <span className="m-fig">
          {int(bids)} {bids === 1 ? "bid" : "bids"} · {int(asks)} {asks === 1 ? "ask" : "asks"}
        </span>
      }
      to={{ page: "orders", symbol, venue }}
    />
  );
}
