# Security

bndesk only reads from exchanges. On Binance its REST client refuses writes other than renewing the futures listen key and its WebSocket client only logs on and subscribes to user data. On Hyperliquid it holds no key and takes none: it reads with an address, its client knows one path and a list of read types, and its socket only subscribes. `server/tests/readonly.rs` fails the build if order, cancel or transfer endpoints show up in the source. Give it read-only API keys anyway. The keys come from environment variables named in `desk.toml`; `desk.toml`, `*.env` and `*.pem` are ignored by git.

When it listens on a non-local address the server will not start without `DESK_PASSWORD_HASH` (scrypt), and repeated failed logins lock the address out for a while.

Please report vulnerabilities privately through GitHub's security advisories rather than in a public issue.
