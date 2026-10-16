import { useMemo } from "react";
import { navigate, useStore } from "../../store";
import { useNow } from "../../hooks";
import { bps, hms, int, num, pct, price } from "../../format";
import { showInfo, span, useLive } from "../../components/mobile";
import type { Account, Exposure } from "../../protocol";
import { TIP, bandDef, useQty } from "./shared";
import { Amt, Big, Empty, PageTabs, Row, Sec, Stats, limitCls, pctSigned, useAmt } from "./rest/ui";
import { AccountsChart, DeskChart, Eye, GapBar, PositionRow } from "./rest/assets";
import { useExPref } from "../../components/ex";
import "./accounts.css";

type Tab = "accounts" | "spot" | "futures" | "exposure";
const TABS: Tab[] = ["accounts", "spot", "futures", "exposure"];

const betaNote = (x: Exposure) =>
  x.beta_source === "estimate" ? "β: the desk's own estimate, may differ from the engine's." : "β: configured per market.";

/** Assets: the desk's total value and today's PnL, then Accounts | Spot | Futures | Exposure. */
export function AccountsM() {
  const sm = useStore((s) => s.snap?.summary);
  const accounts = useLive((s) => s.snap?.accounts, 250);
  const [tab, setTab] = useExPref<Tab>("m-assets", "tab", "accounts", TABS);
  const money = useAmt();
  const open = sm ? sm.equity - sm.pnl_day : null;
  const nPos = (accounts ?? []).reduce((n, a) => n + a.positions.length, 0);

  return (
    <>
      <Big
        label={
          <>
            Est. total value (USDT)
            <Eye />
          </>
        }
        value={money(sm?.equity, "full")}
        sub={
          <button type="button" className="a-today" onClick={() => navigate({ page: "history" })}>
            Today's PnL <Amt v={sm?.pnl_day} />
            <span className={"r-fig " + (sm && open ? (sm.pnl_day > 0 ? "up" : sm.pnl_day < 0 ? "down" : "") : "")}>
              ({sm && open ? pctSigned(sm.pnl_day / open) : "--"})
            </span>
          </button>
        }
      />
      <PageTabs
        items={[
          { value: "accounts", label: "Accounts" },
          { value: "spot", label: "Spot" },
          { value: "futures", label: "Futures", count: nPos || null },
          { value: "exposure", label: "Exposure" },
        ]}
        value={tab}
        onChange={setTab}
      />
      {accounts &&
        (tab === "accounts" ? <AccountsTab accounts={accounts} /> : tab === "spot" ? <SpotTab accounts={accounts} /> : tab === "futures" ? <FuturesTab accounts={accounts} /> : <ExposureTab accounts={accounts} />)}
    </>
  );
}

// ---- Accounts ----

function AccountsTab({ accounts }: { accounts: Account[] }) {
  const now = useNow(1000) + useStore.getState().skew;
  return (
    <>
      <Sec flush>
        {accounts.map((a) => (
          <AccountRow key={a.id} a={a} now={now} />
        ))}
      </Sec>
      <Sec>
        <AccountsChart accounts={accounts} />
      </Sec>
      <Sec>
        <DeskChart what="equity" />
      </Sec>
    </>
  );
}

function AccountRow({ a, now }: { a: Account; now: number }) {
  const money = useAmt();
  const util = a.utilization != null && Number.isFinite(a.utilization) ? a.utilization : null;
  const ut = limitCls(util);
  const old = now - a.updated > 30_000;
  return (
    <Row
      title={
        <>
          {a.label}
          {a.role === "master" && <span className="r-tag">Master</span>}
          {a.user_stream === "down" && <span className="r-tag crit">Stream down</span>}
        </>
      }
      sub={
        <>
          Equity {money(a.equity, "full")}
          {old && <span className="warn-text"> · {span(now - a.updated)} old</span>}
        </>
      }
      value={<Amt v={a.pnl_day} />}
      valueSub={util != null ? <span className={ut === "crit" ? "crit-text" : ut === "warn" ? "warn-text" : ""}>Bid use {pct(util, 0)}</span> : undefined}
      to={{ page: "assets", detail: { kind: "account", id: a.id } }}
    />
  );
}

