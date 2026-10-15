import { UnstyledButton } from "@mantine/core";
import { IconLogout } from "@tabler/icons-react";
import { useStore } from "../../store";
import { useNow } from "../../hooks";
import { int } from "../../format";
import { ListRow, Section, Segmented } from "../../components/mobile";
import { Bps, feedSummary } from "./shared";

/** More: the pages a phone needs less often, then the settings. */
export function MoreM() {
  const nOrders = useStore((s) => s.snap?.orders.length ?? 0);
  const fillsDay = useStore((s) => s.snap?.summary.fills_day ?? 0);
  const markout = useStore((s) => s.snap?.summary.markout_net_bps_1h);
  const engines = useStore((s) => s.snap?.engines);
  const feeds = useStore((s) => s.snap?.feeds);
  const tz = useStore((s) => s.tz);
  const setTz = useStore((s) => s.setTz);
  const hide = useStore((s) => s.hideAmounts);
  const setHide = useStore((s) => s.setHideAmounts);
  const mock = import.meta.env.VITE_MOCK === "1";

  const alerts = useStore((s) => s.snap?.alerts);
  const now = useNow(5000) + useStore.getState().skew;
  // the feeds as the Engine page classifies them (up, silent, flapping, down)
  const fs = feeds ? feedSummary(feeds, now, alerts) : null;
  const running = (engines ?? []).filter((e) => e.up && !e.kill && e.state === "running").length;
  const enginesLine = engines ? `${running} of ${engines.length} running` : "";
  const feedsLine = fs ? `feeds ${fs.text}` : undefined;
  const healthTone = (engines && running < engines.length) || (fs && fs.worst !== "ok") ? "warn" : undefined;

  return (
    <>
      <Section>
        <ListRow
          dense
          title="Markouts"
          subtitle="10 s, last hour"
          primary={markout != null ? <Bps v={markout} /> : undefined}
          to={{ page: "markouts" }}
        />
        <ListRow dense title="Orders" primary={<>{int(nOrders)} open</>} to={{ page: "orders" }} />
        <ListRow
          dense
          title="Engine"
          tone={healthTone}
          subtitle={feedsLine}
          primary={<span className={healthTone ? "warn-text" : ""}>{enginesLine}</span>}
          to={{ page: "engine" }}
        />
        <ListRow dense title="All fills" primary={<>{int(fillsDay)} today</>} to={{ page: "fills" }} />
      </Section>

      <Section title="Settings">
        <div className="m-set">
          <span className="m-set-label">
            Time zone
          </span>
          <Segmented
            value={tz}
            onChange={setTz}
            data={[
              { value: "utc", label: "UTC" },
              { value: "local", label: "Local" },
            ]}
            label="Time zone"
          />
        </div>
        <div className="m-set">
          <span className="m-set-label">
            Hide amounts
            <small>USD figures read •••</small>
          </span>
          <Segmented
            value={hide ? "on" : "off"}
            onChange={(v) => setHide(v === "on")}
            data={[
              { value: "off", label: "Off" },
              { value: "on", label: "On" },
            ]}
            label="Hide amounts"
          />
        </div>
        {!mock && (
          <form method="post" action="/logout">
            <UnstyledButton component="button" type="submit" className="m-set danger">
              <span className="m-set-label">Log out</span>
              <IconLogout size={20} stroke={1.75} />
            </UnstyledButton>
          </form>
        )}
      </Section>

      <div className="m-version">
        bndesk web {__APP_VERSION__} · built {__BUILT__} UTC
        {mock && " · simulated data"}
      </div>
    </>
  );
}
