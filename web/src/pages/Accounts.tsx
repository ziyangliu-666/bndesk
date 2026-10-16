// Assets (was Accounts) ≈ Binance's wallet overview: the estimated total value and today's PnL on top, then tabs
// Overview | Spot | Futures | Exposure & hedge. Nothing scrolls sideways at 1440; every chart is an ExChart.
import { useMediaQuery } from "@mantine/hooks";
import { useMemo } from "react";
import { AgGridReact } from "ag-grid-react";
import type { ColDef, GetRowIdParams, ICellRendererParams, RowClickedEvent, ValueFormatterParams } from "ag-grid-community";
import { IconEye, IconEyeOff } from "@tabler/icons-react";
import { selectInstrument, useStore } from "../store";
import { bps, dur, hm, hms, pct, price, qty } from "../format";
import { ACCOUNT_SERIES, C, FUT_COLOR, INV_COLOR } from "../theme";
import { gridTheme } from "../gridTheme";
import { AccountsGrid } from "../components/AccountsGrid";
import { fPrice, fQtyS, flexCols, signCls, DEFAULT_COL } from "../grid";
import type { Account, HedgeLeg, Position, SymbolRow } from "../protocol";
import { HedgeBridge } from "../components/HedgeBridge";
import { useNow } from "../hooks";
import { ExChart, Tabs, useExPref, type ExSeries } from "../components/ex";
import { Money, hideNow, masked, money, useHide, useMoney } from "./ops/money";
import { IVS, IV_KEYS, STEP, useBucketed } from "./ops/series";
import "./ops/ops.css";

type AssetTab = "overview" | "spot" | "futures" | "exposure";

// ---- grid helpers: USD columns follow Hide amounts (columns rebuilt when it changes) ----
const vv = (p: ValueFormatterParams) => p.value as number | null | undefined;
const fMoney = (p: ValueFormatterParams) => (hideNow() ? masked(vv(p)) : money(vv(p)));
const fSigned = (p: ValueFormatterParams) => (hideNow() ? masked(vv(p), true) : money(vv(p), true));
const mCls = (hide: boolean) => (hide ? "num ops-masked" : "num");
const sCls = (hide: boolean) => (hide ? () => "num ops-masked" : signCls);

function SymCell(p: ICellRendererParams<{ symbol: string; venue?: string }>) {
  const d = p.data;
  if (!d) return null;
  return (
    <span className="ops-sym">
      {d.symbol}
      {d.venue === "usdm" && <span className="ops-perp">Perp</span>}
    </span>
  );
}

// ================================ header ================================

function Hero() {
  const accounts = useStore((s) => s.snap?.accounts);
  const summary = useStore((s) => s.snap?.summary);
  const hide = useHide();
  const setHide = useStore((s) => s.setHideAmounts);
  const t = useMemo(() => {
    if (!accounts) return null;
    const sum = (f: (a: Account) => number) => accounts.reduce((k, a) => k + f(a), 0);
    return {
      equity: sum((a) => a.equity),
      open: sum((a) => a.equity_open),
      pnl: sum((a) => a.pnl_day),
      spot: sum((a) => a.quote_free + a.quote_locked + a.inventory_value),
      fut: sum((a) => a.fut_wallet + a.fut_upnl),
      transfers: sum((a) => a.transfers_day),
    };
  }, [accounts]);
  const pnlDay = summary?.pnl_day ?? t?.pnl;
  const pctDay = t && t.open > 0 && pnlDay != null ? pnlDay / t.open : null;
  const tone = hide || pnlDay == null ? "" : pnlDay > 0 ? "up" : pnlDay < 0 ? "down" : "";
  return (
    <div className="ops-hero">
      <div className="ops-hero-main">
        <span className="ops-hero-label">
          Est. total value (USDT)
          <button className="ops-eye" type="button" onClick={() => setHide(!hide)} aria-label={hide ? "Show amounts" : "Hide amounts"} title={hide ? "Show amounts" : "Hide amounts"}>
            {hide ? <IconEyeOff size={14} /> : <IconEye size={14} />}
          </button>
        </span>
        <span className={"ops-hero-value fig" + (hide ? " ops-masked" : "")}>{t ? (hide ? masked(t.equity) : money(t.equity)) : "--"}</span>
      </div>
      <div className="ops-pair" title="Equity now − equity at the day start − net transfers in, and that as a share of the equity at the start">
        <span className="ops-l">Today's PnL</span>
        <span className={"ops-v fig " + tone}>
          {pnlDay == null ? "--" : hide ? masked(pnlDay, true) : money(pnlDay, true)}
          {pctDay != null && <span className={"ops-unit " + tone}>({pctDay >= 0 ? "+" : "−"}{Math.abs(pctDay * 100).toFixed(2)}%)</span>}
        </span>
      </div>
      <div className="ops-pairs">
        <div className="ops-pair" title="Spot: USDT free and in orders plus the other assets at mid">
          <span className="ops-l">Spot</span>
          <span className="ops-v">{t ? <Money v={t.spot} /> : "--"}</span>
        </div>
        <div className="ops-pair" title="USD-M futures: wallet balance plus unrealized PnL">
          <span className="ops-l">Futures</span>
          <span className="ops-v">{t ? <Money v={t.fut} /> : "--"}</span>
        </div>
        <div className="ops-pair" title="Market-maker rebates credited today, part of today's PnL">
          <span className="ops-l">Rebates today</span>
          <span className="ops-v">{summary ? <Money v={summary.rebates} sign /> : "--"}</span>
        </div>
        <div className="ops-pair" title="Net transfers in since the day start (not PnL)">
          <span className="ops-l">Transfers today</span>
          <span className="ops-v">{t ? <Money v={t.transfers} sign color={false} /> : "--"}</span>
        </div>
      </div>
    </div>
  );
}

