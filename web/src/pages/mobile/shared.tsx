// Pieces more than one phone page shows (an instrument row, a fill, the account and alert definitions, the
// engine's figures, the history loader). Kept here so each page stays its own chunk.
import { memo, useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import {
  DefinedLabel,
  InfoLabel,
  defineProps,
  KV,
  LimitBar,
  ListRow,
  Money,
  RateMeter,
  Section,
  Sheet,
  showInfo,
  Side,
  span,
  Tag,
  tone,
  useMoney,
} from "../../components/mobile";
import { Dot } from "../../components/ui";
import { bps, hms, int, num, price, qty } from "../../format";
import { usePageVisible } from "../../hooks";
import type { Account, Alert, Engine, Feed, Fill, Markouts, Position, SymbolRow } from "../../protocol";
import { useStore } from "../../store";
import { HEDGE_COLOR, INVPNL_COLOR, MM_COLOR, REBATE_COLOR } from "../../theme";
import "./ops.css";

// ---- history: the loader and the day's parts (History, Day, instrument history) ----

export const DAY = 86_400_000;

export type Load<T> = { key: string; data: T | null; err: string | null; loading: boolean };

/** Fetches once per key, and again every `every` ms while the page is visible (0: once). Hiding the page only
 *  stops the refresh; showing it again restarts it without a fetch of its own (the interval's next tick is it). */
export function useLoad<T>(key: string | null, run: (signal: AbortSignal) => Promise<T>, every = 0): Load<T> {
  const [st, setSt] = useState<Load<T>>({ key: "", data: null, err: null, loading: false });
  const visible = usePageVisible();
  const runRef = useRef(run);
  runRef.current = run;
  const ctl = useRef<AbortController | null>(null);
  const go = useCallback(
    (first: boolean) => {
      if (!key) return;
      ctl.current?.abort();
      const ac = (ctl.current = new AbortController());
      if (first) setSt((s) => ({ ...s, loading: true, err: null }));
      runRef.current(ac.signal).then(
        (data) => setSt({ key, data, err: null, loading: false }),
        (e: unknown) => {
          if ((e as Error).name === "AbortError") return;
          // an error for a new key keeps nothing of the old key's data
          setSt((s) => ({ key, data: s.key === key ? s.data : null, err: (e as Error).message || "request failed", loading: false }));
        },
      );
    },
    [key],
  );
  // the first load, and a new one when the key changes
  useEffect(() => {
    go(true);
    return () => ctl.current?.abort();
  }, [go]);
  // the refresh, only while visible
  useEffect(() => {
    if (!key || !(every > 0) || !visible) return;
    const id = setInterval(() => go(false), every);
    return () => clearInterval(id);
  }, [key, every, visible, go]);
  return st;
}

/** Empty, error and first-load states over a chart. */
export function ChartState({ load, empty }: { load: Load<unknown>; empty: boolean }) {
  const text = load.err && load.data == null ? "Could not load history" : load.loading && load.data == null ? "Loading" : empty ? "No data in this range" : null;
  return text ? <div className="m-hist-state">{text}</div> : null;
}

// the parts of a day, in the desk's series colors (the chart's legend uses the same)
export const PARTS = [
  { key: "mm", label: "Market making", short: "MM", color: MM_COLOR },
  { key: "inventory", label: "Inventory PnL", short: "Inv", color: INVPNL_COLOR },
  { key: "hedge", label: "Hedge", short: "Hedge", color: HEDGE_COLOR },
  { key: "rebates", label: "Rebates", short: "Reb", color: REBATE_COLOR },
  { key: "other", label: "Other", short: "Other", color: "#5b6474" },
] as const;
export type PartKey = (typeof PARTS)[number]["key"];

export const PART_INFO: Record<PartKey, string> = {
  mm: "Each fill against the mid 60 s after it, minus fees. USDT.",
  inventory: "Trading PnL minus market making: what the held inventory made after the first 60 s of each fill. USDT.",
  hedge: "The futures legs: price at mark, minus fees, plus funding. USDT.",
  rebates: "Market-maker rebates Binance credited that day. USDT.",
  other: "Day PnL minus trading PnL, the hedge legs and the rebates. USDT.",
};

// ---- instruments and fills (Desk, Instruments, Instrument) ----

/** An instrument's spot PnL today: market making plus inventory. */
export const instPnl = (r: SymbolRow) => r.mm_pnl + r.inv_pnl;

/** "BTCUSDT perp", with "dust" when the balance is below the minimum notional. */
export function InstName({ r }: { r: Pick<SymbolRow, "symbol" | "venue" | "dust"> }) {
  return (
    <>
      {r.symbol}
      {r.venue === "usdm" && <Tag>perp</Tag>}
      {r.dust && <Tag>dust</Tag>}
    </>
  );
}

/** A signed bps figure with its unit, colored by sign (none when it reads 0.0); a dash when there is none. */
export function Bps({ v, unit = true }: { v: number | null | undefined; unit?: boolean }) {
  const t = bps(v);
  return (
    <span className={"m-fig " + tone(v, t)}>
      {t}
      {unit && v != null && <span className="m-unit">bps</span>}
    </span>
  );
}

/** A quantity, or ••• with Hide amounts on: a size gives the amount away even where the price does not. */
export function useQty(): (v: number | null | undefined, sign?: boolean) => string {
  const hide = useStore((s) => s.hideAmounts);
  return (v, sign) => (hide && v != null ? "•••" : qty(v, sign));
}

/** An account's label for its id (the id itself while the account is unknown). */
export function useAccountLabel(id: string): string {
  return useStore((s) => s.snap?.accounts.find((a) => a.id === id)?.label ?? id);
}

/** One instrument: name / "inventory 4.2k · 10 s +0.8 bps"; PnL / a second figure (`side`, default the fills). */
export function InstrumentRow({ r, pnl, sub, side }: { r: SymbolRow; pnl?: number | null; sub?: ReactNode; side?: ReactNode }) {
  const money = useMoney();
  return (
    <ListRow
      title={<InstName r={r} />}
      subtitle={sub ?? `inventory ${money(r.inv_value, "short")} · 10 s ${bps(r.mk10_bps)} bps`}
      primary={<Money v={pnl === undefined ? instPnl(r) : pnl} />}
      secondary={side ?? `${int(r.fills_day)} fills`}
      to={{ page: "desk", detail: { kind: "instrument", symbol: r.symbol, venue: r.venue } }}
    />
  );
}

/** The figure a fill row shows at the right of its second line: the edge, or one markout horizon. */
export type FillFig = "edge" | keyof Markouts;
export const FILL_FIG_LABEL: Record<FillFig, string> = { edge: "edge", "1": "1 s", "10": "10 s", "60": "60 s", "300": "300 s" };
const fillFig = (f: Fill, k: FillFig) => (k === "edge" ? f.edge_bps : f.mk[k]);

/**
 * One fill, the same everywhere (Desk, Instrument, Account, Fills): "ETH + buy" · notional / "16:02:11 · sub-a" ·
 * "edge +0.8 bps". `symbol={false}` on the instrument's own page, `account={false}` where the account is implied.
 * Tap opens every field in the fill sheet.
 */
export const FillRow = memo(function FillRow({
  f,
  onOpen,
  symbol = true,
  account = true,
  fig = "edge",
}: {
  f: Fill;
  onOpen: (f: Fill) => void;
  symbol?: boolean;
  account?: boolean;
  fig?: FillFig;
}) {
  const tz = useStore((s) => s.tz);
  const label = useAccountLabel(f.account);
  const money = useMoney();
  const v = fillFig(f, fig);
  return (
    <ListRow
      dense
      className="m-fillrow"
      title={
        <>
          {symbol && (
            <>
              {f.symbol.replace(/USDT$/, "")}
              {f.venue === "usdm" && <Tag>perp</Tag>}
            </>
          )}
          <Side side={f.side} />
          {!f.maker && <Tag>taker</Tag>}
        </>
      }
      subtitle={account ? `${hms(f.ts, tz)} · ${label}` : hms(f.ts, tz)}
      primary={money(f.notional, "short")}
      secondary={
        <>
          {FILL_FIG_LABEL[fig]} <Bps v={v} />
        </>
      }
      onClick={() => onOpen(f)}
    />
  );
});

/** The fill sheet a page mounts once: `open(f)` shows it, `sheet` is the element to render. It follows the fill
 *  while it is in the store, so markouts fill in as their horizons pass. */
export function useFillSheet() {
  const [f, setF] = useState<Fill | null>(null);
  const [opened, setOpened] = useState(false);
  const live = useStore((s) => (f && opened ? s.snap?.fills.find((x) => x.id === f.id) : undefined));
  const cur = live ?? f;
  const open = useCallback((x: Fill) => {
    setF(x);
    setOpened(true);
  }, []);
  return {
    open,
    sheet: (
      <Sheet
        opened={opened}
        onClose={() => setOpened(false)}
        title={
          cur ? (
            <>
              {cur.symbol}
              {cur.venue === "usdm" && " perp"} <Side side={cur.side} />
            </>
          ) : null
        }
      >
        {cur && <FillFields f={cur} />}
      </Sheet>
    ),
  };
}

const HS: (keyof Markouts)[] = ["1", "10", "60", "300"];

export interface MkRowData {
  label: string;
  /** Definition of the row (not inside a sheet: a sheet never opens another). */
  info?: string;
  /** The edge at the fill; undefined leaves the cell empty (rows that do not depend on it). */
  edge?: number | null;
  v: (number | null | undefined)[];
}

/** The markouts matrix, one header set everywhere (Instrument, Markouts, the fill sheet): bps · Edge · 1 s … */
export function MkTable({ rows, horizons = [1, 10, 60, 300] }: { rows: MkRowData[]; horizons?: number[] }) {
  const cell = (v: number | null | undefined, k: number) => (
    <td key={k} className={tone(v, bps(v))}>
      {bps(v)}
    </td>
  );
  return (
    <div className="m-mk-wrap">
      <table className="m-mk m-fig">
        <thead>
          <tr>
            <th scope="col">bps</th>
            <th scope="col">Edge</th>
            {horizons.map((h) => (
              <th key={h} scope="col">
                {h} s
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.label}>
              <th scope="row">{r.info ? <InfoLabel label={r.label} info={r.info} /> : r.label}</th>
              {r.edge === undefined ? <td /> : cell(r.edge, -1)}
              {horizons.map((_, i) => cell(r.v[i], i))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function FillFields({ f }: { f: Fill }) {
  const tz = useStore((s) => s.tz);
  const route = useStore((s) => s.route);
  const money = useMoney();
  const q = useQty();
  const label = useAccountLabel(f.account);
  // no link to the page the sheet was opened on
  const here = route.detail?.kind === "instrument" && route.detail.symbol === f.symbol && route.detail.venue === f.venue;
  return (
    <div className="m-body">
      <KV
        cols={3}
        items={[
          { label: "Time", value: hms(f.ts, tz) + (tz === "utc" ? " UTC" : "") },
          { label: "Account", value: label },
          { label: "Role", value: f.maker ? "maker" : "taker" },
          { label: "Price", value: price(f.price) },
          { label: "Quantity", value: q(f.qty) },
          { label: "Notional (USDT)", value: money(f.notional, "usd") },
          { label: "Fair", value: price(f.fair) },
          { label: "Fee", value: `${f.fee_asset === "USDT" ? money(f.fee, "usd") : q(f.fee)} ${f.fee_asset}`, span: 2 },
        ]}
      />
      <MkTable
        rows={[
          { label: "Net 1 s", edge: f.edge_bps, v: HS.map((h) => f.mk[h]) },
          { label: "Net 0.2 s", v: HS.map((h) => f.mk_fast[h]) },
          { label: "Raw", v: HS.map((h) => f.mk_raw[h]) },
        ]}
      />
      {!here && (
        <ListRow
          dense
          title={
            <>
              Open {f.symbol}
              {f.venue === "usdm" && <Tag>perp</Tag>}
            </>
          }
          to={{ page: "desk", detail: { kind: "instrument", symbol: f.symbol, venue: f.venue } }}
        />
      )}
    </div>
  );
}

/** The exposure band in a definition: what it allows and how it moves. */
export const bandDef = (band: string) =>
  `The band, ±${band}, is the gap allowed: the larger of a fixed amount and a share of the target, so it moves with the target. ` +
  "Past it the bar turns red at once; the alert waits a minute.";

// ---- accounts: definitions from the desktop's tips, figure table, positions (Accounts, Account) ----

export const TIP = {
  equity: "Spot balances at mid (stablecoins at 1) plus futures margin balance, USDT.",
  dayPnl: "Equity now − equity at the day start − net transfers in since then, USDT.",
  o10: "Orders placed in the last 10 s against the Binance limit.",
  o1d: "Orders placed today as a share of the Binance daily limit.",
  bid: "The share of the account's USDT tied up in its resting buy orders: resting bids ÷ (free USDT + resting bids).",
  notional: "Amount × mark, USDT. Negative = short.",
  upnl: "Unrealized PnL at mark against the entry price, USDT. Not today's result: see Today.",
  today:
    "Today's P&L on the symbol: the position held at the day start and today's fills marked to mark now, minus fees, plus funding, USDT.",
};


/** Decimals for a column of usage percentages: one where two accounts would read the same below 100 %. */
export function pctDigits(shares: number[]): number {
  const r = shares.filter((x) => Number.isFinite(x) && x < 1).map((x) => Math.round(100 * x));
  return new Set(r).size < r.length ? 1 : 0;
}

/** Each account's order rate against Binance's limits, one row per account under the measure's heading: Orders
 *  10 s as "17 / 100", Orders 1 d as a percentage. The headings carry the definitions; the rows only read. */
export function RateSections({ accounts }: { accounts: Account[] }) {
  if (!accounts.length) return null;
  const lim1d = accounts.find((a) => a.orders_1d_limit > 0)?.orders_1d_limit;
  const digits = pctDigits(accounts.filter((a) => a.orders_1d_limit > 0).map((a) => a.orders_1d / a.orders_1d_limit));
  return (
    <>
      <Section title="Orders 10 s" info={`${TIP.o10} Amber from 80 %, red at the limit.`}>
        {accounts.map((a) => (
          <RateMeter key={a.id} label={a.label} value={a.orders_10s} limit={a.orders_10s_limit} />
        ))}
      </Section>
      <Section
        title="Orders 1 d"
        info={`${TIP.o1d}${lim1d ? ` The limit is ${lim1d >= 10_000 ? `${int(lim1d / 1000)}k` : int(lim1d)} orders a day.` : ""} Amber from 80 %, red at the limit.`}
      >
        {accounts.map((a) => (
          <RateMeter key={a.id} label={a.label} value={a.orders_1d} limit={a.orders_1d_limit} pct digits={digits} />
        ))}
      </Section>
    </>
  );
}

// ---- figure table: a name column and up to three right-aligned figure columns, a second line per row ----

export interface FigCol {
  label: string;
  info?: string;
}
export interface FigRow {
  key: string;
  title: ReactNode;
  cells: ReactNode[];
  /** A muted line under the row, across the full width. */
  sub?: ReactNode;
  tone?: "warn";
}

/** Columns line up from row to row (one grid); the header labels open their definitions. */
export function FigTable({ head, cols, rows }: { head?: ReactNode; cols: FigCol[]; rows: FigRow[] }) {
  return (
    <div className="m-ftab" style={{ ["--ft-n" as string]: cols.length }}>
      <div className="m-ftab-head">
        <span>{head}</span>
        {cols.map((c) => (
          <span key={c.label} className={"m-ftab-h" + (c.info ? " m-tap" : "")} {...defineProps(c.label, c.info)}>
            <DefinedLabel label={c.label} info={c.info} />
          </span>
        ))}
      </div>
      {rows.map((r) => (
        <div key={r.key} className={"m-ftab-row" + (r.sub ? " two" : "") + (r.tone ? " " + r.tone : "")}>
          <span className="m-ftab-title">{r.title}</span>
          {r.cells.map((c, i) => (
            <span key={i} className="m-ftab-cell m-fig">
              {c}
            </span>
          ))}
          {r.sub != null && <span className="m-ftab-sub m-fig">{r.sub}</span>}
        </div>
      ))}
    </div>
  );
}

export type PosRow = Position & { account: string };

export function PositionsTable({ rows, showAccount }: { rows: PosRow[]; showAccount: boolean }) {
  const q = useQty();
  return (
    <FigTable
      cols={[
        { label: "Notional", info: TIP.notional },
        { label: "uPnL", info: TIP.upnl },
        { label: "Today", info: TIP.today },
      ]}
      rows={rows.map((p) => ({
        key: p.account + ":" + p.symbol,
        title: (
          <>
            {p.symbol}
            <Tag>
              <Side side={p.amt >= 0 ? "buy" : "sell"} words={["long", "short"]} />
            </Tag>
          </>
        ),
        cells: [
          <Money v={p.notional} kind="pnlShort" color={false} />,
          <Money v={p.upnl} kind="pnlShort" />,
          <Money v={p.pnl_day} kind="pnlShort" />,
        ],
        sub: (
          <>
            {showAccount && <span className="m-ftab-acc">{p.account}</span>}
            {q(p.amt, true)} · entry {price(p.entry)} · mark {price(p.mark)}
          </>
        ),
      }))}
    />
  );
}


// ---- engine figures (Engine, Alert) ----

/** Microseconds as "11.4 µs" or "7.90 ms". */
export function us(v: number | null): string {
  if (v == null) return "—";
  if (v >= 1000) return num(v / 1000, 2) + " ms";
  return num(v, 1) + " µs";
}

const SILENT_MS = 45_000;
const QUIET_MS = 10_000;

/** A feed's state for the health list: up, silent (up but nothing arriving), flapping (reconnecting over and
 *  over: an active alert names it, or its detail counts reconnects) or down. */
export type FeedState = "up" | "silent" | "flapping" | "down";

/** The active stream alerts that name a feed (their text starts with its name, or their id ends with it). */
function alertsOn(f: Feed, alerts: readonly Alert[] | undefined): Alert[] {
  return (alerts ?? []).filter(
    (a) =>
      a.active &&
      (a.rule === "user_stream" || a.rule === "stream_silent" || a.rule === "stream_down") &&
      (a.text.startsWith(f.name + " ") || a.id.endsWith(":" + f.name)),
  );
}

export function feedState(f: Feed, now: number, alerts?: readonly Alert[]): FeedState {
  if (!f.up) return "down";
  const on = alertsOn(f, alerts);
  if (on.some((a) => a.rule === "user_stream") || /reconnect/i.test(f.detail)) return "flapping";
  if (on.some((a) => a.rule === "stream_silent")) return "silent";
  if (f.kind === "public" && f.last != null && now - f.last > SILENT_MS) return "silent";
  // up, but nothing has come for a while (not a user stream: an account that is not trading sends nothing)
  if (f.kind !== "user" && f.msgs_per_s === 0 && f.last != null && now - f.last > QUIET_MS) return "silent";
  return "up";
}

/** The feeds in a line, as Engine and More both write it: "12 up · 1 flapping"; `worst` tints it. */
export function feedSummary(feeds: readonly Feed[], now: number, alerts?: readonly Alert[]) {
  const n: Record<FeedState, number> = { up: 0, silent: 0, flapping: 0, down: 0 };
  for (const f of feeds) n[feedState(f, now, alerts)]++;
  const text = [`${int(n.up)} up`, ...(["silent", "flapping", "down"] as const).filter((k) => n[k] > 0).map((k) => `${int(n[k])} ${k}`)].join(" · ");
  const worst: "ok" | "warn" | "crit" = n.down ? "crit" : n.silent + n.flapping ? "warn" : "ok";
  return { text, worst, n };
}

/** Why a feed needs a look: "down", "silent 52s", "flapping", or null. */
export function feedProblem(f: Feed, now: number, alerts?: readonly Alert[]): string | null {
  const st = feedState(f, now, alerts);
  if (st === "up") return null;
  if (st === "silent" && f.last != null) return `silent ${span(now - f.last)}`;
  return st;
}

const KIND: Record<Feed["kind"], string> = { public: "market data", user: "user stream", rest: "REST poller", engine: "engine metrics" };
// Binance's names for how a user stream connects: shown in the feed's sheet, not in the list
const RAW = /^(listenKey|ws-api)$/;
const RAW_WORD: Record<string, string> = { listenKey: "listen key (the older user data stream)", "ws-api": "WebSocket API subscription" };

export function FeedRow({ f, now, alerts }: { f: Feed; now: number; alerts?: readonly Alert[] }) {
  const tz = useStore((s) => s.tz);
  const st = feedState(f, now, alerts);
  const bad = feedProblem(f, now, alerts);
  const why = alertsOn(f, alerts);
  const detail = RAW.test(f.detail) ? "" : f.detail;
  const info =
    `${KIND[f.kind].charAt(0).toUpperCase() + KIND[f.kind].slice(1)}. ` +
    (st === "down"
      ? "Disconnected."
      : st === "flapping"
        ? "Connected, but it keeps reconnecting: updates may lag or be lost between reconnects."
        : st === "silent"
          ? "Connected, but nothing has arrived for a while."
          : "Connected, messages arriving.") +
    `\n\nMessages: ${num(f.msgs_per_s, 1)} / s; last ${f.last != null ? `${hms(f.last, tz)} (${span(now - f.last)} ago)` : "none yet"}.` +
    (f.detail ? `\n\nConnection: ${RAW.test(f.detail) ? `${f.detail}, ${RAW_WORD[f.detail]}` : f.detail}.` : "") +
    (why.length ? `\n\nAlert: ${why.map((a) => a.text).join("; ")}.` : "");
  return (
    <ListRow
      dot={<Dot ok={st === "up"} warn={st === "silent" || st === "flapping"} />}
      title={f.name}
      tone={st === "down" ? "crit" : bad ? "warn" : undefined}
      subtitle={[KIND[f.kind], detail].filter(Boolean).join(" · ")}
      primary={
        bad ? (
          <span className={st === "down" ? "m-ops-crit" : "warn-text"}>{bad}</span>
        ) : (
          <span className="m-fig">
            {num(f.msgs_per_s, f.msgs_per_s < 10 ? 1 : 0)}
            <span className="m-unit">/s</span>
          </span>
        )
      }
      secondary={bad?.startsWith("silent") ? undefined : f.last != null ? `last ${span(now - f.last)}` : "no message yet"}
      chevron={false}
      onClick={() => showInfo(f.name, info)}
    />
  );
}

/** The engine's own figures: PnL, counters, metrics age. */
export function EngineFacts({ e, spike }: { e: Engine; spike?: boolean }) {
  const money = useMoney();
  return (
    <KV
      cols={3}
      items={[
        {
          label: "Realized",
          info: `${ENGINE_BOOKS} Realized: what its closed trades made since it started, USDT.`,
          value: money(e.realized),
          v: e.realized,
        },
        {
          label: "Unrealized",
          info: `${ENGINE_BOOKS} Unrealized: its open position at its own marks, USDT.`,
          value: money(e.unrealized),
          v: e.unrealized,
        },
        { label: "Fees", info: "Fees paid, USDT.", value: money(e.fees, "usd") },
        { label: "Orders", info: "Orders sent by the engine (counter from its metrics).", value: int(e.orders) },
        { label: "Cancels", info: "Cancels sent by the engine.", value: int(e.cancels) },
        { label: "Fills", info: "Fills received by the engine.", value: int(e.fills) },
        {
          label: "Risk rejects",
          info: "Orders the engine's own risk checks refused, since it started.",
          value: int(e.risk_rejects),
        },
        {
          label: "Venue rejects",
          info: "Orders the exchange rejected, since the engine started. Amber while an alert says they spiked.",
          value: int(e.venue_rejects),
          tone: spike ? "warn" : undefined,
        },
        {
          label: "Last metrics",
          info: "When the monitor last read the engine's figures (it reads them about once a second). Over 5 s old raises an alert.",
          value: `${num(e.stale_s, 1)} s ago`,
          tone: e.stale_s > 5 ? "warn" : undefined,
        },
      ]}
    />
  );
}

const ENGINE_BOOKS =
  "The engine's own books, since it started: they differ from the Desk's Day PnL, which is the accounts' equity change since the day start, net of transfers, and includes the hedge and rebates.";

// the engine's step names, in words
const STEP: Record<string, string> = {
  "md to decision": "market data to decision",
  "decision to send": "decision to send",
};

/** True while an active engine alert on this engine says its venue rejects spiked. */
export function useRejectSpike(name: string): boolean {
  return useStore(
    (s) =>
      s.snap?.alerts.some(
        (a) => a.active && a.rule === "engine" && (a.id === `engine:${name}` || a.text.startsWith(name + " ")) && /reject/i.test(a.text),
      ) ?? false,
  );
}

/** Latency, one row per measured step: p50 and p99. */
export function LatencyTable({ e, p99Limit }: { e: Engine; p99Limit?: number | null }) {
  if (!e.latency.length) return null;
  return (
    <div className="m-ops-tbl" role="table">
      <div className="m-ops-tr head" role="row">
        <span role="columnheader">Latency</span>
        <span role="columnheader" className="m-tap" {...defineProps("p50", "Median latency of the step.")}>
          <span className="m-defined">p50</span>
        </span>
        <span role="columnheader" className="m-tap" {...defineProps("p99", "99th percentile latency of the step: 1 in 100 is slower.")}>
          <span className="m-defined">p99</span>
        </span>
      </div>
      {e.latency.map((l) => (
        <div className="m-ops-tr" role="row" key={l.name}>
          <span role="cell">{STEP[l.name] ?? l.name}</span>
          <span role="cell" className="m-fig">{us(l.p50_us)}</span>
          <span
            role="cell"
            className={"m-fig" + (p99Limit != null && l.p99_us != null && l.p99_us > p99Limit ? " warn-text" : "")}
          >
            {us(l.p99_us)}
          </span>
        </div>
      ))}
    </div>
  );
}

/** The loss that would trip the engine's kill: −(realized + unrealized) against its max loss. */
export function KillBar({ e }: { e: Engine }) {
  const money = useMoney();
  if (e.max_loss == null) return null;
  const loss = Math.max(0, -(e.realized + e.unrealized));
  return (
    <LimitBar
      label="Loss limit"
      info={`The engine stops itself (its kill switch) when its own loss reaches ${money(e.max_loss, "usd")} USDT. The bar is its loss now, realized plus unrealized: ${money(e.realized + e.unrealized)} USDT; empty while it is making money.`}
      value={loss}
      limit={e.max_loss}
    />
  );
}

/** Engine state in a word with its dot: "running", "down", "killed". */
export function EngineState({ e }: { e: Engine }) {
  const word = !e.up ? "down" : e.kill ? "killed" : e.state;
  const ok = e.up && !e.kill && e.state === "running";
  return (
    <span className={"m-ops-state " + (ok ? "" : !e.up || e.kill ? "m-ops-crit" : "warn-text")}>
      <Dot ok={ok} warn={e.up && !e.kill} />
      {word}
    </span>
  );
}
