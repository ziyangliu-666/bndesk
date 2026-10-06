import { useEffect, useState } from "react";
import { UnstyledButton } from "@mantine/core";
import { useStore } from "../store";
import { useNow } from "../hooks";
import { dur, hms } from "../format";
import { LevelIcon } from "./ui";
import { sortAlerts } from "./AlertsList";

const SHOWN = 3;

/** Active warnings and critical alerts, under the header; absent when there are none. */
export function AlertBanner() {
  const alerts = useStore((s) => s.snap?.alerts);
  const tz = useStore((s) => s.tz);
  const skew = useStore((s) => s.skew);
  const now = useNow(1000) + skew;
  const [open, setOpen] = useState(false);
  const live = sortAlerts((alerts ?? []).filter((a) => a.active && a.level !== "info"));
  const n = live.length;

  useEffect(() => {
    document.title = n ? `(${n}) bndesk` : "bndesk";
  }, [n]);
  useEffect(() => {
    if (n <= SHOWN) setOpen(false);
  }, [n]);

  if (!n) return null;
  const shown = open ? live : live.slice(0, SHOWN);
  return (
    <div className="alert-banner" role="alert">
      {shown.map((a) => (
        <div key={a.id} className={"ab-row " + a.level} title={`${a.rule}, since ${hms(a.since, tz)}`}>
          <LevelIcon level={a.level} />
          <span className="ab-text">{a.text}</span>
          <span className="ab-age fig">{dur(now - a.since)}</span>
        </div>
      ))}
      {n > SHOWN && (
        <UnstyledButton className="ab-more" onClick={() => setOpen(!open)}>
          {open ? "Show fewer" : `+${n - SHOWN} more`}
        </UnstyledButton>
      )}
    </div>
  );
}
