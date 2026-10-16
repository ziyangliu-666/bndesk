// The instrument tab of the History page: its name with ▾, opening a searchable list of the desk's instruments
// (the busiest first, each with its day PnL).
import { useEffect, useMemo, useRef, useState } from "react";
import { useStore } from "../../store";
import { pnl } from "../../format";
import { maskNode, useHide } from "../../mask";
import { useHedgePnl } from "../../selectors";
import type { SymbolRow, Venue } from "../../protocol";

export function InstrumentPicker({
  value,
  onPick,
  active,
}: {
  value: { symbol: string; venue: Venue } | null;
  onPick: (symbol: string, venue: Venue) => void;
  active: boolean;
}) {
  const symbols = useStore((s) => s.snap?.symbols);
  const hide = useHide();
  const hedgeOf = useHedgePnl();
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const box = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const list = useMemo(() => {
    // by today's volume; by name while amounts are hidden (the order would give the volumes away)
    const rows = (symbols ?? []).slice().sort((a, b) => (hide ? 0 : b.volume_day - a.volume_day) || a.symbol.localeCompare(b.symbol) || a.venue.localeCompare(b.venue));
    const f = q.trim().toUpperCase();
    return f ? rows.filter((r) => r.symbol.includes(f)) : rows;
  }, [symbols, q, hide]);
  const [hi, setHi] = useState(0);

  useEffect(() => {
    if (!open) return;
    const away = (e: PointerEvent) => box.current && !box.current.contains(e.target as Node) && setOpen(false);
    document.addEventListener("pointerdown", away);
    requestAnimationFrame(() => input.current?.focus());
    return () => document.removeEventListener("pointerdown", away);
  }, [open]);

  const pick = (i: number) => {
    const r = list[i];
    if (!r) return;
    onPick(r.symbol, r.venue);
    setOpen(false);
    setQ("");
  };

  return (
    <div className="hx-pick" ref={box}>
      <button
        type="button"
        role="tab"
        aria-selected={active}
        aria-haspopup="listbox"
        aria-expanded={open}
        className={"ex-tab" + (active ? " on" : "")}
        onClick={() => (active || !value ? setOpen(!open) : onPick(value.symbol, value.venue))}
        title={active ? "Choose an instrument" : undefined}
      >
        {value ? (
          <>
            {value.symbol}
            {value.venue === "usdm" && <span className="hx-perp">Perp</span>}
          </>
        ) : (
          "Instrument"
        )}
      </button>
      <button type="button" className="hx-pick-caret" aria-label="Choose an instrument" onClick={() => setOpen(!open)}>
        ▾
      </button>
      {open && (
        <div className="hx-pick-menu">
          <input
            ref={input}
            className="hx-pick-q"
            placeholder="Search"
            value={q}
            spellCheck={false}
            onChange={(e) => {
              setQ(e.target.value);
              setHi(0);
            }}
            onKeyDown={(e) => {
              if (e.key === "Escape") setOpen(false);
              else if (e.key === "ArrowDown") setHi((h) => Math.min(list.length - 1, h + 1));
              else if (e.key === "ArrowUp") setHi((h) => Math.max(0, h - 1));
              else if (e.key === "Enter") pick(hi);
              else return;
              e.preventDefault();
            }}
          />
          <div className="hx-pick-head">
            <span>Symbol</span>
            <span>Trading PnL</span>
          </div>
          <div className="hx-pick-list" role="listbox">
            {list.map((r, i) => (
              <button
                type="button"
                role="option"
                aria-selected={value?.symbol === r.symbol && value.venue === r.venue}
                key={r.venue + r.symbol}
                className={"hx-pick-it" + (i === hi ? " hi" : "") + (value?.symbol === r.symbol && value.venue === r.venue ? " on" : "")}
                onMouseEnter={() => setHi(i)}
                onClick={() => pick(i)}
              >
                <span>
                  {r.symbol}
                  {r.venue === "usdm" && <span className="hx-perp">Perp</span>}
                </span>
                <PnlCell r={r} hedge={hedgeOf(r)} hide={hide} />
              </button>
            ))}
            {!list.length && <div className="hx-pick-none">No instrument matches</div>}
          </div>
        </div>
      )}
    </div>
  );
}

/** A spot market's Trading PnL, or a perp's hedge leg (marked so). */
function PnlCell({ r, hedge, hide }: { r: SymbolRow; hedge: number | null; hide: boolean }) {
  const perp = r.venue === "usdm";
  const v = perp ? hedge : r.trading_pnl;
  return (
    <span className={"fig " + (hide || v == null ? "" : v > 0.005 ? "up" : v < -0.005 ? "down" : "")}>
      {perp && <span className="dk-mk-k">hedge </span>}
      {maskNode(hide, pnl(v))}
    </span>
  );
}
