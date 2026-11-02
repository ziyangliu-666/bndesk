# Generalizing the desk

bndesk began as the dashboard for one setup: market making on Binance spot, hedged with USD-M perps, from a master account and its sub-accounts, with a FastMM engine beside it. This page records what still ties the code to that setup, most costly first, and the design that removes it. Phase 1 and steps 1 to 4 of the order of work are done; what they changed is marked. What is left is step 5.

## What ties it to one setup

**1. The P&L model assumes spot is what you trade and a perp is your hedge.** `Π` (Trading PnL) is built from spot fills only; every USD-M instrument is a "hedge leg" (`server/src/pnl.rs`, `selectors.ts`). A desk that makes markets on perps gets no market making or Trading PnL at all: everything it does lands under Hedge. This costs the most because the numbers themselves are wrong for that desk, not only the labels, and it reaches `pnl.rs`, `metrics.rs`, `accounts.rs` (`fut_day`), `recompute.rs`, `repair.rs` and the stored `equity` columns. *Step 3: an instrument has a role, and these ask it.*

**2. `Venue = "spot" | "usdm"` is also the exchange's name.** It runs through the protocol (`Fill`, `SymbolRow`, `OpenOrder`, `Account.fees`), about 200 sites in the server and 48 web files, and it carries three meanings at once: which exchange, which product, which margin rules. A second exchange has nowhere to go. Instrument keys (`spot:BTCUSDT`) are stored in `kv`, so they are persistent too. *Step 1: a venue is the id of a market in a table, and pages ask its kind. Step 3: where the server asked "is this spot?" and meant "is this what the desk trades", it asks the role.*

**3. Binance is called from everywhere, not from a connector.** `server/src/binance/` holds only the transport (REST, signing, weight, WebSocket). The endpoints and their JSON are read in `accounts.rs` (the user streams, balances, positions, fees, rate limits), `market.rs` (exchange info), `backfill.rs`, `history.rs` (klines), `recompute.rs` and `repair.rs`. The browser also connects to `stream.binance.com` itself for the forming candle and the 24 h ticker (`components/ex/klines.ts`, `ticker.ts`). *Step 2: every endpoint and field name is in `server/src/binance/`, behind a trait, and a test keeps it there. The browser's two sockets stay, for Binance's two markets only. Step 4: a second connector beside it, and `/api/ticker` for a market with no socket.*

**4. Valuation is pinned to USDT = 1.** `market::QUOTE` is a constant; an asset's price is its `<asset>USDT` market, and `recompute.rs` and `repair.rs` build those names directly. The futures wallet is Binance's own USD total. Hold a desk in USDC or in anything not quoted in USDT and equity is wrong or missing. *Phase 1 replaced the literal in 56 web files with `Snapshot.desk.currency` and `.quote` (`web/src/desk.ts`), and the name on the figures is configurable; the valuation itself stays USDT = 1, which is why `[desk] currency` only accepts USD or a USD stablecoin.*

**5. Accounts assume a master with sub-accounts.** Transfers come from the master's `sub-account/universalTransfer`, matched by email across the desk (`Role`, `email` in 27 places in `accounts.rs`); accounts without a key are read through the master's sub-account endpoints. A desk of separate accounts, or one account, works, but with no transfer history behind it a deposit or withdrawal the stream reports is taken off P&L for three minutes (`MOVE_HOLD_MS`) and then reads as P&L. *Step 4: on Hyperliquid each address's own ledger confirms a transfer, with no master, email or hold. Separate Binance accounts still have the hold.*

**6. Fixed P&L parts and pages that assume them.** Day PnL = market making + inventory + hedge + rebates + other is written out in 41 web files for the hedge and 28 for the rebates. *Phase 1: pages draw the parts a desk has (below). Step 2: the connector tags a distribution as a rebate. Step 3: the list stays fixed, on purpose (below): a role says which instrument goes in which part.*

**7. Order limits are Binance's two windows.** `orders_10s`, `orders_1d`, their limits and alerts, and `orders_source: "binance"`, are in the protocol, the Orders page and the phone's meters. *Step 4: an exchange without them says `no_order_limits`, and has no meters.*

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

## Done in step 3

A desk that sets no role serves the figures it did: `tests/session.rs` compares it with the same golden file, untouched. A desk that sets one gets Trading PnL, market making, inventory, volume and fills for what it trades and Hedge for what hedges, on any market, and `tests/roles.rs` runs a session through both and checks that the parts add up to Day PnL with Other at 0.

