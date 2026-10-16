// The quote ladder, the order book's place on an exchange's trade page: one instrument's resting orders of
// ours at their prices, asks above and bids below, with the market's best bid and ask among them and the mid
// with fair in the middle row. Depth shading is each level's notional.
import { useLayoutEffect, useMemo, useRef } from "react";
import { useElementSize } from "@mantine/hooks";
import { selectInstrument, useStore, type Instrument } from "../../store";
import { bps, price, qty } from "../../format";
import type { OpenOrder, SymbolRow } from "../../protocol";
import { MASK, dd, useHide } from "./mask";

interface Level {
  price: number;
  side: "buy" | "sell";
  qty: number;
  notional: number;
  accounts: string[];
  /** The market's best on this side (it may also hold our orders). */
  best: boolean;
  /** Ours on the wrong side of fair. */
  through: boolean;
  /** A reference step from fair (no order, no market price): the ladder's scale between the real levels. */
  grid?: boolean;
}

const STEPS = [0.5, 1, 2, 2.5, 5, 10, 20, 25, 50, 100, 200, 500];

/** Reference rows every `step` bps from fair, nearest first, until the side holds `n` rows; the real levels
 *  keep their exact prices among them. */
function withGrid(real: Level[], side: "buy" | "sell", fair: number | null, n: number): Level[] {
  if (fair == null || n <= real.length) return real;
  const d = (px: number) => (Math.abs(px - fair) / fair) * 1e4;
  const far = Math.max(2, ...real.map((l) => d(l.price)));
  const step = STEPS.find((s) => s * n >= far * 1.25) ?? STEPS[STEPS.length - 1]!;
  const out = real.slice();
  for (let k = 1; out.length < n && k <= n * 2; k++) {
    const bp = k * step;
    if (real.some((l) => Math.abs(d(l.price) - bp) < step * 0.4)) continue;
    const px = side === "sell" ? fair * (1 + bp / 1e4) : fair * (1 - bp / 1e4);
    out.push({ price: px, side, qty: 0, notional: 0, accounts: [], best: false, through: false, grid: true });
  }
  return out.sort((a, b) => (side === "buy" ? b.price - a.price : a.price - b.price));
}

function levels(orders: OpenOrder[], row: SymbolRow | undefined, side: "buy" | "sell"): Level[] {
  const by = new Map<number, Level>();
  for (const o of orders) {
    if (o.side !== side) continue;
    let l = by.get(o.price);
    if (!l) by.set(o.price, (l = { price: o.price, side, qty: 0, notional: 0, accounts: [], best: false, through: false }));
    l.qty += o.qty;
    l.notional += o.notional;
    if (!l.accounts.includes(o.account)) l.accounts.push(o.account);
    if (o.dist_bps != null && o.dist_bps < 0) l.through = true;
  }
  const best = side === "buy" ? row?.bid : row?.ask;
  if (best != null) {
    const l = by.get(best);
    if (l) l.best = true;
    else by.set(best, { price: best, side, qty: 0, notional: 0, accounts: [], best: true, through: false });
  }
  // nearest the middle first
  return [...by.values()].sort((a, b) => (side === "buy" ? b.price - a.price : a.price - b.price));
}

