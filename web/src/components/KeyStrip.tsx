// The Desk's head, where an exchange has its ticker strip: the name slot, one large figure, its parts in a line
// under it, quieter facts at the right. With nothing picked it is the desk's (Day PnL and its split; exposure,
// equity, volume, markout, fills); with an instrument picked, that instrument's (Binance's last price and 24 h
// figures, then ours).
import type { ReactNode } from "react";
import { useStore, type Instrument } from "../store";
import { bps, compact, hm, int, num, pnl, price, qty, usd } from "../format";
import type { Exposure } from "../protocol";
import { FigureHead, useTicker24h, type Fact } from "./ex";
import { maskNode, signTone, useHide } from "../mask";
import { tradingPnl, unpriced, useHedgePnl } from "../selectors";
import { cur, baseOf, useDesk, isHedge, roled, hedgeWord, inventoryWord, exchangeOf, exchangeWord, notionalCur } from "../desk";
import { hasTickerSocket } from "./ex/ticker";
import { useEngineHedge } from "../pages/strategy/engine";
import { navigate } from "../store";
import { useNow } from "../hooks";

const betaNote = (x: Exposure) =>
  x.beta_source === "estimate" ? "β: desk estimate, may differ from the engine's" : "β: configured per market";

function exposureFact(x: Exposure, m: (s: string) => ReactNode, hide: boolean): Fact {
  const hasGap = x.gap != null && x.band != null;
  const over = hasGap && Math.abs(x.gap!) > x.band!;
  if (hasGap && x.paused)
    return {
      label: "Hedge closing",
      value: m(pnl(x.hedge_notional)),
      tone: over ? "warn" : undefined,
      title: `${x.paused}: the hedge is off and its target is 0; the value is the hedge symbols' futures notional still open, to be closed. ${cur()}.`,
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
        `After the slash: the band, the allowed size of the gap. ${cur()}.`,
    };
  return {
    label: "Net exposure",
    value: m(pnl(x.net)),
    title: `Net exposure: ${inventoryWord().toLowerCase()} value plus ${hedgeWord()} net notional, all accounts.${hide ? "" : ` ${hedgeWord() === "hedge" ? "Hedge" : "Futures"} net notional ${pnl(x.futures_notional)}.`} ${cur()}.`,
  };
}

function engineFact(e: NonNullable<ReturnType<typeof useEngineHedge>>, m: (s: string) => ReactNode): Fact {
  const over = e.gap != null && e.band != null && Math.abs(e.gap) >= e.band;
  return {
    label: (
      <button type="button" className="dk-tk-link" onClick={() => navigate({ page: "strategy" })}>
        {e.word === "Within the band" ? "Hedge gap" : e.word}
      </button>
    ),
    value: (
      <>
        {m(pnl(e.gap))}
        <span className="dk-tk-of"> / ±{m(num(e.band, 0))}</span>
      </>
    ),
    tone: over ? "warn" : undefined,
    title: `The engine's hedge target minus its hedge, against the band at which it rebalances (Strategy has the history). ${cur()}.`,
  };
}

/** The desk's head. `name`: the name slot at the left (the picker / back control). Day PnL is the one large
 *  figure (green / red: it answers "did we make money"); its split is a line under it in ink; equity, exposure,
 *  volume, markout and fills sit quieter at the right. */
