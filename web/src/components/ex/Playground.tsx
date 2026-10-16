// Dev-only playground for the ex/ components: `VITE_MOCK=1 npx vite` then open /ex-playground.html (desktop
// and phone widths). Not part of the app or the build (vite builds index.html only).
import { useEffect, useMemo, useState } from "react";
import { useStore } from "../../store";
import { useIsMobile } from "../../hooks";
import { getJSON, type HistFill } from "../../api";
import { compact, num, pnl, price, usd } from "../../format";
import type { SeriesPoint, Fill } from "../../protocol";
import {
  ChipRow,
  ExChart,
  StatusFooter,
  Tabs,
  TextToggle,
  TickerStrip,
  closePoints,
  fillMarkers,
  fillsByBar,
  fillsShort,
  fillsText,
  signColor,
  useExHidden,
  useExPref,
  useKlines,
  volumePoints,
  type ExSeries,
  type KInterval,
} from "./index";
import { C, FUT_COLOR, INV_COLOR, S2, rgba } from "./palette";

const INST_IVS = [
  { value: "line", label: "Line" },
  { value: "1m", label: "1m" },
  { value: "5m", label: "5m" },
  { value: "15m", label: "15m" },
  { value: "30m", label: "30m" },
  { value: "1h", label: "1H" },
  { value: "4h", label: "4H" },
  { value: "1d", label: "1D" },
  { value: "1w", label: "1W" },
];
const PHONE_IVS = ["line", "1m", "5m", "15m", "1h"];
const SYMS = ["ETHUSDT", "BTCUSDT", "SOLUSDT"];

export function Playground() {
  const phone = useIsMobile();
  const ready = useStore((s) => s.snap != null);
  const [tab, setTab] = useState<"inst" | "pnl">("inst");
  if (!ready) return <div className="waiting">Waiting for the first snapshot</div>;
  return (
    <div style={{ height: "100dvh", display: "flex", flexDirection: "column", background: "var(--ground)" }}>
      <div style={{ flex: 1, minHeight: 0, overflowY: "auto" }}>
        <InstrumentBlock phone={phone} />
        <div style={{ height: phone ? 8 : 1, background: phone ? "var(--ground)" : "var(--rule)" }} />
        <div style={{ padding: "0 12px", background: "var(--panel)", borderBottom: "1px solid var(--rule)" }}>
          <Tabs
            items={[
              { value: "inst", label: "P&L" },
              { value: "pnl", label: "Fills", count: useStore.getState().snap?.summary.fills_day ?? null },
            ]}
            value={tab}
            onChange={setTab}
          />
        </div>
        <DeskPnlBlock phone={phone} />
        <ControlsDemo />
      </div>
      {!phone && <StatusFooter />}
    </div>
  );
}

// ---------------- instrument: klines + fills + quotes ----------------

