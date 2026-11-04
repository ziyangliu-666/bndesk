// The engine's pushed figures, simulated for the demo (VITE_MOCK): two days of 15 s samples of a hedge that
// follows a beta-weighted inventory within its band, and a quoting table. Shapes as server telemetry.rs answers.
import { M } from "./pages/strategy/engine";
import { useStore } from "./store";

const STEP = 15_000;
const SPAN = 2 * 86_400_000;
// the demo desk's own accounts and instruments, so every page names the same ones
const ACCOUNTS = () => {
  const a = useStore.getState().snap?.accounts ?? [];
  const subs = a.filter((x) => x.role === "sub").map((x) => x.id);
  return subs.length ? subs : a.length ? a.map((x) => x.id) : ["sub-a", "sub-b"];
};
const SYMBOLS = (): { symbol: string; mid: number; qty: number }[] => {
  const seen = new Set<string>();
  const out: { symbol: string; mid: number; qty: number }[] = [];
  for (const r of useStore.getState().snap?.symbols ?? []) {
    if (r.venue !== "spot" || seen.has(r.symbol) || r.mid == null) continue;
    seen.add(r.symbol);
    out.push({ symbol: r.symbol, mid: r.mid, qty: r.inv_qty });
  }
  return out.slice(0, 16);
};

function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

interface Built {
  t0: number;
  t: number[];
  flat: Record<string, number>[];
}
let built: Built | null = null;

function build(): Built {
  const now = Math.floor(Date.now() / STEP) * STEP;
  if (built && now - built.t[built.t.length - 1]! < STEP) return built;
  const r = rng(7);
  const t0 = now - SPAN;
  const t: number[] = [];
  const flat: Record<string, number>[] = [];
  let inv = 4200;
  let beta = 0.34;
  let target = -inv * beta;
  let pos = target;
  let count = 0,
    rebalT = 0,
    taker = 0,
    trig = 0,
    slip = 1.2,
    lat = 2400;
  let chase = 0; // samples left for a maker hedge to fill
  const accts = ACCOUNTS();
  const free = accts.map(() => 9000 + r() * 4000);
  const locked = accts.map(() => 3000 + r() * 2000);
  for (let x = t0; x <= now; x += STEP) {
    const hour = new Date(x).getUTCHours();
    const us = hour >= 13 && hour < 21;
    // inventory: a walk, faster in US hours
    inv += (r() - 0.5) * (us ? 260 : 90) - (inv - 3500) * 0.002;
    beta += (r() - 0.5) * 0.004 - (beta - 0.33) * 0.01;
    const bw = inv * beta;
    const paused = new Date(x).getUTCDay() === 6 ? 1 : 0;
    // as anchor_mm: the target follows the beta-weighted inventory every step (clamped), the hedge only moves when
    // a rebalance fills; one starts once the hedge is a band from its target
    target = paused ? 0 : Math.max(-10_000, Math.min(10_000, -bw));
    const band = Math.max(600, 0.4 * Math.abs(target));
    if (!paused && chase === 0 && Math.abs(target - pos) >= band) {
      const isTaker = Math.abs(target - pos) >= 3 * band;
      count++;
      rebalT = x - Math.floor(r() * STEP);
      if (isTaker) taker++;
      trig = isTaker ? 2 : 1;
      chase = isTaker ? 1 : 2 + Math.floor(r() * 6);
      slip = slip * 0.8 + (isTaker ? 4 + r() * 4 : -0.5 + r() * 2) * 0.2;
      lat = lat * 0.8 + (isTaker ? 300 + r() * 400 : 15_000 + r() * 60_000) * 0.2;
    }
    if (chase > 0 && --chase === 0) pos = Math.round(target / 10) * 10;
    for (let i = 0; i < accts.length; i++) {
      const d = (r() - 0.5) * 300;
      locked[i] = Math.max(500, Math.min(8000, locked[i]! + d));
      free[i] = Math.max(200, free[i]! - d);
    }
    const f: Record<string, number> = {};
    const m = (k: keyof typeof M, v: number) => (f["metrics." + M[k]] = v);
    m("target", target);
    m("pos", pos);
    m("band", band);
    m("takerBand", 3 * band);
    m("bw", bw);
    m("invNet", inv);
    m("invGross", Math.abs(inv) * 1.7 + 2000);
    m("beta", beta);
    m("baseShort", 0);
    m("rebalCount", count);
    m("rebalT", rebalT);
    m("makerCount", count - taker);
    m("takerCount", taker);
    m("trigger", trig);
    m("paused", paused);
    m("pauseReason", paused ? 4 : 0);
    m("slipBp", slip);
    m("latencyMs", lat);
    m("unwindUsd", us ? 400 + r() * 300 : 0);
    m("unwindBp", 6 + r() * 4);
    m("sidesWarm", 28);
    m("sidesQuoting", us ? 24 + Math.floor(r() * 3) : 18 + Math.floor(r() * 4));
    m("clipsUnspent", Math.floor(r() * 4));
    m("budget", 34);
    m("poolFree", free.reduce((a, b) => a + b, 0));
    m("poolLocked", locked.reduce((a, b) => a + b, 0));
    m("quoteNotional", 500);
    m("maxUnits", 8);
    accts.forEach((a, i) => {
      f[`balances.${a}.USDT.free`] = free[i]!;
      f[`balances.${a}.USDT.locked`] = locked[i]!;
    });
    t.push(x);
    flat.push(f);
  }
  return (built = { t0, t, flat });
}

