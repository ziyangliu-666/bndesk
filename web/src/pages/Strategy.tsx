// Strategy: what the trading engine itself says it is doing, from the figures its box pushes every 15 s
// (strategy/engine.ts). Hedge: is the hedge on target (the gap in bands over time, with each rebalance), how big
// the exposure is raw and beta-weighted against the hedge, what the hedge cost today, and the rebalances.
// Quoting: where the pools' capital is, and each instrument's quotes and what stops them.
import { useMemo, type ReactNode } from "react";
import { useStore } from "../store";
import { bps, compact, dur, hms, int, num, pct, price } from "../format";
import { ACCOUNT_SERIES, C, FUT_COLOR, INV_COLOR } from "../theme";
import { ExChart, Tabs, useExPref, type ExMarker, type ExSeries } from "../components/ex";
import { amount, maskText, useHide } from "../mask";
import { useNow } from "../hooks";
import { FundingPanel, HedgePanel } from "./Accounts";
import { BLOCK, STALE_MS, engineTrouble, hedgeState, capital, mv, pts, rebalances, skey, useEngineLatest, useEngineSeries, useMetrics, type Latest, type Quote, type Rebalance, type Reason } from "./strategy/engine";
import "./ops/ops.css";
import "./strategy/strategy.css";
import { cur } from "../desk";

const DAY = 86_400_000;
/** The hedge charts hold two days and open on the last one. */
const SPAN = 2 * DAY;
const HEDGE_KEYS = ["target", "pos", "band", "takerBand", "bw", "invNet", "rebalCount", "rebalT", "takerCount", "trigger", "slipBp", "latencyMs", "paused"] as const;

type Tab = "hedge" | "quoting";

function Fig({ label, children, tone, title }: { label: string; children: ReactNode; tone?: string; title?: string }) {
  return (
    <div className="ops-pair" title={title}>
      <span className="ops-l">{label}</span>
      <span className={"ops-v fig" + (tone ? " " + tone : "")}>{children}</span>
    </div>
  );
}

/** How old the last push is, and whether that is too old. */
function usePush(latest: Latest | null) {
  const skew = useStore((s) => s.skew);
  const now = useNow(1000) + skew;
  const age = latest?.t != null ? Math.max(0, now - latest.t) : null;
  return { age, stale: age == null || age > STALE_MS };
}

function NoData({ latest, error }: { latest: Latest | null; error: string | null }) {
  return (
    <div className="st-none">
      {error ? "Could not load the engine's figures" : latest == null ? "Loading" : "The engine has not sent its figures yet"}
    </div>
  );
}

// ================================ hedge ================================

function HedgeState({ m, age, stale, trouble }: { m: Record<string, number>; age: number | null; stale: boolean; trouble: string | null }) {
  const h = hedgeState(m, stale, age, dur);
  return (
    <div className="st-state">
      <span className={"st-state-word " + (trouble && !stale ? "crit-text" : h.tone)}>{trouble && !stale ? trouble : h.word}</span>
      {h.inBands != null && <span className="st-state-sub fig">{`unhedged ${num(h.inBands, 2, true)} bands`}</span>}
    </div>
  );
}

