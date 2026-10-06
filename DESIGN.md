# Design

A real-time, read-only monitor for a set of Binance accounts (a master account and its
sub-accounts): equity and PnL, inventory and exposure, fills with markouts, order-rate usage
against Binance limits, fees, stream health, and optional metrics scraped from a trading engine.
It never places, cancels or transfers.

Binance counts REST weight per IP. If your trading processes share an IP, run the monitor from a
different host with its own read-only keys, so its requests never consume the trading IP's weight.

## Layout

```
server/   Rust collector + API (crate `desk`)
web/      React + TypeScript + Vite single page app
desk.example.toml
```

## Server

Rust, one process. The desk's state lives on a single-threaded tokio runtime and is recomputed and
pushed every 125 ms. Libraries: `tokio-tungstenite` and `reqwest` (WebSocket and REST clients), `axum`
(HTTP and WebSocket server), `serde_json` and `sonic-rs` (JSON), `ed25519-dalek` and `hmac` (signing),
`rusqlite` (SQLite WAL) in a writer thread. History reads run on blocking threads with their own
read-only connections.

### Instruments

Tracked instruments are the union of:
- config `[[markets]]`: `{symbol, venue = "spot" | "usdm", reference = {symbol, venue}?}`;
- auto-discovered: every symbol an account holds a balance or position in, or trades
  (subscriptions are added at run time).

The optional reference is another instrument whose price leads or hedges this one. With a
reference, fair = reference mid × EWMA(own mid / reference mid) (half-life configurable, default
120 s); without one, fair = own mid.

### Sources

- Public market data (no key): spot `wss://stream.binance.com:9443/stream` and USD-M
  `wss://fstream.binance.com/public/stream` with `<sym>@bookTicker`; USD-M
  `wss://fstream.binance.com/market/stream` with `<sym>@markPrice@1s` for positions' marks and
  funding. At most 200 streams per connection; reconnect with backoff, and also when a
  connection sends no data for 60 s while it still answers pings.
- Per account (read key): spot user data via WS API `wss://ws-api.binance.com:443/ws-api/v3`
  (`session.logon` for Ed25519 keys, then `userDataStream.subscribe`; HMAC keys use
  `userDataStream.subscribe.signature`) -> `executionReport`, `outboundAccountPosition`.
  USD-M user data via `POST /fapi/v1/listenKey` and `wss://fstream.binance.com/private/ws/<listenKey>`
  (keepalive every 30 min) -> `ORDER_TRADE_UPDATE`, `ACCOUNT_UPDATE`.
  REST: `/api/v3/account` 15 s (weight 20), `/fapi/v3/account` 10 s (5),
  `/api/v3/rateLimit/order` 15 s (40), `/api/v3/openOrders` 60 s (80),
  `/api/v3/account/commission` one traded symbol per account per hour, rotating (weight 20), `/fapi/v1/commissionRate` hourly (USD-M).
  `/api/v3/myTrades` (20) for each configured or traded spot symbol every 10 min, first 20 s after start, from
  where the last sweep reached less 15 min (the day start at first): fills the user stream missed (the monitor
  down, a dropped stream) join with the stream's ids. A fill from before the balance an opening quantity came
  from corrects that opening instead of Q. `/fapi/v1/userTrades`, `/fapi/v1/income`, `/fapi/v1/markPriceKlines`
  60 s for the futures day.
