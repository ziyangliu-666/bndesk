// Mirrors the wire protocol in DESIGN.md. Field names are the contract.

export type Msg =
  | { type: "snapshot"; data: Snapshot }
  | { type: "patch"; data: Partial<Snapshot> & { diff?: Diff } } // top-level keys replaced wholesale, or edited (diff)
  | { type: "fills"; data: Fill[] } // upsert by id
  | { type: "series"; data: SeriesPoint[] } // appended
  | { type: "account_series"; data: AccountSeries[] } // points appended per account
  | { type: "bars"; data: DayBars } // when a minute closes: the last minute bars, replaced by t
  | { type: "older"; data: Older }; // asked for with the text "older": what the WebSocket's snapshot left out

/** A patch's edits to the values the client has: for an object, the fields that changed; for a list, each changed
 *  row as [index, the fields that changed] (the list kept its length). Unchanged rows keep their objects. */
export type Diff = { [K in keyof Snapshot]?: Snapshot[K] extends unknown[] ? [number, Record<string, unknown>][] : Record<string, unknown> };

export interface Snapshot {
  now: number;
  summary: Summary;
  accounts: Account[];
  symbols: SymbolRow[];
  fills: Fill[]; // today's, newest first, at most 2000 (the newest 100 on the WebSocket, then `older`)
  series: SeriesPoint[]; // today's, 5 s grid (the last 15 minutes on the WebSocket; the store adds the minutes before from `bars`)
  exposure: Exposure;
  engines: Engine[];
  alerts: Alert[];
  feeds: Feed[];
  markouts: MarkoutStats;
  orders: OpenOrder[]; // every resting order across accounts
  days: DayPnl[]; // last 60, incl. today
  hours: HourPnl[]; // today's UTC hours
  account_series: AccountSeries[]; // today's, 45 s grid (the last 65 minutes on the WebSocket, then `older`)
  bars: DayBars; // today's minute bars
}

/** Today's desk at one minute, as columns: each minute's last series point (t = the minute's start), market
 *  making and the hedge legs' P&L as booked then, the notional filled in the minute. Money rounded to cents. */
export interface DayBars {
  t: number[];
  equity: number[];
  pnl_day: number[];
  trading: (number | null)[];
  mm: (number | null)[];
  hedge: (number | null)[];
  inventory: number[];
  futures: number[];
  volume: number[];
}

/** What the WebSocket's snapshot left out, as of that snapshot: fills newest first, account points ascending. */
export interface Older {
  fills: Fill[];
  account_series: AccountSeries[];
}

export interface AccountSeries {
  account: string;
  t: number[];
  equity: number[];
  pnl_day: number[];
}

export interface DayPnl {
  day: string;
  trading: number;
  trading_se: number | null;
  hedged: number;
  hedged_se: number | null;
  factor: number;
  factor_se: number | null;
  fills: number;
  volume: number;
  covered_s: number; // seconds booked live
  backfilled_s: number; // seconds booked from 1 min klines
  // the day's real-money split at its end; null before it was kept
  pnl_day: number | null;
  realized: number | null;
  realized_old: number | null;
  floating: number | null;
  hedge: number | null;
  rebates: number | null;
  other: number | null;
  mm: number | null;
  inventory: number | null;
}

export interface HourPnl {
  t: number;
  trading: number;
  hedged: number;
  factor: number;
  fills: number;
  volume: number;
  mm: number;
  inventory: number;
}

export interface PnlSummary {
  trading: number; // Π today
  trading_se: number | null;
  hedged: number; // S today
  hedged_se: number | null;
  factor: number; // A today
  factor_se: number | null;
  ref_hedge: number; // H
  factor_hedge: number; // Hm
  liquidation: number; // haircut now
  covered_s: number; // seconds booked live
  backfilled_s: number; // seconds booked from 1 min klines
  realized: number; // sells matched FIFO to today's buys, minus today's spot fees
  realized_old: number; // sells matched to the inventory held at the day start, against its opening price
  floating: number; // the inventory left, at its price now against its cost
  mm: number; // market making: Σ s q (M(t+60s) − p) − fee, own mid
  mm_spread: number; // the same at h = 0 against the fair at the fill
  inventory: number; // trading − mm
  mm_unmarked_fills: number; // fills past 60 s with no price 60 s after them (not even from klines): left out of mm
  mm_unmarked_notional: number; // their notional, USD
}

