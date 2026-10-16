// The instrument page's chart: Binance's klines for the instrument (5m by default), our fills as one small
// hollow ring per bar and side at our VWAP, our best bid and ask, the fair and the average cost as price lines, the
// market's volume in its own pane with ours in the legend. Long-press reads a bar; ⤢ opens #/chart/m-inst.
import { useMemo } from "react";
import { compact, price } from "../../../format";
import { useStore } from "../../../store";
import { useInstFills } from "../../desk/instFills";
import {
  ExChart,
  closePoints,
  fillMarkers,
  fillsByBar,
  fillsShort,
  fillsText,
  useExPref,
  useKlines,
  volumePoints,
  type ExLegendItem,
  type ExPriceLine,
  type ExSeries,
  type KInterval,
} from "../../../components/ex";
import { C, rgba } from "../../../components/ex/palette";
import { useLive } from "../../../components/mobile";
import type { Venue } from "../../../protocol";
import { maskText } from "../../../mask";

const IVS = [
  { value: "line", label: "Line" },
  { value: "1m", label: "1m" },
  { value: "5m", label: "5m" },
  { value: "15m", label: "15m" },
  { value: "1h", label: "1H" },
];
const MORE = [
  { value: "30m", label: "30m" },
  { value: "4h", label: "4H" },
  { value: "1d", label: "1D" },
  { value: "1w", label: "1W" },
];
const ALL = [...IVS, ...MORE].map((i) => i.value);
const FAIR = C.accent;

export function InstChart({ symbol, venue }: { symbol: string; venue: Venue }) {
  const [iv, setIv] = useExPref<string>("m-inst", "interval", "5m", ALL);
  const kIv = (iv === "line" ? "1m" : iv) as KInterval;
  const kl = useKlines(symbol, venue, kIv);
  // the store's side of it, four times a second
  const row = useLive((s) => s.snap?.symbols.find((r) => r.symbol === symbol && r.venue === venue), 250, false, symbol + venue);
  const orders = useLive((s) => s.snap?.orders, 250);
  const hide = useStore((s) => s.hideAmounts);

  // our fills on this venue over the loaded bars (instFills.ts: the history, its tail, the live tape after)
  const first = kl.bars[0]?.time ?? null;
  const hk = `${venue}:${symbol}`;
  const fills = useInstFills(symbol, venue, first).fills;
  const byBar = useMemo(() => fillsByBar(fills, kIv), [fills, kIv]);
  const markers = useMemo(() => fillMarkers(byBar, "k"), [byBar]);

  const ours = (orders ?? []).filter((o) => o.symbol === symbol && o.venue === venue);
  const bid = ours.filter((o) => o.side === "buy").sort((a, b) => b.price - a.price)[0];
  const ask = ours.filter((o) => o.side === "sell").sort((a, b) => a.price - b.price)[0];
  const fair = row?.fair ?? null;
  const avg = row && row.inv_qty !== 0 ? row.avg_cost : null;
  const avgWord = venue === "usdm" ? "Entry" : "Avg cost";

  const line = iv === "line";
  const series: ExSeries[] = [
    line
      ? { key: "k", kind: "line", label: symbol, data: closePoints(kl.bars), color: C.ink, toggle: false, format: price }
      : { key: "k", kind: "candles", label: symbol, data: kl.bars, toggle: false, format: price },
    { key: "vol", kind: "histogram", label: "Vol(USDT)", data: volumePoints(kl.bars, true), pane: 1, format: (v) => compact(v), lastValue: false },
  ];
  const bidP = bid?.price;
  const askP = ask?.price;
  // labelled on the axis only: a title inside the plot covers the last candles (the legend names them). Ours
  // have dark tags with coloured text; the one solid tag is the market's last price. Rebuilt only when a price
  // moves (the page re-renders four times a second)
  const lines = useMemo<ExPriceLine[]>(() => {
    const out: ExPriceLine[] = [];
    if (bidP != null) out.push({ series: "k", key: "quotes", price: bidP, color: rgba(C.up, 0.75), labelColor: C.raised, labelTextColor: C.up });
    if (askP != null) out.push({ series: "k", key: "quotes", price: askP, color: rgba(C.down, 0.75), labelColor: C.raised, labelTextColor: C.down });
    if (fair != null) out.push({ series: "k", key: "fair", price: fair, color: rgba(FAIR, 0.8), style: "dotted", axisLabel: false });
    if (avg != null) out.push({ series: "k", key: "avg", price: avg, color: C.muted, style: "large", labelColor: C.raised, labelTextColor: C.ink });
    return out;
  }, [bidP, askP, fair, avg]);

  // fair, our quotes and the average cost are today's: at the latest bar only (a past bar has none)
  const lastT = kl.bars[kl.bars.length - 1]?.time;
  const legend = useMemo<ExLegendItem[]>(() => {
    const now = (v: number | null | undefined) => (t: number) => (t === lastT && v != null ? price(v) : "--");
    // our traded notional in a bar, for the volume pane's legend
    const oursIn = (t: number) => {
      const f = byBar.get(t);
      if (!f) return "0";
      return maskText(hide, compact((f.buyVwap ?? 0) * f.buyQty + (f.sellVwap ?? 0) * f.sellQty));
    };
    return [
      ...(fair != null ? [{ key: "fair", label: "Fair", color: FAIR, value: now(fair), line: 2 }] : []),
      ...(bidP != null || askP != null
        ? [
            { key: "quotes", label: "Our bid", color: C.up, value: now(bidP), line: 2 },
            { key: "quotes", label: "Our ask", color: C.down, value: now(askP), line: 2 },
          ]
        : []),
      ...(avg != null ? [{ key: "avg", label: avgWord, color: C.muted, value: now(avg), line: 3 }] : []),
      { key: "fills", label: "Fills", value: (t: number) => fillsText(byBar.get(t)), box: (t: number) => fillsShort(byBar.get(t)), line: 3 },
      { label: "Ours", pane: 1, color: C.ink2, value: oursIn },
    ];
  }, [fair, bidP, askP, avg, avgWord, byBar, hide, lastT]);

  return (
    <ExChart
      id="m-inst"
      title={symbol + (venue === "usdm" ? " Perp" : "")}
      className="in-chart"
      series={series}
      paneStretch={[1, 0.24]}
      intervals={IVS}
      moreIntervals={MORE}
      interval={iv}
      onInterval={setIv}
      loading={kl.loading}
      emptyText={kl.error ?? undefined}
      height={400}
      // bars at least 5 px apart at 393 px, so the fill markers show (they hide on denser bars)
      initialBars={56}
      resetKey={hk}
      fullscreen
      touch
      markers={markers}
      priceLines={lines}
      legendExtra={legend}
      chips={[
        { key: "fills", label: "Fills", color: C.up, ring: true, title: "Our fills: one ring per bar and side at our average price" },
        { key: "quotes", label: "Quotes", color: C.down, title: "Our best bid and ask as lines" },
        { key: "fair", label: "Fair", color: FAIR, stroke: "dotted" },
        ...(avg != null ? [{ key: "avg", label: avgWord, color: C.muted, stroke: "large" as const }] : []),
        "|",
        { key: "vol", label: "Vol" },
      ]}
    />
  );
}
