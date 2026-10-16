// The Desk's instruments list, the market list's place on an exchange's trade page: search, filter tabs,
// sortable columns, the Desk pinned on top to go back. A click picks the instrument.
import { useEffect, useMemo, useRef, useState } from "react";
import { selectInstrument, useStore, type Instrument } from "../../store";
import { pnl, usd } from "../../format";
import type { SymbolRow } from "../../protocol";
import { Tabs } from "../../components/ex";
import { MASK, dd, useHide } from "./mask";

type Filter = "all" | "held" | "quoted" | "perp";
type SortKey = "symbol" | "value" | "pnl";

const held = (r: SymbolRow) => !r.dust && Math.abs(r.inv_value) >= 1;
const quoted = (r: SymbolRow) => r.open_bids + r.open_asks > 0;

export function Instruments({ sel }: { sel: Instrument | null }) {
  const rows = useStore((s) => s.snap?.symbols);
  const hide = useHide();
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
    const v = (r: SymbolRow) => (sort.k === "value" ? Math.abs(r.inv_value) : r.trading_pnl);
    out.sort((a, b) => {
      const d = sort.k === "symbol" ? a.symbol.localeCompare(b.symbol) || a.venue.localeCompare(b.venue) : v(a) - v(b);
      return sort.desc ? -d : d;
    });
    return out;
  }, [rows, q, filter, sort]);

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

  const head = (k: SortKey, label: string, title: string) => (
    <button
      type="button"
      className={"dk-sort" + (sort.k === k ? " on" : "")}
      title={title}
      onClick={() => setSort((s) => (s.k === k ? { k, desc: !s.desc } : { k, desc: k !== "symbol" }))}
    >
      {label}
      <span className="dk-sort-ic" aria-hidden>
        {sort.k === k ? (sort.desc ? "↓" : "↑") : "↕"}
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
        {head("pnl", "Day PnL", "Trading PnL today (Π), USDT")}
      </div>
      <div className="dk-mk-body" ref={body}>
        <button type="button" className={"dk-mk-row pin" + (sel ? "" : " sel")} onClick={() => selectInstrument(null)} title="The desk as a whole (Esc)">
          <span className="dk-mk-sym">Desk</span>
          <span className="muted">All instruments</span>
          <span />
        </button>
        {list.map((r) => {
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
              <span className="fig">{hide ? MASK : dd(usd(r.inv_value))}</span>
              <span className={"fig " + (hide ? "" : r.trading_pnl > 0.005 ? "up" : r.trading_pnl < -0.005 ? "down" : "")}>{hide ? MASK : dd(pnl(r.trading_pnl))}</span>
            </button>
          );
        })}
        {rows && !list.length && <div className="dk-empty">No instruments match</div>}
      </div>
    </section>
  );
}