export function Ladder({ inst }: { inst: Instrument | null }) {
  const row = useStore((s) => (inst ? s.snap?.symbols.find((r) => r.symbol === inst.symbol && r.venue === inst.venue) : undefined));
  const orders = useStore((s) => s.snap?.orders);
  const hide = useHide();
  const mine = useMemo(() => (inst ? (orders ?? []).filter((o) => o.symbol === inst.symbol && o.venue === inst.venue) : []), [orders, inst]);
  const { ref: sideBox, height: sideH } = useElementSize();
  const perSide = Math.max(0, Math.floor(sideH / 20));
  const asks = withGrid(levels(mine, row, "sell"), "sell", row?.fair ?? null, perSide);
  const bids = withGrid(levels(mine, row, "buy"), "buy", row?.fair ?? null, perSide);
  const max = Math.max(1e-9, ...asks.map((l) => l.notional), ...bids.map((l) => l.notional));
  const fair = row?.fair ?? null;
  const mid = row?.mid ?? null;
  const base = inst?.symbol.replace(/USDT$/, "") ?? "";

  // the mid's colour follows its last move
  const prev = useRef<{ mid: number | null; dir: string }>({ mid: null, dir: "" });
  if (mid != null && mid !== prev.current.mid) {
    const p = prev.current.mid;
    prev.current = { mid, dir: p == null ? "" : mid > p ? "up" : mid < p ? "down" : prev.current.dir };
  }
  const dir = prev.current.dir;

  // the asks scroll from the bottom: the best ask stays next to the middle row
  const askBox = useRef<HTMLDivElement>(null);
  const symKey = inst ? inst.venue + inst.symbol : "";
  useLayoutEffect(() => {
    const el = askBox.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [symKey, asks.length]);

  const bestBid = bids.find((l) => l.qty > 0);
  const bestAsk = asks.find((l) => l.qty > 0);
  const dist = (l: Level | undefined) => (l && fair ? (l.side === "buy" ? (fair - l.price) / fair : (l.price - fair) / fair) * 1e4 : null);
  const nb = mine.filter((o) => o.side === "buy").length;
  const na = mine.filter((o) => o.side === "sell").length;

  const renderRow = (l: Level) => {
    const d = fair ? ((l.price - fair) / fair) * 1e4 : null;
    return (
      <div
        key={l.side + (l.grid ? "g" : "") + l.price}
        className={"dk-lad-row" + (l.qty > 0 ? " ours" : "") + (l.best ? " best" : "") + (l.through ? " through" : "") + (l.grid ? " grid" : "")}
        title={
          (l.qty > 0 ? `Ours: ${qty(l.qty)} ${base} (${l.accounts.join(", ")})` : "") +
          (l.best ? (l.qty > 0 ? "; " : "") + `market best ${l.side === "buy" ? "bid" : "ask"}` : "") +
          (l.through ? "; through fair" : "") +
          (l.grid ? `Fair ${l.side === "buy" ? "−" : "+"}${bps(Math.abs(d ?? 0), false)} bps` : "")
        }
      >
        {l.qty > 0 && !hide && <span className={"dk-lad-bar " + (l.side === "buy" ? "b" : "a")} style={{ width: `${(l.notional / max) * 100}%` }} />}
        <span className={"dk-lad-px " + (l.side === "buy" ? "up" : "down")}>{price(l.price)}</span>
        <span className="dk-lad-q">
          {l.qty > 0 ? (
            <>
              <span className="dk-lad-acct">{l.accounts.length > 1 ? `${l.accounts.length} accts` : l.accounts[0]}</span>
              {hide ? MASK : qty(l.qty)}
            </>
          ) : l.best ? (
            <span className="dk-lad-mkt">best {l.side === "buy" ? "bid" : "ask"}</span>
          ) : null}
        </span>
        <span className="dk-lad-d">{d == null ? "--" : bps(d)}</span>
      </div>
    );
  };

  return (
    <section className="dk-panel dk-lad">
      <div className="dk-head">
        <span className="dk-title">Quotes</span>
        {inst && (
          <button type="button" className="dk-lad-sym" onClick={() => selectInstrument(inst)} title="Open this instrument">
            {inst.symbol}
            <span className="dk-tag">{inst.venue === "usdm" ? "Perp" : "Spot"}</span>
          </button>
        )}
      </div>
      <div className="dk-lad-hd">
        <span>Price(USDT)</span>
        <span>Ours({base || "--"})</span>
        <span title="Distance from fair, bps">bps</span>
      </div>
      <div className="dk-lad-side asks" ref={askBox}>
        <div className="dk-lad-fill" />
        {[...asks].reverse().map(renderRow)}
      </div>
      <div className="dk-lad-mid">
        <span className={"dk-lad-mid-px fig " + dir}>
          {dd(price(mid))}
          {dir === "up" ? " ↑" : dir === "down" ? " ↓" : ""}
        </span>
        <span className="dk-lad-mid-sub">
          <span>
            Fair <b className="fig">{dd(price(fair))}</b>
          </span>
          <span title="Mid against fair">
            Mid {mid != null && fair ? `${bps(((mid - fair) / fair) * 1e4)} bps` : "--"}
          </span>
        </span>
      </div>
      <div className="dk-lad-side bids" ref={sideBox}>
        {bids.map(renderRow)}
      </div>
      <div className="dk-lad-foot">
        <span>
          Ours <span className="up">{nb} bids</span> · <span className="down">{na} asks</span>
        </span>
        <span title="Best own bid and ask, distance from fair">
          Best {dd(bps(dist(bestBid), false))} / {dd(bps(dist(bestAsk), false))} bps
        </span>
      </div>
      {!inst && <div className="dk-empty dk-lad-none">No quoted instrument</div>}
    </section>
  );
}