function InstrumentBlock({ phone }: { phone: boolean }) {
  const [sym, setSym] = useExPref("pg-inst", "symbol", "ETHUSDT", SYMS);
  const [iv, setIv] = useExPref<string>("pg-inst", "interval", "5m", INST_IVS.map((i) => i.value));
  const kIv = (iv === "line" ? "1m" : iv) as KInterval;
  const kl = useKlines(sym, "spot", kIv);
  const row = useStore((s) => s.snap?.symbols.find((r) => r.symbol === sym && r.venue === "spot"));
  const orders = useStore((s) => s.snap?.orders);
  const liveFills = useStore((s) => s.snap?.fills);

  // fills over the loaded range: /api/fills, then the snapshot's after it
  const [hist, setHist] = useState<{ sym: string; to: number; fills: HistFill[] } | null>(null);
  const first = kl.bars[0]?.time;
  useEffect(() => {
    if (first == null) return;
    const to = Date.now();
    let live = true;
    getJSON<HistFill[]>("/api/fills", { symbol: sym, venue: "spot", from: first, to })
      .then((f) => live && setHist({ sym, to, fills: f }))
      .catch(() => {});
    return () => void (live = false);
  }, [sym, first]);
  const fills = useMemo(() => {
    const h = hist && hist.sym === sym ? hist : null;
    const extra = (liveFills ?? []).filter((f: Fill) => f.symbol === sym && f.venue === "spot" && (!h || f.ts > h.to));
    return [...(h?.fills ?? []), ...extra];
  }, [hist, sym, liveFills]);
  const byBar = useMemo(() => fillsByBar(fills, kIv), [fills, kIv]);

  const ours = (orders ?? []).filter((o) => o.symbol === sym && o.venue === "spot");
  const bid = ours.filter((o) => o.side === "buy").sort((a, b) => b.price - a.price)[0];
  const ask = ours.filter((o) => o.side === "sell").sort((a, b) => a.price - b.price)[0];

  const isLine = iv === "line";
  const series: ExSeries[] = [
    isLine
      ? { key: "k", kind: "line", label: sym, data: closePoints(kl.bars), color: C.ink, toggle: false, format: price }
      : { key: "k", kind: "candles", label: sym, data: kl.bars, toggle: false, format: price },
    { key: "vol", kind: "histogram", label: "Vol(USDT)", data: volumePoints(kl.bars, true), pane: 1, format: (v) => compact(v), lastValue: false },
  ];
  const tags = { labelTextColor: C.ground };
  return (
    <section style={{ background: "var(--panel)" }}>
      <TickerStrip
        className="pg-ticker"
        style={{ padding: phone ? "8px 12px" : "6px 12px" }}
        size={phone ? "md" : "sm"}
        lead={{ title: sym + " Spot", value: price(row?.mid), tone: signColor(row?.trading_pnl) === C.ink ? undefined : row!.trading_pnl >= 0 ? "up" : "down", sub: `Fair ${price(row?.fair)}` }}
        items={[
          { label: "Inventory", value: num(row?.inv_qty, 4) },
          { label: "Value", value: usd(row?.inv_value) },
          { label: "Avg cost", value: price(row?.avg_cost) },
          "|",
          { label: "Day PnL", value: pnl(row?.trading_pnl), tone: (row?.trading_pnl ?? 0) > 0 ? "up" : (row?.trading_pnl ?? 0) < 0 ? "down" : undefined },
          { label: "Spread", value: row?.spread_bps == null ? "--" : num(row.spread_bps, 1) + " bps" },
          { label: "Volume", value: compact(row?.volume_day), title: "Notional filled today" },
        ]}
      />
      <ExChart
        id="pg-inst"
        title={sym}
        chartRef={(c) => void ((window as unknown as { pgChart: unknown }).pgChart = c)}
        series={series}
        paneStretch={[1, phone ? 0.24 : 0.22]}
        intervals={phone ? INST_IVS.filter((i) => PHONE_IVS.includes(i.value)) : INST_IVS}
        moreIntervals={phone ? INST_IVS.filter((i) => !PHONE_IVS.includes(i.value)) : undefined}
        interval={iv}
        onInterval={setIv}
        toolbarLeft={<TextToggle options={SYMS.map((s) => ({ value: s, label: s.replace("USDT", "") }))} value={sym} onChange={setSym} label="Symbol" />}
        loading={kl.loading}
        emptyText={kl.error ?? undefined}
        height={phone ? 380 : 440}
        initialBars={phone ? 70 : 140}
        resetKey={sym}
        fullscreen
        markers={fillMarkers(byBar, "k")}
        priceLines={[
          ...(bid ? [{ series: "k", key: "quotes", price: bid.price, color: rgba(C.up, 0.8), title: "Bid " + bid.account, labelColor: C.up, ...tags }] : []),
          ...(ask ? [{ series: "k", key: "quotes", price: ask.price, color: rgba(C.down, 0.8), title: "Ask " + ask.account, labelColor: C.down, ...tags }] : []),
          ...(row?.avg_cost ? [{ series: "k", key: "avg", price: row.avg_cost, color: C.muted, title: "Avg cost", style: "large" as const, labelColor: C.raised, labelTextColor: C.ink }] : []),
        ]}
        legendExtra={[
          ...(bid || ask
            ? [
                { key: "quotes", label: "Our bid", color: C.up, value: () => price(bid?.price) },
                { key: "quotes", label: "Our ask", color: C.down, value: () => price(ask?.price) },
              ]
            : []),
          ...(row?.avg_cost ? [{ key: "avg", label: "Avg cost", color: C.muted, value: () => price(row.avg_cost) }] : []),
          { key: "fills", label: "Fills", value: (t: number) => fillsText(byBar.get(t)), box: (t: number) => fillsShort(byBar.get(t)) },
        ]}
        chips={[
          { key: "fills", label: "Fills", color: C.up },
          { key: "quotes", label: "Quotes", color: C.down },
          { key: "avg", label: "Avg cost", color: C.muted },
          "|",
          { key: "vol", label: "Vol" },
        ]}
      />
    </section>
  );
}

// ---------------- desk P&L today from the 5 s series ----------------

const PNL_IVS = [
  { value: "1m", label: "1m" },
  { value: "5m", label: "5m" },
  { value: "15m", label: "15m" },
  { value: "1h", label: "1H" },
];
const STEP: Record<string, number> = { "1m": 60_000, "5m": 300_000, "15m": 900_000, "1h": 3_600_000 };