- Master key (read; `[master] show = false` keeps the master's own balances off the desk):
  `/sapi/v1/sub-account/list` hourly, `/sapi/v1/sub-account/universalTransfer`
  history every 60 s, so per-account PnL excludes transfers.
- Balance ordering: a REST snapshot can be read before a fill and applied after the stream reported
  it. Each held spot balance keeps its account update time (REST `updateTime`, stream `u`); a snapshot
  leaves alone the assets the stream set after its `updateTime`, and a stream event older than what is
  held is dropped (events carry absolute free / locked, so any newer one is applied). USD-M positions
  and the USDT wallet balance (`ACCOUNT_UPDATE` `a.B` `wb`) do the same with the transaction time `T`
  against `/fapi/v3/account`'s per-position and per-asset `updateTime`; a stream value a minute older than
  the REST request no longer outranks it, so a missed event cannot pin a stale value.
- Klines (public, for the P&L backfill only): spot `/api/v3/klines` (weight 2) and USD-M
  `/fapi/v1/klines` (1 to 5 by size), 1 min bars, at most 1000 a request, paced to 300 / 120 weight a
  minute on top of the governor.
- Engines (optional): Prometheus text from `[[engines]] url`, every 2 s (FastMM's
  `fastmm-top --metrics` exposes one; any exporter with the same metric names works).

Weight governor: track `X-MBX-USED-WEIGHT-1M`, stay under 50 % of the limit, and stop REST for
`Retry-After` on 429/418.

### Derived state

All times are exchange event times (ms).
- mid = (bid + ask) / 2 from bookTicker.
- Edge at fill (bps) = s × (fair − price) / fair × 1e4, s = +1 buy, −1 sell.
- Trading P&L. Scope: the configured spot markets plus every spot symbol filled today, one position
  per base asset. M_k(t) = valuation price (mid, or fair while the book gapes), R_k(t) = mid of its
  reference, r_k(t) = R_k(t) / R_k(t−1) − 1 (0 without a reference), r_b(t) = return of the beta
  instrument (`beta_vs`, else the first hedge symbol), β_k = the estimated or configured beta.
  Inventory Q_k is rebuilt, not read: Q0_k at the day start D is the current balance across the desk's
  accounts minus today's fills, then it changes only by fills (s·q, before fees).
  - Π for the day has a closed form, so it covers the whole day whenever the monitor started:
    Π_k = Q0_k·(M_k(T) − M_k(D)) + Σ_fills [s·q·(M_k(T) − p) − fee], fees in USDT. M_k(D) is the open of
    the 1 min kline at D (fetched once for names held at D, kept across restarts), or the last mark at
    the day roll.
  - H and Hm depend on the path, booked on a live 1 s grid of exchange-clock seconds; a fill at t_f
    enters at the first grid point ≥ t_f. Per step:
    dΠ = Σ_fills [s·q·(M_k(t) − p) − fee] + Σ_k Q_k(t−1)·(M_k(t) − M_k(t−1)),
    dH = Σ_k Q_k(t−1)·M_k(t−1)·r_k(t): what the inventory would have made on its own references,
    dHm = (Σ_k β_k·Q_k(t−1)·M_k(t−1))·r_b(t): the same on the beta instrument.
  - Gaps in today's grid (start after D, restarts, stalls) are backfilled with the same steps on a
    1 min grid from klines of the instruments, their references and the beta instrument, for names with
    inventory or fills in the gap; a fill enters at the first minute after it. Gap ends join the live
    grid's own marks where known (the previous run's last state is saved each minute).
  - S = Π − H (hedged on its own reference with a 0–1 s delay), A = Π − Hm (factor-hedged); per
    instrument likewise.
  Steps are summed per UTC hour (fills, volume, live seconds `covered_s`, backfilled seconds
  `backfilled_s`) and stored each minute; a past day is the sum of its hours, ± its Newey–West standard
  error (lag 3) over the hourly blocks. Fills made while the monitor was down are not seen: they end up
  in Q0.
  Liquidation haircut: Σ_k |Q_k·M_k| × (half spread + taker fee) now, reported apart.
- Markouts (diagnostics, not P&L) at h ∈ {1, 10, 60, 300} s (bps): raw = s × (mid(t+h) / price − 1) × 1e4;
  net(τ) = raw − s × (R(t+h) / R(t+τ) − 1) × 1e4 with τ = 1 s (`mk`) and τ = 0.2 s (`mk_fast`). The
  reference often jumps against a fill within 200 ms; measuring its move from the fill instant
  would count that jump as edge. Instrument mids from a per-instrument 1 s ring (10 min); reference mids
  from a ms-resolution ring of every change (7 min).
- Toxicity D(h) = −s × (R(t+h) / R(t−5 s) − 1) × 1e4 for h ∈ {0, 0.2, 1, 60, 300} s, notional
  weighted over today's fills with a reference: positive = the reference moved against the fill.
- Account equity (quote USDT) = spot balances at mid (stablecoins at 1) + futures margin balance.
  Day PnL = equity − equity at the day start − net transfers in since then (day start configurable, default 00:00 UTC).
- Inventory per asset = sum over accounts of free + locked of non-quote assets; value at mid;
  average cost from today's fills.
