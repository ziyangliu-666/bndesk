import { useMemo } from "react";
import { useStore } from "../../store";
import { useNow } from "../../hooks";
import { hm, int, num, pct, usdShort } from "../../format";
import { Dot } from "../../components/ui";
import {
  Hero,
  KV,
  ListRow,
  Money,
  RateMeter,
  Section,
  Sparkline,
  SplitRows,
  Tag,
  span,
  useHold,
  useLive,
  useMoney,
} from "../../components/mobile";
import type { Fill } from "../../protocol";
import { Bps, FillRow, InstName, PositionsTable, TIP, useFillSheet } from "./shared";
import "./accounts.css";

const FILLS = 20;

/** A daily limit as the definitions write it: 160k. */
const limitK = (n: number) => (n >= 10_000 ? `${int(n / 1000)}k` : int(n));

export function AccountM({ id }: { id: string }) {
  const a = useLive((s) => s.snap?.accounts.find((x) => x.id === id), 250, false, id);
  const series = useLive((s) => s.snap?.account_series.find((x) => x.account === id), 1000, false, id);
  const [held, hold] = useHold();
  const allFills = useLive((s) => s.snap?.fills, 250, held);
  const tz = useStore((s) => s.tz);
  const now = useNow(1000) + useStore.getState().skew;
  const fill = useFillSheet();
  const money = useMoney();
  const fills = useMemo(() => (allFills ?? []).filter((f) => f.account === id), [allFills, id]);
  // the perps only this account holds, when their fills are not among the recent ones: the hedge's own counts
  const symbols = useLive((s) => s.snap?.symbols, 1000);
  const holders = useLive((s) => s.snap?.accounts, 1000);
  const insts = useMemo(() => {
    let xs: InstDay[] = byInstrument(fills);
    // where this account is the only one trading the instrument, the instrument's own day counts are its
    // counts: they agree with the instrument's page (the recent fills reach back only 2,000 fills)
    const others = new Set((allFills ?? []).filter((f) => f.account !== id).map((f) => f.venue + f.symbol));
    xs = xs.map((x) => {
      const r = others.has(x.venue + x.symbol) ? null : symbols?.find((s) => s.symbol === x.symbol && s.venue === x.venue);
      return r && r.fills_day >= x.n ? { ...x, n: r.fills_day, volume: r.volume_day } : x;
    });
    const total = xs.reduce((t, x) => t + x.volume, 0);
    xs = xs.map((x) => ({ ...x, share: total > 0 ? x.volume / total : 0 })).sort((a, b) => b.volume - a.volume);
    for (const r of symbols ?? []) {
      if (r.venue !== "usdm" || !(r.fills_day > 0)) continue;
      if (xs.some((x) => x.venue === "usdm" && x.symbol === r.symbol)) continue;
      const who = (holders ?? []).filter((h) => h.positions.some((p) => p.symbol === r.symbol));
      if (who.length !== 1 || who[0]!.id !== id) continue;
      xs.push({ symbol: r.symbol, venue: "usdm", n: r.fills_day, volume: r.volume_day, share: null, edge: undefined });
    }
    return xs;
  }, [fills, allFills, symbols, holders, id]);
  if (!a) {
    return (
      <Section>
        <div className="m-empty">No account “{id}” on the desk.</div>
      </Section>
    );
  }
  const zone = tz === "utc" ? " UTC" : "";
  const pts = series?.pnl_day ?? [];
  const ts = series?.t ?? [];
  // day PnL an hour ago, from the account's own series
  let h1: number | null = null;
  if (ts.length > 1 && ts[ts.length - 1]! - ts[0]! >= 3_600_000) {
    const cut = ts[ts.length - 1]! - 3_600_000;
    let i = ts.length - 1;
    while (i > 0 && ts[i]! > cut) i--;
    h1 = a.pnl_day - pts[i]!;
  }
  const stream = a.user_stream;
  const util = a.utilization != null && Number.isFinite(a.utilization) ? a.utilization : null;
  const hasFut = a.fut_wallet !== 0 || a.positions.length > 0;
  return (
    <>
      <Section>
        <ListRow
          dense
          dot={<Dot ok={stream === "up"} warn={stream === "n/a"} />}
          title={<>Stream {stream}</>}
          subtitle={a.email || undefined}
          tone={stream === "down" ? "crit" : undefined}
          primary={<span className={"m-fig m-acc-meta" + (now - a.updated > 30_000 ? " warn-text" : " muted")}>updated {span(now - a.updated)} ago</span>}
        />
        <Hero
          label="Day PnL"
          info={TIP.dayPnl}
          v={a.pnl_day}
          sub={
            h1 != null ? (
              <>
                1h <Money v={h1} />
              </>
            ) : undefined
          }
        >
          {pts.length > 1 && (
            <Sparkline
              values={pts}
              height={48}
              range={(v) => (usdShort(v) === usdShort(a.pnl_day) ? "" : money(v, "pnlShort"))}
              ends={[hm(ts[0]!, tz), hm(ts[ts.length - 1]!, tz) + zone]}
            />
          )}
        </Hero>
        {/* where the day's figure comes from: the equity's move, less what was moved in (nothing to split without) */}
        {a.transfers_day !== 0 && (
        <SplitRows
          waterfall
          ink
          rows={[
            {
              key: "eq",
              label: "Equity change",
              info: `Equity now ${money(a.equity, "usd")} minus equity at the day start ${money(a.equity_open, "usd")}. Day PnL = Equity change − Transfers in.`,
              v: a.equity - a.equity_open,
            },
            {
              key: "tr",
              label: a.transfers_day > 0 ? "Transfers in" : "Transfers out",
              info:
                "Money moved into the account since the day start (out, if negative), net. Day PnL = Equity change − Transfers in: " +
                "money moved in is not a gain, money moved out not a loss.",
              v: -a.transfers_day,
              shown: { v: Math.abs(a.transfers_day), kind: "usd" },
            },
          ]}
        />
        )}
      </Section>

      {a.positions.length > 0 && (
        <Section title="Futures positions" link={{ label: "All accounts", to: { page: "assets" } }}>
          <PositionsTable rows={a.positions.map((p) => ({ ...p, account: a.label }))} showAccount={false} />
        </Section>
      )}

      <Section
        title="Instruments today"
        info={
          "What this account traded today, by instrument: fills, the share of the account's volume, the volume (right) and the " +
          "notional-weighted edge at the fill.\n\nCounts are the instrument's own day counts (as on its page) where only this account " +
          "trades it; where other accounts trade it too, they count this account's fills in the latest 2,000 fills of the desk. " +
          "PnL is not split by account; the instrument's page has it, all accounts."
        }
        right={insts.length ? "volume" : undefined}
      >
        {insts.length === 0 && <div className="m-empty">No fills today</div>}
        {insts.slice(0, 8).map((x) => (
          <ListRow
            key={x.venue + x.symbol}
            dense
            title={<InstName r={{ symbol: x.symbol, venue: x.venue, dust: false }} />}
            subtitle={x.share != null ? `${int(x.n)} fills · ${pct(x.share, 0)} of volume` : `${int(x.n)} fills`}
            primary={<Money v={x.volume} kind="short" />}
            secondary={
              x.edge !== undefined ? (
                <>
                  edge <Bps v={x.edge} />
                </>
              ) : undefined
            }
            to={{ page: "desk", detail: { kind: "instrument", symbol: x.symbol, venue: x.venue } }}
          />
        ))}
      </Section>

      <Section title="Balance" info={TIP.equity}>
        <KV
          cols={3}
          items={[
            { label: "Equity", info: TIP.equity, value: <Money v={a.equity} kind="usd" /> },
            { label: "Day start equity", info: "Equity at the day start, USDT.", value: <Money v={a.equity_open} kind="usd" /> },
            {
              label: "Rebates",
              info: "Market-maker rebates credited since the day start: already part of Day PnL (they raise the equity), USDT.",
              value: <Money v={a.rebates} kind="usd" />,
            },
            { label: "USDT free", info: "Free spot quote balance, USDT.", value: <Money v={a.quote_free} kind="usd" /> },
            { label: "USDT locked", info: "Spot quote balance locked in open orders, USDT.", value: <Money v={a.quote_locked} kind="usd" /> },
            {
              label: "Inventory",
              info: "Non-quote spot assets, free + locked, at mid, USDT.",
              value: <Money v={a.inventory_value} kind="usd" />,
            },
          ]}
        />
      </Section>

      {hasFut && (
        <Section title="Futures">
          <KV
            cols={3}
            items={[
              { label: "Wallet", info: "USD-M futures wallet balance, USDT.", value: <Money v={a.fut_wallet} kind="usd" /> },
              { label: "uPnL", info: "Unrealized PnL of futures positions at mark, USDT.", value: <Money v={a.fut_upnl} /> },
              { label: "Available", info: "Futures available balance, USDT.", value: <Money v={a.fut_available} kind="usd" /> },
            ]}
          />
        </Section>
      )}

      <Section title="Orders" link={{ label: "Open orders", to: { page: "orders" } }}>
        {a.orders_10s_limit > 0 && (
          <RateMeter
            label="Orders 10 s"
            info={`${TIP.o10} ${int(a.orders_10s)} of ${int(a.orders_10s_limit)}.`}
            value={a.orders_10s}
            limit={a.orders_10s_limit}
          />
        )}
        {a.orders_1d_limit > 0 && (
          <RateMeter
            label="Orders 1 d"
            info={`${TIP.o1d} ${int(a.orders_1d)} of ${limitK(a.orders_1d_limit)} today (${pct(a.orders_1d / a.orders_1d_limit, 1)}).`}
            value={a.orders_1d}
            limit={a.orders_1d_limit}
            pct
          />
        )}
        {util != null && (
          <RateMeter
            label="Bid use"
            info={`${TIP.bid} Near 100 %, there is little USDT left to bid with. Resting bids ${money(a.bids_notional, "usd")} of ${money(a.bids_notional + a.quote_free, "usd")} USDT quote.`}
            value={util}
            limit={1}
            pct
          />
        )}
        <KV
          cols={3}
          items={[
            { label: "Open", info: "Number of open orders.", value: int(a.open_orders) },
            { label: "Bids", info: "Resting bid notional, USDT.", value: <Money v={a.bids_notional} kind="usd" /> },
            { label: "Asks", info: "Resting ask notional, USDT.", value: <Money v={a.asks_notional} kind="usd" /> },
          ]}
        />
        {a.fees.map((f) => (
          <ListRow
            key={f.venue}
            dense
            title={
              <>
                {f.venue === "spot" ? "Spot fee" : "USD-M fee"}
                {f.changed && <Tag tone="warn">changed</Tag>}
              </>
            }
            subtitle="maker / taker"
            primary={
              <span className={"m-fig" + (f.changed ? " warn-text" : "")}>
                {num(f.maker_bps, 1)} / {num(f.taker_bps, 1)}
                <span className="m-unit">bps</span>
              </span>
            }
          />
        ))}
      </Section>

      {/* nothing recent: Instruments today has already said so */}
      {fills.length > 0 && (
        <div className="m-hold" {...hold}>
          <Section
            title="Recent fills"
            link={fills.length > FILLS ? { label: `All ${int(fills.length)}`, to: { page: "fills", account: id } } : undefined}
          >
            {fills.slice(0, FILLS).map((f) => (
              <FillRow key={f.id} f={f} onOpen={fill.open} account={false} />
            ))}
          </Section>
        </div>
      )}
      {fill.sheet}
    </>
  );
}

type InstDay = { symbol: string; venue: Fill["venue"]; n: number; volume: number; share: number | null; edge: number | null | undefined };

/** Today's fills of one account by instrument: count, volume, its share, the notional-weighted edge. */
function byInstrument(fills: Fill[]): InstDay[] {
  const m = new Map<string, { symbol: string; venue: Fill["venue"]; n: number; volume: number; ew: number; w: number }>();
  let total = 0;
  for (const f of fills) {
    const k = f.venue + f.symbol;
    let x = m.get(k);
    if (!x) m.set(k, (x = { symbol: f.symbol, venue: f.venue, n: 0, volume: 0, ew: 0, w: 0 }));
    x.n++;
    x.volume += f.notional;
    total += f.notional;
    if (f.edge_bps != null && Number.isFinite(f.edge_bps)) {
      x.ew += f.edge_bps * f.notional;
      x.w += f.notional;
    }
  }
  return [...m.values()]
    .map((x) => ({ symbol: x.symbol, venue: x.venue, n: x.n, volume: x.volume, share: total > 0 ? x.volume / total : 0, edge: x.w > 0 ? x.ew / x.w : null }))
    .sort((a, b) => b.volume - a.volume);
}