function HedgeFigures({ m, rebal, hide }: { m: Record<string, number>; rebal: Rebalance[]; hide: boolean }) {
  const a = (v: number | null) => (v == null ? "--" : amount(v, "pnlMoney", hide));
  const today = useMemo(() => {
    const from = Date.now() - DAY;
    const rs = rebal.filter((r) => r.t >= from);
    const n = rs.reduce((k, r) => k + r.n, 0);
    const taker = rs.filter((r) => r.taker).length;
    return { n, taker };
  }, [rebal]);
  const target = mv(m, "target"),
    pos = mv(m, "pos");
  const h = hedgeState(m, false, null, dur);
  return (
    <div className="st-figs">
      <Fig label="Unhedged" title={`Beta-weighted inventory the hedge does not offset (beta-weighted + hedge), ${cur()}`}>{a(h.unhedged)}</Fig>
      <Fig label="Band" title={`Unhedged allowed before a maker rebalance; past the taker band the engine crosses, ${cur()}`}>
        {mv(m, "band") == null ? "--" : maskText(hide, "±" + compact(mv(m, "band")))}
        {mv(m, "takerBand") != null && <span className="ops-unit">{maskText(hide, "taker ±" + compact(mv(m, "takerBand")))}</span>}
      </Fig>
      <Fig label="Target">
        {a(target)}
        {h.behind != null && Math.abs(h.behind) > 0.5 && <span className="ops-unit">{maskText(hide, compact(h.behind, 1, true) + " to fill")}</span>}
      </Fig>
      <Fig label="Hedge position" title="The engine's position in the hedge perpetual, at its mid">{a(pos)}</Fig>
      <Fig label="Beta-weighted inventory">{a(mv(m, "bw"))}</Fig>
      <Fig label="Inventory" title="Net, at mid; gross after it">
        {a(mv(m, "invNet"))}
        {mv(m, "invGross") != null && <span className="ops-unit">{maskText(hide, "gross " + compact(mv(m, "invGross")))}</span>}
      </Fig>
      <Fig label="Beta" title="The engine's effective beta of the inventory to the hedge">{mv(m, "beta") == null ? "--" : num(mv(m, "beta"), 2)}</Fig>
      <Fig label="Rebalances, 24 h">
        {int(today.n)}
        <span className="ops-unit">{today.taker ? `${today.taker} taker` : "all maker"}</span>
      </Fig>
      <Fig label="Slippage" title="Against the mid when the engine decided, average">{mv(m, "slipBp") == null ? "--" : bps(mv(m, "slipBp")) + " bps"}</Fig>
      <Fig label="Time to fill" title="From the decision to the fill, average">{mv(m, "latencyMs") == null ? "--" : dur(mv(m, "latencyMs"))}</Fig>
    </div>
  );
}

/** The engine's hedge figures the charts and the table read. */
export const HEDGE_SERIES = HEDGE_KEYS.map(skey);

export function GapChart({ s, rebal, hide, height }: { s: ReturnType<typeof useEngineSeries>["s"]; rebal: Rebalance[]; hide: boolean; height?: number }) {
  const { series, last24, takerBands } = useMemo(() => {
    const band = s?.v[skey("band")] ?? [];
    const pos = s?.v[skey("pos")] ?? [];
    const tb = s?.v[skey("takerBand")] ?? [];
    // the beta-weighted inventory the hedge does not offset, in bands: it drifts to ±1, a rebalance brings it back
    const gap = pts(s, skey("bw"), (bw, i) => (pos[i] != null && band[i] ? (bw + pos[i]!) / band[i]! : null));
    // and a rebalance still filling: the target the hedge has not reached, in bands
    const behind = pts(s, skey("target"), (t, i) => (pos[i] != null && band[i] ? (t - pos[i]!) / band[i]! : null));
    const from = Date.now() - DAY;
    let takerBands: number | null = null;
    for (let i = (s?.t.length ?? 0) - 1; i >= 0; i--)
      if (tb[i] != null && band[i]) {
        takerBands = tb[i]! / band[i]!;
        break;
      }
    const series: ExSeries[] = [
      { key: "gap", kind: "line", label: "Unhedged", toggle: false, color: C.ink, width: 1.5, format: (v) => num(v, 2, true), data: gap },
      { key: "behind", kind: "line", label: "To fill", color: C.warn, width: 1, format: (v) => num(v, 2, true), data: behind, lastValue: false },
    ];
    return { series, last24: gap.filter((p) => p.time >= from).length, takerBands };
  }, [s]);
  const markers = useMemo<ExMarker[]>(
    () =>
      rebal.map((r) => ({
        series: "gap",
        time: r.t,
        color: r.taker ? C.warn : C.ink2,
        shape: r.taker ? "arrowDown" : "circle",
        position: "aboveBar",
        size: r.taker ? 1 : 0.5,
      })),
    [rebal],
  );
  const lines = useMemo(
    () => [
      { series: "gap", price: 1, color: C.muted, style: "dashed" as const, axisLabel: false, title: "Band" },
      { series: "gap", price: -1, color: C.muted, style: "dashed" as const, axisLabel: false },
      ...(takerBands != null
        ? [
            { series: "gap", price: takerBands, color: C.crit, style: "dotted" as const, axisLabel: false, title: "Taker" },
            { series: "gap", price: -takerBands, color: C.crit, style: "dotted" as const, axisLabel: false },
          ]
        : []),
    ],
    [takerBands],
  );
  return (
    <section className="ops-panel ops-chart-panel">
      <ExChart
        id="st-gap"
        height={height}
        title="Unhedged"
        series={series}
        markers={hide ? [] : markers}
        priceLines={lines}
        toolbarLeft={<span className="ops-chart-title">Unhedged, in bands</span>}
        initialBars={Math.max(2, last24)}
        fill={height == null}
        fullscreen
        emptyText="No figures yet"
        loading={s == null}
      />
    </section>
  );
}