export function DeskTicker({ name }: { name: ReactNode }) {
  // the parts it shows, not the whole snapshot: fills and series messages leave these untouched
  const sm = useStore((st) => st.snap?.summary);
  const exposure = useStore((st) => st.snap?.exposure);
  const tz = useStore((st) => st.tz);
  const hide = useHide();
  const engine = useEngineHedge(useNow(5000) + useStore.getState().skew);
  const m = (s: string) => maskNode(hide, s);
  const tone = (v: number | null | undefined) => (hide ? undefined : signTone(v) || undefined);
  const p = sm?.pnl;
  const hedge = exposure?.hedge_day?.hedge_pnl ?? null;
  const dayStart = sm ? `${hm(sm.day_start, tz)} ${tz === "utc" ? "UTC" : "local time"}` : "the day start";
  const d = useDesk();
  const parts: Fact[] = [
    ...(d.mm ? [] : [{ label: "Trading", value: m(pnl(p?.trading)), title: "Trading PnL: what the fills and the held inventory made, fees included." }]),
    {
      label: "Market making",
      value: m(pnl(p?.mm)),
      title: `Each fill against the mid 60 s after it, minus fees.${hide ? "" : ` Against the fair at the fill instead: ${pnl(p?.mm_spread)} ${cur()}.`}${unpriced(p, hide)}`,
    },
    { label: "Inventory", value: m(pnl(p?.inventory)), title: `Inventory PnL: PnL minus market making, what the inventory made after the first 60 s of each fill.${p?.funding_day ? `${hide ? "" : ` Funding received ${pnl(p.funding_day)}.`}` : ""}` },
    { label: "Hedge", value: m(pnl(hedge)), title: `The ${hedgeWord()} legs since the day start: price at mark, minus fees, plus funding.` },
    { label: "Rebates", value: m(pnl(sm?.rebates)), title: `Market-maker rebates ${exchangeWord()} credited since the day start, per account.` },
    { label: "Other", value: m(pnl(sm?.other)), title: "Day PnL minus what the parts add up to: what the split does not explain." },
  ].filter((x) => (x.label === "Hedge" ? d.hedge : x.label === "Rebates" ? d.rebates : x.label === "Market making" || x.label === "Inventory" ? d.mm : true));
  const facts: Fact[][] = [
    [
      // the engine's own figure when it is pushing (Strategy shows the same), else the desk's estimate
      ...(engine ? [engineFact(engine, m)] : exposure ? [exposureFact(exposure, m, hide)] : []),
      { label: "Equity", value: m(num(sm?.equity, 2)), title: `All accounts: spot balances at mid plus futures margin balance, ${cur()}` },
    ],
    [
      {
        label: roled(d) ? "Volume" : "Spot volume",
        value: m(compact(sm?.volume_day)),
        title: `${roled(d) ? "Notional" : "Spot notional"} filled since ${dayStart}${hide ? "" : `; ${compact(sm?.volume_24h)} over the last 24 hours`} ${d.hedge ? " (the hedge's fills are on their own rows)" : ""}. ${cur()}.`,
      },
      {
        label: "Markout 10 s",
        value: sm?.markout_net_bps_1h == null ? "--" : `${bps(sm.markout_net_bps_1h)} bps`,
        title: "Last hour: the notional-weighted 10 s markout of the fills, net of the reference move.",
      },
      { label: "Fills / h", value: int(sm?.fills_1h), title: `${roled(d) ? "Fills" : "Spot fills"} in the last hour, all accounts; ${int(sm?.fills_day)} today.` },
    ],
  ];
  return (
    <div className="dk-ticker">
      {name}
      <FigureHead
        className="dk-tk"
        label="Day PnL"
        title={`Equity change since ${dayStart}, net of transfers, ${cur()}. Day PnL = ${[...(d.mm ? ["Market making", "Inventory PnL"] : ["Trading PnL"]), ...(d.hedge ? ["Hedge"] : []), ...(d.rebates ? ["Rebates"] : []), "Other"].join(" + ")}.`}
        value={m(pnl(sm?.pnl_day))}
        tone={tone(sm?.pnl_day)}
        aside={[{ label: "1h", value: m(pnl(sm?.pnl_1h)), title: `The change of Day PnL over the last hour, ${cur()}` }]}
        parts={parts}
        facts={facts}
      />
    </div>
  );
}

/** What "Last" is: a trade where the exchange's ticker has one, else its mark. */
const lastTitle = (v: Instrument["venue"]) =>
  hasTickerSocket(v)
    ? `${exchangeOf(v)}'s last trade price, from its 24 h ticker (the ladder's middle row is the mid)`
    : `${exchangeOf(v)}'s mark price, from its 24 h figures (the ladder's middle row is the mid)`;