export interface OpenOrder {
  id: string;
  account: string;
  symbol: string;
  venue: "spot" | "usdm";
  side: "buy" | "sell";
  price: number;
  qty: number;
  notional: number;
  fair: number | null;
  dist_bps: number | null; // from fair, positive = passive
  since: number | null; // order creation time
}

export interface Summary {
  equity: number;
  pnl_day: number;
  pnl_1h: number;
  rebates: number; // market-maker rebates credited today
  other: number | null; // day PnL − Π − hedge legs' P&L − rebates
  pnl: PnlSummary;
  markout_net_bps_1h: number | null; // volume-weighted 10 s markout, net τ = 1 s, last hour
  fills_1h: number;
  fills_day: number;
  volume_day: number;
  fills_24h: number; // the 24 h to now, from the P&L hour blocks (tracked spot markets), the oldest prorated
  volume_24h: number;
  inventory_value: number;
  inventory_assets: number;
  fee_expiry: string | null;
  day_start: number; // epoch ms of the PnL day start
  sessions: { name: string; start: number; end: number }[]; // today's windows, epoch ms
  events: { name: string; at: number }[];
  session: { name: string | null; open: boolean; next_event: string | null; next_event_at: number | null };
}

export type Venue = "spot" | "usdm";

export interface Position {
  symbol: string;
  amt: number;
  entry: number;
  mark: number;
  upnl: number;
  notional: number;
  pnl_day: number | null; // today's price P&L at mark, minus fees, plus funding, on this account
}

export interface AccountFee {
  venue: Venue;
  maker_bps: number;
  taker_bps: number;
  changed: boolean;
}

export interface Account {
  id: string;
  label: string;
  email: string;
  role: "master" | "sub";
  equity: number;
  equity_open: number;
  pnl_day: number;
  transfers_day: number;
  quote_free: number;
  quote_locked: number;
  inventory_value: number;
  fut_wallet: number;
  fut_upnl: number;
  fut_available: number;
  positions: Position[];
  orders_10s: number;
  orders_10s_limit: number;
  orders_1d: number;
  orders_1d_limit: number;
  orders_source: "binance" | "stream"; // "stream": counted from the user stream, without rejected orders
  open_orders: number;
  bids_notional: number;
  asks_notional: number;
  utilization: number; // resting bids / (quote_free + resting bids)
  fees: AccountFee[];
  user_stream: "up" | "down" | "n/a";
  updated: number;
  rebates: number; // market-maker rebates credited today
}

export interface SymbolRow {
  symbol: string;
  venue: Venue;
  reference: string | null;
  mid: number | null;
  ref_mid: number | null;
  spread_bps: number | null;
  basis_bps: number | null;
  inv_qty: number;
  inv_value: number;
  avg_cost: number | null;
  upnl: number | null;
  fills_day: number;
  buys_day: number;
  sells_day: number;
  volume_day: number;
  edge_bps: number | null;
  mk10_bps: number | null; // volume-weighted, net τ = 1 s if available
  mk60_bps: number | null;
  mk300_bps: number | null;
  trading_pnl: number; // Π_k today
  hedged_pnl: number; // S_k today
  realized_pnl: number; // today: Π_k = realized + float, FIFO
  float_pnl: number;
  mm_pnl: number;
  inv_pnl: number;
  open_bids: number;
  open_asks: number;
  bid_dist_bps: number | null; // best own order vs fair
  ask_dist_bps: number | null;
  last_fill: number | null;
  dust: boolean;
  fair: number | null;
  bid: number | null; // market best bid
  ask: number | null; // market best ask
}

export interface Markouts {
  "1": number | null;
  "10": number | null;
  "60": number | null;
  "300": number | null;
}

export interface Fill {
  id: string;
  ts: number;
  account: string;
  symbol: string;
  venue: Venue;
  side: "buy" | "sell";
  price: number;
  qty: number;
  notional: number;
  fee: number;
  fee_asset: string;
  maker: boolean;
  fair: number | null;
  edge_bps: number | null;
  mk: Markouts; // net τ = 1 s if available
  mk_raw: Markouts;
  mk_fast: Markouts; // net τ = 0.2 s if available
  conversion?: boolean; // a trade between two stablecoins (USDCUSDT, ...): on the tape, out of every fill statistic
}

export interface SeriesPoint {
  t: number;
  equity: number;
  pnl_day: number;
  trading: number | null; // Π so far today; null before the P&L grid ran
  hedged: number | null; // S so far today
  inventory: number;
  futures_notional: number;
}

