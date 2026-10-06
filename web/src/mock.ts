// In-browser generator of protocol-conformant messages (VITE_MOCK=1). Generic crypto pairs only.
//
// It runs the desk as a small simulation on the server's 125 ms tick, so it moves like a live desk: each name's
// price ticks on its own clock (busy names more often, all of them sharing a market factor), fills arrive in
// clusters on a few names and move only those rows, orders are requoted one at a time, markouts settle when they
// mature, and P&L is booked from the fills and the marks rather than drawn. The day so far comes from
// historyMock's per-minute path, and the live loop writes its minutes back there, so the chart, the history
// page and the websocket agree.
import type {
  Account,
  AccountSeries,
  Alert,
  DayPnl,
  Engine,
  Exposure,
  Feed,
  Fill,
  HourPnl,
  Markouts,
  MarkoutStats,
  Msg,
  OpenOrder,
  SeriesPoint,
  Snapshot,
  Summary,
  SymbolRow,
} from "./protocol";
import { MIN, activity as minuteActivity, desk, deskAt, minuteOf, setLiveFrom, writeLive, type DeskMinute } from "./historyMock";

type Emit = (m: Msg) => void;

const TICK = 125;
const H = 3_600_000;
const SLOT = 5_000; // series grid
const ACCT_STEP = 45_000; // account series grid
const MAKER_BPS = 0.75;
const TAKER_BPS = 2.25;

// ---- deterministic-ish rng ----
let seed = 0x9e3779b9;
function rnd(): number {
  seed ^= seed << 13;
  seed ^= seed >>> 17;
  seed ^= seed << 5;
  return ((seed >>> 0) % 1_000_000) / 1_000_000;
}
function gauss(): number {
  let u = 0;
  let v = 0;
  while (u === 0) u = rnd();
  while (v === 0) v = rnd();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}
const expo = (mean: number) => -Math.log(1 - rnd() + 1e-12) * mean;
/** A fill's notional: median about 11 USDT, a few to about 150. */
const clipNotional = () => Math.min(150, Math.max(4, 11 * Math.exp(0.8 * gauss())));
const sumOf = <T,>(xs: readonly T[], f: (x: T) => number) => xs.reduce((a, x) => a + f(x), 0);

// ---- accounts ----
const ACCOUNTS: { id: string; role: "master" | "sub"; base: number; transfers: number }[] = [
  { id: "main", role: "master", base: 16_000, transfers: -1500 },
  { id: "sub-a", role: "sub", base: 9_200, transfers: 0 },
  { id: "sub-b", role: "sub", base: 8_650, transfers: 0 },
  { id: "sub-c", role: "sub", base: 6_100, transfers: 1500 },
  { id: "sub-d", role: "sub", base: 5_400, transfers: 0 },
];
const TRADERS = ["sub-b", "sub-a", "sub-c", "sub-d"]; // in the order the busiest names are dealt out
const BASE_EQUITY = sumOf(ACCOUNTS, (a) => a.base);

// ---- universe ----
// [symbol, price, has a USD-M perp it is referenced to]
const SPOT: [string, number, boolean][] = [
  ["BTCUSDT", 64250, true], ["ETHUSDT", 2480, true], ["SOLUSDT", 148.2, true], ["BNBUSDT", 572.4, true],
  ["XRPUSDT", 0.5371, true], ["DOGEUSDT", 0.1093, true], ["ADAUSDT", 0.3532, true], ["AVAXUSDT", 26.41, true],
  ["LINKUSDT", 11.27, true], ["SUIUSDT", 1.842, true], ["TONUSDT", 5.312, false], ["LTCUSDT", 66.85, true],
  ["DOTUSDT", 4.218, false], ["TRXUSDT", 0.1567, true], ["NEARUSDT", 4.712, true], ["APTUSDT", 8.341, true],
  ["ARBUSDT", 0.5612, true], ["OPUSDT", 1.582, true], ["ATOMUSDT", 4.411, false], ["FILUSDT", 3.672, false],
  ["PEPEUSDT", 0.00000842, true], ["WLDUSDT", 1.735, true], ["BCHUSDT", 331.2, true], ["UNIUSDT", 6.842, true],
  ["ETCUSDT", 18.91, true], ["XLMUSDT", 0.0942, true], ["HBARUSDT", 0.0531, true], ["ICPUSDT", 8.214, true],
  ["AAVEUSDT", 142.7, true], ["INJUSDT", 19.84, true], ["SEIUSDT", 0.3125, true], ["TIAUSDT", 5.218, true],
  ["RENDERUSDT", 5.412, true], ["FETUSDT", 1.284, true], ["STXUSDT", 1.612, true], ["IMXUSDT", 1.311, true],
  ["LDOUSDT", 1.092, true], ["RUNEUSDT", 3.871, true], ["ALGOUSDT", 0.1218, false], ["VETUSDT", 0.0221, false],
  ["GRTUSDT", 0.1512, true], ["SANDUSDT", 0.2611, true], ["MANAUSDT", 0.2812, true], ["AXSUSDT", 4.912, true],
  ["EGLDUSDT", 26.31, true], ["THETAUSDT", 1.183, false], ["FLOWUSDT", 0.5312, false], ["CRVUSDT", 0.2812, true],
  ["SNXUSDT", 1.412, true], ["DYDXUSDT", 0.9812, true], ["GALAUSDT", 0.0182, true], ["CHZUSDT", 0.0612, false],
  ["ENSUSDT", 15.42, true], ["JUPUSDT", 0.7812, true], ["PYTHUSDT", 0.2911, true], ["ORDIUSDT", 28.42, true],
  ["BONKUSDT", 0.00001912, true], ["SHIBUSDT", 0.00001412, true], ["FLOKIUSDT", 0.0001312, true], ["WIFUSDT", 1.612, true],
  ["ENAUSDT", 0.2812, true], ["ONDOUSDT", 0.7212, true], ["PENDLEUSDT", 3.812, true], ["TAOUSDT", 312.4, true],
];

interface Ord {
  o: OpenOrder;
  side: "buy" | "sell";
  level: number;
  target: number; // bps from fair it was placed at
}

interface Inst {
  symbol: string;
  ref: boolean;
  account: string;
  weight: number; // share of fills
  rate: number; // price updates per second at activity 1
  tick: number;
  spreadTicks: number;
  baseSpread: number;
  bidK: number; // market best bid, in ticks
  logBase: number;
  beta: number;
  idio: number; // log, the name's own random walk
  refBasis: number; // perp vs spot, bps
  fair: number;
  refMid: number;
  fAt: number; // factor level at the last mark
  hotUntil: number;
  dist: number; // quoting distance, bps
  clip: number; // order notional, USDT
  wantBids: number;
  wantAsks: number;
  orders: Ord[];
  // position and P&L today
  inv: number;
  cost: number | null;
  cash: number; // since the mock started, incl. fees
  v0: number; // inventory value when the mock started
  tOff: number; // trading P&L booked before the mock started
  mm: number; // incl. the part before the mock started
  fd: number; // the inventory's factor drift today
  fills: number;
  buys: number;
  sells: number;
  volume: number;
  edgeW: number;
  edgeN: number;
  mk: Record<"10" | "60" | "300", [number, number]>; // Σ bps × notional, Σ notional
  last: number | null;
  row: SymbolRow | null; // rebuilt only when something on the name changed
}

interface Leg {
  symbol: string;
  spot: Inst;
  tick: number;
  markK: number;
  basis: number;
  idio: number;
  q: number;
  q0: number; // day start
  mark0: number;
  qLive0: number; // when the mock started
  markLive0: number;
  entry: number;
  cash: number;
  fees: number;
  funding: number;
  fills: number;
  volume: number;
  hOff: number;
  row: SymbolRow | null;
}

const insts: Inst[] = [];
const bySymbol = new Map<string, Inst>();
let F = 0; // market factor, log
let D = 0; // the alts against the factor, log: drawdowns the hedge does not cover, recovering over tens of minutes
let lvr = 0; // log volatility, AR(1): calm and choppy stretches

function tickFor(px: number): number {
  return Math.pow(10, Math.floor(Math.log10(px)) - (px >= 1000 ? 5 : 4));
}

