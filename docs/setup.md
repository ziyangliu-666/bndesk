# Running it on your accounts

Build it with Rust and pnpm, then start the server with your config:

```sh
(cd web && pnpm install && pnpm build)
cd server && cargo run --release -- --config ../desk.toml
```

It serves the desk on <http://127.0.0.1:8710>. With `--config ../desk.example.toml --simulate` instead, it runs on real public market data and made-up accounts, without keys.

Copy [desk.example.toml](../desk.example.toml) to `desk.toml` and fill in the accounts, the markets you care about and the alert thresholds. Accounts are read-only: Ed25519 and HMAC keys both work on Binance, and Hyperliquid takes an address and no key. `desk.toml` only names the environment variables that hold them.

A desk with no futures, no rebates or no `[[engines]]` shows no empty columns or panels for them, without any setting. `[desk] market_making = false` shows Trading PnL without its two parts.

## Its currency

`[desk] currency` is what every money figure is in. It is an asset as a market lists it: USDT, USDC, EUR, BTC. An asset is priced along its pairs to that one, through a stablecoin or any spot listing the desk's exchanges have, and a perp and its wallet at what they settle in. A desk in dollars counts a stablecoin with no pair as 1; a desk in anything else assumes nothing, and will not start if an exchange's quote has no way to its currency.

Unset, or `USD`, which no market lists, it is the first exchange's quote: USDT on Binance, USDC on Hyperliquid. A desk on Binance alone that leaves it so counts a USDC a perp settles in as 1, as it always has; `currency = "USDT"` converts it at `USDCUSDT`.

What cash and opening balances make against the currency is real money with no part of its own, so it is in Other. Volume on the day bars and History, and the notional on a fill, stay in what each is quoted in, and on a desk not in dollars they say the first exchange's quote.

Change it and the desk starts a new series from that start. Figures in the old currency stay in the file, unchanged and unread; change back and they are read again. That day's Day PnL counts from the change, with Other holding what Trading PnL made before it until the day rolls. Going between `USD` and the first exchange's quote starts no series, since the asset is the same. `repair-day` and `recompute-mm` refuse a day that is not all in the current currency.

Alert thresholds, `band_usd` and the other `_usd` settings are in the desk's currency, whatever their name.

## Its engines

An `[[engines]]` entry is scraped for Prometheus text. FastMM's names need no more than `name` and `url`. Any other exporter says what it calls things, as in [desk.example.toml](../desk.example.toml), under `format = "generic"` and `[engines.metrics]`: `up`, `orders`, `cancels`, `fills`, `rejects`, `latency` and `latency_unit`. What is not named has no place on the page, and a name the exporter lacks is logged. Kill state, loss limits, the engine's own P&L and venue channels are FastMM's and do not show on a generic engine.

Binance counts request weight per IP address. Run the desk from a machine your trading processes do not share, or it will spend their weight.

If the server listens on anything other than localhost it asks for a password. `cargo run --release -- --new-password` prints one along with the hash to put in `DESK_PASSWORD_HASH`.

The manifest and icons sit behind the login too, so add the desk to a phone's home screen after logging in.

## On Binance

The desk needs read-only API keys: one on the master account for the sub-account list and transfers, and one per sub-account. Separate accounts with no master work too, with the three-minute hold on transfers described in [Generalizing](generalizing.md).

## On Hyperliquid

An account there is an address. Put it in the environment and name the variable, and give the desk no key: it reads with the address alone and refuses `api_key_env`, `secret_env` and `private_key_env` on such an account, as it does `[master]`.

```toml
[[accounts]]
id = "hl-a"
exchange = "hyperliquid"
address_env = "DESK_HL_A_ADDRESS"   # the account's own, or a sub-account's: an agent wallet's reads as empty

[roles]
hl = "traded"                       # without this a perp counts as a hedge, as on any exchange

[[markets]]
symbol = "BTC"                      # a perp is its coin in capitals: BTC, KPEPE
venue = "hl"

[[markets]]
symbol = "HYPEUSDC"                 # spot is base and quote
venue = "hlspot"
```

The same entries beside Binance's make a desk on both, with Binance first if its `[[accounts]]` come first: the first account's exchange gives the desk its clock and its default `currency`. Rows then name their market (`USD-M`, `HL`). In USDT, Hyperliquid's figures are converted at `USDCUSDT`.

It allows ten addresses per IP on its sockets. It keeps each address's last 10 000 fills and an instrument's last 5000 candles, so a desk that was down through a busier day than that has lost what fell off. Builder-deployed perps and outcome tokens are not read, and what they make shows in Other.

To see it with no address at all, set `simulate = true` under `[server]` and name a market, with no accounts:

```toml
[server]
simulate = true

[[markets]]
symbol = "BTC"
venue = "hl"
```

The desk then runs on Hyperliquid's real books with made-up accounts. A `[[markets]]` entry on another exchange's market adds its real books beside them.

## Keeping history

The desk stores its figures in the SQLite file named by `db`. Five-second rows are kept for `keep_fine_days` (7) and thinned to one a minute after that; nothing older than `keep_days` (365) is kept. Market making marks each fill at `mm_horizon_s` (60) after it, one of 1, 10, 60 or 300.

A desk that makes markets on perps sets `[roles] usdm = "traded"` and `role = "hedge"` on what hedges it, as in [desk.example.toml](../desk.example.toml): Trading PnL, market making, volume and inventory are then the perps', with their funding in Inventory, and Hedge is what is left. With nothing set, spot is traded and a perp hedges. Days already kept stay as they were written.

A mark the desk missed because it was down at the time is filled in from the exchange's klines once it is back. Days stored before that fix valued such fills at the mid of the moment; `desk recompute-mm` corrects them, and is safe to run beside the live desk:

```sh
cargo run --release -- --config ../desk.toml recompute-mm --from 2026-10-01 --to 2026-10-16 --dry-run
```

Without `--dry-run` it writes the corrected market making and inventory P&L for those days. It reads only past days and changes nothing else; a running desk shows the corrected days after its next start.

## Docker

The [Dockerfile](../Dockerfile) builds the server and the web UI into one image. It reads the whole config from `DESK_CONFIG` and listens on port 8080:

```sh
docker build -t bndesk .
docker run -p 8080:8080 -v bndesk-data:/data \
  -e DESK_CONFIG="$(cat desk.toml)" -e DESK_PASSWORD_HASH='scrypt$...' \
  -e DESK_SUB_A_API_KEY=... bndesk
```

Point `db` at `/data/desk.db` in that config so history survives restarts.

## Fly.io

[deploy/fly.example.toml](../deploy/fly.example.toml) is an example. On Binance, pick a region outside the US, since it refuses US addresses.
