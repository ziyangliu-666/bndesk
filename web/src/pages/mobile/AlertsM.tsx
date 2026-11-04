import { IconCircleCheck } from "@tabler/icons-react";
import { isHidden, useStore } from "../../store";
import { useNow } from "../../hooks";
import { hm } from "../../format";
import { LevelIcon } from "../../components/ui";
import { showInfo, span, useFreshness } from "../../components/mobile";
import { useExPref } from "../../components/ex";
import type { Alert } from "../../protocol";
import { RULES, alertText, byUrgency } from "./rules";
import { Empty, PageTabs, Row, Sec } from "./rest/ui";
import "./rest/ops.css";
import { ruleApplies } from "../../desk";

type Tab = "active" | "cleared" | "hidden";

// ---- when an alert cleared ----
// The feed keeps no clearing time: an alert only turns inactive. This browser notes the first snapshot that shows
// an alert it saw active as cleared, and keeps that time (a day) so the lists can say when and after how long.
// An alert that cleared while bndesk was closed here has no such time; it is said by when it was raised.
const CLEARED_KEY = "bndesk.alertCleared";
const DAY = 86_400_000;
const seenActive = new Set<string>();
const alertKey = (a: Alert) => a.id + "@" + a.since;
let clearedAt: Record<string, number> = (() => {
  try {
    return JSON.parse(localStorage.getItem(CLEARED_KEY) ?? "{}") as Record<string, number>;
  } catch {
    return {};
  }
})();
function noteAlerts(alerts: Alert[] | undefined, now: number) {
  if (!alerts) return;
  let changed = false;
  for (const a of alerts) {
    const k = alertKey(a);
    if (a.active) seenActive.add(k);
    else if (seenActive.has(k) && clearedAt[k] == null) {
      clearedAt = { ...clearedAt, [k]: now };
      changed = true;
    }
  }
  if (!changed) return;
  for (const [k, t] of Object.entries(clearedAt)) if (t < now - DAY) delete clearedAt[k];
  try {
    localStorage.setItem(CLEARED_KEY, JSON.stringify(clearedAt));
  } catch {
    /* private mode: the times last as long as the page */
  }
}
noteAlerts(useStore.getState().snap?.alerts, Date.now() + useStore.getState().skew);
useStore.subscribe((s, prev) => {
  if (s.snap?.alerts !== prev.snap?.alerts) noteAlerts(s.snap?.alerts, Date.now() + s.skew);
});

/** When this browser saw the alert clear, or null (still active, or it cleared while bndesk was closed here). */
export const clearedTime = (a: Alert): number | null => (a.active ? null : (clearedAt[alertKey(a)] ?? null));

/** A cleared alert's state in words: "Cleared 13:49" over "after 4 min", or "Raised 13:45" over "now clear". */
export function clearedWords(a: Alert, tz: Parameters<typeof hm>[1]): [string, string] {
  const t = clearedTime(a);
  return t != null ? [`Cleared ${hm(t, tz)}`, `after ${span(t - a.since)}`] : [`Raised ${hm(a.since, tz)}`, "now clear"];
}
const CONN = { connecting: "Connecting", live: "Live", lag: "Lagging", stale: "Stale", reconnecting: "Reconnecting" } as const;

/** Alerts (the bell): Active | Cleared today | Hidden. Active: critical first, then warnings, then info, the
 *  oldest first within a level (what has held longest is not clearing on its own). Cleared: newest first. */
