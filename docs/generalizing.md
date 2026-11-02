# Generalizing the desk

bndesk began as the dashboard for one setup: market making on Binance spot, hedged with USD-M perps, from a master account and its sub-accounts, with a FastMM engine beside it. This page records what still ties the code to that setup, most costly first, and the design that removes it. The first phase is done; its changes are marked. The rest needs a change in what the wire protocol means, or a second exchange to test against.

## What ties it to one setup

**1. The P&L model assumes spot is what you trade and a perp is your hedge.** `Π` (Trading PnL) is built from spot fills only; every USD-M instrument is a "hedge leg" (`server/src/pnl.rs`, `selectors.ts`). A desk that makes markets on perps gets no market making or Trading PnL at all: everything it does lands under Hedge. This costs the most because the numbers themselves are wrong for that desk, not only the labels, and it reaches `pnl.rs`, `metrics.rs`, `accounts.rs` (`fut_day`), `recompute.rs`, `repair.rs` and the stored `equity` columns.

**2. `Venue = "spot" | "usdm"` is also the exchange's name.** It runs through the protocol (`Fill`, `SymbolRow`, `OpenOrder`, `Account.fees`), about 200 sites in the server and 48 web files, and it carries three meanings at once: which exchange, which product, which margin rules. A second exchange has nowhere to go. Instrument keys (`spot:BTCUSDT`) are stored in `kv`, so they are persistent too.

**3. Binance is called from everywhere, not from a connector.** `server/src/binance/` holds only the transport (REST, signing, weight, WebSocket). The endpoints and their JSON are read in `accounts.rs` (the user streams, balances, positions, fees, rate limits), `market.rs` (exchange info), `backfill.rs`, `history.rs` (klines), `recompute.rs` and `repair.rs`. The browser also connects to `stream.binance.com` itself for the forming candle and the 24 h ticker (`components/ex/klines.ts`, `ticker.ts`).

**4. Valuation is pinned to USDT = 1.** `market::QUOTE` is a constant; an asset's price is its `<asset>USDT` market, and `recompute.rs` and `repair.rs` build those names directly. The futures wallet is Binance's own USD total. Hold a desk in USDC or in anything not quoted in USDT and equity is wrong or missing. *Phase 1 replaced the literal in 56 web files with `Snapshot.desk.currency` and `.quote` (`web/src/desk.ts`), and the name on the figures is configurable; the valuation itself stays USDT = 1, which is why `[desk] currency` only accepts USD or a USD stablecoin.*

**5. Accounts assume a master with sub-accounts.** Transfers come from the master's `sub-account/universalTransfer`, matched by email across the desk (`Role`, `email` in 27 places in `accounts.rs`); accounts without a key are read through the master's sub-account endpoints. A desk of separate accounts, or one account, works, but with no transfer history behind it a deposit or withdrawal the stream reports is taken off P&L for three minutes (`MOVE_HOLD_MS`) and then reads as P&L.

**6. Fixed P&L parts and pages that assume them.** Day PnL = market making + inventory + hedge + rebates + other is written out in 41 web files for the hedge and 28 for the rebates. Rebates are recognised by the text `MM Rebate` in a Binance distribution (`accounts.rs`). *Phase 1: pages draw the parts a desk has (below). The list of parts is still fixed, and the rebate match still Binance's.*

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

## Target design

### A market is data, not an enum

```ts
interface Market {
  id: string;            // "binance:spot", "binance:usdm", "okx:swap": opaque to the page
  exchange: string;      // "Binance": the interface's word for the venue
  kind: "spot" | "perp" | "future";
  settle: string;        // the asset P&L and margin settle in
  limits: { name: string; window_s: number }[];   // what the Orders page meters
}
```

`Snapshot.desk.markets: Market[]` lists them. `venue` on `Fill`, `SymbolRow` and the rest stays a string but becomes one of those ids, so `"spot"` and `"usdm"` on the wire stay valid as aliases of `binance:spot` and `binance:usdm` for a release, and stored keys are not rewritten. The page stops comparing with `"usdm"` and asks `kind` (a perp tag, a funding row, a mark price) through one helper: most of the 48 files need one line each.

