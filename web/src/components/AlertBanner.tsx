import { useEffect, useState } from "react";
import { UnstyledButton } from "@mantine/core";
import { isHidden, useStore } from "../store";
import { useNow } from "../hooks";
import { dur, hms } from "../format";
import { LevelIcon } from "./ui";
import { sortAlerts } from "./AlertsList";

const SHOWN = 3;

/** Active warnings and critical alerts, under the nav, one quiet 28 px line each (the level's icon in its colour,
 *  the text, its age and Hide at the right); absent when there are none. A warning can be hidden on this browser
 *  until it clears; the hidden ones leave the banner and the title's count. */
export function AlertBanner() {
  const alerts = useStore((s) => s.snap?.alerts);
  const keys = useStore((s) => s.hiddenAlerts);
  const hideAlert = useStore((s) => s.hideAlert);
  const showAll = useStore((s) => s.showAllAlerts);
  const tz = useStore((s) => s.tz);
  const skew = useStore((s) => s.skew);
  const now = useNow(1000) + skew;
  const [open, setOpen] = useState(false);
  const all = (alerts ?? []).filter((a) => a.active && a.level !== "info");
  const live = sortAlerts(all.filter((a) => !isHidden(a, keys)));
  const n = live.length;
  const hidden = all.length - n;

  useEffect(() => {
    document.title = n ? `(${n}) bndesk` : "bndesk";
  }, [n]);
  useEffect(() => {
    if (n <= SHOWN) setOpen(false);
  }, [n]);

  if (!n && !hidden) return null;
  const shown = open ? live : live.slice(0, SHOWN);
  return (
    <div className="alert-banner" role={n ? "alert" : undefined}>
      {shown.map((a) => (
        <div key={a.id} className={"ab-row " + a.level} title={`${a.rule}, since ${hms(a.since, tz)}`}>
          <LevelIcon level={a.level} />
          <span className="ab-text">{a.text}</span>
          <span className="ab-age fig">{dur(now - a.since)}</span>
          {a.level !== "crit" ? (
            <UnstyledButton className="ab-hide" onClick={() => hideAlert(a)} title="Hide on this browser until it clears">
              Hide
            </UnstyledButton>
          ) : (
            <span />
          )}
        </div>
      ))}
      {(n > SHOWN || hidden > 0) && (
        <div className="ab-foot">
          {n > SHOWN && (
            <UnstyledButton className="ab-more" onClick={() => setOpen(!open)}>
              {open ? "Show fewer" : `+${n - SHOWN} more`}
            </UnstyledButton>
          )}
          {hidden > 0 && (
            <UnstyledButton className="ab-more" onClick={showAll} title="Show the alerts hidden on this browser">
              {hidden} hidden
            </UnstyledButton>
          )}
        </div>
      )}
    </div>
  );
}
