// The ticker's name slot as a picker (`Desk ▾`, `ETHUSDT ▾`), as on an exchange's trade page: a searchable list
// of the desk and its instruments, the biggest inventory first (by name while amounts are hidden), each with its
// Trading PnL (a perp: its hedge leg, marked so).
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { selectInstrument, useStore, type Instrument } from "../../store";
import { pnl } from "../../format";
import { maskNode, useHide } from "../../mask";
import { useHedgePnl } from "../../selectors";

export function NamePicker({ sel, children }: { sel: Instrument | null; children: ReactNode }) {
  const symbols = useStore((s) => s.snap?.symbols);
  const hide = useHide();
  const hedgeOf = useHedgePnl();
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const [hi, setHi] = useState(0);
  const box = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);

  // the desk first (index 0, only without a search), then the instruments
  const list = useMemo(() => {
    const f = q.trim().toUpperCase();
    const rows = (symbols ?? [])
      .filter((r) => !f || r.symbol.includes(f))
      .sort((a, b) => (hide ? 0 : Math.abs(b.inv_value) - Math.abs(a.inv_value)) || a.symbol.localeCompare(b.symbol) || a.venue.localeCompare(b.venue));
    return [...(f ? [] : [null]), ...rows];
  }, [symbols, q, hide]);
  const deskTp = useMemo(() => (symbols ?? []).reduce((a, r) => a + (r.venue === "spot" ? r.trading_pnl : 0), 0), [symbols]);

  useEffect(() => {
    if (!open) return;
    const away = (e: PointerEvent) => box.current && !box.current.contains(e.target as Node) && setOpen(false);
    document.addEventListener("pointerdown", away);
    requestAnimationFrame(() => input.current?.focus());
    return () => document.removeEventListener("pointerdown", away);
  }, [open]);

  const pick = (i: number) => {
    const r = list[i];
    if (r === undefined) return;
    selectInstrument(r ? { symbol: r.symbol, venue: r.venue } : null);
    setOpen(false);
    setQ("");
  };

  return (
    <div className="dk-pick" ref={box}>
      <button type="button" className="dk-pick-btn" aria-haspopup="listbox" aria-expanded={open} onClick={() => setOpen(!open)} title="Choose the desk or an instrument">
        {children}
        <span className="dk-pick-caret" aria-hidden>
          ▾
        </span>
      </button>
      {open && (
        <div className="dk-pick-menu">
          <input
            ref={input}
            className="dk-pick-q"
            placeholder="Search"
            value={q}
            spellCheck={false}
            aria-label="Search instruments"
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
          <div className="dk-pick-head">
            <span>Symbol</span>
            <span>Trading PnL</span>
          </div>
          <div className="dk-pick-list" role="listbox">
            {list.map((r, i) => {
              const on = r ? sel?.symbol === r.symbol && sel.venue === r.venue : !sel;
              const perp = r?.venue === "usdm";
              const tp = r ? (perp ? hedgeOf(r) : r.trading_pnl) : deskTp;
              return (
                <button
                  type="button"
                  role="option"
                  aria-selected={on}
                  key={r ? r.venue + r.symbol : "desk"}
                  className={"dk-pick-it" + (i === hi ? " hi" : "") + (on ? " on" : "")}
                  onMouseEnter={() => setHi(i)}
                  onClick={() => pick(i)}
                >
                  <span>
                    {r ? r.symbol : "Desk"}
                    {r?.venue === "usdm" && <span className="dk-tag">Perp</span>}
                  </span>
                  <span className={"fig " + (hide || tp == null ? "" : tp > 0.005 ? "up" : tp < -0.005 ? "down" : "")}>
                    {perp && <span className="dk-mk-k">hedge </span>}
                    {maskNode(hide, pnl(tp))}
                  </span>
                </button>
              );
            })}
            {list.length === 0 && <div className="dk-empty">No instrument matches</div>}
          </div>
        </div>
      )}
    </div>
  );
}
