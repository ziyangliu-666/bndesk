// Pieces more than one phone page shows (an instrument row, a fill, the account and alert definitions, the
// engine's figures, the history loader). Kept here so each page stays its own chunk.
import { memo, useCallback, useEffect, useRef, useState } from "react";
import {
  InfoLabel,
  KV,
  LimitBar,
  ListRow,
  Sheet,
  showInfo,
  Side,
  span,
  Tag,
  tone,
  useMoney,
} from "../../components/mobile";
import { bps, hms, int, num, price, stepName } from "../../format";
import { useQty } from "../../mask";
import { usePageVisible } from "../../hooks";
import type { Alert, Engine, Feed, Fill, Markouts, SymbolRow } from "../../protocol";
import { useStore } from "../../store";
import { PNL_COLORS, PNL_STROKES } from "../../theme";
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

// the parts of a day, in the desk's split palette (theme.ts PNL_COLORS, with its strokes): the chart's legend,
// chips and the split lists use the same
const P = PNL_COLORS;
const S = PNL_STROKES;
export const PARTS = [
  { key: "mm", label: "Market making", short: "MM", color: P.mm, stroke: S.mm },
  { key: "inventory", label: "Inventory PnL", short: "Inv", color: P.inv, stroke: S.inv },
  { key: "hedge", label: "Hedge", short: "Hedge", color: P.hedge, stroke: S.hedge },
  { key: "rebates", label: "Rebates", short: "Rebates", color: P.reb, stroke: S.reb },
  { key: "other", label: "Other", short: "Other", color: P.other, stroke: S.other },
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


/** "BTCUSDT perp", with "dust" when the balance is below the minimum notional. */
export function InstName({ r }: { r: Pick<SymbolRow, "symbol" | "venue" | "dust"> }) {
  return (
    <>
      {r.symbol}
      {r.venue === "usdm" && <Tag>Perp</Tag>}
      {r.dust && <Tag>Dust</Tag>}
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
export { useQty };

/** An account's label for its id (the id itself while the account is unknown). */
export function useAccountLabel(id: string): string {
  return useStore((s) => s.snap?.accounts.find((a) => a.id === id)?.label ?? id);
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
  const q = useQty();
  const v = fillFig(f, fig);
  const usdt = money(f.notional, "short");
  return (
    <ListRow
      dense
      className="m-fillrow"
      title={
        <>
          {symbol && (
            <>
              {f.symbol.replace(/USDT$/, "")}
              {f.venue === "usdm" && <Tag>Perp</Tag>}
            </>
          )}
          {f.conversion && <Tag>conversion</Tag>}
          <Side side={f.side} />
          {!f.maker && <Tag>taker</Tag>}
        </>
      }
      subtitle={account ? `${hms(f.ts, tz)} · ${label}` : hms(f.ts, tz)}
      // as an exchange's trade list: amount @ price, then the notional and the edge (or a markout)
      primary={
        <span className="m-fig">
          {q(f.qty)} <span className="m-at">@</span> {price(f.price)}
        </span>
      }
      secondary={
        <>
          {usdt}
          {usdt !== "--" && <span className="m-unit">USDT</span>} · {FILL_FIG_LABEL[fig]} <Bps v={v} />
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
              {cur.venue === "usdm" && " Perp"} <Side side={cur.side} />
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
              {f.venue === "usdm" && <Tag>Perp</Tag>}
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
  equity: "Spot balances at mid (USDT at 1, other stablecoins at their USDT pair) plus futures margin balance, USDT.",
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

// ---- engine figures (Engine, Alert) ----

/** Microseconds in one unit down the page, as the desktop's System: "11.4 µs", "7,900 µs". */
export function us(v: number | null): string {
  if (v == null) return "--";
  return num(v, v >= 100 ? 0 : 1) + " µs";
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
          info: `${ENGINE_BOOKS} Realized: what its closed trades made since it started; Unrealized: its open position at its own marks. USDT.`,
          value: money(e.realized),
          v: e.realized,
        },
        {
          label: "Unrealized",
          value: money(e.unrealized),
          v: e.unrealized,
        },
        // a cost, signed as one (as the hedge legs' fees)
        { label: "Fees", value: money(e.fees == null ? null : -e.fees), v: e.fees == null ? null : -e.fees },
        { label: "Orders", value: int(e.orders) },
        { label: "Cancels", value: int(e.cancels) },
        { label: "Fills", value: int(e.fills) },
        {
          label: "Risk rejects",
          value: int(e.risk_rejects),
        },
        {
          label: "Venue rejects",
          value: int(e.venue_rejects),
          tone: spike ? "warn" : undefined,
        },
        {
          label: "Last metrics",
          value: `${num(e.stale_s, 1)} s ago`,
          tone: e.stale_s > 5 ? "warn" : undefined,
        },
      ]}
    />
  );
}

const ENGINE_BOOKS =
  "The engine's own books, since it started: they differ from the Desk's Day PnL, which is the accounts' equity change since the day start, net of transfers, and includes the hedge and rebates.";


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
        <span role="columnheader">p50</span>
        <span role="columnheader">p99</span>
      </div>
      {e.latency.map((l) => (
        <div className="m-ops-tr" role="row" key={l.name}>
          <span role="cell">{stepName(l.name)}</span>
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

/** Engine state in a word: "running", "down", "killed". */
export function EngineState({ e }: { e: Engine }) {
  const word = !e.up ? "down" : e.kill ? "killed" : e.state;
  const ok = e.up && !e.kill && e.state === "running";
  return (
    <span className={"m-ops-state " + (ok ? "" : !e.up || e.kill ? "m-ops-crit" : "warn-text")}>
      {word}
    </span>
  );
}
