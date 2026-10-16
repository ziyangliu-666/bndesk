// The quote map for a thumb: QuoteRows (the shared canvas) with a phone's gestures. A tap opens the row's
// instrument; a long press reads the row under the finger (our best bid and ask from fair, the market's spread,
// the inventory, the orders) and a drag up or down moves the reading from row to row, the page held still
// meanwhile. The reading stays after the finger lifts, until the next tap (the charts' tracking mode).
import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { QuoteLegend, QuoteRows, quoteRows, rowsFor, type MapSort, type QRow } from "../../../components/quotes";
import { useBusiest } from "../../../selectors";
import { selectInstrument } from "../../../store";
import { useExPref } from "../../../components/ex";
import { bps, price } from "../../../format";
import { Segmented, useLive, useMoney } from "../../../components/mobile";

const AXIS_H = 18;
const PRESS_MS = 320;
const SLOP = 9;

export function QuoteTouch({
  rows,
  range,
  rowH,
  label,
  inv = false,
  axis = true,
  empty,
}: {
  rows: readonly QRow[];
  range: number;
  rowH: number;
  label: number;
  inv?: boolean;
  axis?: boolean;
  empty?: string;
}) {
  const box = useRef<HTMLDivElement>(null);
  const [read, setRead] = useState<{ i: number; x: number } | null>(null);
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
      return Math.max(0, Math.min(rows.length - 1, i));
    };
    const xIn = (clientX: number) => clientX - el.getBoundingClientRect().left;
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
        navigator.vibrate?.(8);
        setRead({ i: rowAt(start.y), x: xIn(start.x) });
      }, PRESS_MS);
    };
    const move = (e: TouchEvent) => {
      const t = e.touches[0];
      if (!t || !start) return;
      if (scrub) {
        e.preventDefault(); // the page holds still while the finger reads rows
        setRead({ i: rowAt(t.clientY), x: xIn(t.clientX) });
        return;
      }
      if (Math.abs(t.clientX - start.x) > SLOP || Math.abs(t.clientY - start.y) > SLOP) {
        moved = true;
        clearTimeout(timer);
      }
    };
    const up = (e: TouchEvent) => {
      clearTimeout(timer);
      const s = start;
      start = null;
      if (scrub) {
        e.preventDefault(); // no click after a reading
        return;
      }
      if (!s || moved) return;
      e.preventDefault(); // the tap is handled here, not by a click 300 ms on
      if (live.current.read) {
        setRead(null); // the tap that ends a reading opens nothing
        return;
      }
      const row = live.current.rows[rowAt(s.y)];
      if (row) selectInstrument({ symbol: row.sym.symbol, venue: row.sym.venue });
    };
    const cancel = () => {
      clearTimeout(timer);
      start = null;
    };
    // a mouse (desktop testing): a click opens the row
    const click = (e: MouseEvent) => {
      const row = live.current.rows[rowAt(e.clientY)];
      if (row) selectInstrument({ symbol: row.sym.symbol, venue: row.sym.venue });
    };
    el.addEventListener("touchstart", down, { passive: true });
    el.addEventListener("touchmove", move, { passive: false });
    el.addEventListener("touchend", up, { passive: false });
    el.addEventListener("touchcancel", cancel);
    el.addEventListener("click", click);
    return () => {
      clearTimeout(timer);
      el.removeEventListener("touchstart", down);
      el.removeEventListener("touchmove", move);
      el.removeEventListener("touchend", up);
      el.removeEventListener("touchcancel", cancel);
      el.removeEventListener("click", click);
    };
  }, []);

  // a reading ends when its rows go (another sort, the page's data replaced)
  const row = read ? rows[read.i] : undefined;
  const top = (axis ? AXIS_H : 0) + (read?.i ?? 0) * rowH;
  const w = box.current?.clientWidth ?? 0;
  const below = (read?.i ?? 0) < 2;
  return (
    <div ref={box} className="dk-qt" onContextMenu={(e) => e.preventDefault()}>
      <QuoteRows rows={rows} range={range} rowH={rowH} label={label} inv={inv} axis={axis} empty={empty} selected={row ? row.sym.symbol.replace(/USDT$/, "") : undefined} />
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

/** The row under the finger, in figures. */
function Reading({ row, style }: { row: QRow; style: CSSProperties }) {
  const money = useMoney();
  const s = row.sym;
  const nb = row.orders.filter((o) => o.side === "buy").length;
  const na = row.orders.length - nb;
  const d = (v: number | null) => (v == null ? "--" : bps(v, false) + " bps");
  return (
    <div className="dk-qt-read" style={style} role="status">
      <div className="dk-qt-read-h">
        <b>{s.symbol}</b>
        <span className="m-fig">{price(s.mid)}</span>
      </div>
      <dl>
        <dt>Bid below fair</dt>
        <dd className={s.bid_dist_bps == null ? "" : "up"}>{d(s.bid_dist_bps)}</dd>
        <dt>Ask above fair</dt>
        <dd className={s.ask_dist_bps == null ? "" : "down"}>{d(s.ask_dist_bps)}</dd>
        <dt>Spread</dt>
        <dd>{d(s.spread_bps)}</dd>
        <dt>Orders</dt>
        <dd>
          {nb} bid{nb === 1 ? "" : "s"} · {na} ask{na === 1 ? "" : "s"}
        </dd>
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

/** Markets → Quotes: every quoted instrument, with the range and the order as chips above the map. */
export function QuotesFull({ ms }: { ms: number }) {
  // the map's choices, shared with the desktop's Orders map (useQuoteMapState keeps them under ex.qmap.*)
  const [range, setRange] = useExPref<number>("qmap", "range", 25);
  const [sort, setSort] = useExPref<MapSort>("qmap", "sort", "activity", ["activity", "inventory", "name"]);
  const symbols = useLive((s) => s.snap?.symbols, ms);
  const orders = useLive((s) => s.snap?.orders, ms);
  const rows = useMemo(() => quoteRows(symbols ?? [], orders ?? [], sort), [symbols, orders, sort]);
  const nOrders = orders?.filter((o) => o.venue === "spot").length ?? 0;
  const through = orders?.filter((o) => o.venue === "spot" && o.dist_bps != null && o.dist_bps < 0).length ?? 0;
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
        <span className="dk-qf-l">Order</span>
        <Segmented
          label="Order"
          value={sort}
          onChange={setSort}
          data={[
            { value: "activity", label: "Busiest" },
            { value: "inventory", label: "Inventory" },
            { value: "name", label: "A–Z" },
          ]}
        />
      </div>
      <div className="dk-qf-sum m-fig">
        {rows.length} instruments · {nOrders} orders
        {through > 0 && <span className="warn"> · {through} through fair</span>}
      </div>
      <QuoteTouch rows={rows} range={range} rowH={34} label={54} inv />
    </>
  );
}
