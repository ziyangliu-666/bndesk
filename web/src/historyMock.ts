// Mock /api/history, /api/fills and /api/klines (VITE_MOCK=1). The desk's per-minute path is generated from a
// fixed origin with hashed noise up to the minute the live mock starts; from then on the live mock writes each
// minute itself (writeLive), so the day chart, the history page and the websocket agree.
import type { HistBar, HistDay, HistFill, History, Kline } from "./api";
import { useStore } from "./store";

export const MIN = 60_000;
const DAY = 86_400_000;
export const ORIGIN = Math.floor(Date.now() / DAY) * DAY - 20 * DAY;

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
export const minuteOf = (t: number) => Math.floor((t - ORIGIN) / MIN);
const nowMin = () => minuteOf(Date.now());

/** Relative trading activity by UTC time of day: quiet Asia, busier Europe, the US window busiest. */
export function activity(m: number): number {
  const h = ((m % 1440) + 1440) % 1440 / 60;
  if (h >= 13.5 && h < 20) return 2.0;
  if (h >= 7 && h < 13.5) return 1.0;
  if (h < 7) return 0.6;
  return 0.5;
}

// ---- desk ----
// Cumulative since ORIGIN: pi trading, mm market making, re realized, he hedge legs, ot other, fd the inventory's
// factor drift. Levels at the minute close: inv spot inventory value, fut futures notional. Per minute: vol, fills,
// and hx / lx, how far the day PnL went above the higher and below the lower of the minute's open and close.
export interface DeskMinute {
  pi: number;
  mm: number;
  re: number;
  he: number;
  ot: number;
  fd: number;
  inv: number;
  fut: number;
  vol: number;
  fills: number;
  hx: number;
  lx: number;
}
type Key = keyof DeskMinute;
const KEYS: Key[] = ["pi", "mm", "re", "he", "ot", "fd", "inv", "fut", "vol", "fills", "hx", "lx"];
const FLOW: Key[] = ["vol", "fills", "hx", "lx"]; // per minute, not carried over
export const desk = { n: 0 } as Record<Key, number[]> & { n: number };
for (const k of KEYS) desk[k] = [];
let liveFrom = Infinity; // first minute the live mock owns

// Hidden state of the generated path, advanced one minute at a time.
const gen = {
  burst: 0, // log fill intensity, AR(1): busy stretches and quiet ones
  vr: 0, // log volatility, AR(1): calm and choppy stretches
  dd: 0, // a drawdown being recovered: adverse moves that mostly revert over tens of minutes
  side: 0, // the net side of the flow lately, so inventory trends a while before it reverts
  chop: 0, // marks swinging around: choppy intraday moves that do not add up over the day
};
const INV_LEVEL = 2600;
const HEDGE_RATIO = 1;

function generate(m: number): DeskMinute {
  const at = (k: Key) => desk[k][m - 1] ?? (k === "inv" ? INV_LEVEL : k === "fut" ? -HEDGE_RATIO * INV_LEVEL : 0);
  const a = activity(m);
  const g = (salt: number) => gauss(m, salt);
  gen.burst = 0.85 * gen.burst + 0.5 * g(20) + (hash(m, 21) < 0.006 ? 2.0 : 0);
  gen.vr = 0.994 * gen.vr + 0.045 * g(22) + (gen.burst > 1.5 ? 0.03 : 0);
  const sig = Math.exp(gen.vr) * Math.pow(a, 0.4); // this minute's volatility scale
  const lam = 30 * a * Math.exp(gen.burst - 0.4);
  const fills = Math.max(0, Math.round(lam * (0.6 + 0.8 * hash(m, 1))));
  const vol = fills * 13 * Math.exp(0.35 * g(2));

  const inv0 = at("inv");
  const fut0 = at("fut");
  // market making: spread capture net of fees, a slow positive drift with a little noise per fill
  const mm = vol * 0.16e-4 + g(8) * 0.006 * Math.sqrt(fills);
  // inventory: the market factor, what the names do on their own, adverse selection after fills, and drawdowns
  const f = g(3) * 2.0e-4 * sig;
  const fd = inv0 * f;
  let idio = g(4) * 0.21 * sig - vol * 0.03e-4;
  if (fills > 60 && hash(m, 23) < 0.5) idio += (hash(m, 24) < 0.5 ? -1 : 1) * Math.abs(g(25)) * 0.2 * sig; // a cluster lands
  const before = gen.dd;
  if (hash(m, 26) < 0.003 * a) gen.dd -= (1.2 + 3 * hash(m, 27)) * Math.sqrt(a); // a drawdown starts
  gen.dd *= 1 - 1 / (18 + 20 * hash(Math.floor(m / 60), 28)); // and recovers over tens of minutes
  const chop0 = gen.chop;
  gen.chop = gen.chop * (1 - 1 / 12) + g(32) * 0.45 * sig;
  const ddMove = gen.dd - before + gen.chop - chop0;
  const pi = at("pi") + mm + fd + idio + ddMove;
  // inventory value: price, the net flow (which trends while one side is busier), steps, and a pull back
  gen.side = 0.97 * gen.side + 0.12 * g(5);
  let inv = inv0 * (1 + f) + Math.sqrt(vol) * 1.5 * (g(6) + gen.side) + (INV_LEVEL - inv0) * 0.01;
  if (hash(m, 29) < 0.02 * a) inv += (hash(m, 30) < 0.5 ? -1 : 1) * (200 + 450 * hash(m, 31));
  inv = Math.max(400, inv);
  // the hedger trades back to the target once the gap leaves its band, else the legs move with the factor
  let fut = fut0 * (1 + f);
  let he = at("he") + fut0 * f;
  const target = -HEDGE_RATIO * inv;
  if (Math.abs(target - fut) > Math.max(150, 0.06 * Math.abs(target))) {
    he -= Math.abs(target - fut) * 1e-4;
    fut = target;
  }
  const ot = at("ot") * 0.995 + g(10) * 0.006;
  // how far the minute's path strayed past its open and close
  const step = 0.2 * sig + 0.04;
  return {
    pi,
    mm: at("mm") + mm,
    re: at("re") + mm + 0.7 * (fd + idio + ddMove) + g(9) * 0.05,
    he,
    ot,
    fd: at("fd") + fd,
    inv,
    fut,
    vol,
    fills,
    hx: Math.abs(g(11)) * step,
    lx: Math.abs(g(12)) * step,
  };
}

