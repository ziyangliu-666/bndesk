// The trading engine's own figures, as its box pushes them to the desk every 15 s (server telemetry.rs):
// /api/engine/latest (the last payload, whole) and /api/engine/series (numbers over time, flattened as
// "metrics.<name>", "balances.<account>.<asset>.free", ...). The names below are the engine's; a figure the engine
// does not publish is null and its view says nothing, never an error.
import { useEffect, useMemo, useState } from "react";
import { getJSON } from "../../api";

/** The engine's metric names, in one place (FastMM anchor_mm, ctx.metric). */
export const M = {
  target: "hedge_target",
  pos: "hedge_pos",
  band: "hedge_band",
  takerBand: "hedge_taker_band",
  bw: "hedge_bw",
  invGross: "inv_gross",
  invNet: "inv_net",
  beta: "beta",
  baseShort: "base_short",
  rebalCount: "rebal_count",
  rebalT: "rebal_t",
  trigger: "rebal_trigger",
  makerCount: "rebal_maker",
  takerCount: "rebal_taker",
  paused: "hedge_paused",
  pauseReason: "hedge_pause_reason",
  slipBp: "hedge_slip_bp",
  latencyMs: "hedge_fill_ms",
  sidesWarm: "sides_warm",
  sidesQuoting: "sides_quoting",
  clipsUnspent: "clips_unspent",
  budget: "budget",
  poolFree: "pool_free",
  poolLocked: "pool_locked",
  quoteNotional: "quote_notional",
  maxUnits: "max_units",
} as const;
export type MKey = keyof typeof M;

/** What a rebalance's trigger code means. */
export const TRIGGER: Record<number, string> = { 0: "Band", 1: "Taker band", 2: "Close", 3: "Pause", 4: "Resume", 5: "Manual" };
/** Why a pause is on. */
export const PAUSE: Record<number, string> = { 0: "", 1: "Market closed", 2: "Weekend", 3: "Daily window", 4: "Manual" };
/** A quote's first obstacle (status-file.md `block`). */
export const BLOCK: Record<number, string> = {
  0: "Quoting",
  1: "Not wanted",
  2: "Quoting off",
  3: "Cancelled",
  4: "Venue tripped",
  5: "Data late",
  6: "Backing off",
  7: "Starved",
  8: "Rejected",
  9: "Pending",
};

export interface Quote {
  symbol: string;
  venue?: string;
  side: "bid" | "ask" | "buy" | "sell" | string;
  desired_px?: number | null;
  desired_qty?: number | null;
  desired_levels?: number | null;
  working_px?: number | null;
  working_qty?: number | null;
  working_orders?: number | null;
  block?: number | null;
  reason?: string | null;
  note?: string | null;
  block_since_ns?: number | null;
  block_since?: number | null;
  position?: number | null;
  mid?: number | null;
}
export interface Balance {
  account: string;
  asset: string;
  free: number;
  locked: number;
}
export interface Reason {
  reason: string;
  count: number;
}
export interface Payload {
  metrics?: Record<string, number> | { name: string; value: number }[];
  balances?: Balance[];
  quotes?: Quote[];
  risk_reject_reasons?: Reason[];
  venue_reject_reasons?: Reason[];
  kill?: { active?: boolean; reason?: string } | boolean;
  [k: string]: unknown;
}
export interface Latest {
  /** When the desk received it (ms); null: nothing yet. */
  t: number | null;
  now: number;
  payload: Payload | null;
}
export interface Series {
  t: number[];
  v: Record<string, (number | null)[]>;
}

/** The payload's metrics as a map, whichever shape the engine sends. */
export function metrics(p: Payload | null | undefined): Record<string, number> {
  const m = p?.metrics;
  if (!m) return {};
  if (Array.isArray(m)) return Object.fromEntries(m.map((x) => [x.name, x.value]));
  return m;
}
export const mv = (m: Record<string, number>, k: MKey): number | null => {
  const v = m[M[k]];
  return typeof v === "number" && Number.isFinite(v) ? v : null;
};
export const skey = (k: MKey) => "metrics." + M[k];

/** A push older than this is stale (three missed). */
export const STALE_MS = 50_000;

/** The last payload, again every 15 s. */
export function useEngineLatest(): { latest: Latest | null; error: string | null } {
  const [latest, setLatest] = useState<Latest | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    let timer: ReturnType<typeof setTimeout>;
    const load = async () => {
      try {
        const r = await getJSON<Latest>("/api/engine/latest", {});
        if (live) setLatest(r), setError(null);
      } catch (e) {
        if (live) setError(String(e));
      }
      if (live) timer = setTimeout(load, 15_000);
    };
    void load();
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, []);
  return { latest, error };
}