export function ExposureChart({ s, hide, height }: { s: ReturnType<typeof useEngineSeries>["s"]; hide: boolean; height?: number }) {
  const series = useMemo<ExSeries[]>(() => {
    const fmt = (v: number) => amount(v, "pnlMoney", hide);
    // the hedge drawn as the size of its short, so it lies on the beta-weighted line when hedged
    const size = (v: number) => amount(v, "money", hide);
    return [
      { key: "inv", kind: "line", label: "Inventory", color: INV_COLOR, width: 1, data: pts(s, skey("invNet")), format: fmt, lastValue: false },
      { key: "bw", kind: "line", label: "Beta-weighted", color: C.ink, width: 2, data: pts(s, skey("bw")), format: fmt },
      // the hedge and its target as what they offset (their negatives): on top of the beta-weighted line when hedged
      { key: "hedge", kind: "line", label: "Short hedge", color: FUT_COLOR, width: 2, data: pts(s, skey("pos"), (v) => -v), format: size },
      { key: "target", kind: "line", label: "Short target", color: FUT_COLOR, width: 1, lineStyle: "dotted", data: pts(s, skey("target"), (v) => -v), format: size, lastValue: false, options: { lineType: 1 } },
    ];
  }, [s, hide]);
  const last24 = series[1]!.data.filter((p) => p.time >= Date.now() - DAY).length;
  return (
    <section className="ops-panel ops-chart-panel">
      <ExChart
        id="st-exp"
        height={height}
        title="Exposure"
        series={series}
        toolbarLeft={<span className="ops-chart-title">{`Exposure and hedge (${cur()})`}</span>}
        initialBars={Math.max(2, last24)}
        fill={height == null}
        fullscreen
        emptyText="No figures yet"
        loading={s == null}
      />
    </section>
  );
}

function Rebalances({ rebal, hide }: { rebal: Rebalance[]; hide: boolean }) {
  const tz = useStore((s) => s.tz);
  const rows = useMemo(() => rebal.slice().reverse().slice(0, 200), [rebal]);
  const a = (v: number | null) => (v == null ? "--" : maskText(hide, compact(v, 1, true)));
  return (
    <section className="ops-panel st-rebal">
      <header className="ops-head">
        <span className="ops-title">Rebalances</span>
        <span className="ops-count">{rows.length ? `${rows.length} in 2 days` : ""}</span>
      </header>
      <div className="ops-body ops-scroll">
        {rows.length ? (
          <table className="ops-table">
            <thead>
              <tr>
                <th className="l">Time</th>
                <th className="l">Type</th>
                <th className="l">Trigger</th>
                <th title={`Target before and after, ${cur()}`}>Target</th>
                <th title="Average slippage after it, bps">Slip</th>
                <th title="Average time to fill after it">Fill</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.t}>
                  <td className="l fig">
                    {new Date(r.t).toDateString() !== new Date().toDateString() && <span className="muted">{new Date(r.t).toISOString().slice(5, 10)} </span>}
                    {hms(r.t, tz)}
                  </td>
                  <td className={"l" + (r.taker ? " warn-text" : "")}>{r.taker == null ? "--" : r.taker ? "Taker" : "Maker"}{r.n > 1 ? ` ×${r.n}` : ""}</td>
                  <td className="l">{r.trigger ?? "--"}</td>
                  <td className="fig">
                    <span className="muted">{a(r.prevTarget)} → </span>
                    {a(r.target)}
                  </td>
                  <td className="fig">{r.slip == null ? "--" : bps(r.slip)}</td>
                  <td className="fig">{r.latency == null ? "--" : dur(r.latency)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <div className="ops-empty">None in 2 days</div>
        )}
      </div>
    </section>
  );
}

