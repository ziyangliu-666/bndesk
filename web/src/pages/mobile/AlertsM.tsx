import { IconCircleCheck } from "@tabler/icons-react";
import { isHidden, useStore } from "../../store";
import { useNow } from "../../hooks";
import { hm } from "../../format";
import { LevelIcon } from "../../components/ui";
import { span, useFreshness } from "../../components/mobile";
import { useExPref } from "../../components/ex";
import type { Alert } from "../../protocol";
import { RULES, alertText, byUrgency } from "./rules";
import { Empty, PageTabs, Row, Sec } from "./rest/ui";
import "./rest/ops.css";

type Tab = "active" | "cleared" | "hidden";
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
          { value: "cleared", label: "Cleared today", count: cleared.length || null },
          { value: "hidden", label: "Hidden", count: hidden.length || null },
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
    </>
  );
}

function AlertRow({ a }: { a: Alert }) {
  const hide = useStore((s) => s.hideAmounts);
  const tz = useStore((s) => s.tz);
  const now = useNow(5000) + useStore.getState().skew;
  return (
    <Row
      className={"o-alert" + (a.active && a.level === "crit" ? " crit" : "")}
      lead={<LevelIcon level={a.level} size={18} />}
      title={RULES[a.rule]?.name ?? a.rule}
      sub={alertText(a, hide)}
      sub2
      value={<span className="o-alert-t r-fig">{a.active ? span(now - a.since) : hm(a.since, tz)}</span>}
      // a cleared alert: the time it was raised (the feed keeps no clearing time), said as such
      valueSub={a.active ? `since ${hm(a.since, tz)}` : "raised · cleared"}
      to={{ page: "alerts", detail: { kind: "alert", id: a.id } }}
    />
  );
}
