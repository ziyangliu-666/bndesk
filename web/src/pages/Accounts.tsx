import { useMediaQuery } from "@mantine/hooks";
import { useCallback, useMemo, useRef } from "react";
import type uPlot from "uplot";
import { AgGridReact } from "ag-grid-react";
import type { ColDef, GetRowIdParams } from "ag-grid-community";
import { useStore } from "../store";
import { hm, pnl, usd, bps, hms, dur } from "../format";
import { ACCOUNT_SERIES, C, S1, S2, gridTheme } from "../theme";
import { AXIS_FONT, UPlot, tooltipPlugin } from "../components/UPlot";
import { timeAxis, usdAxis, usdTicks } from "../components/DayChart";
import { AccountsGrid } from "../components/AccountsGrid";
import { Legend, Num, Panel } from "../components/ui";
import { fPnl, fPrice, fQtyS, flexCols, signCls, DEFAULT_COL } from "../grid";
import type { HedgeLeg, Position } from "../protocol";
import { HedgeBridge } from "../components/HedgeBridge";
import { useNow } from "../hooks";

type PosRow = Position & { account: string };

function Positions() {
  const accounts = useStore((s) => s.snap?.accounts);
  const rows = useMemo<PosRow[]>(
    () => accounts?.flatMap((a) => a.positions.map((p) => ({ ...p, account: a.id }))) ?? [],
    [accounts],
  );
  const cols = useMemo<ColDef<PosRow>[]>(() => {
    const n = (c: ColDef<PosRow>): ColDef<PosRow> => ({ type: "rightAligned", cellClass: "num", ...c });
    return [
      { field: "account", headerName: "Account", headerTooltip: "Account holding the position", width: 70 },
      { field: "symbol", headerName: "Perp", headerTooltip: "USD-M perpetual", width: 96, cellClass: "sym" },
      n({ field: "amt", headerName: "Amount", headerTooltip: "Position size, base-asset units; negative = short", width: 84, valueFormatter: fQtyS, cellClass: signCls }),
      n({ field: "notional", headerName: "Notional", headerTooltip: "Amount × mark, USDT", width: 84, valueFormatter: fPnl, cellClass: signCls }),
      n({ field: "entry", headerName: "Entry", headerTooltip: "Average entry price, USDT", width: 84, valueFormatter: fPrice }),
      n({ field: "mark", headerName: "Mark", headerTooltip: "Mark price, USDT", width: 84, valueFormatter: fPrice }),
      n({ field: "upnl", headerName: "uPnL", headerTooltip: "Unrealized PnL at mark against the entry price, USDT. Not today's result: see Today", width: 80, valueFormatter: fPnl, cellClass: signCls }),
      n({ field: "pnl_day", headerName: "Today", headerTooltip: "Today's P&L on the symbol: the position held at the day start and today's fills marked to mark now, minus fees, plus funding, USDT", width: 80, valueFormatter: fPnl, cellClass: signCls }),
    ];
  }, []);
  const fitted = useMemo(() => flexCols(cols), [cols]);
  return (
    <Panel className="pos-panel" title="Futures positions" bodyClass="grid-body">
      <AgGridReact<PosRow>
        theme={gridTheme}
        rowData={rows}
        columnDefs={fitted}
        defaultColDef={DEFAULT_COL}
        getRowId={rowIdPos}
        suppressCellFocus
        tooltipShowDelay={300}
        overlayNoRowsTemplate="No futures positions"
      />
    </Panel>
  );
}

