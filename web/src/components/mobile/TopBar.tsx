import { UnstyledButton } from "@mantine/core";
import { useShallow } from "zustand/react/shallow";
import { IconBell, IconChevronLeft, IconEyeOff } from "@tabler/icons-react";
import { back, isSub, navigate, useStore, type Route } from "../../store";
import { dur, hms } from "../../format";
import { useNow } from "../../hooks";
import { LevelIcon } from "../ui";
import { useAlertCount } from "./MobileNav";
import { reconnectNow } from "../../ws";
import { titleOf } from "../../pages/mobile";
import { StatusPill, useFreshness } from "./StatusPill";

/** Sticky top bar: the page title (below a tab's own page, the back chevron and the title are one button),
 *  the alerts bell with its count, and the connection only while it is not live; while amounts are hidden, a button that shows them
 *  again; while the figures are stale, a line saying how old they are; while a critical alert is active, one
 *  line with it (every page). */
export function TopBar({ route }: { route: Route }) {
  // the title's words only (an account's label, an alert's level): not every message's snapshot
  const [title, suffix] = useStore(useShallow((s) => titleOf(route, s.snap)));
  const hidden = useStore((s) => s.hideAmounts);
  const sub = isSub(route);
  const text = (
    <>
      {title}
      {suffix && <span className="m-title-sub">{suffix}</span>}
    </>
  );
  return (
    <header className="m-bar">
      <div className={"m-bar-row" + (sub ? " sub" : "")}>
        {sub ? (
          <h1 className="m-title">
            <UnstyledButton className="m-back" onClick={back}>
              <IconChevronLeft size={26} stroke={2} aria-hidden />
              <span className="m-sr">Back from </span>
              <span className="m-back-title">{text}</span>
            </UnstyledButton>
          </h1>
        ) : (
          <h1 className="m-title">{text}</h1>
        )}
        {hidden && (
          <UnstyledButton
            className="m-hidden-on"
            onClick={() => useStore.getState().setHideAmounts(false)}
            aria-label="Amounts are hidden. Show amounts"
          >
            <IconEyeOff size={20} stroke={1.75} />
          </UnstyledButton>
        )}
        <Bell route={route} />
        <StatusPill />
      </div>
      <AsOf />
      <CritPin route={route} />
    </header>
  );
}

function AsOf() {
  const { stale, lastMsg, state } = useFreshness();
  const tz = useStore((s) => s.tz);
  const skew = useStore((s) => s.skew);
  if (!stale) return null;
  return (
    <div className="m-asof m-fig" role="status">
      <span className="m-asof-text">
        {state === "reconnecting" ? "Reconnecting. " : ""}Figures as of {hms(lastMsg + skew, tz)}
        {tz === "utc" ? " UTC" : ""}
      </span>
      {import.meta.env.VITE_MOCK !== "1" && <UnstyledButton onClick={() => reconnectNow()}>Reconnect</UnstyledButton>}
    </div>
  );
}

/** The alerts bell, the active count as a plain figure beside it (red when one is critical); a tap opens Alerts
 *  over the current tab. */
function Bell({ route }: { route: Route }) {
  const { n, crit } = useAlertCount();
  const here = route.page === "alerts" && !route.detail;
  return (
    <UnstyledButton
      className={"m-bell" + (here ? " on" : "")}
      aria-current={here ? "page" : undefined}
      aria-label={n ? `Alerts, ${n} active` : "Alerts"}
      onClick={() => !here && navigate({ page: "alerts" })}
    >
      <IconBell size={22} stroke={1.6} />
      {n > 0 && <span className={"m-bell-n m-fig" + (crit ? " crit" : "")}>{n > 99 ? "99+" : n}</span>}
    </UnstyledButton>
  );
}

/** The newest active critical alert, pinned under the bar on every page; a tap opens it. */
function CritPin({ route }: { route: Route }) {
  const alerts = useStore((s) => s.snap?.alerts);
  const skew = useStore((s) => s.skew);
  const now = useNow(1000) + skew;
  const crit = (alerts ?? []).filter((a) => a.active && a.level === "crit").sort((x, y) => y.since - x.since);
  const a = crit[0];
  if (!a || (route.detail?.kind === "alert" && route.detail.id === a.id) || (route.page === "alerts" && !route.detail)) return null;
  return (
    <UnstyledButton className="m-pin" onClick={() => navigate({ page: "alerts", detail: { kind: "alert", id: a.id } })}>
      <LevelIcon level="crit" />
      <span className="m-pin-text">{a.text}</span>
      <span className="m-pin-age m-fig">{crit.length > 1 ? `+${crit.length - 1} · ` : ""}{dur(now - a.since)}</span>
    </UnstyledButton>
  );
}
