import { UnstyledButton } from "@mantine/core";
import { useShallow } from "zustand/react/shallow";
import { IconChevronLeft, IconEyeOff } from "@tabler/icons-react";
import { back, isSub, useStore, type Route } from "../../store";
import { hms } from "../../format";
import { reconnectNow } from "../../ws";
import { titleOf } from "../../pages/mobile";
import { StatusPill, useFreshness } from "./StatusPill";

/** Sticky top bar: the page title (below a tab's own page, the back chevron and the title are one button)
 *  and the status pill; while amounts are hidden, a button that shows them again; while the figures are
 *  stale, a line saying how old they are. */
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
        <StatusPill />
      </div>
      <AsOf />
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
