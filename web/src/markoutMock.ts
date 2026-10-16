// Mock /api/markouts (VITE_MOCK=1): today's fills (historyMock's tape, the live mock's own where it reaches), each
// given a price path around it, then read the way the server's markouts.rs does. The path: the price drifted into
// our quote before the fill (a maker's normal case), a mild adverse drift after it, a sub-second pick-off on some
// names, and a random walk on top, part of it the reference's (market) move. Thin names get wide error bands from
// their few fills alone.
import type { MarkoutDist, MarkoutLine, MarkoutReport, Venue } from "./protocol";

export const PATH_S = [-10, -5, -2, -1, -0.5, 0, 0.2, 0.5, 1, 2, 5, 10, 20, 30, 60, 120, 300];
const N = PATH_S.length;
const J0 = 5; // 0 s
const J_FAST = 6; // 0.2 s
const J_TAU = 8; // 1 s
const J_M5 = 1; // −5 s
const J10 = 11;
const J60 = 14;
const BUCKET = 900_000;

export interface MkFill {
  t: number;
  symbol: string;
  venue: Venue;
  side: "buy" | "sell";
  notional: number;
  account: string;
}

function hash(a: number, b: number): number {
  let h = (Math.imul(a | 0, 0x9e3779b1) ^ Math.imul(b | 0, 0x85ebca77)) >>> 0;
  h = Math.imul(h ^ (h >>> 16), 0x7feb352d) >>> 0;
  h = Math.imul(h ^ (h >>> 15), 0x846ca68b) >>> 0;
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}
function gauss(a: number, b: number): number {
  const u = Math.max(1e-9, hash(a, b));
  const v = hash(b, a + 7);
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}
const strSeed = (s: string) => [...s].reduce((h, c) => Math.imul(h ^ c.charCodeAt(0), 16777619) >>> 0, 2166136261);

/** A name's character: its edge, how far price runs into our quotes, how much keeps going after, pick-offs. */
interface Char {
  edge: number;
  pre: number;
  adv: number;
  jump: number;
  vol: number;
  skew: number;
}
const chars = new Map<string, Char>();
function charOf(symbol: string, venue: Venue): Char {
  const k = venue + ":" + symbol;
  let c = chars.get(k);
  if (!c) {
    const s = strSeed(k);
    const r = (i: number) => hash(s, 900 + i);
    c =
      venue === "usdm"
        ? { edge: -0.4 + r(1) * 0.6, pre: 0.3, adv: 0.2 + r(2) * 0.6, jump: 0, vol: 0.7 + r(3) * 0.4, skew: 0 }
        : {
            edge: 1.1 + r(1) * 1.4,
            pre: 1.0 + r(2) * 2.2,
            // most names keep some of their edge; a few are picked off and lose it
            adv: r(4) < 0.22 ? 2.6 + r(5) * 2.4 : 0.7 + r(5) * 1.3,
            jump: r(6) < 0.3 ? 0.5 + r(7) * 1.0 : r(7) * 0.3,
            vol: 0.6 + r(3) * 1.3,
            // the side the drift after the fill hurts more (the day's trend): sells, on most names today
            skew: 0.25 + (r(8) - 0.5) * 0.7,
          };
    chars.set(k, c);
  }
  return c;
}

