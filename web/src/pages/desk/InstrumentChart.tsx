// The Desk's centre with an instrument picked: its market candles (Binance klines, live forming bar) with our
// fills as one circle per bar and side at our VWAP, our open orders, fair and average cost as price lines, a
// chip row for the overlays, and an Info tab.
import { useMemo, useRef, type ReactNode } from "react";
import { useStore, type Instrument } from "../../store";
import { useInstFills } from "./instFills";
import { bps, compact, int, num, pnl, price, qty } from "../../format";
import type { OpenOrder } from "../../protocol";
import { C, INV_COLOR, PNL_COLORS } from "../../theme";
import { Stable, sameValue } from "./model";
import {
  ExChart,
  INTERVAL_MS,
  closePoints,
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
import { maskFormat, maskNode, useHide } from "../../mask";

// research §3.2: Line 1s 1m 5m 15m 1H 4H 1D ▾(30m 1W), 1m first. No 1s: the server's kline proxy has no 1 s
// bars (spec, Data), and the Line already draws the 1 m closes.
const IVS = [
  { value: "line", label: "Line", title: "A line on the 1m closes" },
  { value: "1m", label: "1m" },
  { value: "5m", label: "5m" },
  { value: "15m", label: "15m" },
  { value: "1h", label: "1H" },
  { value: "4h", label: "4H" },
  { value: "1d", label: "1D" },
];
const MORE = [
  { value: "30m", label: "30m" },
  { value: "1w", label: "1W" },
];
const IV_VALUES = [...IVS, ...MORE].map((i) => i.value);
const FAIR = C.accent;
const INV_LINE = INV_COLOR;
const POS_PNL = PNL_COLORS.trading;
// our own notional filled: ink (the market's volume beside it is up / down)
const OURS = rgba(C.ink, 0.7);

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
  const [iv, setIv] = useExPref<string>("desk.inst", "interval", "1m", IV_VALUES);
  const line = iv === "line";
  const kIv = (line ? "1m" : iv) as KInterval;
  const k = useKlines(symbol, venue, kIv);
  const row = useStore((s) => s.snap?.symbols.find((r) => r.symbol === symbol && r.venue === venue));
  const orders = useStore((s) => s.snap?.orders);
  const hide = useHide();

  // our fills over the loaded range (instFills.ts: the history, its tail fetched again, the live tape after)
  const first = k.bars[0]?.time ?? null;
  const key = `${venue}:${symbol}`;
  const own = useInstFills(symbol, venue, first);
  const fills = own.fills;
  const byBar = useMemo(() => fillsByBar(fills, kIv), [fills, kIv]);

  // Inventory and Position P&L per bar, rebuilt from today's inventory back through our fills: valid once the
  // fills cover the whole range
  const invNow = row?.inv_qty ?? null;
  const cut = own.complete && first != null ? first : Infinity;
  const position = useMemo(() => {
    const bars = k.bars;
    if (invNow == null || !bars.length || !Number.isFinite(cut)) return null;
    const step = INTERVAL_MS[kIv];
    const ft = (f: (typeof fills)[number]) => f.t;
    const sq = (f: (typeof fills)[number]) => (f.side === "buy" ? f.qty : -f.qty);
    let j = fills.findIndex((f) => ft(f) >= cut);
    if (j < 0) j = fills.length;
    let run = invNow;
    for (let i = j; i < fills.length; i++) run -= sq(fills[i]!);
    const inv0 = run;
    let cash = 0;
    let open0: number | null = null;
    const inv: { time: number; value: number | null }[] = [];
    const pnl: { time: number; value: number | null }[] = [];
    bars.forEach((b, i) => {
      const end = i === bars.length - 1 ? Infinity : b.time + step;
      if (end <= cut) {
        inv.push({ time: b.time, value: null });
        pnl.push({ time: b.time, value: null });
        return;
      }
      if (open0 == null) open0 = b.time >= cut ? b.open : b.close;
      while (j < fills.length && ft(fills[j]!) < end) {
        const f = fills[j]!;
        run += sq(f);
        cash -= sq(f) * f.price;
        j++;
      }
      inv.push({ time: b.time, value: run });
      pnl.push({ time: b.time, value: run * b.close + cash - inv0 * open0 });
    });
    return { inv, pnl };
  }, [k.bars, fills, invNow, cut, kIv]);
  const oursByBar = useMemo(() => {
    const m = new Map<number, number>();
    for (const [t, f] of byBar) m.set(t, (f.buyVwap ?? 0) * f.buyQty + (f.sellVwap ?? 0) * f.sellQty);
    return m;
  }, [byBar]);

  const mine = ours(orders, inst);
  const bids = mine.filter((o) => o.side === "buy").sort((a, b) => b.price - a.price);
  const asks = mine.filter((o) => o.side === "sell").sort((a, b) => a.price - b.price);
  const fair = row?.fair ?? null;
  const avg = row?.avg_cost ?? null;
  // a key of what the lines show, so they are rebuilt only when a price moves (not on every store update)
  const linesKey = [bids.map((o) => o.price).join(","), asks.map((o) => o.price).join(","), fair, avg].join("|");
  // price lines are labelled on the axis only (a title inside the plot covers the last candles); the legend
  // names them. Our quotes, fair and average cost have dark tags with coloured text: the one solid tag is the
  // market's last price (the candle series' own)
  const lines = useMemo<ExPriceLine[]>(() => {
    const out: ExPriceLine[] = [];
    bids.forEach((o, i) =>
      out.push(
        i === 0
          ? { series: "k", key: "quotes", price: o.price, color: rgba(C.up, 0.8), labelColor: C.raised, labelTextColor: C.up }
          : { series: "k", key: "quotes", price: o.price, color: rgba(C.up, 0.35), style: "dotted", axisLabel: false },
      ),
    );
    asks.forEach((o, i) =>
      out.push(
        i === 0
          ? { series: "k", key: "quotes", price: o.price, color: rgba(C.down, 0.8), labelColor: C.raised, labelTextColor: C.down }
          : { series: "k", key: "quotes", price: o.price, color: rgba(C.down, 0.35), style: "dotted", axisLabel: false },
      ),
    );
    if (fair != null) out.push({ series: "k", key: "fair", price: fair, color: rgba(FAIR, 0.7), style: "dotted", labelColor: C.raised, labelTextColor: FAIR });
    if (avg != null) out.push({ series: "k", key: "avg", price: avg, color: C.muted, style: "large", labelColor: C.raised, labelTextColor: C.ink });
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [linesKey]);
  const markers = useMemo(() => fillMarkers(byBar, "k"), [byBar]);

  const stable = useRef(new Stable()).current;
  const oursPts = useMemo(() => k.bars.map((b) => ({ time: b.time, value: oursByBar.get(b.time) ?? 0, color: OURS })), [k.bars, oursByBar]);
  const series: ExSeries[] = useMemo(() => {
    const base = symbol.replace(/USDT$/, "");
    const out: ExSeries[] = [
      line
        ? { key: "k", kind: "line", label: symbol, data: closePoints(k.bars), color: C.ink, toggle: false, format: price }
        : { key: "k", kind: "candles", label: symbol, data: k.bars, toggle: false },
      // the market's volume, not ours: never masked
      { key: "vol", kind: "histogram", label: "Vol(USDT)", data: volumePoints(k.bars, true), pane: 1, format: (v) => compact(v), lastValue: false },
      // ours on its own scale in the same pane (a sliver next to the market's otherwise); the legend has the figure
      {
        key: "ours",
        kind: "histogram",
        label: "Ours(USDT)",
        data: stable.get("ours" + kIv, oursPts, sameValue),
        pane: 1,
        scale: "ours",
        margins: { top: 0.35, bottom: 0 },
        format: maskFormat(hide, (v) => compact(v)),
        lastValue: false,
      },
    ];
    if (position) {
      out.push({
        key: "inv",
        kind: "line",
        label: `Inventory(${base})`,
        pane: 2,
        color: INV_LINE,
        width: 1,
        hiddenByDefault: true,
        format: maskFormat(hide, (v) => qty(v, true)),
        data: stable.get("inv" + kIv, position.inv, sameValue),
      });
      out.push({
        key: "ppnl",
        kind: "baseline",
        label: "Position P&L",
        pane: 3,
        hiddenByDefault: true,
        format: maskFormat(hide, pnl),
        data: stable.get("ppnl" + kIv, position.pnl, sameValue),
      });
    }
    return out;
  }, [symbol, k.bars, line, oursPts, kIv, position, hide, stable]);
  const bid0 = bids[0]?.price;
  const ask0 = asks[0]?.price;
  // fair, our quotes and the average cost are today's: shown at the latest bar only (a past bar has none)
  const lastT = k.bars[k.bars.length - 1]?.time;
  const legend = useMemo<ExLegendItem[]>(() => {
    const now = (v: number | null | undefined) => (t: number) => (t === lastT ? price(v) : "--");
    return [
      ...(fair != null ? [{ key: "fair", label: "Fair", color: FAIR, value: now(fair) }] : []),
      ...(bid0 != null || ask0 != null
        ? [
            { key: "quotes", label: "Our bid", color: C.up, value: now(bid0) },
            { key: "quotes", label: "Our ask", color: C.down, value: now(ask0) },
          ]
        : []),
      ...(avg != null ? [{ key: "avg", label: "Avg cost", color: C.ink2, value: now(avg) }] : []),
      { key: "fills", label: "Fills", value: (t: number) => fillsText(byBar.get(t)) },
    ];
  }, [fair, bid0, ask0, avg, byBar, lastT]);

  return (
    <div className="dk-chart-col">
      <ExChart
        id="desk.inst"
        className="dk-chart"
        fill
        title={symbol}
        series={series}
        paneStretch={[1, 0.2, 0.2, 0.22]}
        intervals={IVS}
        moreIntervals={MORE}
        interval={iv}
        onInterval={setIv}
        loading={k.loading}
        emptyText={k.error ?? "No bars"}
        initialBars={110}
        resetKey={key}
        fullscreen
        markers={markers}
        priceLines={lines}
        legendExtra={legend}
        chips={[
          { key: "fills", label: "Fills", color: C.up, ring: true, title: "Our fills: one ring per bar and side at our average price" },
          { key: "quotes", label: "Quotes", color: C.down, title: "Our open orders as lines; the best on each side has its price on the axis" },
          { key: "fair", label: "Fair", color: FAIR, stroke: "dotted" },
          { key: "avg", label: "Avg cost", color: C.muted, stroke: "large" },
          "|",
          { key: "vol", label: "Vol", title: "The market's volume" },
          { key: "ours", label: "Ours", color: OURS, bar: true, title: "Our filled notional per bar, on its own scale" },
          ...(position
            ? [
                { key: "inv", label: "Inventory", color: INV_LINE, title: "Our inventory at each bar's close, from today's and our fills" },
                { key: "ppnl", label: "Position P&L", color: POS_PNL, title: "From the left edge: our fills and the inventory marked at each close, fees left out" },
              ]
            : []),
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
  const m = (s: string) => maskNode(hide, s);
  const items: [string, ReactNode, string?][] = row
    ? [
        ["Venue", inst.venue === "usdm" ? "USD-M perpetual" : "Spot"],
        ["Reference", row.reference != null ? refLabel(row.reference) : "--"],
        ["Mid", price(row.mid)],
        ["Fair", price(row.fair)],
        ["Reference mid", price(row.ref_mid)],
        ["Basis", bps(row.basis_bps) + " bps", "Mid / reference mid − 1"],
        ["Best bid", price(row.bid)],
        ["Best ask", price(row.ask)],
        ["Inventory", m(qty(row.inv_qty, true))],
        ["Realized", m(pnl(row.realized_pnl)), "Sells matched FIFO to today's buys, minus fees"],
        ["Floating", m(pnl(row.float_pnl)), "The inventory left, at mid, against its cost"],
        ["Unrealized", m(pnl(row.upnl))],
        ["Buys / sells", `${int(row.buys_day)} / ${int(row.sells_day)}`],
        ["Markout 10 s", bps(row.mk10_bps) + " bps", "Volume-weighted over today's fills, net of the reference move"],
        ["Markout 60 s", bps(row.mk60_bps) + " bps"],
        ["Markout 300 s", bps(row.mk300_bps) + " bps"],
        ["Our bids / asks", `${row.open_bids} / ${row.open_asks}`],
        ["Bid dist", bps(row.bid_dist_bps, false) + " bps", "Best own bid below fair"],
        ["Ask dist", bps(row.ask_dist_bps, false) + " bps", "Best own ask above fair"],
        ...(funding
          ? ([
              ["Funding rate", funding.rate == null ? "--" : num(funding.rate * 100, 4, true) + "%"],
              ["Position", m(compact(funding.position))],
            ] as [string, ReactNode][])
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