// ---- Spot: USDT and the inventory, by asset ----

function SpotTab({ accounts }: { accounts: Account[] }) {
  const symbols = useLive((s) => s.snap?.symbols, 1000);
  const money = useAmt();
  const q = useQty();
  const t = accounts.reduce((m, a) => ({ free: m.free + a.quote_free, locked: m.locked + a.quote_locked, inv: m.inv + a.inventory_value }), { free: 0, locked: 0, inv: 0 });
  const held = useMemo(
    () => (symbols ?? []).filter((r) => r.venue === "spot" && Math.abs(r.inv_value) >= 1).sort((a, b) => Math.abs(b.inv_value) - Math.abs(a.inv_value)),
    [symbols],
  );
  return (
    <>
      <Sec flush>
        <Stats
          cols={3}
          items={[
            { label: "Inventory", info: "Non-quote spot assets, free + locked, at mid, all accounts, USDT.", value: money(t.inv, "full") },
            { label: "USDT free", value: money(t.free, "full") },
            { label: "USDT locked", info: "Spot quote balance locked in open orders, USDT.", value: money(t.locked, "full") },
          ]}
        />
      </Sec>
      <Sec title="Holdings" right="value · today">
        {held.map((r) => {
          const base = r.symbol.replace(/USDT$/, "");
          return (
            <Row
              key={r.symbol}
              title={
                <>
                  {base}
                  {r.dust && <span className="r-tag">Dust</span>}
                </>
              }
              sub={`${q(r.inv_qty)} ${base}${r.avg_cost ? ` · avg ${price(r.avg_cost)}` : ""}`}
              value={<Amt v={r.inv_value} kind="full" />}
              valueSub={<Amt v={r.trading_pnl} />}
              to={{ page: "desk", detail: { kind: "instrument", symbol: r.symbol, venue: "spot" } }}
            />
          );
        })}
        {!held.length && <Empty>No spot inventory</Empty>}
      </Sec>
    </>
  );
}

// ---- Futures: margin, positions, today's hedge legs, funding ----

function FuturesTab({ accounts }: { accounts: Account[] }) {
  const x = useStore((s) => s.snap?.exposure);
  const tz = useStore((s) => s.tz);
  const now = useNow(1000) + useStore.getState().skew;
  const money = useAmt();
  const q = useQty();
  const t = accounts.reduce((m, a) => ({ w: m.w + a.fut_wallet, u: m.u + a.fut_upnl, av: m.av + a.fut_available }), { w: 0, u: 0, av: 0 });
  const pos = accounts.flatMap((a) => a.positions.map((p) => ({ p, a })));
  const hd = x?.hedge_day;
  return (
    <>
      <Sec flush>
        <Stats
          cols={3}
          items={[
            { label: "Wallet", info: "USD-M futures wallet balance, all accounts, USDT.", value: money(t.w, "full") },
            { label: "uPnL", info: TIP.upnl, value: <Amt v={t.u} /> },
            { label: "Available", value: money(t.av, "full") },
          ]}
        />
      </Sec>
      <Sec title="Positions" info={`uPnL: ${TIP.upnl}\n\nToday: ${TIP.today}`} right="uPnL · today">
        {pos.map(({ p, a }) => (
          <PositionRow key={a.id + p.symbol} p={p} account={a.label} />
        ))}
        {!pos.length && <Empty>No open positions</Empty>}
      </Sec>
      {hd && hd.legs.length > 0 && (
        <Sec title="Hedge legs today" info="Since the day start: the position at the day start, today's fills and fees, and the day start's mark." right="fills · fees">
          {hd.legs.map((l) => (
            <Row
              key={l.symbol}
              dense
              title={l.symbol}
              sub={`start ${q(l.qty0, true)} · mark then ${price(l.mark0)}`}
              value={<span className="r-fig">{int(l.fills)}</span>}
              valueSub={<Amt v={-l.fees} />}
            />
          ))}
        </Sec>
      )}
      {x && x.funding.length > 0 && (
        <Sec title="Funding" right="rate · next">
          {x.funding.map((f) => (
            <Row
              key={f.symbol}
              dense
              title={f.symbol}
              sub={`position ${q(f.position, true)}`}
              value={<span className="r-fig">{f.rate == null ? "--" : `${bps(f.rate * 1e4)} bps`}</span>}
              valueSub={f.next == null ? "--" : `${hms(f.next, tz)} · in ${span(f.next - now)}`}
            />
          ))}
        </Sec>
      )}
    </>
  );
}

