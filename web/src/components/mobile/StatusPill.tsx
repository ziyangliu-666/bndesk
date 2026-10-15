import { useState } from "react";
import { UnstyledButton } from "@mantine/core";
import { IconRefresh } from "@tabler/icons-react";
import { useStore } from "../../store";
import { useNow } from "../../hooks";
import { reconnectNow } from "../../ws";
import { hm, hms } from "../../format";
import { nextEvent } from "../Header";
import { Sheet } from "./Sheet";
import { KV, span } from "./figures";

export type Fresh = "connecting" | "live" | "lag" | "stale" | "reconnecting";

const LAG = 3_000;
const STALE = 10_000;

/** How fresh the figures are: live under 3 s since the last message, lagging to 10 s, stale after that or
 *  while the socket is down. `stale` is true when figures should dim. */
export function useFreshness(): { state: Fresh; age: number | null; lastMsg: number; stale: boolean } {
  const conn = useStore((s) => s.conn);
  const lastMsg = useStore((s) => s.lastMsg);
  const now = useNow(500);
  const age = lastMsg ? Math.max(0, now - lastMsg) : null;
  let state: Fresh;
  if (conn === "connecting") state = "connecting";
  else if (conn === "reconnecting") state = "reconnecting";
  else if (age == null || age < LAG) state = "live";
  else if (age < STALE) state = "lag";
  else state = "stale";
  const stale = lastMsg > 0 && (state === "stale" || state === "reconnecting" || state === "connecting" || (age ?? 0) >= STALE);
  return { state, age, lastMsg, stale };
}

const WORD: Record<Fresh, string> = {
  connecting: "Connecting",
  live: "Live",
  lag: "Lagging",
  stale: "Stale",
  reconnecting: "Reconnecting",
};

function pillText(state: Fresh, age: number | null): string {
  if (state === "lag" && age != null) return `Lag ${span(age)}`;
  if (state === "stale" && age != null) return `Stale ${span(age)}`;
  return WORD[state];
}

/** Always in the top bar: the connection's state in a word, with a dot. Tap for details and Reconnect now. */
export function StatusPill() {
  const { state, age } = useFreshness();
  const [open, setOpen] = useState(false);
  return (
    <>
      <UnstyledButton className={"m-pill m-fig " + state} onClick={() => setOpen(true)} aria-label={`Connection: ${pillText(state, age)}`}>
        <span className={"m-led " + state} />
        {pillText(state, age)}
      </UnstyledButton>
      <StatusSheet opened={open} onClose={() => setOpen(false)} />
    </>
  );
}

function StatusSheet({ opened, onClose }: { opened: boolean; onClose: () => void }) {
  const { state, age, lastMsg } = useFreshness();
  const tz = useStore((s) => s.tz);
  const skew = useStore((s) => s.skew);
  const session = useStore((s) => s.snap?.summary.session);
  const now = useNow(1000) + skew;
  const mock = import.meta.env.VITE_MOCK === "1";
  const tzName = tz === "utc" ? "UTC" : "local";

  const why =
    state === "live"
      ? "Updates are arriving."
      : state === "lag"
        ? "Updates are late; the figures may be a few seconds old."
        : state === "stale"
          ? "No update for a while: the figures are dimmed and may be out of date."
          : state === "reconnecting"
            ? "The connection dropped; retrying. The figures are dimmed until it is back."
            : "Opening the connection.";

  const sess = session?.next_event_at != null ? session : null;
  return (
    <Sheet opened={opened} onClose={onClose} title="Connection">
      <div className="m-status-head">
        <span className={"m-led " + state} />
        <div>
          <div className="m-status-word">{WORD[state]}</div>
          <div className="m-status-why">{why}</div>
        </div>
      </div>
      <div className="m-body">
        <KV
          items={[
            { label: "Clock", value: `${hms(now, tz)} ${tzName}` },
            { label: "Last update", value: lastMsg ? `${span(age ?? 0)} ago` : "—", tone: state === "stale" ? "crit" : state === "lag" ? "warn" : undefined },
            // one session line: "Americas · closes in 1 h 7 min", the event's clock time beside it
            {
              label: "Session",
              span: 2,
              value: sess ? (
                <>
                  {sess.name ? `${cap(sess.name)} · ${nextEvent(sess.next_event, sess.name)}` : cap(sess.next_event ?? "next event")} in{" "}
                  {span(sess.next_event_at! - now)} <span className="muted">· {hm(sess.next_event_at!, tz)} {tzName}</span>
                </>
              ) : (
                "—"
              ),
            },
          ]}
        />
      </div>
      <div style={{ marginTop: 16 }}>
        <UnstyledButton className="m-btn primary" onClick={() => reconnectNow()} disabled={mock}>
          <IconRefresh size={18} stroke={2} />
          Reconnect now
        </UnstyledButton>
        {mock && <div className="m-note">Demo: the data is generated in this browser, there is no connection.</div>}
      </div>
    </Sheet>
  );
}

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