/** Per fill: edge, then raw / net τ 1 s / net τ 0.2 s / D(h) at each path horizon (NaN where there is none). */
const cache = new Map<string, Float32Array>();
function pathOf(f: MkFill): Float32Array {
  const key = `${f.venue}:${f.symbol}:${f.t}:${f.side}:${f.notional.toFixed(4)}`;
  let a = cache.get(key);
  if (a) return a;
  const c = charOf(f.symbol, f.venue);
  const s0 = (f.t % 2_147_483_647) ^ strSeed(f.symbol);
  const g = (i: number) => gauss(s0, i);
  const sig = 0.9 * c.vol;
  // two random walks out from the fill each way: the market's (the reference) and the name's own
  const F = new Float64Array(N);
  const I = new Float64Array(N);
  for (let j = J0 + 1; j < N; j++) {
    const dt = PATH_S[j]! - PATH_S[j - 1]!;
    F[j] = F[j - 1]! + g(j) * sig * Math.sqrt(0.6 * dt);
    I[j] = I[j - 1]! + g(40 + j) * sig * Math.sqrt(0.4 * dt);
  }
  for (let j = J0 - 1; j >= 0; j--) {
    const dt = PATH_S[j + 1]! - PATH_S[j]!;
    F[j] = F[j + 1]! + g(j) * sig * Math.sqrt(0.6 * dt);
    I[j] = I[j + 1]! + g(40 + j) * sig * Math.sqrt(0.4 * dt);
  }
  const edge = c.edge + g(80) * 1.1;
  const run = c.pre * (0.6 + 0.8 * hash(s0, 81));
  const adv = c.adv * (1 + (f.side === "sell" ? c.skew : -c.skew));
  const mean = (h: number) => (h < 0 ? run * (1 - Math.exp(h / 3)) : -adv * (1 - Math.exp(-h / 12)) - c.jump * (1 - Math.exp(-h / 0.3)));
  // the market's share of the move: half the adverse drift, a little of the run-in
  const mkt = (h: number) => (h < 0 ? 0.4 : 0.5) * mean(h);
  const rm = new Float64Array(N);
  for (let j = 0; j < N; j++) rm[j] = mkt(PATH_S[j]!) + F[j]!;
  a = new Float32Array(1 + 4 * N);
  a[0] = edge;
  const hasRef = f.venue === "spot";
  for (let j = 0; j < N; j++) {
    const raw = edge * 0.92 + mean(PATH_S[j]!) + F[j]! + I[j]!;
    a[1 + j] = raw;
    a[1 + N + j] = hasRef ? raw - (rm[j]! - rm[J_TAU]!) : raw;
    a[1 + 2 * N + j] = hasRef ? raw - (rm[j]! - rm[J_FAST]!) : raw;
    a[1 + 3 * N + j] = hasRef ? -(rm[j]! - rm[J_M5]!) : NaN;
  }
  cache.set(key, a);
  return a;
}

export interface MkQuery {
  account: string;
  venue: string;
  side: string;
  ref: string;
  weight: string;
  h: number;
}

class Mom {
  n = 0;
  w = 0;
  wx = 0;
  wxx = 0;
  ww = 0;
  wneg = 0;
  add(x: number, w: number) {
    if (!Number.isFinite(x) || w <= 0) return;
    this.n++;
    this.w += w;
    this.wx += w * x;
    this.wxx += w * x * x;
    this.ww += w * w;
    if (x < 0) this.wneg += w;
  }
  mean() {
    return this.w > 0 ? this.wx / this.w : null;
  }
  se() {
    if (this.n < 2 || this.w <= 0) return null;
    const m = this.wx / this.w;
    const v = Math.max(0, this.wxx / this.w - m * m);
    const neff = (this.w * this.w) / this.ww;
    return neff > 1 ? Math.sqrt(v / (neff - 1)) : null;
  }
  adverse() {
    return this.w > 0 ? this.wneg / this.w : null;
  }
}
const moms = () => Array.from({ length: N }, () => new Mom());
const line = (m: Mom[]): MarkoutLine => ({ n: m.map((x) => x.n), mean: m.map((x) => x.mean()), se: m.map((x) => x.se()), adverse: m.map((x) => x.adverse()) });

function niceWidth(span: number, want: number) {
  const raw = Math.max(1e-6, span / want);
  const mag = 10 ** Math.floor(Math.log10(raw));
  return [1, 2, 2.5, 5, 10].map((k) => k * mag).find((w) => w >= raw) ?? 10 * mag;
}
function dist(xs: [number, number][], j: number): MarkoutDist {
  const d: MarkoutDist = { h: PATH_S[j]!, n: xs.length, lo: 0, width: 0, bins: [], mean: null, median: null, p10: null, p90: null };
  if (!xs.length) return d;
  xs.sort((a, b) => a[0] - b[0]);
  const total = xs.reduce((s, x) => s + x[1], 0);
  const q = (p: number) => {
    let acc = 0;
    for (const [x, w] of xs) if ((acc += w) >= p * total) return x;
    return xs[xs.length - 1]![0];
  };
  d.mean = xs.reduce((s, [x, w]) => s + x * w, 0) / total;
  d.median = q(0.5);
  d.p10 = q(0.1);
  d.p90 = q(0.9);
  const a = q(0.01);
  const b = q(0.99);
  const width = niceWidth(Math.max(0.5, b - a), 36);
  const lo = Math.floor(a / width) * width;
  const nb = Math.min(80, Math.max(1, Math.floor((b - lo) / width) + 1));
  const bins = new Array<number>(nb).fill(0);
  for (const [x, w] of xs) bins[Math.min(nb - 1, Math.max(0, Math.floor((x - lo) / width)))]! += w / total;
  return { ...d, lo, width, bins };
}

