import { useMemo } from "react";
import { navigate, useStore } from "../../store";
import { useNow } from "../../hooks";
import { pct, price } from "../../format";
import { span, useLive } from "../../components/mobile";
import type { Account } from "../../protocol";
import { TIP, useQty } from "./shared";
import { Amt, Big, Empty, PageTabs, Row, Sec, Stats, limitCls, useAmt } from "./rest/ui";
import { pctOfMoney, useHide } from "../../mask";
import { AccountsChart, DeskChart, Eye, PositionRow } from "./rest/assets";
import { useExPref } from "../../components/ex";
import "./accounts.css";
import { oneCol, oneColWord } from "../../selectors";
import { cur, baseOf, useDesk, isSpot, hasPerps, roled, cashWord } from "../../desk";

// the exposure and the hedge are on Strategy (the engine's own figures); a remembered "exposure" falls back
type Tab = "accounts" | "spot" | "futures";
const TABS: Tab[] = ["accounts", "spot", "futures"];

/** Assets: the desk's total value and today's PnL, where it sits and what moved it besides trading, then
 *  Accounts | Spot | Futures. */
export function AccountsM() {
  const sm = useStore((s) => s.snap?.summary);
  const accounts = useLive((s) => s.snap?.accounts, 250);
  const [saved, setTab] = useExPref<Tab>("m-assets", "tab", "accounts", TABS);
  const desk = useDesk();
  // no futures on this desk: a tab remembered from elsewhere falls back
  const tab = !hasPerps(desk) && saved === "futures" ? "accounts" : saved;
  const money = useAmt();
  const hide = useHide();
  const open = sm ? sm.equity - sm.pnl_day : null;
  // where the value sits, and the day's two figures that are not trading (as the desktop's Assets head)
  const t = useMemo(() => {
    if (!accounts) return null;
    const sum = (f: (a: Account) => number) => accounts.reduce((k, a) => k + f(a), 0);
    return {
      spot: sum((a) => a.quote_free + a.quote_locked + a.inventory_value),
      fut: sum((a) => a.fut_wallet + a.fut_upnl),
      transfers: sum((a) => a.transfers_day),
    };
  }, [accounts]);

  return (
    <>
      <Big
        label={
          <>
            Est. total value ({cur()})
            <Eye />
          </>
        }
        value={money(sm?.equity, "full")}
        sub={
          <button type="button" className="a-today" onClick={() => navigate({ page: "history" })}>
            Day PnL <Amt v={sm?.pnl_day} />
            <span className={"fig " + (hide ? "masked" : sm && open ? (sm.pnl_day > 0 ? "up" : sm.pnl_day < 0 ? "down" : "") : "")}>
              ({sm && open ? pctOfMoney(sm.pnl_day / open, hide) : "--"})
            </span>
          </button>
        }
      />
      <Stats
        className="a-parts"
        cols={hasPerps(desk) ? 4 : 3}
        items={[
          { label: "Spot", value: t ? money(t.spot, "full") : "--" },
          ...(hasPerps(desk) ? [{ label: "Futures", value: t ? money(t.fut, "full") : "--" }] : []),
          ...(desk.rebates ? [{ label: "Rebates today", value: <Amt v={sm?.rebates} plain /> }] : []),
          { label: "Transfers today", value: <Amt v={t?.transfers} plain /> },
        ]}
      />
      <PageTabs
        items={[
          { value: "accounts", label: "Accounts" },
          { value: "spot", label: "Spot" },
          ...(hasPerps(desk) ? [{ value: "futures" as const, label: "Futures" }] : []),
        ]}
        value={tab}
        onChange={setTab}
      />
      {accounts &&
        (tab === "accounts" ? <AccountsTab accounts={accounts} /> : tab === "spot" ? <SpotTab accounts={accounts} /> : <FuturesTab accounts={accounts} />)}
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
  const desk = useDesk();
  const symbols = useLive((s) => s.snap?.symbols, 1000);
  const money = useAmt();
  const q = useQty();
  const t = accounts.reduce((m, a) => ({ free: m.free + a.quote_free, locked: m.locked + a.quote_locked, inv: m.inv + a.inventory_value }), { free: 0, locked: 0, inv: 0 });
  const held = useMemo(
    () => (symbols ?? []).filter((r) => isSpot(r.venue) && Math.abs(r.inv_value) >= 1).sort((a, b) => Math.abs(b.inv_value) - Math.abs(a.inv_value)),
    [symbols],
  );
  return (
    <>
      <Sec flush>
        <Stats
          cols={3}
          items={[
            { label: "Inventory", info: `Non-quote spot assets, free + locked, at mid, all accounts, ${cur()}.`, value: money(t.inv, "full") },
            { label: `${cashWord()} free`, value: money(t.free, "full") },
            { label: `${cashWord()} locked`, info: `Spot quote balance locked in open orders, ${cur()}.`, value: money(t.locked, "full") },
          ]}
        />
      </Sec>
      <Sec title="Holdings" right={`value · ${oneColWord(desk.mm)}`}>
        {held.map((r) => {
          const base = baseOf(r.symbol);
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
              valueSub={<Amt v={oneCol(r, desk.mm)} />}
              to={{ page: "desk", detail: { kind: "instrument", symbol: r.symbol, venue: r.venue } }}
            />
          );
        })}
        {!held.length && <Empty>No spot inventory</Empty>}
      </Sec>
    </>
  );
}

// ---- Futures: margin and positions (the hedge legs and funding are on Strategy) ----

function FuturesTab({ accounts }: { accounts: Account[] }) {
  const money = useAmt();
  const t = accounts.reduce((m, a) => ({ w: m.w + a.fut_wallet, u: m.u + a.fut_upnl, av: m.av + a.fut_available }), { w: 0, u: 0, av: 0 });
  const pos = accounts.flatMap((a) => a.positions.map((p) => ({ p, a })));
  return (
    <>
      <Sec flush>
        <Stats
          cols={3}
          items={[
            { label: "Wallet", info: `Perp wallet balance, all accounts, ${cur()}.`, value: money(t.w, "full") },
            { label: "uPnL", info: TIP.upnl, value: <Amt v={t.u} /> },
            { label: "Available", value: money(t.av, "full") },
          ]}
        />
      </Sec>
      <Sec title="Positions" info={`uPnL: ${TIP.upnl}\n\nToday: ${TIP.today}`} right={roled() ? "uPnL · today" : "uPnL · hedge today"}>
        {pos.map(({ p, a }) => (
          <PositionRow key={a.id + p.symbol} p={p} account={a.label} />
        ))}
        {!pos.length && <Empty>No open positions</Empty>}
      </Sec>
    </>
  );
}