function buildUniverse() {
  // busy names are not simply the large caps: shuffle the activity ranks
  const rank = SPOT.map((_, k) => k);
  for (let k = rank.length - 1; k > 0; k--) {
    const j = Math.floor(rnd() * (k + 1));
    [rank[k], rank[j]] = [rank[j]!, rank[k]!];
  }
  const ws = rank.map((r) => Math.pow(r + 2, -1.5));
  const wSum = ws.reduce((a, b) => a + b, 0);
  const wMax = Math.max(...ws);
  SPOT.forEach(([symbol, px, ref], k) => {
    const tick = tickFor(px);
    const tickBps = (tick / px) * 1e4;
    const baseSpread = tickBps >= 0.3 ? (rnd() < 0.75 ? 1 : 2) : Math.max(1, Math.round((0.6 + rnd() * 2.4) / tickBps));
    const w = ws[k]! / wSum;
    const r = rank[k]!;
    const i: Inst = {
      symbol,
      ref,
      account: TRADERS[r % TRADERS.length]!,
      weight: w,
      rate: 0.12 + 1.6 * Math.sqrt(ws[k]! / wMax),
      tick,
      spreadTicks: baseSpread,
      baseSpread,
      bidK: Math.round(px / tick - baseSpread / 2),
      logBase: Math.log(px),
      beta: symbol === "BTCUSDT" ? 1 : symbol === "ETHUSDT" ? 1.05 : 0.8 + rnd() * 0.4,
      idio: 0,
      refBasis: ref ? (rnd() - 0.5) * 4 : 0,
      fair: px,
      refMid: px,
      fAt: 0,
      hotUntil: 0,
      dist: 1.2 + rnd() * 3.5,
      clip: 14 + rnd() * rnd() * 140,
      wantBids: r < 6 ? 2 : rnd() < 0.35 ? 0 : 1,
      wantAsks: r < 4 ? 2 : 1,
      orders: [],
      inv: 0,
      cost: null,
      cash: 0,
      v0: 0,
      tOff: 0,
      mm: 0,
      fd: 0,
      fills: 0,
      buys: 0,
      sells: 0,
      volume: 0,
      edgeW: 0,
      edgeN: 0,
      mk: { "10": [0, 0], "60": [0, 0], "300": [0, 0] },
      last: null,
      row: null,
    };
    insts.push(i);
    bySymbol.set(symbol, i);
  });
}

const tickOf = (i: Inst) => i.tick;
const bidOf = (i: Inst) => i.bidK * i.tick;
const askOf = (i: Inst) => (i.bidK + i.spreadTicks) * i.tick;
const midOf = (i: Inst) => (i.bidK + i.spreadTicks / 2) * i.tick;
const truePx = (i: Inst) => Math.exp(i.logBase + i.beta * F + i.idio + D);
const invValue = (i: Inst) => i.inv * midOf(i);
const tradingOf = (i: Inst) => i.tOff + i.cash + invValue(i) - i.v0;

const legs: Leg[] = [];
const legMark = (l: Leg) => l.markK * l.tick;
const legPnl = (l: Leg) => l.hOff + l.cash + l.q * legMark(l) - l.qLive0 * l.markLive0 - l.fees + l.funding;
const futNotional = () => sumOf(legs, (l) => l.q * legMark(l));

// ---- time ----
const dayStartOf = (t: number) => {
  const d = new Date(t);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
};
let now = Date.now();
let dayStart = dayStartOf(now);
let d0 = minuteOf(dayStart); // first minute of the day
let curMin = minuteOf(now);
const activityNow = () => minuteActivity(minuteOf(now));

// ---- desk state ----
let base: DeskMinute; // the desk's cumulative values at the day start
let mmLiveSpread = 0; // Σ edge × notional − fees, since the mock started
let mmSpread0 = 0;
let other = 0;
let realizedOld = 0;
let regime = 0; // log intensity of fill clusters, AR(1)
let minVol = 0; // this minute's notional filled
let minOpen = 0; // the desk's cumulative day PnL at the minute's open, and its range since
let minHi = 0;
let minLo = 0;
let minFills = 0;
let deskDirty = false;
const series: SeriesPoint[] = [];
let fills: Fill[] = [];
let fillSeq = 0;
const pending: { f: Fill; i: Inst }[] = []; // fills with markouts still to mature
const due: { at: number; i: Inst; side: "buy" | "sell" }[] = []; // the rest of a fill cluster
const requote = new Set<Inst>();
const byHourMk: { s10: number; w10: number; s60: number; w60: number; mk10: number | null; mk60: number | null }[] = Array.from(
  { length: 24 },
  () => ({ s10: 0, w10: 0, s60: 0, w60: 0, mk10: null, mk60: null }),
);
const alerts: Alert[] = [];

// ---- orders ----
let orderSeq = 0;
const orderAdds: Record<string, number[]> = {}; // per account, send times for the 10 s counter
const acctTouched = new Set<string>();
const eng1 = { orders: 0, cancels: 0, fills: 0, risk: 3, venue: 0, fees: 0 };
const rejects1 = [
  { reason: "post only would cross", count: 21 },
  { reason: "insufficient balance", count: 8 },
  { reason: "too many orders", count: 4 },
  { reason: "price filter", count: 2 },
];

function sent(account: string) {
  (orderAdds[account] ??= []).push(now);
  acctTouched.add(account);
}

function place(i: Inst, side: "buy" | "sell", level: number) {
  const target = Math.max(0.4, i.dist * (1 + level * 1.6) + gauss() * 0.3);
  const raw = side === "buy" ? i.fair * (1 - target / 1e4) : i.fair * (1 + target / 1e4);
  const price = (side === "buy" ? Math.floor(raw / i.tick) : Math.ceil(raw / i.tick)) * i.tick;
  const room = side === "sell" ? invValue(i) / Math.max(1, i.wantAsks) : Infinity;
  const notional = Math.min(room * 0.95, i.clip * (0.8 + rnd() * 0.4));
  if (notional < 5) return;
  const o: OpenOrder = {
    id: `o${++orderSeq}`,
    account: i.account,
    symbol: i.symbol,
    venue: "spot",
    side,
    price,
    qty: notional / price,
    notional,
    fair: i.fair,
    dist_bps: distOf(i, side, price),
    since: now,
  };
  i.orders.push({ o, side, level, target });
  eng1.orders++;
  sent(i.account);
}
function distOf(i: Inst, side: "buy" | "sell", price: number) {
  return ((side === "buy" ? i.fair - price : price - i.fair) / i.fair) * 1e4;
}
function cancel(i: Inst, ord: Ord, filled = false) {
  i.orders.splice(i.orders.indexOf(ord), 1);
  if (!filled) eng1.cancels++;
  acctTouched.add(i.account);
}
/** Bring the name's resting orders to its wanted levels; asks only against inventory. */
function ensureQuotes(i: Inst) {
  for (const side of ["buy", "sell"] as const) {
    const want = side === "buy" ? i.wantBids : invValue(i) >= 6 ? i.wantAsks : 0;
    const have = i.orders.filter((o) => o.side === side);
    for (const o of have.filter((o) => o.level >= want)) cancel(i, o);
    for (let lv = 0; lv < want; lv++) if (!have.some((o) => o.level === lv)) place(i, side, lv);
  }
}
/** On a new fair: refresh distances, and replace the orders that drifted out of tolerance. */
function retarget(i: Inst) {
  for (const ord of i.orders.slice()) {
    const d = distOf(i, ord.side, ord.o.price);
    if (Math.abs(d - ord.target) > 0.8 + ord.level || d < 0.3 || rnd() < 0.05) {
      cancel(i, ord);
      place(i, ord.side, ord.level);
    } else {
      ord.o = { ...ord.o, fair: i.fair, dist_bps: d };
    }
  }
  if (i.orders.length === 0 || rnd() < 0.05) ensureQuotes(i);
}

// ---- prices ----
/** A new market on the name: mid snaps to its tick grid toward the true price, usually one tick. */
function mark(i: Inst, dir = 0) {
  i.fd += invValue(i) * i.beta * (F - i.fAt);
  i.fAt = F;
  i.idio += gauss() * 0.4e-4 * Math.exp(lvr);
  const tp = truePx(i);
  if (rnd() < 0.03) i.spreadTicks = i.spreadTicks === i.baseSpread ? i.baseSpread + 1 : i.baseSpread;
  else if (i.spreadTicks !== i.baseSpread && rnd() < 0.3) i.spreadTicks = i.baseSpread;
  let k = Math.round(tp / i.tick - i.spreadTicks / 2);
  if (k === i.bidK) k += tp > midOf(i) ? 1 : tp < midOf(i) ? -1 : rnd() < 0.5 ? 1 : -1;
  if (rnd() < 0.1) {
    // a level cleared: a few ticks, or a few bps on fine-tick names
    const dir = k >= i.bidK ? 1 : -1;
    const bps = (1.2 + rnd() * 2.5) * 1e-4;
    k += dir * Math.max(1 + Math.floor(rnd() * 3), Math.round((tp * bps) / i.tick));
  }
  if (dir !== 0 && Math.sign(k - i.bidK) !== dir) k = i.bidK + dir * (1 + Math.floor(rnd() * 2));
  i.bidK = Math.max(1, k);
  i.fair = tp * (1 + gauss() * 0.15e-4);
  i.refMid = i.ref ? tp * (1 + i.refBasis / 1e4 + gauss() * 0.2e-4) : tp;
  retarget(i);
  i.row = null;
}