function latest() {
  const b = build();
  const f = b.flat[b.flat.length - 1]!;
  const r = rng(Math.floor(Date.now() / 60_000));
  const metrics = Object.entries(f)
    .filter(([k]) => k.startsWith("metrics."))
    .map(([k, v]) => ({ name: k.slice(8), value: v }));
  const balances = Object.fromEntries(ACCOUNTS().map((a) => [a, { USDT: { free: f[`balances.${a}.USDT.free`]!, locked: f[`balances.${a}.USDT.locked`]! } }]));
  const now = Date.now();
  const syms = SYMBOLS();
  const n = syms.length;
  const quotes = syms.flatMap(({ symbol, mid, qty: held }, i) => {
    const blockOf = (side: number) => (i === n - 1 ? 5 : i === n - 2 ? 7 : i === n - 3 && side === 1 ? 1 : i === n - 4 && side === 0 ? 8 : 0);
    return [0, 1].map((side) => {
      const block = blockOf(side);
      const half = mid * (4 + i * 0.6 + r()) * 1e-4;
      const px = side === 0 ? mid - half : mid + half;
      const qty = (800 + r() * 1500) / mid;
      return {
        symbol,
        venue: 0,
        side: side === 0 ? "buy" : "sell",
        desired_px: px,
        desired_qty: qty,
        desired_levels: 3,
        working_px: block === 0 ? px : null,
        working_qty: block === 0 ? qty * (0.6 + r() * 0.4) : 0,
        working_orders: block === 0 ? 3 : 0,
        block,
        reason: block === 8 ? "PostOnlyWouldCross" : "None",
        note: "",
        block_since_ns: block === 0 ? 0 : (now - (60_000 + i * 45_000)) * 1e6,
        position: held,
        mid,
      };
    });
  });
  // the sides as the quotes show them
  const sides = metrics.find((x) => x.name === M.sidesQuoting);
  if (sides) sides.value = quotes.filter((q) => q.block === 0).length;
  const warm = metrics.find((x) => x.name === M.sidesWarm);
  if (warm) warm.value = quotes.filter((q) => q.block !== 1).length;
  return {
    t: b.t[b.t.length - 1],
    now,
    payload: {
      schema: "bndesk-anchor/1",
      ok: true,
      engine: { name: "anchor-live", state: "running", running: true },
      venues: [{ name: "binance", order: "live", killed: false }],
      kill: { flags: 0, reason: "", latched: false, flatten_state: "Off", flattening: false },
      metrics,
      balances,
      quotes,
      risk_reject_reasons: [
        { reason: "MaxPosition", count: 41 },
        { reason: "RateLimit", count: 12 },
      ],
      venue_reject_reasons: [
        { reason: "PostOnlyWouldCross", count: 230 },
        { reason: "InsufficientBalance", count: 7 },
      ],
    },
  };
}

function series(params: Record<string, string | number>) {
  const b = build();
  const keys = String(params.keys).split(",");
  const to = Number(params.to ?? Date.now());
  const from = Number(params.from ?? to - 86_400_000);
  const step = Math.max(Number(params.step ?? 0) * 1000, Math.floor((to - from) / 4000));
  const out: { t: number[]; v: Record<string, (number | null)[]> } = { t: [], v: {} };
  const match = (k: string) => keys.some((p) => (p.endsWith("*") ? k.startsWith(p.slice(0, -1)) : k === p));
  const cols = Object.keys(b.flat[0]!).filter(match);
  for (const k of cols) out.v[k] = [];
  let bucket = NaN;
  for (let i = 0; i < b.t.length; i++) {
    const t = b.t[i]!;
    if (t < from || t > to) continue;
    const bk = step > 0 ? Math.floor(t / step) : t;
    // the last in each bucket
    if (bk === bucket) {
      out.t.pop();
      for (const k of cols) out.v[k]!.pop();
    }
    bucket = bk;
    out.t.push(t);
    for (const k of cols) out.v[k]!.push(b.flat[i]![k] ?? null);
  }
  return out;
}

export function engineMock(path: string, params: Record<string, string | number>): unknown {
  if (path === "/api/engine/latest") return latest();
  if (path === "/api/engine/series") return series(params);
  throw new Error("404 " + path);
}
