// The engine's pushed figures, simulated for the demo (VITE_MOCK): two days of 15 s samples of a hedge that
// follows a beta-weighted inventory within its band, and a quoting table. Shapes as server telemetry.rs answers.
import { M } from "./pages/strategy/engine";

const STEP = 15_000;
const SPAN = 2 * 86_400_000;
const ACCOUNTS = ["mm1", "mm2", "mm3", "mm4"];
const SYMBOLS = ["NVDAUSDT", "TSLAUSDT", "AAPLUSDT", "MSFTUSDT", "AMZNUSDT", "METAUSDT", "GOOGLUSDT", "AMDUSDT", "COINUSDT", "MSTRUSDT", "PLTRUSDT", "CRMUSDT", "PYPLUSDT", "ZMBUSDT"];

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
    taker = 0,
    trig = 0,
    slip = 1.2,
    lat = 2400;
  let chase = 0; // samples left for a maker hedge to fill
  const free = ACCOUNTS.map(() => 9000 + r() * 4000);
  const locked = ACCOUNTS.map(() => 3000 + r() * 2000);
  for (let x = t0; x <= now; x += STEP) {
    const hour = new Date(x).getUTCHours();
    const us = hour >= 13 && hour < 21;
    // inventory: a walk, faster in US hours
    inv += (r() - 0.5) * (us ? 260 : 90) - (inv - 3500) * 0.002;
    beta += (r() - 0.5) * 0.004 - (beta - 0.33) * 0.01;
    const bw = inv * beta;
    const band = Math.max(600, 0.4 * Math.abs(bw));
    const want = -bw;
    const paused = new Date(x).getUTCDay() === 6 ? 1 : 0;
    if (!paused && Math.abs(want - target) > band) {
      const isTaker = Math.abs(want - target) > 3 * band;
      target = Math.round(want / 10) * 10;
      count++;
      if (isTaker) taker++;
      trig = isTaker ? 1 : 0;
      chase = isTaker ? 1 : 2 + Math.floor(r() * 6);
      slip = slip * 0.8 + (isTaker ? 4 + r() * 4 : -0.5 + r() * 2) * 0.2;
      lat = lat * 0.8 + (isTaker ? 300 + r() * 400 : 15_000 + r() * 60_000) * 0.2;
    }
    if (chase > 0 && --chase === 0) pos = target;
    for (let i = 0; i < ACCOUNTS.length; i++) {
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
    m("makerCount", count - taker);
    m("takerCount", taker);
    m("trigger", trig);
    m("paused", paused);
    m("pauseReason", paused ? 2 : 0);
    m("slipBp", slip);
    m("latencyMs", lat);
    m("sidesWarm", 28);
    m("sidesQuoting", us ? 24 + Math.floor(r() * 3) : 18 + Math.floor(r() * 4));
    m("clipsUnspent", Math.floor(r() * 4));
    m("budget", 40_000);
    m("poolFree", free.reduce((a, b) => a + b, 0));
    m("poolLocked", locked.reduce((a, b) => a + b, 0));
    m("quoteNotional", locked.reduce((a, b) => a + b, 0) * 0.92);
    m("maxUnits", 8);
    ACCOUNTS.forEach((a, i) => {
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
  const balances = ACCOUNTS.map((a) => ({ account: a, asset: "USDT", free: f[`balances.${a}.USDT.free`]!, locked: f[`balances.${a}.USDT.locked`]! }));
  const now = Date.now();
  const quotes = SYMBOLS.flatMap((symbol, i) => {
    const mid = 40 + i * 37.3 + r() * 2;
    const blockOf = (side: number) => (i === 13 ? 5 : i === 12 ? 7 : i === 11 && side === 1 ? 1 : i === 10 && side === 0 ? 8 : 0);
    return [0, 1].map((side) => {
      const block = blockOf(side);
      const half = mid * (4 + i * 0.6 + r()) * 1e-4;
      const px = side === 0 ? mid - half : mid + half;
      const qty = Math.round((800 + r() * 1500) / mid * 100) / 100;
      return {
        symbol,
        side: side === 0 ? "bid" : "ask",
        desired_px: px,
        desired_qty: qty,
        desired_levels: 3,
        working_px: block === 0 ? px : null,
        working_qty: block === 0 ? qty * (0.6 + r() * 0.4) : 0,
        working_orders: block === 0 ? 3 : 0,
        block,
        reason: block === 8 ? "PostOnlyWouldCross" : null,
        note: block === 7 ? "budget 0 / 1200" : block === 1 ? "inventory cap" : null,
        block_since: block === 0 ? null : now - (60_000 + i * 45_000),
        position: Math.round((r() - 0.3) * 3000 / mid * 100) / 100,
        mid,
      };
    });
  });
  return {
    t: b.t[b.t.length - 1],
    now,
    payload: {
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
      kill: { active: false },
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
