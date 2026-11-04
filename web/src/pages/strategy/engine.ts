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
  unwindUsd: "unwind_usd",
  unwindBp: "unwind_bp",
} as const;
export type MKey = keyof typeof M;

/** What a rebalance's trigger code means (anchor_mm-metrics.md `rebal_trigger`). */
export const TRIGGER: Record<number, string> = {
  1: "Band",
  2: "Taker band",
  3: "Maker timeout",
  4: "Band",
  5: "Window close",
  6: "Window close, taker",
};
/** Codes of a taker (IOC) order. */
export const TAKER_TRIGGERS = new Set([2, 3, 4, 6]);
/** Why the hedge is not traded (`hedge_pause_reason`; 0 hedging). */
export const PAUSE: Record<number, string> = {
  1: "Warming up",
  2: "No hedge book",
  3: "Hedge book stale",
  4: "No-hedge window",
  5: "No hedge set",
};
/** A quote's first obstacle (status-file.md `block`). */
export const BLOCK: Record<number, string> = {
  [-1]: "Unknown",
  0: "Quoting",
  1: "Not wanted",
  2: "Quoting off",
  3: "Pulled",
  4: "Venue killed",
  5: "Feed lag",
  6: "Backoff",
  7: "Starved",
  8: "Refused",
  9: "Pending",
};

export interface Quote {
  symbol: string;
  /** Index into the payload's venues. */
  venue?: number | string;
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
  schema?: string;
  t_ns?: number;
  /** false: the engine's status file was unreadable (only `error` with it). */
  ok?: boolean;
  error?: string;
  /** The quotes were left out to keep the push small. */
  truncated?: boolean;
  engine?: { name?: string; state?: string; running?: boolean; session_id?: number | string };
  metrics?: Record<string, number> | { name: string; value: number }[];
  /** By account then asset (an array of rows also read). */
  balances?: Record<string, Record<string, { free?: number; locked?: number }>> | Balance[];
  quotes?: Quote[];
  venues?: { name: string; order?: string; killed?: boolean; kill_reason?: string }[];
  risk_reject_reasons?: Reason[];
  venue_reject_reasons?: Reason[];
  kill?: { flags?: number; reason?: string; latched?: boolean; flatten_state?: string; flattening?: boolean };
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
  /** Rebalances decided in this sample (0: an IOC that took over one already started). */
  n: number;
  taker: boolean | null;
  trigger: string | null;
  target: number | null;
  prevTarget: number | null;
  pos: number | null;
  slip: number | null;
  latency: number | null;
}

/**
 * Rebalances read off the samples: each sample where `rebal_count` went up (a new one, at `rebal_t`), or where only
 * `rebal_taker` did (an IOC taking over one already started: past the taker band or the maker timeout). A drop of
 * either is the engine restarting.
 */
export function rebalances(s: Series | null): Rebalance[] {
  if (!s) return [];
  const col = (k: MKey) => s.v[skey(k)] ?? [];
  const cnt = col("rebalCount"),
    at = col("rebalT"),
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
    const c = cnt[i],
      t = tk[i];
    if (c == null) continue;
    const more = last != null && c > last ? c - last : 0;
    const tookOver = t != null && lastTaker != null && t > lastTaker;
    if (more > 0 || tookOver) {
      const code = trig[i];
      const when = more > 0 && at[i] != null && at[i]! > s.t[i]! - 120_000 && at[i]! <= s.t[i]! + 60_000 ? at[i]! : s.t[i]!;
      out.push({
        t: when,
        n: more,
        taker: code != null ? TAKER_TRIGGERS.has(code) : t != null && lastTaker != null ? tookOver : null,
        trigger: code == null || code === 0 ? null : (TRIGGER[code] ?? `Code ${code}`),
        target: tgt[i] ?? null,
        prevTarget: lastTarget,
        pos: pos[i] ?? null,
        slip: slip[i] ?? null,
        latency: lat[i] ?? null,
      });
    }
    last = c;
    if (t != null) lastTaker = t;
    if (tgt[i] != null) lastTarget = tgt[i]!;
  }
  // two in one sample, or a restart's clock: keep them in time order, one row per time
  out.sort((x, y) => x.t - y.t);
  return out.filter((r, i) => i === 0 || r.t !== out[i - 1]!.t);
}

/** The balances by account (USD-like assets summed: what the pools quote with). */
export function capital(p: Payload | null | undefined): { account: string; free: number; locked: number }[] {
  const by = new Map<string, { account: string; free: number; locked: number }>();
  const add = (account: string, asset: string, free: number | undefined, locked: number | undefined) => {
    if (!/^(USDT|USDC|FDUSD|USD)$/.test(asset)) return;
    const r = by.get(account) ?? { account, free: 0, locked: 0 };
    r.free += free || 0;
    r.locked += locked || 0;
    by.set(account, r);
  };
  const b = p?.balances;
  if (Array.isArray(b)) for (const x of b) add(x.account, x.asset, x.free, x.locked);
  else if (b) for (const [acct, assets] of Object.entries(b)) for (const [asset, x] of Object.entries(assets ?? {})) add(acct, asset, x?.free, x?.locked);
  return [...by.values()].sort((a, b) => a.account.localeCompare(b.account));
}

/** What stops the engine as a whole, if anything: unreadable status, a kill, a flatten. */
export function engineTrouble(p: Payload | null | undefined): string | null {
  if (!p) return null;
  if (p.ok === false) return "Engine status unreadable" + (p.error ? `: ${p.error}` : "");
  const k = p.kill;
  if (k?.flattening || (k?.flatten_state && k.flatten_state !== "Off")) return `Flatten ${k.flatten_state ?? "working"}` + (k.reason ? `: ${k.reason}` : "");
  if (k?.latched || (k?.flags ?? 0) !== 0) return "Killed" + (k?.reason ? `: ${k.reason}` : "");
  if (p.engine?.running === false) return `Engine ${p.engine.state ?? "stopped"}`;
  return null;
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
  const pause = PAUSE[mv(m, "pauseReason") ?? 0] ?? (mv(m, "pauseReason") ? `code ${mv(m, "pauseReason")}` : "");
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