// ================================ Overview ================================
// Each ExChart here is keyed on Hide amounts: ExChart takes a series' format when the series is created, so a
// new chart picks up the masked one (axis, legend and tag all read •••).

/** Day PnL by account (one line each, plus the desk) or the desk's equity, today, on the account grid. */
function AccountChart() {
  const all = useStore((s) => s.snap?.account_series);
  const accounts = useStore((s) => s.snap?.accounts);
  const series = useStore((s) => s.snap?.series);
  const hide = useHide();
  const [iv, setIv] = useExPref("assets-acc", "interval", "1m", IV_KEYS);
  const [mode, setMode] = useExPref("assets-acc", "mode", "pnl", ["pnl", "equity"]);
  const pts = useBucketed();
  const step = STEP[iv] ?? 0;
  const desk = useMemo(() => {
    const s = series ?? [];
    return { t: s.map((p) => p.t), eq: s.map((p) => p.equity) };
  }, [series]);
  const fmtS = (v: number) => (hide ? masked(v, true) : money(v, true));
  const fmtU = (v: number) => (hide ? masked(v) : money(v));
  const shown = useMemo(() => {
    const by = new Map((all ?? []).map((a) => [a.account, a]));
    return (accounts ?? [])
      .filter((a) => by.has(a.id))
      .slice(0, ACCOUNT_SERIES.length)
      .map((a, k) => ({ id: a.id, label: a.label, s: by.get(a.id)!, color: ACCOUNT_SERIES[k]! }));
  }, [all, accounts]);
  // the desk's line on the accounts' own grid (the sum where every account has a point), so at rest the legend
  // reads every line at the same time
  const deskPnl = useMemo(() => {
    const sum = new Map<number, [number, number]>();
    for (const a of shown)
      a.s.t.forEach((t, i) => {
        const c = sum.get(t) ?? [0, 0];
        c[0] += a.s.pnl_day[i] ?? 0;
        c[1]++;
        sum.set(t, c);
      });
    const ts = [...sum.keys()].filter((t) => sum.get(t)![1] === shown.length).sort((a, b) => a - b);
    return { t: ts, v: ts.map((t) => sum.get(t)![0]) };
  }, [shown]);
  const lines: ExSeries[] =
    mode === "pnl"
      ? [
          {
            key: "desk",
            kind: "line",
            label: "Desk",
            color: C.ink,
            width: 1,
            data: pts("desk-pnl", deskPnl.t, deskPnl.v, step),
            format: fmtS,
            signColor: false,
          },
          ...shown.map(
            (a): ExSeries => ({
              key: a.id,
              kind: "line",
              label: a.label,
              color: a.color,
              data: pts("acc-" + a.id, a.s.t, a.s.pnl_day, step),
              format: fmtS,
              lastValue: false,
            }),
          ),
        ]
      : [
          {
            key: "equity",
            kind: "area",
            label: "Equity",
            color: C.accent,
            data: pts("desk-eq", desk.t, desk.eq, step),
            format: fmtU,
            toggle: false,
          },
        ];
  return (
    <section className="ops-panel ops-chart-panel">
      <ExChart
        key={hide ? "masked" : "shown"}
        id="assets-acc"
        title={mode === "pnl" ? "Day PnL by account" : "Equity"}
        series={lines}
        intervals={IVS}
        interval={iv}
        onInterval={setIv}
        toolbarLeft={<span className="ops-chart-title">{mode === "pnl" ? "Day PnL by account" : "Desk equity"}</span>}
        modes={[
          {
            label: "Chart",
            value: mode,
            onChange: setMode,
            options: [
              { value: "pnl", label: "Day PnL" },
              { value: "equity", label: "Equity" },
            ],
          },
        ]}
        resetKey={mode}
        fill
        fullscreen
        emptyText="No account series yet"
      />
    </section>
  );
}

