// The instrument page's chart: Binance's klines for the instrument (5m by default), our fills as one small
// circle per bar and side at our VWAP, our best bid and ask, the fair and the average cost as price lines, the
// market's volume in its own pane with ours in the legend. Long-press reads a bar; ⤢ opens #/chart/m-inst.
import { useEffect, useMemo, useState } from "react";
import { getJSON, type HistFill } from "../../../api";
import { compact, price } from "../../../format";
import { useStore } from "../../../store";
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
  type ExPriceLine,
  type ExSeries,
  type KInterval,
} from "../../../components/ex";
import { C, S1, rgba } from "../../../components/ex/palette";
import { useLive } from "../../../components/mobile";
import type { Fill, Venue } from "../../../protocol";

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
const FAIR = S1;

export function InstChart({ symbol, venue }: { symbol: string; venue: Venue }) {
  const [iv, setIv] = useExPref<string>("m-inst", "interval", "5m", ALL);
  const kIv = (iv === "line" ? "1m" : iv) as KInterval;
  const kl = useKlines(symbol, venue, kIv);
  // the store's side of it, four times a second
  const row = useLive((s) => s.snap?.symbols.find((r) => r.symbol === symbol && r.venue === venue), 250, false, symbol + venue);
  const orders = useLive((s) => s.snap?.orders, 250);
  const liveFills = useLive((s) => s.snap?.fills, 500);
  const hide = useStore((s) => s.hideAmounts);

  // our fills over the loaded bars: /api/fills, then the snapshot's after it
  const [hist, setHist] = useState<{ k: string; to: number; fills: HistFill[] } | null>(null);
  const first = kl.bars[0]?.time;
  const hk = `${venue}:${symbol}`;
  useEffect(() => {
    if (first == null) return;
    const to = Date.now();
    let on = true;
    getJSON<HistFill[]>("/api/fills", { symbol, venue, from: first, to })
      .then((f) => on && setHist({ k: hk, to, fills: f }))
      .catch(() => {});
    return () => void (on = false);
  }, [symbol, venue, first, hk]);
  const fills = useMemo(() => {
    const h = hist && hist.k === hk ? hist : null;
    const extra = (liveFills ?? []).filter((f: Fill) => f.symbol === symbol && f.venue === venue && (!h || f.ts > h.to));
    return [...(h?.fills ?? []), ...extra];
  }, [hist, hk, liveFills, symbol, venue]);
  const byBar = useMemo(() => fillsByBar(fills, kIv), [fills, kIv]);

  const ours = (orders ?? []).filter((o) => o.symbol === symbol && o.venue === venue);
  const bid = ours.filter((o) => o.side === "buy").sort((a, b) => b.price - a.price)[0];
  const ask = ours.filter((o) => o.side === "sell").sort((a, b) => a.price - b.price)[0];
  const fair = row?.fair ?? null;
  const avg = row && row.inv_qty !== 0 ? row.avg_cost : null;

  const line = iv === "line";
  const series: ExSeries[] = [
    line
      ? { key: "k", kind: "line", label: symbol, data: closePoints(kl.bars), color: C.ink, toggle: false, format: price }
      : { key: "k", kind: "candles", label: symbol, data: kl.bars, toggle: false, format: price },
    { key: "vol", kind: "histogram", label: "Vol(USDT)", data: volumePoints(kl.bars, true), pane: 1, format: (v) => compact(v), lastValue: false },
  ];
  const tag = { labelTextColor: C.ground };
  const lines: ExPriceLine[] = [];
  if (bid) lines.push({ series: "k", key: "quotes", price: bid.price, color: rgba(C.up, 0.75), title: "Bid", labelColor: C.up, ...tag });
  if (ask) lines.push({ series: "k", key: "quotes", price: ask.price, color: rgba(C.down, 0.75), title: "Ask", labelColor: C.down, ...tag });
  if (fair != null) lines.push({ series: "k", key: "fair", price: fair, color: rgba(FAIR, 0.8), style: "dotted", axisLabel: false });
  if (avg != null) lines.push({ series: "k", key: "avg", price: avg, color: C.muted, title: "Avg cost", style: "large", labelColor: C.raised, labelTextColor: C.ink });

  // our traded notional in a bar, for the volume pane's legend
  const oursIn = (t: number) => {
    const f = byBar.get(t);
    if (!f) return "0";
    return hide ? "•••" : compact((f.buyVwap ?? 0) * f.buyQty + (f.sellVwap ?? 0) * f.sellQty);
  };

  return (
    <ExChart
      id="m-inst"
      title={symbol + (venue === "usdm" ? " perp" : "")}
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
      initialBars={72}
      resetKey={hk}
      fullscreen
      touch
      markers={fillMarkers(byBar, "k")}
      priceLines={lines}
      legendExtra={[
        ...(fair != null ? [{ key: "fair", label: "Fair", color: FAIR, value: () => price(fair), line: 2 }] : []),
        ...(bid || ask
          ? [
              { key: "quotes", label: "Bid", color: C.up, value: () => (bid ? price(bid.price) : "--"), line: 2 },
              { key: "quotes", label: "Ask", color: C.down, value: () => (ask ? price(ask.price) : "--"), line: 2 },
            ]
          : []),
        ...(avg != null ? [{ key: "avg", label: "Avg cost", color: C.muted, value: () => price(avg), line: 3 }] : []),
        { key: "fills", label: "Fills", value: (t: number) => fillsText(byBar.get(t)), box: (t: number) => fillsShort(byBar.get(t)), line: 3 },
        { label: "Ours", pane: 1, color: C.ink2, value: oursIn },
      ]}
      chips={[
        { key: "fills", label: "Fills", color: C.up },
        { key: "quotes", label: "Quotes", color: C.down },
        { key: "fair", label: "Fair", color: FAIR },
        ...(avg != null ? [{ key: "avg", label: "Avg cost", color: C.muted }] : []),
        "|",
        { key: "vol", label: "Vol" },
      ]}
    />
  );
}
