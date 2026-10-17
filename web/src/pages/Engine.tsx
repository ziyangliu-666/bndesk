// System (was Engine): the engines, then the feeds and the alerts side by side. Each engine is a section: its name and state,
// a row of label-over-value figures (no tiles), then rejects, latency and venue connections side by side.
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { AgGridReact } from "ag-grid-react";
import type { ColDef, GetRowIdParams, ICellRendererParams } from "ag-grid-community";
import { IconAlertOctagon } from "@tabler/icons-react";
import { useStore } from "../store";
import type { Engine as EngineT, Feed } from "../protocol";
import { C } from "../theme";
import { gridTheme } from "../gridTheme";
import { int, num, stepName } from "../format";
import { StateTag } from "../components/ui";
import { fAge, DEFAULT_COL } from "../grid";
import { AlertsList, useAlertList } from "../components/AlertsList";
import { TextToggle, useExPref } from "../components/ex";
import { Money } from "../mask";
import { RULES } from "./mobile/rules";
import "./ops/ops.css";

/** A latency in one unit down the page: µs (a decimal under 100 µs). */
function us(v: number | null): string {
  if (v == null) return "--";
  return num(v, v >= 100 ? 0 : 1) + " µs";
}

function Pair({ label, title, children, tone }: { label: string; title?: string; children: ReactNode; tone?: string }) {
  return (
    <div className="ops-pair" title={title}>
      <span className="ops-l">{label}</span>
      <span className={"ops-v fig" + (tone ? " " + tone : "")}>{children}</span>
    </div>
  );
}