// ---- fills ----
function newFill(i: Inst, side: "buy" | "sell"): Fill | null {
  const resting = i.orders.filter((o) => o.side === side).sort((a, b) => a.level - b.level)[0];
  if (!resting) return null;
  const maker = rnd() < 0.96;
  const price = maker ? resting.o.price : side === "buy" ? askOf(i) : bidOf(i);
  let notional = Math.min(resting.o.notional, clipNotional());
  if (side === "sell") notional = Math.min(notional, invValue(i) * 0.98);
  if (notional < 3) return null;
  const qty = notional / price;
  const s = side === "buy" ? 1 : -1;
  const fee = (notional * (maker ? MAKER_BPS : TAKER_BPS)) / 1e4;
  const edge = s * ((i.fair - price) / i.fair) * 1e4;
  // book it
  i.fd += invValue(i) * i.beta * (F - i.fAt);
  i.fAt = F;
  const newInv = Math.max(0, i.inv + s * qty);
  if (s > 0) i.cost = i.cost == null || i.inv <= 0 ? price : (i.cost * i.inv + price * qty) / newInv;
  i.inv = newInv;
  if (i.inv * price < 1) i.cost = null;
  i.cash += -s * qty * price - fee;
  i.fills++;
  if (s > 0) i.buys++;
  else i.sells++;
  i.volume += notional;
  i.edgeW += edge * notional;
  i.edgeN += notional;
  i.last = now;
  i.row = null;
  mmLiveSpread += (edge * notional) / 1e4 - fee;
  minVol += notional;
  minFills++;
  deskDirty = true;
  eng1.fills++;
  eng1.fees += fee;
  // the order fills, partly or wholly; a filled order is replaced next tick
  resting.o = { ...resting.o, notional: resting.o.notional - notional, qty: (resting.o.notional - notional) / resting.o.price };
  if (resting.o.notional < 4) {
    cancel(i, resting, true);
    requote.add(i);
  }
  if (side === "buy") requote.add(i); // asks may now be possible
  acctTouched.add(i.account);
  return {
    id: `${i.account}-${i.symbol}-${++fillSeq}`,
    ts: now,
    account: i.account,
    symbol: i.symbol,
    venue: "spot",
    side,
    price,
    qty,
    notional,
    fee,
    fee_asset: side === "buy" ? i.symbol.replace(/USDT$/, "") : "USDT",
    maker,
    fair: i.fair,
    edge_bps: edge,
    mk: emptyMk(),
    mk_raw: emptyMk(),
    mk_fast: emptyMk(),
  };
}
function emptyMk(): Markouts {
  return { "1": null, "10": null, "60": null, "300": null };
}

function pickByWeight(): Inst {
  let r = rnd();
  for (const i of insts) {
    r -= i.weight;
    if (r <= 0) return i;
  }
  return insts[0]!;
}

/** A cluster: the market trades through the name's quotes on one side, a few fills within a second or two. */
function startCluster() {
  const i = pickByWeight();
  const held = invValue(i);
  let side: "buy" | "sell" = held > 220 ? (rnd() < 0.7 ? "sell" : "buy") : rnd() < 0.5 ? "buy" : "sell";
  if (!i.orders.some((o) => o.side === side)) side = side === "buy" ? "sell" : "buy";
  if (!i.orders.some((o) => o.side === side)) return;
  const s = side === "buy" ? 1 : -1;
  // the price went through us, and some of it keeps going (that is the adverse part of the markouts)
  i.idio -= s * (0.8 + rnd() * 2.2) * 1e-4;
  mark(i, -s);
  i.hotUntil = now + 6000 + rnd() * 6000;
  let n = 1;
  while (rnd() < 0.6 && n < 9) n++;
  let t = now;
  for (let k = 0; k < n; k++) {
    due.push({ at: t, i, side });
    t += expo(350);
  }
}

const HORIZONS = ["1", "10", "60", "300"] as const;
function mature(): Fill[] {
  const out: Fill[] = [];
  for (let k = pending.length - 1; k >= 0; k--) {
    const p = pending[k]!;
    const age = (now - p.f.ts) / 1000;
    let mk: Markouts | null = null;
    for (const h of HORIZONS) {
      if (p.f.mk[h] != null || age < Number(h)) continue;
      mk ??= { ...p.f.mk };
      const s = p.f.side === "buy" ? 1 : -1;
      const v = s * ((midOf(p.i) - p.f.price) / p.f.price) * 1e4;
      mk[h] = v;
      settle(p.i, p.f, h, v);
    }
    if (mk) {
      const s = p.f.side === "buy" ? 1 : -1;
      const raw = { ...p.f.mk_raw };
      const fast = { ...p.f.mk_fast };
      for (const h of HORIZONS) {
        if (mk[h] == null || raw[h] != null) continue;
        raw[h] = s * ((p.i.refMid - p.f.price) / p.f.price) * 1e4;
        fast[h] = mk[h]! + 0.4 * (raw[h]! - mk[h]!);
      }
      const nf: Fill = { ...p.f, mk, mk_raw: raw, mk_fast: fast };
      p.f = nf;
      out.push(nf);
      const idx = fills.findIndex((x) => x.id === nf.id);
      if (idx >= 0) fills[idx] = nf;
    }
    if (age >= 300) pending.splice(k, 1);
  }
  return out;
}
function settle(i: Inst, f: Fill, h: (typeof HORIZONS)[number], v: number) {
  if (h === "1") return;
  const acc = i.mk[h];
  acc[0] += v * f.notional;
  acc[1] += f.notional;
  i.row = null;
  const b = byHourMk[new Date(f.ts).getUTCHours()]!;
  if (h === "10") {
    b.s10 += v * f.notional;
    b.w10 += f.notional;
  }
  if (h === "60") {
    b.s60 += v * f.notional;
    b.w60 += f.notional;
    i.mm += (v * f.notional) / 1e4 - f.fee;
    deskDirty = true;
  }
}

// ---- hedger (engine 2) ----
const eng2 = { orders: 131, cancels: 22, fills: 118, risk: 0, venue: 3, fees: 0 };
const rejects2 = [
  { reason: "reduce only rejected", count: 2 },
  { reason: "post only would cross", count: 9 },
  { reason: "margin is insufficient", count: 0 },
];
let hedgeOrder: { leg: Leg; qty: number; at: number; o: OpenOrder } | null = null;
const BAND = (target: number) => Math.max(150, 0.08 * Math.abs(target));
const betaValue = () => sumOf(insts, (i) => invValue(i) * i.beta);

function hedger() {
  if (hedgeOrder) {
    if (now >= hedgeOrder.at) {
      const { leg, qty } = hedgeOrder;
      const maker = rnd() < 0.5;
      const price = legMark(leg) * (1 + (maker ? -1 : 1) * Math.sign(qty) * 0.2e-4);
      leg.q += qty;
      leg.cash -= qty * price;
      leg.fees += (Math.abs(qty * price) * (maker ? 0.2 : 0.5)) / 1e3; // 2 / 5 bps
      leg.fills++;
      leg.volume += Math.abs(qty * price);
      leg.entry = leg.q !== 0 ? price : leg.entry;
      leg.row = null;
      eng2.fills++;
      eng2.fees += (Math.abs(qty * price) * (maker ? 0.2 : 0.5)) / 1e3;
      hedgeOrder = null;
      acctTouched.add("main");
      deskDirty = true;
    }
    return;
  }
  const target = -betaValue();
  const gap = target - futNotional();
  if (Math.abs(gap) <= BAND(target)) return;
  const leg = rnd() < 0.7 ? legs[0]! : legs[1]!;
  const qty = gap / legMark(leg);
  hedgeOrder = {
    leg,
    qty,
    at: now + 250 + rnd() * 1500,
    o: {
      id: `h${++orderSeq}`,
      account: "main",
      symbol: leg.symbol,
      venue: "usdm",
      side: qty > 0 ? "buy" : "sell",
      price: legMark(leg),
      qty: Math.abs(qty),
      notional: Math.abs(gap),
      fair: legMark(leg),
      dist_bps: 0.2,
      since: now,
    },
  };
  eng2.orders++;
  if (rnd() < 0.15) eng2.cancels++;
  sent("main");
}

