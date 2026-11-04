// Assets (was Accounts) ≈ Binance's wallet overview: the estimated total value and today's PnL on top, then tabs
// Overview | Spot | Futures (the hedge and exposure are on Strategy). Nothing scrolls sideways at 1440; every chart is an ExChart.
import { useMediaQuery } from "@mantine/hooks";
import { useMemo } from "react";
import { AgGridReact } from "ag-grid-react";
import type { ColDef, GetRowIdParams, ICellRendererParams, RowClickedEvent, ValueFormatterParams } from "ag-grid-community";
import { IconEye, IconEyeOff } from "@tabler/icons-react";
import { selectInstrument, useStore } from "../store";
import { bps, dur, hms, pct, price, qty } from "../format";
import { ACCOUNT_SERIES, C, FUT_COLOR, INV_COLOR } from "../theme";
import { gridTheme } from "../gridTheme";
import { AccountsGrid } from "../components/AccountsGrid";
import { fPrice, fQtyS, flexCols, maskVF, signCls, DEFAULT_COL } from "../grid";
import type { Account, HedgeLeg, Position, SymbolRow } from "../protocol";
import { HedgeBridge } from "../components/HedgeBridge";
import { useNow } from "../hooks";
import { ExChart, FigureHead, Tabs, useExPref, type ExSeries } from "../components/ex";
import { Money, amount, hideNow, pctOfMoney, qtyText, useAmount, useHide } from "../mask";
import { IVS, IV_KEYS, STEP, useBucketed } from "./ops/series";
import "./ops/ops.css";
import { cur, quoteAsset, baseOf, useDesk, isSpot, spotVenue, hasPerps, inventoryWord, notionalWord, roled, venueTag, cashWord } from "../desk";
import type { Venue } from "../protocol";

type AssetTab = "overview" | "spot" | "futures";

// ---- grid helpers: USD columns follow Hide amounts (columns rebuilt when it changes) ----
const vv = (p: ValueFormatterParams) => p.value as number | null | undefined;
const fMoney = (p: ValueFormatterParams) => (amount(vv(p), "money", hideNow()));
const fSigned = (p: ValueFormatterParams) => (amount(vv(p), "pnlMoney", hideNow()));
const mCls = (hide: boolean) => (hide ? "num masked" : "num");
const sCls = (hide: boolean) => (hide ? () => "num masked" : signCls);

function SymCell(p: ICellRendererParams<{ symbol: string; venue?: string }>) {
  const d = p.data;
  if (!d) return null;
  return (
    <span className="ops-sym">
      {d.symbol}
      {venueTag(d.venue) && <span className="ops-perp">{venueTag(d.venue)}</span>}
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
  const desk = useDesk();
  const pnlDay = summary?.pnl_day ?? t?.pnl;
  const pctDay = t && t.open > 0 && pnlDay != null ? pnlDay / t.open : null;
  const tone = hide ? undefined : pnlDay == null ? undefined : pnlDay > 0 ? "up" : pnlDay < 0 ? "down" : undefined;
  // the total value large; Day PnL beside it (the one coloured figure: did we make money); where the value sits
  // (spot, futures) in a line under it; rebates and transfers quieter at the right
  return (
    <div className="ops-hero">
      <FigureHead
        label={
          <span className="ops-hero-label">
            Total value ({cur()})
            <button className="ops-eye" type="button" onClick={() => setHide(!hide)} aria-label={hide ? "Show amounts" : "Hide amounts"} title={hide ? "Show amounts" : "Hide amounts"}>
              {hide ? <IconEyeOff size={14} /> : <IconEye size={14} />}
            </button>
          </span>
        }
        title="Estimated: every account's equity, spot at mid plus futures margin balance"
        value={t ? amount(t.equity, "money", hide) : "--"}
        aside={[
          {
            label: "Day PnL",
            value: (
              <>
                {pnlDay == null ? "--" : amount(pnlDay, "pnlMoney", hide)}
                {pctDay != null && <span className="ops-unit"> {pctOfMoney(pctDay, hide)}</span>}
              </>
            ),
            tone,
            title: "Equity now − equity at the day start − net transfers in, and that as a share of the equity at the start",
          },
        ]}
        parts={[
          { label: "Spot", value: t ? <Money v={t.spot} /> : "--", title: `Spot: ${cashWord()} free and in orders plus the other assets at their price` },
          ...(hasPerps(desk) ? [{ label: "Futures", value: t ? <Money v={t.fut} /> : "--", title: "Perps: wallet balance plus unrealized PnL" },] : []),
        ]}
        facts={[
          [
            ...(desk.rebates ? [{ label: "Rebates today", value: summary ? <Money v={summary.rebates} sign color={false} /> : "--", title: "Market-maker rebates credited today, part of today's PnL" },] : []),
            { label: "Transfers today", value: t ? <Money v={t.transfers} sign color={false} /> : "--", title: "Net transfers in since the day start (not PnL)" },
          ],
        ]}
      />
    </div>
  );
}

// ================================ Overview ================================
// ExChart re-reads a series' format when it prints otherwise, so Hide amounts masks the axis, legend and tag
// without a new chart.

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
  const fmtS = (v: number) => amount(v, "pnlMoney", hide);
  const fmtU = (v: number) => amount(v, "money", hide);
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
            color: C.ink2,
            data: pts("desk-eq", desk.t, desk.eq, step),
            format: fmtU,
            toggle: false,
          },
        ];
  return (
    <section className="ops-panel ops-chart-panel">
      <ExChart
        id="assets-acc"
        title={mode === "pnl" ? `Day PnL by account (${cur()})` : `Desk equity (${cur()})`}
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
        legendRest="names"
        emptyText="No account series yet"
      />
    </section>
  );
}

