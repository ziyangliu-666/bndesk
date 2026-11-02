# Generalizing the desk

bndesk began as the dashboard for one setup: market making on Binance spot, hedged with USD-M perps, from a master account and its sub-accounts, with a FastMM engine beside it. This page records what still ties the code to that setup, most costly first, and the design that removes it. Phase 1 and steps 1 and 2 of the order of work are done; what they changed is marked. The rest needs a change in what a figure means, or a second exchange to test against.

## What ties it to one setup

**1. The P&L model assumes spot is what you trade and a perp is your hedge.** `Π` (Trading PnL) is built from spot fills only; every USD-M instrument is a "hedge leg" (`server/src/pnl.rs`, `selectors.ts`). A desk that makes markets on perps gets no market making or Trading PnL at all: everything it does lands under Hedge. This costs the most because the numbers themselves are wrong for that desk, not only the labels, and it reaches `pnl.rs`, `metrics.rs`, `accounts.rs` (`fut_day`), `recompute.rs`, `repair.rs` and the stored `equity` columns.

**2. `Venue = "spot" | "usdm"` is also the exchange's name.** It runs through the protocol (`Fill`, `SymbolRow`, `OpenOrder`, `Account.fees`), about 200 sites in the server and 48 web files, and it carries three meanings at once: which exchange, which product, which margin rules. A second exchange has nowhere to go. Instrument keys (`spot:BTCUSDT`) are stored in `kv`, so they are persistent too. *Step 1: a venue is the id of a market in a table, and pages ask its kind. The server still answers "is this spot?" where it means "is this what the desk trades": that is item 1.*

**3. Binance is called from everywhere, not from a connector.** `server/src/binance/` holds only the transport (REST, signing, weight, WebSocket). The endpoints and their JSON are read in `accounts.rs` (the user streams, balances, positions, fees, rate limits), `market.rs` (exchange info), `backfill.rs`, `history.rs` (klines), `recompute.rs` and `repair.rs`. The browser also connects to `stream.binance.com` itself for the forming candle and the 24 h ticker (`components/ex/klines.ts`, `ticker.ts`). *Step 2: every endpoint and field name is in `server/src/binance/`, behind a trait, and a test keeps it there. The browser's two sockets stay, for Binance's two markets only.*

**4. Valuation is pinned to USDT = 1.** `market::QUOTE` is a constant; an asset's price is its `<asset>USDT` market, and `recompute.rs` and `repair.rs` build those names directly. The futures wallet is Binance's own USD total. Hold a desk in USDC or in anything not quoted in USDT and equity is wrong or missing. *Phase 1 replaced the literal in 56 web files with `Snapshot.desk.currency` and `.quote` (`web/src/desk.ts`), and the name on the figures is configurable; the valuation itself stays USDT = 1, which is why `[desk] currency` only accepts USD or a USD stablecoin.*

**5. Accounts assume a master with sub-accounts.** Transfers come from the master's `sub-account/universalTransfer`, matched by email across the desk (`Role`, `email` in 27 places in `accounts.rs`); accounts without a key are read through the master's sub-account endpoints. A desk of separate accounts, or one account, works, but with no transfer history behind it a deposit or withdrawal the stream reports is taken off P&L for three minutes (`MOVE_HOLD_MS`) and then reads as P&L.

**6. Fixed P&L parts and pages that assume them.** Day PnL = market making + inventory + hedge + rebates + other is written out in 41 web files for the hedge and 28 for the rebates. *Phase 1: pages draw the parts a desk has (below). Step 2: the connector tags a distribution as a rebate. The list of parts is still fixed.*

**7. Order limits are Binance's two windows.** `orders_10s`, `orders_1d`, their limits and alerts, and `orders_source: "binance"`, are in the protocol, the Orders page and the phone's meters.

**8. Engine metrics assume FastMM.** `server/src/engine.rs` reads `fastmm_*` names, and `Engine` has FastMM's shape (kill, max loss, venue channels). Any exporter with those names works; nothing else does. *Phase 1: no engine configured means no Engines section, tab, count or alert row.*

**9. Binance's words in the interface.** "Binance's limit", "Binance's 24 h volume", "Market-maker rebates Binance credited" and so on, in about 30 tooltips and the alert definitions. Cheap on its own; it goes with the connector's display name.

Not coupling, despite the look of it: sessions and events are optional and absent means a plain 24 h day; `[exposure]` is optional and absent means no gap, band or target; `fee_expiry` is optional. The day start is configurable. Markouts, the quote map and History take any instrument with a mid.

## Done in phase 1

No field changed meaning. `Snapshot.desk` is additive, and without it the page draws what it always did.

