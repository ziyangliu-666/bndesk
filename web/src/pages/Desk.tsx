// The desktop Desk, laid out as an exchange's trade page: the ticker strip on top; the quote ladder at the left,
// the chart in the centre, the instruments list and the latest fills at the right; the tabbed panel under the
// chart. Picking an instrument (any row) turns the ticker, chart and ladder into that instrument's; Esc, the ✕
// in the name slot or the pinned Desk row go back to the desk as a whole.
import { useEffect, useMemo } from "react";
import { selectInstrument, useStore, type Instrument } from "../store";
import { DeskTicker, InstrumentTicker } from "../components/KeyStrip";
import { DeskChart } from "./desk/DeskChart";
import { InstrumentChart } from "./desk/InstrumentChart";
import { Ladder } from "./desk/Ladder";
import { Instruments } from "./desk/Instruments";
import { LatestFills } from "./desk/LatestFills";
import { BottomPanel } from "./desk/BottomPanel";
import "./desk/desk.css";

const LADDER_KEY = "desk.ladder";

function readLadder(): Instrument | null {
  try {
    const v = JSON.parse(localStorage.getItem(LADDER_KEY) ?? "null") as Instrument | null;
    return v && typeof v.symbol === "string" ? v : null;
  } catch {
    return null;
  }
}
/** The last instrument picked, read once and kept here as it changes (not read from storage in a selector,
 *  which runs on every store update). */
let lastPicked: Instrument | null | undefined;
const lastLadder = () => (lastPicked === undefined ? (lastPicked = readLadder()) : lastPicked);

/** The ladder's instrument with nothing picked: the last one picked while it is still quoted, else the one with
 *  the most open orders. */
function useLadderInstrument(sel: Instrument | null): Instrument | null {
  useEffect(() => {
    if (!sel) return;
    lastPicked = sel;
    try {
      localStorage.setItem(LADDER_KEY, JSON.stringify(sel));
    } catch {
      /* private mode */
    }
  }, [sel]);
  // the instrument with the most orders, as a string: the ladder does not re-render on every order change
  const most = useStore((s) => {
    if (sel) return "";
    const n = new Map<string, number>();
    for (const o of s.snap?.orders ?? []) n.set(o.venue + ":" + o.symbol, (n.get(o.venue + ":" + o.symbol) ?? 0) + 1);
    const last = lastLadder();
    if (last && n.has(last.venue + ":" + last.symbol)) return last.venue + ":" + last.symbol;
    let best = "";
    let k = 0;
    for (const [key, c] of n) if (c > k || (c === k && key < best)) [best, k] = [key, c];
    return best;
  });
  return useMemo(() => {
    if (sel) return sel;
    if (!most) return null;
    const [venue, symbol] = most.split(":") as [Instrument["venue"], string];
    return { symbol, venue };
  }, [sel, most]);
}

export function Desk() {
  const sel = useStore((s) => s.deskSymbol);
  const chartOpen = useStore((s) => s.chart != null);
  const ladder = useLadderInstrument(sel);

  // Esc: back to the desk (not while a fullscreen chart or a text field has it)
  useEffect(() => {
    if (!sel) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || e.defaultPrevented || chartOpen) return;
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return;
      selectInstrument(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [sel, chartOpen]);

  const back = (
    <button type="button" className="dk-back" onClick={() => selectInstrument(null)} title="Back to the desk (Esc)">
      ← Desk
    </button>
  );

  return (
    <div className="dk">
      {sel ? (
        <InstrumentTicker
          inst={sel}
          name={
            <div className="dk-name">
              <div className="dk-name-row">
                <span className="dk-name-big">{sel.symbol}</span>
                <span className="dk-tag">{sel.venue === "usdm" ? "Perp" : "Spot"}</span>
                <button type="button" className="dk-x" onClick={() => selectInstrument(null)} title="Back to the desk (Esc)" aria-label="Back to the desk">
                  ✕
                </button>
              </div>
              <div className="dk-name-sub">{sel.venue === "usdm" ? "USD-M perpetual" : "Spot"} · all accounts</div>
            </div>
          }
        />
      ) : (
        <DeskTicker
          name={
            <div className="dk-name">
              <div className="dk-name-row">
                <span className="dk-name-big">Desk</span>
              </div>
              <div className="dk-name-sub">All accounts</div>
            </div>
          }
        />
      )}
      <div className="dk-lad-cell">
        <Ladder inst={ladder} />
      </div>
      <div className="dk-centre-cell">{sel ? <InstrumentChart inst={sel} head={back} /> : <DeskChart />}</div>
      <div className="dk-right">
        <Instruments sel={sel} />
        <LatestFills inst={sel} />
      </div>
      <div className="dk-bottom-cell">
        <BottomPanel sel={sel} />
      </div>
    </div>
  );
}
