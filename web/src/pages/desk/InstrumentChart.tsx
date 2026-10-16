// The Desk's centre with an instrument picked: its market candles (Binance klines, live forming bar) with our
// fills as one circle per bar and side at our VWAP, our open orders, fair and average cost as price lines, a
// chip row for the overlays, and an Info tab.
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { getJSON, type HistFill } from "../../api";
import { useStore, type Instrument } from "../../store";
import { bps, compact, int, num, pnl, price, qty } from "../../format";
import type { Fill, OpenOrder } from "../../protocol";
import { C } from "../../theme";
import {
  ExChart,
  Tabs,
  fillMarkers,
  fillsByBar,
  fillsText,
  rgba,
  useExPref,
  useKlines,
  volumePoints,
  type ExLegendItem,
  type ExPriceLine,
  type ExSeries,
  type KInterval,
} from "../../components/ex";
import { refLabel } from "../../components/ui";
import { MASK, dd, useHide } from "./mask";

const IVS = [
  { value: "1m", label: "1m" },
  { value: "5m", label: "5m" },
  { value: "15m", label: "15m" },
  { value: "1h", label: "1H" },
  { value: "4h", label: "4H" },
  { value: "1d", label: "1D" },
];
const IV_VALUES = IVS.map((i) => i.value);
const FAIR = C.accent;

type Tab = "chart" | "info";

export function InstrumentChart({ inst, head }: { inst: Instrument; head?: ReactNode }) {
  const [tab, setTab] = useExPref<Tab>("desk.inst", "tab", "chart", ["chart", "info"]);
  return (
    <section className="dk-panel dk-centre">
      <div className="dk-head">
        <Tabs
          items={[
            { value: "chart", label: "Chart" },
            { value: "info", label: "Info" },
          ]}
          value={tab}
          onChange={setTab}
        />
        {head}
      </div>
      {tab === "chart" ? <Klines inst={inst} /> : <Info inst={inst} />}
    </section>
  );
}

const ours = (orders: readonly OpenOrder[] | undefined, i: Instrument) => (orders ?? []).filter((o) => o.symbol === i.symbol && o.venue === i.venue);

function Klines({ inst }: { inst: Instrument }) {
  const { symbol, venue } = inst;
  const [iv, setIv] = useExPref<string>("desk.inst", "interval", "5m", IV_VALUES);
  const k = useKlines(symbol, venue, iv as KInterval);
  const row = useStore((s) => s.snap?.symbols.find((r) => r.symbol === symbol && r.venue === venue));
  const orders = useStore((s) => s.snap?.orders);
  const liveFills = useStore((s) => s.snap?.fills);
  const hide = useHide();

  // fills over the loaded range: /api/fills before the snapshot's, the snapshot's after
  const [hist, setHist] = useState<{ key: string; to: number; fills: HistFill[] } | null>(null);
  const first = k.bars[0]?.time;
  const key = `${venue}:${symbol}`;
  useEffect(() => {
    if (first == null) return;
    const to = Date.now();
    let live = true;
    getJSON<HistFill[]>("/api/fills", { symbol, venue, from: first, to })
      .then((f) => live && setHist({ key, to, fills: f.filter((x) => x.venue === venue) }))
      .catch(() => {});
    return () => void (live = false);
  }, [key, first, symbol, venue]);
  const fills = useMemo(() => {
    const h = hist && hist.key === key ? hist : null;
    const mine = (liveFills ?? []).filter((f: Fill) => f.symbol === symbol && f.venue === venue);
    const oldest = mine.length ? mine[mine.length - 1]!.ts : Infinity;
    // the history up to the snapshot's oldest fill, then the snapshot's (newest first → oldest first)
    return [...(h?.fills.filter((f) => f.t < oldest) ?? []), ...mine.slice().reverse()];
  }, [hist, key, liveFills, symbol, venue]);
  const byBar = useMemo(() => fillsByBar(fills, iv as KInterval), [fills, iv]);
  const oursByBar = useMemo(() => {
    const m = new Map<number, number>();
    for (const [t, f] of byBar) m.set(t, (f.buyVwap ?? 0) * f.buyQty + (f.sellVwap ?? 0) * f.sellQty);
    return m;
  }, [byBar]);

  const mine = ours(orders, inst);
  const bids = mine.filter((o) => o.side === "buy").sort((a, b) => b.price - a.price);
  const asks = mine.filter((o) => o.side === "sell").sort((a, b) => a.price - b.price);
  const tag = { labelTextColor: C.ground };
  const lines: ExPriceLine[] = [];
  bids.forEach((o, i) =>
    lines.push(
      i === 0
        ? { series: "k", key: "orders", price: o.price, color: rgba(C.up, 0.8), title: "Bid " + o.account, labelColor: C.up, ...tag }
        : { series: "k", key: "orders", price: o.price, color: rgba(C.up, 0.35), style: "dotted", axisLabel: false },
    ),
  );
  asks.forEach((o, i) =>
    lines.push(
      i === 0
        ? { series: "k", key: "orders", price: o.price, color: rgba(C.down, 0.8), title: "Ask " + o.account, labelColor: C.down, ...tag }
        : { series: "k", key: "orders", price: o.price, color: rgba(C.down, 0.35), style: "dotted", axisLabel: false },
    ),
  );
  if (row?.fair != null) lines.push({ series: "k", key: "fair", price: row.fair, color: rgba(FAIR, 0.7), title: "Fair", style: "dotted", labelColor: FAIR, ...tag });
  if (row?.avg_cost != null) lines.push({ series: "k", key: "avg", price: row.avg_cost, color: C.muted, title: "Avg cost", style: "large", labelColor: C.raised, labelTextColor: C.ink });

  const series: ExSeries[] = [
    { key: "k", kind: "candles", label: symbol, data: k.bars, toggle: false },
    { key: "vol", kind: "histogram", label: "Vol(USDT)", data: volumePoints(k.bars, true), pane: 1, format: (v) => compact(v), lastValue: false },
  ];
  const legend: ExLegendItem[] = [
    ...(row?.fair != null ? [{ key: "fair", label: "Fair", color: FAIR, value: () => price(row.fair) }] : []),
    ...(bids.length || asks.length
      ? [
          { key: "orders", label: "Our bid", color: C.up, value: () => dd(price(bids[0]?.price)) },
          { key: "orders", label: "Our ask", color: C.down, value: () => dd(price(asks[0]?.price)) },
        ]
      : []),
    ...(row?.avg_cost != null ? [{ key: "avg", label: "Avg cost", color: C.ink2, value: () => price(row.avg_cost) }] : []),
    { key: "fills", label: "Fills", value: (t: number) => fillsText(byBar.get(t)) },
    {
      pane: 1,
      label: "Ours(USDT)",
      color: C.ink2,
      title: "Our filled notional in the bar",
      value: (t: number) => (hide ? MASK : compact(oursByBar.get(t) ?? 0)),
    },
  ];

  return (
    <div className="dk-chart-col">
      <ExChart
        id="desk.inst"
        className="dk-chart"
        fill
        title={symbol}
        series={series}
        paneStretch={[1, 0.2]}
        intervals={IVS}
        interval={iv}
        onInterval={setIv}
        loading={k.loading}
        emptyText={k.error ?? "No bars"}
        initialBars={110}
        resetKey={key}
        fullscreen
        markers={fillMarkers(byBar, "k")}
        priceLines={lines}
        legendExtra={legend}
        chips={[
          { key: "fills", label: "Fills", color: C.up, title: "Our fills: one circle per bar and side at our average price" },
          { key: "orders", label: "Orders", color: C.down, title: "Our open orders; the best on each side is labelled" },
          { key: "fair", label: "Fair", color: FAIR },
          { key: "avg", label: "Avg cost", color: C.muted },
          "|",
          { key: "vol", label: "Vol" },
        ]}
        style={{ flex: 1, minHeight: 0 }}
      />
    </div>
  );
}

