import { useMemo } from "react";
import { navigate, useStore } from "../../store";
import { useNow } from "../../hooks";
import { bps, int, num, pct } from "../../format";
import { span, useHold, useLive } from "../../components/mobile";
import { useExPref } from "../../components/ex";
import type { Fill } from "../../protocol";
import { FillRow, TIP, useFillSheet } from "./shared";
import { Amt, Big, Empty, Meter, PageTabs, Row, Sec, Stats, useAmt } from "./rest/ui";
import { AccountsChart, Eye, PositionRow } from "./rest/assets";
import "./accounts.css";

const FILLS = 30;
type Tab = "balance" | "instruments" | "orders" | "fills";

/** One account: its Day PnL today on a chart, then Balance | Instruments | Orders | Fills. */
export function AccountM({ id }: { id: string }) {
  const a = useLive((s) => s.snap?.accounts.find((x) => x.id === id), 250, false, id);
  const series = useLive((s) => s.snap?.account_series.find((x) => x.account === id), 1000, false, id);
  const accounts = useLive((s) => s.snap?.accounts, 1000);
  const [tab, setTab] = useExPref<Tab>("m-account", "tab", "balance", ["balance", "instruments", "orders", "fills"]);
  const now = useNow(1000) + useStore.getState().skew;
  if (!a || !accounts) return <Empty>No account “{id}” on the desk.</Empty>;

  // Day PnL an hour ago, from the account's own series
  const pts = series?.pnl_day ?? [];
  const ts = series?.t ?? [];
  let h1: number | null = null;
  if (ts.length > 1 && ts[ts.length - 1]! - ts[0]! >= 3_600_000) {
    const cut = ts[ts.length - 1]! - 3_600_000;
    let i = ts.length - 1;
    while (i > 0 && ts[i]! > cut) i--;
    h1 = a.pnl_day - pts[i]!;
  }
  const old = now - a.updated > 30_000;
  return (
    <>
      <Big
        label={
          <>
            Day PnL (USDT)
            <Eye />
          </>
        }
        value={<Amt v={a.pnl_day} />}
        sub={
          <>
            {h1 != null && (
              <>
                1h <Amt v={h1} />
              </>
            )}
            <span className={a.user_stream === "down" ? "crit-text" : old ? "warn-text" : ""}>
              {h1 != null && " · "}Stream {a.user_stream}
              {old ? `, ${span(now - a.updated)} old` : ""}
            </span>
          </>
        }
      />
      <AccountsChart accounts={accounts} only={id} />
      <PageTabs
        items={[
          { value: "balance", label: "Balance" },
          { value: "instruments", label: "Instruments" },
          { value: "orders", label: "Orders", count: a.open_orders || null },
          { value: "fills", label: "Fills" },
        ]}
        value={tab}
        onChange={setTab}
      />
      {tab === "balance" ? <Balance id={id} /> : tab === "instruments" ? <Instruments id={id} /> : tab === "orders" ? <Orders id={id} /> : <Fills id={id} />}
    </>
  );
}

function Balance({ id }: { id: string }) {
  const a = useLive((s) => s.snap?.accounts.find((x) => x.id === id), 250, false, id);
  const money = useAmt();
  if (!a) return null;
  const hasFut = a.fut_wallet !== 0 || a.positions.length > 0;
  return (
    <>
      <Sec flush>
        <Stats
          cols={3}
          items={[
            { label: "Equity", info: TIP.equity, value: money(a.equity, "full") },
            { label: "Day start", info: "Equity at the day start, USDT.", value: money(a.equity_open, "full") },
            {
              label: a.transfers_day >= 0 ? "Transfers in" : "Transfers out",
              info: "Money moved into the account since the day start (out, if negative), net. Day PnL = equity change − transfers in.",
              value: money(Math.abs(a.transfers_day), "full"),
            },
            { label: "USDT free", value: money(a.quote_free, "full") },
            { label: "USDT locked", info: "Spot quote balance locked in open orders, USDT.", value: money(a.quote_locked, "full") },
            { label: "Inventory", info: "Non-quote spot assets, free + locked, at mid, USDT.", value: money(a.inventory_value, "full") },
            { label: "Rebates", info: "Market-maker rebates credited since the day start: already part of Day PnL, USDT.", value: <Amt v={a.rebates} /> },
          ]}
        />
      </Sec>
      {hasFut && (
        <Sec title="Futures" right="uPnL · today">
          <Stats
            cols={3}
            items={[
              { label: "Wallet", value: money(a.fut_wallet, "full") },
              { label: "uPnL", info: TIP.upnl, value: <Amt v={a.fut_upnl} /> },
              { label: "Available", value: money(a.fut_available, "full") },
            ]}
          />
          {a.positions.map((p) => (
            <PositionRow key={p.symbol} p={p} />
          ))}
        </Sec>
      )}
    </>
  );
}

type InstDay = { symbol: string; venue: Fill["venue"]; n: number; volume: number; share: number | null; edge: number | null | undefined };

