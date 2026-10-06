# Contributing

1. Server: `cd server && cargo build --release`, `cargo test`, `cargo clippy --all-targets` (no warnings).
2. Web: `cd web && pnpm install && pnpm build`. `pnpm dev` proxies to a server on :8710; `pnpm dev:mock` runs on generated data with no server.
3. Without keys, `cargo run --release -- --config ../desk.example.toml --simulate` runs the full desk on real public market data and synthetic accounts.
4. The wire protocol is defined in [DESIGN.md](DESIGN.md#wire-protocol-server---web). `server/src/protocol.rs` and `web/src/protocol.ts` mirror it field for field, and a test checks the Rust structs against it. Change all three together.
5. The server never writes to Binance. A new REST or WebSocket call must be a read; `server/tests/readonly.rs` fails otherwise.
6. UI: one value per slot, plain labels, no decorative effects. Take a screenshot at 1440 and 2000 px wide before calling a UI change done.
7. Commit subjects describe the change in the present tense (`History page: ...`, `server: ...`).