function Info({ inst }: { inst: Instrument }) {
  const row = useStore((s) => s.snap?.symbols.find((r) => r.symbol === inst.symbol && r.venue === inst.venue));
  const funding = useStore((s) => s.snap?.exposure.funding.find((f) => f.symbol === inst.symbol));
  const hide = useHide();
  const m = (s: string) => (hide ? MASK : dd(s));
  const items: [string, string, string?][] = row
    ? [
        ["Venue", inst.venue === "usdm" ? "USD-M perpetual" : "Spot"],
        ["Reference", row.reference != null ? refLabel(row.reference) : "--"],
        ["Mid", dd(price(row.mid))],
        ["Fair", dd(price(row.fair))],
        ["Reference mid", dd(price(row.ref_mid))],
        ["Basis", dd(bps(row.basis_bps)) + " bps", "Mid / reference mid − 1"],
        ["Best bid", dd(price(row.bid))],
        ["Best ask", dd(price(row.ask))],
        ["Inventory", m(qty(row.inv_qty, true))],
        ["Realized", m(pnl(row.realized_pnl)), "Sells matched FIFO to today's buys, minus fees"],
        ["Floating", m(pnl(row.float_pnl)), "The inventory left, at mid, against its cost"],
        ["Unrealized", m(pnl(row.upnl))],
        ["Buys / sells", `${int(row.buys_day)} / ${int(row.sells_day)}`],
        ["Markout 10 s", dd(bps(row.mk10_bps)) + " bps", "Volume-weighted over today's fills, net of the reference move"],
        ["Markout 60 s", dd(bps(row.mk60_bps)) + " bps"],
        ["Markout 300 s", dd(bps(row.mk300_bps)) + " bps"],
        ["Our bids / asks", `${row.open_bids} / ${row.open_asks}`],
        ["Bid dist", dd(bps(row.bid_dist_bps, false)) + " bps", "Best own bid below fair"],
        ["Ask dist", dd(bps(row.ask_dist_bps, false)) + " bps", "Best own ask above fair"],
        ...(funding
          ? ([
              ["Funding rate", funding.rate == null ? "--" : num(funding.rate * 100, 4, true) + "%"],
              ["Position", m(compact(funding.position))],
            ] as [string, string][])
          : []),
      ]
    : [];
  return (
    <div className="dk-info">
      {items.map(([l, v, t]) => (
        <div key={l} className="dk-info-it">
          <span className={t ? "dotted" : undefined} title={t}>
            {l}
          </span>
          <b className="fig">{v}</b>
        </div>
      ))}
      {!row && <div className="dk-empty">Not tracked</div>}
    </div>
  );
}
