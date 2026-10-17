# bndesk

**[Online Demo](https://ziy.bio/bndesk/)**

A real-time, read-only dashboard for high-frequency market making on Binance, written in Rust and React and designed for [FastMM](https://github.com/ziyangliu-666/FastMM). It looks like an exchange's trade page, on a pure-black ground.

![Desk](docs/screenshots/desk.gif)

![Orders](docs/screenshots/orders.gif)

![On a phone](docs/screenshots/phone.webp)

## Features

- Day P&L split into market making, inventory, hedge, rebates and other
- P&L, equity and exposure charts with intervals from 1 minute to 1 day that pan back over earlier days
- Quote map: every resting order against fair value and the market's bid and ask, per account
- Analysis: the price path around our fills from −10 s to 5 min with ±2 standard-error bands, the markout distribution, markouts through the day, by instrument, and edge against markout
- History by day, week or 15 minutes, for the desk or one instrument with Binance's klines and our fills on them
- Inventory, exposure and hedge across spot and USD-M futures, master and sub-accounts in one view
- Trading engine metrics over Prometheus, feed health and alerts
- Hide amounts masks every money figure for screen sharing
- A phone layout of its own: Desk, Markets, History, Assets and More, with alerts under a bell
- Read-only by design

## Built for speed

- One async Rust server (tokio, axum) holds all live state in memory
- The first snapshot carries only what the first screen draws; the rest follows once it is drawn
- After that only the rows and fields that changed go out, at most every 125 ms, large messages deflated as binary frames
- The page's files are served brotli-compressed and cached for a year; the socket and the first page start loading together
- Charts and the quote map draw on canvas, and grids render only the rows in view

[Setup](docs/setup.md) | [Pages](docs/pages.md) | [Design](DESIGN.md) | [Security](SECURITY.md) | MIT
