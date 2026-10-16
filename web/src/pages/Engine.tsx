// System (was Engine): tabs Engines | Feeds | Alerts. Each engine is a section on the panel: its name and state,
// a row of label-over-value figures (no tiles), then rejects, latency and venue connections side by side.
import { useMemo, type ReactNode } from "react";
import { AgGridReact } from "ag-grid-react";
import type { ColDef, GetRowIdParams, ICellRendererParams } from "ag-grid-community";
import { IconAlertOctagon } from "@tabler/icons-react";
import { useStore } from "../store";
import type { Engine as EngineT, Feed } from "../protocol";
import { C } from "../theme";
import { gridTheme } from "../gridTheme";
import { int, num } from "../format";
import { StateTag } from "../components/ui";
import { fAge, DEFAULT_COL } from "../grid";
import { AlertsList, useAlertList } from "../components/AlertsList";
import { Tabs, TextToggle, useExPref } from "../components/ex";
import { Money } from "../mask";
import "./ops/ops.css";

function us(v: number | null): string {
  if (v == null) return "--";
  if (v >= 1000) return num(v / 1000, 2) + " ms";
  return num(v, 1) + " µs";
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
        <Pair label="Realized (USDT)" title="Realized PnL reported by the engine">
          <Money v={e.realized} sign />
        </Pair>
        <Pair label="Unrealized (USDT)" title="Unrealized PnL reported by the engine">
          <Money v={e.unrealized} sign />
        </Pair>
        <Pair label="Fees (USDT)" title="Fees paid">
          <Money v={e.fees} />
        </Pair>
        <Pair label="Max loss (USDT)" title="Loss limit that triggers the engine's kill">
          {e.max_loss == null ? "--" : <Money v={e.max_loss} />}
        </Pair>
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
                <td className="l">{l.name}</td>
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
    <div className="ops-panel ops-feeds">
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

type SysTab = "engines" | "feeds" | "alerts";
type AlertView = "active" | "hidden" | "cleared";

function Alerts() {
  const { active, hidden, cleared } = useAlertList();
  const [view, setView] = useExPref<AlertView>("system", "alerts", "active", ["active", "hidden", "cleared"]);
  return (
    <div className="ops-sys-alerts">
      <div className="ops-head ops-subhead">
        <TextToggle
          label="Alerts"
          value={view}
          onChange={setView}
          options={[
            { value: "active", label: `Active ${active.length}` },
            { value: "cleared", label: `Cleared today ${cleared.length}` },
            { value: "hidden", label: `Hidden ${hidden.length}`, title: "Hidden on this browser until they clear" },
          ]}
        />
      </div>
      <AlertsList bare filter={view} />
    </div>
  );
}

export function Engine() {
  const engines = useStore((s) => s.snap?.engines);
  const feeds = useStore((s) => s.snap?.feeds);
  const { active } = useAlertList();
  const [tab, setTab] = useExPref<SysTab>("system", "tab", "engines", ["engines", "feeds", "alerts"]);
  const down = feeds?.filter((f) => !f.up).length ?? 0;
  const engDown = engines?.filter((e) => !e.up || e.kill).length ?? 0;
  return (
    <div className="page ops-system">
      <div className="ops-tabbar">
        <Tabs
          value={tab}
          onChange={setTab}
          items={[
            { value: "engines", label: "Engines", count: engines ? (engDown ? `${engDown} down` : engines.length) : null },
            { value: "feeds", label: "Feeds", count: feeds ? (down ? `${down} down` : `${feeds.length}/${feeds.length}`) : null },
            { value: "alerts", label: "Alerts", count: active.length || null },
          ]}
        />
      </div>
      <div className={"ops-sys-body" + (tab === "feeds" ? " flush" : "")}>
        {tab === "engines" &&
          (engines?.length ? (
            engines.map((e) => <EngineSection key={e.name} e={e} />)
          ) : (
            <div className="ops-empty">{engines ? "No engine configured. Add an [[engines]] url to scrape Prometheus metrics." : "--"}</div>
          ))}
        {tab === "feeds" && <Feeds />}
        {tab === "alerts" && <Alerts />}
      </div>
    </div>
  );
}
