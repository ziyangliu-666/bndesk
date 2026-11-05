import { memo, useMemo, useRef } from "react";
import { UnstyledButton } from "@mantine/core";
import { IconEye, IconEyeOff } from "@tabler/icons-react";
import { isHidden, navigate, serverNow, useStore } from "../../store";
import { useEngineHedge } from "../strategy/engine";
import { useNow } from "../../hooks";
import { dayName, hm, int, num } from "../../format";
import { LevelIcon } from "../../components/ui";
import { LimitBar, ListRow, Money, RateMeter, Section, useHold, useLive, useMoney } from "../../components/mobile";
import { PNL_COLORS, PNL_STROKES, type Stroke } from "../../theme";
import { SeriesKey } from "../../components/ex";
import type { Account, Exposure, Fill } from "../../protocol";
import { FillRow, useFillSheet } from "./shared";
import { RULES, alertText, byUrgency, heldFor } from "./rules";
import { DeskChart } from "./desk/DeskChart";
import { QuotesLine } from "./desk/QuoteTouch";
import "./desk.css";
import { cur, useDesk, inventoryWord, hedgeWord } from "../../desk";
import { useRunningTotal } from "../desk/past";

/** The day's figures follow every message (8 a second); lists and the chart a little slower. */
const FIG_MS = 125;
const PAGE_MS = 250;
/** The quotes line's counts follow every message. */
const QUOTES_MS = 125;

// Desk, the phone's home: what the desk has made and its parts, over all the kept days (hero; today and the last
// hour under it), how it got there (the chart: P&L, equity,
// exposure), the quotes in one line (the map is Markets → Quotes), how close to the limits, the latest fills.
export function DeskM() {
  // the day's figures follow every message; the lists, chart and quotes take theirs 4 times a second
  const sm = useLive((s) => s.snap?.summary, FIG_MS);
  const exposure = useLive((s) => s.snap?.exposure, FIG_MS);
  const engine = useEngineHedge(useNow(5000) + useStore.getState().skew);
  const accounts = useLive((s) => s.snap?.accounts, PAGE_MS);
  // the latest fills hold still under a resting finger
  const [held, hold] = useHold();
  const fills = useLive((s) => s.snap?.fills, PAGE_MS, held);
  const reconcile = useStore((s) => s.snap?.alerts.some((a) => a.active && a.rule === "reconcile") ?? false);
  const tz = useStore((s) => s.tz);
  const fill = useFillSheet();
  const o10 = useSticky(accounts ?? [], (a) => [a.orders_10s, a.orders_10s_limit]);
  const o1d = useSticky(accounts ?? [], (a) => [a.orders_1d, a.orders_1d_limit]);
  // the parts with values of their own keep their element while the day's figures move 8 times a second
  const chartEl = useMemo(() => <DeskChart ms={PAGE_MS} />, []);
  const quotesEl = useMemo(() => <QuotesLine ms={QUOTES_MS} />, []);
  const desk = useDesk();
  const run = useRunningTotal(sm?.day_start);
  if (!sm || !exposure) return null;
  const p = sm.pnl;
  const hedge = exposure.hedge_day?.hedge_pnl ?? null;
  // the running total: today's figures on the earlier days' closes (null until those are in)
  const o = run?.total;
  const on = (v: number | null | undefined, d: number | undefined) => (v == null || d === undefined ? null : v + d);
  const since = run?.first != null ? `since ${dayName(run.first)}` : `since ${hm(sm.day_start, tz)}${tz === "utc" ? " UTC" : ""}`;
  const equity = (accounts ?? []).reduce((s, a) => s + a.equity, 0);
  const mk = sm.markout_net_bps_1h;

  return (
    <>
      <AlertLine />

      <DeskHero
        v={on(sm.pnl_day, o?.c)}
        since={since}
        day={sm.pnl_day}
        h1={sm.pnl_1h}
        equity={equity}
        parts={[
          ...(desk.mm
            ? [
                { key: "mm", label: "MM", color: PNL_COLORS.mm, stroke: PNL_STROKES.mm, v: on(p.mm, o?.mm) },
                { key: "inv", label: "Inv", color: PNL_COLORS.inv, stroke: PNL_STROKES.inv, v: on(p.inventory, o && o.trading - o.mm) },
              ]
            : [{ key: "trading", label: "Trading", color: PNL_COLORS.trading, stroke: PNL_STROKES.trading, v: on(p.trading, o?.trading) }]),
          ...(desk.hedge ? [{ key: "hedge", label: "Hedge", color: PNL_COLORS.hedge, stroke: PNL_STROKES.hedge, v: on(hedge, o?.hedge) }] : []),
          ...(desk.rebates ? [{ key: "reb", label: "Rebates", color: PNL_COLORS.reb, stroke: PNL_STROKES.reb, v: on(sm.rebates, o?.reb) }] : []),
          {
            key: "other",
            label: "Other",
            color: PNL_COLORS.other,
            stroke: PNL_STROKES.other,
            v: on(sm.other, o && o.c - o.trading - o.hedge - o.reb),
            tone: reconcile ? "warn" : undefined,
          },
        ]}
      />

      {/* the hedge on the first screen, under the day's P&L: "is the hedge OK" without a scroll */}
      <div className="dk-hedge-line">{engine ? <EngineHedgeBar e={engine} /> : <ExposureBar x={exposure} />}</div>

      <section className="dk-chart-sec">
        {chartEl}
      </section>

      {quotesEl}

      <Section title="Risk" className="dk-risk">
        {o10 && (
          <RateMeter
            label="Orders 10 s"
            who={o10.a.label}
            value={o10.v}
            limit={o10.lim}
          />
        )}
        {o1d && (
          <RateMeter
            label="Orders today"
            who={o1d.a.label}
            value={o1d.v}
            limit={o1d.lim}
            pct
          />
        )}

        {/* the pace of the day, one quiet line under the limits (not a strip of equal boxes) */}
        <div className="dk-pace m-fig">
          <span>
            Fills / h <b>{int(sm.fills_1h)}</b>
          </span>
          <span>
            Volume <b>{<Money v={sm.volume_day} kind="k" />}</b>
          </span>
          <span>
            Markout 10 s <b>{mk == null ? "--" : `${num(mk, 1, true)} bps`}</b>
          </span>
        </div>
      </Section>

      {fills && fills.length > 0 && (
        <div className="m-hold" {...hold}>
          <Section title="Latest fills" link={{ label: "All", to: { page: "fills" } }}>
            <LatestFills fills={fills} onOpen={fill.open} />
          </Section>
        </div>
      )}
      {fill.sheet}
    </>
  );
}

