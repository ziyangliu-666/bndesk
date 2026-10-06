import { SegmentedControl, UnstyledButton } from "@mantine/core";
import { useStore, type Page } from "../store";
import { useNow } from "../hooks";
import { countdown, dur, hm, hms } from "../format";

const PAGES: { value: Page; label: string }[] = [
  { value: "desk", label: "Desk" },
  { value: "history", label: "History" },
  { value: "markouts", label: "Markouts" },
  { value: "orders", label: "Orders" },
  { value: "accounts", label: "Accounts" },
  { value: "engine", label: "Engine" },
];

export const PAGE_KEYS: Record<string, Page> = Object.fromEntries(PAGES.map((p, i) => [String(i + 1), p.value]));

export function Header() {
  const page = useStore((s) => s.page);
  const setPage = useStore((s) => s.setPage);
  const tz = useStore((s) => s.tz);
  const setTz = useStore((s) => s.setTz);
  return (
    <header className="app-head">
      <div className="brand">bndesk</div>
      <SegmentedControl
        size="xs"
        value={page}
        onChange={(v) => setPage(v as Page)}
        data={PAGES.map((p, i) => ({
          value: p.value,
          label: (
            <span className="tab-label">
              {p.label}
              <kbd>{i + 1}</kbd>
            </span>
          ),
        }))}
        classNames={{ root: "tabs-root", indicator: "tabs-ind", label: "tabs-lab" }}
      />
      <div className="head-right">
        <Session />
        <Clock />
        <UnstyledButton
          className="tz-toggle"
          onClick={() => setTz(tz === "utc" ? "local" : "utc")}
          title="Toggle UTC / local time (t)"
        >
          <span className={tz === "utc" ? "on" : ""}>UTC</span>
          <span className={tz === "local" ? "on" : ""}>local</span>
        </UnstyledButton>
        <ConnPill />
        {import.meta.env.VITE_MOCK !== "1" && (
          <form method="post" action="/logout" className="logout">
            <button type="submit" title="End this browser's session">Log out</button>
          </form>
        )}
      </div>
    </header>
  );
}

function Clock() {
  const tz = useStore((s) => s.tz);
  const skew = useStore((s) => s.skew);
  const now = useNow(1000);
  return <span className="clock fig">{hms(now + skew, tz)}</span>;
}

/** "asia closes" after "asia" reads as "closes": the session name is already there. */
const nextEvent = (ev: string | null, cur: string | null) =>
  !ev ? "the next event" : cur && ev.startsWith(cur + " ") ? ev.slice(cur.length + 1) : ev;

function Session() {
  const s = useStore((st) => st.snap?.summary.session);
  const tz = useStore((st) => st.tz);
  const skew = useStore((st) => st.skew);
  const now = useNow(1000) + skew;
  if (!s || s.next_event_at == null) return null;
  const name = s.name ?? "next";
  const tzName = tz === "utc" ? "UTC" : "local time";
  const tip = s.name
    ? `Session ${s.name}${s.open ? ", open" : ""}: ${nextEvent(s.next_event, s.name)} at ${hm(s.next_event_at, tz)} ${tzName}; time left h:mm:ss`
    : `${s.next_event ?? "Next event"} at ${hm(s.next_event_at, tz)} ${tzName}; time left h:mm:ss`;
  return (
    <span className="session fig" title={tip}>
      <span className="muted">{name}</span> {countdown(s.next_event_at - now)}
    </span>
  );
}

function ConnPill() {
  const conn = useStore((s) => s.conn);
  const lastMsg = useStore((s) => s.lastMsg);
  const now = useNow(500);
  const age = lastMsg ? now - lastMsg : null;
  let cls = "";
  let text = "";
  if (conn === "connecting") {
    cls = "warn";
    text = "connecting";
  } else if (conn === "reconnecting") {
    cls = "warn";
    text = age != null ? `reconnecting, last ${dur(age)} ago` : "reconnecting";
  } else if (age != null && age > 3000) {
    cls = "bad";
    text = `stale ${dur(age)}`;
  }
  if (!text) return null;
  return (
    <span className={"conn fig " + cls} role="status">
      {text}
    </span>
  );
}