function Overview() {
  const wide = useMediaQuery("(min-width: 1700px)") ?? true;
  const scrolls = useMediaQuery("(max-width: 1399px)") ?? false; // the grid scrolls sideways: room for its bar
  const n = useStore((st) => st.snap?.accounts.length ?? 0);
  // grid header + rows (gridTheme: 26 + 24 a row), so the grid needs no inner scroll
  const h = 27 + 24 * Math.max(1, n) + 2 + (scrolls ? 14 : 0);
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
  const fmt = (v: number) => (amount(v, field === "futures_notional" ? "pnlMoney" : "money", hide));
  return (
    <section className="ops-panel ops-chart-panel">
      <ExChart
        id={id}
        title={`${title} (${cur()})`}
        series={[{ key: field, kind: field === "inventory" ? "area" : "line", label: title, color, data: pts(field, cols.t, cols.v, STEP[iv] ?? 0), format: fmt, toggle: false }]}
        intervals={IVS}
        interval={iv}
        onInterval={setIv}
        toolbarLeft={<span className="ops-chart-title">{title} ({cur()})</span>}
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
  venue: Venue;
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
const openSpot = (e: RowClickedEvent<SpotRow>) => e.data && e.data.asset !== cashWord() && selectInstrument({ symbol: e.data.symbol, venue: e.data.venue });

function useSpotRows() {
  const symbols = useStore((s) => s.snap?.symbols);
  const orders = useStore((s) => s.snap?.orders);
  const accounts = useStore((s) => s.snap?.accounts);
  return useMemo(() => {
    const locked = new Map<string, number>();
    for (const o of orders ?? []) if (isSpot(o.venue) && o.side === "sell") locked.set(o.symbol, (locked.get(o.symbol) ?? 0) + o.qty);
    const rows: SpotRow[] = (symbols ?? [])
      .filter((s: SymbolRow) => isSpot(s.venue) && Math.abs(s.inv_qty) > 0)
      .map((s) => {
        const l = Math.min(locked.get(s.symbol) ?? 0, s.inv_qty);
        return {
          symbol: s.symbol,
          asset: baseOf(s.symbol),
          venue: s.venue,
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
    const usdt: SpotRow = { symbol: cashWord(), asset: cashWord(), venue: spotVenue(), amount: free + inOrders, locked: inOrders, free, mid: 1, avg: null, value: free + inOrders, upnl: null, today: 0, dust: false };
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
  const m = useAmount();
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
              <th title={`Free spot quote balance, ${cur()}`}>{cashWord()} free</th>
              <th title={`Spot quote balance locked in open bids, ${cur()}`}>In orders</th>
              <th title={`Non-quote spot assets at mid, ${cur()}`}>Inventory</th>
              <th title="Resting bid notional / (free quote + resting bid notional)">Bid use</th>
            </tr>
          </thead>
          <tbody className={hide ? "masked-body" : undefined}>
            {(accounts ?? []).map((a) => (
              <tr key={a.id}>
                <td className="l">{a.label}</td>
                <td className={hide ? "masked" : ""}>{m(a.quote_free)}</td>
                <td className={hide ? "masked" : ""}>{m(a.quote_locked)}</td>
                <td className={hide ? "masked" : ""}>{m(a.inventory_value)}</td>
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
      // with amounts hidden the rows go by asset (an order by value would give the values away)
      { field: "asset", headerName: "Asset", width: 90, cellRenderer: AssetCell, pinned: "left", sort: hide ? "asc" : null },
      // sizes and balances are masked too: they give the amount away
      n({ field: "amount", headerName: "Amount", headerTooltip: "Held across the accounts, free + in orders", width: 100, valueFormatter: maskVF((p) => qty(p.value as number)), cellClass: mCls(hide) }),
      n({ field: "locked", headerName: "In orders", headerTooltip: "Held in resting sell orders", width: 90, valueFormatter: maskVF((p) => qty(p.value as number)), cellClass: mCls(hide) }),
      n({ field: "free", headerName: "Available", width: 90, valueFormatter: maskVF((p) => qty(p.value as number)), cellClass: mCls(hide) }),
      n({ field: "mid", headerName: "Price", headerTooltip: "Mid", width: 90, valueFormatter: fPrice }),
      n({ field: "avg", headerName: "Avg cost", headerTooltip: "Average cost of what is held", width: 90, valueFormatter: (p) => (p.data?.asset === quoteAsset() ? "" : price(p.value as number)) }),
      n({ field: "value", headerName: `Value (${cur()})`, headerTooltip: "Amount at mid", width: 100, valueFormatter: fMoney, cellClass: mCls(hide), sort: hide ? null : "desc", sortable: !hide }),
      n({ field: "upnl", headerName: "uPnL", headerTooltip: `Value − amount × avg cost, ${cur()}`, width: 84, valueFormatter: (p) => (p.data?.asset === quoteAsset() ? "" : fSigned(p)), cellClass: sCls(hide) }),
      n({ field: "today", headerName: "Trading PnL", headerTooltip: `Today, ${cur()}: market making + inventory PnL (realized + float), fees included`, width: 90, valueFormatter: (p) => (p.data?.asset === quoteAsset() ? "" : fSigned(p)), cellClass: sCls(hide) }),
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
        <SideChart id="assets-spot" title={inventoryWord()} field="inventory" color={INV_COLOR} />
      </div>
    </div>
  );
}

// ================================ Futures ================================

type PosRow = Position & { account: string };
const rowIdPos = (p: GetRowIdParams<PosRow>) => `${p.data.account}:${p.data.symbol}`;
const openPos = (e: RowClickedEvent<PosRow>) => e.data && selectInstrument({ symbol: e.data.symbol, venue: e.data.venue });

function FuturesAccounts() {
  const accounts = useStore((s) => s.snap?.accounts);
  const hide = useHide();
  const m = useAmount();
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
                <th title={`Perp wallet balance, ${cur()}`}>Wallet</th>
                <th title={`Unrealized PnL of the positions at mark, ${cur()}`}>uPnL</th>
                <th title={`Futures available balance, ${cur()}`}>Available</th>
                <th title="Open positions">Positions</th>
              </tr>
            </thead>
            <tbody>
              {fut.map((a) => (
                <tr key={a.id}>
                  <td className="l">{a.label}</td>
                  <td className={hide ? "masked" : ""}>{m(a.fut_wallet)}</td>
                  <td>
                    <Money v={a.fut_upnl} sign />
                  </td>
                  <td className={hide ? "masked" : ""}>{m(a.fut_available)}</td>
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
    () => accounts?.flatMap((a) => a.positions.map((p) => ({ ...p, account: a.label }))) ?? [],
    [accounts],
  );
  const cols = useMemo<ColDef<PosRow>[]>(() => {
    const n = (c: ColDef<PosRow>): ColDef<PosRow> => ({ type: "rightAligned", cellClass: "num", ...c });
    return flexCols([
      { field: "symbol", headerName: "Symbol", headerTooltip: "Perpetual", width: 120, cellRenderer: SymCell },
      n({ field: "amt", headerName: "Size", headerTooltip: "Position size, base asset; negative = short", width: 96, valueFormatter: maskVF(fQtyS), cellClass: hide ? "num masked" : signCls }),
      n({ field: "notional", headerName: "Notional", headerTooltip: `Size × mark, ${cur()}`, width: 96, valueFormatter: fSigned, cellClass: sCls(hide) }),
      n({ field: "entry", headerName: "Entry price", headerTooltip: "Average entry price", width: 96, valueFormatter: fPrice }),
      n({ field: "mark", headerName: "Mark price", headerTooltip: "Mark price", width: 96, valueFormatter: fPrice }),
      n({ field: "upnl", headerName: "uPnL", headerTooltip: `Unrealized PnL at mark against the entry price, ${cur()}. Not today's result: see Today`, width: 90, valueFormatter: fSigned, cellClass: sCls(hide) }),
      n({
        field: "pnl_day",
        headerName: roled() ? "Today" : "Hedge",
        headerTooltip: `Today, ${cur()}: the position held at the day start and today's fills marked to mark now, minus fees, plus funding`,
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
      <SideChart id="assets-fut" title={notionalWord()} field="futures_notional" color={FUT_COLOR} />
    </div>
  );
}

// ================================ hedge (shown on Strategy) ================================

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
export function FundingPanel() {
  const x = useStore((s) => s.snap?.exposure);
  const hide = useHide();
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
                  <td className={hide ? "masked" : f.position > 0 ? "up" : f.position < 0 ? "down" : ""}>{qtyText(f.position, hide, true)}</td>
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
const openLeg = (e: RowClickedEvent<HedgeLeg>) => e.data && selectInstrument({ symbol: e.data.symbol, venue: e.data.venue });

export function HedgePanel() {
  const h = useStore((s) => s.snap?.exposure.hedge_day);
  const inv = useStore((s) => s.snap?.summary.pnl.inventory);
  const hide = useHide();
  const cols = useMemo<ColDef<HedgeLeg>[]>(() => {
    const n = (c: ColDef<HedgeLeg>): ColDef<HedgeLeg> => ({ type: "rightAligned", cellClass: "num", ...c });
    return flexCols([
      { field: "symbol", headerName: "Leg", headerTooltip: "Hedge leg", width: 104, cellRenderer: LegCell },
      n({ field: "qty0", headerName: "Start", headerTooltip: "Position at the day start, base asset", width: 76, valueFormatter: maskVF(fQtyS), cellClass: hide ? "num masked" : signCls }),
      n({ field: "qty", headerName: "Now", headerTooltip: "Position now, base asset", width: 76, valueFormatter: maskVF(fQtyS), cellClass: hide ? "num masked" : signCls }),
      n({ field: "fills", headerName: "Fills", headerTooltip: "Futures fills today", width: 52 }),
      n({ field: "mark", headerName: "Mark", headerTooltip: "Mark price now", width: 84, valueFormatter: fPrice }),
      n({ colId: "fees", headerName: "Fees", headerTooltip: `Fees today, a cost, ${cur()}`, width: 64, valueGetter: (p) => (p.data ? -p.data.fees : null), valueFormatter: fSigned, cellClass: sCls(hide) }),
      n({ field: "pnl", headerName: "Hedge PnL", headerTooltip: `Today: price P&L at mark − fees + funding, ${cur()}`, width: 90, valueFormatter: fSigned, cellClass: sCls(hide) }),
    ]);
  }, [hide]);
  const offset = h && inv != null && h.hedge_pnl != null && Math.abs(inv) > 1e-9 ? -h.hedge_pnl / inv : null;
  return (
    <section className="ops-panel ops-hedge">
      <header className="ops-head">
        <span className="ops-title" title="Since the day start: the Inventory PnL of the Desk, against what the hedge made">
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

// ================================ page ================================

export function Accounts() {
  const [saved, setTab] = useExPref<AssetTab>("assets", "tab", "overview", ["overview", "spot", "futures"]);
  const desk = useDesk();
  // no futures on this desk: a tab remembered from elsewhere falls back
  const tab = !hasPerps(desk) && saved === "futures" ? "overview" : saved;
  return (
    <div className="page ops-assets">
      <Hero />
      <div className="ops-tabbar">
        <Tabs
          value={tab}
          onChange={setTab}
          items={[
            { value: "overview", label: "Overview" },
            { value: "spot", label: "Spot" },
            ...(hasPerps(desk) ? [{ value: "futures" as const, label: "Futures" }] : []),
          ]}
        />
      </div>
      {tab === "overview" && <Overview />}
      {tab === "spot" && <Spot />}
      {tab === "futures" && <Futures />}
    </div>
  );
}
