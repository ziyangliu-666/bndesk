# Running it on your accounts

Build it with Rust and pnpm, then start the server with your config:

```sh
(cd web && pnpm install && pnpm build)
cd server && cargo run --release -- --config ../desk.toml
```

It serves the desk on <http://127.0.0.1:8710>. With `--config ../desk.example.toml --simulate` instead, it runs on real public market data and made-up accounts, without keys.

Copy [desk.example.toml](../desk.example.toml) to `desk.toml` and fill in the accounts, the markets you care about and the alert thresholds. The desk needs read-only API keys: one on the master account for the sub-account list and transfers, and one per sub-account. Ed25519 and HMAC keys both work. `desk.toml` only names the environment variables that hold them.

Binance counts request weight per IP address. Run the desk from a machine your trading processes do not share, or it will spend their weight.

If the server listens on anything other than localhost it asks for a password. `cargo run --release -- --new-password` prints one along with the hash to put in `DESK_PASSWORD_HASH`.

The manifest and icons sit behind the login too, so add the desk to a phone's home screen after logging in.

## Keeping history

The desk stores its figures in the SQLite file named by `db`. Five-second rows are kept for `keep_fine_days` (7) and thinned to one a minute after that; nothing older than `keep_days` (365) is kept. Market making marks each fill at `mm_horizon_s` (60) after it, one of 1, 10, 60 or 300.

A mark the desk missed because it was down at the time is filled in from Binance's klines once it is back. Days stored before that fix valued such fills at the mid of the moment; `desk recompute-mm` corrects them, and is safe to run beside the live desk:

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

[deploy/fly.example.toml](../deploy/fly.example.toml) is an example. Pick a region outside the US, since Binance refuses US addresses.