- Exposure: per account and total, spot inventory value, futures net notional, net. Optional
  `[exposure] target_ratio, band_usd, band_frac, hedge_symbols` turns on a hedge check: the hedge
  symbols' futures notional (all futures if none named) should equal −ratio × beta-weighted spot
  value, within band = max(`band_usd`, `band_frac` × |target|). Inside an `[[exposure.pauses]]`
  window (weekly, `start = "fri 21:00"`, `end = "sun 21:00"`, in its `tz`) the hedge is off: the
  target is 0 and any hedge left counts as to be closed. The betas are the desk's own, which may
  differ from a trading engine's,
  with `beta` per `[[markets]]` entry (default 1), or `beta = "estimate"`: EWMA cov/var of each
  market's (reference) 10 s log returns against `beta_vs`, shrunk to `beta_prior` by
  n / (n + `beta_prior_samples`) and clipped, persisted across restarts. `markets_only` limits the
  hedge target and inventory alerts to configured markets.
- Accounts without their own key but with an email are read through the master key's
  sub-account endpoints (balances, futures account and positions; no fills or orders).
  Read-only keys cannot call `/api/v3/rateLimit/order`; order counts then come from `NEW`
  execution reports on the user stream.
- Sessions: optional `[[sessions]] {name, tz, start, end, days}` and `[[events]] {name, tz, at, days}`;
  drawn on the day chart and used for the session clock. None configured: plain 24 h day.

### Persistence