function Hedge({ latest, error }: { latest: Latest | null; error: string | null }) {
  const hide = useHide();
  const m = useMetrics(latest);
  const { age, stale } = usePush(latest);
  const { s } = useEngineSeries(HEDGE_SERIES, SPAN);
  const rebal = useMemo(() => rebalances(s), [s]);
  if (!latest?.payload) return <NoData latest={latest} error={error} />;
  return (
    <div className="ops-tab-body st-hedge">
      <section className="ops-panel st-top">
        <HedgeState m={m} age={age} stale={stale} trouble={engineTrouble(latest.payload)} />
        <HedgeFigures m={m} rebal={rebal} hide={hide} />
      </section>
      <GapChart s={s} rebal={rebal} hide={hide} />
      <ExposureChart s={s} hide={hide} />
      <div className="ops-col st-side">
        <HedgePanel />
        <FundingPanel />
        <Rebalances rebal={rebal} hide={hide} />
      </div>
    </div>
  );
}

// ================================ quoting ================================

function CapitalPanel({ latest, hide }: { latest: Latest | null; hide: boolean }) {
  const rows = useMemo(() => capital(latest?.payload), [latest]);
  const tot = rows.reduce((k, r) => ({ free: k.free + r.free, locked: k.locked + r.locked }), { free: 0, locked: 0 });
  const util = (r: { free: number; locked: number }) => (r.free + r.locked > 0 ? r.locked / (r.free + r.locked) : null);
  const a = (v: number) => maskText(hide, compact(v));
  return (
    <section className="ops-panel">
      <header className="ops-head">
        <span className="ops-title">Capital</span>
        <span className="ops-head-right fig">
          <span className="muted">In orders</span> {util(tot) == null ? "--" : pct(util(tot)!)}
        </span>
      </header>
      <div className="ops-body">
        <table className="ops-table st-cap">
          <thead>
            <tr>
              <th className="l">Account</th>
              <th title={`In open orders, ${cur()}`}>Locked</th>
              <th title={`Free to quote with, ${cur()}`}>Free</th>
              <th className="l st-cap-bar-h">In orders</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => {
              const u = util(r);
              return (
                <tr key={r.account}>
                  <td className="l">{r.account}</td>
                  <td className="fig">{a(r.locked)}</td>
                  <td className="fig">{a(r.free)}</td>
                  <td className="l">
                    <span className="st-bar">
                      <span className={"st-bar-fill" + (u != null && u > 0.9 ? " hot" : "")} style={{ width: `${(u ?? 0) * 100}%` }} />
                    </span>
                    <span className="fig st-bar-v">{u == null ? "--" : pct(u)}</span>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function CapitalChart({ hide }: { hide: boolean }) {
  const { s } = useEngineSeries(useMemo(() => ["balances.*"], []), SPAN);
  const series = useMemo<ExSeries[]>(() => {
    if (!s) return [];
    // locked over free + locked, per account (USD-like assets)
    const accts = new Map<string, { free: string[]; locked: string[] }>();
    for (const k of Object.keys(s.v)) {
      const m = /^balances\.([^.]+)\.(USDT|USDC|FDUSD|USD)\.(free|locked)$/.exec(k);
      if (!m) continue;
      const e = accts.get(m[1]!) ?? { free: [], locked: [] };
      e[m[3] as "free" | "locked"].push(k);
      accts.set(m[1]!, e);
    }
    const sumAt = (keys: string[], i: number) => keys.reduce((k, x) => k + (s.v[x]![i] ?? 0), 0);
    return [...accts.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([acct, e], j) => ({
        key: acct,
        kind: "line" as const,
        label: acct,
        color: ACCOUNT_SERIES[j % ACCOUNT_SERIES.length],
        width: 1.5,
        format: (v: number) => pct(v),
        lastValue: false,
        data: s.t.map((t, i) => {
          const f = sumAt(e.free, i),
            l = sumAt(e.locked, i);
          return { time: t, value: f + l > 0 ? l / (f + l) : null };
        }),
      }));
  }, [s]);
  const last24 = series[0]?.data.filter((p) => p.time >= Date.now() - DAY).length ?? 0;
  return (
    <section className="ops-panel ops-chart-panel">
      <ExChart
        id="st-cap"
        title="Capital in orders"
        series={hide ? [] : series}
        toolbarLeft={<span className="ops-chart-title">Capital in orders, by account</span>}
        initialBars={Math.max(2, last24)}
        fill
        fullscreen
        emptyText={hide ? "Amounts hidden" : "No figures yet"}
        loading={s == null}
      />
    </section>
  );
}

interface QRow {
  key: string;
  venue: string | null;
  symbol: string;
  mid: number | null;
  position: number | null;
  bid: Quote | null;
  ask: Quote | null;
  spread: number | null;
  depth: number | null;
  /** The worse side's block (0 quoting) and since when. */
  block: number;
  since: number | null;
  why: string | null;
}

export function quoteRows(qs: Quote[], venues?: { name: string }[]): QRow[] {
  const named = new Set(qs.map((q) => q.venue)).size > 1;
  const by = new Map<string, { bid: Quote | null; ask: Quote | null }>();
  for (const q of qs) {
    const key = q.symbol + (q.venue != null ? "|" + q.venue : "");
    const e = by.get(key) ?? { bid: null, ask: null };
    if (q.side === "bid" || q.side === "buy") e.bid = q;
    else e.ask = q;
    by.set(key, e);
  }
  const rank = (b: number) => (b >= 3 ? 3 : b === 2 ? 2 : b === 1 ? 1 : 0);
  return [...by.entries()]
    .map(([key, { bid, ask }]) => {
      const q = bid ?? ask!;
      const mid = q.mid ?? null;
      const bp = bid?.working_px ?? null,
        ap = ask?.working_px ?? null;
      const spread = bp != null && ap != null && mid ? ((ap - bp) / mid) * 1e4 : null;
      const depth = (bid?.working_px && bid.working_qty ? bid.working_px * bid.working_qty : 0) + (ask?.working_px && ask.working_qty ? ask.working_px * ask.working_qty : 0);
      const worst = [bid, ask].filter(Boolean).sort((x, y) => rank(y!.block ?? 0) - rank(x!.block ?? 0))[0]!;
      const since = worst.block_since ?? (worst.block_since_ns ? worst.block_since_ns / 1e6 : null);
      const v = q.venue;
      return {
        key,
        venue: named && v != null ? (typeof v === "number" ? (venues?.[v]?.name ?? String(v)) : v) : null,
        symbol: key.split("|")[0]!,
        mid,
        position: q.position ?? null,
        bid,
        ask,
        spread,
        depth: depth || null,
        block: worst.block ?? 0,
        since: worst.block ? since : null,
        why: [worst.reason && worst.reason !== "None" ? words(worst.reason) : null, worst.note].filter(Boolean).join(" · ") || null,
      };
    })
    .sort((a, b) => rank(b.block) - rank(a.block) || a.symbol.localeCompare(b.symbol));
}

function QuoteSide({ q, hide }: { q: Quote | null; hide: boolean }) {
  if (!q) return <span className="muted">--</span>;
  if (q.working_px == null || !q.working_qty) return <span className="muted">{q.desired_px == null ? "--" : price(q.desired_px)}</span>;
  return (
    <>
      {price(q.working_px)}
      <span className="muted"> × {maskText(hide, compact(q.working_qty))}</span>
    </>
  );
}

function QuotesTable({ latest, hide }: { latest: Latest | null; hide: boolean }) {
  const skew = useStore((s) => s.skew);
  const now = useNow(1000) + skew;
  const rows = useMemo(() => quoteRows(latest?.payload?.quotes ?? [], latest?.payload?.venues), [latest]);
  const n = rows.filter((r) => r.block === 0).length;
  return (
    <section className="ops-panel st-quotes">
      <header className="ops-head">
        <span className="ops-title">Quotes</span>
        <span className="ops-count">{rows.length ? `${n} of ${rows.length} quoting both sides` : ""}</span>
      </header>
      <div className="ops-body ops-scroll">
        {rows.length ? (
          <table className="ops-table">
            <thead>
              <tr>
                <th className="l">Symbol</th>
                <th className="l">State</th>
                <th className="l">Why</th>
                <th title="For how long">Since</th>
                <th title="Working bid, price × quantity">Bid</th>
                <th title="Working ask, price × quantity">Ask</th>
                <th title="Working ask − bid over mid, bps">Spread</th>
                <th title={`Working notional both sides, ${cur()}`}>Depth</th>
                <th title="Position, base asset">Position</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.key}>
                  <td className="l">
                    {r.symbol}
                    {r.venue && <span className="ops-perp">{r.venue}</span>}
                  </td>
                  <td className={"l " + (r.block >= 3 ? "warn-text" : r.block > 0 ? "muted" : "")}>{BLOCK[r.block] ?? `Code ${r.block}`}</td>
                  <td className="l muted st-why">{r.why ?? ""}</td>
                  <td className="fig">{r.since != null ? dur(now - r.since) : ""}</td>
                  <td className="fig"><QuoteSide q={r.bid} hide={hide} /></td>
                  <td className="fig"><QuoteSide q={r.ask} hide={hide} /></td>
                  <td className="fig">{r.spread == null ? "--" : num(r.spread, 1)}</td>
                  <td className="fig">{r.depth == null ? "--" : maskText(hide, compact(r.depth))}</td>
                  <td className={"fig" + (hide ? " masked" : (r.position ?? 0) > 0 ? " up" : (r.position ?? 0) < 0 ? " down" : "")}>{r.position == null ? "--" : maskText(hide, num(r.position, 2, true))}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <div className="ops-empty">{latest?.payload?.truncated ? "The last push left the quotes out to stay small" : "The engine sent no quotes"}</div>
        )}
      </div>
    </section>
  );
}

/** A reason's CamelCase name as words: PostOnlyWouldCross → Post only would cross. */
const words = (s: string) => s.replace(/([a-z0-9])([A-Z])/g, "$1 $2").replace(/_/g, " ").replace(/^./, (c) => c.toUpperCase()).replace(/ ([A-Z])(?=[a-z])/g, (_, c: string) => " " + c.toLowerCase());

function RejectList({ title, list }: { title: string; list: Reason[] | undefined }) {
  return (
    <div className="st-rej">
      <div className="ops-l">{title}</div>
      {list?.length ? (
        list.slice(0, 6).map((r) => (
          <div key={r.reason} className="st-rej-row">
            <span title={r.reason}>{words(r.reason)}</span>
            <span className="fig">{int(r.count)}</span>
          </div>
        ))
      ) : (
        <div className="muted">None</div>
      )}
    </div>
  );
}

function Quoting({ latest, error }: { latest: Latest | null; error: string | null }) {
  const hide = useHide();
  const m = useMetrics(latest);
  const { age, stale } = usePush(latest);
  const tz = useStore((s) => s.tz);
  const quoting = useMemo(() => {
    const rows = quoteRows(latest?.payload?.quotes ?? [], latest?.payload?.venues);
    return { n: rows.filter((r) => r.block === 0).length, of: rows.length };
  }, [latest]);
  if (!latest?.payload) return <NoData latest={latest} error={error} />;
  const p = latest.payload;
  const trouble = engineTrouble(p);
  const a = (v: number | null) => (v == null ? "--" : maskText(hide, compact(v)));
  return (
    <div className="ops-tab-body st-quoting">
      <section className="ops-panel st-top">
        <div className="st-state">
          <span className={"st-state-word " + (stale ? "warn-text" : trouble ? "crit-text" : quoting.n < quoting.of ? "" : "up")}>
            {stale ? "No push for " + dur(age) : (trouble ?? `${quoting.n} of ${quoting.of} quoting`)}
          </span>
          {!stale && latest.t != null && <span className="st-state-sub fig">{`pushed ${hms(latest.t, tz)}`}</span>}
        </div>
        <div className="st-figs">
          <Fig label="Sides quoting" title="Sides with a working quote, of the warm ones">
            {mv(m, "sidesQuoting") == null ? "--" : int(mv(m, "sidesQuoting"))}
            {mv(m, "sidesWarm") != null && <span className="ops-unit">of {int(mv(m, "sidesWarm"))}</span>}
          </Fig>
          <Fig label="Budget" title="Clips the pools' balance allows, and those left after the last re-allocation">
            {mv(m, "budget") == null ? "--" : num(mv(m, "budget"), 1)}
            {mv(m, "clipsUnspent") != null && <span className="ops-unit">{`${num(mv(m, "clipsUnspent"), 1)} unspent`}</span>}
          </Fig>
          <Fig label="Clip" title={`One quote's notional; at most ${mv(m, "maxUnits") ?? "--"} clips a side, ${cur()}`}>
            {a(mv(m, "quoteNotional"))}
            {mv(m, "maxUnits") != null && <span className="ops-unit">{`max ${int(mv(m, "maxUnits"))}`}</span>}
          </Fig>
          <Fig label="Pool locked" title="The engine's own booking">{a(mv(m, "poolLocked"))}</Fig>
          <Fig label="Pool free">{a(mv(m, "poolFree"))}</Fig>
          <Fig label="Unwinding" title={`Positions the last requote is unwinding, and how far from fair, ${cur()}`}>
            {a(mv(m, "unwindUsd"))}
            {mv(m, "unwindBp") != null && (mv(m, "unwindUsd") ?? 0) > 0 && <span className="ops-unit">{`${bps(mv(m, "unwindBp"), false)} bps`}</span>}
          </Fig>
        </div>
      </section>
      <QuotesTable latest={latest} hide={hide} />
      <div className="ops-col st-side">
        <CapitalPanel latest={latest} hide={hide} />
        <section className="ops-panel">
          <header className="ops-head">
            <span className="ops-title">Rejects</span>
          </header>
          <div className="st-rejs">
            <RejectList title="Risk" list={p.risk_reject_reasons} />
            <RejectList title="Venue" list={p.venue_reject_reasons} />
          </div>
        </section>
        <CapitalChart hide={hide} />
      </div>
    </div>
  );
}

// ================================ page ================================

export function Strategy() {
  const [tab, setTab] = useExPref<Tab>("strategy", "tab", "hedge", ["hedge", "quoting"]);
  const { latest, error } = useEngineLatest();
  return (
    <div className="page ops-assets st-page">
      <div className="ops-tabbar">
        <Tabs
          value={tab}
          onChange={setTab}
          items={[
            { value: "hedge", label: "Hedge" },
            { value: "quoting", label: "Quoting" },
          ]}
        />
      </div>
      {tab === "hedge" ? <Hedge latest={latest} error={error} /> : <Quoting latest={latest} error={error} />}
    </div>
  );
}
