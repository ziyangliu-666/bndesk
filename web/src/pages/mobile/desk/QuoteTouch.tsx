// The quote map for a thumb: QuoteRows (the shared canvas) with a phone's gestures. A tap opens the row's
// instrument; a long press reads the row under the finger (our best bid and ask from fair, signed as the axis,
// the market's spread, the orders, the inventory) and a drag up or down moves the reading from row to row, the
// page held still meanwhile. The reading stays after the finger lifts and belongs to the instrument, not to the
// row's place (the busiest list re-ranks); it ends on the next tap on the map, a touch anywhere else on the
// page, or a scroll.
import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { QuoteLegend, QuoteRows, SORTS, mapCounts, quoteRows, rowsFor, sidesOf, type MapSort, type QRow } from "../../../components/quotes";
import { useBusiest } from "../../../selectors";
import { selectInstrument, useStore } from "../../../store";
import { LONG_PRESS_MS } from "../../../gesture";
import { useExPref } from "../../../components/ex";
import { bps, int, price } from "../../../format";
import { Chips, Segmented, useLive, useMoney } from "../../../components/mobile";

const AXIS_H = 18;
const PRESS_MS = LONG_PRESS_MS;
/** The reading's height, about (the side it goes on is chosen with it). */
const READ_H = 132;
const SLOP = 9;

const keyOf = (r: QRow) => `${r.sym.venue}:${r.sym.symbol}`;

