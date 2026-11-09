import { useMemo } from "react";
import { useStore } from "../../store";
import { bps, compact, dur, hm, hms, int, num, pct, type TzMode } from "../../format";
import { useExPref } from "../../components/ex";
import { maskText, useHide } from "../../mask";
import { useNow } from "../../hooks";
import { cur } from "../../desk";
import { ExposureChart, GapChart, HEDGE_SERIES, deskNote, fillTime, quoteCounts, quoteRows, unwindCount } from "../strategy/parts";
import { showInfo } from "../../components/mobile";
import { bandDef } from "./shared";
import { DeskChart, GapBar } from "./rest/assets";
import type { Exposure } from "../../protocol";
import { hedgeWord, inventoryWord, roled } from "../../desk";
import { STALE_MS, engineTrouble, hedgeState, capital, mv, rebalances, useEngineLatest, useEngineSeries, useMetrics, type Latest } from "../strategy/engine";
import { HedgeBridge } from "../../components/HedgeBridge";
import { useQty } from "../../mask";
import { Amt, Empty, PageTabs, Row, Sec, Stats, useAmt } from "./rest/ui";
import "./strategy.css";

const betaNote = (x: Exposure) =>
  x.beta_source === "estimate" ? "β: the desk's own estimate, may differ from the engine's." : "β: configured per market.";

// ---- Strategy: the engine's own figures (pushed every 15 s). Hedge: the state, the gap and exposure charts, today's
// inventory against the hedge with its legs and funding (the desk's own day), the rebalances; Quoting: capital and
// the instruments not quoting ----

type Tab = "hedge" | "quoting";

function useAge(latest: Latest | null) {
  const now = useNow(1000) + useStore((s) => s.skew);
  const age = latest?.t != null ? Math.max(0, now - latest.t) : null;
  return { now, age, stale: age == null || age > STALE_MS };
}

/** A day in the chosen zone, to date a time that is not today's. */
const dayOf = (t: number, tz: TzMode) => (tz === "utc" ? new Date(t).toISOString().slice(0, 10) : new Date(t).toLocaleDateString("en-CA"));
const when = (t: number, tz: TzMode, today: string) => {
  const d = dayOf(t, tz);
  return (d === today ? "" : d.slice(5) + " ") + hms(t, tz);
};

function HedgeM({ latest }: { latest: Latest }) {
  const hide = useHide();
  const tz = useStore((s) => s.tz);
  const m = useMetrics(latest);
  const { now, age, stale } = useAge(latest);
  const { s } = useEngineSeries(HEDGE_SERIES, 2 * 86_400_000);
  const rebal = useMemo(() => rebalances(s), [s]);
  // the hedge figures signed one way everywhere on the page: short is negative
  const a = (v: number | null) => (v == null ? "--" : maskText(hide, compact(v, 1, true)));
  const h = hedgeState(m, stale, age, dur);
  const trouble = engineTrouble(latest.payload);
  const [word, tone] = trouble && !stale ? [trouble, "crit-text"] : [h.word, h.tone];
  const rows = useMemo(() => rebal.slice().reverse(), [rebal]);
  const today = dayOf(now, tz);
  return (
    <>
      <div className="st-m-state">
        <span className={"st-m-word " + tone}>{word}</span>
        {h.gap != null && h.band != null && (
          <span className="st-m-sub r-fig">{`gap ${a(h.gap)} of ${maskText(hide, "±" + num(h.band, 0))}`}</span>
        )}
      </div>
      <Stats
        cols={4}
        className="st-m-figs"
        items={[
          { label: "Target", value: a(mv(m, "target")) },
          { label: "Position", value: a(mv(m, "pos")) },
          { label: "Beta-weighted", value: a(mv(m, "bw")) },
          { label: "Inventory", value: a(mv(m, "invNet")) },
          { label: "Beta", value: mv(m, "beta") == null ? "--" : num(mv(m, "beta"), 2) },
          { label: "Taker band", value: h.takerBand == null ? "--" : maskText(hide, "±" + num(h.takerBand, 0)) },
          { label: "Slippage", value: mv(m, "slipBp") == null ? "--" : bps(mv(m, "slipBp")) + " bps" },
          { label: "Time to fill", value: fillTime(mv(m, "latencyMs")) },
        ]}
      />
      <div className="r-chart">
        <GapChart s={s} rebal={rebal} hide={hide} height={240} />
      </div>
      <div className="r-chart">
        <ExposureChart s={s} hide={hide} height={240} />
      </div>
      <HedgeDayM />
      <FundingM />
      <Sec title="Rebalances" right={rows.length ? `${int(rows.length)} in 2 days` : undefined}>
        {rows.map((r) => (
          <Row
            dense
            key={r.t}
            title={when(r.t, tz, today)}
            sub={[r.taker == null ? null : (r.taker ? "Taker" : "Maker") + (r.n > 1 ? ` ×${r.n}` : ""), r.trigger].filter(Boolean).join(" · ")}
            value={
              <span className="r-fig">
                <span className="muted">{a(r.from)} → </span>
                {a(r.pos)}
              </span>
            }
            valueSub={`slip ${r.slip == null ? "--" : bps(r.slip) + " bps"} · fill ${fillTime(r.latency)}`}
            tone={r.taker ? "warn" : undefined}
          />
        ))}
        {!rows.length && <Empty>None in 2 days</Empty>}
      </Sec>
    </>
  );
}

