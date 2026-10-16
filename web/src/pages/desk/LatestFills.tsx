// The latest fills, the market trades' place on an exchange's trade page: price in the side's colour, size,
// edge, time; new rows flash once. Desk-wide with the symbol, or the picked instrument's.
import { memo, useEffect, useMemo, useRef, useState } from "react";
import { getJSON, type HistFill } from "../../api";
import { selectInstrument, serverNow, useStore, type Instrument } from "../../store";
import { bps, compact, hms, int, price, qty } from "../../format";
import type { Fill } from "../../protocol";
import { maskNode, qtyText, useHide } from "../../mask";

const N = 80;

/** What a row shows: a fill from the live tape, or an earlier one from /api/fills (no edge kept there). */
type ShownFill = Pick<Fill, "id" | "ts" | "account" | "symbol" | "venue" | "side" | "price" | "qty" | "notional" | "maker" | "edge_bps">;

export function LatestFills({ inst }: { inst: Instrument | null }) {
  const fills = useStore((s) => s.snap?.fills);
  const fillsDay = useStore((s) => (inst ? s.snap?.symbols.find((r) => r.symbol === inst.symbol && r.venue === inst.venue)?.fills_day : s.snap?.summary.fills_day));
  const tz = useStore((s) => s.tz);
  const hide = useHide();
  const dayStart = useStore((s) => s.snap?.summary.day_start ?? 0);
  const tape = useMemo(() => {
    const all = fills ?? [];
    if (!inst) return all.slice(0, N);
    const out: Fill[] = [];
    for (const f of all) {
      if (f.symbol === inst.symbol && f.venue === inst.venue) out.push(f);
      if (out.length >= N) break;
    }
    return out;
  }, [fills, inst]);

  // the live tape holds the desk's newest fills only: a quiet instrument's earlier ones today come from
  // /api/fills (once per pick; new ones arrive on the tape)
  const short = !!inst && fills != null && tape.length < N && (fillsDay ?? 0) > tape.length;
  const [older, setOlder] = useState<{ key: string; rows: ShownFill[] } | null>(null);
  const instKey = inst ? inst.venue + ":" + inst.symbol : "";
  useEffect(() => {
    if (!short || !inst || !dayStart || older?.key === instKey) return;
    const ac = new AbortController();
    const to = tape.length ? tape[tape.length - 1]!.ts : serverNow();
    getJSON<HistFill[]>("/api/fills", { symbol: inst.symbol, venue: inst.venue, from: dayStart, to }, ac.signal)
      .then((h) => {
        if (ac.signal.aborted) return;
        const rows = h
          .filter((f) => f.venue === inst.venue && f.t < to)
          .slice(-N)
          .reverse()
          .map((f, i): ShownFill => ({ id: `h${f.t}:${i}`, ts: f.t, account: f.account, symbol: inst.symbol, venue: f.venue, side: f.side, price: f.price, qty: f.qty, notional: f.price * f.qty, maker: f.maker, edge_bps: null }));
        setOlder({ key: instKey, rows });
      })
      .catch(() => {});
    return () => ac.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [short, instKey, dayStart]);
  const list: ShownFill[] = useMemo(
    () => (older && older.key === instKey && tape.length < N ? [...tape, ...older.rows.filter((f) => !tape.length || f.ts < tape[tape.length - 1]!.ts)].slice(0, N) : tape),
    [older, instKey, tape],
  );

  // rows that arrive after the list is first drawn flash once (the class stays a second; the animation runs once)
  const seen = useRef<Set<string> | null>(null);
  const freshAt = useRef(new Map<string, number>());
  const key = inst ? inst.venue + inst.symbol : "";
  const shownKey = useRef(key);
  if (shownKey.current !== key) {
    shownKey.current = key;
    seen.current = null;
    freshAt.current.clear();
  }
  const now = Date.now();
  if (seen.current) for (const f of list) if (!seen.current.has(f.id) && !freshAt.current.has(f.id)) freshAt.current.set(f.id, now);
  for (const [id, t] of freshAt.current) if (now - t > 1000) freshAt.current.delete(id);
  useEffect(() => {
    seen.current = new Set(list.map((f) => f.id));
  }, [list]);
  const fresh = freshAt.current;

  const base = inst?.symbol.replace(/USDT$/, "");
  return (
    <section className="dk-panel dk-tr">
      <div className="dk-head">
        <span className="dk-title">Fills</span>
        <span className="dk-head-r muted fig">{fillsDay == null ? "--" : `${int(fillsDay)} today`}</span>
      </div>
      <div className={"dk-tr-hd" + (inst ? " inst" : "")}>
        {inst ? (
          <>
            <span>Price(USDT)</span>
            <span>Qty({base})</span>
          </>
        ) : (
          <>
            <span>Symbol</span>
            <span>Price</span>
            <span>Notional</span>
          </>
        )}
        <span title="Edge at fill against fair, bps">Edge</span>
        <span>Time</span>
      </div>
      <div className="dk-tr-body">
        {list.map((f) => (
          <FillRow key={f.id} f={f} inst={!!inst} fresh={fresh.has(f.id)} hide={hide} time={hms(f.ts, tz)} />
        ))}
        {fills && !list.length && fillsDay === 0 && <div className="dk-empty">No fills today</div>}
      </div>
    </section>
  );
}

const FillRow = memo(function FillRow({ f, inst, fresh, hide, time }: { f: ShownFill; inst: boolean; fresh: boolean; hide: boolean; time: string }) {
  const side = f.side === "buy" ? "up" : "down";
  const tip = `${f.side === "buy" ? "Buy" : "Sell"} ${qtyText(f.qty, hide)} ${f.symbol.replace(/USDT$/, "")} at ${price(f.price)}, ${f.account}${f.maker ? "" : ", taker"}`;
  return (
    <div
      className={"dk-tr-row" + (inst ? " inst" : " click") + (fresh ? " fresh" : "")}
      title={tip}
      onClick={inst ? undefined : () => selectInstrument({ symbol: f.symbol, venue: f.venue })}
    >
      {inst ? (
        <>
          <span className={"fig " + side}>{price(f.price)}</span>
          <span className="fig">{maskNode(hide, qty(f.qty))}</span>
        </>
      ) : (
        <>
          <span className="dk-tr-sym">
            {f.symbol.replace(/USDT$/, "")}
            {f.venue === "usdm" && <span className="dk-tag">Perp</span>}
          </span>
          <span className={"fig " + side}>{price(f.price)}</span>
          <span className="fig">{maskNode(hide, compact(f.notional))}</span>
        </>
      )}
      <span className={"fig " + (f.edge_bps == null ? "muted" : "")}>{f.edge_bps == null ? "--" : bps(f.edge_bps)}</span>
      <span className="fig muted">{time}</span>
    </div>
  );
});