// ---- history: the day so far, from historyMock's minutes ----
function buildHistory() {
  now = Date.now();
  dayStart = dayStartOf(now);
  d0 = minuteOf(dayStart);
  curMin = minuteOf(now);
  setLiveFrom(curMin);
  base = deskAt(d0 - 1);
  const e = deskAt(curMin - 1);
  let fills0 = 0;
  let vol0 = 0;
  for (let m = d0; m < curMin; m++) {
    fills0 += desk.fills[m]!;
    vol0 += desk.vol[m]!;
  }
  const trading0 = e.pi - base.pi;
  const mm0 = e.mm - base.mm;
  const fd0 = e.fd - base.fd;
  other = e.ot - base.ot;

  // inventory: about half the names hold some, summing to the desk's inventory value
  const held = insts.filter(() => rnd() < 0.45);
  const raw = held.map((i) => Math.sqrt(i.weight) * Math.exp(0.6 * gauss()));
  const rawSum = raw.reduce((a, b) => a + b, 0);
  held.forEach((i, k) => {
    i.inv = ((raw[k]! / rawSum) * e.inv) / midOf(i);
    i.cost = midOf(i) * (1 + gauss() * 15e-4);
  });
  for (const i of insts) {
    i.v0 = invValue(i);
    i.fair = truePx(i);
    i.refMid = i.ref ? i.fair * (1 + i.refBasis / 1e4) : i.fair;
  }
  // the day's numbers so far, dealt out over the names; each split sums to the desk total
  const split = (total: number, w: (i: Inst) => number, noise: number) => {
    const ws = insts.map(w);
    const wSum = ws.reduce((a, b) => a + b, 0) || 1;
    const gs = insts.map((_, k) => gauss() * noise * Math.sqrt(ws[k]! / wSum));
    const gSum = gs.reduce((a, b) => a + b, 0);
    return insts.map((_, k) => (total * ws[k]!) / wSum + gs[k]! - (gSum * ws[k]!) / wSum);
  };
  const tr = split(trading0, (i) => i.weight + 0.002, 6);
  const mm = split(mm0, (i) => i.weight, 1.5);
  const fd = split(fd0, (i) => Math.max(1e-3, invValue(i)), 0);
  let left = fills0;
  insts.forEach((i, k) => {
    i.tOff = tr[k]!;
    i.mm = mm[k]!;
    i.fd = fd[k]!;
    i.fills = Math.min(left, Math.floor(fills0 * i.weight * (0.7 + 0.6 * rnd())));
    left -= i.fills;
  });
  insts[0]!.fills += left;
  const fSum = sumOf(insts, (i) => i.fills) || 1;
  for (const i of insts) {
    i.volume = (vol0 * i.fills) / fSum;
    i.buys = Math.round(i.fills * (0.5 + gauss() * 0.04));
    i.sells = i.fills - i.buys;
    const edge = 1.6 + gauss() * 0.6;
    i.edgeW = edge * i.volume;
    i.edgeN = i.volume;
    const noisy = (mu: number, sd: number) => mu + (gauss() * sd) / Math.sqrt(1 + i.fills / 40);
    i.mk["10"] = [noisy(0.9, 2.5) * i.volume, i.volume];
    i.mk["60"] = [noisy(0.5, 4) * i.volume, i.volume];
    i.mk["300"] = [noisy(0.1, 7) * i.volume, i.volume];
  }
  mmSpread0 = sumOf(insts, (i) => i.edgeW / 1e4) - vol0 * MAKER_BPS * 1e-4;
  realizedOld = trading0 * 0.08;

  // the futures legs: the desk's hedge so far, split 70 / 30 between the BTC and ETH perps
  for (const [symbol, share, tick, basis] of [["BTCUSDT", 0.7, 0.1, 1.5], ["ETHUSDT", 0.3, 0.01, 2.0]] as const) {
    const spot = bySymbol.get(symbol)!;
    const mk = spot.fair * (1 + basis / 1e4);
    const markK = Math.round(mk / tick);
    const q = (e.fut * share) / mk;
    legs.push({
      symbol,
      spot,
      tick,
      markK,
      basis,
      idio: spot.idio,
      q,
      q0: q * (0.85 + rnd() * 0.3),
      mark0: mk * (1 - fd0 / Math.max(500, e.inv) + gauss() * 2e-3),
      qLive0: q,
      markLive0: markK * tick,
      entry: mk * (1 + gauss() * 2e-3),
      cash: 0,
      fees: 0,
      funding: 0,
      fills: Math.round(eng2.fills * share),
      volume: eng2.fills * share * 260,
      hOff: (e.he - base.he) * share,
      row: null,
    });
  }

  // the 5 s series: each minute's points walk from the last close to this one
  const at = (m: number, k: keyof DeskMinute) => desk[k][m]! - (k === "inv" || k === "fut" ? 0 : base[k]);
  for (let m = d0; m < curMin; m++) {
    const p = m === d0 ? null : m - 1;
    // trading PnL wanders inside the minute (a bridge pinned to its open and close), the levels move straight
    const walk: number[] = [];
    let x = 0;
    const sd = (desk.hx[m]! + desk.lx[m]!) * 0.35 + 0.01;
    for (let k = 0; k < 12; k++) walk.push((x += gauss() * sd));
    for (let k = 0; k < 12; k++) {
      const w = (k + 1) / 12;
      const lerp = (key: keyof DeskMinute) => (p == null ? at(m, key) * w : at(p, key) + (at(m, key) - at(p, key)) * w);
      const pi = lerp("pi") + walk[k]! - walk[11]! * w;
      const pnl = pi + lerp("he") + lerp("ot");
      series.push({
        t: dayStart + (m - d0) * MIN + k * SLOT,
        equity: BASE_EQUITY + pnl,
        pnl_day: pnl,
        trading: pi,
        hedged: pi - lerp("fd"),
        inventory: lerp("inv"),
        futures_notional: lerp("fut"),
      });
    }
  }

  // the fills tape: the most recent minutes' fills, in clusters, summing to each minute's count and volume
  const tape: Fill[] = [];
  for (let m = curMin - 1; m >= d0 && tape.length < 2000; m--) {
    const n = desk.fills[m]!;
    const inMin: Fill[] = [];
    while (inMin.length < n) {
      const i = pickByWeight();
      const side: "buy" | "sell" = rnd() < 0.5 ? "buy" : "sell";
      let t = dayStart + (m - d0) * MIN + Math.floor(rnd() * 55_000);
      let c = 1;
      while (rnd() < 0.6 && c < 9) c++;
      for (let k = 0; k < c && inMin.length < n; k++) {
        inMin.push(pastFill(i, side, t));
        t += Math.floor(expo(350));
      }
    }
    const scale = desk.vol[m]! / (sumOf(inMin, (f) => f.notional) || 1);
    for (const f of inMin) {
      f.notional *= scale;
      f.qty = f.notional / f.price;
      f.fee *= scale;
    }
    tape.push(...inMin.sort((a, b) => b.ts - a.ts));
  }
  fills = tape.slice(0, 2000);
  for (const f of fills) {
    const i = bySymbol.get(f.symbol)!;
    i.last = Math.max(i.last ?? 0, f.ts);
    if (now - f.ts < 300_000) pending.push({ f, i });
  }
  // the hourly markouts so far
  for (let h = 0; h < new Date(now).getUTCHours(); h++) {
    const b = byHourMk[h]!;
    const a = minuteActivity(d0 + h * 60 + 30);
    b.mk10 = 0.6 + 0.3 * a + gauss() * 0.7;
    b.mk60 = 0.3 + 0.2 * a + gauss() * 1.1;
  }

  for (const i of insts) ensureQuotes(i);
  eng1.orders = Math.round(fills0 * 6.1);
  eng1.cancels = Math.round(fills0 * 5.7);
  eng1.fills = fills0;
  eng1.fees = vol0 * MAKER_BPS * 1e-4 * 1.04;
  eng1.venue = 35;
  for (const a of ACCOUNTS) orderAdds[a.id] = [];

  alerts.push(
    { id: "a1", rule: "user_stream", level: "warn", text: "main usdm user stream reconnected 3 times in the last hour", since: now - 47_000, active: true },
    { id: "a2", rule: "dust", level: "info", text: "sub-c holds 0.31 DOT, below 5 USDT min notional", since: now - 3.2 * H, active: true },
    { id: "a3", rule: "stream_down", level: "crit", text: "sub-a spot user stream down 14 s", since: now - 1.4 * H, active: false },
    { id: "a4", rule: "markout", level: "warn", text: "30-min 10 s markout −1.3 bps over 41 fills", since: now - 5.6 * H, active: false },
  );
}

