# Generalizing the desk

bndesk began as the dashboard for one setup: market making on Binance spot, hedged with USD-M perps, from a master account and its sub-accounts, in USDT, with a FastMM engine beside it. It is now a general read-only desk. This page says what is general, what is not, what has not been run against a real account, and how it got here, for someone forking it.

## What is general now

**Exchanges.** A desk reads Binance, Hyperliquid or both. `server/src/connector.rs` is everything the desk asks of an exchange, and a connector's directory is the only place that knows an endpoint or a field name; `server/tests/readonly.rs` fails otherwise. To add an exchange, add its markets to `protocol::MARKETS` and implement `Connector`; `server/src/hyperliquid/` is the shortest example.

**What you trade.** Spot or perps, either as what you make markets on or as what hedges it. An instrument's role decides which figure it lands in. With no role set, spot is traded and a perp hedges.

**Accounts.** A master with sub-accounts, separate accounts, one account, or an address with no key.

**Currency.** `[desk] currency` is what every figure is in: USDT, USDC, EUR, BTC, any asset the listed spot pairs reach. An asset goes along its pairs to it, and a perp and its wallet at what they settle in. A desk that changes currency starts a new series and never mixes two; nothing stored is rewritten, and changing back reads the old figures again.

**Engines.** FastMM by its own metric names, or any Prometheus exporter by the names you give for `up`, orders, cancels, fills, rejects and latency. None at all is fine.

**The pages.** They draw what a desk has: no hedge, rebates, market-making split, order limits or engines means no empty columns or tabs. A limit or a rebate names the desk's own exchange, and a row its own market.

A Binance desk that sets none of this gets the figures and requests it always did. `server/tests/session.rs` replays a Binance session against a file written before any of the work, and that file has not changed. The price of that promise is `Numeraire::par`: a desk on Binance alone that names no currency still prices an asset only on `<asset>USDT` and counts a USDC a perp settles in as 1. Naming any currency, `USDT` included, ends it.

## What remains out of scope

Each of these waits for a desk that needs it.

- **Keys with more than a key and a secret.** `Credentials` is an API key and one signer. A passphrase needs another field.
- **Inverse and dated contracts.** Roles and valuation assume a perp is a quantity in base units, linear, settling in what it is quoted in. An inverse contract's position value is not q × M.
- **More than one perp market on an account.** `Account.perp` is one. Hyperliquid's builder-deployed perps would be a second, read per dex, and until then what they make shows in Other. `hedge_symbols` names a symbol on every perp market the desk reads.
- **The same perp name on two exchanges.** `repair-day` adds positions by symbol across accounts. Binance's names and Hyperliquid's do not collide.
- **A part of P&L of your own.** Day PnL is market making + inventory + hedge + rebates + other, a fixed list. What cash and opening balances make against the desk's currency has no part and shows in Other.
- **Volume and notionals in a currency that is not dollars.** Live day volume is converted. A fill's or an order's notional, markouts' weights and P&L, and the day bars' and History's volume stay in each fill's quote, since a stored fill has no rate of its time. A desk in dollars reads them as dollars; a desk in EUR sees them named by the first exchange's quote.
- **Past prices at their time on the day a currency changes.** That day is a desk started at the change: Day PnL from then, Other holding what Trading PnL made before it until the roll. A transfer of an asset earlier that day leaves Π's opening quantity off by it, into Other.
- **Separate Binance accounts' transfers.** With no master, a deposit or withdrawal the stream reports is taken off P&L for three minutes (`MOVE_HOLD_MS`) and then reads as P&L. Hyperliquid's per-address ledger has no such hold.
- **A link typed into a running page.** Links are checked against the desk's markets when the page loads. One typed later, to `spot` on a desk without Binance, opens Binance's public ticker socket from the browser; its bars are refused. The browser's own sockets are for Binance's two markets only.
- **`Inst.mark_ring`** is timed on receipt, as a mark has no time, and **Hyperliquid's `Pace`** does not count `/api/klines`, which has its own pool, on an allowance of half the limit.
- **Other engines' extras.** Kill state, loss limit, the engine's own P&L and venue channels are read only from FastMM's names.

## What has not been run against a real account

None of the generalizing work read an account. All of the below comes from the published docs or stand-ins, and a first run on a real one should compare the Assets page with the exchange's and watch Other.

