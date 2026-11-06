# Agent API

`/api/agent/*` is bndesk's history for agents: monitoring, research, autoresearch. It is read-only and
describes itself. It covers every figure the desk and the engine keep, over any range and on one time grid,
so an agent is not limited to one snapshot. Start with `GET /api/agent`: the catalog lists each series and
what it means, the accounts, the engine's keys, and the dates on which a definition changed.

## Access

- **Header:** `Authorization: Bearer $BNDESK_READ_TOKEN`.
- **Scope:** the token opens these paths only, and GET only. Any other path, or a wrong token, gets 401; a
  method other than GET gets 405. A logged-in browser session works on these paths too.
- **Where the token lives:**
  - on the server: the Fly secret `BNDESK_READ_TOKEN` (32 characters or more, else the token is off);
  - on this machine: `~/secrets/bndesk-read.env` (mode 600). Source it; never echo it.
- **Rotating:** write a new token to the file, run `fly secrets import -a bndesk-b836c6 < ~/secrets/bndesk-read.env`,
  and the machines restart with it.
- **Logging:** every read is logged on the server (`agent read <uri>`).

```sh
set -a; . ~/secrets/bndesk-read.env; set +a
q() { curl -sf -H "Authorization: Bearer $BNDESK_READ_TOKEN" "https://bndesk-b836c6.fly.dev/api/agent$1"; }
q ''                                                   # catalog
q '/series?keys=capital.*.util&from=-7d&step=3600&agg=mean&format=csv'
q '/pnl?from=-30d&step=86400'
```

## Conventions

- **Times** (`from`, `to`) can be given as:
  - epoch ms (or s);
  - `now`;
  - relative: `-90m`, `-24h`, `-7d`, `-2w`;
  - a UTC date `2026-11-05`, or a date and time `2026-11-05T12:00Z`.

  The default range is the last 24 h; `pnl` and `events` default to 7 d.
- **Time stamps:** `t` is epoch ms in UTC. A grid's `t` is the start of its bucket.
- **Money** is in USD(T).
- **Day figures** in `desk.*` restart at each P&L day's start; the catalog says when that is.
- **Format:** `format=csv` works on `series`, `pnl` and `fills`; everything else is JSON.

## Endpoints

| Path | What | Parameters |
|---|---|---|
| `/api/agent` | Catalog | none |
| `/api/agent/state` | Now: the dashboard's whole snapshot, plus the engine's last push | none |
| `/api/agent/series` | Any series side by side on one grid | `keys`, `from`, `to`, `step`, `agg`, `format` |
| `/api/agent/pnl` | P&L per bar, as changes. `pnl = mm + inventory_pnl + hedge + rebates + other`, with fills, volume and levels | `from`, `to`, `step` (60–86400 s), `format` |
| `/api/agent/fills` | Every fill: fee, edge, the mark market making counts, raw/net/fast markouts at 1/10/60/300 s, toxicity, price path | `from`, `to`, `symbol`, `venue`, `account`, `side`, `limit` (≤ 200k), `format` |
| `/api/agent/events` | Alerts, transfers (amounts only), distributions, definition changes | `from`, `to` |
| `/api/agent/markouts` | Today's markout curves and distribution, as on the Analysis page | as `/api/markouts` |
| `/api/agent/klines` | Candles from the exchange | as `/api/klines` |

### Series keys

Keys are comma-separated, and a `*` at the end of a name expands it.

- **`desk.<key>`:**
  - `equity`, `pnl_day`
  - the P&L split: `trading`, `mm`, `inventory_pnl`, `hedge`, `rebates`, `other`
  - `realized`, `floating`
  - `inventory_value`, `futures_notional`
- **`acct.<account>.<key>`:** `equity`, `pnl_day`, `inventory_value`, `futures_notional`.
- **`capital.<pool account | pool>.<key>`:** `util`, `free`, `locked`. `util` is locked / (free + locked),
  taken over the stablecoins (USDT, USDC, FDUSD, USD) in the engine's push.
- **`engine.<key>`:** any numeric leaf of the engine's push, e.g. `engine.metrics.*` or
  `engine.balances.binance_m2.USDT.locked`. The catalog lists them under `engine_keys`.

### Grid

- **`step`** is in seconds: 15, 60, 300, 900, 1800, 3600, 14400, 86400 or 604800. Without it, the step is
  chosen so the answer has about 1,500 buckets. One answer holds at most 20,000 buckets.
- **`agg`** sets how each bucket summarises what it holds: `last` (the default), `first`, `mean`, `min` or
  `max`.
- **Engine samples** come every 15 s for 7 days, then one every 5 min for 180 days. For `mean`, `min` or
  `max` over a long range, the samples are read at about 60 per bucket.