export function AlertsM() {
  const alerts = useStore((s) => s.snap?.alerts) ?? [];
  const keys = useStore((s) => s.hiddenAlerts);
  const [tab, setTab] = useExPref<Tab>("m-alerts", "tab", "active", ["active", "cleared", "hidden"]);
  const { state } = useFreshness();

  const hidden = alerts.filter((a) => isHidden(a, keys)).sort(byUrgency);
  const active = alerts.filter((a) => a.active && !isHidden(a, keys)).sort(byUrgency);
  const cleared = alerts.filter((a) => !a.active).sort((a, b) => b.since - a.since);
  const list = tab === "active" ? active : tab === "cleared" ? cleared : hidden;

  return (
    <>
      <PageTabs
        items={[
          { value: "active", label: "Active", count: active.length || null },
          { value: "cleared", label: "Cleared today" },
          { value: "hidden", label: "Hidden" },
        ]}
        value={tab}
        onChange={setTab}
      />
      <Sec flush>
        {list.map((a) => (
          <AlertRow key={a.id} a={a} />
        ))}
        {!list.length &&
          (tab === "active" ? (
            <div className="o-clear">
              <IconCircleCheck size={20} stroke={1.75} className="up" />
              <span>No active alerts</span>
              <span className="muted">· {CONN[state]}</span>
            </div>
          ) : (
            <Empty>{tab === "cleared" ? "Nothing cleared today" : "No alert hidden on this browser"}</Empty>
          ))}
        {tab === "hidden" && hidden.length > 0 && <p className="r-note o-note">Hidden on this browser until they clear: off the bell's count and the Desk.</p>}
      </Sec>
      {tab === "active" && <Watched alerts={alerts} />}
    </>
  );
}

/** Every check the desk runs, each with its state now: what is clear is as much the answer as what is not. A
 *  tap says what the check watches. */
function Watched({ alerts }: { alerts: Alert[] }) {
  const tz = useStore((s) => s.tz);
  // the latest cleared alert of each check, to say when it last held
  const last = new Map<string, Alert>();
  for (const a of alerts) if (!a.active && (!last.has(a.rule) || a.since > last.get(a.rule)!.since)) last.set(a.rule, a);
  const by = new Map<string, Alert["level"]>();
  const rank = { crit: 2, warn: 1, info: 0 } as const;
  for (const a of alerts) if (a.active && (!by.has(a.rule) || rank[a.level] > rank[by.get(a.rule)!])) by.set(a.rule, a.level);
  return (
    <Sec title="Checks" right="now">
      {Object.entries(RULES).filter(([k]) => ruleApplies(k)).map(([k, r]) => {
        const lv = by.get(k);
        const was = last.get(k);
        return (
          <Row
            key={k}
            dense
            title={r.name}
            value={
              <span className={lv === "crit" ? "crit-text" : lv === "warn" ? "warn-text" : lv ? "" : "muted"}>
                {lv === "crit" ? "Critical" : lv === "warn" ? "Warning" : lv ? "Info" : was ? checkCleared(was, tz) : "Quiet"}
              </span>
            }
            onClick={() => showInfo(r.name, r.means)}
          />
        );
      })}
    </Sec>
  );
}

/** A check's last alert, cleared: "Cleared 13:49", or "Cleared, raised 13:45" when the clearing was not seen here. */
function checkCleared(a: Alert, tz: Parameters<typeof hm>[1]): string {
  const t = clearedTime(a);
  return t != null ? `Cleared ${hm(t, tz)}` : `Cleared, raised ${hm(a.since, tz)}`;
}

function AlertRow({ a }: { a: Alert }) {
  const hide = useStore((s) => s.hideAmounts);
  const tz = useStore((s) => s.tz);
  const now = useNow(5000) + useStore.getState().skew;
  const [v, vs] = a.active ? [span(now - a.since), `since ${hm(a.since, tz)}`] : clearedWords(a, tz);
  return (
    <Row
      className={"o-alert" + (a.active && a.level === "crit" ? " crit" : "")}
      lead={<LevelIcon level={a.level} size={18} />}
      title={RULES[a.rule]?.name ?? a.rule}
      sub={alertText(a, hide)}
      sub2
      value={<span className="o-alert-t r-fig">{v}</span>}
      valueSub={vs}
      to={{ page: "alerts", detail: { kind: "alert", id: a.id } }}
    />
  );
}
