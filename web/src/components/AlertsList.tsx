import { UnstyledButton } from "@mantine/core";
import { canHide, isHidden, useStore } from "../store";
import { useNow } from "../hooks";
import { dur, hms } from "../format";
import { LevelIcon, Panel } from "./ui";
import type { Alert } from "../protocol";
import "./alerts.css";

const rank = { crit: 0, warn: 1, info: 2 } as const;
const LEVEL = { crit: "Critical", warn: "Warning", info: "Info" } as const;

export function sortAlerts(a: Alert[]): Alert[] {
  return a.slice().sort((x, y) => {
    if (x.active !== y.active) return x.active ? -1 : 1;
    if (rank[x.level] !== rank[y.level]) return rank[x.level] - rank[y.level];
    return y.since - x.since;
  });
}

/** Today's alerts in the order the list shows them: active first, the ones hidden on this browser after them,
 *  then the cleared ones. */
export function useAlertList() {
  const alerts = useStore((s) => s.snap?.alerts);
  const keys = useStore((s) => s.hiddenAlerts);
  const sorted = sortAlerts(alerts ?? []);
  const active = sorted.filter((a) => a.active && !isHidden(a, keys));
  const hidden = sorted.filter((a) => isHidden(a, keys));
  const cleared = sorted.filter((a) => !a.active);
  return { active, hidden, cleared, keys };
}

/**
 * Today's alerts: active first, the ones hidden on this browser after them, muted, then the cleared ones.
 * Default: a panel titled "Alerts" with one-line rows. `bare`: no panel head (a tab names it), and each row as a
 * notification: level icon, the text, under it the level, the rule and the time it fired, the age and Hide at the
 * right. `filter` keeps one group.
 */
export function AlertsList({ bare = false, filter }: { bare?: boolean; filter?: "active" | "hidden" | "cleared" } = {}) {
  const { active, hidden: hid, cleared, keys } = useAlertList();
  const hideAlert = useStore((s) => s.hideAlert);
  const showAlert = useStore((s) => s.showAlert);
  const tz = useStore((s) => s.tz);
  const skew = useStore((s) => s.skew);
  const now = useNow(1000) + skew;
  const list = filter === "active" ? active : filter === "hidden" ? hid : filter === "cleared" ? cleared : active.concat(hid, cleared);
  const empty = filter === "hidden" ? "No hidden alerts" : filter === "cleared" ? "No alerts cleared today" : filter === "active" ? "No active alerts" : "No alerts today";
  const rows = (
    <>
      {list.length === 0 && <div className="empty">{empty}</div>}
      <ul className={"alerts" + (bare ? " alerts-bare" : "")}>
        {list.map((a) => {
          const hidden = isHidden(a, keys);
          const act = hidden ? (
            <UnstyledButton className="alert-act" onClick={() => showAlert(a)} title="Show it in the banner again">
              Show
            </UnstyledButton>
          ) : canHide(a) ? (
            <UnstyledButton className="alert-act" onClick={() => hideAlert(a)} title="Hide on this browser until it clears">
              Hide
            </UnstyledButton>
          ) : (
            <span />
          );
          const age = (
            <span className="alert-age fig" title={a.active ? "Time since the alert fired" : undefined}>
              {a.active ? dur(now - a.since) : "cleared"}
            </span>
          );
          if (bare)
            return (
              <li key={a.id} className={"alert " + a.level + (a.active ? " active" : " cleared") + (hidden ? " hidden" : "")}>
                <LevelIcon level={a.level} />
                <span className="alert-main">
                  <span className="alert-text">{a.text}</span>
                  <span className="alert-meta fig">
                    <span className="alert-level">{LEVEL[a.level]}</span>
                    {hidden && <span>hidden here</span>}
                    <span>{a.rule}</span>
                    <span>since {hms(a.since, tz)}</span>
                  </span>
                </span>
                {age}
                {act}
              </li>
            );
          return (
            <li
              key={a.id}
              className={"alert " + a.level + (a.active ? " active" : " cleared") + (hidden ? " hidden" : "")}
              title={`${a.rule} since ${hms(a.since, tz)}`}
            >
              <LevelIcon level={a.level} />
              <span className="alert-text">
                <span className="alert-level">{LEVEL[a.level]}</span>
                {hidden && <span className="alert-hidden">hidden</span>}
                {a.text}
              </span>
              {age}
              {act}
            </li>
          );
        })}
      </ul>
    </>
  );
  if (bare) return rows;
  return (
    <Panel className="alerts-panel" title="Alerts" bodyClass="alerts-body">
      {rows}
    </Panel>
  );
}