function pastFill(i: Inst, side: "buy" | "sell", ts: number): Fill {
  const s = side === "buy" ? 1 : -1;
  const ageS = (now - ts) / 1000;
  const mid = midOf(i) * Math.exp(gauss() * 4e-4 * Math.sqrt(ageS / 600 + 0.05));
  const edge = 1.6 + gauss() * 1.4;
  const price = Math.round((mid * (1 - (s * edge) / 1e4)) / tickOf(i)) * tickOf(i);
  const notional = clipNotional();
  const maker = rnd() < 0.96;
  const mk: Markouts = {
    "1": ageS >= 1 ? edge * 0.8 + gauss() * 0.8 : null,
    "10": ageS >= 10 ? edge * 0.55 + gauss() * 2 : null,
    "60": ageS >= 60 ? edge * 0.3 + gauss() * 4 : null,
    "300": ageS >= 300 ? edge * 0.1 + gauss() * 8 : null,
  };
  const raw = { ...mk };
  const fast = { ...mk };
  for (const h of HORIZONS) {
    if (mk[h] == null) continue;
    raw[h] = mk[h]! + gauss() * (i.ref ? 1.5 : 0.3);
    fast[h] = mk[h]! + 0.4 * (raw[h]! - mk[h]!);
  }
  return {
    id: `${i.account}-${i.symbol}-${++fillSeq}`,
    ts,
    account: i.account,
    symbol: i.symbol,
    venue: "spot",
    side,
    price,
    qty: notional / price,
    notional,
    fee: (notional * (maker ? MAKER_BPS : TAKER_BPS)) / 1e4,
    fee_asset: side === "buy" ? i.symbol.replace(/USDT$/, "") : "USDT",
    maker,
    fair: mid,
    edge_bps: edge,
    mk,
    mk_raw: raw,
    mk_fast: fast,
  };
}

// ---- the desk's numbers ----
function pnlParts() {
  const trading = sumOf(insts, tradingOf);
  const mm = sumOf(insts, (i) => i.mm);
  const fd = sumOf(insts, (i) => i.fd);
  const hedge = sumOf(legs, legPnl);
  const floating = sumOf(insts, (i) => (i.cost != null ? i.inv * (midOf(i) - i.cost) : 0));
  return { trading, mm, fd, hedge, floating, pnlDay: trading + hedge + other };
}

function deskRow(): DeskMinute {
  const p = pnlParts();
  return {
    pi: base.pi + p.trading,
    mm: base.mm + p.mm,
    re: base.re + p.trading - p.floating,
    he: base.he + p.hedge,
    ot: base.ot + other,
    fd: base.fd + p.fd,
    inv: sumOf(insts, invValue),
    fut: futNotional(),
    vol: minVol,
    fills: minFills,
    hx: Math.max(0, minHi - Math.max(minOpen, p.pnlDay)),
    lx: Math.max(0, Math.min(minOpen, p.pnlDay) - minLo),
  };
}

function sessionsFor(ds: number) {
  return [
    { name: "asia", start: ds + 0 * H, end: ds + 7 * H },
    { name: "europe", start: ds + 7 * H, end: ds + 13.5 * H },
    { name: "americas", start: ds + 13.5 * H, end: ds + 20 * H },
  ];
}
function eventsFor(ds: number) {
  return [0, 8, 16].map((h) => ({ name: "funding", at: ds + h * H }));
}

let mkNet1h: number | null = null;
function windowSum(minutes: number) {
  let f = minFills;
  let v = minVol;
  for (let m = Math.max(0, curMin - minutes); m < curMin; m++) {
    f += desk.fills[m] ?? 0;
    v += desk.vol[m] ?? 0;
  }
  return { fills: f, volume: v };
}

function summary(): Summary {
  const ds = dayStart;
  const sessions = sessionsFor(ds);
  const events = eventsFor(ds);
  const cur = sessions.find((s) => now >= s.start && now < s.end) ?? null;
  const upcoming: { name: string; at: number }[] = [];
  for (const s of sessions) upcoming.push({ name: `${s.name} opens`, at: s.start }, { name: `${s.name} closes`, at: s.end });
  for (const e of events) upcoming.push(e);
  upcoming.push({ name: "funding", at: ds + 24 * H });
  const next = upcoming.filter((e) => e.at > now).sort((a, b) => a.at - b.at)[0] ?? null;
  const p = pnlParts();
  const hourAgo = series[Math.floor((now - H - ds) / SLOT)];
  const fillsDay = sumOf(insts, (i) => i.fills);
  const volumeDay = sumOf(insts, (i) => i.volume);
  const invVal = sumOf(insts, invValue);
  const h1 = windowSum(60);
  const d1 = windowSum(1440);
  const elapsed = Math.floor((now - ds) / 1000);
  return {
    equity: BASE_EQUITY + p.pnlDay,
    pnl_day: p.pnlDay,
    pnl_1h: p.pnlDay - (hourAgo?.pnl_day ?? 0),
    other,
    pnl: {
      trading: p.trading,
      trading_se: 3.2 + Math.sqrt(fillsDay) * 0.012,
      hedged: p.trading - p.fd,
      hedged_se: 1.4 + Math.sqrt(fillsDay) * 0.005,
      factor: p.trading - 0.8 * p.fd,
      factor_se: 2.6 + Math.sqrt(fillsDay) * 0.009,
      ref_hedge: p.fd,
      factor_hedge: 0.8 * p.fd,
      liquidation: invVal * 0.0006,
      covered_s: Math.max(0, elapsed - 2400),
      backfilled_s: Math.min(2400, elapsed),
      realized: p.trading - p.floating - realizedOld,
      realized_old: realizedOld,
      floating: p.floating,
      mm: p.mm,
      mm_spread: mmSpread0 + mmLiveSpread,
      inventory: p.trading - p.mm,
    },
    markout_net_bps_1h: mkNet1h,
    fills_1h: h1.fills,
    fills_day: fillsDay,
    volume_day: volumeDay,
    fills_24h: d1.fills,
    volume_24h: d1.volume,
    inventory_value: invVal,
    inventory_assets: insts.filter((i) => invValue(i) >= 1).length,
    fee_expiry: null,
    day_start: ds,
    sessions,
    events,
    session: { name: cur?.name ?? null, open: cur != null, next_event: next?.name ?? null, next_event_at: next?.at ?? null },
  };
}

function symbolRow(i: Inst): SymbolRow {
  const mid = midOf(i);
  const tr = tradingOf(i);
  const fl = i.cost != null ? i.inv * (mid - i.cost) : 0;
  const best = (side: "buy" | "sell") => {
    const ds = i.orders.filter((o) => o.side === side).map((o) => distOf(i, side, o.o.price));
    return ds.length ? Math.min(...ds) : null;
  };
  const avg = (h: "10" | "60" | "300") => (i.mk[h][1] > 0 ? i.mk[h][0] / i.mk[h][1] : null);
  return {
    symbol: i.symbol,
    venue: "spot",
    reference: i.ref ? i.symbol : null,
    mid,
    ref_mid: i.ref ? i.refMid : null,
    spread_bps: ((i.spreadTicks * i.tick) / mid) * 1e4,
    basis_bps: i.ref ? (mid / i.refMid - 1) * 1e4 : null,
    inv_qty: i.inv,
    inv_value: i.inv * mid,
    avg_cost: i.cost,
    upnl: i.cost != null ? fl : null,
    fills_day: i.fills,
    buys_day: i.buys,
    sells_day: i.sells,
    volume_day: i.volume,
    edge_bps: i.edgeN > 0 ? i.edgeW / i.edgeN : null,
    mk10_bps: avg("10"),
    mk60_bps: avg("60"),
    mk300_bps: avg("300"),
    trading_pnl: tr,
    hedged_pnl: tr - i.fd,
    realized_pnl: tr - fl,
    float_pnl: fl,
    mm_pnl: i.mm,
    inv_pnl: tr - i.mm,
    open_bids: i.orders.filter((o) => o.side === "buy").length,
    open_asks: i.orders.filter((o) => o.side === "sell").length,
    bid_dist_bps: best("buy"),
    ask_dist_bps: best("sell"),
    last_fill: i.last,
    dust: i.symbol === "DOTUSDT",
    fair: i.fair,
    bid: bidOf(i),
    ask: askOf(i),
  };
}

