// The Desk's instruments list, the market list's place on an exchange's trade page: search, filter tabs,
// sortable columns (no desk total: the head carries it; Esc or the ✕ by the name go back). A click picks the
// instrument.
import { useEffect, useMemo, useRef, useState } from "react";
import { selectInstrument, useStore, type Instrument } from "../../store";
import { pnl, usd } from "../../format";
import type { SymbolRow } from "../../protocol";
import { Tabs } from "../../components/ex";
import { maskNode, useHide } from "../../mask";
import { tradingPnl, useHedgePnl } from "../../selectors";
import { cur, useDesk, isPerp, isHedge, hasPerps, venueTag } from "../../desk";

type Filter = "all" | "held" | "quoted" | "perp";
type SortKey = "symbol" | "value" | "mm" | "inv";

const held = (r: SymbolRow) => !r.dust && Math.abs(r.inv_value) >= 1;
const quoted = (r: SymbolRow) => r.open_bids + r.open_asks > 0;

export function Instruments({ sel }: { sel: Instrument | null }) {
  const rows = useStore((s) => s.snap?.symbols);
  const hide = useHide();
  const hedgeOf = useHedgePnl();
  const [q, setQ] = useState("");
  const [filter, setFilter] = useState<Filter>("all");
  const d = useDesk();
  const [sort, setSort] = useState<{ k: SortKey; desc: boolean }>({ k: "value", desc: true });

  const list = useMemo(() => {
    const qq = q.trim().toUpperCase();
    const out = (rows ?? []).filter(
      (r) =>
        (!qq || r.symbol.includes(qq)) &&
        (filter === "all" || (filter === "held" && held(r)) || (filter === "quoted" && quoted(r)) || (filter === "perp" && isPerp(r.venue))),
    );
    // Hide amounts: a sort by a hidden figure would give its ranking away, so the list keeps the names' order
    const k = hide && sort.k !== "symbol" ? "symbol" : sort.k;
    const byName = (a: SymbolRow, b: SymbolRow) => a.symbol.localeCompare(b.symbol) || a.venue.localeCompare(b.venue);
    out.sort((a, b) => {
      if (k === "symbol") return (sort.k === "symbol" && sort.desc ? -1 : 1) * byName(a, b);
      if (k === "value") return (sort.desc ? -1 : 1) * (Math.abs(a.inv_value) - Math.abs(b.inv_value));
      // a part of the P&L (with no split kept, the trading P&L): what hedges (none) after what the desk trades
      const part = (r: SymbolRow) => (isHedge(r) ? null : !d.mm ? tradingPnl(r) : k === "mm" ? r.mm_pnl : r.inv_pnl);
      const x = part(a),
        y = part(b);
      if (x == null || y == null) return x == null && y == null ? byName(a, b) : x == null ? 1 : -1;
      return (sort.desc ? -1 : 1) * (x - y);
    });
    return out;
  }, [rows, q, filter, sort, hide, d.mm]);

  // a pick from elsewhere (a fill, a grid row, the footer) brings its row into view
  const body = useRef<HTMLDivElement>(null);
  const selKey = sel ? sel.venue + sel.symbol : "";
  useEffect(() => {
    body.current?.querySelector(".dk-mk-row.sel")?.scrollIntoView({ block: "nearest" });
  }, [selKey]);

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
    <section className={"dk-panel dk-mk" + (d.mm ? " split" : "")}>
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
          { value: "held", label: "Held", title: `Inventory worth 1 ${cur()} or more` },
          { value: "quoted", label: "Quoted", title: "With resting orders of ours" },
          ...(hasPerps(d) ? [{ value: "perp" as const, label: "Perp", title: "Perpetuals" }] : []),
        ]}
        value={filter}
        onChange={setFilter}
      />
      <div className="dk-mk-hd">
        {head("symbol", "Symbol", "Sort by name")}
        {head("value", "Inv value", `Inventory × mid, ${cur()}; sorted by size`)}
        {d.mm ? (
          <>
            {head("mm", "MM", `Market making today, ${cur()}: each fill against the fair 60 s later (its mid before the fill moved as the leader perp moved), minus fees. What hedges: its leg's P&L across both columns, marked hedge`)}
            {head("inv", "Inv PnL", `Inventory PnL today, ${cur()}: what the held inventory made after those 60 s`)}
          </>
        ) : (
          head("mm", "Trading", `Today, ${cur()}: what the fills and the held inventory made, fees included. What hedges: its leg's P&L, marked hedge`)
        )}
      </div>
      <div className="dk-mk-body" ref={body}>
        {list.map((r) => {
          const hedged = isHedge(r);
          const tone = (v: number | null) => "fig " + (hide || v == null ? "" : v > 0.005 ? "up" : v < -0.005 ? "down" : "");
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
                {venueTag(r.venue) && <span className="dk-tag">{venueTag(r.venue)}</span>}
              </span>
              <span className="fig">{maskNode(hide, usd(r.inv_value))}</span>
              {hedged ? (
                <span className={tone(hedgeOf(r)) + (d.mm ? " dk-mk-span" : "")}>
                  <span className="dk-mk-k">hedge </span>
                  {maskNode(hide, pnl(hedgeOf(r)))}
                </span>
              ) : d.mm ? (
                <>
                  <span className={tone(r.mm_pnl)}>{maskNode(hide, pnl(r.mm_pnl))}</span>
                  <span className={tone(r.inv_pnl)}>{maskNode(hide, pnl(r.inv_pnl))}</span>
                </>
              ) : (
                <span className={tone(r.trading_pnl)}>{maskNode(hide, pnl(r.trading_pnl))}</span>
              )}
            </button>
          );
        })}
        {rows && !list.length && <div className="dk-empty">No instruments match</div>}
      </div>
    </section>
  );
}
