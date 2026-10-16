// The Desk's ticker strip, as on an exchange's trade page: the name slot, the big value, then label-over-value
// pairs. With nothing picked it is the desk's (Day PnL and its parts, exposure, equity, volume, markout,
// fills); with an instrument picked, that instrument's (Binance's 24 h stats, then ours).
import { useRef, type ReactNode } from "react";
import { useStore, type Instrument } from "../store";
import { bps, compact, hm, int, num, pnl, price, qty, usd } from "../format";
import type { Exposure } from "../protocol";
import { TickerStrip, useTicker24h, type TickerItem } from "./ex";
import { maskNode, signTone, useHide } from "../mask";
import { useInstPnl } from "../selectors";

const betaNote = (x: Exposure) =>
  x.beta_source === "estimate" ? "β: desk estimate, may differ from the engine's" : "β: configured per market";

function exposureItem(x: Exposure, m: (s: string) => ReactNode, hide: boolean): TickerItem {
  const hasGap = x.gap != null && x.band != null;
  const over = hasGap && Math.abs(x.gap!) > x.band!;
  if (hasGap && x.paused)
    return {
      label: "Hedge closing",
      value: m(pnl(x.hedge_notional)),
      tone: over ? "warn" : undefined,
      title: `${x.paused}: the hedge is off and its target is 0; the value is the hedge symbols' futures notional still open, to be closed. USDT.`,
    };
  if (hasGap)
    return {
      label: "Exposure gap",
      value: (
        <>
          {m(pnl(x.gap))}
          <span className="dk-tk-of"> / ±{m(num(x.band, 0))}</span>
        </>
      ),
      tone: over ? "warn" : undefined,
      title:
        `Exposure gap: hedge target minus the futures notional of the hedge symbols (the trade that closes it; negative = sell more), where the target is −${num(x.ratio, 2)} × beta-weighted spot value (${betaNote(x)}). ` +
        `After the slash: the band, the allowed size of the gap. USDT.`,
    };
  return {
    label: "Net exposure",
    value: m(pnl(x.net)),
    title: `Net exposure: spot inventory value plus futures net notional, all accounts.${hide ? "" : ` Futures net notional ${pnl(x.futures_notional)}.`} USDT.`,
  };
}

/** The desk's strip. `name`: the name slot at the left (the picker / back control). */
export function DeskTicker({ name }: { name: ReactNode }) {
  // the parts it shows, not the whole snapshot: fills and series messages leave these untouched
  const sm = useStore((st) => st.snap?.summary);
  const exposure = useStore((st) => st.snap?.exposure);
  const tz = useStore((st) => st.tz);
  const hide = useHide();
  const m = (s: string) => maskNode(hide, s);
  const tone = (v: number | null | undefined) => (hide ? undefined : signTone(v) || undefined);
  const p = sm?.pnl;
  const hedge = exposure?.hedge_day?.hedge_pnl ?? null;
  const dayStart = sm ? `${hm(sm.day_start, tz)} ${tz === "utc" ? "UTC" : "local time"}` : "the day start";
  const items: (TickerItem | "|")[] = [
    { label: <span title="The change of Day PnL over the last hour">1h PnL</span>, value: m(pnl(sm?.pnl_1h)), tone: tone(sm?.pnl_1h) },
    "|",
    // tooltips on the plain words without the dotted underline (kept for jargon: Other, Exposure gap, Markout)
    {
      label: <span title={`Each fill against the mid 60 s after it, minus fees.${hide ? "" : ` Against the fair at the fill instead: ${pnl(p?.mm_spread)} USDT.`}`}>Market making</span>,
      value: m(pnl(p?.mm)),
      tone: tone(p?.mm),
    },
    { label: <span title="Trading PnL minus market making: what the inventory made after the first 60 s of each fill.">Inventory PnL</span>, value: m(pnl(p?.inventory)), tone: tone(p?.inventory) },
    { label: <span title="The futures legs since the day start: price at mark, minus fees, plus funding.">Hedge</span>, value: m(pnl(hedge)), tone: tone(hedge) },
    { label: <span title="Market-maker rebates Binance credited since the day start, hourly per account.">Rebates</span>, value: m(pnl(sm?.rebates)), tone: tone(sm?.rebates) },
    { label: "Other", value: m(pnl(sm?.other)), tone: tone(sm?.other), title: "Day PnL minus trading PnL, the hedge and the rebates: what the split does not explain." },
    "|",
    ...(exposure ? [exposureItem(exposure, m, hide)] : [{ label: "Exposure gap", value: "--" }]),
    { label: <span title="All accounts: spot balances at mid plus futures margin balance, USDT">Equity</span>, value: m(num(sm?.equity, 2)) },
    { label: <span title={`Notional filled since ${dayStart}${hide ? "" : `; ${compact(sm?.volume_24h)} over the last 24 hours`}. USDT.`}>Volume</span>, value: m(compact(sm?.volume_day)) },
    {
      label: "Markout 10 s",
      value: sm?.markout_net_bps_1h == null ? "--" : `${bps(sm.markout_net_bps_1h)} bps`,
      tone: signTone(sm?.markout_net_bps_1h) || undefined,
      title: "Last hour: the notional-weighted 10 s markout of the fills, net of the reference move.",
    },
    { label: <span title={`Fills in the last hour, all accounts; ${int(sm?.fills_day)} today.`}>Fills / h</span>, value: int(sm?.fills_1h) },
  ];
  return (
    <div className="dk-ticker">
      {name}
      <TickerStrip
        className="dk-tk"
        lead={{
          title: <span title={`Equity change since ${dayStart}, net of transfers. Day PnL = Market making + Inventory PnL + Hedge + Rebates + Other.`}>Day PnL (USDT)</span>,
          value: m(pnl(sm?.pnl_day)),
          tone: tone(sm?.pnl_day),
        }}
        items={items}
      />
    </div>
  );
}