function legRow(l: Leg): SymbolRow {
  const mark = legMark(l);
  return {
    symbol: l.symbol,
    venue: "usdm",
    reference: null,
    mid: mark,
    ref_mid: null,
    spread_bps: (l.tick / mark) * 1e4,
    basis_bps: null,
    inv_qty: l.q,
    inv_value: l.q * mark,
    avg_cost: l.entry,
    upnl: l.q * (mark - l.entry),
    fills_day: l.fills,
    buys_day: Math.ceil(l.fills / 2),
    sells_day: Math.floor(l.fills / 2),
    volume_day: l.volume,
    edge_bps: null,
    mk10_bps: null,
    mk60_bps: null,
    mk300_bps: null,
    trading_pnl: 0,
    hedged_pnl: 0,
    realized_pnl: 0,
    float_pnl: 0,
    mm_pnl: 0,
    inv_pnl: 0,
    open_bids: hedgeOrder?.leg === l && hedgeOrder.qty > 0 ? 1 : 0,
    open_asks: hedgeOrder?.leg === l && hedgeOrder.qty < 0 ? 1 : 0,
    bid_dist_bps: null,
    ask_dist_bps: null,
    last_fill: null,
    dust: false,
    fair: mark,
    bid: (l.markK - 0.5) * l.tick,
    ask: (l.markK + 0.5) * l.tick,
  };
}

function symbols(): SymbolRow[] {
  const out: SymbolRow[] = [];
  for (const i of insts) out.push((i.row ??= symbolRow(i)));
  for (const l of legs) out.push((l.row ??= legRow(l)));
  return out;
}

function allOrders(): OpenOrder[] {
  const out: OpenOrder[] = [];
  for (const i of insts) for (const o of i.orders) out.push(o.o);
  if (hedgeOrder) out.push(hedgeOrder.o);
  return out;
}

// Accounts revalue on their own events (a fill, an order sent) and otherwise now and then, as the server's
// balance reads do; between those an account's row stands still.
const acctCache = new Map<string, Account>();
const acctStream: Record<string, "up" | "down"> = {};
function account(a: (typeof ACCOUNTS)[number]): Account {
  const mine = insts.filter((i) => i.account === a.id);
  const isMain = a.id === "main";
  const pnl = sumOf(mine, tradingOf) + (isMain ? sumOf(legs, legPnl) + other : 0);
  const inv = sumOf(mine, invValue);
  const futU = isMain ? sumOf(legs, (l) => l.q * (legMark(l) - l.entry)) : 0;
  const futW = isMain ? 6200 + sumOf(legs, (l) => l.cash + l.q * l.entry - l.qLive0 * l.entry) : 0;
  const equity = a.base + a.transfers + pnl;
  const quote = equity - inv - futW - futU;
  const orders = mine.flatMap((i) => i.orders);
  const bidsN = sumOf(orders.filter((o) => o.side === "buy"), (o) => o.o.notional);
  const asksN = sumOf(orders.filter((o) => o.side === "sell"), (o) => o.o.notional);
  const adds = (orderAdds[a.id] ?? []).filter((t) => t > now - 10_000);
  orderAdds[a.id] = adds;
  const free = Math.max(0, quote - bidsN);
  return {
    id: a.id,
    label: a.id,
    email: `${a.id.replace("-", "")}@example.com`,
    role: a.role,
    equity,
    equity_open: a.base,
    pnl_day: pnl,
    transfers_day: a.transfers,
    quote_free: free,
    quote_locked: quote - free,
    inventory_value: inv,
    fut_wallet: futW,
    fut_upnl: futU,
    fut_available: futW * 0.62,
    positions: isMain
      ? legs.map((l) => ({
          symbol: l.symbol,
          amt: l.q,
          entry: l.entry,
          mark: legMark(l),
          upnl: l.q * (legMark(l) - l.entry),
          notional: l.q * legMark(l),
          pnl_day: legPnl(l),
        }))
      : [],
    orders_10s: adds.length,
    orders_10s_limit: 100,
    orders_1d: (isMain ? 2_400 : 38_000) + eng1.orders / 4 + adds.length,
    orders_1d_limit: 160_000,
    open_orders: orders.length + (isMain && hedgeOrder ? 1 : 0),
    bids_notional: bidsN,
    asks_notional: asksN,
    utilization: bidsN + free > 0 ? bidsN / (bidsN + free) : 0,
    fees: [
      { venue: "spot", maker_bps: MAKER_BPS, taker_bps: TAKER_BPS, changed: false },
      ...(isMain ? [{ venue: "usdm" as const, maker_bps: 2.0, taker_bps: 5.0, changed: false }] : []),
    ],
    user_stream: acctStream[a.id] ?? "up",
    updated: now,
  };
}
function accounts(): Account[] {
  return ACCOUNTS.map((a) => {
    const cur = acctCache.get(a.id);
    const stale = cur && (cur.orders_10s > 0 ? (orderAdds[a.id] ?? []).some((t) => t <= now - 10_000) : false);
    if (!cur || acctTouched.has(a.id) || stale || rnd() < 0.1) {
      const fresh = account(a);
      acctCache.set(a.id, fresh);
      return fresh;
    }
    return cur;
  });
}

let fundingCache: Exposure["funding"] = [];
function exposure(acc: Account[]): Exposure {
  const spot = sumOf(insts, invValue);
  const fut = futNotional();
  const bv = betaValue();
  const target = -bv;
  const p = pnlParts();
  const hedge = p.hedge;
  const drift = p.trading - p.mm;
  const fees = sumOf(legs, (l) => l.fees);
  const funding = sumOf(legs, (l) => l.funding);
  return {
    spot_value: spot,
    futures_notional: fut,
    net: spot + fut,
    target,
    band: BAND(target),
    gap: target - fut,
    by_account: acc.map((a) => {
      const f = a.positions.reduce((s, x) => s + x.notional, 0);
      return { account: a.id, spot_value: a.inventory_value, futures_notional: f, net: a.inventory_value + f };
    }),
    funding: fundingCache,
    beta_value: bv,
    hedge_notional: fut,
    ratio: 1,
    paused: null,
    paused_until: null,
    beta_source: "estimate",
    hedge_day: {
      inventory_drift: drift,
      factor_drift: p.fd,
      residual_drift: drift - p.fd,
      hedge_pnl: hedge,
      price_pnl: hedge + fees - funding,
      fees,
      funding,
      offset_factor: p.fd !== 0 ? -hedge / p.fd : null,
      offset_total: drift !== 0 ? -hedge / drift : null,
      net: drift + hedge,
      legs: legs.map((l) => ({
        symbol: l.symbol,
        qty0: l.q0,
        qty: l.q,
        mark0: l.mark0,
        mark: legMark(l),
        fills: l.fills,
        price_pnl: legPnl(l) + l.fees - l.funding,
        fees: l.fees,
        funding: l.funding,
        pnl: legPnl(l),
      })),
    },
  };
}

// ---- engines and feeds: scraped about once a second ----
const lat = (p50: number, p99: number) => ({ p50, p99 });
const lat1 = [lat(3.1, 11.4), lat(1.2, 4.6), lat(2150, 7900), lat(1950, 7000)];
const lat2 = [lat(2.4, 8.8), lat(0.9, 3.7), lat(3100, 9800), lat(2900, 9100)];
const LAT_NAMES = ["md to decision", "decision to send", "order ack", "cancel ack"];
function jitter(xs: { p50: number; p99: number }[], base: { p50: number; p99: number }[]) {
  xs.forEach((x, k) => {
    x.p50 += (base[k]!.p50 - x.p50) * 0.1 + base[k]!.p50 * gauss() * 0.02;
    x.p99 += (base[k]!.p99 - x.p99) * 0.1 + base[k]!.p99 * gauss() * 0.04;
  });
}
const LAT1_BASE = lat1.map((x) => ({ ...x }));
const LAT2_BASE = lat2.map((x) => ({ ...x }));
let engineCache: Engine[] = [];
function engines(): Engine[] {
  jitter(lat1, LAT1_BASE);
  jitter(lat2, LAT2_BASE);
  if (rnd() < 0.02) {
    eng1.venue++;
    rejects1[0]!.count++;
  }
  const hedge = sumOf(legs, legPnl);
  const p = pnlParts();
  return [
    {
      name: "engine-1",
      url: "http://127.0.0.1:9464/metrics",
      up: true,
      stale_s: 0.05 + rnd() * 0.3,
      state: "running",
      strategy: "mm",
      orders: eng1.orders,
      cancels: eng1.cancels,
      fills: eng1.fills,
      risk_rejects: eng1.risk,
      venue_rejects: eng1.venue,
      rejects: rejects1.map((r) => ({ ...r })),
      realized: p.trading - p.floating,
      unrealized: p.floating,
      fees: eng1.fees,
      max_loss: 300,
      kill: false,
      kill_reason: null,
      latency: lat1.map((x, k) => ({ name: LAT_NAMES[k]!, p50_us: x.p50, p99_us: x.p99 })),
      venues: [{ name: "binance spot", md: "up", user: "up", order: "up", reconnects: 1, cooldowns: 0, rest_errors: 2 }],
    },
    {
      name: "hedge-1",
      url: "http://127.0.0.1:9465/metrics",
      up: true,
      stale_s: 0.05 + rnd() * 0.3,
      state: "running",
      strategy: "hedge",
      orders: eng2.orders,
      cancels: eng2.cancels,
      fills: eng2.fills,
      risk_rejects: eng2.risk,
      venue_rejects: eng2.venue,
      rejects: rejects2.map((r) => ({ ...r })),
      realized: hedge - sumOf(legs, (l) => l.q * (legMark(l) - l.entry)),
      unrealized: sumOf(legs, (l) => l.q * (legMark(l) - l.entry)),
      fees: sumOf(legs, (l) => l.fees),
      max_loss: 150,
      kill: false,
      kill_reason: null,
      latency: lat2.map((x, k) => ({ name: LAT_NAMES[k]!, p50_us: x.p50, p99_us: x.p99 })),
      venues: [
        { name: "binance usdm", md: "up", user: acctStream.main === "down" ? "down" : "up", order: "up", reconnects: 3, cooldowns: 0, rest_errors: 1 },
        { name: "binance spot", md: "up", user: "n/a", order: "n/a", reconnects: 0, cooldowns: 0, rest_errors: 0 },
      ],
    },
  ];
}

