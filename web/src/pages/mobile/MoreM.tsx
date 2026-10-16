import { useStore } from "../../store";
import { useNow } from "../../hooks";
import { bps, int } from "../../format";
import { TextToggle, TvAttribution } from "../../components/ex";
import { feedSummary } from "./shared";
import { Row, Sec } from "./rest/ui";
import "./rest/ops.css";

/** More: the pages a phone needs less often, then the settings and the About lines. */
export function MoreM() {
  const nOrders = useStore((s) => s.snap?.orders.length ?? 0);
  const fillsDay = useStore((s) => s.snap?.summary.fills_day ?? 0);
  const markout = useStore((s) => s.snap?.summary.markout_net_bps_1h);
  const engines = useStore((s) => s.snap?.engines);
  const feeds = useStore((s) => s.snap?.feeds);
  const alerts = useStore((s) => s.snap?.alerts);
  const tz = useStore((s) => s.tz);
  const setTz = useStore((s) => s.setTz);
  const hide = useStore((s) => s.hideAmounts);
  const setHide = useStore((s) => s.setHideAmounts);
  const mock = import.meta.env.VITE_MOCK === "1";
  const now = useNow(5000) + useStore.getState().skew;

  // the feeds as the System page classifies them (up, silent, flapping, down)
  const fs = feeds ? feedSummary(feeds, now, alerts) : null;
  const running = (engines ?? []).filter((e) => e.up && !e.kill && e.state === "running").length;
  const warn = engines != null && running < engines.length;

  return (
    <>
      <Sec flush>
        <Row
          title="Analysis"
          sub="Markouts, by hour, by instrument"
          value={markout != null ? <span className="r-fig">{bps(markout)} bps</span> : undefined}
          valueSub={markout != null ? "10 s, last hour" : undefined}
          to={{ page: "analysis" }}
        />
        <Row title="Orders" sub="Open orders, quote map, rate limits" value={<span className="r-fig">{int(nOrders)}</span>} valueSub="open" to={{ page: "orders" }} />
        <Row
          title="System"
          sub="Engines and feeds"
          value={engines ? <span className={"r-fig" + (warn ? " warn-text" : "")}>{`${running} / ${engines.length}`}</span> : undefined}
          valueSub={fs ? <span className={fs.worst !== "ok" ? "warn-text" : ""}>feeds {fs.text}</span> : undefined}
          to={{ page: "system" }}
        />
        <Row title="All fills" sub="Newest first, by account" value={<span className="r-fig">{int(fillsDay)}</span>} valueSub="today" to={{ page: "fills" }} />
      </Sec>

      <Sec title="Settings">
        <div className="o-set">
          <span>Time zone</span>
          <TextToggle
            label="Time zone"
            value={tz}
            onChange={setTz}
            options={[
              { value: "utc", label: "UTC" },
              { value: "local", label: "Local" },
            ]}
          />
        </div>
        <div className="o-set">
          <span>
            Hide amounts
            <span className="o-set-sub">USD figures read •••</span>
          </span>
          <TextToggle
            label="Hide amounts"
            value={hide ? "on" : "off"}
            onChange={(v) => setHide(v === "on")}
            options={[
              { value: "off", label: "Off" },
              { value: "on", label: "On" },
            ]}
          />
        </div>
        {!mock && (
          <form method="post" action="/logout" className="o-set">
            <button type="submit" className="r-act o-logout">
              Log out
            </button>
          </form>
        )}
      </Sec>

      <Sec title="About">
        <div className="o-about">
          bndesk web {__APP_VERSION__} · built {__BUILT__} UTC
          {mock && " · simulated data"}
          <br />
          <TvAttribution />
        </div>
      </Sec>
    </>
  );
}
