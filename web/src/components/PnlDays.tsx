import { useCallback, useMemo } from "react";
import type uPlot from "uplot";
import { AgGridReact } from "ag-grid-react";
import type { ColDef, GetRowIdParams, ICellRendererParams } from "ag-grid-community";
import { useStore } from "../store";
import { int, num, pnl, se, usd } from "../format";
import { INVPNL_COLOR, MM_COLOR, gridTheme } from "../theme";
import { UPlot, axis, barsPaths, tooltipPlugin } from "./UPlot";
import { Num, Panel } from "./ui";
import { usdAxis } from "./DayChart";
import type { DayPnl } from "../protocol";
import { fInt, fPnl, fUsd, flexCols, signCls, DEFAULT_COL } from "../grid";

const DEF_PI = "Trading PnL: market making plus inventory PnL, fees included; not hedged";
const DEF_MM = "Market making: each fill against the mid 60 s later, minus fees";
const DEF_INV = "Inventory PnL: trading PnL minus market making, what the held inventory made after those 60 s";
const DEF_SE = "± is the standard error of the day's sum, Newey–West (lag 3) over its hourly blocks";

function zeroLine(): uPlot.Plugin {
  return {
    hooks: {
      draw: (u) => {
        const { top, height, left, width } = u.bbox;
        const y = Math.round(u.valToPos(0, "y", true)) + 0.5;
        if (y <= top || y >= top + height) return;
        const ctx = u.ctx;
        ctx.save();
        ctx.strokeStyle = "#4a5870";
        ctx.lineWidth = devicePixelRatio;
        ctx.beginPath();
        ctx.moveTo(left, y);
        ctx.lineTo(left + width, y);
        ctx.stroke();
        ctx.restore();
      },
    },
  };
}

const symRange = (_u: uPlot, min: number, max: number): uPlot.Range.MinMax => {
  const m = Math.max(Math.abs(min), Math.abs(max), 0.5) * 1.15;
  return [Math.min(0, min) < 0 ? -m : 0 - m * 0.1, m];
};

// ---- daily table (headline) ----

type DayRow = DayPnl & { _total?: boolean; _n?: number };

function PmCell(field: "trading") {
  return function Cell(p: ICellRendererParams<DayRow>) {
    const d = p.data;
    if (!d) return null;
    const v = d[field];
    const e = d[`${field}_se` as const];
    return (
      <span className="pm fig">
        <Num v={v} text={pnl(v)} />
        <span className="pm-se">{se(e)}</span>
      </span>
    );
  };
}

function totalRow(days: DayPnl[]): DayRow {
  const sum = (k: "trading" | "hedged" | "factor" | "fills" | "volume" | "covered_s" | "backfilled_s") => days.reduce((a, d) => a + d[k], 0);
  // sums of the days that kept it, null when none did
  const sumN = (k: "pnl_day" | "realized" | "realized_old" | "floating" | "hedge" | "other" | "mm" | "inventory") => {
    const xs = days.map((d) => d[k]).filter((x): x is number => x != null);
    return xs.length ? xs.reduce((a, x) => a + x, 0) : null;
  };
  const comb = (k: "trading_se" | "hedged_se" | "factor_se") => {
    const xs = days.map((d) => d[k]).filter((x): x is number => x != null);
    return xs.length ? Math.sqrt(xs.reduce((a, x) => a + x * x, 0)) : null;
  };
  return {
    _total: true,
    _n: days.length,
    day: `${days.length} d`,
    trading: sum("trading"),
    trading_se: comb("trading_se"),
    hedged: sum("hedged"),
    hedged_se: comb("hedged_se"),
    factor: sum("factor"),
    factor_se: comb("factor_se"),
    fills: sum("fills"),
    volume: sum("volume"),
    covered_s: sum("covered_s"),
    backfilled_s: sum("backfilled_s"),
    pnl_day: sumN("pnl_day"),
    realized: sumN("realized"),
    realized_old: sumN("realized_old"),
    floating: sumN("floating"),
    hedge: sumN("hedge"),
    other: sumN("other"),
    mm: sumN("mm"),
    inventory: sumN("inventory"),
  };
}