function Instruments({ id }: { id: string }) {
  const allFills = useLive((s) => s.snap?.fills, 1000);
  const symbols = useLive((s) => s.snap?.symbols, 1000);
  const holders = useLive((s) => s.snap?.accounts, 1000);
  const money = useAmt();
  const insts = useMemo(() => {
    const fills = (allFills ?? []).filter((f) => f.account === id);
    let xs: InstDay[] = byInstrument(fills);
    // where this account is the only one trading the instrument, the instrument's own day counts are its counts
    const others = new Set((allFills ?? []).filter((f) => f.account !== id).map((f) => f.venue + f.symbol));
    xs = xs.map((x) => {
      const r = others.has(x.venue + x.symbol) ? null : symbols?.find((s) => s.symbol === x.symbol && s.venue === x.venue);
      return r && r.fills_day >= x.n ? { ...x, n: r.fills_day, volume: r.volume_day } : x;
    });
    const total = xs.reduce((t, x) => t + x.volume, 0);
    xs = xs.map((x) => ({ ...x, share: total > 0 ? x.volume / total : 0 })).sort((p, q) => q.volume - p.volume);
    for (const r of symbols ?? []) {
      if (r.venue !== "usdm" || !(r.fills_day > 0)) continue;
      if (xs.some((x) => x.venue === "usdm" && x.symbol === r.symbol)) continue;
      const who = (holders ?? []).filter((h) => h.positions.some((p) => p.symbol === r.symbol));
      if (who.length !== 1 || who[0]!.id !== id) continue;
      xs.push({ symbol: r.symbol, venue: "usdm", n: r.fills_day, volume: r.volume_day, share: null, edge: undefined });
    }
    return xs;
  }, [allFills, symbols, holders, id]);
  return (
    <Sec
      flush
      title="Traded today"
      info="What this account traded today, by instrument: fills, the share of the account's volume, the volume and the notional-weighted edge at the fill. PnL is not split by account; the instrument's page has it, all accounts."
      right="volume · edge"
    >
      {insts.map((x) => (
        <Row
          key={x.venue + x.symbol}
          title={
            <>
              {x.symbol}
              {x.venue === "usdm" && <span className="r-tag">Perp</span>}
            </>
          }
          sub={x.share != null ? `${int(x.n)} fills · ${pct(x.share, 0)} of volume` : `${int(x.n)} fills`}
          value={money(x.volume, "k")}
          valueSub={x.edge != null ? `edge ${bps(x.edge)} bps` : undefined}
          to={{ page: "desk", detail: { kind: "instrument", symbol: x.symbol, venue: x.venue } }}
        />
      ))}
      {!insts.length && <Empty>No fills today</Empty>}
    </Sec>
  );
}

/** A daily limit as the definitions write it: 160K. */
const limitK = (n: number) => (n >= 10_000 ? `${int(n / 1000)}K` : int(n));

function Orders({ id }: { id: string }) {
  const a = useLive((s) => s.snap?.accounts.find((x) => x.id === id), 250, false, id);
  const money = useAmt();
  if (!a) return null;
  const util = a.utilization != null && Number.isFinite(a.utilization) ? a.utilization : null;
  return (
    <>
      <Sec flush>
        {a.orders_10s_limit > 0 && <Meter label="Orders 10 s" value={a.orders_10s} limit={a.orders_10s_limit} />}
        {a.orders_1d_limit > 0 && <Meter label="Orders today" sub={`${int(a.orders_1d)} of ${limitK(a.orders_1d_limit)}`} value={a.orders_1d} limit={a.orders_1d_limit} pct />}
        {util != null && <Meter label="Bid use" sub="resting bids ÷ USDT" value={util} limit={1} pct digits={0} />}
      </Sec>
      <Sec title="Resting" right={<button type="button" className="r-act" onClick={() => navigate({ page: "orders", account: id })}>Open orders</button>}>
        <Stats
          cols={3}
          items={[
            { label: "Open", value: int(a.open_orders) },
            { label: "Bids (USDT)", value: money(a.bids_notional, "full") },
            { label: "Asks (USDT)", value: money(a.asks_notional, "full") },
          ]}
        />
      </Sec>
      <Sec title="Fees" right="maker / taker">
        {a.fees.map((f) => (
          <Row
            key={f.venue}
            dense
            title={
              <>
                {f.venue === "spot" ? "Spot" : "USD-M"}
                {f.changed && <span className="r-tag warn">Changed</span>}
              </>
            }
            value={
              <span className={"r-fig" + (f.changed ? " warn-text" : "")}>
                {num(f.maker_bps, 1)} / {num(f.taker_bps, 1)} bps
              </span>
            }
          />
        ))}
      </Sec>
    </>
  );
}

function Fills({ id }: { id: string }) {
  const [held, hold] = useHold();
  const allFills = useLive((s) => s.snap?.fills, 250, held);
  const fill = useFillSheet();
  const fills = useMemo(() => (allFills ?? []).filter((f) => f.account === id), [allFills, id]);
  return (
    <div className="m-hold" {...hold}>
      <Sec flush title={fills.length > FILLS ? `Newest ${FILLS} of ${int(fills.length)}` : `${int(fills.length)} fills`} right={fills.length > FILLS ? <AllFills id={id} /> : undefined}>
        <div className="m-body">
          {fills.slice(0, FILLS).map((f) => (
            <FillRow key={f.id} f={f} onOpen={fill.open} account={false} />
          ))}
        </div>
        {!fills.length && <Empty>No fills today</Empty>}
      </Sec>
      {fill.sheet}
    </div>
  );
}

function AllFills({ id }: { id: string }) {
  return (
    <button type="button" className="r-act" onClick={() => navigate({ page: "fills", account: id })}>
      All fills
    </button>
  );
}

/** Today's fills of one account by instrument: count, volume, its share, the notional-weighted edge. */
function byInstrument(fills: Fill[]): InstDay[] {
  const m = new Map<string, { symbol: string; venue: Fill["venue"]; n: number; volume: number; ew: number; w: number }>();
  let total = 0;
  for (const f of fills) {
    if (f.conversion) continue; // a stablecoin conversion: on the tape, not in the account's trading
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
    .sort((p, q) => q.volume - p.volume);
}