const feedState: Feed[] = [
  { name: "spot bookTicker 1/1", kind: "public", up: true, msgs_per_s: 0, last: null, detail: `${SPOT.length} streams` },
  { name: "usdm bookTicker 1/1", kind: "public", up: true, msgs_per_s: 0, last: null, detail: `${SPOT.filter((s) => s[2]).length} streams` },
  { name: "usdm markPrice", kind: "public", up: true, msgs_per_s: 0, last: null, detail: "2 streams @1s" },
  ...ACCOUNTS.map((a): Feed => ({ name: `${a.id} spot user`, kind: "user", up: true, msgs_per_s: 0, last: null, detail: "ws-api" })),
  { name: "main usdm user", kind: "user", up: true, msgs_per_s: 0, last: null, detail: "listenKey" },
  { name: "spot rest", kind: "rest", up: true, msgs_per_s: 0, last: null, detail: "" },
  { name: "usdm rest", kind: "rest", up: true, msgs_per_s: 0, last: null, detail: "" },
  { name: "engine-1 metrics", kind: "engine", up: true, msgs_per_s: 1, last: null, detail: "127.0.0.1:9464" },
  { name: "hedge-1 metrics", kind: "engine", up: true, msgs_per_s: 1, last: null, detail: "127.0.0.1:9465" },
];
function feeds(): Feed[] {
  const a = activityNow();
  for (const f of feedState) {
    if (f.kind === "public") {
      f.msgs_per_s = f.name.startsWith("usdm markPrice") ? 2 : Math.round((90 + rnd() * 60) * a);
      f.last = now - Math.floor(rnd() * 40);
    } else if (f.kind === "user") {
      const id = f.name.split(" ")[0]!;
      f.up = acctStream[id] !== "down";
      const adds = (orderAdds[id] ?? []).filter((t) => t > now - 10_000).length;
      f.msgs_per_s = f.up ? Math.round((adds / 10) * 2.2 * 10) / 10 : 0;
      if (f.up && adds) f.last = Math.max(...orderAdds[id]!);
    } else if (f.kind === "rest") {
      f.msgs_per_s = 0.3;
      if (rnd() < 0.3) f.last = now - Math.floor(rnd() * 500);
      f.detail = f.name.startsWith("spot") ? `weight ${300 + Math.floor(rnd() * 200)} / 6000` : `weight ${40 + Math.floor(rnd() * 40)} / 2400`;
    } else {
      f.last = now - Math.floor(rnd() * 300);
    }
  }
  return feedState.map((f) => ({ ...f }));
}

/** Markout curves from the tape's matured fills, recomputed every few seconds as the server does. */
function markouts(): MarkoutStats {
  const acc = (pick: (f: Fill) => Markouts, keep: (f: Fill) => boolean) =>
    HORIZONS.map((h) => {
      let s = 0;
      let w = 0;
      for (const f of fills) {
        const v = pick(f)[h];
        if (v == null || !keep(f)) continue;
        s += v * f.notional;
        w += f.notional;
      }
      return w > 0 ? s / w : null;
    });
  const all = acc((f) => f.mk, () => true);
  const matured = HORIZONS.map((h) => fills.filter((f) => f.mk[h] != null).length);
  const fillsDay = sumOf(insts, (i) => i.fills);
  const hNow = new Date(now).getUTCHours();
  return {
    horizons: [1, 10, 60, 300],
    all,
    buys: acc((f) => f.mk, (f) => f.side === "buy"),
    sells: acc((f) => f.mk, (f) => f.side === "sell"),
    raw: acc((f) => f.mk_raw, () => true),
    fast: acc((f) => f.mk_fast, () => true),
    by_hour: byHourMk.map((b, hour) => {
      const s = d0 + hour * 60;
      const e = Math.min(s + 59, curMin);
      let n = 0;
      for (let m = s; m <= e && hour <= hNow; m++) n += desk.fills[m] ?? 0;
      if (hour === hNow) n += minFills;
      const mm = hour <= hNow ? (desk.mm[e] ?? 0) - (desk.mm[s - 1] ?? 0) : 0;
      return {
        hour,
        fills: n,
        mk10: b.w10 > 0 ? (b.s10 + (b.mk10 ?? 0) * 1e3) / (b.w10 + (b.mk10 != null ? 1e3 : 0)) : b.mk10,
        mk60: b.w60 > 0 ? (b.s60 + (b.mk60 ?? 0) * 1e3) / (b.w60 + (b.mk60 != null ? 1e3 : 0)) : b.mk60,
        pnl: mm,
      };
    }),
    toxicity: {
      horizons_s: [0, 0.2, 1, 60, 300],
      bps: [all[0] != null ? all[0] * 0.2 : null, all[0] != null ? all[0] * 0.9 : null, all[0] ?? null, all[2] ?? null, all[3] ?? null],
      fills: [fillsDay, fillsDay, fillsDay - (fills.length - matured[0]!), fillsDay - (fills.length - matured[2]!), fillsDay - (fills.length - matured[3]!)],
    },
  };
}

function hours(): HourPnl[] {
  const out: HourPnl[] = [];
  for (let h = 0; d0 + h * 60 <= curMin; h++) {
    const s = d0 + h * 60;
    const e = Math.min(s + 59, curMin);
    const d = (k: keyof DeskMinute) => (desk[k][e] ?? desk[k][e - 1]!) - desk[k][s - 1]!;
    let fl = 0;
    let vol = 0;
    for (let m = s; m <= e; m++) {
      fl += desk.fills[m] ?? 0;
      vol += desk.vol[m] ?? 0;
    }
    const tr = d("pi");
    const mm = d("mm");
    out.push({ t: dayStart + h * H, trading: tr, hedged: tr - d("fd"), factor: tr - 0.8 * d("fd"), mm, inventory: tr - mm, fills: fl, volume: vol });
  }
  return out;
}

const pastDays: DayPnl[] = [];
function buildDays() {
  for (let k = 20; k >= 1; k--) {
    const s = d0 - k * 1440;
    const e = s + 1439;
    if (s < 1) continue;
    const d = (key: keyof DeskMinute) => desk[key][e]! - desk[key][s - 1]!;
    let fl = 0;
    let vol = 0;
    for (let m = s; m <= e; m++) {
      fl += desk.fills[m]!;
      vol += desk.vol[m]!;
    }
    const tr = d("pi");
    const kept = k <= 3;
    pastDays.push({
      day: new Date(dayStart - k * 24 * H).toISOString().slice(0, 10),
      trading: tr,
      trading_se: 6 + rnd() * 4,
      hedged: tr - d("fd"),
      hedged_se: 2.5 + rnd() * 2,
      factor: tr - 0.8 * d("fd"),
      factor_se: 5 + rnd() * 3,
      fills: fl,
      volume: vol,
      covered_s: k === 9 ? 70_200 : 86_400 - Math.floor(rnd() * 300),
      backfilled_s: k === 9 ? 16_200 : 0,
      pnl_day: kept ? tr + d("he") + d("ot") : null,
      realized: kept ? d("re") : null,
      realized_old: kept ? tr * 0.08 : null,
      floating: kept ? tr - d("re") : null,
      hedge: kept ? d("he") : null,
      other: kept ? d("ot") : null,
      mm: kept ? d("mm") : null,
      inventory: kept ? tr - d("mm") : null,
    });
  }
}
function days(sum: Summary): DayPnl[] {
  const p = sum.pnl;
  const today: DayPnl = {
    day: new Date(dayStart).toISOString().slice(0, 10),
    trading: p.trading,
    trading_se: p.trading_se,
    hedged: p.hedged,
    hedged_se: p.hedged_se,
    factor: p.factor,
    factor_se: p.factor_se,
    fills: sum.fills_day,
    volume: sum.volume_day,
    covered_s: p.covered_s,
    backfilled_s: p.backfilled_s,
    pnl_day: sum.pnl_day,
    realized: p.realized,
    realized_old: p.realized_old,
    floating: p.floating,
    hedge: sumOf(legs, legPnl),
    other: sum.other,
    mm: p.mm,
    inventory: p.inventory,
  };
  return pastDays.concat(today);
}

