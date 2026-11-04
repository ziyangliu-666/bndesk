import { useMemo } from "react";
import { useStore } from "../../store";
import { bps, compact, dur, hms, int, num, pct } from "../../format";
import { useExPref } from "../../components/ex";
import { maskText, useHide } from "../../mask";
import { useNow } from "../../hooks";
import { cur } from "../../desk";
import { ExposureChart, GapChart, HEDGE_SERIES, quoteRows } from "../Strategy";
import { BLOCK, STALE_MS, engineTrouble, hedgeState, capital, mv, rebalances, useEngineLatest, useEngineSeries, useMetrics, type Latest } from "../strategy/engine";
import { Empty, PageTabs, Row, Sec, Stats } from "./rest/ui";
import "./history.css";

// ---- Strategy: the engine's own figures (pushed every 15 s). Hedge: the state, the gap and exposure charts and
// the rebalances; Quoting: capital and the instruments not quoting ----

type Tab = "hedge" | "quoting";

function useAge(latest: Latest | null) {
  const now = useNow(1000) + useStore((s) => s.skew);
  const age = latest?.t != null ? Math.max(0, now - latest.t) : null;
  return { now, age, stale: age == null || age > STALE_MS };
}

function HedgeM({ latest }: { latest: Latest }) {
  const hide = useHide();
  const tz = useStore((s) => s.tz);
  const m = useMetrics(latest);
  const { age, stale } = useAge(latest);
  const { s } = useEngineSeries(HEDGE_SERIES, 2 * 86_400_000);
  const rebal = useMemo(() => rebalances(s), [s]);
  const a = (v: number | null) => (v == null ? "--" : maskText(hide, compact(v, 1, true)));
  const target = mv(m, "target"),
    pos = mv(m, "pos");
  const h = hedgeState(m, stale, age, dur);
  const trouble = engineTrouble(latest.payload);
  const [word, tone] = trouble && !stale ? [trouble, "crit-text"] : [h.word, h.tone];
  const day = rebal.filter((r) => r.t >= Date.now() - 86_400_000);
  return (
    <>
      <div className="h-sum">
        <div className="h-sum-l">
          <div className="h-sum-label">Hedge</div>
          <div className={"h-sum-v " + tone}>{word}</div>
          {h.inBands != null && <div className="h-sum-note">{`Unhedged ${num(h.inBands, 2, true)} bands`}</div>}
        </div>
      </div>
      <Stats
        cols={3}
        items={[
          { label: "Unhedged", value: a(h.unhedged) },
          { label: "Band", value: h.band == null ? "--" : maskText(hide, "±" + compact(h.band)) },
          { label: "Beta", value: mv(m, "beta") == null ? "--" : num(mv(m, "beta"), 2) },
          { label: "Target", value: a(target) },
          { label: "Hedge", value: a(pos) },
          { label: "Beta-weighted", value: a(mv(m, "bw")) },
          { label: "Inventory", value: a(mv(m, "invNet")) },
          { label: "Slippage", value: mv(m, "slipBp") == null ? "--" : bps(mv(m, "slipBp")) + " bps" },
          { label: "Time to fill", value: mv(m, "latencyMs") == null ? "--" : dur(mv(m, "latencyMs")) },
        ]}
      />
      <div className="r-chart">
        <GapChart s={s} rebal={rebal} hide={hide} height={240} />
      </div>
      <div className="r-chart">
        <ExposureChart s={s} hide={hide} height={240} />
      </div>
      <Sec title="Rebalances" right={`${day.reduce((k, r) => k + r.n, 0)} in 24 h`}>
        {rebal
          .slice()
          .reverse()
          .slice(0, 30)
          .map((r) => (
            <Row
              dense
              key={r.t}
              title={hms(r.t, tz)}
              sub={[r.taker == null ? null : r.taker ? "Taker" : "Maker", r.trigger].filter(Boolean).join(" · ")}
              value={<span className="r-fig">{a(r.target)}</span>}
              valueSub={`from ${a(r.prevTarget)}`}
              tone={r.taker ? "warn" : undefined}
            />
          ))}
        {!rebal.length && <Empty>None in 2 days</Empty>}
      </Sec>
    </>
  );
}

function QuotingM({ latest }: { latest: Latest }) {
  const hide = useHide();
  const m = useMetrics(latest);
  const { now } = useAge(latest);
  const caps = useMemo(() => capital(latest.payload), [latest]);
  const rows = useMemo(() => quoteRows(latest.payload?.quotes ?? [], latest.payload?.venues), [latest]);
  const off = rows.filter((r) => r.block !== 0);
  const a = (v: number | null) => (v == null ? "--" : maskText(hide, compact(v)));
  return (
    <>
      <Stats
        cols={3}
        items={[
          { label: "Sides quoting", value: mv(m, "sidesQuoting") == null ? "--" : `${int(mv(m, "sidesQuoting"))} / ${int(mv(m, "sidesWarm"))}` },
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
      <Sec title="Not quoting" right={`${rows.length - off.length} of ${rows.length} quoting`}>
        {off.map((r) => (
          <Row
            dense
            key={r.key}
            title={r.venue ? `${r.symbol} ${r.venue}` : r.symbol}
            sub={r.why ?? undefined}
            value={<span className={r.block >= 3 ? "warn-text" : "muted"}>{BLOCK[r.block] ?? `Code ${r.block}`}</span>}
            valueSub={r.since != null ? dur(now - r.since) : undefined}
          />
        ))}
        {!off.length && <Empty>Every instrument is quoting</Empty>}
      </Sec>
    </>
  );
}

export function StrategyM() {
  const [tab, setTab] = useExPref<Tab>("m-strategy", "tab", "hedge", ["hedge", "quoting"]);
  const { latest, error } = useEngineLatest();
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
      {!latest?.payload ? (
        <Empty>{error ? "Could not load the engine's figures" : latest == null ? "Loading" : "The engine has not sent its figures yet"}</Empty>
      ) : tab === "hedge" ? (
        <HedgeM latest={latest} />
      ) : (
        <QuotingM latest={latest} />
      )}
    </>
  );
}
