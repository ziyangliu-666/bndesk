import { useMemo } from "react";
import { AgGridReact } from "ag-grid-react";
import type { ColDef, GetRowIdParams, ICellRendererParams } from "ag-grid-community";
import { IconAlertOctagon } from "@tabler/icons-react";
import { useStore } from "../store";
import type { Engine as EngineT, Feed } from "../protocol";
import { C, gridTheme } from "../theme";
import { int, num, pnl, usd } from "../format";
import { Num, Panel, StateTag } from "../components/ui";
import { fAge, DEFAULT_COL } from "../grid";
import { AlertsList } from "../components/AlertsList";

function us(v: number | null): string {
  if (v == null) return "—";
  if (v >= 1000) return num(v / 1000, 2) + " ms";
  return num(v, 1) + " µs";
}

function EngineCard({ e }: { e: EngineT }) {
  const stale = e.stale_s > 5;
  return (
    <Panel
      className={"engine-card" + (e.kill ? " killed" : "")}
      title={
        <span className="eng-title">
          {e.name}
          <span className="muted">{e.strategy}</span>
        </span>
      }
      right={
        <span className="eng-state">
          {e.kill && (
            <span className="kill">
              <IconAlertOctagon size={14} color={C.crit} /> Kill active{e.kill_reason ? `: ${e.kill_reason}` : ""}
            </span>
          )}
          <StateTag state={e.up ? e.state : "down"} />
          {stale && <span className="fig warn-text">metrics {num(e.stale_s, 1)} s old</span>}
        </span>
      }
      bodyClass="engine-body"
    >
      <div className="eng-figs fig">
        <div title="Orders sent by the engine (counter from its metrics)"><label>Orders</label>{int(e.orders)}</div>
        <div title="Cancels sent by the engine"><label>Cancels</label>{int(e.cancels)}</div>
        <div title="Fills received by the engine"><label>Fills</label>{int(e.fills)}</div>
        <div className={e.risk_rejects ? "warn-text" : ""} title="Orders the engine's risk checks refused">
          <label>Risk rejects</label>
          {int(e.risk_rejects)}
        </div>
        <div className={e.venue_rejects ? "warn-text" : ""} title="Orders the exchange rejected">
          <label>Venue rejects</label>
          {int(e.venue_rejects)}
        </div>
        <div title="Realized PnL reported by the engine, USDT">
          <label>Realized</label>
          <Num v={e.realized} text={pnl(e.realized)} />
          <span className="unit">USDT</span>
        </div>
        <div title="Unrealized PnL reported by the engine, USDT">
          <label>Unrealized</label>
          <Num v={e.unrealized} text={pnl(e.unrealized)} />
          <span className="unit">USDT</span>
        </div>
        <div title="Fees paid, USDT">
          <label>Fees</label>
          {usd(e.fees)}
          <span className="unit">USDT</span>
        </div>
        <div title="Loss limit that triggers the engine's kill, USDT">
          <label>Max loss</label>
          {e.max_loss == null ? "—" : usd(e.max_loss)}
          {e.max_loss != null && <span className="unit">USDT</span>}
        </div>
      </div>
      <div className="eng-tables">
        <table className="dtable fig">
          <thead>
            <tr><th className="l">Rejects by reason</th><th title="Rejected orders since the engine started">Count</th></tr>
          </thead>
          <tbody>
            {e.rejects.length === 0 && <tr><td className="l muted">none</td><td /></tr>}
            {e.rejects.slice().sort((a, b) => b.count - a.count).map((r) => (
              <tr key={r.reason}><td className="l">{r.reason}</td><td>{int(r.count)}</td></tr>
            ))}
          </tbody>
        </table>
        <table className="dtable fig">
          <thead>
            <tr><th className="l">Latency</th><th title="Median">p50</th><th title="99th percentile">p99</th></tr>
          </thead>
          <tbody>
            {e.latency.map((l) => (
              <tr key={l.name}><td className="l">{l.name}</td><td>{us(l.p50_us)}</td><td>{us(l.p99_us)}</td></tr>
            ))}
          </tbody>
        </table>
        <table className="dtable fig wide">
          <thead>
            <tr>
              <th className="l">Venue</th><th className="l">Market data</th><th className="l">User</th><th className="l">Order</th>
              <th title="Connection re-establishments">Reconnects</th>
              <th title="Rate-limit cooldowns entered">Cooldowns</th>
              <th title="REST requests that returned an error">REST errors</th>
            </tr>
          </thead>
          <tbody>
            {e.venues.map((v) => (
              <tr key={v.name}>
                <td className="l">{v.name}</td>
                <td className="l"><StateTag state={v.md} /></td>
                <td className="l"><StateTag state={v.user} /></td>
                <td className="l"><StateTag state={v.order} /></td>
                <td>{int(v.reconnects)}</td>
                <td className={v.cooldowns ? "warn-text" : ""}>{int(v.cooldowns)}</td>
                <td>{int(v.rest_errors)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="muted eng-url">{e.url}</div>
    </Panel>
  );
}

function UpCell(p: ICellRendererParams<Feed>) {
  return p.data ? <StateTag state={p.data.up ? "up" : "down"} /> : null;
}

function Feeds() {
  const feeds = useStore((s) => s.snap?.feeds);
  const cols = useMemo<ColDef<Feed>[]>(
    () => [
      { field: "name", headerName: "Feed", headerTooltip: "Connection or poller the monitor runs", width: 220, cellClass: "sym" },
      { field: "kind", headerName: "Kind", headerTooltip: "public market data, user data stream, REST poller or engine metrics", width: 80 },
      { field: "up", headerName: "State", headerTooltip: "Connected or not", width: 84, cellRenderer: UpCell },
      { field: "msgs_per_s", headerName: "Msgs / s", headerTooltip: "Messages received per second", width: 84, type: "rightAligned", cellClass: "num", valueFormatter: (p) => num(p.value as number, 1) },
      { field: "last", headerName: "Last msg", headerTooltip: "Time since the last message", width: 84, type: "rightAligned", cellClass: "num", valueFormatter: fAge },
      { field: "detail", headerName: "Detail", headerTooltip: "Feed-specific state", flex: 1, minWidth: 160, cellClass: "muted", headerClass: "pad-left", cellStyle: { paddingLeft: "24px" } },
    ],
    [],
  );
  const down = feeds?.filter((f) => !f.up).length ?? 0;
  return (
    <Panel
      className="feeds-panel"
      title="Monitor feeds"
      right={down ? <span className="fig warn-text">{down} down</span> : undefined}
      bodyClass="grid-body"
    >
      <AgGridReact<Feed>
        theme={gridTheme}
        rowData={feeds ?? []}
        columnDefs={cols}
        defaultColDef={DEFAULT_COL}
        getRowId={rowIdFeed}
        domLayout="autoHeight"
        suppressCellFocus
        tooltipShowDelay={300}
      />
    </Panel>
  );
}

const rowIdFeed = (p: GetRowIdParams<Feed>) => p.data.name;

export function Engine() {
  const engines = useStore((s) => s.snap?.engines);
  return (
    <div className="page engine">
      <div className="engines">
        {engines?.length ? (
          engines.map((e) => <EngineCard key={e.name} e={e} />)
        ) : (
          <Panel title="Engines">
            <div className="empty">No engine configured. Add an [[engines]] url to scrape Prometheus metrics.</div>
          </Panel>
        )}
      </div>
      <div className="eng-bottom">
        <Feeds />
        <AlertsList />
      </div>
    </div>
  );
}