export function QuoteTouch({
  rows,
  range,
  rowH,
  label,
  inv = false,
  axis = true,
  stickyAxis = false,
  empty,
}: {
  rows: readonly QRow[];
  range: number;
  rowH: number;
  label: number;
  inv?: boolean;
  axis?: boolean;
  /** The ticks stay under the top bar (a long map). */
  stickyAxis?: boolean;
  empty?: string;
}) {
  const box = useRef<HTMLDivElement>(null);
  // the reading: the instrument under the finger and the finger's x (the box goes on the other side)
  const [read, setRead] = useState<{ key: string; x: number } | null>(null);
  const live = useRef({ rows, rowH, read, axis });
  live.current = { rows, rowH, read, axis };

  useEffect(() => {
    const el = box.current;
    if (!el) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let start: { x: number; y: number; t: number } | null = null;
    let scrub = false;
    let moved = false;
    const rowAt = (clientY: number) => {
      const { rows, rowH, axis } = live.current;
      const r = el.getBoundingClientRect();
      const i = Math.floor((clientY - r.top - (axis ? AXIS_H : 0)) / rowH);
      return rows[Math.max(0, Math.min(rows.length - 1, i))];
    };
    const xIn = (clientX: number) => clientX - el.getBoundingClientRect().left;
    const readAt = (cx: number, cy: number) => {
      const r = rowAt(cy);
      if (r) setRead({ key: keyOf(r), x: xIn(cx) });
    };
    const down = (e: TouchEvent) => {
      if (e.touches.length !== 1) return;
      const t = e.touches[0]!;
      start = { x: t.clientX, y: t.clientY, t: Date.now() };
      moved = false;
      scrub = false;
      clearTimeout(timer);
      timer = setTimeout(() => {
        if (!start || moved || !live.current.rows.length) return;
        scrub = true;
        if (navigator.userActivation?.hasBeenActive) navigator.vibrate?.(8);
        readAt(start.x, start.y);
      }, PRESS_MS);
    };
    const move = (e: TouchEvent) => {
      const t = e.touches[0];
      if (!t || !start) return;
      if (scrub) {
        e.preventDefault(); // the page holds still while the finger reads rows
        readAt(t.clientX, t.clientY);
        return;
      }
      if (Math.abs(t.clientX - start.x) > SLOP || Math.abs(t.clientY - start.y) > SLOP) {
        moved = true;
        clearTimeout(timer);
        if (live.current.read) setRead(null); // a swipe that starts on the map scrolls the page: the reading goes
      }
    };
    const up = (e: TouchEvent) => {
      clearTimeout(timer);
      const s = start;
      start = null;
      if (scrub) {
        scrub = false;
        e.preventDefault(); // no click after a reading
        return;
      }
      if (!s || moved) return;
      e.preventDefault(); // the tap is handled here, not by a click 300 ms on
      if (live.current.read) {
        setRead(null); // the tap that ends a reading opens nothing
        return;
      }
      const row = rowAt(s.y);
      if (row) selectInstrument({ symbol: row.sym.symbol, venue: row.sym.venue });
    };
    const cancel = () => {
      clearTimeout(timer);
      start = null;
    };
    // a mouse (desktop testing): a click opens the row
    const click = (e: MouseEvent) => {
      const row = rowAt(e.clientY);
      if (row) selectInstrument({ symbol: row.sym.symbol, venue: row.sym.venue });
    };
    // a finger anywhere else on the page, or the page scrolling, ends a reading
    const away = (e: TouchEvent) => {
      if (live.current.read && !el.contains(e.target as Node)) setRead(null);
    };
    const scrolled = () => {
      if (live.current.read && !scrub) setRead(null);
    };
    el.addEventListener("touchstart", down, { passive: true });
    el.addEventListener("touchmove", move, { passive: false });
    el.addEventListener("touchend", up, { passive: false });
    el.addEventListener("touchcancel", cancel);
    el.addEventListener("click", click);
    document.addEventListener("touchstart", away, { capture: true, passive: true });
    window.addEventListener("scroll", scrolled, { passive: true });
    return () => {
      clearTimeout(timer);
      el.removeEventListener("touchstart", down);
      el.removeEventListener("touchmove", move);
      el.removeEventListener("touchend", up);
      el.removeEventListener("touchcancel", cancel);
      el.removeEventListener("click", click);
      document.removeEventListener("touchstart", away, { capture: true });
      window.removeEventListener("scroll", scrolled);
    };
  }, []);

  // the reading follows its instrument to wherever the rows now put it, and ends when it leaves them
  const i = read ? rows.findIndex((r) => keyOf(r) === read.key) : -1;
  const row = i >= 0 ? rows[i] : undefined;
  const top = (axis ? AXIS_H : 0) + Math.max(0, i) * rowH;
  const w = box.current?.clientWidth ?? 0;
  // above the row when it fits under the sticky top bar, else below it (whichever side has the room, in the
  // viewport: after a scroll the row may sit just under the bar)
  const below = (() => {
    const el = box.current;
    if (!el || i < 0) return i < 2;
    const rowTop = el.getBoundingClientRect().top + top;
    const bar = document.querySelector(".m-bar")?.getBoundingClientRect().bottom ?? 0;
    const floor = document.querySelector(".m-nav")?.getBoundingClientRect().top ?? window.innerHeight;
    const roomAbove = rowTop - bar - 4;
    const roomBelow = floor - (rowTop + rowH) - 4;
    return roomAbove < READ_H && roomBelow > roomAbove;
  })();
  return (
    <div ref={box} className="dk-qt" onContextMenu={(e) => e.preventDefault()}>
      <QuoteRows rows={rows} range={range} rowH={rowH} label={label} inv={inv} axis={axis} stickyAxis={stickyAxis} empty={empty} selected={row ? row.sym.symbol.replace(/USDT$/, "") : undefined} />
      {row && (
        <>
          <div className="dk-qt-hl" style={{ top, height: rowH }} aria-hidden />
          <Reading
            row={row}
            style={{
              top: below ? top + rowH + 4 : undefined,
              bottom: below ? undefined : (box.current?.clientHeight ?? 0) - top + 4,
              ...(read!.x > w / 2 ? { left: 0 } : { right: 0 }),
            }}
          />
        </>
      )}
    </div>
  );
}

/** Our best order's distance from fair, signed as the map's axis: a bid below fair is negative. */
const signed = (v: number | null, side: "bid" | "ask") => (v == null ? "--" : bps(side === "bid" ? -v : v) + " bps");