/** Today's inventory P&L against what the hedge made (the desk's own day), then the legs that made it. */
function HedgeDayM() {
  const hd = useStore((s) => s.snap?.exposure.hedge_day);
  const inv = useStore((s) => s.snap?.summary.pnl.holding);
  const hide = useHide();
  const q = useQty();
  if (!hd) return null;
  const offset = inv != null && hd.hedge_pnl != null && Math.abs(inv) > 1e-9 ? -hd.hedge_pnl / inv : null;
  return (
    <>
      <Sec className="st-m-bridge" title="Inventory and hedge, today" right={offset != null ? `offset ${pct(offset, 0)}` : undefined}>
        {hide ? <Empty>Amounts hidden</Empty> : <HedgeBridge h={hd} inventory={inv ?? 0} />}
      </Sec>
      {hd.legs.length > 0 && (
        <Sec title="Hedge legs" right="hedge PnL · fees">
          {hd.legs.map((l) => (
            <Row
              key={l.venue + l.symbol}
              dense
              title={l.symbol}
              sub={`${q(l.qty0, true)} → ${q(l.qty, true)} · ${int(l.fills)} fills`}
              value={<Amt v={l.pnl} />}
              valueSub={<Amt v={-l.fees} plain />}
              to={{ page: "desk", detail: { kind: "instrument", symbol: l.symbol, venue: l.venue } }}
            />
          ))}
        </Sec>
      )}
    </>
  );
}

/** Funding of the perps held: the rate now and when it is next paid. */
function FundingM() {
  const f = useStore((s) => s.snap?.exposure.funding);
  const tz = useStore((s) => s.tz);
  const now = useNow(1000) + useStore((s) => s.skew);
  if (!f?.length) return null;
  const next = (t: number | null) => (t == null ? "--" : `${hm(t, tz)} · in ${dur(t - now)}`);
  // one payment time for every perp (the usual case): said once, in the head
  const one = f.every((x) => x.next === f[0]!.next);
  return (
    <Sec title="Funding" right={one ? `next ${next(f[0]!.next)}` : "rate · next"}>
      {f.map((x) => (
        <Row
          key={x.symbol}
          dense
          title={x.symbol}
          value={<span className="r-fig">{x.rate == null ? "--" : `${bps(x.rate * 1e4)} bps`}</span>}
          valueSub={one ? undefined : next(x.next)}
        />
      ))}
    </Sec>
  );
}

function QuotingM({ latest }: { latest: Latest }) {
  const hide = useHide();
  const m = useMetrics(latest);
  const { now } = useAge(latest);
  const caps = useMemo(() => capital(latest.payload), [latest]);
  const rows = useMemo(() => quoteRows(latest.payload?.quotes ?? [], latest.payload?.venues), [latest]);
  // what needs a look: a side stopped by something; one-sided and idle instruments are the engine's own choice
  const off = rows.filter((r) => r.kind === "blocked");
  const c = quoteCounts(rows);
  const a = (v: number | null) => (v == null ? "--" : maskText(hide, compact(v)));
  const { age, stale } = useAge(latest);
  const trouble = engineTrouble(latest.payload);
  const truncated = latest.payload?.truncated === true || latest.payload?.quotes == null;
  return (
    <>
      {(stale || trouble) && <div className="st-m-trouble warn-text">{stale ? "No push for " + dur(age) : trouble}</div>}
      <Stats
        cols={3}
        items={[
          {
            label: "Sides with a clip",
            value: mv(m, "sidesQuoting") == null ? "--" : `${int(mv(m, "sidesQuoting"))} / ${int(mv(m, "sidesWarm"))}` + (unwindCount(latest, m) > 0 ? ` +${int(unwindCount(latest, m))}` : ""),
          },
          { label: "Budget, clips", value: mv(m, "budget") == null ? "--" : `${num(mv(m, "clipsUnspent"), 1)} / ${num(mv(m, "budget"), 1)}` },
          { label: "Unwinding", value: a(mv(m, "unwindUsd")) },
        ]}
      />
      <Sec title={`Capital (${cur()})`}>
        {caps.map((c) => {
          const u = c.free + c.locked > 0 ? c.locked / (c.free + c.locked) : null;
          return (
            <Row
              dense
              key={c.account}
              title={c.account}
              sub={`${a(c.locked)} in orders · ${a(c.free)} free`}
              value={<span className={"r-fig" + (u != null && u > 0.9 ? " warn-text" : "")}>{u == null ? "--" : pct(u)}</span>}
            />
          );
        })}
        {!caps.length && <Empty>No balances sent</Empty>}
      </Sec>
      <Sec title="Stopped" right={truncated ? undefined : [`${c.both} both sides`, c.one && `${c.one} one side`, c.idle && `${c.idle} idle`].filter(Boolean).join(" · ")}>
        {off.map((r) => (
          <Row
            dense
            key={r.key}
            title={r.venue ? `${r.symbol} ${r.venue}` : r.symbol}
            sub={r.why ?? undefined}
            value={<span className="warn-text">{r.state}</span>}
            valueSub={r.since != null ? dur(now - r.since) : undefined}
          />
        ))}
        {truncated ? <Empty>The last push left the quotes out</Empty> : !off.length && <Empty>{rows.length ? "Nothing is stopped" : "The engine sent no quotes"}</Empty>}
      </Sec>
    </>
  );
}

