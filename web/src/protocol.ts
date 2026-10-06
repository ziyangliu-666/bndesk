// Mirrors the wire protocol in DESIGN.md. Field names are the contract.

export type Msg =
  | { type: "snapshot"; data: Snapshot }
  | { type: "patch"; data: Partial<Snapshot> } // top-level keys replaced wholesale
  | { type: "fills"; data: Fill[] } // upsert by id
  | { type: "series"; data: SeriesPoint[] } // appended
  | { type: "account_series"; data: AccountSeries[] }; // points appended per account

export interface Snapshot {
  now: number;
  summary: Summary;
  accounts: Account[];
  symbols: SymbolRow[];
  fills: Fill[]; // today's, newest first, at most 2000
  series: SeriesPoint[]; // today's, 5 s grid
  exposure: Exposure;
  engines: Engine[];
  alerts: Alert[];
  feeds: Feed[];
  markouts: MarkoutStats;
  orders: OpenOrder[]; // every resting order across accounts
  days: DayPnl[]; // last 60, incl. today
  hours: HourPnl[]; // today's UTC hours
  account_series: AccountSeries[]; // today's, 45 s grid
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
  other: number | null; // day PnL − Π − hedge legs' P&L
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
  open_orders: number;
  bids_notional: number;
  asks_notional: number;
  utilization: number; // resting bids / (quote_free + resting bids)
  fees: AccountFee[];
  user_stream: "up" | "down" | "n/a";
  updated: number;
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