/** An instrument's head: Binance's last price large with its 24 h figures beside it; our position and P&L in a
 *  line under it (Trading PnL coloured: ours); spread, edge and fills quieter at the right. */
export function InstrumentTicker({ inst, name }: { inst: Instrument; name: ReactNode }) {
  const t = useTicker24h(inst.symbol, inst.venue);
  const row = useStore((s) => s.snap?.symbols.find((r) => r.symbol === inst.symbol && r.venue === inst.venue));
  const hide = useHide();
  const m = (s: string) => maskNode(hide, s);
  const tone = (v: number | null | undefined) => (hide ? undefined : signTone(v) || undefined);
  const hedgeOf = useHedgePnl();
  const dm = useDesk().mm;
  const hedged = isHedge(inst);
  const tp = row ? (hedged ? hedgeOf(row) : tradingPnl(row)) : null;
  const base = baseOf(inst.symbol);
  const aside: Fact[] = [
    { label: "24h", value: t ? `${num(t.change, decimals(t.last), true)} ${pctText(t.changePct)}` : "--", title: `${exchangeOf(inst.venue)}'s 24 h change` },
    { label: "High", value: price(t?.high) },
    { label: "Low", value: price(t?.low) },
    { label: "Vol", value: t ? compact(t.quoteVolume) : "--", title: `${exchangeOf(inst.venue)}'s 24 h volume, ${notionalCur()}` },
  ];
  const parts: Fact[] = [
    hedged
      ? { label: "Hedge", value: m(pnl(tp)), tone: tone(tp), title: `Today: this instrument's hedge leg, price P&L at mark − fees + funding, ${cur()}` }
      : dm
        ? { label: "Market making", value: m(pnl(row?.mm_pnl)), tone: tone(row?.mm_pnl), title: `Today: each fill against the mid 60 s later, minus fees, ${cur()}` }
        : { label: "Trading", value: m(pnl(tp)), tone: tone(tp), title: `Today: what the fills and the held inventory made, fees included, ${cur()}` },
    ...(hedged || !dm ? [] : [{ label: "Inventory PnL", value: m(pnl(row?.inv_pnl)), tone: tone(row?.inv_pnl), title: `Today: what the held inventory made after those 60 s, ${cur()}` }]),
    { label: "Inventory", value: row ? m(`${qty(row.inv_qty, true)} ${base}`) : "--", title: "Held across accounts, free + locked" },
    { label: "Value", value: m(usd(row?.inv_value)), title: `Inventory × mid, ${cur()}` },
    { label: "Avg cost", value: price(row?.avg_cost), title: "Average cost from today's fills" },
  ];
  const facts: Fact[][] = [
    [
      { label: "Spread", value: row?.spread_bps == null ? "--" : `${bps(row.spread_bps, false)} bps`, title: "Market spread: (ask − bid) / mid" },
      { label: "Edge", value: row?.edge_bps == null ? "--" : `${bps(row.edge_bps)} bps`, title: "Edge at fill against fair, volume-weighted over today's fills" },
    ],
    [{ label: "Fills today", value: int(row?.fills_day) }],
  ];
  return (
    <div className="dk-ticker">
      {name}
      <FigureHead
        className="dk-tk"
        // Binance's last trade: the one market price up here; the ladder's middle row is our mid and fair
        label="Last"
        title={lastTitle(inst.venue)}
        value={price(t?.last)}
        aside={aside}
        parts={parts}
        facts={facts}
      />
    </div>
  );
}

const pctText = (v: number) => `${v > 0 ? "+" : v < 0 ? "−" : ""}${Math.abs(v).toFixed(2)}%`;

const decimals = (v: number) => {
  const a = Math.abs(v);
  return a >= 1000 ? 2 : a >= 10 ? 3 : a >= 1 ? 4 : a >= 0.01 ? 5 : 7;
};