// ---- head: Day PnL on one line, clear but not giant; 1h, equity and the day's start a quiet line under it ----

function DeskHero({ v, since, day, h1, equity, parts }: { v: number | null; since: string; day: number; h1: number; equity: number; parts: Part[] }) {
  const hide = useStore((s) => s.hideAmounts);
  return (
    <section className="dk-hero">
      <div className="dk-hero-top">
        <span className="dk-hero-label">PnL</span>
        <span className="dk-hero-v">
          <Money v={v} />
        </span>
        <span className="dk-hero-unit">{cur()} {since}</span>
        <UnstyledButton
          className="dk-eye"
          aria-label={hide ? "Show amounts" : "Hide amounts"}
          aria-pressed={hide}
          onClick={() => useStore.getState().setHideAmounts(!hide)}
        >
          {hide ? <IconEyeOff size={18} stroke={1.75} /> : <IconEye size={18} stroke={1.75} />}
        </UnstyledButton>
      </div>
      {/* the parts that make the day, keyed as the chart's lines; in ink: the sign is in the text */}
      <div className="dk-hero-parts m-fig">
        {parts.map((r) => (
          <span key={r.key} className={r.tone ?? ""}>
            <SeriesKey color={r.color} stroke={r.stroke} />
            {r.label} <b>{<Money v={r.v} color={false} />}</b>
          </span>
        ))}
      </div>
      <div className="dk-hero-sub m-fig">
        <span>
          Today <b>{<Money v={day} color={false} />}</b>
        </span>
        <span>
          1h <b>{<Money v={h1} color={false} />}</b>
        </span>
        <span>
          Equity <b>{<Money v={equity} kind="full" />}</b>
        </span>
      </div>
    </section>
  );
}

interface Part {
  key: string;
  label: string;
  color: string;
  stroke: Stroke;
  v: number | null | undefined;
  tone?: "warn";
}

const LatestFills = memo(function LatestFills({ fills, onOpen }: { fills: Fill[]; onOpen: (f: Fill) => void }) {
  return (
    <>
      {fills.slice(0, 5).map((f) => (
        <FillRow key={f.id} f={f} onOpen={onOpen} />
      ))}
    </>
  );
});