function ExposurePanel() {
  const x = useStore((s) => s.snap?.exposure);
  const tz = useStore((s) => s.tz);
  const skew = useStore((s) => s.skew);
  const now = useNow(1000) + skew;
  const title = (
    <>
      Exposure <span className="title-unit">USDT</span>
    </>
  );
  if (!x) return <Panel className="exp-panel" title={title}>—</Panel>;
  const over = x.gap != null && x.band != null && Math.abs(x.gap) > x.band;
  return (
    <Panel
      className="exp-panel"
      title={title}
      right={
        x.target != null ? (
          x.paused ? (
            <span className={"fig " + (over ? "warn-text" : "muted")} title="Hedge off: target 0; the hedge still open is to be closed">
              {x.paused}
              {x.paused_until != null && ` until ${hm(x.paused_until, tz)}`}
            </span>
          ) : (
            <span
              className={"head-items fig " + (over ? "warn-text" : "muted")}
              title={`Hedge target: −${x.ratio} × beta-weighted spot value; band: allowed |gap|, USDT. ` +
                (x.beta_source === "estimate" ? "β: the desk's own estimate, may differ from the engine's." : "β: configured per market.")}
            >
              <span>target {pnl(x.target)}</span>
              <span>band ±{usd(x.band)}</span>
            </span>
          )
        ) : undefined
      }
      bodyClass="scroll-body"
    >
      <table className="dtable fig">
        <thead>
          <tr>
            <th className="l">Account</th>
            <th title="Spot inventory value at mid, USDT">Spot value</th>
            <th title="Futures net notional, signed, USDT">Futures notional</th>
            <th title="Spot value + futures notional, USDT">Net</th>
          </tr>
        </thead>
        <tbody>
          {x.by_account.map((r) => (
            <tr key={r.account}>
              <td className="l">{r.account}</td>
              <td>{usd(r.spot_value)}</td>
              <td><Num v={r.futures_notional} text={pnl(r.futures_notional)} /></td>
              <td><Num v={r.net} text={pnl(r.net)} /></td>
            </tr>
          ))}
          <tr className="total">
            <td className="l">Total</td>
            <td>{usd(x.spot_value)}</td>
            <td><Num v={x.futures_notional} text={pnl(x.futures_notional)} /></td>
            <td><Num v={x.net} text={pnl(x.net)} /></td>
          </tr>
          {x.gap != null && (
            <>
              <tr>
                <td className="l" title="Beta-weighted spot value and hedge symbols' futures notional, USDT">Hedge</td>
                <td>{usd(x.beta_value)}</td>
                <td><Num v={x.hedge_notional} text={pnl(x.hedge_notional)} /></td>
                <td />
              </tr>
              <tr className={over ? "warn-row" : ""}>
                <td className="l" title={x.paused ? "Hedge off: futures notional still open, to be closed, USDT" : "Target − hedge futures notional: the trade that closes the gap, USDT"}>
                  {x.paused ? "To close" : "Gap vs target"}
                </td>
                <td />
                <td />
                <td><Num v={x.gap} text={pnl(x.gap)} /></td>
              </tr>
            </>
          )}
        </tbody>
      </table>
      {x.funding.length > 0 && (
        <table className="dtable fig">
          <thead>
            <tr>
              <th className="l">Funding</th>
              <th title="Position size, base-asset units">Position</th>
              <th title="Current funding rate per interval, bps">Rate</th>
              <th title="Next funding time and time left">Next</th>
            </tr>
          </thead>
          <tbody>
            {x.funding.map((f) => (
              <tr key={f.symbol}>
                <td className="l">{f.symbol}</td>
                <td><Num v={f.position} text={(f.position > 0 ? "+" : f.position < 0 ? "−" : "") + Math.abs(f.position).toFixed(4)} /></td>
                <td>{f.rate == null ? "—" : bps(f.rate * 1e4) + " bps"}</td>
                <td>{f.next == null ? "—" : `${hms(f.next, tz)} (${dur(f.next - now)})`}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Panel>
  );
}

const pct = (v: number | null) => (v == null ? "—" : `${Math.round(v * 100)} %`);

const rowIdLeg = (p: GetRowIdParams<HedgeLeg>) => p.data.symbol;

function HedgePanel() {
  const h = useStore((s) => s.snap?.exposure.hedge_day);
  const cols = useMemo<ColDef<HedgeLeg>[]>(() => {
    const n = (c: ColDef<HedgeLeg>): ColDef<HedgeLeg> => ({ type: "rightAligned", cellClass: "num", ...c });
    return [
      { field: "symbol", headerName: "Leg", headerTooltip: "Futures hedge leg", width: 96, cellClass: "sym" },
      n({ field: "qty0", headerName: "Start", headerTooltip: "Position at the day start, base-asset units", width: 72, valueFormatter: fQtyS, cellClass: signCls }),
      n({ field: "qty", headerName: "Now", headerTooltip: "Position now, base-asset units", width: 72, valueFormatter: fQtyS, cellClass: signCls }),
      n({ field: "fills", headerName: "Fills", headerTooltip: "Futures fills today", width: 56 }),
      n({ field: "mark0", headerName: "Mark open", headerTooltip: "Mark price at the day start, USDT", width: 84, valueFormatter: fPrice }),
      n({ field: "mark", headerName: "Mark", headerTooltip: "Mark price now, USDT", width: 84, valueFormatter: fPrice }),
      n({ colId: "fees", headerName: "Fees", headerTooltip: "Fees today, a cost, USDT", width: 64, valueGetter: (p) => (p.data ? -p.data.fees : null), valueFormatter: fPnl, cellClass: signCls }),
      n({ field: "pnl", headerName: "Today", headerTooltip: "Price P&L at mark − fees + funding, USDT", width: 76, valueFormatter: fPnl, cellClass: signCls }),
    ];
  }, []);
  const fitted = useMemo(() => flexCols(cols), [cols]);
  return (
    <Panel
      className="hedge-panel"
      title={
        <span title="Since the day start: what the spot inventory made on its references (drift), against what the futures legs made">
          Inventory and hedge, today
        </span>
      }
      right={
        h ? (
          <span className="muted fig" title={`Hedge over the drift it offsets; of the beta part: ${pct(h.offset_factor)}`}>
            offset {pct(h.offset_total)}
          </span>
        ) : undefined
      }
      bodyClass="hedge-body"
    >
      {h ? (
        <>
          <HedgeBridge h={h} />
          {h.legs.length > 0 && (
            <div className="hedge-legs">
              <AgGridReact<HedgeLeg>
                theme={gridTheme}
                rowData={h.legs}
                columnDefs={fitted}
                defaultColDef={DEFAULT_COL}
                getRowId={rowIdLeg}
                suppressCellFocus
                tooltipShowDelay={300}
              />
            </div>
          )}
        </>
      ) : (
        <div className="muted empty-note">No hedge data yet</div>
      )}
    </Panel>
  );
}

interface Line {
  key: "equity" | "pnl_day" | "inventory" | "futures_notional";
  label: string;
  color: string;
  signed: boolean;
}

function SeriesChart({ title, lines }: { title: string; lines: Line[] }) {
  const series = useStore((s) => s.snap?.series);
  const tz = useStore((s) => s.tz);
  const data = useMemo<uPlot.AlignedData>(() => {
    const pts = series ?? [];
    return [pts.map((p) => p.t / 1000), ...lines.map((l) => pts.map((p) => p[l.key]))];
  }, [series, lines]);
  const options = useCallback(
    (width: number, height: number): uPlot.Options => ({
      width,
      height,
      padding: [8, 12, 0, 0],
      legend: { show: false },
      cursor: { y: false, points: { size: 8, width: 2, stroke: C.panel }, drag: { x: false, y: false } },
      scales: {
        x: { time: false },
        y: {
          range: (_u, min, max) => {
            const pad = Math.max(1, (max - min) * 0.08);
            return [min - pad, max + pad];
          },
        },
      },
      axes: [
        timeAxis(tz),
        usdAxis({ values: usdTicks(lines[0]!.signed) }),
      ],
      series: [{}, ...lines.map((l) => ({ label: l.label, stroke: l.color, width: 2, points: { show: false } }))],
      plugins: [
        tooltipPlugin((u, i) => {
          const t = u.data[0][i];
          if (t == null) return null;
          return {
            title: hm(t * 1000, tz),
            rows: lines.map((l, k) => ({
              color: l.color,
              label: l.label,
              value: (l.signed ? pnl(u.data[k + 1]![i] ?? null) : usd(u.data[k + 1]![i] ?? null)) + " USDT",
            })),
          };
        }),
      ],
    }),
    [tz, lines],
  );
  return (
    <Panel
      className="series-panel"
      title={
        <>
          {title} <span className="title-unit">USDT</span>
        </>
      }
      right={lines.length > 1 ? <Legend items={lines.map((l) => ({ color: l.color, label: l.label }))} /> : undefined}
      bodyClass="chart-body"
    >
      {series && <UPlot options={options} data={data} />}
    </Panel>
  );
}

/** Zero line, and each account's latest day PnL at its line end, labels spread apart with leader lines. */
function endLabels(names: () => string[]): uPlot.Plugin {
  return {
    hooks: {
      draw: (u) => {
        const ctx = u.ctx;
        const dpr = devicePixelRatio;
        const { top, height, left, width } = u.bbox;
        const y0 = Math.round(u.valToPos(0, "y", true)) + 0.5;
        ctx.save();
        if (y0 > top && y0 < top + height) {
          ctx.strokeStyle = "#4a5870";
          ctx.lineWidth = dpr;
          ctx.beginPath();
          ctx.moveTo(left, y0);
          ctx.lineTo(left + width, y0);
          ctx.stroke();
        }
        const ns = names();
        const ends: { k: number; x: number; y: number; v: number }[] = [];
        for (let k = 1; k < u.data.length; k++) {
          const ys = u.data[k]!;
          for (let i = ys.length - 1; i >= 0; i--) {
            const v = ys[i];
            if (v != null) {
              ends.push({ k, x: u.valToPos(u.data[0][i]!, "x", true), y: u.valToPos(v, "y", true), v });
              break;
            }
          }
        }
        ends.sort((a, b) => a.y - b.y);
        const gap = 14 * dpr;
        const ly = ends.map((e) => e.y);
        for (let i = 1; i < ly.length; i++) ly[i] = Math.max(ly[i]!, ly[i - 1]! + gap);
        const over = ly.length ? ly[ly.length - 1]! - (top + height - 4 * dpr) : 0;
        if (over > 0) for (let i = 0; i < ly.length; i++) ly[i] = ly[i]! - over;
        for (let i = ly.length - 2; i >= 0; i--) ly[i] = Math.min(ly[i]!, ly[i + 1]! - gap);
        ctx.font = AXIS_FONT.replace("11px", `${11 * dpr}px`);
        ctx.textBaseline = "middle";
        ctx.textAlign = "left";
        const lx = left + width + 10 * dpr;
        ends.forEach((e, i) => {
          const y = ly[i]!;
          ctx.strokeStyle = ACCOUNT_SERIES[(e.k - 1) % ACCOUNT_SERIES.length]!;
          ctx.lineWidth = dpr;
          ctx.beginPath();
          ctx.moveTo(e.x + 3 * dpr, e.y);
          ctx.lineTo(lx - 6 * dpr, y);
          ctx.lineTo(lx - 2 * dpr, y);
          ctx.stroke();
          ctx.fillStyle = C.ink2;
          ctx.fillText(`${ns[e.k - 1] ?? ""} ${pnl(e.v)}`, lx, y);
        });
        ctx.restore();
      },
    },
  };
}

function AccountPnlChart() {
  const all = useStore((s) => s.snap?.account_series);
  const accounts = useStore((s) => s.snap?.accounts);
  const dayStart = useStore((s) => s.snap?.summary.day_start ?? 0);
  const tz = useStore((s) => s.tz);
  // the desk's accounts in grid order, at most six lines
  const shown = useMemo(() => {
    const by = new Map((all ?? []).map((a) => [a.account, a]));
    return (accounts ?? []).filter((a) => by.has(a.id)).slice(0, ACCOUNT_SERIES.length).map((a) => ({ label: a.label, s: by.get(a.id)! }));
  }, [all, accounts]);
  const labels = useMemo(() => shown.map((x) => x.label), [shown]);
  const labelsRef = useRef(labels);
  labelsRef.current = labels;
  const data = useMemo<uPlot.AlignedData>(() => {
    const ts = Array.from(new Set(shown.flatMap((x) => x.s.t))).sort((a, b) => a - b);
    const idx = new Map(ts.map((t, i) => [t, i]));
    const cols = shown.map((x) => {
      const col = new Array<number | null>(ts.length).fill(null);
      x.s.t.forEach((t, i) => (col[idx.get(t)!] = x.s.pnl_day[i]!));
      return col;
    });
    return [ts.map((t) => t / 1000), ...cols];
  }, [shown]);
  const n = labels.length;
  const key = labels.join("|");
  const options = useCallback(
    (width: number, height: number): uPlot.Options => ({
      width,
      height,
      padding: [10, 104, 0, 0],
      legend: { show: false },
      cursor: { y: false, points: { size: 7, width: 2, stroke: C.panel }, drag: { x: false, y: false } },
      scales: {
        x: {
          time: false,
          range: (u) => {
            const xs = u.data[0];
            const lo = xs.length ? xs[0]! : dayStart / 1000;   // from the first point: the day so far
            const hi = xs.length ? xs[xs.length - 1]! : lo + 3600;
            return [lo, hi + Math.max(10, (hi - lo) * 0.005)];
          },
        },
        y: {
          range: (_u, min, max) => {
            const pad = Math.max(2, (max - min) * 0.1);
            return [Math.min(0, min) - pad, Math.max(0, max) + pad];
          },
        },
      },
      axes: [timeAxis(tz, { space: 70 }), usdAxis()],
      series: [
        {},
        ...labelsRef.current.map((l, k) => ({ label: l, stroke: ACCOUNT_SERIES[k]!, width: 1.75, spanGaps: true, points: { show: false } })),
      ],
      plugins: [
        endLabels(() => labelsRef.current),
        tooltipPlugin((u, i) => {
          const t = u.data[0][i];
          if (t == null) return null;
          return {
            title: hm(t * 1000, tz) + (tz === "utc" ? " UTC" : "") + " day PnL",
            rows: labelsRef.current.map((l, k) => ({
              color: ACCOUNT_SERIES[k]!,
              label: l,
              value: pnl(u.data[k + 1]![i] ?? null) + " USDT",
            })),
          };
        }),
      ],
    }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [tz, dayStart, n, key],
  );
  return (
    <Panel
      className="series-panel"
      title={
        <span title="Each account's day PnL: equity minus equity at the day start, minus net transfers in. Points every 45 s. USDT.">
          Day PnL by account <span className="title-unit">USDT</span>
        </span>
      }
      right={n > 1 ? <Legend items={labels.map((l, k) => ({ color: ACCOUNT_SERIES[k]!, label: l }))} /> : undefined}
      bodyClass="chart-body"
    >
      {n > 0 ? <UPlot options={options} data={data} /> : <div className="muted empty-note">No account series yet</div>}
    </Panel>
  );
}

const EQ: Line[] = [{ key: "equity", label: "Equity", color: S1, signed: false }];
const INV: Line[] = [
  { key: "inventory", label: "Spot inventory", color: S1, signed: true },
  { key: "futures_notional", label: "Futures notional", color: S2, signed: true },
];

const rowIdPos = (p: GetRowIdParams<PosRow>) => `${p.data.account}:${p.data.symbol}`;

export function Accounts() {
  const wide = useMediaQuery("(min-width: 1700px)") ?? true;
  const n = useStore((st) => st.snap?.accounts.length ?? 0);
  // header + grid header + rows + totals row, so the grid needs no inner scroll
  const top = 30 + 27 + 24 * (n + (n > 1 ? 1 : 0)) + 4;
  const npos = useStore((st) => st.snap?.accounts.reduce((k, a) => k + a.positions.length, 0) ?? 0);
  const posH = 30 + 27 + 24 * Math.max(1, npos) + 4;
  return (
    <div className="page accounts" style={{ gridTemplateRows: `${top}px minmax(300px, 1.8fr) minmax(170px, 1fr)` }}>
      <Panel className="acc-full" title="Accounts" bodyClass="grid-body">
        <AccountsGrid full wide={wide} />
      </Panel>
      <div className="acc-row">
        <div className="acc-col" style={{ gridTemplateRows: `${posH}px minmax(0, 1fr)` }}>
          <Positions />
          <HedgePanel />
        </div>
        <ExposurePanel />
      </div>
      <div className="acc-row three">
        <AccountPnlChart />
        <SeriesChart title="Desk equity" lines={EQ} />
        <SeriesChart title="Desk inventory, futures" lines={INV} />
      </div>
    </div>
  );
}
