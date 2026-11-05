# Design

A real-time, read-only monitor for a set of accounts on one or more exchanges: equity and PnL in the desk's
currency, inventory and exposure, fills with markouts, order-rate usage where the exchange limits it, fees, stream
health, and optional metrics scraped from a trading engine. It never places, cancels or transfers.

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
- config `[[markets]]`: `{symbol, venue = "spot" | "usdm", reference = {symbol, venue}?}` (a venue is the id of one of
  `Snapshot.desk.markets`; an alias, `binance:spot` or `binance:usdm`, is read as its market and never written);
- auto-discovered: every symbol an account holds a balance or position in, or trades
  (subscriptions are added at run time).

The optional reference is another instrument whose price leads or hedges this one. With a
reference, fair = reference mid × EWMA(own mid / reference mid) (half-life configurable, default
120 s); without one, fair = own mid.

### Connectors

What the desk asks of an exchange is the trait in `server/src/connector.rs`. `server/src/binance/` and
`server/src/hyperliquid/` implement it and are the only code that knows an endpoint, a field name or a URL. A connector
reports an account's news as `accounts::Event`s, applied where they are read: `Account::apply` holds the rules below about
which of a REST read and a stream event is newer. The markets are the table `protocol::MARKETS`: a market's id is what
stored rows, instrument keys and links say, it has no ':', and its aliases are accepted going in and never written. A
market with 1 s bars has backfilled prices from those, one without from trades, and one whose trades cannot be asked for by
time from one read of 1 min bars, which price horizons of a minute and more.

A desk reads every exchange its accounts name, in their order, then those of the `[[markets]]` it watches, and with none
of these Binance. `Exchanges` holds one connector each, and a market's `exchange` picks it. An account's `exchange`
(default `binance`) names its connector, and `markets` the ones it is read on: on Binance `["spot", "usdm"]`, or
`futures = true` as ever, and they must include spot, where its balances are read; on Hyperliquid every market by default,
with its balances read whichever are named. Each connector keeps its exchange's clock, for what it asks and signs; `CLOCK`,
the desk's grid, reads the first exchange's. An exchange down at the start holds the desk up for a minute at most, once
another has answered, and its listing joins the market when it comes back. `server/tests/readonly.rs` holds a connector to
reading.

### Sources (Binance)

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
  60 s for the futures day. `/sapi/v1/asset/assetDividend` (10) every 5 min, the whole day each time:
  asset distributions, among them the hourly market-maker rebate, which trading commissions do not show.
  A past day kept from before then is asked about once, a minute after the start, and keeps its rebates.