/** Generated minutes through upto; minutes the live mock owns but has not written carry the last levels. */
export function extendDesk(upto: number) {
  for (let m = desk.n; m <= upto; m++) {
    let row: DeskMinute;
    if (m < liveFrom) row = generate(m);
    else {
      row = {} as DeskMinute;
      for (const k of KEYS) row[k] = FLOW.includes(k) ? 0 : desk[k][m - 1]!;
    }
    for (const k of KEYS) desk[k][m] = row[k];
  }
  desk.n = Math.max(desk.n, upto + 1);
}

/** The live mock takes over from minute m on (history up to m − 1 stays generated). */
export function setLiveFrom(m: number) {
  extendDesk(m - 1);
  liveFrom = m;
}
/** The live mock's levels for minute m, overwriting what was there. */
export function writeLive(m: number, row: DeskMinute) {
  extendDesk(m);
  for (const k of KEYS) desk[k][m] = row[k];
}
export function deskAt(m: number): DeskMinute {
  extendDesk(m);
  const row = {} as DeskMinute;
  for (const k of KEYS) row[k] = desk[k][m] ?? 0;
  return row;
}

function history(from: number, to: number, step: number): History {
  const now = nowMin();
  extendDesk(now);
  const sm = step / 60;
  const m0 = Math.max(0, Math.floor((from - ORIGIN) / MIN / sm) * sm);
  const m1 = Math.min(now, Math.floor((to - ORIGIN) / MIN));
  const base = (xs: number[]) => (m0 > 0 ? xs[m0 - 1]! : 0);
  const tot = (m: number) => desk.pi[m]! + desk.he[m]! + desk.ot[m]!;
  const b0 = m0 > 0 ? tot(m0 - 1) : 0;
  const [bpi, bre, bmm, bhe] = [base(desk.pi), base(desk.re), base(desk.mm), base(desk.he)];
  const bars: HistBar[] = [];
  let prev = 0;
  for (let s = m0; s <= m1; s += sm) {
    const e = Math.min(m1, s + sm - 1);
    let h = prev;
    let l = prev;
    let vol = 0;
    let fills = 0;
    for (let m = s; m <= e; m++) {
      const o = (m > 0 ? tot(m - 1) : 0) - b0;
      const v = tot(m) - b0;
      h = Math.max(h, v, Math.max(o, v) + desk.hx[m]!);
      l = Math.min(l, v, Math.min(o, v) - desk.lx[m]!);
      vol += desk.vol[m]!;
      fills += desk.fills[m]!;
    }
    const c = tot(e) - b0;
    bars.push({
      t: ORIGIN + s * MIN,
      o: prev,
      h,
      l,
      c,
      pi: desk.pi[e]! - bpi,
      realized: desk.re[e]! - bre,
      mm: desk.mm[e]! - bmm,
      hedge: desk.he[e]! - bhe,
      inventory: desk.inv[e]!,
      futures: desk.fut[e]!,
      volume: vol,
      fills,
    });
    prev = c;
  }
  return { step, bars, days: days() };
}

function days(): HistDay[] {
  const out: HistDay[] = [];
  for (let t = ORIGIN; t <= Date.now(); t += DAY) out.push({ day: new Date(t).toISOString().slice(0, 10), start: t });
  return out;
}

