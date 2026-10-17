// The desktop's 28 px footer: the clock with UTC | Local and the session, quiet; the connection and the feeds
// only when something is wrong (Stale 12 s, Disconnected, Feeds 12/13), in words; the TradingView attribution.
import { useStore } from "../../store";
import { useNow } from "../../hooks";
import { countdown, hms, hm } from "../../format";
import { nextEvent } from "../Header";
import { useFreshness } from "../mobile/StatusPill";
import { TvAttribution } from "./controls";
import "./ex.css";

/**
 * Desktop footer, 28 px, full width: the clock, UTC | Local and the session's countdown in muted text; at the
 * right, a stale or lost connection and any feed down, in the warning colours, then "Charts by TradingView".
 * Nothing there moves or glows while all is well.
 */
export function StatusFooter() {
  return (
    <footer className="ex-foot">
      <SessionClock />
      <TzToggle />
      <span className="ex-foot-gap" />
      <ConnState />
      <Feeds />
      <TvAttribution />
    </footer>
  );
}

/** Nothing while the figures are live; else how stale they are, or that the socket is down. */
function ConnState() {
  const { state, age } = useFreshness();
  if (state === "live") return null;
  const secs = age != null ? Math.round(age / 1000) : null;
  const [word, tone] =
    state === "reconnecting" ? ["Disconnected", "crit"] : state === "connecting" ? ["Connecting", "warn"] : [`Stale ${secs ?? "--"} s`, state === "stale" ? "crit" : "warn"];
  const tip = age != null ? `Last update ${Math.round(age / 100) / 10} s ago` : "No update yet";
  return (
    <span className={"ex-foot-conn " + tone} role="status" title={tip}>
      {word}
    </span>
  );
}

/** Only when a feed is down: how many are up, the down ones on hover. */
function Feeds() {
  const feeds = useStore((s) => s.snap?.feeds);
  const down = (feeds ?? []).filter((f) => !f.up).map((f) => f.name);
  if (!feeds?.length || !down.length) return null;
  return (
    <span className="fig ex-warn" title={"Down: " + down.join(", ")}>
      Feeds {feeds.length - down.length}/{feeds.length}
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
        {s.name ? `${s.name[0]!.toUpperCase()}${s.name.slice(1)} session` : "Next session"} · {countdown(s.next_event_at - now)} left
      </span>
    ) : null;
  return (
    <>
      <span className="fig">{hms(now, tz)}</span>
      {sess}
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
