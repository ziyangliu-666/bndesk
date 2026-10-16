// The quote map in three sizes (README in phaseA notes):
//   QuoteMapFull: desktop Orders (ECharts map, lazy) and phone Markets → Quotes (light canvas), with its legend on
//                 top and labelled controls (Account, Sort, Range).
//   QuoteMapMini: the phone Desk's live block, the N busiest instruments at 28 px a row; a tap picks one.
//   QuoteBand:    one instrument's row (phone instrument page), our bids and asks around fair and the market band.
// Only QuoteMapFull on the desktop loads ECharts; the rest is plain canvas.
import { Suspense, useMemo } from "react";
import type { Venue } from "../../protocol";
import { useStore } from "../../store";
import { lazyPage } from "../../lazyPage";
import { useBusiest } from "../../selectors";
import { TextToggle } from "../ex/controls";
import { useExPref } from "../ex/prefs";
import { QuoteRows } from "./QuoteRows";
import { RANGES, SORTS, mapCounts, quoteRows, rowsFor, type MapSort, type QRow } from "./model";
import "./quotes.css";

export { QuoteRows, type QuoteRowsProps } from "./QuoteRows";
export { quoteRows, rowsFor, short, mapCounts, sidesOf, widthOf, RANGES, LADDER, SORTS, type QRow, type MapSort } from "./model";

/** The desktop map (ECharts), its own chunk: `QuoteMapEC.preload()` fetches it ahead. */
export const QuoteMapEC = lazyPage<Parameters<typeof import("../QuoteMap").QuoteMap>[0]>(() =>
  import("../QuoteMap").then((m) => ({ default: m.QuoteMap })),
);

type OnSelect = (symbol: string, venue: Venue) => void;

/** The map's legend on top of the map: Market Bid–Ask ▬ · Our Bid ● · Our Ask ● · Size = order size ·● ·
 *  Through fair ◎ · Beyond range ▸. `short` (the phone) leaves out Beyond range and wraps to two lines. */
export function QuoteLegend({ short = false, className }: { short?: boolean; className?: string }) {
  return (
    <div className={"q-legend" + (short ? " short" : "") + (className ? " " + className : "")}>
      <span>
        <i className="q-lg-band" /> Market Bid–Ask
      </span>
      <span>
        <i className="q-lg-dot up" /> Our Bid
      </span>
      <span>
        <i className="q-lg-dot down" /> Our Ask
      </span>
      <span title="A dot's area is the order's size (notional)">
        <i className="q-lg-dot sm" />
        <i className="q-lg-dot lg" /> Size = order size
      </span>
      <span title="An order priced through fair: a bid above it or an ask below it">
        <i className="q-lg-dot ring" /> Through fair
      </span>
      {!short && (
        <span>
          <i className="q-lg-tri" /> Beyond range
        </span>
      )}
    </div>
  );
}

export interface QuoteMapState {
  account: string | null;
  setAccount: (a: string | null) => void;
  sort: MapSort;
  setSort: (s: MapSort) => void;
  range: number;
  setRange: (r: number) => void;
}

/** The map's choices (account, sort, range), remembered on this browser under `ex.qmap.*`. */
export function useQuoteMapState(): QuoteMapState {
  const [account, setAccount] = useExPref<string | null>("qmap", "account", null);
  const [sort, setSort] = useExPref<MapSort>("qmap", "sort", "activity", SORTS);
  const [range, setRange] = useExPref<number>("qmap", "range", 25);
  return { account, setAccount, sort, setSort, range, setRange };
}

/** The map's counts for an account (null: all): rows, orders, rows quoted on one side, wide rows, through fair. */
export function useMapCounts(account: string | null = null) {
  const symbols = useStore((s) => s.snap?.symbols);
  const orders = useStore((s) => s.snap?.orders);
  return useMemo(() => mapCounts(quoteRows(symbols ?? [], orders ?? [], "name", account)), [symbols, orders, account]);
}

/** Labelled control groups: `Account All sub-a sub-b · Sort Busiest Inventory A–Z · Range ±10 ±25 ±50 ±100`.
 *  `accounts` defaults to the trading accounts with orders or inventory. */
