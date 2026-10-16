import { UnstyledButton } from "@mantine/core";
import { canHide, isHidden, useStore } from "../store";
import { useNow } from "../hooks";
import { dur, hms } from "../format";
import { LevelIcon, Panel } from "./ui";
import type { Alert } from "../protocol";

const rank = { crit: 0, warn: 1, info: 2 } as const;

export function sortAlerts(a: Alert[]): Alert[] {
  return a.slice().sort((x, y) => {
    if (x.active !== y.active) return x.active ? -1 : 1;
    if (rank[x.level] !== rank[y.level]) return rank[x.level] - rank[y.level];
    return y.since - x.since;
  });
}

/** Today's alerts: active first, the ones hidden on this browser after them, muted, then the cleared ones. */
export function AlertsList() {
  const alerts = useStore((s) => s.snap?.alerts);
  const keys = useStore((s) => s.hiddenAlerts);
  const hideAlert = useStore((s) => s.hideAlert);
  const showAlert = useStore((s) => s.showAlert);
  const tz = useStore((s) => s.tz);
  const skew = useStore((s) => s.skew);
  const now = useNow(1000) + skew;
  const sorted = sortAlerts(alerts ?? []);
  const list = sorted.filter((a) => a.active && !isHidden(a, keys)).concat(sorted.filter((a) => isHidden(a, keys)), sorted.filter((a) => !a.active));
  return (
    <Panel
      className="alerts-panel"
      title="Alerts"
      bodyClass="alerts-body"
    >
      {list.length === 0 && <div className="empty">No alerts today</div>}
      <ul className="alerts">
        {list.map((a) => {
          const hidden = isHidden(a, keys);
          return (
            <li
              key={a.id}
              className={"alert " + a.level + (a.active ? " active" : " cleared") + (hidden ? " hidden" : "")}
              title={`${a.rule} since ${hms(a.since, tz)}`}
            >
              <LevelIcon level={a.level} />
              <span className="alert-text">
                <span className="alert-level">{a.level === "crit" ? "Critical" : a.level === "warn" ? "Warning" : "Info"}</span>
                {hidden && <span className="alert-hidden">hidden</span>}
                {a.text}
              </span>
              <span className="alert-age fig" title={a.active ? "Time since the alert fired" : undefined}>{a.active ? dur(now - a.since) : "cleared"}</span>
              {hidden ? (
                <UnstyledButton className="alert-act" onClick={() => showAlert(a)} title="Show it in the banner again">
                  Show
                </UnstyledButton>
              ) : canHide(a) ? (
                <UnstyledButton className="alert-act" onClick={() => hideAlert(a)} title="Hide on this browser until it clears">
                  Hide
                </UnstyledButton>
              ) : (
                <span />
              )}
            </li>
          );
        })}
      </ul>
    </Panel>
  );
}
