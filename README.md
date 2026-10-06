# bndesk

bndesk is a high-performance visualization engine for high-frequency trading on Binance, written in Rust. It watches your accounts and the market and draws live P&L, inventory, hedge and fill quality in the browser.

![Desk](docs/screenshots/desk.gif)

![Orders](docs/screenshots/orders.gif)

**[Live demo](https://ziy.bio/bndesk/)**

## What it supports

- Binance spot and USD-M futures, a master account and any number of sub-accounts
- Day P&L split into market making, inventory, hedge and other
- Markouts from 1 s to 5 min for every fill, by market and by hour
- Resting quotes plotted against fair value and the book
- History over days and weeks
- Your own engine's metrics from a Prometheus endpoint, and alerts
- Read-only API keys, Ed25519 or HMAC; it never places or cancels an order

To run it on your own accounts, see [docs/setup.md](docs/setup.md). More: [the pages](docs/pages.md), [design](DESIGN.md), [security](SECURITY.md). MIT licensed.