const pctText = (v: number) => `${v > 0 ? "+" : v < 0 ? "−" : ""}${Math.abs(v).toFixed(2)}%`;

/** An instrument's strip: Binance's last price and 24 h stats, then our inventory, cost, P&L, spread, edge. */
export function InstrumentTicker({ inst, name }: { inst: Instrument; name: ReactNode }) {
  const t = useTicker24h(inst.symbol, inst.venue);
  const row = useStore((s) => s.snap?.symbols.find((r) => r.symbol === inst.symbol && r.venue === inst.venue));
  const hide = useHide();
  const m = (s: string) => maskNode(hide, s);
  const tone = (v: number | null | undefined) => (hide ? undefined : signTone(v) || undefined);
  const pnlOf = useInstPnl();
  const tp = row ? pnlOf(row) : null;
  // the last price's colour follows its last move, as on an exchange
  const prev = useRef<{ last: number; dir: "up" | "down" | undefined }>({ last: NaN, dir: undefined });
  if (t && t.last !== prev.current.last) {
    const dir = Number.isFinite(prev.current.last) ? (t.last > prev.current.last ? "up" : t.last < prev.current.last ? "down" : prev.current.dir) : t.change >= 0 ? "up" : "down";
    prev.current = { last: t.last, dir };
  }
  const base = inst.symbol.replace(/USDT$/, "");
  const chg = t ? (t.change > 0 ? "up" : t.change < 0 ? "down" : undefined) : undefined;
  const items: (TickerItem | "|")[] = [
    { label: "24h Chg", value: t ? `${num(t.change, decimals(t.last), true)} ${pctText(t.changePct)}` : "--", tone: chg },
    { label: "24h High", value: price(t?.high) },
    { label: "24h Low", value: price(t?.low) },
    { label: "24h Vol(USDT)", value: t ? compact(t.quoteVolume) : "--" },
    "|",
    { label: <span title="Held across accounts, free + locked">Inventory</span>, value: row ? m(`${qty(row.inv_qty, true)} ${base}`) : "--" },
    { label: <span title="Inventory × mid, USDT">Value</span>, value: m(usd(row?.inv_value)) },
    { label: <span title="Average cost from today's fills, USDT per unit">Avg cost</span>, value: price(row?.avg_cost) },
    {
      label: "Trading PnL",
      value: m(pnl(tp)),
      tone: tone(tp),
      title:
        inst.venue === "usdm"
          ? "Today: the hedge leg, price at mark − fees + funding, USDT"
          : "Today: market making + inventory PnL, fees included, USDT. The desk's Day PnL adds the hedge, rebates and other",
    },
    ...(inst.venue === "spot" ? [{ label: <span title="Each fill against the mid 60 s later, minus fees, USDT">Market making</span>, value: m(pnl(row?.mm_pnl)), tone: tone(row?.mm_pnl) }] : []),
    { label: <span title="Market spread: (ask − bid) / mid">Spread</span>, value: row?.spread_bps == null ? "--" : `${bps(row.spread_bps, false)} bps` },
    { label: "Edge", value: row?.edge_bps == null ? "--" : `${bps(row.edge_bps)} bps`, tone: signTone(row?.edge_bps) || undefined, title: "Edge at fill against fair, volume-weighted over today's fills" },
    { label: <span title="Fills today">Fills</span>, value: int(row?.fills_day) },
  ];
  return (
    <div className="dk-ticker">
      {name}
      <TickerStrip
        className="dk-tk"
        lead={{
          // Binance's last trade: the one market price up here; the ladder's middle row is our mid and fair
          title: <span title="Binance's last trade price, from its 24 h ticker">Last price</span>,
          value: price(t?.last),
          tone: prev.current.dir,
        }}
        items={items}
      />
    </div>
  );
}

const decimals = (v: number) => {
  const a = Math.abs(v);
  return a >= 1000 ? 2 : a >= 10 ? 3 : a >= 1 ? 4 : a >= 0.01 ? 5 : 7;
};
