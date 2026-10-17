import { memo, useMemo, useState } from "react";
import { UnstyledButton } from "@mantine/core";
import { IconSearch, IconX } from "@tabler/icons-react";
import { selectInstrument, useMarketsView } from "../../store";
import { int, price } from "../../format";
import { Money, Segmented, useHold, useLive, useMoney } from "../../components/mobile";
import { Tabs, useTicker24h, useTickers24h, tickerKey, type Ticker24h } from "../../components/ex";
import type { SymbolRow, Venue } from "../../protocol";
import { hedgePnl, legPnl, tradingPnl } from "../../selectors";
import { useHide } from "../../mask";
import { QuotesFull } from "./desk/QuoteTouch";
import "./desk.css";
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
      {view === "list" ? <MarketList /> : <section className="mk-quotes"><QuotesFull ms={125} /></section>}
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
  // a spot market's Trading PnL; a perp is the hedge: its leg's P&L today, shown as such (and sorted after)
  const hedgeOf = useMemo(() => {
    const leg = legPnl(legs);
    return (r: SymbolRow) => hedgePnl(r, leg);
  }, [legs]);
  // with Hide amounts on, a list ordered by a hidden figure would give its ranking away: by name instead
  const hide = useHide();
  const sortHidden = hide && (sort.key === "pnl" || sort.key === "inv");
  const eff: Sort = sortHidden ? { key: "name", desc: false } : sort;
  const all = rows ?? [];
  const needle = q.trim().toUpperCase();
  const shown = useMemo(
    () => all.filter((r) => FILTERS[filter](r) && (!needle || r.symbol.includes(needle))),
    [all, filter, needle],
  );
  // the 24 h change is read for the whole list only while it orders the list (each row reads its own)
  const tick = useTickers24h(eff.key === "chg" ? shown : NO_ROWS);
  const list = useMemo(() => {
    const val = (r: SymbolRow): number | string | null => {
      switch (eff.key) {
        case "name":
          return r.symbol;
        case "fills":
          return r.fills_day;
        case "chg":
          return tick.get(tickerKey(r.symbol, r.venue))?.changePct ?? null;
        case "pnl":
          return tradingPnl(r);
        case "inv":
          return Math.abs(r.inv_value);
      }
    };
    const dir = eff.desc ? -1 : 1;
    return shown.slice().sort((a, b) => {
      const x = val(a);
      const y = val(b);
      if (x == null || y == null) return x == null ? (y == null ? 0 : 1) : -1; // unknown last, either way
      if (typeof x === "string") return dir * x.localeCompare(y as string);
      return dir * (x - (y as number));
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shown, eff.key, eff.desc, tick]);

  // each header cell steps through its figures: Name / Fills, Mid / 24h (both ways), Day PnL (both ways) / Inv
  const tapLeft = () => setSort(sort.key === "fills" ? { key: "name", desc: false } : { key: "fills", desc: true });
  const tapMid = () => setSort(sort.key === "chg" ? { key: "chg", desc: !sort.desc } : { key: "chg", desc: true });
  const tapRight = () =>
    setSort(
      sort.key === "pnl" ? (sort.desc ? { key: "pnl", desc: false } : { key: "inv", desc: true }) : { key: "pnl", desc: true },
    );
  const arrow = eff.desc ? "↓" : "↑";
  const word = (k: Key, text: string) => (
    <span className={eff.key === k ? "on" : ""}>
      {text}
      {eff.key === k && <i>{arrow}</i>}
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
              { value: "all", label: "All" },
              { value: "held", label: "Held" },
              { value: "quoted", label: "Quoted" },
              { value: "perp", label: "Perp" },
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
            {word("pnl", "Trading PnL")} / {word("inv", "Inv")}
          </UnstyledButton>
        </div>
      </div>
      <div className="mk-list">
      <div className="m-hold" {...hold}>
        {list.map((r) => (
          <MarketRow key={r.venue + r.symbol} r={r} hedge={hedgeOf(r)} />
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
const MarketRow = memo(function MarketRow({ r, hedge }: { r: SymbolRow; hedge: number | null }) {
  const money = useMoney();
  const hide = useHide();
  const t: Ticker24h | null = useTicker24h(r.symbol, r.venue);
  const perp = r.venue === "usdm";
  const chg = t?.changePct ?? null;
  // with amounts hidden every row reads the same ("flat" would tell which are held)
  const inv = !hide && Math.abs(r.inv_value) < 0.005 ? "flat" : (perp ? "pos " : "inv ") + money(r.inv_value, perp ? "pnlShort" : "short") + (hide ? "" : " USDT");
  return (
    <UnstyledButton className="mk-row" onClick={() => selectInstrument({ symbol: r.symbol, venue: r.venue })}>
      <span className="mk-c-l">
        <span className="mk-sym">
          {r.symbol.replace(/USDT$/, "")}
          <span className="mk-quote">/USDT</span>
        </span>
        <span className="mk-sub">
          {perp ? "Perp · " : ""}
          {int(r.fills_day)} fills
        </span>
      </span>
      <span className="mk-c-m">
        <span className="mk-px m-fig">{r.mid == null ? "--" : price(r.mid)}</span>
        {/* the market's 24 h move: a fact about the market, in ink (colour is for what we made) */}
        <span className="mk-sub m-fig">{pctText(chg)}</span>
      </span>
      <span className="mk-c-r">
        <span className="mk-pnl">
          {perp && <span className="mk-k">hedge </span>}
          <Money v={perp ? hedge : r.trading_pnl} />
        </span>
        <span className="mk-sub m-fig">{inv}</span>
      </span>
    </UnstyledButton>
  );
});