### A connector per exchange

```rust
#[async_trait(?Send)]
trait Connector {
    fn markets(&self) -> Vec<Market>;
    async fn instruments(&self) -> Result<Vec<Instrument>>;             // exchange info: base, quote, min notional
    fn public_streams(&self, subs: &[InstrumentKey]) -> Vec<StreamSpec>; // books, marks
    async fn run_account(&self, acct: &AccountCfg, tx: Events) -> Result<()>;
    async fn klines(&self, key: &InstrumentKey, iv: Interval, from: i64, to: i64) -> Result<Vec<Kline>>;
    async fn transfers(&self, since: i64) -> Result<Vec<Transfer>>;      // empty where not offered
    async fn distributions(&self, since: i64) -> Result<Vec<Distribution>>; // tagged by the connector: Rebate, Other
}

enum Event { Fill(FillRec), Balance(..), Position(..), OrderUpdate(..), Fee(..), Move(..), Limit(..), Stream(..) }
```

`accounts.rs`, the biggest file, splits along this line: everything that parses Binance's JSON moves to `connectors/binance/`, and what stays applies `Event`s, which it already nearly does through `on_spot_event` and `on_fut_event`. The balance-ordering rules (DESIGN.md) become the event's `update_time`. `tests/readonly.rs` extends to every connector: a connector is a read-only thing or it does not ship. Config:

```toml
[[exchanges]]
id = "binance"
kind = "binance"

[[accounts]]
id = "a"
exchange = "binance"   # default: the only exchange
markets = ["binance:spot"]   # replaces futures = true
```

With no `[[exchanges]]`, one Binance exchange is implied and `futures = true` means what it means today, so a current config keeps working. Klines and the 24 h ticker go through the server for every connector; the browser's direct Binance sockets stay only as Binance's own fast path.

### A numeraire that is real

`[desk] currency` becomes what valuation is in: `Market::asset_price` asks for a path to it (direct pair, or through the connector's stable), the futures wallet is converted by its `settle`, and the check that limits the name to dollars goes. A stored row needs its currency, so a desk that changes it starts a new series rather than mixing two.

### P&L parts as a list

Split the fixed model into what a fill makes and what a position costs:

```ts
interface PnlPart { key: string; label: string; of: string | null; info: string }  // of: the part this one splits
```

`Snapshot.desk.parts` and a generic `values: Record<string, number | null>` on `HistoryBar`, `DayPnl` and `Summary.pnl` replace the named columns, with the old names kept as aliases for a release. The default list is today's. The perp problem (item 1) is solved here: an instrument's role becomes config, not its venue, so `Π` covers whatever is marked `role = "traded"` and `Hedge` whatever is `role = "hedge"`, defaulting to today's spot and perp. The store needs a `pnl_parts` table beside the `equity` columns; old rows read through the aliases.

### Engines by adapter

`[[engines]] format = "fastmm" | "generic"`. `generic` maps configured metric names onto `up`, orders, fills, rejects and latency, and leaves the rest out, as a desk with no hedge leaves out its parts. `Engine`'s FastMM-only fields become optional.

## Order of work

1. Markets as data, with the aliases: the protocol change everything else needs, and no behaviour change on Binance.
2. The connector split of `accounts.rs`, `market.rs` and the kline paths, still only Binance, proved by the existing tests and a replayed session.
3. Instrument roles and P&L parts, the only step that changes figures for anyone, and only for a desk that sets a role.
4. A second connector, chosen for having the least in common with Binance (no sub-account transfers, one margin account), to find what the trait got wrong.
5. The real numeraire, engine adapters and the interface's words, each small after that.

The mock demo moves with each step: `web/src/mock.ts` takes `?currency=`, `?hedge=0`, `?rebates=0`, `?mm=0` and `?engines=0` today, and gains a second market the same way.
