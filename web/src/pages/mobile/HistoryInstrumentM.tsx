import { useMemo } from "react";
import { create } from "zustand";
import { useStore, serverNow } from "../../store";
import { getJSON, type History as Hist, type HistDay, type HistFill, type Kline } from "../../api";
import { InstrumentChart } from "../../components/HistoryChart";
import { hm, int, price } from "../../format";
import { Chips, KV, ListRow, Money, Section } from "../../components/mobile";
import type { Venue } from "../../protocol";
import { ChartState, DAY, useLoad } from "./shared";
import { dayTitle } from "./index";
import "./history.css";

const STEPS = ["1m", "5m", "15m", "1h", "4h", "1d"] as const;
type Interval = (typeof STEPS)[number];
const SEC: Record<Interval, number> = { "1m": 60, "5m": 300, "15m": 900, "1h": 3600, "4h": 14_400, "1d": 86_400 };
const BARS = 1500; // per load: a phone does not need the desktop's 5000
const REFRESH = 30_000;

// stable empties, so the memos below don't rerun (and the chart doesn't reset) on every render while loading
const NO_KLINES: Kline[] = [];
const NO_FILLS: HistFill[] = [];
const NO_DAYS: HistDay[] = [];

const useIval = create<{ ival: Interval; set: (v: Interval) => void }>((set) => ({ ival: "5m", set: (ival) => set({ ival }) }));

/** One instrument's market candles with our fills on them, reached from the instrument's page. */
export function HistoryInstrumentM({ symbol, venue }: { symbol: string; venue: Venue }) {
  const { ival, set } = useIval();
  const tz = useStore((s) => s.tz);
  const dayStart = useStore((s) => s.snap?.summary.day_start ?? 0);
  const step = SEC[ival];
  // BARS back from now, moved forward onto a day start
  const from = dayStart ? dayStart - Math.floor((BARS * step * 1000) / DAY) * DAY : 0;
  const key = dayStart ? `${symbol}|${venue}|${ival}|${from}` : null;
  const load = useLoad<{ klines: Kline[]; fills: HistFill[]; days: HistDay[] }>(
    key,
    async (signal) => {
      const to = serverNow();
      const [klines, fills, h] = await Promise.all([
        getJSON<Kline[]>("/api/klines", { symbol, venue, interval: ival, from, to }, signal),
        getJSON<HistFill[]>("/api/fills", { symbol, from, to }, signal),
        getJSON<Hist>("/api/history", { from: to - 60_000, to, step: 60 }, signal),
      ]);
      return { klines, fills: fills.filter((f) => f.venue === venue), days: h.days };
    },
    REFRESH,
  );
  const data = load.key === key ? load.data : null;
  const klines = data?.klines ?? NO_KLINES;
  const fills = data?.fills ?? NO_FILLS;

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
  const since = klines[0]?.[0];

  return (
    <>
      <Section card={false}>
        <div className="m-hist-ivals">
          <Chips value={ival} onChange={set} data={STEPS.map((s) => ({ value: s, label: s }))} label="Interval" />
        </div>
        <div className="m-hist-chart">
          <InstrumentChart
            phone
            height={260}
            klines={klines}
            fills={fills}
            days={data?.days ?? NO_DAYS}
            step={step}
            tz={tz}
            fitKey={load.key}
          />
          <ChartState load={load} empty={data != null && klines.length === 0} />
        </div>
      </Section>

      {data && (
        <Section
          title="Our fills"
          info={`Fills on ${venue === "usdm" ? "USD-M" : "spot"} in the loaded window, all accounts; avg is the quantity-weighted price.`}
          right={since != null ? `since ${dayTitle(ymd(since, tz === "utc"))} ${hm(since, tz)}` : undefined}
        >
          <KV
            items={[
              { label: "Buys", value: sum.bn ? `${int(sum.bn)} @ ${price(sum.bv / sum.bq)}` : "0" },
              { label: "Sells", value: sum.sn ? `${int(sum.sn)} @ ${price(sum.sv / sum.sq)}` : "0" },
              { label: "Bought, USDT", value: <Money v={sum.bv} kind="short" /> },
              { label: "Sold, USDT", value: <Money v={sum.sv} kind="short" /> },
            ]}
          />
          <ListRow
            dense
            title="Today"
            subtitle="quotes, inventory and markouts"
            to={{ page: "desk", detail: { kind: "instrument", symbol, venue } }}
          />
        </Section>
      )}
    </>
  );
}

/** YYYY-MM-DD of a moment, in UTC or local time. */
function ymd(t: number, utc: boolean): string {
  const d = new Date(t);
  if (utc) return d.toISOString().slice(0, 10);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}