Called for real on 2026-11-02, with the shapes in the tests taken from the answers: Hyperliquid's `exchangeStatus`, `metaAndAssetCtxs`, `spotMetaAndAssetCtxs`, `l2Book`, `candleSnapshot` (prices are strings, where the docs' types say numbers), what it answers to what it refuses, and the socket's public feeds. Also run for real, with made-up accounts: a desk in EUR on Binance's public books, whose equity, transfers and generic engine came out as they should.

**Binance, in a currency other than the default:**

- `totalWalletBalance` is taken as USDT. The docs describe it as USDT only in single-asset mode and as a USD total in multi-assets mode. In single-asset mode a USDC wallet on USD-M would be left out of equity, on any desk, as it always was.
- A USDC-margined perp's funding and P&L are assumed to arrive in USDC, and its fee in `commissionAsset`.

**Hyperliquid, built from the docs:** `clearinghouseState`, `spotClearinghouseState`, `frontendOpenOrders`, `userFillsByTime`, `userFunding`, `userNonFundingLedgerUpdates`, `userFees`, `userAbstraction` and every user socket feed. In particular:

- the key `nonFundingLedgerUpdates` in the socket's ledger message is not in the docs, only its type; a wrong one costs a minute, as the read has it;
- how often `clearinghouseState` and `spotState` push, and so how long a fill's position lags it; the reads catch it within 10 s, and until then Other moves;
- whether a unified account's spot `total` leaves out unrealized P&L, as the desk assumes;
- whether a withdrawal's `usdc` includes its `fee`, and an `internalTransfer`'s; if not, the fee reads as P&L;
- the ledger kind `send` is not in the docs' list, and is read as `spotTransfer` is; any other kind stays in P&L and is logged once;
- whether a minute with no trade has a candle, which `repair-day` needs at the day's start, as it does `m0`.

**Generic engines** are tested against text written from the Prometheus exposition format, not a real exporter's. `repair-day` has not met a real Hyperliquid day.

## How it got here

What each step found, for whoever changes these parts. A Binance desk with an unchanged config served the same figures, sent the same requests and read the same rows at every step.

### A desk draws what it has (phase 1)

No field changed meaning. `Snapshot.desk` is additive, and without it the page draws what it always did.

| | |
|---|---|
| `currency` | `[desk] currency`, the name on money figures: labels, tooltips, chart units, the per-asset alert. Step 5 made it what they are in |
| `quote` | the asset `quote_free` is a balance of, and what a market name's suffix is stripped by (`baseOf`, `quoteOf` replace 15 copies of a regex) |
| `hedge` | an account with `futures = true`, `[exposure] target_ratio`, a position or futures wallet now, or a kept day's hedge P&L. Off: no Hedge figure, line, column or chip; no Futures and Exposure tabs; no futures columns or USD-M fee; the Exposure chart draws the one line that means anything; no Perp filter |
| `rebates` | a rebate credited today or on a kept day. Off: the same for Rebates |
| `mm` | `[desk] market_making = false`: Trading PnL without its two parts, for a desk that does not think in markouts |
| engines | none configured: System is feeds and alerts, the phone has no Engines tab, and rules that cannot fire are out of the checks list |

Other is never hidden: it is what keeps the parts adding up to Day PnL, whatever is left out. Price tooltips that said "USDT" across instruments (`Mid`, `Avg cost`, `Limit price`) lost the unit, and a price on one instrument names that instrument's quote.

### Markets and connectors (steps 1 and 2)

A Binance desk with an unchanged config serves the same figures, sends the same requests and reads the same rows. `Snapshot.desk.markets`, `Position.venue` and `HedgeLeg.venue` are additive. `server/tests/session.rs` replays a Binance session through the desk and compares it with a file written before any of this.

#### A market is data

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

`kind` has no `future`, since nothing tells a dated future from a perp yet. The proposal's `limits` field never came: `no_order_limits` on an account said all a page needed.

#### A connector per exchange

`server/src/connector.rs` is what the desk can ask of an exchange: the clock, what is listed, a public feed it tells which instruments to watch, book tops, bars and trades, `start_accounts`, distributions, and for `repair-day` an `AccountReader`. `server/src/binance/` is the only implementation and the only place that knows an endpoint, a field name or a URL.