// ---- instruments ----
interface Path {
  n: number;
  lc: number[]; // log close per minute, before anchoring
  vol: number[];
  seed: number;
  anchor: number; // log offset that puts the latest close at the current mid
}
const paths = new Map<string, Path>();
function path(symbol: string): Path {
  let p = paths.get(symbol);
  if (!p) {
    p = { n: 0, lc: [], vol: [], seed: strSeed(symbol), anchor: 0 };
    paths.set(symbol, p);
  }
  const upto = nowMin();
  for (let m = p.n; m <= upto; m++) {
    p.lc.push((p.lc[m - 1] ?? 0) + gauss(m, p.seed) * 0.0004 * Math.sqrt(activity(m)));
    p.vol.push((0.3 + hash(m, p.seed + 1) * 1.4) * activity(m));
  }
  p.n = upto + 1;
  const mid = useStore.getState().snap?.symbols.find((s) => s.symbol === symbol)?.mid ?? 100;
  p.anchor = Math.log(mid) - p.lc[upto]!;
  return p;
}
function minuteBar(p: Path, m: number, basis: number): [number, number, number, number] {
  const o = Math.exp((p.lc[m - 1] ?? p.lc[m]!) + p.anchor) * basis;
  const c = Math.exp(p.lc[m]! + p.anchor) * basis;
  const h = Math.max(o, c) * (1 + Math.abs(gauss(m, p.seed + 2)) * 0.00025);
  const l = Math.min(o, c) * (1 - Math.abs(gauss(m, p.seed + 3)) * 0.00025);
  return [o, h, l, c];
}

const STEP: Record<string, number> = { "1m": 1, "5m": 5, "15m": 15, "1h": 60, "4h": 240, "1d": 1440 };

function klines(symbol: string, venue: string, interval: string, from: number, to: number): Kline[] {
  const p = path(symbol);
  const basis = venue === "usdm" ? 1.0002 : 1;
  const sm = STEP[interval] ?? 1;
  const m0 = Math.max(0, Math.floor((from - ORIGIN) / MIN / sm) * sm);
  const m1 = Math.min(p.n - 1, Math.floor((to - ORIGIN) / MIN));
  const notional = 40_000 / Math.exp(p.anchor);
  const out: Kline[] = [];
  for (let s = m0; s <= m1; s += sm) {
    const e = Math.min(m1, s + sm - 1);
    let [o, h, l, c] = minuteBar(p, s, basis);
    let v = 0;
    for (let m = s; m <= e; m++) {
      const b = minuteBar(p, m, basis);
      if (b[1] > h) h = b[1];
      if (b[2] < l) l = b[2];
      c = b[3];
      v += p.vol[m]! * notional;
    }
    out.push([ORIGIN + s * MIN, o, h, l, c, v]);
  }
  return out;
}

const ACCTS = ["sub-a", "sub-b", "sub-c", "sub-d"];
function fills(symbol: string, from: number, to: number): HistFill[] {
  const p = path(symbol);
  const isPerpHedged = symbol === "BTCUSDT" || symbol === "ETHUSDT";
  const m0 = Math.max(0, Math.floor((from - ORIGIN) / MIN));
  const m1 = Math.min(p.n - 1, Math.floor((to - ORIGIN) / MIN));
  const out: HistFill[] = [];
  for (let m = m0; m <= m1; m++) {
    const r = hash(m, p.seed + 10);
    const a = activity(m);
    if (r < 0.05 * a) {
      // a cluster: a few fills within seconds, on one side
      const n = 1 + Math.floor(-Math.log(Math.max(1e-9, hash(m, p.seed + 11))) * 1.8);
      const [, h, l] = minuteBar(p, m, 1);
      const bias = gauss(Math.floor(m / 30), p.seed + 12); // buying and selling come in runs
      const side = hash(m, p.seed + 13) < 0.5 + bias * 0.2 ? "buy" : "sell";
      const t0 = ORIGIN + m * MIN + Math.floor(hash(m, p.seed + 14) * (MIN - 5000));
      for (let k = 0; k < n; k++) {
        const px = side === "buy" ? l + (h - l) * 0.25 : h - (h - l) * 0.25;
        out.push({
          t: t0 + Math.floor(k * 400 * (0.5 + hash(m * 8 + k, p.seed + 15))),
          side,
          price: px,
          qty: Math.min(150, Math.max(4, 11 * Math.exp(0.8 * gauss(m * 8 + k, p.seed + 16)))) / px,
          account: ACCTS[p.seed % ACCTS.length]!,
          venue: "spot",
          maker: hash(m * 8 + k, p.seed + 17) < 0.95,
        });
      }
    }
    if (isPerpHedged && r > 1 - 0.01 * a) {
      const [, h, l] = minuteBar(p, m, 1.0002);
      const side = hash(m, p.seed + 18) < 0.5 ? "buy" : "sell";
      const px = (h + l) / 2;
      out.push({ t: ORIGIN + m * MIN + 30_000, side, price: px, qty: (150 + hash(m, p.seed + 19) * 350) / px, account: "main", venue: "usdm", maker: false });
    }
  }
  return out.sort((x, y) => x.t - y.t);
}

export function mockApi(path: string, q: Record<string, string | number>): unknown {
  const n = (k: string) => Number(q[k]);
  switch (path) {
    case "/api/history":
      return history(n("from"), n("to"), n("step"));
    case "/api/klines":
      return klines(String(q.symbol), String(q.venue), String(q.interval), n("from"), n("to"));
    case "/api/fills":
      return fills(String(q.symbol), n("from"), n("to"));
  }
  throw new Error("404 Not Found");
}
