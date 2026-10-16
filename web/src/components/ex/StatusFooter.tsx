// The desktop's 28 px footer: connection state, feeds, session clock, UTC | Local, a marquee of the
// instruments' day P&L, and the TradingView attribution.
import { memo } from "react";
import { useStore } from "../../store";
import { useNow } from "../../hooks";
import { countdown, hms, hm, pnl } from "../../format";
import { nextEvent } from "../Header";
import { useFreshness, type Fresh } from "../mobile/StatusPill";
import type { Venue } from "../../protocol";
import { TvAttribution } from "./controls";
import { useDayPnlList } from "../../selectors";
import { maskText, useHide } from "../../mask";
import "./ex.css";

const CONN: Record<Fresh, [string, string]> = {
  live: ["Live", "up"],
  lag: ["Stale", "warn"],
  stale: ["Stale", "warn"],
  connecting: ["Connecting", "warn"],
  reconnecting: ["Disconnected", "crit"],
};

/**
 * Desktop footer, 28 px, full width: `● Live` (or Stale / Disconnected, from the socket and the age of the
 * last message), `Feeds 14/14`, the session and its countdown, the clock with UTC | Local, a marquee of each
 * instrument's day P&L (Π today; hover pauses; a click calls `onInstrument`), and "Charts by TradingView".
 */
export function StatusFooter({ onInstrument }: { onInstrument?: (symbol: string, venue: Venue) => void }) {
  return (
    <footer className="ex-foot">
      <ConnState />
      <Feeds />
      <span className="ex-foot-vr" />
      <SessionClock />
      <TzToggle />
      <span className="ex-foot-vr" />
      <Marquee onInstrument={onInstrument} />
      <span className="ex-foot-vr" />
      <TvAttribution />
    </footer>
  );
}

function ConnState() {
  const { state, age } = useFreshness();
  const [word, tone] = CONN[state];
  const tip = age != null ? `Last update ${Math.round(age / 100) / 10} s ago` : "No update yet";
  return (
    <span className={"ex-foot-conn " + tone} role="status" title={tip}>
      <span className="ex-dot" />
      {word}
    </span>
  );
}

function Feeds() {
  const feeds = useStore((s) => s.snap?.feeds);
  if (!feeds?.length) return <span className="fig">Feeds --</span>;
  const up = feeds.filter((f) => f.up).length;
  const down = feeds.filter((f) => !f.up).map((f) => f.name);
  return (
    <span className={"fig" + (up < feeds.length ? " ex-warn" : "")} title={down.length ? "Down: " + down.join(", ") : "Every feed is up"}>
      Feeds {up}/{feeds.length}
    </span>
  );
}

function SessionClock() {
  const s = useStore((st) => st.snap?.summary.session);
  const tz = useStore((st) => st.tz);
  const skew = useStore((st) => st.skew);
  const now = useNow(1000) + skew;
  const tzName = tz === "utc" ? "UTC" : "local time";
  const sess =
    s && s.next_event_at != null ? (
      <span
        className="fig"
        title={`${s.name ? `Session ${s.name}: ` : ""}${nextEvent(s.next_event, s.name)} at ${hm(s.next_event_at, tz)} ${tzName}; time left h:mm:ss`}
      >
        Session <span className="ex-ink">{s.name ?? "next"}</span> {countdown(s.next_event_at - now)} left
      </span>
    ) : null;
  return (
    <>
      {sess}
      {sess && <span className="ex-foot-vr" />}
      <span className="fig ex-ink">{hms(now, tz)}</span>
    </>
  );
}

function TzToggle() {
  const tz = useStore((s) => s.tz);
  const setTz = useStore((s) => s.setTz);
  return (
    <span className="ex-foot-tz" role="radiogroup" aria-label="Time zone" title="Times in UTC or this computer's time (key t)">
      <button type="button" role="radio" aria-checked={tz === "utc"} className={tz === "utc" ? "on" : ""} onClick={() => setTz("utc")}>
        UTC
      </button>
      <button type="button" role="radio" aria-checked={tz === "local"} className={tz === "local" ? "on" : ""} onClick={() => setTz("local")}>
        Local
      </button>
    </span>
  );
}

const Marquee = memo(function Marquee({ onInstrument }: { onInstrument?: (symbol: string, venue: Venue) => void }) {
  const items = useDayPnlList(24);
  const hide = useHide();
  if (!items.length) return <span className="ex-marq" />;
  const row = (copy: boolean) => items.map((r) => (
    <button
      key={r.symbol + r.venue}
      type="button"
      tabIndex={copy ? -1 : undefined}
      className="ex-marq-it"
      onClick={onInstrument ? () => onInstrument(r.symbol, r.venue) : undefined}
      title={`${r.symbol}${r.venue === "usdm" ? " perp" : ""}: Trading PnL today, USDT`}
    >
      <span className="ex-ink">
        {r.symbol}
        {r.venue === "usdm" ? " perp" : ""}
      </span>{" "}
      <span className={"fig " + (hide ? "masked" : r.pnl > 0.005 ? "up" : r.pnl < -0.005 ? "down" : "")}>{maskText(hide, pnl(r.pnl))}</span>
    </button>
  ));
  // two copies scroll by half their width, so the loop has no seam
  return (
    <div className="ex-marq">
      <span className="ex-marq-l" title="Each instrument's Trading PnL today, USDT">
        Trading PnL
      </span>
      <div className="ex-marq-clip">
        <div className="ex-marq-in" style={{ animationDuration: `${Math.max(30, items.length * 5)}s` }}>
          {row(false)}
          <span aria-hidden="true" className="ex-marq-copy">
            {row(true)}
          </span>
        </div>
      </div>
    </div>
  );
});