/** The desk's own exposure and gap (Assets' old Exposure tab), when the engine is not pushing its figures. */
function DeskExposureM({ note }: { note: string }) {
  const accounts = useStore((s) => s.snap?.accounts) ?? [];
  const x = useStore((s) => s.snap?.exposure);
  const sm = useStore((s) => s.snap?.summary);
  const tz = useStore((s) => s.tz);
  const money = useAmt();
  if (!x || !sm) return null;
  const labelOf = (id: string) => accounts.find((a) => a.id === id)?.label ?? id;
  const gapInfo = x.paused
    ? `${x.paused}: the hedge is off and its target is 0; the value is the hedge symbols' futures notional still open, to be closed` +
      `${x.paused_until != null ? `, until ${hms(x.paused_until, tz)}` : ""}. ${cur()}.`
    : `Hedge target minus the futures notional of the hedge symbols (the trade that closes it; negative = sell more), where the target is ` +
      `−${num(x.ratio, 2)} × beta-weighted spot value. ${betaNote(x)} ${bandDef(money(x.band, "full"))} ${cur()}.`;
  return (
    <>
      <div className="st-m-note">{note}</div>
      <Sec flush>
        {x.band != null && (x.gap != null || x.paused) && (
          <GapBar
            label={x.paused ? `Hedge to close (${x.paused})` : "Exposure gap"}
            value={x.paused ? x.hedge_notional : x.gap}
            band={x.band}
            onLabel={() => showInfo(x.paused ? "Hedge to close" : "Exposure gap", gapInfo)}
          />
        )}
        <Stats
          cols={3}
          items={[
            { label: "Net exposure", info: `${inventoryWord()} value plus ${hedgeWord()} net notional, all accounts. ${cur()}.`, value: <Amt v={x.net} plain /> },
            {
              label: "Hedge target",
              info: `Hedge target = −${num(x.ratio, 2)} × Spot × beta (${money(x.beta_value, "full")}). ${betaNote(x)} ${cur()}.`,
              value: <Amt v={x.target} plain />,
            },
            { label: "Hedge", info: `Futures notional of the hedge symbols, ${cur()}.`, value: <Amt v={x.hedge_notional} plain /> },
            { label: roled() ? "Inventory" : "Spot value", value: money(x.spot_value, "full") },
            ...(Math.abs(x.futures_notional - x.hedge_notional) > 0.005
              ? [{ label: "All futures", info: `Futures net notional of every symbol, hedge or not, ${cur()}.`, value: <Amt v={x.futures_notional} plain /> }]
              : []),
          ]}
        />
      </Sec>
      <Sec title="By account" right="spot · futures · net">
        {x.by_account.map((r) => (
          <Row
            key={r.account}
            dense
            title={labelOf(r.account)}
            sub={`Spot ${money(r.spot_value, "k")} · Futures ${money(r.futures_notional, "pnlK")}`}
            value={<Amt v={r.net} kind="pnlK" plain />}
            to={{ page: "assets", detail: { kind: "account", id: r.account } }}
          />
        ))}
      </Sec>
      <Sec>
        <DeskChart what="exposure" />
      </Sec>
      <HedgeDayM />
      <FundingM />
    </>
  );
}

export function StrategyM() {
  const [tab, setTab] = useExPref<Tab>("m-strategy", "tab", "hedge", ["hedge", "quoting"]);
  const { latest, error } = useEngineLatest();
  const { age, stale } = useAge(latest);
  return (
    <>
      <PageTabs
        items={[
          { value: "hedge", label: "Hedge" },
          { value: "quoting", label: "Quoting" },
        ]}
        value={tab}
        onChange={setTab}
      />
      {latest == null && !error ? (
        <Empty>Loading</Empty>
      ) : tab === "hedge" && (!latest?.payload || stale) ? (
        <DeskExposureM note={deskNote(error, latest, age)} />
      ) : !latest?.payload ? (
        <Empty>{error ? "Could not load the engine's figures" : "The engine has not sent its figures yet"}</Empty>
      ) : tab === "hedge" ? (
        <HedgeM latest={latest} />
      ) : (
        <QuotingM latest={latest} />
      )}
    </>
  );
}
