import { useMemo } from "react";
import { useStore, serverNow } from "../../store";
import { getJSON, type HistFill } from "../../api";
import { compact, int, price } from "../../format";
import { C } from "../../theme";
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
  type ExSeries,
  type KInterval,
} from "../../components/ex";
import type { Venue } from "../../protocol";
import { useLoad } from "./shared";
import { Row, Sec, Stats, useAmt } from "./rest/ui";
import "./history.css";

const IVS = [
  { value: "line", label: "Line" },
  { value: "5m", label: "5m" },
  { value: "15m", label: "15m" },
  { value: "1h", label: "1H" },
  { value: "4h", label: "4H" },
];
const MORE = [
  { value: "1m", label: "1m" },
  { value: "30m", label: "30m" },
  { value: "1d", label: "1D" },
  { value: "1w", label: "1W" },
];
const ALL = [...IVS, ...MORE].map((i) => i.value);
const BARS = 1000;
const NO_FILLS: HistFill[] = [];

/** One instrument's market candles over a longer span, with our fills on them (per bar and side, one circle
 *  at our VWAP), and what was bought and sold in that span. */
export function HistoryInstrumentM({ symbol, venue }: { symbol: string; venue: Venue }) {
  const [iv, setIv] = useExPref<string>("m-hinst", "interval", "1h", ALL);
  const kIv = (iv === "line" ? "15m" : iv) as KInterval;
  const k = useKlines(symbol, venue, kIv, { bars: BARS });
  const money = useAmt();
  const first = k.bars[0]?.time;
  const key = first != null ? `${symbol}|${venue}|${kIv}|${Math.floor(first / 3_600_000)}` : null;
  const load = useLoad<HistFill[]>(
    key,
    (signal) =>
      getJSON<HistFill[]>("/api/fills", { symbol, venue, from: first!, to: serverNow() }, signal).then((xs) => xs.filter((f) => f.venue === venue && f.t >= first!)),
    60_000,
  );
  const fills = load.key === key && load.data ? load.data : NO_FILLS;
  const byBar = useMemo(() => fillsByBar(fills, kIv), [fills, kIv]);
  const row = useStore((s) => s.snap?.symbols.find((r) => r.symbol === symbol && r.venue === venue));

  const series = useMemo<ExSeries[]>(
    () => [
      iv === "line"
        ? { key: "k", kind: "line", label: symbol, color: C.ink, data: closePoints(k.bars), toggle: false, format: price }
        : { key: "k", kind: "candles", label: symbol, data: k.bars, toggle: false, format: price },
      { key: "vol", kind: "histogram", label: "Vol(USDT)", pane: 1, data: volumePoints(k.bars, true), format: (v) => compact(v), lastValue: false },
    ],
    [iv, k.bars, symbol],
  );

  const sum = useMemo(() => {
    const s = { bn: 0, bq: 0, bv: 0, sn: 0, sq: 0, sv: 0 };
    for (const f of fills) {
      if (f.side === "buy") {
        s.bn++;
        s.bq += f.qty;
        s.bv += f.qty * f.price;
      } else {
        s.sn++;
        s.sq += f.qty;
        s.sv += f.qty * f.price;
      }
    }
    return s;
  }, [fills]);
  const ready = load.key === key && load.data != null;

  return (
    <>
      <div className="r-chart h-inst-chart">
        <ExChart
          id="m-hinst"
          title={symbol}
          series={series}
          paneStretch={[1, 0.22]}
          intervals={IVS}
          moreIntervals={MORE}
          interval={iv}
          onInterval={setIv}
          loading={k.loading}
          emptyText={k.error ?? undefined}
          height={380}
          initialBars={80}
          resetKey={symbol + venue}
          fullscreen
          markers={fillMarkers(byBar, "k")}
          priceLines={
            row?.avg_cost ? [{ series: "k", key: "avg", price: row.avg_cost, color: C.muted, title: "Avg cost", style: "large", labelColor: C.raised, labelTextColor: C.ink }] : undefined
          }
          legendExtra={[{ key: "fills", label: "Fills", value: (t) => fillsText(byBar.get(t)), box: (t) => fillsShort(byBar.get(t)) }]}
          chips={[{ key: "fills", label: "Fills", color: C.up }, ...(row?.avg_cost ? [{ key: "avg", label: "Avg cost", color: C.muted }] : []), "|", { key: "vol", label: "Vol" }]}
        />
      </div>

      <Sec title="Our fills" right={first != null ? `in the chart's ${int(k.bars.length)} bars` : undefined} info={`Fills on ${venue === "usdm" ? "USD-M" : "spot"} over the bars loaded, all accounts; @ is the quantity-weighted price.`}>
        <Stats
          cols={2}
          items={[
            { label: "Buys", value: !ready ? "--" : sum.bn ? `${int(sum.bn)} @ ${price(sum.bv / sum.bq)}` : "0", tone: sum.bn ? "up" : "" },
            { label: "Sells", value: !ready ? "--" : sum.sn ? `${int(sum.sn)} @ ${price(sum.sv / sum.sq)}` : "0", tone: sum.sn ? "down" : "" },
            { label: "Bought (USDT)", value: ready ? money(sum.bv, "k") : "--" },
            { label: "Sold (USDT)", value: ready ? money(sum.sv, "k") : "--" },
          ]}
        />
      </Sec>
      <Sec>
        <Row
          title="Today"
          sub="Quotes, fills, markouts and inventory"
          value={row ? <span className="r-fig">{int(row.fills_day)} fills</span> : undefined}
          to={{ page: "desk", detail: { kind: "instrument", symbol, venue } }}
        />
      </Sec>
    </>
  );
}