function EngineSection({ e }: { e: EngineT }) {
  const stale = e.stale_s > 5;
  return (
    <section className={"ops-engine" + (e.kill ? " killed" : "")}>
      <div className="ops-engine-head">
        <span className="ops-engine-name">{e.name}</span>
        <span className="muted">{e.strategy}</span>
        <StateTag state={e.up ? e.state : "down"} />
        {e.kill && (
          <span className="ops-kill">
            <IconAlertOctagon size={14} color={C.crit} /> Kill active{e.kill_reason ? `: ${e.kill_reason}` : ""}
          </span>
        )}
        {stale && <span className="fig warn-text">metrics {num(e.stale_s, 1)} s old</span>}
      </div>
      {/* two groups, apart: what the engine did, then its money */}
      <div className="ops-engine-figs">
      <div className="ops-pairs">
        <Pair label="Orders" title="Orders sent by the engine (counter from its metrics)">{int(e.orders)}</Pair>
        <Pair label="Cancels" title="Cancels sent by the engine">{int(e.cancels)}</Pair>
        <Pair label="Fills" title="Fills received by the engine">{int(e.fills)}</Pair>
        <Pair label="Risk rejects" title="Orders the engine's risk checks refused" tone={e.risk_rejects ? "warn-text" : ""}>
          {int(e.risk_rejects)}
        </Pair>
        <Pair label="Venue rejects" title="Orders the exchange rejected" tone={e.venue_rejects ? "warn-text" : ""}>
          {int(e.venue_rejects)}
        </Pair>
      </div>
      <div className="ops-pairs">
        <Pair label="Realized" title="Realized PnL reported by the engine">
          <Money v={e.realized} sign />
        </Pair>
        <Pair label="Unrealized" title="Unrealized PnL reported by the engine">
          <Money v={e.unrealized} sign />
        </Pair>
        <Pair label="Fees" title="Fees paid today: a cost, signed as one (rebates are credited apart)">
          <Money v={e.fees == null ? null : -e.fees} sign color={false} />
        </Pair>
        <Pair label="Loss limit" title="The day's loss that triggers the engine's kill">
          {e.max_loss == null ? "--" : <Money v={e.max_loss} />}
        </Pair>
      </div>
      </div>
      <div className="ops-engine-tables">
        <table className="ops-table">
          <thead>
            <tr>
              <th className="l">Rejects by reason</th>
              <th title="Rejected orders since the engine started">Count</th>
            </tr>
          </thead>
          <tbody>
            {e.rejects.length === 0 && (
              <tr>
                <td className="l muted">None</td>
                <td />
              </tr>
            )}
            {e.rejects
              .slice()
              .sort((a, b) => b.count - a.count)
              .map((r) => (
                <tr key={r.reason}>
                  <td className="l">{r.reason}</td>
                  <td>{int(r.count)}</td>
                </tr>
              ))}
          </tbody>
        </table>
        <table className="ops-table">
          <thead>
            <tr>
              <th className="l">Latency</th>
              <th title="Median">p50</th>
              <th title="99th percentile">p99</th>
            </tr>
          </thead>
          <tbody>
            {e.latency.map((l) => (
              <tr key={l.name}>
                <td className="l">{stepName(l.name)}</td>
                <td>{us(l.p50_us)}</td>
                <td>{us(l.p99_us)}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <table className="ops-table">
          <thead>
            <tr>
              <th className="l">Venue</th>
              <th className="l">Market data</th>
              <th className="l">User</th>
              <th className="l">Order</th>
              <th title="Connection re-establishments">Reconnects</th>
              <th title="Rate-limit cooldowns entered">Cooldowns</th>
              <th title="REST requests that returned an error">REST errors</th>
            </tr>
          </thead>
          <tbody>
            {e.venues.map((v) => (
              <tr key={v.name}>
                <td className="l">{v.name}</td>
                <td className="l">
                  <StateTag state={v.md} />
                </td>
                <td className="l">
                  <StateTag state={v.user} />
                </td>
                <td className="l">
                  <StateTag state={v.order} />
                </td>
                <td>{int(v.reconnects)}</td>
                <td className={v.cooldowns ? "warn-text" : ""}>{int(v.cooldowns)}</td>
                <td>{int(v.rest_errors)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function UpCell(p: ICellRendererParams<Feed>) {
  return p.data ? <StateTag state={p.data.up ? "up" : "down"} /> : null;
}

const KIND = { public: "Public", user: "User", rest: "REST", engine: "Engine" } as const;

function Feeds() {
  const feeds = useStore((s) => s.snap?.feeds);
  // more rows than fit: the grid's foot fades until it is scrolled to its end, so the rows below read as there
  const box = useRef<HTMLDivElement>(null);
  const [more, setMore] = useState(false);
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const check = () => {
      const vp = el.querySelector<HTMLElement>(".ag-body-viewport");
      if (vp) setMore(vp.scrollTop + vp.clientHeight < vp.scrollHeight - 2);
    };
    const ro = new ResizeObserver(check);
    ro.observe(el);
    el.addEventListener("scroll", check, { capture: true, passive: true });
    const id = setInterval(check, 1000);
    check();
    return () => {
      ro.disconnect();
      el.removeEventListener("scroll", check, { capture: true });
      clearInterval(id);
    };
  }, []);
  const cols = useMemo<ColDef<Feed>[]>(
    () => [
      { field: "name", headerName: "Feed", headerTooltip: "Connection or poller the monitor runs", width: 240, cellClass: "sym" },
      {
        field: "kind",
        headerName: "Kind",
        headerTooltip: "Public market data, user data stream, REST poller or engine metrics",
        width: 90,
        valueFormatter: (p) => KIND[p.value as Feed["kind"]] ?? String(p.value),
      },
      { field: "up", headerName: "State", headerTooltip: "Connected or not", width: 90, cellRenderer: UpCell },
      { field: "msgs_per_s", headerName: "Msgs / s", headerTooltip: "Messages received per second", width: 90, type: "rightAligned", cellClass: "num", valueFormatter: (p) => num(p.value as number, 1) },
      { field: "last", headerName: "Last msg", headerTooltip: "Time since the last message", width: 90, type: "rightAligned", cellClass: "num", valueFormatter: fAge },
      { field: "detail", headerName: "Detail", headerTooltip: "Feed-specific state", flex: 1, minWidth: 160, cellClass: "muted", headerClass: "pad-left", cellStyle: { paddingLeft: "24px" } },
    ],
    [],
  );
  return (
    <div className={"ops-panel ops-feeds" + (more ? " more" : "")} ref={box}>
      <AgGridReact<Feed>
        theme={gridTheme}
        rowData={feeds ?? []}
        columnDefs={cols}
        defaultColDef={DEFAULT_COL}
        getRowId={rowIdFeed}
        suppressCellFocus
        tooltipShowDelay={300}
        overlayNoRowsTemplate="No feeds"
      />
    </div>
  );
}

const rowIdFeed = (p: GetRowIdParams<Feed>) => p.data.name;

type AlertView = "active" | "hidden" | "cleared";

/** Every check the desk runs with its state now, under the active alerts: what is clear is part of the answer. */
function Checks() {
  const alerts = useStore((s) => s.snap?.alerts);
  const rank = { crit: 2, warn: 1, info: 0 } as const;
  const by = new Map<string, keyof typeof rank>();
  for (const a of alerts ?? []) if (a.active && (!by.has(a.rule) || rank[a.level] > rank[by.get(a.rule)!])) by.set(a.rule, a.level);
  return (
    <div className="ops-checks">
      <div className="ops-checks-h">Checks now</div>
      {Object.entries(RULES).map(([k, r]) => {
        const lv = by.get(k);
        return (
          <div key={k} className="ops-check" title={r.means}>
            <span>{r.name}</span>
            <span className={lv === "crit" ? "crit-text" : lv === "warn" ? "warn-text" : lv ? "" : "muted"}>{lv === "crit" ? "Critical" : lv === "warn" ? "Warning" : lv ? "Info" : "Clear"}</span>
          </div>
        );
      })}
    </div>
  );
}

function Alerts() {
  const { active } = useAlertList();
  const [view, setView] = useExPref<AlertView>("system", "alerts", "active", ["active", "hidden", "cleared"]);
  return (
    <section className="ops-panel ops-sys-alerts">
      <header className="ops-head">
        <span className="ops-title">Alerts</span>
        <TextToggle
          label="Alerts"
          value={view}
          onChange={setView}
          options={[
            // a count only where it asks for something: the active alerts
            { value: "active", label: active.length ? `Active ${active.length}` : "Active" },
            { value: "cleared", label: "Cleared today" },
            { value: "hidden", label: "Hidden", title: "Hidden on this browser until they clear" },
          ]}
        />
      </header>
      <div className="ops-sys-scroll">
        <AlertsList bare filter={view} />
        {view === "active" && <Checks />}
      </div>
    </section>
  );
}

/** System on one screen: the engines on top (each a section of figures and tables), the feeds and the alerts
 *  side by side under them, filling the rest (tabs would leave most of the screen empty with two engines). */
export function Engine() {
  const engines = useStore((s) => s.snap?.engines);
  const feeds = useStore((s) => s.snap?.feeds);
  const down = feeds?.filter((f) => !f.up).length ?? 0;
  const engDown = engines?.filter((e) => !e.up || e.kill).length ?? 0;
  return (
    <div className="page ops-system">
      <section className="ops-panel ops-sys-engines">
        <header className="ops-head">
          <span className="ops-title">
            Engines {engDown > 0 && <span className="ops-count fig warn-text">{engDown} down</span>}
          </span>
          <span className="ops-head-right muted">Money in USDT</span>
        </header>
        <div className="ops-sys-scroll">
          {engines?.length ? (
            engines.map((e) => <EngineSection key={e.name} e={e} />)
          ) : (
            <div className="ops-empty">{engines ? "No engine configured. Add an [[engines]] url to scrape Prometheus metrics." : "--"}</div>
          )}
        </div>
      </section>
      <div className="ops-sys-lower">
        <section className="ops-panel">
          <header className="ops-head">
            <span className="ops-title">
              Feeds {down > 0 && <span className="ops-count fig warn-text">{down} down</span>}
            </span>
          </header>
          <Feeds />
        </section>
        <Alerts />
      </div>
    </div>
  );
}