```toml
[roles]
usdm = "traded"          # a market's default: unset, spot is traded and a perp hedges

[[markets]]
symbol = "BTCUSDC"
venue = "usdm"
role = "hedge"           # one instrument's; on spot, its base asset's
```

An instrument named in `[exposure] hedge_symbols` hedges too, so a desk that has those does not repeat itself, and naming one and calling it traded is refused at load. `Roles` is in `protocol.rs`, and goes to the page as `Snapshot.desk.roles`, which asks `roleOf` the same way (`web/src/desk.ts`). Pages keep `isPerp` for what goes with the kind (a `Perp` tag, a funding row, a mark) and ask `isHedge` or `isTraded` where a figure goes.

Reading the code changed the proposal in five places:

- **No parts list, no `pnl_parts` table.** The proposal replaced `DayPnl`, `HistoryBar` and `Summary.pnl`'s named columns with `values: Record<string, number>` and a new table. Nothing needs it: the parts did not change, only which instruments go in them, so `trading`, `mm`, `hedge` and the rest keep their columns and their meaning, and stored rows read as they always did, with no aliases to expire. A list can come when a desk needs a part that is not one of these. Funding did not ask for one: it is what a position costs, so it is in Inventory for what is traded and in Hedge for what hedges, and `Summary.pnl.funding_day` says how much of Inventory it is.
- **A market's default as well as an instrument's role.** The proposal put roles on `[[markets]]`, but instruments are discovered from fills and positions: a desk on 80 perps would have to list them all, and one it forgot would land in Hedge.
- **A role on spot is its base asset's.** A balance cannot be split between BTCUSDT and BTCFDUSD. Two roles on one base are refused at load.
- **A traded perp is valued at its mark, not its mid.** Equity counts unrealized P&L at the mark, so Π at the mid would leave mark − mid × position wandering in Other, the figure meant to show what the desk cannot explain. `Market::value` and a second 1 s ring of marks hold it. Market making stays at the mid, as markouts are.
- **`Hedge` needed two sources.** A perp's leg is the account's `fut_day`, read from the exchange by trade id, and stays so: the golden file holds it. A spot asset has no such thing, so it stays in `PnlBook`, which already has its fills, flows and M_k(D), with a flag keeping it out of Π, and `hedge_legs` gives it the leg's shape.

The positions the book keeps are keyed by base on spot, as stored `pnlstate` rows are, and by instrument key for a perp, which a stored row cannot collide with. `spot_value`, `futures_notional` and the `inventory` and `futures_notional` columns keep their names and mean what the desk trades and what hedges it, which is what they meant before. `perps` is new beside `hedge` on `Snapshot.desk`: a desk whose perps are all traded has positions, margin and the Futures tab, and no Hedge figure.