export interface Exposure {
  spot_value: number;
  futures_notional: number;
  net: number;
  target: number | null;
  band: number | null;
  gap: number | null;
  by_account: { account: string; spot_value: number; futures_notional: number; net: number }[];
  funding: { symbol: string; rate: number | null; next: number | null; position: number }[];
  beta_value: number;       // spot value weighted by each market's beta
  hedge_notional: number;   // futures notional of the hedge symbols (all futures if none named)
  ratio: number | null;     // target_ratio
  paused: string | null;    // name of the hedge pause window open now (target 0), else null
  paused_until: number | null;
  beta_source: string;      // "estimate" (the desk's own) or "fixed" (configured)
  hedge_day: HedgeDay | null;
}

export interface Engine {
  name: string;
  url: string;
  up: boolean;
  stale_s: number;
  state: string;
  strategy: string;
  orders: number;
  cancels: number;
  fills: number;
  risk_rejects: number;
  venue_rejects: number;
  rejects: { reason: string; count: number }[];
  realized: number;
  unrealized: number;
  fees: number;
  max_loss: number | null;
  kill: boolean;
  kill_reason: string | null;
  latency: { name: string; p50_us: number | null; p99_us: number | null }[];
  venues: {
    name: string;
    md: string;
    user: string;
    order: string;
    reconnects: number;
    cooldowns: number;
    rest_errors: number;
  }[];
}

export interface Alert {
  id: string;
  rule: string;
  level: "info" | "warn" | "crit";
  text: string;
  since: number;
  active: boolean;
}

export interface Feed {
  name: string;
  kind: "public" | "user" | "rest" | "engine";
  up: boolean;
  msgs_per_s: number;
  last: number | null;
  detail: string;
}

export interface MarkoutStats {
  horizons: number[]; // [1, 10, 60, 300]
  all: (number | null)[]; // net τ = 1 s
  buys: (number | null)[];
  sells: (number | null)[];
  raw: (number | null)[];
  fast: (number | null)[]; // net τ = 0.2 s
  by_hour: { hour: number; fills: number; mk10: number | null; mk60: number | null; pnl: number }[]; // UTC hour
  toxicity: { horizons_s: number[]; bps: (number | null)[]; fills: number[] }; // D(h)
}

/** Today's inventory drift against the futures legs (see DESIGN.md). */
export interface HedgeDay {
  inventory_drift: number; // H
  factor_drift: number; // Hm
  residual_drift: number; // H − Hm
  hedge_pnl: number | null;
  price_pnl: number | null;
  fees: number;
  funding: number;
  offset_factor: number | null; // −hedge P&L / Hm
  offset_total: number | null; // −hedge P&L / H
  net: number | null; // H + hedge P&L
  legs: HedgeLeg[];
}

export interface HedgeLeg {
  symbol: string;
  qty0: number;
  qty: number;
  mark0: number | null;
  mark: number | null;
  fills: number;
  price_pnl: number | null;
  fees: number;
  funding: number;
  pnl: number | null;
}

/** `GET /api/markouts`: today's fills seen one way (see DESIGN.md). Lines are indexed like `horizons_s`. */
export interface MarkoutReport {
  now: number;
  day_start: number;
  horizons_s: number[]; // −10 … 300
  fills: number;
  path_fills: number; // of `fills`, those with a price path (the curve is drawn from these only)
  notional: number;
  edge: number | null;
  pnl: number; // Σ notional × 60 s markout, USDT
  all: MarkoutLine; // all / buy / sell ignore the side filter
  buy: MarkoutLine;
  sell: MarkoutLine;
  /** All, buys, sells over every fill: those without a path count at 1, 10, 60, 300 s from their own markouts. */
  every: [MarkoutLine, MarkoutLine, MarkoutLine];
  tox: MarkoutLine; // D(h)
  dist: MarkoutDist;
  by_time: MarkoutBucket[]; // 15 minutes
  by_instrument: MarkoutInst[];
}

export interface MarkoutLine {
  n: number[];
  mean: (number | null)[];
  se: (number | null)[];
  adverse: (number | null)[];
}

export interface MarkoutDist {
  h: number;
  n: number;
  lo: number;
  width: number;
  bins: number[]; // weight shares
  mean: number | null;
  median: number | null;
  p10: number | null;
  p90: number | null;
}

export interface MarkoutBucket {
  t: number;
  fills: number;
  notional: number;
  mk10: number | null;
  mk60: number | null;
}

export interface MarkoutInst {
  symbol: string;
  venue: Venue;
  fills: number;
  notional: number;
  edge: number | null;
  mean: (number | null)[]; // by path horizon
  se10: number | null;
  adverse10: number | null;
  pnl: number;
}
