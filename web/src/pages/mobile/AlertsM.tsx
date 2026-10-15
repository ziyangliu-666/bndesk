import { useState, type ReactNode } from "react";
import { UnstyledButton } from "@mantine/core";
import { IconCircleCheck } from "@tabler/icons-react";
import { useStore } from "../../store";
import { useNow } from "../../hooks";
import { hm } from "../../format";
import { LevelIcon } from "../../components/ui";
import { ListRow, Section, useFreshness } from "../../components/mobile";
import type { Alert } from "../../protocol";
import { alertText, byUrgency, heldFor } from "./rules";
import "./ops.css";

/** Alerts, grouped by level: critical and warnings open, info and the cleared ones folded. Within a level the
 *  oldest comes first: what has held longest is not clearing on its own. Cleared ones newest first. */
export function AlertsM() {
  const alerts = useStore((s) => s.snap?.alerts) ?? [];
  const tz = useStore((s) => s.tz);
  const hide = useStore((s) => s.hideAmounts);
  const now = useNow(1000) + useStore.getState().skew;
  const { state } = useFreshness();

  const active = alerts.filter((a) => a.active);
  const crit = active.filter((a) => a.level === "crit").sort(byUrgency);
  const warn = active.filter((a) => a.level === "warn").sort(byUrgency);
  const info = active.filter((a) => a.level === "info").sort(byUrgency);
  const cleared = alerts.filter((a) => !a.active).sort(byUrgency);

  const row = (a: Alert) => (
    <ListRow
      key={a.id}
      className="m-ops-alert"
      lead={<LevelIcon level={a.level} size={18} />}
      title={alertText(a, hide)}
      subtitle={a.active ? `since ${hm(a.since, tz)}` : `${hm(a.since, tz)}, cleared`}
      primary={a.active ? <span className="m-fig m-ops-age">{heldFor(now - a.since)}</span> : undefined}
      to={{ page: "alerts", detail: { kind: "alert", id: a.id } }}
    />
  );

  return (
    <>
      {crit.length + warn.length === 0 && (
        <Section>
          <div className="m-ops-clear">
            <IconCircleCheck size={18} stroke={1.75} className="up" />
            <span>No active alerts</span>
            <span className="muted">· {CONN[state]}</span>
          </div>
        </Section>
      )}
      {crit.length > 0 && <Section title="Critical">{crit.map(row)}</Section>}
      {warn.length > 0 && <Section title="Warning">{warn.map(row)}</Section>}
      {info.length > 0 && <Folded title="Info" items={info} row={row} />}
      {cleared.length > 0 && <Folded title="Cleared today" items={cleared} row={row} />}
    </>
  );
}

const CONN = { connecting: "Connecting", live: "Live", lag: "Lagging", stale: "Stale", reconnecting: "Reconnecting" } as const;

/** A group that starts folded: its heading says how many, a tap shows them. */
function Folded({ title, items, row }: { title: string; items: Alert[]; row: (a: Alert) => ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <Section
      title={title}
      right={
        <UnstyledButton className="m-link m-ops-fold" onClick={() => setOpen(!open)} aria-expanded={open}>
          {open ? "Hide" : `Show ${items.length}`}
        </UnstyledButton>
      }
    >
      {open ? items.map(row) : null}
    </Section>
  );
}
