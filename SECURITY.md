# Security

bndesk only reads from Binance. Its REST client refuses writes other than renewing the futures listen key, its WebSocket client only logs on and subscribes to user data, and `server/tests/readonly.rs` fails the build if order, cancel or transfer endpoints show up in the source. Give it read-only API keys anyway. The keys come from environment variables named in `desk.toml`; `desk.toml`, `*.env` and `*.pem` are ignored by git.

When it listens on a non-local address the server will not start without `DESK_PASSWORD_HASH` (scrypt), and repeated failed logins lock the address out for a while.

Please report vulnerabilities privately through GitHub's security advisories rather than in a public issue.