/** The report for one view, as markouts.rs builds it. */
export function markoutReport(fills: MkFill[], q: MkQuery, now: number, dayStart: number): MarkoutReport {
  const ref = q.ref === "fast" ? 2 : q.ref === "raw" ? 0 : 1;
  const byFill = q.weight === "fill";
  let hj = J10;
  for (let j = 0; j < N; j++) if (Math.abs(PATH_S[j]! - q.h) < Math.abs(PATH_S[hj]! - q.h)) hj = j;
  const sides = [moms(), moms(), moms()];
  const tox = moms();
  const edge = new Mom();
  let n = 0;
  let notional = 0;
  let pnl = 0;
  const atH: [number, number][] = [];
  const nb = Math.min(200, Math.floor(Math.max(0, now - dayStart) / BUCKET) + 1);
  const buckets = Array.from({ length: nb }, () => ({ fills: 0, notional: 0, m10: new Mom(), m60: new Mom() }));
  const insts = new Map<string, { symbol: string; venue: Venue; fills: number; notional: number; edge: Mom; mk: Mom[]; pnl: number }>();
  const vals = new Array<number>(N);
  for (const f of fills) {
    if ((q.account && f.account !== q.account) || (q.venue && f.venue !== q.venue)) continue;
    const p = pathOf(f);
    const w = byFill ? 1 : f.notional;
    for (let j = 0; j < N; j++) vals[j] = now >= f.t + PATH_S[j]! * 1000 + 1000 ? p[1 + ref * N + j]! : NaN;
    const si = f.side === "buy" ? 1 : 2;
    for (let j = 0; j < N; j++) {
      sides[0]![j]!.add(vals[j]!, w);
      sides[si]![j]!.add(vals[j]!, w);
    }
    if (q.side && q.side !== f.side) continue;
    n++;
    notional += f.notional;
    edge.add(p[0]!, w);
    const p60 = Number.isFinite(vals[J60]!) ? (vals[J60]! * f.notional) / 1e4 : 0;
    pnl += p60;
    for (let j = 0; j < N; j++) if (now >= f.t + PATH_S[j]! * 1000 + 1000) tox[j]!.add(p[1 + 3 * N + j]!, w);
    if (Number.isFinite(vals[hj]!)) atH.push([vals[hj]!, w]);
    const b = buckets[Math.floor((f.t - dayStart) / BUCKET)];
    if (b) {
      b.fills++;
      b.notional += f.notional;
      b.m10.add(vals[J10]!, w);
      b.m60.add(vals[J60]!, w);
    }
    const k = f.venue + ":" + f.symbol;
    let a = insts.get(k);
    if (!a) insts.set(k, (a = { symbol: f.symbol, venue: f.venue, fills: 0, notional: 0, edge: new Mom(), mk: moms(), pnl: 0 }));
    a.fills++;
    a.notional += f.notional;
    a.edge.add(p[0]!, w);
    for (let j = 0; j < N; j++) a.mk[j]!.add(vals[j]!, w);
    a.pnl += p60;
  }
  return {
    now,
    day_start: dayStart,
    horizons_s: PATH_S,
    fills: n,
    path_fills: n,
    notional,
    edge: edge.mean(),
    pnl,
    all: line(sides[0]!),
    buy: line(sides[1]!),
    sell: line(sides[2]!),
    every: [line(sides[0]!), line(sides[1]!), line(sides[2]!)],
    tox: line(tox),
    dist: dist(atH, hj),
    by_time: buckets.map((b, k) => ({ t: dayStart + k * BUCKET, fills: b.fills, notional: b.notional, mk10: b.m10.mean(), mk60: b.m60.mean() })),
    by_instrument: [...insts.values()]
      .map((a) => ({
        symbol: a.symbol,
        venue: a.venue,
        fills: a.fills,
        notional: a.notional,
        edge: a.edge.mean(),
        mean: a.mk.map((m) => m.mean()),
        se10: a.mk[J10]!.se(),
        adverse10: a.mk[J10]!.adverse(),
        pnl: a.pnl,
      }))
      .sort((x, y) => y.notional - x.notional || x.symbol.localeCompare(y.symbol)),
  };
}