function bucket(series: SeriesPoint[], step: number) {
  const out: { time: number; o: number; h: number; l: number; c: number; tr: number | null; inv: number; fut: number }[] = [];
  for (const p of series) {
    const t = Math.floor(p.t / step) * step;
    const last = out[out.length - 1];
    if (last && last.time === t) {
      last.h = Math.max(last.h, p.pnl_day);
      last.l = Math.min(last.l, p.pnl_day);
      last.c = p.pnl_day;
      last.tr = p.trading;
      last.inv = p.inventory;
      last.fut = p.futures_notional;
    } else out.push({ time: t, o: last?.c ?? p.pnl_day, h: p.pnl_day, l: p.pnl_day, c: p.pnl_day, tr: p.trading, inv: p.inventory, fut: p.futures_notional });
  }
  return out;
}

function DeskPnlBlock({ phone }: { phone: boolean }) {
  const [iv, setIv] = useExPref("pg-pnl", "interval", "1m", PNL_IVS.map((i) => i.value));
  const [style, setStyle] = useExPref("pg-pnl", "style", "area", ["area", "candles"]);
  const raw = useStore((s) => s.snap?.series);
  const fills = useStore((s) => s.snap?.fills);
  const step = STEP[iv]!;
  const bars = useMemo(() => bucket(raw ?? [], step), [raw, step]);
  const vol = useMemo(() => {
    const m = new Map<number, number>();
    for (const f of fills ?? []) {
      const t = Math.floor(f.ts / step) * step;
      m.set(t, (m.get(t) ?? 0) + f.notional);
    }
    return bars.map((b) => ({ time: b.time, value: m.get(b.time) ?? 0 }));
  }, [bars, fills, step]);
  const series: ExSeries[] = [
    style === "candles"
      ? { key: "day", kind: "candles", label: "Day PnL", data: bars.map((b) => ({ time: b.time, open: b.o, high: b.h, low: b.l, close: b.c })), format: pnl, toggle: false }
      : { key: "day", kind: "baseline", label: "Day PnL", data: bars.map((b) => ({ time: b.time, value: b.c })), format: pnl, toggle: false },
    { key: "trading", kind: "line", label: "Π", color: S2, data: bars.map((b) => ({ time: b.time, value: b.tr })), format: pnl, lastValue: false },
    { key: "vol", kind: "histogram", label: "Vol(USDT)", color: rgba(C.ink2, 0.4), pane: 1, data: vol, format: (v) => compact(v) },
    { key: "inv", kind: "line", label: "Inventory", color: INV_COLOR, pane: 2, data: bars.map((b) => ({ time: b.time, value: b.inv })), format: (v) => compact(v) },
    { key: "fut", kind: "line", label: "Futures", color: FUT_COLOR, pane: 2, data: bars.map((b) => ({ time: b.time, value: b.fut })), format: (v) => compact(v), lastValue: false },
  ];
  return (
    <ExChart
      id="pg-pnl"
      title="Desk P&L"
      series={series}
      paneStretch={[1, 0.22, 0.3]}
      intervals={PNL_IVS}
      interval={iv}
      onInterval={setIv}
      modes={[
        {
          label: "Style",
          value: style,
          onChange: setStyle,
          options: [
            { value: "area", label: "Area" },
            { value: "candles", label: "Candles" },
          ],
        },
      ]}
      height={phone ? 300 : 380}
      fullscreen
      chips
      boxRows={(t) => {
        const b = bars.find((x) => x.time === t);
        if (!b) return [];
        return [
          ["Day PnL", pnl(b.c), signColor(b.c)],
          ["Π", pnl(b.tr), S2],
          ["Inventory", compact(b.inv), INV_COLOR],
          ["Futures", compact(b.fut), FUT_COLOR],
        ];
      }}
    />
  );
}

// ---------------- controls ----------------

function ControlsDemo() {
  const [iv, setIv] = useState("15m");
  const [t, setT] = useState<"a" | "b" | "c">("a");
  const h = useExHidden("pg-chips", ["two"]);
  return (
    <section style={{ padding: 12, display: "flex", flexDirection: "column", gap: 12, background: "var(--panel)", borderTop: "1px solid var(--rule)" }}>
      <Tabs
        items={[
          { value: "a", label: "Inventory", count: 17 },
          { value: "b", label: "Open orders", count: 84 },
          { value: "c", label: "Fills", count: compact(4937, 1) },
        ]}
        value={t}
        onChange={setT}
      />
      <TextToggle
        options={[{ value: "line", label: "Line" }, { value: "1m", label: "1m" }, { value: "15m", label: "15m" }, { value: "|" }, { value: "1h", label: "1H" }]}
        value={iv}
        onChange={setIv}
      />
      <ChipRow items={[{ key: "one", label: "MM", color: "#199e70" }, { key: "two", label: "Inv", color: "#a47ef0" }, "|", { key: "three", label: "Vol" }]} isOn={h.isOn} onToggle={h.toggle} />
      <div className="fig" style={{ color: "var(--muted)" }}>
        compact: {compact(950.123)} · {compact(9501)} · {compact(267_203_000)} · {compact(-1.23e9, 2, true)} · {compact(null)}
      </div>
    </section>
  );
}
