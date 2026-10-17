# Contributing

1. Server: `cd server && cargo build --release`, `cargo test`, `cargo clippy --all-targets` (no warnings).
2. Web: `cd web && pnpm install && pnpm build`. `pnpm dev` proxies to a server on :8710; `pnpm dev:mock` runs on generated data with no server.
3. Without keys, `cargo run --release -- --config ../desk.example.toml --simulate` runs the full desk on real public market data and synthetic accounts.
4. The wire protocol is defined in [DESIGN.md](DESIGN.md#wire-protocol-server---web). `server/src/protocol.rs` and `web/src/protocol.ts` mirror it field for field, and a test checks the Rust structs against it. Change all three together.
5. The server never writes to Binance. A new REST or WebSocket call must be a read; `server/tests/readonly.rs` fails otherwise.
6. UI: one value per slot, plain labels, no decorative effects. Take a screenshot at 1440 and 2000 px wide, and at 393 px for the phone layout, before calling a UI change done. What reads as generated rather than designed is out ([DESIGN.md](DESIGN.md#web), "Restraint"):
   - no status dots, pulsing or glowing indicators; a state is a word, and the connection shows only when it is stale or lost;
   - nothing moves on its own (no marquee, no ticker scroll);
   - green and red only for whether we made money (Day PnL, per-instrument and per-account P&L) and for buy and sell; everything else in ink, the sign in the text;
   - a figure once per view: chart legends name their lines at rest and give values on hover where the head has the figures;
   - no count badges on tabs (a count only where it asks for something: active alerts, engines down), no pills or plates (a perp reads `Perp` in muted text, spot needs no tag), no dotted underlines (definitions in tooltips or the phone's sheets);
   - hierarchy over strips: one figure large, its parts in a line, secondary facts grouped and quieter; related things close, groups apart.
7. Commit subjects describe the change in the present tense (`History page: ...`, `server: ...`).