export function QuoteControls({ st, accounts, compact = false }: { st: QuoteMapState; accounts?: string[]; compact?: boolean }) {
  const all = useStore((s) => s.snap?.accounts);
  const ids = useMemo(
    () => accounts ?? (all ?? []).filter((a) => a.role !== "master" && (a.open_orders > 0 || a.inventory_value > 1)).map((a) => a.id),
    [accounts, all],
  );
  return (
    <div className={"q-ctrls" + (compact ? " compact" : "")}>
      {ids.length > 1 && !compact && (
        <div className="q-grp">
          <span className="q-grp-l">Account</span>
          <TextToggle
            label="Account"
            value={st.account ?? "all"}
            onChange={(v) => st.setAccount(v === "all" ? null : v)}
            options={[{ value: "all", label: "All" }, ...ids.map((id) => ({ value: id, label: id }))]}
          />
        </div>
      )}
      <div className="q-grp">
        <span className="q-grp-l">Sort</span>
        <TextToggle
          label="Sort"
          value={st.sort}
          onChange={st.setSort}
          options={[
            { value: "activity", label: "Busiest", title: "Most fills today first" },
            { value: "wide", label: "Widest", title: "Our widest bid–ask first" },
            { value: "oneside", label: "One side", title: "Instruments quoted on one side only first" },
            { value: "inventory", label: "Inventory" },
            { value: "name", label: "A–Z" },
          ]}
        />
      </div>
      <div className="q-grp">
        <span className="q-grp-l">Range</span>
        <TextToggle
          label="Range in bps"
          value={String(RANGES.includes(st.range as (typeof RANGES)[number]) ? st.range : "")}
          onChange={(v) => st.setRange(Number(v))}
          options={RANGES.map((r) => ({ value: String(r), label: `±${r}`, title: `±${r} bps around fair` }))}
        />
      </div>
    </div>
  );
}

/**
 * The full quote map: legend on top, labelled controls, then the map. Desktop (default): the ECharts map that
 * fills its parent (give the parent a height; rows scroll inside, hover shows an instrument's orders, ctrl +
 * wheel changes the range). `phone`: every row at 28 px on a canvas (the page scrolls), range as text toggles.
 * `onSelect` gets a row's instrument; `selected` is drawn in the accent colour. `st` lets a page hold the state
 * (to filter an orders table by the same account); by default it is the remembered one.
 */
export function QuoteMapFull({
  phone = false,
  onSelect,
  selected,
  st: given,
  controls = true,
}: {
  phone?: boolean;
  onSelect?: OnSelect;
  selected?: string | null;
  st?: QuoteMapState;
  /** Draw QuoteControls in the header (off: the page places them itself). */
  controls?: boolean;
}) {
  const own = useQuoteMapState();
  const st = given ?? own;
  return (
    <div className={"q-full" + (phone ? " phone" : "")}>
      <div className="q-head">
        <QuoteLegend short={phone} />
        {controls && <QuoteControls st={st} compact={phone} />}
      </div>
      {phone ? (
        <PhoneMap st={st} onSelect={onSelect} selected={selected} />
      ) : (
        <div className="q-ec">
          <Suspense fallback={null}>
            <QuoteMapEC
              range={st.range}
              onRange={st.setRange}
              sort={st.sort}
              account={st.account}
              selected={selected ?? null}
              onSelect={onSelect ?? (() => {})}
            />
          </Suspense>
        </div>
      )}
    </div>
  );
}

function PhoneMap({ st, onSelect, selected }: { st: QuoteMapState; onSelect?: OnSelect; selected?: string | null }) {
  const symbols = useStore((s) => s.snap?.symbols);
  const orders = useStore((s) => s.snap?.orders);
  const rows = useMemo(() => quoteRows(symbols ?? [], orders ?? [], st.sort, st.account), [symbols, orders, st.sort, st.account]);
  return (
    <QuoteRows
      rows={rows}
      range={st.range}
      rowH={28}
      label={52}
      inv
      selected={selected ? selected.replace(/USDT$/, "") : undefined}
      onRow={onSelect ? (r) => onSelect(r.sym.symbol, r.sym.venue) : undefined}
    />
  );
}

/**
 * The mini map: the `n` busiest quoted instruments (fills in the last 15 min, ranked again every 30 s so rows
 * hold still), 28 px a row, bps ticks on top, live. A tap calls `onSelect` (open the instrument).
 */
export function QuoteMapMini({ n = 8, range = 25, onSelect, rowH = 28 }: { n?: number; range?: number; onSelect?: OnSelect; rowH?: number }) {
  const keys = useBusiest(n);
  const symbols = useStore((s) => s.snap?.symbols);
  const orders = useStore((s) => s.snap?.orders);
  const rows: QRow[] = useMemo(() => rowsFor(keys, symbols ?? [], orders ?? []), [keys, symbols, orders]);
  return <QuoteRows rows={rows} range={range} rowH={rowH} label={60} onRow={onSelect ? (r) => onSelect(r.sym.symbol, r.sym.venue) : undefined} />;
}

/**
 * One instrument's live band (phone instrument page): our bids and asks around fair, the market's bid–ask, bps
 * ticks above. No symbol column (the page's header names it).
 */
export function QuoteBand({ symbol, venue, range = 25, rowH = 36 }: { symbol: string; venue: Venue; range?: number; rowH?: number }) {
  const sym = useStore((s) => s.snap?.symbols.find((r) => r.symbol === symbol && r.venue === venue));
  const orders = useStore((s) => s.snap?.orders);
  const rows: QRow[] = useMemo(
    () => (sym ? [{ sym, orders: (orders ?? []).filter((o) => o.symbol === symbol && o.venue === venue) }] : []),
    [sym, orders, symbol, venue],
  );
  return <QuoteRows rows={rows} range={range} rowH={rowH} label={0} empty="No quotes" />;
}
