import { useStore } from "../store";
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

export function AlertsList() {
  const alerts = useStore((s) => s.snap?.alerts);
  const tz = useStore((s) => s.tz);
  const skew = useStore((s) => s.skew);
  const now = useNow(1000) + skew;
  const list = sortAlerts(alerts ?? []);
  return (
    <Panel
      className="alerts-panel"
      title="Alerts"
      bodyClass="alerts-body"
    >
      {list.length === 0 && <div className="empty">No alerts today</div>}
      <ul className="alerts">
        {list.map((a) => (
          <li key={a.id} className={"alert " + a.level + (a.active ? " active" : " cleared")} title={`${a.rule} since ${hms(a.since, tz)}`}>
            <LevelIcon level={a.level} />
            <span className="alert-text">
              <span className="alert-level">{a.level === "crit" ? "Critical" : a.level === "warn" ? "Warning" : "Info"}</span>
              {a.text}
            </span>
            <span className="alert-age fig" title={a.active ? "Time since the alert fired" : undefined}>{a.active ? dur(now - a.since) : "cleared"}</span>
          </li>
        ))}
      </ul>
    </Panel>
  );
}