`desk.db` (SQLite WAL): `fills` (with edge, markouts and toxicity when matured), `equity` (5 s rows
per account and for the desk, account `*`; the desk's rows also carry Π and S so far today in `trading`,
`hedged`, and the real-money split in `realized` (realized + realized_old), `floating` and `hedge` (the
futures legs' P&L), NULL in per-account rows and in rows older than the columns), `transfers`, `alerts`, `pnl_hours` (hourly P&L blocks, upserted each minute), `kv`
(opening equity, fees, betas, and the day's P&L state: booked spans, M_k(D), H_k, last marks). Today's
rows and 60 days of hourly blocks are reloaded on start; per-account series are served on a 45 s grid.

### Alerts

Rule id, level `info | warn | crit`, thresholds in `[alerts]`:
- `stream_down`: a feed disconnected > 10 s (crit for user data).
- `stream_silent`: a public market-data connection with no data for 45 s while the session is open.
- `stale_quote`: no bookTicker on a tracked instrument > `stale_quote_s` (default 60) while its session is open.
  bookTicker only sends on a change at the top of the book, and thin markets can sit unchanged for tens of seconds.
- `orders_10s`, `orders_1d`: unfilled order count > 80 % of the limit.
- `rest_ban`: 418 or 429 seen (also engine rate-limit cooldowns).
- `fee_change`: commission differs from the first value seen; `fee_expiry` within 7 days if configured.
- `drawdown`: day PnL below `day_drawdown_usd`, or a drop over 15 min larger than `drop_15m_usd`.
- `inventory`: total inventory value > `inventory_cap_usd`, or one asset > `asset_cap_usd`.
- `exposure_gap`: |gap| > band for > 60 s (when configured); inside a hedge pause, info: hedge left to close.
- `reconcile`: |day PnL − Π − hedge legs| > `reconcile_usd` (1) for > 5 min: a fill, transfer or asset the desk does not see.
- `markout`: rolling 30-min volume-weighted 10 s net markout < `markout_floor_bps` with >= 30 fills.
- `dust`: a balance below the symbol's min notional (info).
- `engine`: kill active, state not running, metrics stale > 5 s, reject spike.
- `futures_margin`: futures available balance below `futures_margin_min_usd`.
- `quote_idle`: an account's free quote below `quote_idle_usd` for longer than `quote_idle_s`.
- `engine_latency`: an engine latency p99 above `latency_p99_us`.
- Market making and inventory, in the instrument's own mid (no reference): mm = Σ over today's spot fills of
  s q (M(t + h) − p) − fee, h = `mm_horizon_s` (60; one of the markout horizons 1, 10, 60, 300), the mid
  now for a fill younger than h; mm_spread the same at h = 0 against the fair at the fill; inventory =
  Π − mm (the opening inventory and each fill's position from h on). Day PnL = mm + inventory + hedge
  legs + other.
- Real-money split of Π, per base and summed, over today's spot fills in time order (USD at the quote
  asset's price): sells take today's buys first, oldest first, and the inventory held at the day start (at
  M_k(D)) only when no buy of today is left. realized: sells against today's buys, minus today's spot fees;
  realized_old: sells from the opening inventory (or beyond it), against M_k(D); floating: what is left, at
  M_k(T) against its cost. realized + realized_old + floating = Π_k.
- `pnl_1h`: last hour's PnL below −`drop_1h_usd`.

## Wire protocol (server -> web)

`GET /api/snapshot` returns the `Snapshot`. `GET /ws` sends one `snapshot` on connect, then
messages at most every 125 ms. JSON; money in USDT; times in epoch ms.
`web/src/protocol.ts` mirrors these names exactly.

History, read from `desk.db` off the desk's thread (a read-only connection) and behind the same login;
`from` / `to` epoch ms UTC (`to` defaults to now, `from` to a day before it), a bad parameter is a 400:
- `GET /api/history?from&to&step` -> `History`. `step` seconds, one of 60, 300, 900, 3600, 14400, 86400
  (default 300); bars start at multiples of `step` from the day start; at most 5000 bars (a longer range
  keeps its latest part). From the desk's equity rows in [from, to): each P&L day's series restarts at
  the day start, so within a day the value is the sum of the earlier days' final values in the range plus
  its value now (days without rows add nothing), less each series' first value in the range, so it starts
  at 0 even when the range starts mid-day. o/h/l/c of that cumulative day PnL; pi (Π), realized,
  hedge: the bar's last non-null cumulative value; inventory, futures: the bar's last row; volume (Σ price
  × qty) and fills over every fill, spot and USD-M. Bars without equity rows are left out.
- `GET /api/fills?symbol&from&to` -> `HistoryFill[]`, oldest first, at most 20000; `symbol` optional.
- `GET /api/klines?symbol&venue&interval&from&to` -> `[t, o, h, l, c, volume][]`: Binance's public klines
  (spot `/api/v3/klines`, USD-M `/fapi/v1/klines`) opening in [from, to], at most 5000 (the latest).
  `venue` spot (default) or usdm; `interval` 1m (default), 5m, 15m, 1h, 4h, 1d; `symbol` [A-Z0-9]{2,20}.
  Fetched 1000 bars a request; chunks whose bars have all closed are cached in memory. Binance's 4xx is a
  400, a 429 / 418 a 503 until its Retry-After.

```ts
type Msg =
  | { type: "snapshot"; data: Snapshot }
  | { type: "patch"; data: Partial<Snapshot> }      // top-level keys replaced wholesale
  | { type: "fills"; data: Fill[] }                 // upsert by id
  | { type: "series"; data: SeriesPoint[] }         // appended
  | { type: "account_series"; data: AccountSeries[] };   // points appended per account

interface Snapshot {
  now: number;
  summary: Summary;
  accounts: Account[];
  symbols: SymbolRow[];
  fills: Fill[];            // today's, newest first, at most 2000
  series: SeriesPoint[];    // today's, 5 s grid
  exposure: Exposure;
  engines: Engine[];
  alerts: Alert[];
  feeds: Feed[];
  markouts: MarkoutStats;
  orders: OpenOrder[];      // every resting order across accounts
  days: { day: string; trading: number; trading_se: number | null; hedged: number; hedged_se: number | null;
          factor: number; factor_se: number | null; fills: number; volume: number;
          covered_s: number; backfilled_s: number;        // last 60, incl. today; seconds booked live / from klines
          pnl_day: number | null; realized: number | null; realized_old: number | null; floating: number | null;
          hedge: number | null; other: number | null; mm: number | null; inventory: number | null }[];  // the day's real-money split at its end (kv dayreal:<day>);
                                                           // where kept, a past day's trading is its closed-form Π
  hours: { t: number; trading: number; hedged: number; factor: number; fills: number; volume: number;
           mm: number; inventory: number }[];   // today's UTC hours
  account_series: AccountSeries[];   // today's, 45 s grid
}

interface Summary {
  equity: number; pnl_day: number; pnl_1h: number;
  other: number | null;   // day PnL − Π − hedge legs' P&L: what neither explains (null while the hedge is unknown)
  pnl: { trading: number; trading_se: number | null; hedged: number; hedged_se: number | null;   // today: Π, S
         factor: number; factor_se: number | null;                                               // A
         ref_hedge: number; factor_hedge: number;                                                // H, Hm
         liquidation: number; covered_s: number; backfilled_s: number;                           // haircut now; seconds booked live / from klines
         realized: number; realized_old: number; floating: number;                               // Π split FIFO, see below
         mm: number; mm_spread: number; inventory: number };                                     // Π = mm + inventory, see below
  markout_net_bps_1h: number | null;  // volume-weighted 10 s markout, net τ = 1 s, last hour
  fills_1h: number; fills_day: number; volume_day: number;
  fills_24h: number; volume_24h: number;   // the 24 h to now, from the P&L hour blocks (tracked spot markets), the oldest prorated
  inventory_value: number; inventory_assets: number;
  fee_expiry: string | null;
  day_start: number;                // epoch ms of the PnL day start
  sessions: { name: string; start: number; end: number }[];   // today's windows, epoch ms
  events: { name: string; at: number }[];
  session: { name: string | null; open: boolean; next_event: string | null; next_event_at: number | null };
}

interface Account {
  id: string; label: string; email: string; role: "master" | "sub";
  equity: number; equity_open: number; pnl_day: number; transfers_day: number;
  quote_free: number; quote_locked: number; inventory_value: number;
  fut_wallet: number; fut_upnl: number; fut_available: number;
  positions: { symbol: string; amt: number; entry: number; mark: number; upnl: number; notional: number;
               pnl_day: number | null }[];   // pnl_day: today's price P&L, fees and funding on the symbol
  orders_10s: number; orders_10s_limit: number; orders_1d: number; orders_1d_limit: number;
  open_orders: number; bids_notional: number; asks_notional: number;
  utilization: number;              // resting bids / (quote_free + resting bids)
  fees: { venue: "spot" | "usdm"; maker_bps: number; taker_bps: number; changed: boolean }[];
  user_stream: "up" | "down" | "n/a"; updated: number;
}

interface SymbolRow {
  symbol: string; venue: "spot" | "usdm"; reference: string | null;
  mid: number | null; ref_mid: number | null; spread_bps: number | null; basis_bps: number | null;
  inv_qty: number; inv_value: number; avg_cost: number | null; upnl: number | null;
  fills_day: number; buys_day: number; sells_day: number; volume_day: number;
  edge_bps: number | null;
  mk10_bps: number | null; mk60_bps: number | null; mk300_bps: number | null;   // volume-weighted, net τ = 1 s if available
  trading_pnl: number; hedged_pnl: number;                                      // today: Π_k, S_k
  realized_pnl: number; float_pnl: number;                                      // today: Π_k = realized + float, FIFO
  mm_pnl: number; inv_pnl: number;                                              // today: Π_k = mm + inventory
  open_bids: number; open_asks: number;
  bid_dist_bps: number | null; ask_dist_bps: number | null;                     // best own order vs fair
  last_fill: number | null; dust: boolean;
  fair: number | null; bid: number | null; ask: number | null;   // fair value and the market's best bid / ask
}

interface Fill {
  id: string; ts: number; account: string; symbol: string; venue: "spot" | "usdm"; side: "buy" | "sell";
  price: number; qty: number; notional: number; fee: number; fee_asset: string; maker: boolean;
  fair: number | null; edge_bps: number | null;
  mk: { "1": number | null; "10": number | null; "60": number | null; "300": number | null };      // net τ = 1 s if available
  mk_raw: { "1": number | null; "10": number | null; "60": number | null; "300": number | null };
  mk_fast: { "1": number | null; "10": number | null; "60": number | null; "300": number | null }; // net τ = 0.2 s if available
}

interface AccountSeries { account: string; t: number[]; equity: number[]; pnl_day: number[] }

interface History {
  step: number;   // seconds
  bars: HistoryBar[];
  days: { day: string; start: number }[];   // the P&L days overlapping the range: UTC date of the day start, its epoch ms
}

interface HistoryBar {
  t: number;                                // bar start
  o: number; h: number; l: number; c: number;   // day PnL summed across days since `from`
  pi: number | null; realized: number | null; mm: number | null; hedge: number | null;   // the same for Π, realized + realized_old, hedge legs; bar close
  inventory: number | null; futures: number | null;   // last in the bar: inventory value, futures notional
  volume: number; fills: number;            // every fill in the bar
}

interface HistoryFill { t: number; side: "buy" | "sell"; price: number; qty: number; account: string; venue: "spot" | "usdm"; maker: boolean }

interface SeriesPoint { t: number; equity: number; pnl_day: number; trading: number | null; hedged: number | null; inventory: number; futures_notional: number }   // trading, hedged: Π, S so far today; null before the P&L grid ran

interface Exposure {
  spot_value: number; futures_notional: number; net: number;
  target: number | null; band: number | null; gap: number | null;   // gap = target − hedge_notional
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

// Today's inventory drift against the futures legs. Drift H: what the spot inventory made on each name's
// reference; Hm: the beta instrument's part. A leg's price P&L is Q0 (M_T − M_D) + Σ s q (M_T − p) at mark,
// from REST fills since the day start; hedge P&L = price P&L − fees + funding.
interface HedgeDay {
  inventory_drift: number; factor_drift: number; residual_drift: number;
  hedge_pnl: number | null; price_pnl: number | null; fees: number; funding: number;
  offset_factor: number | null; offset_total: number | null;   // −hedge P&L / Hm, / H
  net: number | null;                                          // H + hedge P&L
  legs: HedgeLeg[];
}

interface HedgeLeg {
  symbol: string; qty0: number; qty: number; mark0: number | null; mark: number | null; fills: number;
  price_pnl: number | null; fees: number; funding: number; pnl: number | null;
}

interface Engine { name: string; url: string; up: boolean; stale_s: number; state: string; strategy: string;
  orders: number; cancels: number; fills: number; risk_rejects: number; venue_rejects: number;
  rejects: { reason: string; count: number }[];
  realized: number; unrealized: number; fees: number; max_loss: number | null; kill: boolean; kill_reason: string | null;
  latency: { name: string; p50_us: number | null; p99_us: number | null }[];
  venues: { name: string; md: string; user: string; order: string; reconnects: number; cooldowns: number; rest_errors: number }[] }

interface Alert { id: string; rule: string; level: "info" | "warn" | "crit"; text: string; since: number; active: boolean }

interface Feed { name: string; kind: "public" | "user" | "rest" | "engine"; up: boolean; msgs_per_s: number; last: number | null; detail: string }

interface OpenOrder {
  id: string; account: string; symbol: string; venue: "spot" | "usdm"; side: "buy" | "sell";
  price: number; qty: number; notional: number;
  fair: number | null; dist_bps: number | null;   // from fair, positive = passive
  since: number | null;                           // order creation time
}

interface MarkoutStats {
  horizons: number[];                  // [1, 10, 60, 300]
  all: (number | null)[]; buys: (number | null)[]; sells: (number | null)[];   // net τ = 1 s
  raw: (number | null)[]; fast: (number | null)[];                             // raw, net τ = 0.2 s
  by_hour: { hour: number; fills: number; mk10: number | null; mk60: number | null; pnl: number }[];   // UTC hour; pnl = 60 s markout × notional
  toxicity: { horizons_s: number[]; bps: (number | null)[]; fills: number[] };   // D(h), h = [0, 0.2, 1, 60, 300]
}
```

## Web

React 19, TypeScript, Vite. Mantine 8 (layout, controls, theme), AG Grid Community (blotters,
cell change flash), uPlot and ECharts (live charts), TradingView Lightweight Charts (History),
zustand (store fed by the WebSocket). Font: IBM Plex Sans with tabular numerals for figures.

Pages (keys 1 to 6): Desk (default), History, Markouts, Orders, Accounts, Engine.

```
+--------------------------------------------------------------------------------------------+
| equity | day PnL | hedged PnL S | trading PnL Π | fills/h | inventory | exposure | session | ! |
+--------------------------------------------------------------------------------------------+
| the day: day PnL, Π and S over the day, configured sessions and events shaded               |
+---------------------------------------------------------------+----------------------------+
| instruments blotter (inventory, markouts, own quotes vs fair)  | live fills tape            |
+---------------------------------------------------------------+----------------------------+
| accounts: equity, PnL, quote, inventory, futures, order-rate meters, stream state | alerts  |
+--------------------------------------------------------------------------------------------+
```

Accounts page: the accounts grid, futures positions, exposure, desk equity, inventory, and day PnL by
account (one line per account, labelled at its end).

Dark slate ground for long sessions; gains teal-green, losses coral, every signed figure carries
its sign; amber for warnings; one accent for selection.
