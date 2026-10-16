import { memo, useMemo, useState } from "react";
import { UnstyledButton } from "@mantine/core";
import { IconSearch, IconX } from "@tabler/icons-react";
import { selectInstrument, useMarketsView } from "../../store";
import { int, price } from "../../format";
import { Money, Segmented, tone, useHold, useLive, useMoney } from "../../components/mobile";
import { Tabs, useTicker24h, useTickers24h, tickerKey, type Ticker24h } from "../../components/ex";
import type { SymbolRow, Venue } from "../../protocol";
import { instPnl } from "./shared";
import { QuotesFull } from "./desk/QuoteTouch";
import "./desk.css";
import "./desk/dk.css";
import "./desk/mk.css";

type Filter = "all" | "held" | "quoted" | "perp";
type Key = "fills" | "name" | "chg" | "pnl" | "inv";
type Sort = { key: Key; desc: boolean };

const held = (r: SymbolRow) => !r.dust && Math.abs(r.inv_value) >= 5;
const quoted = (r: SymbolRow) => r.open_bids + r.open_asks > 0;
const FILTERS: Record<Filter, (r: SymbolRow) => boolean> = {
  all: () => true,
  held,
  quoted,
  perp: (r) => r.venue === "usdm",
};
const NO_ROWS: { symbol: string; venue: Venue }[] = [];

/** "−1.25%" / "+0.40%" / "--". */
const pctText = (v: number | null | undefined) => (v == null || !Number.isFinite(v) ? "--" : (v > 0 ? "+" : v < 0 ? "−" : "") + Math.abs(v).toFixed(2) + "%");

/** Markets: every tracked instrument (List), or the live quote map of the quoted ones (Quotes). */
export function InstrumentsM() {
  const [view, setView] = useMarketsView();
  return (
    <>
      <div className="mk-view">
        <Tabs
          items={[
            { value: "list", label: "List" },
            { value: "quotes", label: "Quotes" },
          ]}
          value={view}
          onChange={setView}
        />
      </div>
      {view === "list" ? <MarketList /> : <section className="mk-quotes"><QuotesFull ms={250} /></section>}
    </>
  );
}

