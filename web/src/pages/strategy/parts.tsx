// What Strategy's desktop and phone pages share, apart from the desktop's own panels: the hedge charts, the quote rows
// and their counts, and how a few figures read. Kept out of Strategy.tsx, which draws Accounts' panels (and so pulls in
// AG Grid), so the phone's Strategy loads none of it.
import { useMemo } from "react";
import { dur, num } from "../../format";
import { C, FUT_COLOR, INV_COLOR } from "../../theme";
import { ExChart, type ExMarker, type ExSeries } from "../../components/ex";
import { amount } from "../../mask";
import { BLOCK, mv, pts, skey, useEngineSeries, type Latest, type Quote, type Rebalance } from "./engine";
import "../ops/ops.css";
import "./strategy.css";
import { cur } from "../../desk";

export const DAY = 86_400_000;

/** The hedge charts hold two days and open on the last one. */
export const SPAN = 2 * DAY;

const HEDGE_KEYS = ["target", "pos", "band", "takerBand", "bw", "invNet", "rebalCount", "rebalT", "takerCount", "trigger", "slipBp", "latencyMs", "paused"] as const;

/** Why the Hedge tab shows the desk's estimate in place of the engine's figures. */
export function deskNote(error: string | null, latest: Latest | null, age: number | null) {
  const why = error
    ? "Could not load the engine's figures"
    : !latest?.payload
      ? "The engine is not pushing its figures yet"
      : `No push from the engine for ${dur(age ?? 0)}`;
  return `${why}: the desk's own exposure and gap, from its accounts (its beta may differ from the engine's).`;
}

/** The engine's hedge figures the charts and the table read. */
export const HEDGE_SERIES = HEDGE_KEYS.map(skey);

export function GapChart({ s, rebal, hide, height }: { s: ReturnType<typeof useEngineSeries>["s"]; rebal: Rebalance[]; hide: boolean; height?: number }) {
  const { series, last24, takerBands } = useMemo(() => {
    const band = s?.v[skey("band")] ?? [];
    const pos = s?.v[skey("pos")] ?? [];
    const tb = s?.v[skey("takerBand")] ?? [];
    // the engine's gap, target − hedge, in bands: it drifts to ±1 as the inventory moves, a rebalance brings it back
    const gap = pts(s, skey("target"), (t, i) => (pos[i] != null && band[i] ? (t - pos[i]!) / band[i]! : null));
    const from = Date.now() - DAY;
    let takerBands: number | null = null;
    for (let i = (s?.t.length ?? 0) - 1; i >= 0; i--)
      if (tb[i] != null && band[i]) {
        takerBands = tb[i]! / band[i]!;
        break;
      }
    const series: ExSeries[] = [
      { key: "gap", kind: "line", label: "Gap", toggle: false, color: C.ink, width: 1.5, format: (v) => num(v, 2, true), data: gap },
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
        title="Hedge gap"
        series={series}
        markers={hide ? [] : markers}
        priceLines={lines}
        toolbarLeft={<span className="ops-chart-title">Gap to target, in bands</span>}
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

export interface QRow {
  key: string;
  venue: string | null;
  symbol: string;
  mid: number | null;
  position: number | null;
  bid: Quote | null;
  ask: Quote | null;
  spread: number | null;
  depth: number | null;
  /** The side that matters: a blocked one first (≥2, or -1), then a quoting one; 1 when neither side is wanted. */
  block: number;
  /** blocked: a side is stopped by something; both / bid / ask: quoting those; idle: the engine wants neither side. */
  kind: "blocked" | "both" | "bid" | "ask" | "idle";
  /** The row's state in words. */
  state: string;
  since: number | null;
  why: string | null;
}

/** A price the engine sent, or null for its 0 (no price). */
export const px = (v: number | null | undefined) => (v != null && v > 0 ? v : null);

const ORDER: Record<QRow["kind"], number> = { blocked: 0, bid: 1, ask: 1, both: 2, idle: 3 };

/** How long a hedge took to fill: milliseconds under a second. */
export const fillTime = (ms: number | null | undefined) =>
  ms == null ? "--" : ms < 1000 ? `${Math.round(ms)} ms` : ms < 10_000 ? `${(ms / 1000).toFixed(1)} s` : dur(ms);

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
  const stopped = (q: Quote | null) => q != null && q.block != null && (q.block >= 2 || q.block < 0);
  const on = (q: Quote | null) => q != null && (q.block ?? 0) === 0;
  return [...by.entries()]
    .map(([key, { bid, ask }]): QRow => {
      const q = bid ?? ask!;
      const mid = q.mid ?? null;
      const bp = on(bid) ? px(bid!.working_px) : null,
        ap = on(ask) ? px(ask!.working_px) : null;
      const spread = bp != null && ap != null && mid ? ((ap - bp) / mid) * 1e4 : null;
      const notional = (x: Quote | null) => (on(x) && px(x!.working_px) && x!.working_qty ? x!.working_px! * x!.working_qty : 0);
      const depth = notional(bid) + notional(ask);
      const bad = [bid, ask].find(stopped) ?? null;
      const kind: QRow["kind"] = bad ? "blocked" : on(bid) && on(ask) ? "both" : on(bid) ? "bid" : on(ask) ? "ask" : "idle";
      const w = bad ?? (on(bid) ? bid : on(ask) ? ask : q)!;
      const since = w.block_since ?? (w.block_since_ns ? w.block_since_ns / 1e6 : null);
      const v = q.venue;
      const block = w.block ?? 0;
      const state = kind === "blocked" ? (BLOCK[block] ?? `Code ${block}`) + (bad === bid ? ", bid" : ", ask") : kind === "both" ? "Quoting" : kind === "bid" ? "Bid only" : kind === "ask" ? "Ask only" : "Idle";
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
        block,
        kind,
        state,
        since: kind === "blocked" ? since : null,
        why: bad ? [bad.reason && bad.reason !== "None" ? words(bad.reason) : null, bad.note].filter(Boolean).join(" · ") || null : null,
      };
    })
    .sort((a, b) => ORDER[a.kind] - ORDER[b.kind] || a.symbol.localeCompare(b.symbol));
}

/** Working sides the allocator gave no clip: the orders unwinding inventory held. */
export function unwindCount(latest: Latest | null, m: Record<string, number>) {
  const working = (latest?.payload?.quotes ?? []).filter((q) => (q.block ?? 0) === 0).length;
  const clip = mv(m, "sidesQuoting");
  return clip == null ? 0 : Math.max(0, working - clip);
}

/** The rows in a line: how many quote both sides, one side, are stopped and idle. */
export function quoteCounts(rows: QRow[]) {
  const c = { both: 0, one: 0, blocked: 0, idle: 0 };
  for (const r of rows) r.kind === "both" ? c.both++ : r.kind === "blocked" ? c.blocked++ : r.kind === "idle" ? c.idle++ : c.one++;
  return c;
}

/** A reason's CamelCase name as words: PostOnlyWouldCross → Post only would cross. */
export const words = (s: string) => s.replace(/([a-z0-9])([A-Z])/g, "$1 $2").replace(/_/g, " ").replace(/^./, (c) => c.toUpperCase()).replace(/ ([A-Z])(?=[a-z])/g, (_, c: string) => " " + c.toLowerCase());