export function DaysTable() {
  const days = useStore((s) => s.snap?.days);
  const rows = useMemo(() => (days ?? []).slice().reverse(), [days]);
  const pinned = useMemo(() => (days && days.length > 1 ? [totalRow(days)] : []), [days]);
  const cols = useMemo<ColDef<DayRow>[]>(() => {
    const n = (c: ColDef<DayRow>): ColDef<DayRow> => ({ type: "rightAligned", cellClass: "num", ...c });
    return [
      {
        field: "day",
        headerName: "Day",
        headerTooltip: "PnL day (starts at the configured day start), newest first; the bottom row sums the days shown",
        width: 92,
        cellClass: (p) => (p.node.rowPinned ? "sym total" : "fig"),
      },
      n({ field: "pnl_day", headerName: "Day PnL", headerTooltip: "Equity change net of transfers, USDT", width: 72, valueFormatter: fPnl, cellClass: signCls }),
      n({ field: "mm", headerName: "Market making", headerTooltip: `${DEF_MM}, USDT`, width: 96, valueFormatter: fPnl, cellClass: signCls }),
      n({ field: "inventory", headerName: "Inventory", headerTooltip: `${DEF_INV}, USDT`, width: 72, valueFormatter: fPnl, cellClass: signCls }),
      n({ field: "hedge", headerName: "Hedge", headerTooltip: "Futures legs: price, fees, funding, USDT", width: 60, valueFormatter: fPnl, cellClass: signCls }),
      n({ field: "other", headerName: "Other", headerTooltip: "Day PnL minus trading PnL and the hedge legs, USDT", width: 60, valueFormatter: fPnl, cellClass: signCls }),
      n({ colId: "trading", headerName: "Trading ± SE", headerTooltip: `${DEF_PI}. ${DEF_SE}. USDT`, width: 128, valueGetter: (p) => p.data?.trading, cellRenderer: PmCell("trading") }),
      n({ field: "fills", headerName: "Fills", headerTooltip: "Spot fills booked that day", width: 72, valueFormatter: fInt }),
      n({ field: "volume", headerName: "Volume", headerTooltip: "Notional of the spot fills booked that day, USDT", width: 76, valueFormatter: fUsd }),
      n({
        field: "covered_s",
        headerName: "Coverage",
        headerTooltip: "Hours booked live, plus hours backfilled from 1 min klines after +",
        width: 100,
        // clear of the overlay scrollbar
        cellStyle: { paddingRight: 16 },
        headerStyle: { paddingRight: 16 },
        valueGetter: (p) => (p.data ? p.data.covered_s + p.data.backfilled_s : null),
        valueFormatter: (p) => {
          const d = p.data;
          if (!d) return "";
          const h = (s: number) => num(s / 3600, 1);
          return d.backfilled_s > 0 ? `${h(d.covered_s)}+${h(d.backfilled_s)} h` : `${h(d.covered_s)} h`;
        },
      }),
    ];
  }, []);
  const fitted = useMemo(() => flexCols(cols), [cols]);
  return (
    <Panel
      className="days-panel"
      title={
        <span title={`${DEF_PI}. ${DEF_SE}.`}>
          PnL by day <span className="title-unit">USDT</span>
        </span>
      }
      bodyClass="grid-body"
    >
      <AgGridReact<DayRow>
        theme={gridTheme}
        rowData={rows}
        columnDefs={fitted}
        defaultColDef={DEFAULT_COL}
        getRowId={rowIdDayRow}
        pinnedBottomRowData={pinned}
        suppressCellFocus
        animateRows={false}
        tooltipShowDelay={300}
      />
    </Panel>
  );
}

// ---- hourly trading PnL bars, today ----

export function HourBars() {
  const hours = useStore((s) => s.snap?.hours);
  const dayStart = useStore((s) => s.snap?.summary.day_start ?? 0);
  // Stacked from zero per sign: the inventory bar is drawn first, to mm + inventory when both share a sign
  // (market making then covers its own part), else from zero the other way.
  const data = useMemo<uPlot.AlignedData>(() => {
    const xs = Array.from({ length: 24 }, (_, h) => h);
    const by = new Map((hours ?? []).map((b) => [Math.floor((b.t - dayStart) / 3_600_000), b]));
    const outer = xs.map((h) => {
      const b = by.get(h);
      if (!b) return null;
      return b.mm * b.inventory > 0 ? b.mm + b.inventory : b.inventory;
    });
    return [xs, outer, xs.map((h) => by.get(h)?.mm ?? null)];
  }, [hours, dayStart]);
  const options = useCallback(
    (width: number, height: number): uPlot.Options => ({
      width,
      height,
      padding: [10, 12, 0, 0],
      legend: { show: false },
      cursor: { y: false, points: { show: false }, drag: { x: false, y: false } },
      scales: { x: { time: false, range: () => [-0.6, 23.6] }, y: { range: symRange } },
      axes: [
        axis({
          splits: () => [0, 3, 6, 9, 12, 15, 18, 21],
          values: (_u, s) => s.map((v) => String(new Date(dayStart + v * 3_600_000).getUTCHours()).padStart(2, "0")),
        }),
        usdAxis({ size: 56 }),
      ],
      series: [
        {},
        { label: "Inventory PnL", fill: INVPNL_COLOR, stroke: INVPNL_COLOR, width: 0, paths: barsPaths(0), points: { show: false } },
        { label: "Market making", fill: MM_COLOR, stroke: MM_COLOR, width: 0, paths: barsPaths(0), points: { show: false } },
      ],
      plugins: [
        zeroLine(),
        tooltipPlugin((u, i) => {
          const h = u.data[0][i]!;
          const t = dayStart + h * 3_600_000;
          const b = useStore.getState().snap?.hours.find((x) => x.t === t);
          if (!b) return null;
          const hh = String(new Date(t).getUTCHours()).padStart(2, "0");
          return {
            title: `${hh}:00 UTC`,
            rows: [
              { label: "Market making", labelColor: MM_COLOR, value: pnl(b.mm) },
              { label: "Inventory PnL", labelColor: INVPNL_COLOR, value: pnl(b.inventory) },
              { label: "Trading PnL", value: pnl(b.trading) },
              { label: "fills", value: int(b.fills) },
              { label: "volume", value: usd(b.volume) },
            ],
          };
        }),
      ],
    }),
    [dayStart],
  );
  return (
    <Panel
      className="hour-panel"
      title={
        <span title={`${DEF_MM}. ${DEF_INV}. Summed over each UTC hour of today. USDT.`}>
          PnL by UTC hour, today <span className="title-unit">USDT</span>
        </span>
      }
      right={
        <div className="legend">
          <span style={{ color: MM_COLOR }}>Market making</span>
          <span style={{ color: INVPNL_COLOR }}>Inventory PnL</span>
        </div>
      }
      bodyClass="chart-body"
    >
      <UPlot options={options} data={data} />
    </Panel>
  );
}

const rowIdDayRow = (p: GetRowIdParams<DayRow>) => p.data.day;