What a role does not do: rows already written stay as written, so a desk that sets one sees the change from its next start (today's figures are rebuilt then from the fills) and its kept days do not move. History's volume and `repair-day` and `recompute-mm` take the roles set now. `repair-day` reads a traded perp's funding from the exchange and its prices from mark klines, as equity has them.

## Done in step 4

The second connector is Hyperliquid, for the reason the order of work asks: it has the least in common with Binance. An account is an address with one margin account behind it; no key, master, email or listen key; its reads are POSTs; it tells the time only in a status reply; it has no list of book tops, no 1 s bars, no trades by time, no mark candles, no order windows and no distributions; its symbols are not `[A-Z0-9]` and its funding is hourly. OKX was the other candidate, and would have shared most of Binance's shape (GET reads, a key, mark candles, sub-account transfers).

A desk runs on it alone or beside Binance. On Binance alone the requests, feeds, figures and stored rows are what they were, and `tests/session.rs` compares them with the same golden file, untouched. `server/src/hyperliquid/` is the connector; `tests/hyperliquid.rs` runs an account against a stand-in built from the published docs, and a session alone and beside Binance, where the parts add up to Day PnL with Other at 0.

### What it showed was wrong

- **"Read-only" meant "only GETs".** Every read there is a `POST`, so `allowed_writes` and the scans in `tests/readonly.rs` could say nothing about it, and listing `POST /info` as a write would have made the guarantee a formality. A read is now the connector's to define and the test's to hold: one path, a list of types, no signed body, and nothing in the directory that can sign. Better than a gate, this desk has no key to misuse there, and refuses one at load.
- **`Credentials` assumed reading takes a key.** `a.creds.is_some()` stood for "can be read" in four places. `credentials` can now answer that it takes none, and `Account::readable` says what those places meant.
- **One connector.** `Desk`, `bootstrap`, `make_streams`, `seed_books` and `run` are loops, and `Exchanges` picks by market. Doing this showed what "one exchange" had hidden: `spot_symbols` would have asked Binance about Hyperliquid's symbols; `hedge_symbols` and the Hedge figure's market default reached every market in the table, on a desk that reads two of them; a 429 from one exchange stopped the other's bars; and one exchange down at the start would have kept the desk off the page.
- **One clock.** Each connector keeps its own and signs with it, and `CLOCK` reads the first exchange's. On this machine the two read 1163 and 1016 ms ahead of it at the same moment. Fills mature and marks are taken on the desk's clock while a market's rings are on its exchange's, so a 1 s markout on the second exchange can be off by the difference between the two exchanges' clocks, not by the machine's error, which both offsets share.
- **`book_tops` assumed a list of every top.** It is told the symbols now, and Binance's ignores them.
- **`trade_at` and `mark_bars` assumed a history it does not keep.** `Market::trade_history` sends a backfill to one read of 1 min bars, which was the doc's own suggestion, and `mark_bars` is "or the nearest it has". A 1 s or 10 s markout the desk missed stays missing there.
- **A symbol is the exchange's name.** The doc expected `/api/klines` and `baseOf` to widen. They did not need to: `names.rs` translates at the boundary, so stored symbols stay `[A-Z0-9]` and the page sees `BTC`, `KPEPE` and `HYPEUSDC`. Base and quote were already `Inst`'s, from the listing. `BTC-USDT-SWAP` on another exchange can go the same way, or be the first thing to need more.
- **`markets` had to include spot.** That was Binance's rule, not the desk's: `Market::wallet` says where an account's balances must be read, and Hyperliquid has no such market.
- **Funding needed guessing.** Binance's account event gives no symbol, so the desk gives it to the one position held. Hyperliquid names the coin: `Event::Funding`.
- **Valuation had no way off Binance's spot.** `asset_inst` falls back to a pair on another exchange's spot market. This is the least step 5 could leave standing, not the numeraire: USDC is still 1.
- **Transfers matched by email through a master.** A ledger per address gives records directly, `email` holding the address, and `Transfers::pending` lets the day open only once each is read.
- **A stored fill on an unknown market read as spot.** It is left out and logged now. A row that says nothing is from before fills had a market, and stays spot.
- **Pages.** A row says which market where the kind would not tell two apart (`venueTag`); `/api/ticker` feeds a market with no socket, whose forming candle already followed the desk's mid; a link to a market this desk lacks finds the one it has; and order meters read `0 / 100` until an account could say it has none. The `Perp`, `USD-M` and last-trade wording that would have been false there went with it.

What the doc feared and did not happen: a single margin account fits `PerpSnapshot` as it was, with the wallet as its value less what is unrealized and `settle` empty. It does not fit once the balance lives on the spot side, which `userAbstraction` tells.

### What is checked, and what is not

Called for real on 2026-11-02, and the shapes in the tests are those answers: `exchangeStatus`, `metaAndAssetCtxs`, `spotMetaAndAssetCtxs`, `l2Book`, `candleSnapshot` (prices are strings, where the docs' types say numbers), its answers to what it refuses (422 for an interval it lacks, 500 and `null` for a coin it does not list), the socket's `bbo`, `activeAssetCtx`, `subscriptionResponse` and `pong`, and that a subscription to an unlisted coin closes the connection.

Built from the published docs and not checked against a real account, since this work read none, though the exchange would answer for any address: `clearinghouseState`, `spotClearinghouseState`, `frontendOpenOrders`, `userFillsByTime`, `userFunding`, `userNonFundingLedgerUpdates`, `userFees`, `userAbstraction` and every user socket feed. In particular:

- the key `nonFundingLedgerUpdates` in the socket's ledger message is not in the docs, only its type; a wrong one costs a minute, as the read has it;
- how often `clearinghouseState` and `spotState` push, and so how long a fill's position lags it; the reads catch it within 10 s, and until then Other moves;
- whether a unified account's spot `total` leaves out unrealized P&L, as the desk assumes;
- whether a withdrawal's `usdc` includes its `fee`, and an `internalTransfer`'s; if not, the fee reads as P&L;
- the ledger kind `send` is not in the docs' list, and is read as `spotTransfer` is; any other kind stays in P&L and is logged once;
- whether a minute with no trade has a candle, which `repair-day` needs at the day's start, as it does `m0`.

A first run on a real address should compare the Assets page with the exchange's, and watch Other.

## What the later steps need from this

**5. The numeraire, engine adapters, the interface's words.**

- `market::QUOTE`, `asset_inst` and `asset_price` still pin valuation to USDT, with `other_pairs` as the way around it; `recompute.rs` and `repair.rs` build `spot:<asset>USDT` keys directly, so on a desk without Binance those find no bars and an asset's fee or rebate there counts 0 (`repair-day` runs on Hyperliquid's own fills and funding, and has not met a real one). `PerpSnapshot.wallet` is a USD total, and a perp's price and funding are taken as USD (`quote_px`, `PerpDay`), so USDC-margined ones are off by USDC's price, beside Binance now as well as on it. Add `settle` to `Market` then. `Market::quote` is the start of it.
- A desk has one `quote` and one `currency`, its first exchange's, and `quote_free` sums stablecoins across whichever exchange an account is on.
- Engine adapters do not touch any of this.
- The words: `Binance's limit` and the like remain where only Binance has the thing (order windows, rebates, the stream's note), and are true there. `orders_source: "binance"` is on Hyperliquid's accounts too, unread with no meters. They can read `Market.exchange`, which KeyStrip now does through `exchangeOf`.

Not settled by this step, and waiting for what needs them:

- `Credentials` is an API key and one signer. A passphrase needs another field, which Hyperliquid did not ask for.
- Roles assume what both exchanges' perps are: a quantity in base units, linear, a price in USD. An inverse contract needs a size, and a position's value is no longer q × M. `hedge_symbols` names a symbol on every perp market the desk reads.
- `Account.perp` is one market, so an account has one. Hyperliquid's builder-deployed perps would be a second, in a clearinghouse read per dex, and what they make reads as Other until then.
- A symbol's position key is by symbol within an account, and `repair-day` adds positions by symbol across accounts: two exchanges listing the same perp name would collide there. Binance's names and Hyperliquid's do not.
- `Inst.mark_ring` is timed by `CLOCK` on receipt, as `Mark` has no time.
- A link is checked against the desk's markets when the page loads. One typed into a running page, to `spot` on a desk without Binance, still opens Binance's public ticker socket from the browser; its bars are refused.
- Separate Binance accounts with no master still have the three-minute hold of item 5.
- Hyperliquid's `Pace` is per connector and `/api/klines` is on its own pool, as Binance's is: the bars a busy page asks for are not counted against the weight the desk paces, on an allowance of half the limit.

## Target design

### A numeraire that is real

`[desk] currency` becomes what valuation is in: `Market::asset_price` asks for a path to it (direct pair, or through the connector's stable), the futures wallet is converted by its `settle`, and the check that limits the name to dollars goes. A stored row needs its currency, so a desk that changes it starts a new series rather than mixing two.

### Engines by adapter

`[[engines]] format = "fastmm" | "generic"`. `generic` maps configured metric names onto `up`, orders, fills, rejects and latency, and leaves the rest out, as a desk with no hedge leaves out its parts. `Engine`'s FastMM-only fields become optional.

## Order of work

1. ~~Markets as data, with the aliases.~~ Done.
2. ~~The connector split of `accounts.rs`, `market.rs` and the kline paths, still only Binance.~~ Done.
3. ~~Instrument roles, the only step that changes figures for anyone, and only for a desk that sets a role.~~ Done.
4. ~~A second connector, chosen for having the least in common with Binance (no sub-account transfers, one margin account), to find what the trait got wrong.~~ Done: Hyperliquid.
5. The real numeraire, engine adapters and the interface's words, each small after that.

The mock demo moves with each step: `web/src/mock.ts` takes `?currency=`, `?hedge=0`, `?rebates=0`, `?mm=0`, `?engines=0`, `?markets=2`, a second perp market, and `?perp=1`, a desk that makes markets on perps and hedges with two others (`&hedge=0`: with nothing), and `?exchange=hl`, a desk on Hyperliquid.