// per-account day PnL on the 45 s grid: each account's share of the desk, bridged to where it stands now
function accountSeriesHistory(acc: Account[]): AccountSeries[] {
  const grid = series.filter((p) => p.t % ACCT_STEP === 0);
  const last = series[series.length - 1]?.pnl_day ?? 0;
  const span = Math.max(1, (grid[grid.length - 1]?.t ?? dayStart) - dayStart);
  return acc.map((a) => {
    const share = (ACCOUNTS.find((x) => x.id === a.id)!.base) / BASE_EQUITY;
    const off = a.pnl_day - share * last;
    let walk = 0;
    const w: number[] = grid.map(() => (walk += gauss() * 0.25));
    const wEnd = w[w.length - 1] ?? 0;
    const pnl = grid.map((p, k) => {
      const f = (p.t - dayStart) / span;
      return share * p.pnl_day + off * f + w[k]! - wEnd * f;
    });
    return { account: a.id, t: grid.map((p) => p.t), pnl_day: pnl, equity: pnl.map((v) => a.equity_open + v) };
  });
}

function snapshot(): Snapshot {
  const sum = summary();
  const acc = ACCOUNTS.map((a) => {
    const x = account(a);
    acctCache.set(a.id, x);
    return x;
  });
  engineCache = engines();
  fundingCache = funding();
  return {
    now,
    summary: sum,
    accounts: acc,
    symbols: symbols(),
    fills: fills.slice(0, 2000),
    series: series.slice(),
    exposure: exposure(acc),
    engines: engineCache,
    alerts: alerts.map((a) => ({ ...a })),
    feeds: feeds(),
    markouts: markouts(),
    orders: allOrders(),
    days: days(sum),
    hours: hours(),
    account_series: accountSeriesHistory(acc),
  };
}
function funding(): Exposure["funding"] {
  return legs.map((l) => ({
    symbol: l.symbol,
    rate: 0.0001 + Math.sin(now / 1e7 + l.basis) * 0.00004,
    next: dayStart + Math.ceil((now - dayStart + 1) / (8 * H)) * 8 * H,
    position: l.q,
  }));
}

// ---- live loop ----
export function startMock(emit: Emit): () => void {
  buildUniverse();
  buildHistory();
  buildDays();
  minOpen = minHi = minLo = pnlParts().pnlDay;
  emit({ type: "snapshot", data: snapshot() });
  let tick = 0;
  let lastSlot = series.length ? series[series.length - 1]!.t : dayStart - SLOT;
  let nextScrape = now + 1000;
  let nextMarkouts = now + 3000;
  const iv = setInterval(() => {
    now = Date.now();
    tick++;
    acctTouched.clear();
    const a = activityNow();
    regime = 0.997 * regime + 0.03 * gauss();
    const intensity = a * Math.exp(regime - 0.3);

    // minute rollover: close the last minute in the history, start counting the new one
    const m = minuteOf(now);
    if (m !== curMin) {
      writeLive(curMin, deskRow());
      curMin = m;
      minVol = 0;
      minFills = 0;
      minOpen = minHi = minLo = pnlParts().pnlDay;
      deskDirty = true;
    }

    // the market factor moves most ticks; names re-mark on their own clocks
    lvr = 0.9995 * lvr + 0.007 * gauss();
    if (rnd() < 0.7) F += gauss() * 0.02e-4 * Math.exp(lvr);
    D *= 1 - 1 / (25 * 480);
    if (rnd() < (0.003 * a) / 480) D -= (1.5 + 4 * rnd()) / Math.max(500, sumOf(insts, invValue));
    for (const i of insts) {
      const hot = now < i.hotUntil ? 4 : 1;
      if (rnd() < i.rate * hot * Math.sqrt(a) * (TICK / 1000) * 1.1) mark(i);
    }
    for (const l of legs) {
      if (rnd() < 0.2) {
        // the perp follows the market factor, not the spot book's own noise
        l.idio += gauss() * 0.03e-4;
        const k = Math.round(Math.exp(l.spot.logBase + l.spot.beta * F + l.idio + l.basis / 1e4) / l.tick);
        if (k !== l.markK) {
          l.markK = k;
          l.row = null;
          acctTouched.add("main");
        }
      }
    }

    // fills: clusters start now and then; their later fills land on the following ticks
    if (rnd() < 0.65 * intensity * (TICK / 1000)) startCluster();
    const newFills: Fill[] = [];
    for (let k = due.length - 1; k >= 0; k--) {
      const d = due[k]!;
      if (d.at > now) continue;
      due.splice(k, 1);
      const f = newFill(d.i, d.side);
      if (f) {
        newFills.push(f);
        pending.push({ f, i: d.i });
      }
    }
    // requotes after fills, one tick later
    if (!newFills.length) {
      for (const i of requote) ensureQuotes(i);
      requote.clear();
    }
    if (newFills.length) fills = newFills.reverse().concat(fills).slice(0, 2000);
    const updated = mature();
    const out = newFills.concat(updated);
    if (out.length) emit({ type: "fills", data: out });

    hedger();

    // a stream flap on sub-a now and then
    if (tick % 4800 === 1200) acctStream["sub-a"] = "down";
    if (tick % 4800 === 1310) acctStream["sub-a"] = "up";

    // the 5 s series point, and the history's current minute
    const slot = now - (now % SLOT);
    const newSlot = slot > lastSlot;
    if (newSlot) {
      lastSlot = slot;
      other += gauss() * 0.002;
      const p = pnlParts();
      const pt: SeriesPoint = {
        t: slot,
        equity: BASE_EQUITY + p.pnlDay,
        pnl_day: p.pnlDay,
        trading: p.trading,
        hedged: p.trading - p.fd,
        inventory: sumOf(insts, invValue),
        futures_notional: futNotional(),
      };
      series.push(pt);
      emit({ type: "series", data: [pt] });
      if (slot % ACCT_STEP === 0) {
        const acc = ACCOUNTS.map(account);
        emit({ type: "account_series", data: acc.map((x) => ({ account: x.id, t: [slot], equity: [x.equity], pnl_day: [x.pnl_day] })) });
      }
    }
    {
      const d = pnlParts().pnlDay;
      minHi = Math.max(minHi, d);
      minLo = Math.min(minLo, d);
    }
    if (newSlot || deskDirty) {
      writeLive(curMin, deskRow());
      deskDirty = false;
    }

    // the patch: every tick the desk's live parts; the scraped parts when scraped
    const sum = summary();
    const acc = accounts();
    const patch: Partial<Snapshot> = {
      now,
      summary: sum,
      symbols: symbols(),
      orders: allOrders(),
      accounts: acc,
      exposure: exposure(acc),
      hours: hours(),
    };
    if (now >= nextScrape) {
      nextScrape = now + 900 + rnd() * 200;
      for (const l of legs) l.funding += (l.q * legMark(l) * -0.0001) / 28_800; // accrues per second
      engineCache = engines();
      fundingCache = funding();
      patch.engines = engineCache;
      patch.feeds = feeds();
      patch.alerts = alerts.map((x) => ({ ...x }));
      const w = fills.filter((f) => f.ts > now - H && f.mk["10"] != null);
      const wn = sumOf(w, (f) => f.notional);
      mkNet1h = wn > 0 ? sumOf(w, (f) => f.mk["10"]! * f.notional) / wn : null;
    }
    if (now >= nextMarkouts) {
      nextMarkouts = now + 3000;
      patch.markouts = markouts();
    }
    if (newSlot) patch.days = days(sum);
    emit({ type: "patch", data: patch });
  }, TICK);
  return () => clearInterval(iv);
}