function Overview() {
  const wide = useMediaQuery("(min-width: 1700px)") ?? true;
  const n = useStore((st) => st.snap?.accounts.length ?? 0);
  // grid header + rows (gridTheme: 26 + 24 a row), so the grid needs no inner scroll
  const h = 27 + 24 * Math.max(1, n) + 2;
  return (
    <div className="ops-tab-body ops-ov">
      <section className="ops-panel" style={{ height: h }}>
        <AccountsGrid full wide={wide} />
      </section>
      <AccountChart />
    </div>
  );
}

/** One of today's desk lines (spot inventory value, futures notional) on the 5 s grid, beside its tab's tables. */
function SideChart({ id, title, field, color }: { id: string; title: string; field: "inventory" | "futures_notional"; color: string }) {
  const series = useStore((s) => s.snap?.series);
  const hide = useHide();
  const [iv, setIv] = useExPref(id, "interval", "1m", IV_KEYS);
  const pts = useBucketed();
  const cols = useMemo(() => {
    const s = series ?? [];
    return { t: s.map((p) => p.t), v: s.map((p) => p[field]) };
  }, [series, field]);
  const fmt = (v: number) => (hide ? masked(v, field === "futures_notional") : money(v, field === "futures_notional"));
  return (
    <section className="ops-panel ops-chart-panel">
      <ExChart
        key={hide ? "masked" : "shown"}
        id={id}
        title={title}
        series={[{ key: field, kind: field === "inventory" ? "area" : "line", label: title, color, data: pts(field, cols.t, cols.v, STEP[iv] ?? 0), format: fmt, toggle: false }]}
        intervals={IVS}
        interval={iv}
        onInterval={setIv}
        toolbarLeft={<span className="ops-chart-title">{title} (USDT)</span>}
        fill
        fullscreen
        emptyText="No series yet"
      />
    </section>
  );
}

// ================================ Spot ================================

interface SpotRow {
  symbol: string;
  asset: string;
  venue: "spot";
  amount: number;
  locked: number;
  free: number;
  mid: number | null;
  avg: number | null;
  value: number;
  upnl: number | null;
  today: number;
  dust: boolean;
}

const rowIdSpot = (p: GetRowIdParams<SpotRow>) => p.data.symbol;
const openSpot = (e: RowClickedEvent<SpotRow>) => e.data && e.data.asset !== "USDT" && selectInstrument({ symbol: e.data.symbol, venue: "spot" });