// ---- Exposure: the gap against its band, the hedge, by account ----

function ExposureTab({ accounts }: { accounts: Account[] }) {
  const x = useStore((s) => s.snap?.exposure);
  const sm = useStore((s) => s.snap?.summary);
  const tz = useStore((s) => s.tz);
  const money = useAmt();
  if (!x || !sm) return null;
  const labelOf = (id: string) => accounts.find((a) => a.id === id)?.label ?? id;
  const hd = x.hedge_day;
  const inv = sm.pnl.inventory;
  const offset = hd && hd.hedge_pnl != null && Math.abs(inv) > 1e-9 ? -hd.hedge_pnl / inv : null;
  const gapInfo = x.paused
    ? `${x.paused}: the hedge is off and its target is 0; the value is the hedge symbols' futures notional still open, to be closed` +
      `${x.paused_until != null ? `, until ${hms(x.paused_until, tz)}` : ""}. USDT.`
    : `Hedge target minus the futures notional of the hedge symbols (the trade that closes it; negative = sell more), where the target is ` +
      `−${num(x.ratio, 2)} × beta-weighted spot value. ${betaNote(x)} ${bandDef(money(x.band, "full"))} USDT.`;
  return (
    <>
      <Sec flush>
        {x.band != null && (x.gap != null || x.paused) && (
          <GapBar
            label={x.paused ? `Hedge to close (${x.paused})` : "Exposure gap"}
            value={x.paused ? x.hedge_notional : x.gap}
            band={x.band}
            onLabel={() => showInfo(x.paused ? "Hedge to close" : "Exposure gap", gapInfo)}
          />
        )}
        <Stats
          cols={3}
          items={[
            { label: "Net exposure", info: `Spot inventory value plus futures net notional, all accounts. USDT.`, value: <Amt v={x.net} plain /> },
            {
              label: "Hedge target",
              info: `Hedge target = −${num(x.ratio, 2)} × Spot × beta (${money(x.beta_value, "full")}). ${betaNote(x)} USDT.`,
              value: <Amt v={x.target} plain />,
            },
            { label: "Hedge", info: "Futures notional of the hedge symbols, USDT.", value: <Amt v={x.hedge_notional} plain /> },
            { label: "Spot value", value: money(x.spot_value, "full") },
            { label: "Futures", value: <Amt v={x.futures_notional} plain /> },
            { label: "Spot × beta", info: "The spot inventory's value with each market weighted by its beta to the hedge instrument. USDT.", value: money(x.beta_value, "full") },
          ]}
        />
      </Sec>
      {hd && (
        <Sec
          title="Inventory and hedge today"
          info="Since the day start: the Inventory PnL of the Desk against what the futures legs made. Offset: −Hedge ÷ Inventory PnL; 100 % cancels it exactly."
        >
          <Stats
            cols={4}
            items={[
              { label: "Inventory", value: <Amt v={inv} /> },
              { label: "Hedge", value: <Amt v={hd.hedge_pnl} /> },
              { label: "Net", value: <Amt v={inv + (hd.hedge_pnl ?? 0)} /> },
              { label: "Offset", value: offset != null ? pct(offset, 0) : "--" },
            ]}
          />
        </Sec>
      )}
      <Sec title="By account" right="spot · futures · net">
        {x.by_account.map((r) => (
          <Row
            key={r.account}
            dense
            title={labelOf(r.account)}
            sub={`Spot ${money(r.spot_value, "k")} · Futures ${money(r.futures_notional, "pnlK")}`}
            value={<Amt v={r.net} kind="pnlK" plain />}
            to={{ page: "assets", detail: { kind: "account", id: r.account } }}
          />
        ))}
      </Sec>
      <Sec>
        <DeskChart what="exposure" />
      </Sec>
    </>
  );
}