- Master key (read; `[master] show = false` keeps the master's own balances off the desk):
  `/sapi/v1/sub-account/list` hourly, `/sapi/v1/sub-account/universalTransfer`
  history every 60 s, so per-account PnL excludes transfers. The user streams show a transfer seconds
  earlier (spot `balanceUpdate`, USD-M `ACCOUNT_UPDATE` `bc` outside orders and funding): such a move counts
  until the history shows it, and for 3 min at most (`MOVE_HOLD_MS`) if it never does (a deposit or
  withdrawal, a spot to futures move inside one account, which nets out there).
- Transfer values: each move and each record is valued once, when first seen: the asset's mid at the end
  of the last whole second before it (1 s ring, 10 min; the price at first sight when the ring does not
  reach back), in the desk's currency (Valuation, below). A record that confirms a move takes the move's value. The value is
  stored (`transfers.usd`) and kept across restarts; a row stored without one is valued at first sight
  after the start.
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
- Engines (optional): Prometheus text from `[[engines]] url`, every 2 s. `format = "fastmm"`, the default, reads FastMM's
  own names (`fastmm-top --metrics`). `format = "generic"` reads any exporter by the names `[engines.metrics]` gives for
  `up`, `orders`, `cancels`, `fills`, `rejects` and `latency`: counters summed over their labels, rejects a row per label
  set, latency a row per summary (`quantile` label, per other label) or histogram (`<name>_bucket`, quantiles interpolated
  in the bucket as Prometheus does). What is not named is null and has no place on the page; a name the scrape lacks is
  logged. With no `up` an engine is up while its metrics answer.

Weight governor: track `X-MBX-USED-WEIGHT-1M`, stay under 50 % of the limit, and stop REST for
`Retry-After` on 429/418.

### Sources (Hyperliquid)

An account is an address, from `address_env`. Reading it takes no key, the desk refuses one at load, and nothing in the
connector can sign. Every read is a `POST /info` with a `type` from `rest::READS`, unsigned, and the client refuses any
other path or type, or a body with `action`, `signature` or `nonce`, before it leaves the process. Trading is `POST /exchange`
with a wallet signature; that path is not in the source. The socket sends `subscribe` and `ping` only, never `post`.

- Listing: `metaAndAssetCtxs`, `spotMetaAndAssetCtxs`. `names.rs` turns the exchange's names into the desk's: a perp is its
  coin in capitals (`BTC`, `KPEPE` for `kPEPE`) on `hl`, a spot pair base and quote (`HYPEUSDC` for `@107`) on `hlspot`.
  Builder-deployed perps (`xyz:NVDA`) and outcome tokens are not read: a fill on one is left out, and shows in Other.
- Public socket `wss://api.hyperliquid.xyz/ws`: `bbo` per coin, `activeAssetCtx` per perp for mark and funding, at most 400
  subscriptions a connection, `ping` every 30 s (it closes a connection silent for 60 s). A subscription to a coin it does
  not list closes the connection, so one is sent for listed coins only. Funding is hourly, and the rate is per hour.
- Books not yet ticked: `l2Book` per symbol, as it has no list of tops.
- Bars: `candleSnapshot`, 1 min and up, the last 5000 of an interval. It has no 1 s bars, no trades by time and no mark
  candles, so a day's opening mark, `mark_bars` and a backfill read trade candles. 24 h figures for `/api/ticker` come from
  the two listings, cached 5 s, with the high and low from hourly candles, cached 5 min.
- User socket, one per address, at most 10 addresses an IP: `userFills`, `orderUpdates`, `userFundings`,
  `userNonFundingLedgerUpdates`, `clearinghouseState`, `spotState`.
- Reads per account: `clearinghouseState` and `spotClearinghouseState` every 10 s, `frontendOpenOrders`, `userFillsByTime`,
  `userFunding` and `userNonFundingLedgerUpdates` each minute, `userFees` and `userAbstraction` every 5 min. Weight stays
  under half of 1200 a minute per IP, counted here since it sends no count of its own; a 429 pauses a minute.
- One margin account: `clearinghouseState` is a `PerpSnapshot`, with wallet = accountValue − unrealized. An account in
  `unifiedAccount` or `portfolioMargin` keeps its whole balance on the spot side, so its wallet there is 0.
- Transfers: each address's own ledger confirms them, so there is no master, no email and no hold. `email` holds the
  address, which is what a record's `from_email` and `to_email` then say. Deposits, withdrawals, transfers, sends and vault
  flows are records; a move between its own spot and perp sides has the same address at both ends and nets; a liquidation,
  reward or leader's commission is not money moved and stays in P&L. The day opens once every address's ledger is in.
- Fees and rebates: `userFees`. A maker rebate is a negative fee on the fill, in Π, so there are no distributions and no
  Rebates line. There are no order windows, so `no_order_limits` is set and no meter is drawn.
- Valuation: as on any exchange (below): its perps settle in USDC, and a desk in anything else converts them.

### Derived state

All times are exchange event times (ms).
- mid = (bid + ask) / 2 from bookTicker.
- Edge at fill (bps) = s × (fair − price) / fair × 1e4, s = +1 buy, −1 sell.
- Roles. An instrument is traded or hedges: its own `[[markets]] role` (or being in `[exposure] hedge_symbols`, for a
  perp), else its market's `[roles]`, else spot is traded and a perp hedges. A spot role is its base asset's, since a
  balance cannot be split between pairs. What is traded makes Trading P&L, market making, inventory, the desk's fills and
  volume; what hedges makes Hedge. A figure's meaning follows the role, not the market's kind, and this section says
  "spot" and "futures legs" for a desk with none set. Past rows keep what they were written as; a new role applies from
  the next start, to today's figures rebuilt then (`History` volume and the repairs take the roles set now).
- A traded perp is booked by Π like an asset, with these differences: its position is kept under its instrument key
  (`usdm:BTCUSDT`), since a base can have several; Q_k is the position across the accounts, M_k its mark (the mid until
  the first one), as equity has it, so Π moves with equity; held with no fill today it is in scope; M_k(D) is the day's
  kept mark, else the mark kline the accounts' sweep read, in the desk's currency at what it settles in. Π_k adds its funding today (in inventory,
  `funding_day`; realized in the split, not on the hour blocks, which are fills and marks). In the split a fill closes
  today's opposite lots first, then the opening position; what is left opens a lot, long or short. Market making is at
  its own mid. A spot asset that hedges is kept the same way as a traded one, and adds to Hedge: Π_k's closed form is
  its leg (`PnlBook::hedge_legs`), with nothing in Π, H, Hm, the blocks or the fill counts. A perp that hedges stays
  the account's `FutLeg`, as below.
- Trading P&L. Scope: the configured spot markets plus every spot symbol filled today, one position
  per base asset, and the traded perps. M_k(t) = valuation price (mid, or fair while the book gapes), R_k(t) = mid of its
  reference, r_k(t) = R_k(t) / R_k(t−1) − 1 (0 without a reference), r_b(t) = return of the beta
  instrument (`beta_vs`, else the first hedge symbol), β_k = the estimated or configured beta.
  Inventory Q_k is rebuilt, not read: Q0_k at the day start D is the current balance across the desk's
  accounts minus today's fills and flows, then it changes by fills (s·q, before fees) and by flows.
  Flows: today's transfers that cross the desk's edge, the same list Day PnL takes off (each account's
  records and unconfirmed moves, netted by transfer, so one between two of the desk's accounts is none;
  a desk account with the master's email sending to an address off the desk is a flow out). A flow books
  like a fill of s·q at p = its transfer value per unit, no fee, not counted in fills or volume, and left
  out of markouts and the market-making split; an asset Π holds no position in yet gets one. Stablecoins are
  cash, never a position: their flows and their conversions (below) stay out of Π, and Day PnL alone carries
  what holding or converting them made (their moves against the desk's currency, the spread and fee of a conversion). A move that drops unconfirmed is taken back as it was booked, so
  Π, like Day PnL, is as if it had never been seen.
  - Π for the day has a closed form, so it covers the whole day whenever the monitor started:
    Π_k = Q0_k·(M_k(T) − M_k(D)) + Σ_fills+flows [s·q·(M_k(T) − p) − fee], all in the desk's currency. M_k(D) is the open of
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
- Valuation: every money figure is in `Market::numeraire`, the asset `[desk] currency` names. An asset's price is the
  product of the pairs on its way there (`Market::path`): its direct pair with the currency on a spot market, else the
  shortest way through the spot listings, at most three pairs, turned over where needed, by a market's own quote first,
  then a stablecoin. A desk in dollars stops at a stablecoin, whose own way is its pair with the currency or nothing; it
  counts 1 with no pair or none quoted yet (an account holding one is not valued for its first 30 s, as for any asset).
  A desk in anything else assumes nothing, and refuses to start if an exchange's quote or a wallet's asset has no way there.
  A perp's position, unrealized P&L, funding and price P&L are in what it is quoted in, a perp wallet in its market's
  `settle`, each converted at that asset's price now (`Market::unit`). Equity, the opening equity, transfers, moves and
  rebates take these prices, so a stablecoin sent in and converted makes no Day PnL beyond the conversion's own spread
  and fee. What cash and opening balances make against the currency is real money with no part of its own: it is in Other.
- Par: a desk on Binance alone with `currency` unset (or `USD`) keeps what it has always done, `Numeraire::par`: an asset
  is priced only on `<asset>USDT`, and a dollar a perp settles in is 1 (`usdm:BTCUSDC`'s P&L and fees), so its figures and
  requests stay the golden file's. Naming any asset, `USDT` included, or reading a second exchange, ends par.
- A change of currency: rows carry no currency, so kv `currency` lists spans (from, asset) and the desk reads only those in
  its asset now (`store::Series`): equity rows and hour blocks by time, and `open:`, `pnlstate:`, `dayreal:` by key, those
  of a later span written `<key>#<span>`. A change opens a span at that start and rewrites nothing; changing back reads the
  old span again. The day of a change is a desk started then: Day PnL from that moment, today's fills still in Π, so Other
  holds the difference until the roll. `repair-day` and `recompute-mm` refuse a day that is not wholly in the currency.
  What is not converted is what stays in each fill's quote: `Fill.notional`, order and markout notionals, the day bars'
  and History's volume, which the page names by `notionalCur` (about a dollar on a desk in dollars, else the first
  exchange's quote). Live day volume (`volume_day`, a symbol's) is in the currency.
- Conversions: a trade between two stablecoins (base and quote both stablecoins: USDCUSDT, FDUSDUSDT) is a
  conversion, not market making. It stays on the fills tape and in the raw fills (`Fill.conversion`, tagged
  "Conv"), and is left out of everything fill-based: the fill aggregate (counts, volume, edge, markouts, the
  per-hour and toxicity stats, the alerts on them), `/api/markouts`, market making, Π and its scope, the day
  and History volume bars, `/api/fills` across all instruments (asked for by name it is shown), and the
  instrument rows (`symbols`: so no quote map, movers, footer or picker entry for the pair).
- Account equity = spot balances at their price + perp wallet + unrealized P&L, in the desk's currency (above).
  Day PnL = equity − equity at the day start − net transfers in since then, at their values when they
  happened (day start configurable, default 00:00 UTC). An asset that leaves carries no price exposure
  after it has gone, in Day PnL or in Π.
- Inventory per asset = sum over accounts of free + locked of non-quote assets; value at mid;
  average cost from today's fills.
- Exposure: per account and total, spot inventory value, futures net notional, net. Optional
  `[exposure] target_ratio, band_usd, band_frac, hedge_symbols` turns on a hedge check: the hedge
  symbols' futures notional (all futures if none named) should equal −ratio × beta-weighted spot
  value (clamped to ±`max_notional` when set), within band = max(`band_usd`, `band_frac` × |target|). Inside an `[[exposure.pauses]]`
  window (weekly, `start = "fri 21:00"`, `end = "sun 21:00"`, in its `tz`) the hedge is off: the
  target is 0 and any hedge left counts as to be closed. The betas are the desk's own, which may
  differ from a trading engine's,
  with `beta` per `[[markets]]` entry (default 1), or `beta = "estimate"`: EWMA cov/var of each
  market's (reference) log returns against `beta_vs` over `beta_horizon_s` (default `beta_sample_s`,
  10 s), sampled every `beta_sample_s` (overlapping when the horizon is longer), shrunk to `beta_prior`
  by n / (n + `beta_prior_samples`) and clipped, persisted across restarts (state kept for another
  horizon or sample interval starts the estimate again). `markets_only` limits the
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
futures legs' P&L) and `rebates`, NULL in per-account rows and in rows older than the columns), `transfers`,
`dividends` (each account's asset distributions), `alerts`, `pnl_hours` (hourly P&L blocks, upserted each minute), `kv`
(opening equity, fees, betas, and the day's P&L state: booked spans, M_k(D), H_k, last marks). Today's
rows and 60 days of hourly blocks are reloaded on start; per-account series are served on a 45 s grid.

### Alerts

Rule id, level `info | warn | crit`, thresholds in `[alerts]`:
- `stream_down`: a feed disconnected > 10 s (crit for user data).
- `stream_silent`: a public market-data connection with no data for 45 s while the session is open.
- `stale_quote`: no bookTicker > `stale_quote_s` (default 60) while its session is open, on an instrument the desk
  quotes: one in `[[markets]]`, a market's reference, or one with an order resting. Others held or traded (dust)
  are not watched.
  bookTicker only sends on a change at the top of the book, and thin markets can sit unchanged for tens of seconds.
- `orders_10s`, `orders_1d`: unfilled order count > 80 % of the limit. `orders_10s` opens only after 20 s over 80 % and clears under 70 %, so a burst hovering at the threshold is one alert.
- `rest_ban`: 418 or 429 seen (also engine rate-limit cooldowns).
- `fee_change`: commission differs from its baseline (the first value seen, kv `fee:<acct>:<venue>:<symbol>`),
  for 24 h from when the change was seen (kv `feechg:…`, so a restart keeps the clock; a rate already differing
  at startup counts from then), then the new value is the baseline; another change restarts the 24 h.
  `fee_expiry` within 7 days if configured.
- `drawdown`: day PnL below `day_drawdown_usd`, or a drop over 15 min larger than `drop_15m_usd`.
- `inventory`: total inventory value > `inventory_cap_usd` (clears under 95 % of it), or one traded instrument > `asset_cap_usd` (only when set; no per-asset cap by default).
- `exposure_gap`: |gap| > band for > `gap_hold_s` (60), or > `gap_wide_bands` bands for > 60 s (when set; when configured): a hedge that rebalances slowly is still at work before that; inside a hedge pause, info: hedge left to close.
- `reconcile`: |day PnL − Π − hedge legs − rebates| > `reconcile_usd` (1) for > 5 min: a fill, transfer or asset the desk does not see.
- `markout`: rolling 30-min volume-weighted 10 s net markout < `markout_floor_bps` with >= 30 fills.
- `dust`: a balance below the symbol's min notional (info).
- `engine`: kill active, state not running, metrics stale > 5 s, reject spike.
- `futures_margin`: futures available balance below `futures_margin_min_usd`.
- `quote_idle`: an account's free quote below `quote_idle_usd` for longer than `quote_idle_s`.
- `engine_latency`: an engine latency p99 above `latency_p99_us`.
- Market making and inventory, in the instrument's own mid (no reference): mm = Σ over today's spot fills of
  s q (M(t + h) − p) − fee, h = `mm_horizon_s` (60; one of the markout horizons 1, 10, 60, 300), the mid
  now for a fill younger than h (+ 30 s grace). A mark not taken live (the desk was down at t + h) is
  backfilled from klines by the P&L backfill task, under its weight budget: spot 1 s klines (the close of the
  second holding t + h, as the 1 s mid ring takes it), else 1 min klines interpolated open → close (h ≥ 60 s
  only); USD-M instruments, which have no 1 s klines, from the first aggregate trade at or after t + h. The
  reference at t + h for the net marks and D(h) likewise; without it net = raw, as live. Backfilled marks
  are stored with the fill (`bf` bit j; bit 4 + j: klines had no price, not asked again). A fill past h + grace
  with no price at t + h is left out of mm and mm_spread (its move counts in inventory) and counted in
  mm_unmarked_fills / mm_unmarked_notional; mm_spread the same at h = 0 against the fair at the fill; inventory =
  Π − mm (the opening inventory and each fill's position from h on). Day PnL = mm + inventory + hedge
  legs + rebates + other. Rebates: today's distributions whose description has "MM Rebate", at the asset's
  price when credited; other distributions (airdrops, rewards) are kept in `dividends` and stay in other.
  Days before 2026-10-17 valued such fills at the mid now; `desk recompute-mm --from D --to D [--dry-run]`
  backfills their marks as above and corrects the stored `mm` of the desk equity rows and `kv dayreal:<day>`
  (mm, inventory = trading − mm) by each fill's mark less the mid the row had (1 min klines); past days only.
- Real-money split of Π, per base and summed, over today's spot fills in time order (in the desk's currency at the quote
  asset's price): sells take today's buys first, oldest first, and the inventory held at the day start (at
  M_k(D)) only when no buy of today is left. realized: sells against today's buys, minus today's spot fees;
  realized_old: sells from the opening inventory (or beyond it), against M_k(D); floating: what is left, at
  M_k(T) against its cost. realized + realized_old + floating = Π_k.
- `pnl_1h`: last hour's PnL below −`drop_1h_usd`.

## Wire protocol (server -> web)

`GET /api/snapshot` returns the `Snapshot` in full. `GET /ws` sends one `snapshot` on connect, then
messages at most every 125 ms. JSON; money in the desk's currency, named by `desk.currency`; times in epoch ms.
`web/src/protocol.ts` mirrors these names exactly.

The WebSocket's snapshot carries what the first screen draws, so it is small (tens of KB deflated at the end
of a day): the newest 100 fills, the series of the last 15 minutes (`bars` hold the whole day at one minute),
each account's points of the last 65 minutes. The page sends the text `older` once it has drawn a snapshot;
the server answers with one `older` message, the rest as of that snapshot (fills up to 2000 in all, the
accounts' earlier points). The page adds the fills it does not have and puts the points before its first:
whatever came since the snapshot is newer and stays. After a day roll the server broadcasts `snapshot` then
`older` to every client.

History, read from `desk.db` off the desk's thread (a read-only connection) and behind the same login;
`from` / `to` epoch ms UTC (`to` defaults to now, `from` to a day before it), a bad parameter is a 400:
- `GET /api/history?from&to&step` -> `History`. `step` seconds, one of 60, 300, 900, 3600, 14400, 86400
  (default 300); bars start at multiples of `step` from the day start; at most 40 000 bars (a longer range
  keeps its latest part: a year at 15 min fits, and the page asks for finer bars a span at a time). From the desk's equity rows in [from, to): each P&L day's series restarts at
  the day start, so within a day the value is the sum of the earlier days' final values in the range plus
  its value now (days without rows add nothing), less each series' first value in the range, so it starts
  at 0 even when the range starts mid-day. o/h/l/c of that cumulative day PnL; pi (Π), realized,
  hedge: the bar's last non-null cumulative value; inventory, futures: the bar's last row; volume (Σ price
  × qty) and fills over every fill, spot and USD-M. Bars without equity rows are left out. The desk rows
  and per-minute fill sums are kept in memory (read once at start, then only what was written since,
  thinned like the store), so a request does not read the db: on a small machine it does not stay in
  the page cache, and a month of rows took 30 s from disk.
- `GET /api/fills?symbol&venue&from&to` -> `HistoryFill[]`, oldest first, at most 20000; `symbol` and `venue` (a market's id or alias) optional.
- `GET /api/klines?symbol&venue&interval&from&to` -> `[t, o, h, l, c, volume][]`: the market's connector's klines
  (Binance: spot `/api/v3/klines`, USD-M `/fapi/v1/klines`) opening in [from, to], at most 40 000 (the latest).
  `venue` a market's id or alias, spot by default; `interval` 1m (default), 5m, 15m, 30m, 1h, 4h, 1d, 1w; `symbol` [A-Z0-9]{2,20}.
  Fetched 1000 bars a request; chunks whose bars have all closed are cached in memory. An exchange's refusal is a
  400, a 429 / 418 a 503 until its Retry-After, for that exchange's markets alone. A market of an exchange this desk does
  not read is a 400.
- `GET /api/ticker?symbol&venue` -> `{last, open, high, low, volume, quote_volume, t}`: an instrument's 24 h, for a market the
  page has no socket to. `high` and `low` may be null. 204 where its connector leaves that to the page (Binance's markets).

Markouts, answered on the desk's thread from today's fills in memory:
- `GET /api/markouts?account&venue&side&ref&weight&h` -> `MarkoutReport`. Optional filters `account`, `venue`
  (a market's id or alias), `side` (buy | sell); `ref` net (τ = 1 s, default) | fast (τ = 0.2 s) | raw; `weight` notional
  (default) | fill; `h` the distribution's horizon in seconds (default 10, the nearest path horizon). Each fill
  keeps its instrument's mid and the reference's at the path horizons −10, −5, −2, −1, −0.5, 0, 0.2, 0.5, 1, 2,
  5, 10, 20, 30, 60, 120, 300 s (the 1 s ring's at 1, 10, 60, 300 s, as the markouts; the ms ring's
  elsewhere, kept for every configured or filled instrument), stored with the fill. A horizon before the
  fill reads the same formula: positive = the mid was then on our side of our price. The `all`, `buy`,
  `sell` lines ignore `side`; everything else is filtered by it. Standard error: the weighted variance over
  (effective n − 1); `adverse` is the weight share below zero. `pnl` = Σ notional × 60 s markout (a
  diagnostic, not P&L). `by_time`: 15-minute buckets from the day start; `by_instrument` by notional.

```ts
type Msg =
  | { type: "snapshot"; data: Snapshot }
  | { type: "patch"; data: Partial<Snapshot> & { diff?: Diff } }   // top-level keys replaced wholesale, or edited
  | { type: "fills"; data: Fill[] }                 // upsert by id
  | { type: "series"; data: SeriesPoint[] }         // appended
  | { type: "account_series"; data: AccountSeries[] }    // points appended per account
  | { type: "bars"; data: DayBars }                 // when a minute closes: the last 5 minute bars, replaced by t
  | { type: "older"; data: Older };                 // asked for with the text "older": what the snapshot left out

interface Snapshot {
  now: number;
  desk: Desk;
  summary: Summary;
  accounts: Account[];
  symbols: SymbolRow[];
  fills: Fill[];            // today's, newest first, at most 2000 (the newest 100 on the WebSocket)
  series: SeriesPoint[];    // today's, 5 s grid (the last 15 minutes on the WebSocket)
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
          hedge: number | null; rebates: number | null; other: number | null; mm: number | null; inventory: number | null }[];  // the day's real-money split at its end (kv dayreal:<day>);
                                                           // where kept, a past day's trading is its closed-form Π
  hours: { t: number; trading: number; hedged: number; factor: number; fills: number; volume: number;
           mm: number; inventory: number }[];   // today's UTC hours
  account_series: AccountSeries[];   // today's, 45 s grid (the last 65 minutes on the WebSocket)
  bars: DayBars;            // today's minute bars
}

// How this desk is set up, so the pages draw only what applies. Nothing here changes a figure: Day PnL, its parts
// and Other are computed the same way whatever it says.
interface Desk {
  currency: string;   // [desk] currency, what money figures are in, an asset; USD or unset means the first exchange's quote
  quote: string;      // the first exchange's quote: what a market name's suffix is stripped by. quote_free and quote_locked are every stablecoin's and the currency's, in the currency
  markets: { id: string; exchange: string; kind: "spot" | "perp"; name: string }[];   // what every venue field can say: id is the venue, name the interface's word for it
  roles: {            // what instruments are for, as configured: an instrument's own, else its market's, else spot is traded and a perp hedges. Empty on a desk that sets none
    markets: Record<string, "traded" | "hedge">;       // [roles]: by market id
    instruments: Record<string, "traded" | "hedge">;   // [[markets]] role and hedge_symbols: "usdm:BTCUSDT"; on spot its base asset, "spot:BTC"
  };
  perps: boolean;     // the futures columns and tabs show (an account with a perp market, a position, a futures wallet)
  hedge: boolean;     // the Hedge figure shows (a perp account whose market hedges, an instrument with that role, [exposure] target_ratio, a position or spot asset in the role now, a kept day's hedge P&L)
  rebates: boolean;   // a rebate has been credited: today, or on a kept day (so it can turn true during a run)
  mm: boolean;        // [desk] market_making: split Trading PnL into market making and inventory on the pages
  earlier: { until: number; currency: string };   // absent unless the currency changed: figures before this are in that one, stored and not shown
}

// Today's desk at one minute, as columns: each minute's last series point (t = the minute's start), with market
// making and the hedge legs' P&L as booked then, and the notional filled in the minute (Σ price × qty, every
// fill). Money rounded to cents. The day chart draws these; the page takes the series before its own from them.
interface DayBars {
  t: number[]; equity: number[]; pnl_day: number[]; trading: (number | null)[];
  mm: (number | null)[]; hedge: (number | null)[];
  inventory: number[]; futures: number[]; volume: number[];
}

interface Older { fills: Fill[]; account_series: AccountSeries[] }   // newest first; points per account, ascending

// A patch's keys that changed are whole, or under diff, whichever is shorter: an object's changed fields, a list's
// changed rows as [index, changed fields] when it kept its length. A row's other fields, and the other rows, stay.
type Diff = { [K in keyof Snapshot]?: [number, Record<string, unknown>][] | Record<string, unknown> };

interface Summary {
  equity: number; pnl_day: number; pnl_1h: number;
  rebates: number;        // market-maker rebates credited today
  other: number | null;   // day PnL − Π − hedge legs' P&L − rebates: what none explains (null while the hedge is unknown)
  pnl: { trading: number; trading_se: number | null; hedged: number; hedged_se: number | null;   // today: Π, S
         factor: number; factor_se: number | null;                                               // A
         ref_hedge: number; factor_hedge: number;                                                // H, Hm
         liquidation: number; covered_s: number; backfilled_s: number;                           // haircut now; seconds booked live / from klines
         realized: number; realized_old: number; floating: number;                               // Π split FIFO, see below
         mm: number; mm_spread: number; inventory: number; funding_day: number;                                    // Π = mm + inventory, see below
         mm_unmarked_fills: number; mm_unmarked_notional: number };                              // fills past h without a price at t + h: out of mm
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
  quote_free: number; quote_locked: number; inventory_value: number; hedge_value: number;
  fut_wallet: number; fut_upnl: number; fut_available: number;
  positions: { symbol: string; venue: string; amt: number; entry: number; mark: number; upnl: number; notional: number;
               pnl_day: number | null }[];   // pnl_day: today's price P&L, fees and funding on the symbol
  orders_10s: number; orders_10s_limit: number; orders_1d: number; orders_1d_limit: number;
  orders_source: string;                    // the exchange's id, "binance" (rateLimit/order), or "stream" (user stream, no rejects)
  no_order_limits: boolean;                 // its exchange has no order windows: no meters. Only ever true: absent where it has them
  open_orders: number; bids_notional: number; asks_notional: number;
  utilization: number;              // resting bids / (quote_free + resting bids)
  fees: { venue: string; maker_bps: number; taker_bps: number; changed: boolean }[];
  user_stream: "up" | "down" | "n/a"; updated: number;
  rebates: number;                  // market-maker rebates credited today
}

interface SymbolRow {
  symbol: string; venue: string; reference: string | null;
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
  id: string; ts: number; account: string; symbol: string; venue: string; side: "buy" | "sell";
  price: number; qty: number; notional: number; fee: number; fee_asset: string; maker: boolean;
  fair: number | null; edge_bps: number | null;
  mk: { "1": number | null; "10": number | null; "60": number | null; "300": number | null };      // net τ = 1 s if available
  mk_raw: { "1": number | null; "10": number | null; "60": number | null; "300": number | null };
  mk_fast: { "1": number | null; "10": number | null; "60": number | null; "300": number | null }; // net τ = 0.2 s if available
  conversion: boolean;   // a trade between two stablecoins: on the tape, out of every fill statistic
}

interface AccountSeries { account: string; t: number[]; equity: number[]; pnl_day: number[] }

interface History {
  step: number;   // seconds
  bars: HistoryBar[];
  days: { day: string; start: number }[];   // the P&L days overlapping the range: UTC date of the day start, its epoch ms
}

interface HistoryBar {
  t: number;                                // bar start
  o: number; h: number; l: number; c: number;   // day PnL summed across days since `from` (`per=day`: as stored, restarting each day)
  pi: number | null; realized: number | null; mm: number | null; hedge: number | null;   // the same for Π, realized + realized_old, hedge legs; bar close
  rebates: number | null;                   // the same for the rebates
  inventory: number | null; futures: number | null;   // last in the bar: inventory value, futures notional
  equity: number | null;                    // last in the bar: equity of all accounts
  volume: number; fills: number;            // every fill in the bar
}

interface HistoryFill { t: number; side: "buy" | "sell"; price: number; qty: number; account: string; venue: string; maker: boolean }

interface MarkoutReport {
  now: number; day_start: number;
  horizons_s: number[];                     // the path horizons, −10 … 300
  fills: number;                            // the filtered fills
  path_fills: number;                       // of them, those with a price path (kept since paths were added)
  notional: number;
  edge: number | null;                      // weighted edge at the fill, bps
  pnl: number;                              // Σ notional × 60 s markout, USDT
  all: MarkoutLine; buy: MarkoutLine; sell: MarkoutLine;   // by horizon, `side` ignored; fills with a path only
  every: MarkoutLine[];                     // [all, buy, sell] over every fill; one without a path counts at
                                            // the 1 s to 300 s horizons from its own markouts
  tox: MarkoutLine;                         // D(h), reference move against the fill since −5 s
  dist: MarkoutDist;                        // per-fill markouts at `h`
  by_time: MarkoutBucket[];                 // 15-minute buckets
  by_instrument: MarkoutInst[];             // by notional, largest first
}

interface MarkoutLine { n: number[]; mean: (number | null)[]; se: (number | null)[]; adverse: (number | null)[] }

interface MarkoutDist { h: number; n: number; lo: number; width: number; bins: number[]; mean: number | null; median: number | null; p10: number | null; p90: number | null }   // bins: weight shares

interface MarkoutBucket { t: number; fills: number; notional: number; mk10: number | null; mk60: number | null }

interface MarkoutInst { symbol: string; venue: string; fills: number; notional: number; edge: number | null; mean: (number | null)[]; se10: number | null; adverse10: number | null; pnl: number }   // mean by path horizon

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

// Today's inventory drift against the futures legs (the Accounts page's bridge shows the Desk's
// pnl.inventory instead, so the two pages agree; the drifts feed the exposure target). Drift H: what the spot inventory made on each name's
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
  symbol: string; venue: string; qty0: number; qty: number; mark0: number | null; mark: number | null; fills: number;
  price_pnl: number | null; fees: number; funding: number; pnl: number | null;
}

interface Engine { name: string; url: string; up: boolean; stale_s: number; state: string; strategy: string;
  // null: its metrics do not say. FastMM's names say all of these; an exporter of its own what [engines.metrics] names
  orders: number | null; cancels: number | null; fills: number | null; risk_rejects: number | null; venue_rejects: number | null;
  rejects: { reason: string; count: number }[];
  realized: number | null; unrealized: number | null; fees: number | null; max_loss: number | null; kill: boolean | null; kill_reason: string | null;
  latency: { name: string; p50_us: number | null; p99_us: number | null }[];
  venues: { name: string; md: string; user: string; order: string; reconnects: number; cooldowns: number; rest_errors: number }[] }

interface Alert { id: string; rule: string; level: "info" | "warn" | "crit"; text: string; since: number; active: boolean }

interface Feed { name: string; kind: "public" | "user" | "rest" | "engine"; up: boolean; msgs_per_s: number; last: number | null; detail: string }

interface OpenOrder {
  id: string; account: string; symbol: string; venue: string; side: "buy" | "sell";
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
cell change flash), TradingView Lightweight Charts (every time chart, in one exchange-style frame), ECharts (Analysis),
zustand (store fed by the WebSocket). Font: IBM Plex Sans with tabular numerals for figures.

Pages (keys 1 to 6): Desk (default), History, Analysis, Orders, Assets, System. The former names
(`#/markouts`, `#/accounts`, `#/engine`) are kept as aliases.

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

Pure-black ground for long sessions; gains teal-green, losses coral, every signed figure carries
its sign; amber for warnings only; one accent for selection.

Restraint. Colour means something or is not there: green and red answer whether we made money (Day PnL,
an instrument's or an account's P&L) or mark buy and sell; edge, markouts, inventory, exposure, volume,
counts and the parts of a split are ink with their sign in the text. A head has a hierarchy: one figure
large (Day PnL, the last price, the total value, the 10 s markout), its parts in one line under it, the
secondary facts grouped and quieter at the right (`FigureHead`), not a strip of equal label-over-value
boxes. A figure appears once per view: a chart's legend names the lines at rest and reads values on hover
when the head carries them, and a list does not repeat the head's total. No status dots or pulsing
indicators (a state is a word, the connection only when stale or lost), nothing that scrolls by itself,
no count badges on tabs unless the count asks for action, no plates around qualifiers (`Perp` is muted
text; spot has no tag), no dotted underlines (tooltips and the phone's definition sheets carry the
definitions). Space groups: related things close, groups apart by space or a single rule.

Trading PnL is market making + inventory PnL, fees included, never the hedge, on every page and size: a
spot market has one, a perp (the hedge) has none and shows its hedge leg's P&L under a Hedge figure or
column. Day PnL = Trading PnL + hedge legs + rebates + other. The split has one palette on every chart and
size (theme.ts `PNL_COLORS`, `PNL_STROKES`): Day PnL an area coloured by sign, Trading ink solid, market
making blue solid, inventory PnL violet long dashes, hedge teal dashes, rebates light grey spaced dots,
other grey dots; none of them green, red or amber, each with a stroke of its own so colour is not the only
cue. Spot inventory takes the inventory hue and futures the hedge hue wherever they are drawn.

A desk draws what it has (`Snapshot.desk`): no hedge means no Hedge figure, line, column or chip, no Futures or Exposure
& hedge tab, no futures columns; no rebates, the same for Rebates; `mm` false, Trading PnL without its two parts. No
engine configured means no Engines section or tab, and an engine shows the figures its metrics say. Other stays: it is what keeps the split adding up to Day PnL. While
the snapshot has not come, or from a server without `desk`, everything is drawn, in USDT.

Hiding an alert: a warning or info alert can be hidden on this browser (localStorage `desk.hiddenAlerts`),
never a critical one. The key is the alert's id and `since`, so it stays hidden while its text's figures
change at each check, and comes back if it clears and fires again; a key goes when its alert is no longer
active. A hidden alert leaves the banner (a Hide after each warning's age; "n hidden" shows them all again),
the title's count, the phone's Alerts badge and the Desk's alert strip. The Engine page's list keeps it,
muted, marked hidden, with Show; the phone's Alerts tab folds it under Hidden, and its page has Hide this
alert or Show this alert. Nothing reaches the server.

### Phone

`responsive.ts` decides once per layout change: a viewport under 48em wide, or a touch screen whose short
side is under 30em (a phone held sideways), gets the phone layout. The decision holds while a text field has
focus, so an on-screen keyboard that shrinks the viewport does not swap the tree. The phone has its own tree,
`components/mobile` and `pages/mobile`, on the same store, protocol and `format.ts`. Tablets from 768 to
1199 px get the desktop tree, reflowed by CSS (wrapping heads, one column under 62em, fixed panel heights
where the page scrolls); 1200 px and up is unchanged.

```
+------------------------------------+
| Desk                       bell 2  |   title, or < and a detail's title; Stale / Disconnected only when so
| ! active alert               >     |
| PnL +851.44 USDT since Oct 4       |   PnL since the first kept day; today, 1h, equity under it
| Market making  ----   +9.65        |   the split as a waterfall under it
| ...                                |
| Risk: exposure gap, orders         |   limit bars
| best / worst, accounts,            |   lists; a row opens its detail
| the day, latest fills              |
+------------------------------------+
| Desk Alerts Accounts History More  |
+------------------------------------+
```

Routes live in the URL hash, so a link opens a given screen: `#/desk` `#/alerts` `#/accounts` `#/history`
`#/more` `#/markouts` `#/orders` `#/engine` `#/fills` `#/instruments`, and the details
`#/instrument/<symbol>/<spot|usdm>` `#/account/<id>` `#/day/<YYYY-MM-DD>` `#/alert/<id>`
`#/history/<symbol>/<venue>`. The desktop reads the same hash and shows a phone-only page as the nearest of its
own (the detail's page; alerts on Engine; More, fills and instruments on Desk). Each tab keeps its own stack of pages with their scroll offsets. Back steps down
the current tab's stack, then to the Desk, then out of the app; an open sheet takes one Back of its own. The
browser's history only ever holds the current tab's stack.

A phone freezes a background tab and its socket can die without a close, so on return to the page, or a page
restored from the back-forward cache, the WebSocket reconnects unless messages are still arriving. Timers
pause while the page is hidden. Every page is a lazy chunk, on both trees. After a deploy an open
tab may ask for chunks that are gone: `LoadBoundary` reloads once, then shows one line with a Reload button.

Charts on touch: Lightweight Charts runs with `vertTouchDrag` off, so a vertical swipe scrolls the page. The
Desk's day chart does not pan or zoom; a sideways drag reads the minutes into its legend. History pans with a
drag and zooms with a pinch, and a Reset button brings back the live view. uPlot charts get a touch cursor: a
sideways drag scrubs, and the values show on a line above the plot instead of a tooltip.

`public/manifest.webmanifest` and 180, 192 and 512 px icons let it be added to the home screen, standalone and
black. There is no service worker.

The rules are the desktop's: one value per slot, a figure once per screen, where it leads (parts under a
total do not repeat it); gain and loss colours only for P&L figures and the side of a fill; amber and red only
for alerts and limits. Lists instead of grids, sections split by rules, no cards. Definitions sit behind the
labels: a dotted underline opens the same text the desktop shows on hover.