Reading the code changed the proposal's shape in four places:

- No channel. The proposal had `run_account(acct, tx: Events)`; a connector calls `Account::apply(Event)` instead, where it read the message. A channel would have put a task switch between a stream event and the balance it changes, and the rules about which of a REST read and a stream event is newer depend on that order. `Account::apply` holds those rules, in terms of `u` (an update time) and `t0` (when a request went out).
- A feed, not a list of streams. Instruments are discovered at run time, so `public_streams(subs)` would be asked again each time. `public_feed` returns something told `watch(inst)`; Binance's writes books straight from its stream's callback, with no allocation added.
- Two kinds of connector method. The desk's thread is single-threaded and its `Rest` holds `Rc`s; `/api/klines` runs in axum handlers, which must be `Send`. So `KlineSource` is a separate `Send` trait with its own pool, as the proxy always had, and the backfill's `bars` stays on the governed client.
- No `[[exchanges]]`. Nothing configures an exchange yet. An account says `exchange = "binance"` (the default) and `markets = ["spot", "usdm"]`, or `futures = true` as ever; a table comes with the first setting that needs one.

`tests/readonly.rs` holds the guarantee at this boundary: the trait's methods are listed one by one, none may trade, every market has a connector, no URL or endpoint appears outside a connector's directory, and a stand-in exchange sees only GETs and the listen key from every read Binance makes.

### Roles (step 3)

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

### A second exchange (step 4)

The second connector is Hyperliquid, chosen for having the least in common with Binance. An account is an address with one margin account behind it; no key, master, email or listen key; its reads are POSTs; it tells the time only in a status reply; it has no list of book tops, no 1 s bars, no trades by time, no mark candles, no order windows and no distributions; its symbols are not `[A-Z0-9]` and its funding is hourly. OKX was the other candidate, and would have shared most of Binance's shape (GET reads, a key, mark candles, sub-account transfers).

A desk runs on it alone or beside Binance. On Binance alone the requests, feeds, figures and stored rows are what they were, and `tests/session.rs` compares them with the same golden file, untouched. `server/src/hyperliquid/` is the connector; `tests/hyperliquid.rs` runs an account against a stand-in built from the published docs, and a session alone and beside Binance, where the parts add up to Day PnL with Other at 0.

#### What it showed was wrong

- **"Read-only" meant "only GETs".** Every read there is a `POST`, so `allowed_writes` and the scans in `tests/readonly.rs` could say nothing about it, and listing `POST /info` as a write would have made the guarantee a formality. A read is now the connector's to define and the test's to hold: one path, a list of types, no signed body, and nothing in the directory that can sign. Better than a gate, this desk has no key to misuse there, and refuses one at load.
- **`Credentials` assumed reading takes a key.** `a.creds.is_some()` stood for "can be read" in four places. `credentials` can now answer that it takes none, and `Account::readable` says what those places meant.
- **One connector.** `Desk`, `bootstrap`, `make_streams`, `seed_books` and `run` are loops, and `Exchanges` picks by market. Doing this showed what "one exchange" had hidden: `spot_symbols` would have asked Binance about Hyperliquid's symbols; `hedge_symbols` and the Hedge figure's market default reached every market in the table, on a desk that reads two of them; a 429 from one exchange stopped the other's bars; and one exchange down at the start would have kept the desk off the page.
- **One clock.** Each connector keeps its own and signs with it, and `CLOCK` reads the first exchange's. On this machine the two read 1163 and 1016 ms ahead of it at the same moment. Fills mature and marks are taken on the desk's clock while a market's rings are on its exchange's, so a 1 s markout on the second exchange can be off by the difference between the two exchanges' clocks, not by the machine's error, which both offsets share.
- **`book_tops` assumed a list of every top.** It is told the symbols now, and Binance's ignores them.
- **`trade_at` and `mark_bars` assumed a history it does not keep.** `Market::trade_history` sends a backfill to one read of 1 min bars, which was the doc's own suggestion, and `mark_bars` is "or the nearest it has". A 1 s or 10 s markout the desk missed stays missing there.
- **A symbol is the exchange's name.** The doc expected `/api/klines` and `baseOf` to widen. They did not need to: `names.rs` translates at the boundary, so stored symbols stay `[A-Z0-9]` and the page sees `BTC`, `KPEPE` and `HYPEUSDC`. Base and quote were already `Inst`'s, from the listing. `BTC-USDT-SWAP` on another exchange can go the same way, or be the first thing to need more.
- **`markets` had to include spot.** That was Binance's rule, not the desk's: `Market::wallet` says where an account's balances must be read, and Hyperliquid has no such market.
- **Funding needed guessing.** Binance's account event gives no symbol, so the desk gives it to the one position held. Hyperliquid names the coin: `Event::Funding`.
- **Valuation had no way off Binance's spot.** Step 5 gave it one.
- **Transfers matched by email through a master.** A ledger per address gives records directly, `email` holding the address, and `Transfers::pending` lets the day open only once each is read.
- **A stored fill on an unknown market read as spot.** It is left out and logged now. A row that says nothing is from before fills had a market, and stays spot.
- **Pages.** A row says which market where the kind would not tell two apart (`venueTag`); `/api/ticker` feeds a market with no socket, whose forming candle already followed the desk's mid; a link to a market this desk lacks finds the one it has; and order meters read `0 / 100` until an account could say it has none. The `Perp`, `USD-M` and last-trade wording that would have been false there went with it.