| | |
|---|---|
| `currency` | `[desk] currency`, the name on money figures: labels, tooltips, chart units, the per-asset alert |
| `quote` | the asset `quote_free` is a balance of, and what a market name's suffix is stripped by (`baseOf`, `quoteOf` replace 15 copies of a regex) |
| `hedge` | an account with `futures = true`, `[exposure] target_ratio`, a position or futures wallet now, or a kept day's hedge P&L. Off: no Hedge figure, line, column or chip; no Futures and Exposure tabs; no futures columns or USD-M fee; the Exposure chart draws the one line that means anything; no Perp filter |
| `rebates` | a rebate credited today or on a kept day. Off: the same for Rebates |
| `mm` | `[desk] market_making = false`: Trading PnL without its two parts, for a desk that does not think in markouts |
| engines | none configured: System is feeds and alerts, the phone has no Engines tab, and rules that cannot fire are out of the checks list |

Other is never hidden: it is what keeps the parts adding up to Day PnL, whatever is left out. Price tooltips that said "USDT" across instruments (`Mid`, `Avg cost`, `Limit price`) lost the unit, and a price on one instrument names that instrument's quote.

## Done in steps 1 and 2

A Binance desk with an unchanged config serves the same figures, sends the same requests and reads the same rows. `Snapshot.desk.markets`, `Position.venue` and `HedgeLeg.venue` are additive. `server/tests/session.rs` replays a Binance session through the desk and compares it with a file written before any of this.

### A market is data

```ts
interface Market {
  id: string;            // what every venue field says: "spot", "usdm"
  exchange: string;      // "Binance"
  kind: "spot" | "perp";
  name: string;          // the interface's word: "USD-M"
}
```

`Snapshot.desk.markets` lists them, and the page asks `isPerp(venue)`, `isSpot(venue)` or `marketOf(venue).name` (`web/src/desk.ts`). On the server `Venue` is an index into `protocol::MARKETS`, so it is still a byte to copy and compare, and `by_sym` on the book path is still an array.

This turns the proposal's aliases around. The proposal made `binance:spot` the name and `spot` an alias on the wire for a release. But `spot` and `usdm` are in every fill row, fill id, kv key (`fee:<acct>:<venue>:<symbol>`, `pnlstate`), instrument key, link and saved view, and those keys are split at their first `:`, so an id with a colon would mean two names forever and a rewrite or a translation at every read. So the stored name is the id, for good, and a new market's id has no colon. `binance:spot` and `binance:usdm` are aliases going in only: config and query strings. Nothing changes on the wire, and nothing expires.

Two fields of the proposal wait for what reads them: `settle` for the numeraire, and `limits` for the Orders page (item 7), which still meters `orders_10s` and `orders_1d`. `kind` has no `future`, since nothing tells a dated future from a perp yet.

### A connector per exchange

`server/src/connector.rs` is what the desk can ask of an exchange: the clock, what is listed, a public feed it tells which instruments to watch, book tops, bars and trades, `start_accounts`, distributions, and for `repair-day` an `AccountReader`. `server/src/binance/` is the only implementation and the only place that knows an endpoint, a field name or a URL.

Reading the code changed the proposal's shape in four places:

- No channel. The proposal had `run_account(acct, tx: Events)`; a connector calls `Account::apply(Event)` instead, where it read the message. A channel would have put a task switch between a stream event and the balance it changes, and the rules about which of a REST read and a stream event is newer depend on that order. `Account::apply` holds those rules, in terms of `u` (an update time) and `t0` (when a request went out).
- A feed, not a list of streams. Instruments are discovered at run time, so `public_streams(subs)` would be asked again each time. `public_feed` returns something told `watch(inst)`; Binance's writes books straight from its stream's callback, with no allocation added.
- Two kinds of connector method. The desk's thread is single-threaded and its `Rest` holds `Rc`s; `/api/klines` runs in axum handlers, which must be `Send`. So `KlineSource` is a separate `Send` trait with its own pool, as the proxy always had, and the backfill's `bars` stays on the governed client.
- No `[[exchanges]]`. Nothing configures an exchange yet. An account says `exchange = "binance"` (the default) and `markets = ["spot", "usdm"]`, or `futures = true` as ever; a table comes with the first setting that needs one.

`tests/readonly.rs` holds the guarantee at this boundary: the trait's methods are listed one by one, none may trade, every market has a connector, no URL or endpoint appears outside a connector's directory, and a stand-in exchange sees only GETs and the listen key from every read Binance makes.

## What the later steps need from this