function MarketList() {
  // the order holds still under a resting finger
  const [hold_, hold] = useHold();
  const rows = useLive((s) => s.snap?.symbols, 250, hold_);
  const legs = useLive((s) => s.snap?.exposure.hedge_day?.legs, 1000, hold_);
  const [q, setQ] = useState("");
  const [filter, setFilter] = useState<Filter>("all");
  const [sort, setSort] = useState<Sort>({ key: "pnl", desc: true });
  // a perp's PnL is its hedge leg's today
  const pnlOf = useMemo(() => {
    const leg = new Map((legs ?? []).map((l) => [l.symbol, l.pnl]));
    return (r: SymbolRow) => (r.venue === "usdm" ? (leg.get(r.symbol) ?? r.upnl ?? 0) : instPnl(r));
  }, [legs]);
  const all = rows ?? [];
  const counts = useMemo(() => {
    const c: Record<Filter, number> = { all: 0, held: 0, quoted: 0, perp: 0 };
    for (const r of all) for (const f of Object.keys(FILTERS) as Filter[]) if (FILTERS[f](r)) c[f]++;
    return c;
  }, [all]);
  const needle = q.trim().toUpperCase();
  const shown = useMemo(
    () => all.filter((r) => FILTERS[filter](r) && (!needle || r.symbol.includes(needle))),
    [all, filter, needle],
  );
  // the 24 h change is read for the whole list only while it orders the list (each row reads its own)
  const tick = useTickers24h(sort.key === "chg" ? shown : NO_ROWS);
  const list = useMemo(() => {
    const val = (r: SymbolRow): number | string | null => {
      switch (sort.key) {
        case "name":
          return r.symbol;
        case "fills":
          return r.fills_day;
        case "chg":
          return tick.get(tickerKey(r.symbol, r.venue))?.changePct ?? null;
        case "pnl":
          return pnlOf(r);
        case "inv":
          return Math.abs(r.inv_value);
      }
    };
    const dir = sort.desc ? -1 : 1;
    return shown.slice().sort((a, b) => {
      const x = val(a);
      const y = val(b);
      if (x == null || y == null) return x == null ? (y == null ? 0 : 1) : -1; // unknown last, either way
      if (typeof x === "string") return dir * x.localeCompare(y as string);
      return dir * (x - (y as number));
    });
  }, [shown, sort, tick, pnlOf]);

  // each header cell steps through its figures: Name / Fills, Mid / 24h (both ways), Day PnL (both ways) / Inv
  const tapLeft = () => setSort(sort.key === "fills" ? { key: "name", desc: false } : { key: "fills", desc: true });
  const tapMid = () => setSort(sort.key === "chg" ? { key: "chg", desc: !sort.desc } : { key: "chg", desc: true });
  const tapRight = () =>
    setSort(
      sort.key === "pnl" ? (sort.desc ? { key: "pnl", desc: false } : { key: "inv", desc: true }) : { key: "pnl", desc: true },
    );
  const arrow = sort.desc ? "↓" : "↑";
  const word = (k: Key, text: string) => (
    <span className={sort.key === k ? "on" : ""}>
      {text}
      {sort.key === k && <i>{arrow}</i>}
    </span>
  );

  return (
    <>
      <label className="mk-search">
        <IconSearch size={16} stroke={1.75} aria-hidden />
        <input
          type="search"
          inputMode="search"
          autoCapitalize="characters"
          autoComplete="off"
          spellCheck={false}
          placeholder="Search"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          aria-label="Search instruments"
        />
        {q && (
          <UnstyledButton className="mk-clear" onClick={() => setQ("")} aria-label="Clear the search">
            <IconX size={16} stroke={1.75} />
          </UnstyledButton>
        )}
      </label>
      <div className="mk-sticky">
        <div className="mk-filters">
          <Segmented
            label="Show"
            value={filter}
            onChange={setFilter}
            data={[
              { value: "all", label: "All", count: counts.all },
              { value: "held", label: "Held", count: counts.held },
              { value: "quoted", label: "Quoted", count: counts.quoted },
              { value: "perp", label: "Perp", count: counts.perp },
            ]}
          />
        </div>
        <div className="mk-head" role="group" aria-label="Sort">
          <UnstyledButton className="mk-h-l" onClick={tapLeft}>
            {word("name", "Name")} / {word("fills", "Fills")}
          </UnstyledButton>
          <UnstyledButton className="mk-h-m" onClick={tapMid}>
            Mid / {word("chg", "24h")}
          </UnstyledButton>
          <UnstyledButton className="mk-h-r" onClick={tapRight}>
            {word("pnl", "Day PnL")} / {word("inv", "Inv")}
          </UnstyledButton>
        </div>
      </div>
      <div className="mk-list">
      <div className="m-hold" {...hold}>
        {list.map((r) => (
          <MarketRow key={r.venue + r.symbol} r={r} pnl={pnlOf(r)} />
        ))}
        {list.length === 0 && (
          <div className="m-empty">{needle ? `No instrument matches “${q.trim()}”.` : "No instruments here."}</div>
        )}
      </div>
      </div>
    </>
  );
}

/** One instrument, 56 px: name and venue · mid and its 24 h change · day PnL and the inventory. */
const MarketRow = memo(function MarketRow({ r, pnl }: { r: SymbolRow; pnl: number }) {
  const money = useMoney();
  const t: Ticker24h | null = useTicker24h(r.symbol, r.venue);
  const perp = r.venue === "usdm";
  const chg = t?.changePct ?? null;
  const inv = Math.abs(r.inv_value) < 0.005 ? "flat" : (perp ? "pos " : "inv ") + money(r.inv_value, perp ? "pnlShort" : "short");
  return (
    <UnstyledButton className="mk-row" onClick={() => selectInstrument({ symbol: r.symbol, venue: r.venue })}>
      <span className="mk-c-l">
        <span className="mk-sym">
          {r.symbol.replace(/USDT$/, "")}
          <span className="mk-quote">/USDT</span>
        </span>
        <span className="mk-sub">
          {perp ? "Perp" : "Spot"} · {int(r.fills_day)} fills
        </span>
      </span>
      <span className="mk-c-m">
        <span className="mk-px m-fig">{r.mid == null ? "--" : price(r.mid)}</span>
        <span className={"mk-sub m-fig " + tone(chg, pctText(chg))}>{pctText(chg)}</span>
      </span>
      <span className="mk-c-r">
        <span className="mk-pnl">
          <Money v={pnl} />
        </span>
        <span className="mk-sub m-fig">{inv}</span>
      </span>
    </UnstyledButton>
  );
});