What the doc feared and did not happen: a single margin account fits `PerpSnapshot` as it was, with the wallet as its value less what is unrealized and `settle` empty. It does not fit once the balance lives on the spot side, which `userAbstraction` tells.

### The currency, engines and words (step 5)

**The numeraire.** The proposal was a direct pair or the connector's stable. Reading the code changed it in five places:

- **A way, not a pair.** `Market::path` is up to three pairs through the spot listings, because a desk in EUR on a listing with `XUSDT` and `EURUSDT` needs one turned over. It replaces `other_pairs`. A desk in dollars stops at a stablecoin, or USDC would have been priced as `BTCUSDT / BTCUSDC`.
- **Two things were called USD.** A spot asset's value was real, through `asset_price`; a perp's was its raw price, because nothing had asked. `Market::value` and `unit` now convert it, and an account's positions, wallet, funding and legs all ask them. `FutDay` stays in the settlement asset, except fees, which a connector values as it reads them.
- **`settle` is per market only for the wallet.** A linear perp settles in what it is quoted in, which `Inst.quote` already says, so `Market.settle` is what a perp account's wallet total is in, and is not on the wire: pages see the wallet converted.
- **`par` had to exist.** The golden file allows no change, and USDC at `USDCUSDT`'s mid on `usdm:BTCUSDC` is one, as is pricing `XBTC` through BTC, which adds a subscription. So the old rule is a flag, on a desk that asked for nothing else.
- **`quote_free` was never one asset.** It sums every stablecoin in the currency, so the pages call it Cash wherever the quote's name would not be true.

**The series.** The proposal gave a stored row its currency. Rows gained no column: kv `currency` lists spans of time and asset, a read asks whether a time is in the current one, and key-value money of a later span gets `#<span>` on its key, since a day can be split. So an upgrade writes one row, and a downgrade reads the first span's keys as it always did. A desk with no record is in its first exchange's quote, which is what it was valued in; one with no rows at all starts in whatever it names.

**Engines.** `Engine`'s FastMM fields became nullable rather than absent, so FastMM's wire is what it was, zeros on an unreachable engine included, and the page shows a figure only where it is not null. `kill` being null is what takes kill state off a generic engine. The tests hold a histogram's quantiles to how Prometheus's `histogram_quantile` interpolates.

**The words.** A limit or a rebate names `exchangeWord()`: the desk's one exchange, else "the exchange". `orders_source` is the account's exchange's id, still `binance` there. The socket URLs in `components/ex/` remain Binance's, as those two markets' own.

The mock demo: `web/src/mock.ts` takes `?currency=`, `?hedge=0`, `?rebates=0`, `?mm=0`, `?engines=0`, `?markets=2`, a second perp market, `?perp=1`, a desk that makes markets on perps and hedges with two others (`&hedge=0`: with nothing), `?exchange=hl`, a desk on Hyperliquid, `?engine=generic`, an engine by an exporter of its own, and `?earlier=USDC`, a desk that changed its currency today.