// ---- the most urgent warning, one line (critical alerts are pinned under the top bar on every page) ----

function AlertLine() {
  const alerts = useLive((s) => s.snap?.alerts, 1000);
  const keys = useStore((s) => s.hiddenAlerts);
  const hide = useStore((s) => s.hideAmounts);
  useNow(5000);
  const active = useMemo(
    () => (alerts ?? []).filter((a) => a.active && a.level === "warn" && !isHidden(a, keys)).sort(byUrgency),
    [alerts, keys],
  );
  const top = active[0];
  if (!top) return null;
  const more = active.length - 1;
  return (
    <div className="dk-alert">
    <ListRow
      lead={<LevelIcon level={top.level} size={16} />}
      tone="warn"
      title={alertText(top, hide)}
      subtitle={`${RULES[top.rule]?.name ?? top.rule} · ${heldFor(serverNow() - top.since)}${more > 0 ? ` · ${more} more` : ""}`}
      to={more > 0 ? { page: "alerts" } : { page: "alerts", detail: { kind: "alert", id: top.id } }}
    />
    </div>
  );
}

// ---- risk ----

/** The engine's own hedge (when it is pushing): what Strategy shows, a tap away. */
function EngineHedgeBar({ e }: { e: NonNullable<ReturnType<typeof useEngineHedge>> }) {
  return (
    <button type="button" className="m-plain-btn" onClick={() => navigate({ page: "strategy" })}>
      <LimitBar
        label={e.word === "Within the band" ? "Hedge gap" : e.word}
        value={e.gap ?? 0}
        limit={e.band ?? 0}
        centered
      />
    </button>
  );
}

function ExposureBar({ x }: { x: Exposure }) {
  const money = useMoney();
  const beta = x.beta_source === "estimate" ? "β is the desk's estimate, which may differ from the engine's" : "β is configured per market";
  if (x.gap != null && x.band != null) {
    if (x.paused) {
      return (
        <LimitBar
          label="Hedge off"
          info={`${x.paused}: the hedge is off and its target is 0; the figure is the hedge symbols' futures notional still open, to be closed, against the band ±${money(x.band, "usd")}. ${cur()}.`}
          value={x.hedge_notional}
          limit={x.band}
          centered
          text={
            <>
              <span className="m-lim-of">closing </span>
              {money(x.hedge_notional, "pnl")}
            </>
          }
        />
      );
    }
    return (
      <LimitBar
        label="Exposure gap"
        info={
          `Hedge target minus the futures notional of the hedge symbols: the trade that closes it (negative = sell more). ` +
          `The target, ${money(x.target, "pnl")}, is −${num(x.ratio, 2)} × the beta-weighted spot value ${money(x.beta_value, "usd")}; ${beta}. ` +
          `The band, ±${money(x.band, "usd")}, is the allowed size of the gap. ${cur()}.`
        }
        value={x.gap}
        limit={x.band}
        centered
      />
    );
  }
  return (
    <LimitBar
      label="Net exposure"
      info={`${inventoryWord()} value ${money(x.spot_value, "usd")} plus ${hedgeWord()} net notional ${money(x.futures_notional, "pnl")}, all accounts. No hedge band is set. ${cur()}.`}
      value={x.net}
      limit={0}
      text={<Money v={x.net} color={false} />}
    />
  );
}

type Worst = { a: Account; v: number; lim: number };

// another account takes the row only when it is this much closer to its limit (5 points of the limit)
const STICK = 0.05;

/** The account closest to a limit, held while it stays about as close as any: two accounts near the same use
 *  would otherwise swap the row's name every few messages. */
function useSticky(accts: Account[], f: (a: Account) => [number, number]): Worst | null {
  const shown = useRef<string | null>(null);
  let w: Worst | null = null;
  let held: Worst | null = null;
  for (const a of accts) {
    const [v, lim] = f(a);
    if (!(lim > 0)) continue;
    if (!w || v / lim > w.v / w.lim) w = { a, v, lim };
    if (a.id === shown.current) held = { a, v, lim };
  }
  const pick = held && w && w.v / w.lim - held.v / held.lim <= STICK ? held : w;
  shown.current = pick?.a.id ?? null;
  return pick;
}