/** `keys` over the last `spanMs`, again every minute. */
export function useEngineSeries(keys: string[], spanMs: number): { s: Series | null; error: string | null } {
  const [s, setS] = useState<Series | null>(null);
  const [error, setError] = useState<string | null>(null);
  const k = keys.join(",");
  useEffect(() => {
    let live = true;
    let timer: ReturnType<typeof setTimeout>;
    const load = async () => {
      const to = Date.now();
      try {
        const r = await getJSON<Series>("/api/engine/series", { keys: k, from: to - spanMs, to });
        if (live) setS(r), setError(null);
      } catch (e) {
        if (live) setError(String(e));
      }
      if (live) timer = setTimeout(load, 60_000);
    };
    void load();
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [k, spanMs]);
  return { s, error };
}

/** One series as chart points (nulls left out; a gap of more than `gapMs` breaks the line with a null point). */
export function pts(s: Series | null, key: string, f: (v: number, i: number) => number | null = (v) => v, gapMs = 120_000): { time: number; value: number | null }[] {
  const col = s?.v[key];
  if (!s || !col) return [];
  const out: { time: number; value: number | null }[] = [];
  let prev = -Infinity;
  for (let i = 0; i < s.t.length; i++) {
    const v = col[i];
    if (v == null) continue;
    const t = s.t[i]!;
    if (t - prev > gapMs && out.length) out.push({ time: prev + 1, value: null });
    const x = f(v, i);
    out.push({ time: t, value: x });
    prev = t;
  }
  return out;
}

export interface Rebalance {
  t: number;
  /** Rebalances in this sample (more than one when they came within one push). */
  n: number;
  taker: boolean | null;
  trigger: string | null;
  target: number | null;
  prevTarget: number | null;
  pos: number | null;
  slip: number | null;
  latency: number | null;
}

/** Rebalances read off the samples: each sample where the count went up (a drop is the engine restarting). */
export function rebalances(s: Series | null): Rebalance[] {
  if (!s) return [];
  const col = (k: MKey) => s.v[skey(k)] ?? [];
  const cnt = col("rebalCount"),
    tk = col("takerCount"),
    trig = col("trigger"),
    tgt = col("target"),
    pos = col("pos"),
    slip = col("slipBp"),
    lat = col("latencyMs");
  const out: Rebalance[] = [];
  let last: number | null = null;
  let lastTaker: number | null = null;
  let lastTarget: number | null = null;
  for (let i = 0; i < s.t.length; i++) {
    const c = cnt[i];
    if (c == null) continue;
    if (last != null && c > last) {
      const t = tk[i];
      const code = trig[i];
      out.push({
        t: s.t[i]!,
        n: c - last,
        taker: t != null && lastTaker != null ? t > lastTaker : null,
        trigger: code == null ? null : (TRIGGER[code] ?? `Code ${code}`),
        target: tgt[i] ?? null,
        prevTarget: lastTarget,
        pos: pos[i] ?? null,
        slip: slip[i] ?? null,
        latency: lat[i] ?? null,
      });
    }
    last = c;
    if (tk[i] != null) lastTaker = tk[i]!;
    if (tgt[i] != null) lastTarget = tgt[i]!;
  }
  return out;
}

/** The balances by account (USDT-like assets summed: what the pools quote with). */
export function capital(p: Payload | null | undefined): { account: string; free: number; locked: number }[] {
  const by = new Map<string, { account: string; free: number; locked: number }>();
  for (const b of p?.balances ?? []) {
    if (!/^(USDT|USDC|FDUSD|USD)$/.test(b.asset)) continue;
    const r = by.get(b.account) ?? { account: b.account, free: 0, locked: 0 };
    r.free += b.free || 0;
    r.locked += b.locked || 0;
    by.set(b.account, r);
  }
  return [...by.values()].sort((a, b) => a.account.localeCompare(b.account));
}

export function useMetrics(latest: Latest | null) {
  return useMemo(() => metrics(latest?.payload), [latest]);
}

/**
 * The hedge's state now. `unhedged`: the beta-weighted inventory the hedge does not offset (bw + hedge; the hedge
 * is short, negative), what the band is measured on; `behind`: the target the hedge has not reached yet
 * (target − hedge: a rebalance still filling).
 */
export function hedgeState(m: Record<string, number>, stale: boolean, age: number | null, dur: (ms: number | null) => string) {
  const target = mv(m, "target"),
    pos = mv(m, "pos"),
    bw = mv(m, "bw"),
    band = mv(m, "band"),
    tb = mv(m, "takerBand");
  const paused = (mv(m, "paused") ?? 0) > 0;
  const unhedged = bw != null && pos != null ? bw + pos : null;
  const behind = target != null && pos != null ? target - pos : null;
  const inBands = unhedged != null && band ? unhedged / band : null;
  const filling = behind != null && band != null && Math.abs(behind) > 0.1 * band;
  const pause = PAUSE[mv(m, "pauseReason") ?? 0];
  const [word, tone] = stale
    ? ["No push for " + dur(age), "warn-text"]
    : paused
      ? ["Paused" + (pause ? `: ${pause}` : ""), "muted"]
      : unhedged == null || band == null
        ? ["--", ""]
        : tb != null && Math.abs(unhedged) > tb
          ? ["Past the taker band", "crit-text"]
          : filling
            ? ["Rebalancing", "warn-text"]
            : Math.abs(unhedged) > band
              ? ["Outside the band", "warn-text"]
              : ["Within the band", "up"];
  return { unhedged, behind, inBands, word, tone, band, takerBand: tb };
}
