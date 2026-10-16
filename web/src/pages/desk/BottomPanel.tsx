// The Desk's bottom panel, the positions / open orders panel of an exchange's trade page: one tab at a time,
// each with its count, its filters at the right of the tab row.
import { useMemo } from "react";
import { isHidden, useStore, type Instrument } from "../../store";
import { Tabs, TextToggle, useExPref } from "../../components/ex";
import { SymbolsGrid } from "../../components/SymbolsGrid";
import { FillsTape, MARKOUT_BASIS, type MarkoutBasis } from "../../components/FillsTape";
import { AccountsGrid } from "../../components/AccountsGrid";
import { AlertsList } from "../../components/AlertsList";
import { OrdersGrid } from "./OrdersGrid";
import { useHide } from "../../mask";

type Tab = "inventory" | "orders" | "fills" | "accounts" | "alerts";
const TABS: Tab[] = ["inventory", "orders", "fills", "accounts", "alerts"];

export function BottomPanel({ sel }: { sel: Instrument | null }) {
  const [tab, setTab] = useExPref<Tab>("desk.bottom", "tab", "inventory", TABS);
  const [dust, setDust] = useExPref<boolean>("desk.bottom", "hideDust", false);
  const [basis, setBasis] = useExPref<MarkoutBasis>("desk.bottom", "basis", "net", ["net", "fast", "raw"]);
  const [scope, setScope] = useExPref<string>("desk.bottom", "scope", "all", ["all", "one"]);
  const hide = useHide();
  const nSym = useStore((s) => (dust ? s.snap?.symbols.filter((r) => !r.dust || r.fills_day > 0).length : s.snap?.symbols.length));
  const nOrders = useStore((s) => s.snap?.orders.length);
  const nFills = useStore((s) => s.snap?.summary.fills_day);
  const nAcc = useStore((s) => s.snap?.accounts.length);
  const alerts = useStore((s) => s.snap?.alerts);
  const hiddenAlerts = useStore((s) => s.hiddenAlerts);
  const nAlerts = useMemo(() => (alerts ?? []).filter((a) => a.active && !isHidden(a, hiddenAlerts)).length, [alerts, hiddenAlerts]);
  const one = scope === "one" && sel != null ? sel : null;

  const scoped = (tab === "orders" || tab === "fills") && sel != null;
  const right = (
    <>
      {scoped && (
        <TextToggle
          label="Instruments shown"
          options={[
            { value: "all", label: "All" },
            { value: "one", label: sel!.symbol + (sel!.venue === "usdm" ? " Perp" : "") },
          ]}
          value={scope === "one" ? "one" : "all"}
          onChange={setScope}
        />
      )}
      {tab === "fills" && <TextToggle label="Markout basis" options={MARKOUT_BASIS} value={basis} onChange={setBasis} />}
      {tab === "inventory" && (
        <button type="button" className={"dk-pill" + (dust ? " on" : "")} aria-pressed={dust} onClick={() => setDust(!dust)} title="Leave out balances below the min notional that did not trade today">
          Hide dust
        </button>
      )}
    </>
  );

  return (
    <section className={"dk-panel dk-bottom" + (hide ? " dk-hide" : "")}>
      <div className="dk-head">
        <Tabs
          items={[
            { value: "inventory", label: "Inventory", count: nSym },
            { value: "orders", label: "Open orders", count: nOrders },
            { value: "fills", label: "Fills", count: nFills, title: "Today's fills" },
            { value: "accounts", label: "Accounts", count: nAcc },
            { value: "alerts", label: "Alerts", count: nAlerts || null, title: "Active alerts" },
          ]}
          value={tab}
          onChange={setTab}
          right={right}
          className="dk-bottom-tabs"
        />
      </div>
      <div className={"dk-bottom-body" + (tab === "accounts" ? " dk-accounts" : "") + (tab === "alerts" ? " dk-alerts" : "")}>
        {tab === "inventory" && <SymbolsGrid selected={sel} hideDust={dust} />}
        {tab === "orders" && <OrdersGrid symbol={one} />}
        {tab === "fills" && <FillsTape mode={basis} symbol={one} />}
        {tab === "accounts" && <AccountsGrid />}
        {tab === "alerts" && <AlertsList />}
      </div>
    </section>
  );
}