**3. Roles and P&L parts.** These are where `is_spot()` means "is this what the desk trades": `PnlBook::on_fill_at`, `plan` and the fill loops (`pnl.rs`), `metrics::aggregate`, `mm_split`, `symbol_rows` and `beta_weighted_spot`, the `spot` scope in `app.rs`, the volume filter in `history.rs`, `leg_symbols` and the keys in `repair.rs`, and `isPerp` in `selectors.ts` and `SymbolsGrid`. A role belongs on `MarketCfg`, with these asking it. `pnl.rs` also calls `m.ensure(symbol, Venue::SPOT, ..)` and builds `spot:<symbol>` keys, which assume every traded fill is on the one spot market.

**4. A second connector.** Add its markets at the end of `MARKETS` (a place is a `Venue`), implement `Connector`, add it to `connector::open`. Then what the trait does not yet settle:

- `Desk` holds one connector and config refuses a second exchange. `make_streams`, `bootstrap`, `seed_books` and `run` become loops, `on_new` routes by `inst.venue`, and `Venue::market().exchange` picks the connector.
- `CLOCK` is one offset. Two exchanges need one each, and `fills`, `markouts` and the P&L grid read it as if there were one.
- An account is one spot wallet plus one perp market: `Account.perp`, `positions` by symbol, `fut_wallet`, `fut_usdt`. A single margin account has to fit `PerpSnapshot`, or that event has to change. `markets` must include a spot market for now, because `Account::ready` and `spot_parts` assume one.
- Transfers match by email through a master. `Transfers` needs another way to confirm a stream's move, or a desk without one keeps the three-minute hold (item 5).
- A symbol is `[A-Z0-9]{2,20}` in `/api/klines`, and a base is found by stripping a quote. `BTC-USDT-SWAP` fails both.
- Kline intervals are Binance's names (`history::INTERVALS`), and `CHUNK` is its limit. `KlineSource::bars` is where a connector would translate them.
- `Credentials` is an API key and one signer. A passphrase needs another field.
- A stored fill whose venue no longer parses reads as spot (`store::row_fill`), as it always did. With more markets that should be an error or a kept string.
- A row says `Perp`, not which perp. With `?markets=2` two BTCUSDT Perp rows read alike in the lists; only the instrument's header and the Markouts filter name the market. `kindWord` is the helper for it.
- The 24 h ticker has no server route: another market's reads `--` until `/api/ticker` exists. `web/src/store.ts` defaults a link with no venue to `spot`, and `"perp"` in a link to `usdm`.

**5. The numeraire, engine adapters, the interface's words.** `market::QUOTE`, `asset_inst` and `asset_price` still pin valuation to `<asset>USDT` on `Venue::SPOT`; `recompute.rs` and `repair.rs` build those keys directly, and `PerpSnapshot.wallet` is a USD total. Add `settle` to `Market` then. Engine adapters do not touch any of this. The words (`Binance's limit` and 50 or so like it, `orders_source: "binance"`) can read `Market.exchange`, which is on the wire and otherwise unread by the page.

## Target design

### A numeraire that is real

`[desk] currency` becomes what valuation is in: `Market::asset_price` asks for a path to it (direct pair, or through the connector's stable), the futures wallet is converted by its `settle`, and the check that limits the name to dollars goes. A stored row needs its currency, so a desk that changes it starts a new series rather than mixing two.

### P&L parts as a list

Split the fixed model into what a fill makes and what a position costs:

```ts
interface PnlPart { key: string; label: string; of: string | null; info: string }  // of: the part this one splits
```

`Snapshot.desk.parts` and a generic `values: Record<string, number | null>` on `HistoryBar`, `DayPnl` and `Summary.pnl` replace the named columns, with the old names kept as aliases for a release. The default list is today's. The perp problem (item 1) is solved here: an instrument's role becomes config, not its market's kind, so `Π` covers whatever is marked `role = "traded"` and `Hedge` whatever is `role = "hedge"`, defaulting to today's spot and perp. The store needs a `pnl_parts` table beside the `equity` columns; old rows read through the aliases.

### Engines by adapter

`[[engines]] format = "fastmm" | "generic"`. `generic` maps configured metric names onto `up`, orders, fills, rejects and latency, and leaves the rest out, as a desk with no hedge leaves out its parts. `Engine`'s FastMM-only fields become optional.

## Order of work

1. ~~Markets as data, with the aliases.~~ Done.
2. ~~The connector split of `accounts.rs`, `market.rs` and the kline paths, still only Binance.~~ Done.
3. Instrument roles and P&L parts, the only step that changes figures for anyone, and only for a desk that sets a role.
4. A second connector, chosen for having the least in common with Binance (no sub-account transfers, one margin account), to find what the trait got wrong.
5. The real numeraire, engine adapters and the interface's words, each small after that.

The mock demo moves with each step: `web/src/mock.ts` takes `?currency=`, `?hedge=0`, `?rebates=0`, `?mm=0`, `?engines=0` and `?markets=2`, the last a second perp market.