function useSpotRows() {
  const symbols = useStore((s) => s.snap?.symbols);
  const orders = useStore((s) => s.snap?.orders);
  const accounts = useStore((s) => s.snap?.accounts);
  return useMemo(() => {
    const locked = new Map<string, number>();
    for (const o of orders ?? []) if (o.venue === "spot" && o.side === "sell") locked.set(o.symbol, (locked.get(o.symbol) ?? 0) + o.qty);
    const rows: SpotRow[] = (symbols ?? [])
      .filter((s: SymbolRow) => s.venue === "spot" && Math.abs(s.inv_qty) > 0)
      .map((s) => {
        const l = Math.min(locked.get(s.symbol) ?? 0, s.inv_qty);
        return {
          symbol: s.symbol,
          asset: s.symbol.replace(/USDT$/, ""),
          venue: "spot" as const,
          amount: s.inv_qty,
          locked: l,
          free: s.inv_qty - l,
          mid: s.mid,
          avg: s.avg_cost,
          value: s.inv_value,
          upnl: s.upnl,
          today: s.trading_pnl,
          dust: s.dust,
        };
      })
      .sort((a, b) => b.value - a.value);
    const free = (accounts ?? []).reduce((k, a) => k + a.quote_free, 0);
    const inOrders = (accounts ?? []).reduce((k, a) => k + a.quote_locked, 0);
    const usdt: SpotRow = { symbol: "USDT", asset: "USDT", venue: "spot", amount: free + inOrders, locked: inOrders, free, mid: 1, avg: null, value: free + inOrders, upnl: null, today: 0, dust: false };
    return { rows, usdt };
  }, [symbols, orders, accounts]);
}

function AssetCell(p: ICellRendererParams<SpotRow>) {
  const d = p.data;
  if (!d) return null;
  return <span className={"ops-sym" + (d.dust ? " ops-dust" : "")} title={d.dust ? "Below the minimum notional: cannot be sold on its own" : undefined}>{d.asset}</span>;
}