/** The row under the finger, in figures. */
function Reading({ row, style }: { row: QRow; style: CSSProperties }) {
  const money = useMoney();
  const s = row.sym;
  const nb = row.orders.filter((o) => o.side === "buy").length;
  const na = row.orders.length - nb;
  const sides = sidesOf(row);
  return (
    <div className="dk-qt-read" style={style} role="status">
      <div className="dk-qt-read-h">
        <b>{s.symbol}</b>
        <span className="m-fig">{price(s.mid)}</span>
      </div>
      <dl>
        <dt>Our bid vs fair</dt>
        <dd className={s.bid_dist_bps == null ? "muted" : "up"}>{nb ? signed(s.bid_dist_bps, "bid") : "No bid"}</dd>
        <dt>Our ask vs fair</dt>
        <dd className={s.ask_dist_bps == null ? "muted" : "down"}>{na ? signed(s.ask_dist_bps, "ask") : "No ask"}</dd>
        <dt>Market spread</dt>
        <dd>{s.spread_bps == null ? "--" : bps(s.spread_bps, false) + " bps"}</dd>
        <dt>Orders</dt>
        <dd>{sides === "none" ? "None" : `${nb} bid${nb === 1 ? "" : "s"} · ${na} ask${na === 1 ? "" : "s"}`}</dd>
        <dt>Inventory</dt>
        <dd>{money(s.inv_value, "usd")}</dd>
      </dl>
    </div>
  );
}

/** The Desk's block: the `n` busiest instruments, live (at `ms`). */
export function QuotesMini({ n = 8, ms }: { n?: number; ms: number }) {
  const keys = useBusiest(n);
  const symbols = useLive((s) => s.snap?.symbols, ms);
  const orders = useLive((s) => s.snap?.orders, ms);
  const rows = useMemo(() => rowsFor(keys, symbols ?? [], orders ?? []), [keys, symbols, orders]);
  return <QuoteTouch rows={rows} range={25} rowH={34} label={58} empty="Nothing quoted right now" />;
}

const RANGES = [10, 25, 50, 100] as const;

/** Markets → Quotes and More → Orders → Quotes: every quoted instrument, with the range and the order above the
 *  map and its counts (one side, wide, through fair) under them. */
export function QuotesFull({ ms }: { ms: number }) {
  // the map's choices, shared with the desktop's Orders map (useQuoteMapState keeps them under ex.qmap.*)
  const [range, setRange] = useExPref<number>("qmap", "range", 25);
  const [sort, setSort] = useExPref<MapSort>("qmap", "sort", "activity", SORTS);
  const symbols = useLive((s) => s.snap?.symbols, ms);
  const orders = useLive((s) => s.snap?.orders, ms);
  const hide = useStore((s) => s.hideAmounts);
  const rows = useMemo(() => quoteRows(symbols ?? [], orders ?? [], sort, null, hide), [symbols, orders, sort, hide]);
  const n = useMemo(() => mapCounts(rows), [rows]);
  return (
    <>
      <QuoteLegend short />
      <div className="dk-qf-ctl">
        <span className="dk-qf-l">Range</span>
        <Segmented
          label="Range in bps"
          value={String(range)}
          onChange={(v) => setRange(Number(v))}
          data={RANGES.map((r) => ({ value: String(r), label: `±${r}` }))}
        />
      </div>
      <div className="dk-qf-ctl">
        <span className="dk-qf-l">Sort</span>
        <Chips
          label="Sort"
          value={sort}
          onChange={setSort}
          data={[
            { value: "activity", label: "Busiest" },
            { value: "wide", label: "Widest" },
            { value: "oneside", label: "One side" },
            { value: "inventory", label: "Inventory" },
            { value: "name", label: "A–Z" },
          ]}
        />
      </div>
      <div className="dk-qf-sum m-fig">
        {int(n.rows)} instruments · {int(n.orders)} orders
        {n.oneSide > 0 && <> · {int(n.oneSide)} one side</>}
        {n.wide > 0 && <> · {int(n.wide)} wide</>}
        {n.through > 0 && <span className="warn"> · {int(n.through)} through fair</span>}
      </div>
      <QuoteTouch rows={rows} range={range} rowH={34} label={54} inv stickyAxis />
    </>
  );
}
