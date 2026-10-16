// The Desk's instruments list, the market list's place on an exchange's trade page: search, filter tabs,
// sortable columns, the Desk pinned on top to go back. A click picks the instrument.
import { useEffect, useMemo, useRef, useState } from "react";
import { selectInstrument, useStore, type Instrument } from "../../store";
import { pnl, usd } from "../../format";
import type { SymbolRow } from "../../protocol";
import { Tabs } from "../../components/ex";
import { maskNode, useHide } from "../../mask";
import { tradingPnl, useHedgePnl } from "../../selectors";

type Filter = "all" | "held" | "quoted" | "perp";
type SortKey = "symbol" | "value" | "pnl";

const held = (r: SymbolRow) => !r.dust && Math.abs(r.inv_value) >= 1;
const quoted = (r: SymbolRow) => r.open_bids + r.open_asks > 0;

export function Instruments({ sel }: { sel: Instrument | null }) {
  const rows = useStore((s) => s.snap?.symbols);
  const hide = useHide();
  const hedgeOf = useHedgePnl();
  const [q, setQ] = useState("");
  const [filter, setFilter] = useState<Filter>("all");
  const [sort, setSort] = useState<{ k: SortKey; desc: boolean }>({ k: "value", desc: true });

  const list = useMemo(() => {
    const qq = q.trim().toUpperCase();
    const out = (rows ?? []).filter(
      (r) =>
        (!qq || r.symbol.includes(qq)) &&
        (filter === "all" || (filter === "held" && held(r)) || (filter === "quoted" && quoted(r)) || (filter === "perp" && r.venue === "usdm")),
    );
    // Hide amounts: a sort by a hidden figure would give its ranking away, so the list keeps the names' order
    const k = hide && sort.k !== "symbol" ? "symbol" : sort.k;
    const byName = (a: SymbolRow, b: SymbolRow) => a.symbol.localeCompare(b.symbol) || a.venue.localeCompare(b.venue);
    out.sort((a, b) => {
      if (k === "symbol") return (sort.k === "symbol" && sort.desc ? -1 : 1) * byName(a, b);
      if (k === "value") return (sort.desc ? -1 : 1) * (Math.abs(a.inv_value) - Math.abs(b.inv_value));
      // Trading PnL: the perps (the hedge, no Trading PnL) after the spot markets
      const x = tradingPnl(a),
        y = tradingPnl(b);
      if (x == null || y == null) return x == null && y == null ? byName(a, b) : x == null ? 1 : -1;
      return (sort.desc ? -1 : 1) * (x - y);
    });
    return out;
  }, [rows, q, filter, sort, hide]);
  // the desk's row: the spot inventory's value and the Trading PnL, as the Inventory tab's total
  const desk = useMemo(() => {
    let v = 0;
    let t = 0;
    for (const r of rows ?? []) if (r.venue === "spot") (v += r.inv_value), (t += r.trading_pnl);
    return { v, t };
  }, [rows]);

  // a pick from elsewhere (a fill, a grid row, the footer) brings its row into view
  const body = useRef<HTMLDivElement>(null);
  const selKey = sel ? sel.venue + sel.symbol : "";
  useEffect(() => {
    body.current?.querySelector(".dk-mk-row.sel")?.scrollIntoView({ block: "nearest" });
  }, [selKey]);

  const counts = useMemo(() => {
    const r = rows ?? [];
    return { held: r.filter(held).length, quoted: r.filter(quoted).length, perp: r.filter((x) => x.venue === "usdm").length };
  }, [rows]);

  const sortedBy = hide && sort.k !== "symbol" ? "symbol" : sort.k;
  const head = (k: SortKey, label: string, title: string) => (
    <button
      type="button"
      className={"dk-sort" + (sortedBy === k ? " on" : "")}
      title={hide && k !== "symbol" ? title + ". Sorted by name while amounts are hidden" : title}
      onClick={() => setSort((s) => (s.k === k ? { k, desc: !s.desc } : { k, desc: k !== "symbol" }))}
    >
      {label}
      <span className="dk-sort-ic" aria-hidden>
        {sortedBy === k ? (sort.k === k && sort.desc ? "↓" : "↑") : "↕"}
      </span>
    </button>
  );

  return (
    <section className="dk-panel dk-mk">
      <div className="dk-mk-search">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden>
          <circle cx="11" cy="11" r="7" />
          <path d="m20 20-3.5-3.5" />
        </svg>
        <input value={q} onChange={(e) => setQ(e.currentTarget.value)} placeholder="Search" aria-label="Search instruments" spellCheck={false} />
        {q && (
          <button type="button" className="dk-x" onClick={() => setQ("")} aria-label="Clear">
            ✕
          </button>
        )}
      </div>
      <Tabs
        size="sm"
        className="dk-mk-tabs"
        items={[
          { value: "all", label: "All" },
          { value: "held", label: "Held", count: counts.held, title: "Inventory worth 1 USDT or more" },
          { value: "quoted", label: "Quoted", count: counts.quoted, title: "With resting orders of ours" },
          { value: "perp", label: "Perp", count: counts.perp, title: "USD-M perpetuals" },
        ]}
        value={filter}
        onChange={setFilter}
      />
      <div className="dk-mk-hd">
        {head("symbol", "Symbol", "Sort by name")}
        {head("value", "Inv value", "Inventory × mid, USDT; sorted by size")}
        {head("pnl", "Trading PnL", "Today, USDT: market making + inventory PnL. A perp is the hedge: its leg's P&L, marked hedge")}
      </div>
      <div className="dk-mk-body" ref={body}>
        <button type="button" className={"dk-mk-row pin" + (sel ? "" : " sel")} onClick={() => selectInstrument(null)} title="The desk as a whole (Esc)">
          <span className="dk-mk-sym">Desk</span>
          <span className="fig">{maskNode(hide, usd(desk.v))}</span>
          <span className={"fig " + (hide ? "" : desk.t > 0.005 ? "up" : desk.t < -0.005 ? "down" : "")}>{maskNode(hide, pnl(desk.t))}</span>
        </button>
        {list.map((r) => {
          const perp = r.venue === "usdm";
          const tp = perp ? hedgeOf(r) : r.trading_pnl;
          const on = sel?.symbol === r.symbol && sel.venue === r.venue;
          return (
            <button
              type="button"
              key={r.venue + r.symbol}
              className={"dk-mk-row" + (on ? " sel" : "") + (r.dust ? " dust" : "")}
              onClick={() => selectInstrument({ symbol: r.symbol, venue: r.venue })}
            >
              <span className="dk-mk-sym">
                {r.symbol}
                {r.venue === "usdm" && <span className="dk-tag">Perp</span>}
              </span>
              <span className="fig">{maskNode(hide, usd(r.inv_value))}</span>
              <span className={"fig " + (hide || tp == null ? "" : tp > 0.005 ? "up" : tp < -0.005 ? "down" : "")}>
                {perp && <span className="dk-mk-k">hedge </span>}
                {maskNode(hide, pnl(tp))}
              </span>
            </button>
          );
        })}
        {rows && !list.length && <div className="dk-empty">No instruments match</div>}
      </div>
    </section>
  );
}