function SpotAccounts() {
  const accounts = useStore((s) => s.snap?.accounts);
  const m = useMoney();
  const hide = useHide();
  return (
    <section className="ops-panel">
      <header className="ops-head">
        <span className="ops-title">By account</span>
      </header>
      <div className="ops-body ops-scroll">
        <table className="ops-table">
          <thead>
            <tr>
              <th className="l">Account</th>
              <th title="Free spot quote balance, USDT">USDT free</th>
              <th title="Spot quote balance locked in open bids, USDT">In orders</th>
              <th title="Non-quote spot assets at mid, USDT">Inventory</th>
              <th title="Resting bid notional / (free quote + resting bid notional)">Bid use</th>
            </tr>
          </thead>
          <tbody className={hide ? "ops-masked-body" : undefined}>
            {(accounts ?? []).map((a) => (
              <tr key={a.id}>
                <td className="l">{a.label}</td>
                <td className={hide ? "ops-masked" : ""}>{m(a.quote_free)}</td>
                <td className={hide ? "ops-masked" : ""}>{m(a.quote_locked)}</td>
                <td className={hide ? "ops-masked" : ""}>{m(a.inventory_value)}</td>
                <td>{a.role === "master" || !Number.isFinite(a.utilization) ? "--" : pct(a.utilization)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function Spot() {
  const { rows, usdt } = useSpotRows();
  const hide = useHide();
  const cols = useMemo<ColDef<SpotRow>[]>(() => {
    const n = (c: ColDef<SpotRow>): ColDef<SpotRow> => ({ type: "rightAligned", cellClass: "num", ...c });
    return flexCols([
      { field: "asset", headerName: "Asset", width: 90, cellRenderer: AssetCell, pinned: "left" },
      n({ field: "amount", headerName: "Amount", headerTooltip: "Held across the accounts, free + in orders", width: 100, valueFormatter: (p) => qty(p.value as number) }),
      n({ field: "locked", headerName: "In orders", headerTooltip: "Held in resting sell orders", width: 90, valueFormatter: (p) => qty(p.value as number) }),
      n({ field: "free", headerName: "Available", width: 90, valueFormatter: (p) => qty(p.value as number) }),
      n({ field: "mid", headerName: "Price", headerTooltip: "Mid, USDT", width: 90, valueFormatter: fPrice }),
      n({ field: "avg", headerName: "Avg cost", headerTooltip: "Average cost of what is held, USDT", width: 90, valueFormatter: (p) => (p.data?.asset === "USDT" ? "" : price(p.value as number)) }),
      n({ field: "value", headerName: "Value (USDT)", headerTooltip: "Amount at mid", width: 100, valueFormatter: fMoney, cellClass: mCls(hide), initialSort: "desc" }),
      n({ field: "upnl", headerName: "uPnL", headerTooltip: "Value − amount × avg cost, USDT", width: 84, valueFormatter: (p) => (p.data?.asset === "USDT" ? "" : fSigned(p)), cellClass: sCls(hide) }),
      n({ field: "today", headerName: "Today", headerTooltip: "Today's trading P&L on the market (Π: realized + float), USDT", width: 84, valueFormatter: (p) => (p.data?.asset === "USDT" ? "" : fSigned(p)), cellClass: sCls(hide) }),
    ]);
  }, [hide]);
  const pinned = useMemo(() => [usdt], [usdt]);
  return (
    <div className="ops-tab-body ops-spot">
      <section className="ops-panel">
        <header className="ops-head">
          <span className="ops-title">
            Balances <span className="ops-count fig">{rows.length + 1}</span>
          </span>
        </header>
        <div className="ops-body ops-grid">
          <AgGridReact<SpotRow>
            theme={gridTheme}
            rowData={rows}
            pinnedTopRowData={pinned}
            columnDefs={cols}
            defaultColDef={DEFAULT_COL}
            getRowId={rowIdSpot}
            onRowClicked={openSpot}
            rowClass="ops-click"
            suppressCellFocus
            animateRows={false}
            tooltipShowDelay={300}
            overlayNoRowsTemplate="No spot assets"
          />
        </div>
      </section>
      <div className="ops-side">
        <SpotAccounts />
        <SideChart id="assets-spot" title="Spot inventory" field="inventory" color={INV_COLOR} />
      </div>
    </div>
  );
}

// ================================ Futures ================================

type PosRow = Position & { account: string; venue: "usdm" };
const rowIdPos = (p: GetRowIdParams<PosRow>) => `${p.data.account}:${p.data.symbol}`;
const openPos = (e: RowClickedEvent<PosRow>) => e.data && selectInstrument({ symbol: e.data.symbol, venue: "usdm" });

function FuturesAccounts() {
  const accounts = useStore((s) => s.snap?.accounts);
  const hide = useHide();
  const m = useMoney();
  const fut = (accounts ?? []).filter((a) => a.fut_wallet || a.positions.length);
  return (
    <section className="ops-panel">
      <header className="ops-head">
        <span className="ops-title">By account</span>
      </header>
      <div className="ops-body ops-scroll">
        {fut.length === 0 ? (
          <div className="ops-empty">No futures wallets</div>
        ) : (
          <table className="ops-table">
            <thead>
              <tr>
                <th className="l">Account</th>
                <th title="USD-M futures wallet balance, USDT">Wallet</th>
                <th title="Unrealized PnL of the positions at mark, USDT">uPnL</th>
                <th title="Futures available balance, USDT">Available</th>
                <th title="Open positions">Positions</th>
              </tr>
            </thead>
            <tbody>
              {fut.map((a) => (
                <tr key={a.id}>
                  <td className="l">{a.label}</td>
                  <td className={hide ? "ops-masked" : ""}>{m(a.fut_wallet)}</td>
                  <td>
                    <Money v={a.fut_upnl} sign />
                  </td>
                  <td className={hide ? "ops-masked" : ""}>{m(a.fut_available)}</td>
                  <td>{a.positions.length}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </section>
  );
}

function Futures() {
  const accounts = useStore((s) => s.snap?.accounts);
  const hide = useHide();
  const rows = useMemo<PosRow[]>(
    () => accounts?.flatMap((a) => a.positions.map((p) => ({ ...p, account: a.label, venue: "usdm" as const }))) ?? [],
    [accounts],
  );
  const cols = useMemo<ColDef<PosRow>[]>(() => {
    const n = (c: ColDef<PosRow>): ColDef<PosRow> => ({ type: "rightAligned", cellClass: "num", ...c });
    return flexCols([
      { field: "symbol", headerName: "Symbol", headerTooltip: "USD-M perpetual", width: 120, cellRenderer: SymCell },
      n({ field: "amt", headerName: "Size", headerTooltip: "Position size, base asset; negative = short", width: 96, valueFormatter: fQtyS, cellClass: signCls }),
      n({ field: "notional", headerName: "Notional", headerTooltip: "Size × mark, USDT", width: 96, valueFormatter: fSigned, cellClass: sCls(hide) }),
      n({ field: "entry", headerName: "Entry price", headerTooltip: "Average entry price, USDT", width: 96, valueFormatter: fPrice }),
      n({ field: "mark", headerName: "Mark price", headerTooltip: "Mark price, USDT", width: 96, valueFormatter: fPrice }),
      n({ field: "upnl", headerName: "uPnL", headerTooltip: "Unrealized PnL at mark against the entry price, USDT. Not today's result: see Today", width: 90, valueFormatter: fSigned, cellClass: sCls(hide) }),
      n({
        field: "pnl_day",
        headerName: "Today",
        headerTooltip: "Today's P&L on the symbol: the position held at the day start and today's fills marked to mark now, minus fees, plus funding, USDT",
        width: 90,
        valueFormatter: fSigned,
        cellClass: sCls(hide),
      }),
      { field: "account", headerName: "Account", width: 80, cellClass: "muted-cell" },
    ]);
  }, [hide]);
  return (
    <div className="ops-tab-body ops-fut">
      <section className="ops-panel ops-pos" style={{ height: Math.min(360, 40 + 27 + 24 * Math.max(1, rows.length) + 2) }}>
        <header className="ops-head">
          <span className="ops-title">
            Positions <span className="ops-count fig">{rows.length}</span>
          </span>
        </header>
        <div className="ops-body ops-grid">
          <AgGridReact<PosRow>
            theme={gridTheme}
            rowData={rows}
            columnDefs={cols}
            defaultColDef={DEFAULT_COL}
            getRowId={rowIdPos}
            onRowClicked={openPos}
            rowClass="ops-click"
            suppressCellFocus
            tooltipShowDelay={300}
            overlayNoRowsTemplate="No futures positions"
          />
        </div>
      </section>
      <FuturesAccounts />
      <SideChart id="assets-fut" title="Futures notional" field="futures_notional" color={FUT_COLOR} />
    </div>
  );
}

// ================================ Exposure & hedge ================================

function ExposureTable() {
  const x = useStore((s) => s.snap?.exposure);
  const tz = useStore((s) => s.tz);
  const hide = useHide();
  const mc = hide ? "ops-masked" : "";
  if (!x)
    return (
      <section className="ops-panel">
        <header className="ops-head">
          <span className="ops-title">Exposure</span>
        </header>
        <div className="ops-empty">--</div>
      </section>
    );
  const over = x.gap != null && x.band != null && Math.abs(x.gap) > x.band;
  return (
    <section className="ops-panel">
      <header className="ops-head">
        <span className="ops-title">Exposure (USDT)</span>
        {x.target != null && (
          <span className="ops-head-right">
            {x.paused ? (
              <span className={over ? "warn-text" : "muted"} title="Hedge off: target 0; the hedge still open is to be closed">
                {x.paused}
                {x.paused_until != null && ` until ${hm(x.paused_until, tz)}`}
              </span>
            ) : (
              <span
                className={"ops-target fig" + (over ? " warn-text" : "")}
                title={
                  `Hedge target: −${x.ratio} × beta-weighted spot value; band: allowed |gap|, USDT. ` +
                  (x.beta_source === "estimate" ? "β: the desk's own estimate, may differ from the engine's." : "β: configured per market.")
                }
              >
                Target <b className={mc}>{hide ? masked(x.target, true) : money(x.target, true)}</b> · Band <b className={mc}>±{hide ? masked(x.band) : money(x.band)}</b>
              </span>
            )}
          </span>
        )}
      </header>
      <div className="ops-body ops-scroll">
        <table className="ops-table">
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
                <td>
                  <Money v={r.spot_value} />
                </td>
                <td>
                  <Money v={r.futures_notional} sign />
                </td>
                <td>
                  <Money v={r.net} sign />
                </td>
              </tr>
            ))}
            <tr className="total">
              <td className="l">Total</td>
              <td>
                <Money v={x.spot_value} />
              </td>
              <td>
                <Money v={x.futures_notional} sign />
              </td>
              <td>
                <Money v={x.net} sign />
              </td>
            </tr>
            {x.gap != null && (
              <>
                <tr className="sub">
                  <td className="l" title="Beta-weighted spot value and hedge symbols' futures notional, USDT">
                    Hedge (β-weighted)
                  </td>
                  <td>
                    <Money v={x.beta_value} />
                  </td>
                  <td>
                    <Money v={x.hedge_notional} sign />
                  </td>
                  <td />
                </tr>
                <tr className={over ? "warn-row" : "sub"}>
                  <td className="l" title={x.paused ? "Hedge off: futures notional still open, to be closed, USDT" : "Target − hedge futures notional: the trade that closes the gap, USDT"}>
                    {x.paused ? "To close" : "Gap vs target"}
                  </td>
                  <td />
                  <td />
                  <td>
                    <Money v={x.gap} sign color={!over} />
                  </td>
                </tr>
              </>
            )}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function LegCell(p: ICellRendererParams<HedgeLeg>) {
  if (!p.data) return null;
  return (
    <span className="ops-sym">
      {p.data.symbol}
      <span className="ops-perp">Perp</span>
    </span>
  );
}

/** Funding as on Binance futures: rate and countdown per perp held. */
function FundingPanel() {
  const x = useStore((s) => s.snap?.exposure);
  const tz = useStore((s) => s.tz);
  const skew = useStore((s) => s.skew);
  const now = useNow(1000) + skew;
  if (!x || x.funding.length === 0) return null;
  return (
    <section className="ops-panel">
      <header className="ops-head">
        <span className="ops-title">Funding</span>
      </header>
      <div className="ops-body ops-scroll">
          <table className="ops-table">
            <thead>
              <tr>
                <th className="l">Symbol</th>
                <th title="Position size, base asset">Position</th>
                <th title="Current funding rate per interval">Funding rate</th>
                <th title="Next funding time">Next</th>
                <th title="Time left to the next funding">Countdown</th>
              </tr>
            </thead>
            <tbody>
              {x.funding.map((f) => (
                <tr key={f.symbol}>
                  <td className="l">
                    <span className="ops-sym">
                      {f.symbol}
                      <span className="ops-perp">Perp</span>
                    </span>
                  </td>
                  <td className={f.position > 0 ? "up" : f.position < 0 ? "down" : ""}>{qty(f.position, true)}</td>
                  <td title={f.rate == null ? undefined : bps(f.rate * 1e4) + " bps"}>{f.rate == null ? "--" : (f.rate >= 0 ? "" : "−") + Math.abs(f.rate * 100).toFixed(4) + "%"}</td>
                  <td>{f.next == null ? "--" : hms(f.next, tz)}</td>
                  <td>{f.next == null ? "--" : dur(f.next - now)}</td>
                </tr>
              ))}
            </tbody>
          </table>
      </div>
    </section>
  );
}

const rowIdLeg = (p: GetRowIdParams<HedgeLeg>) => p.data.symbol;
const openLeg = (e: RowClickedEvent<HedgeLeg>) => e.data && selectInstrument({ symbol: e.data.symbol, venue: "usdm" });

function HedgePanel() {
  const h = useStore((s) => s.snap?.exposure.hedge_day);
  const inv = useStore((s) => s.snap?.summary.pnl.inventory);
  const hide = useHide();
  const cols = useMemo<ColDef<HedgeLeg>[]>(() => {
    const n = (c: ColDef<HedgeLeg>): ColDef<HedgeLeg> => ({ type: "rightAligned", cellClass: "num", ...c });
    return flexCols([
      { field: "symbol", headerName: "Leg", headerTooltip: "Futures hedge leg", width: 104, cellRenderer: LegCell },
      n({ field: "qty0", headerName: "Start", headerTooltip: "Position at the day start, base asset", width: 76, valueFormatter: fQtyS, cellClass: signCls }),
      n({ field: "qty", headerName: "Now", headerTooltip: "Position now, base asset", width: 76, valueFormatter: fQtyS, cellClass: signCls }),
      n({ field: "fills", headerName: "Fills", headerTooltip: "Futures fills today", width: 52 }),
      n({ field: "mark", headerName: "Mark", headerTooltip: "Mark price now, USDT", width: 84, valueFormatter: fPrice }),
      n({ colId: "fees", headerName: "Fees", headerTooltip: "Fees today, a cost, USDT", width: 64, valueGetter: (p) => (p.data ? -p.data.fees : null), valueFormatter: fSigned, cellClass: sCls(hide) }),
      n({ field: "pnl", headerName: "Today", headerTooltip: "Price P&L at mark − fees + funding, USDT", width: 76, valueFormatter: fSigned, cellClass: sCls(hide) }),
    ]);
  }, [hide]);
  const offset = h && inv != null && h.hedge_pnl != null && Math.abs(inv) > 1e-9 ? -h.hedge_pnl / inv : null;
  return (
    <section className="ops-panel ops-hedge">
      <header className="ops-head">
        <span className="ops-title" title="Since the day start: the Inventory PnL of the Desk, against what the futures legs made">
          Inventory and hedge, today
        </span>
        {offset != null && (
          <span className="ops-head-right fig" title="Hedge P&L over the Inventory PnL it offsets">
            <span className="muted">Offset</span> {Math.round(offset * 100)}%
          </span>
        )}
      </header>
      {h ? (
        <>
          {hide ? <div className="ops-empty">Amounts hidden</div> : <div className="ops-bridge"><HedgeBridge h={h} inventory={inv ?? 0} /></div>}
          {h.legs.length > 0 && (
            <div className="ops-body ops-grid ops-legs">
              <AgGridReact<HedgeLeg>
                theme={gridTheme}
                rowData={h.legs}
                columnDefs={cols}
                defaultColDef={DEFAULT_COL}
                getRowId={rowIdLeg}
                onRowClicked={openLeg}
                rowClass="ops-click"
                suppressCellFocus
                tooltipShowDelay={300}
              />
            </div>
          )}
        </>
      ) : (
        <div className="ops-empty">No hedge data yet</div>
      )}
    </section>
  );
}

/** Today's spot inventory, futures notional and their net, on the 5 s desk grid. */
function ExposureChart() {
  const series = useStore((s) => s.snap?.series);
  const hide = useHide();
  const [iv, setIv] = useExPref("assets-exp", "interval", "1m", IV_KEYS);
  const pts = useBucketed();
  const step = STEP[iv] ?? 0;
  const cols = useMemo(() => {
    const s = series ?? [];
    return { t: s.map((p) => p.t), inv: s.map((p) => p.inventory), fut: s.map((p) => p.futures_notional), net: s.map((p) => p.inventory + p.futures_notional) };
  }, [series]);
  const fmt = (v: number) => (hide ? masked(v, true) : money(v, true));
  const lines: ExSeries[] = [
    { key: "inv", kind: "line", label: "Spot inventory", color: INV_COLOR, data: pts("inv", cols.t, cols.inv, step), format: fmt },
    { key: "fut", kind: "line", label: "Futures notional", color: FUT_COLOR, data: pts("fut", cols.t, cols.fut, step), format: fmt },
    { key: "net", kind: "line", label: "Net", color: C.ink, width: 1, data: pts("net", cols.t, cols.net, step), format: fmt, lastValue: false },
  ];
  return (
    <section className="ops-panel ops-chart-panel">
      <ExChart
        key={hide ? "masked" : "shown"}
        id="assets-exp"
        title="Exposure"
        series={lines}
        intervals={IVS}
        interval={iv}
        onInterval={setIv}
        toolbarLeft={<span className="ops-chart-title">Exposure (USDT)</span>}
        fill
        fullscreen
        emptyText="No series yet"
      />
    </section>
  );
}

function Exposure() {
  return (
    <div className="ops-tab-body ops-exp">
      <ExposureTable />
      <div className="ops-col">
        <HedgePanel />
        <FundingPanel />
      </div>
      <ExposureChart />
    </div>
  );
}

// ================================ page ================================

export function Accounts() {
  const [tab, setTab] = useExPref<AssetTab>("assets", "tab", "overview", ["overview", "spot", "futures", "exposure"]);
  const nAcc = useStore((s) => s.snap?.accounts.length);
  const nPos = useStore((s) => s.snap?.accounts.reduce((k, a) => k + a.positions.length, 0));
  const nSpot = useStore((s) => s.snap?.symbols.filter((x) => x.venue === "spot" && Math.abs(x.inv_qty) > 0).length);
  return (
    <div className="page ops-assets">
      <Hero />
      <div className="ops-tabbar">
        <Tabs
          value={tab}
          onChange={setTab}
          items={[
            { value: "overview", label: "Overview", count: nAcc ?? null },
            { value: "spot", label: "Spot", count: nSpot != null ? nSpot + 1 : null },
            { value: "futures", label: "Futures", count: nPos ?? null },
            { value: "exposure", label: "Exposure & hedge" },
          ]}
        />
      </div>
      {tab === "overview" && <Overview />}
      {tab === "spot" && <Spot />}
      {tab === "futures" && <Futures />}
      {tab === "exposure" && <Exposure />}
    </div>
  );
}
