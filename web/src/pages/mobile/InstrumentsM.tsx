import { useMemo, useState } from "react";
import { serverNow } from "../../store";
import { useNow } from "../../hooks";
import { bps, int } from "../../format";
import { Chips, Money, Section, Segmented, span, tone, useHold, useLive, useMoney } from "../../components/mobile";
import type { SymbolRow } from "../../protocol";
import { InstrumentRow, instPnl } from "./shared";
import "./desk.css";

type Sort = "pnl" | "inv" | "mk10" | "fills" | "last";
type Venue = "all" | "spot" | "usdm";

const SORTS: { value: Sort; label: string }[] = [
  { value: "pnl", label: "PnL" },
  { value: "inv", label: "Inventory" },
  { value: "mk10", label: "Markout 10 s" },
  { value: "fills", label: "Fills" },
  { value: "last", label: "Last fill" },
];

// nulls last, whatever the direction
const by =
  (f: (r: SymbolRow) => number | null, desc: boolean) =>
  (a: SymbolRow, b: SymbolRow): number => {
    const x = f(a);
    const y = f(b);
    if (x == null || y == null) return x == null ? (y == null ? 0 : 1) : -1;
    return desc ? y - x : x - y;
  };

const order = (pnlOf: (r: SymbolRow) => number): Record<Sort, (a: SymbolRow, b: SymbolRow) => number> => ({
  pnl: by((r) => Math.abs(pnlOf(r)), true), // biggest either way, as Movers
  inv: by((r) => Math.abs(r.inv_value), true),
  mk10: by((r) => r.mk10_bps, false), // worst first
  fills: by((r) => r.fills_day, true),
  last: by((r) => r.last_fill, true),
});

/** Every tracked instrument, sorted by one key; the sort's figure moves to the row's right. */
export function InstrumentsM() {
  // the order holds still under a resting finger
  const [held, hold] = useHold();
  const rows = useLive((s) => s.snap?.symbols, 250, held);
  const legs = useLive((s) => s.snap?.exposure.hedge_day?.legs, 1000, held);
  // a perp's PnL is its hedge leg's today
  const pnlOf = useMemo(() => {
    const leg = new Map((legs ?? []).map((l) => [l.symbol, l.pnl]));
    return (r: SymbolRow) => (r.venue === "usdm" ? (leg.get(r.symbol) ?? r.upnl ?? 0) : instPnl(r));
  }, [legs]);
  const [sort, setSort] = useState<Sort>("pnl");
  const [venue, setVenue] = useState<Venue>("all");
  const money = useMoney();
  const now = useNow(sort === "last" ? 1000 : 60_000);
  const list = useMemo(
    () => (rows ?? []).filter((r) => venue === "all" || r.venue === venue).sort(order(pnlOf)[sort]),
    [rows, venue, sort, pnlOf],
  );
  const total = list.reduce((s, r) => s + pnlOf(r), 0);
  const nPerp = (rows ?? []).filter((r) => r.venue === "usdm").length;
  void now;

  const ago = (t: number | null) => (t == null ? "no fills" : `last ${span(serverNow() - t)}`);
  const inv = (r: SymbolRow) =>
    r.venue === "usdm" ? `position ${money(r.inv_value, "pnlShort")}` : `inventory ${money(r.inv_value, "short")}`;
  // no markout (perps, or no matured fill yet): left out, not "10 s — bps"
  const mk = (r: SymbolRow) => (r.mk10_bps == null ? "" : `10 s ${bps(r.mk10_bps)} bps`);
  const fl = (r: SymbolRow) => `${int(r.fills_day)} fills`;
  const join = (...xs: string[]) => xs.filter(Boolean).join(" · ");
  // the sorted figure on the right under the PnL; the rest in the subtitle
  const parts = (r: SymbolRow): [string, string] => {
    switch (sort) {
      case "pnl":
        return [join(inv(r), mk(r)), fl(r)];
      case "inv":
        return [join(mk(r), fl(r)), inv(r)];
      case "mk10":
        return [join(inv(r), fl(r)), mk(r) || "no markout"];
      case "fills":
        return [join(inv(r), mk(r)), fl(r)];
      case "last":
        return [join(inv(r), fl(r)), ago(r.last_fill)];
    }
  };

  return (
    <>
      <Section card={false} className="m-inst-chips">
        <Chips value={sort} onChange={setSort} data={SORTS} label="Sort by" />
      </Section>
      <div className="m-inst-bar">
        <span className="m-inst-sum">
          <b>{list.length}</b> instruments · PnL <Money v={total} />
        </span>
        {nPerp > 0 && (
          <Segmented
            value={venue}
            onChange={setVenue}
            data={[
              { value: "all", label: "All" },
              { value: "spot", label: "Spot" },
              { value: "usdm", label: "Perp" },
            ]}
            label="Venue"
          />
        )}
      </div>
      <div className="m-hold" {...hold}>
      <Section className="m-inst-list">
        {list.map((r) => {
          const [sub, side] = parts(r);
          return (
            <InstrumentRow
              key={r.venue + r.symbol}
              r={r}
              pnl={pnlOf(r)}
              sub={sub}
              side={<span className={sort === "mk10" ? tone(r.mk10_bps, bps(r.mk10_bps)) : ""}>{side}</span>}
            />
          );
        })}
        {list.length === 0 && <div className="m-empty">No instruments on this venue.</div>}
      </Section>
      </div>
    </>
  );
}
