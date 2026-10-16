import { useMemo, useRef } from "react";
import { isHidden, serverNow, useStore } from "../../store";
import { useNow } from "../../hooks";
import { hm, int, num, usdShort } from "../../format";
import { Dot, LevelIcon } from "../../components/ui";
import { DayChart } from "../../components/DayChart";
import {
  Hero,
  KV,
  LazyMount,
  LimitBar,
  ListRow,
  Money,
  RateMeter,
  Section,
  Sparkline,
  SplitRows,
  Tag,
  useHold,
  useLive,
  useMoney,
} from "../../components/mobile";
import type { Account, Exposure } from "../../protocol";
import { Bps, FillRow, instPnl, InstrumentRow, useFillSheet } from "./shared";
import { RULES, alertText, byUrgency, heldFor } from "./rules";
import "./desk.css";

/** How often the Desk takes the store's figures: twice a second is live to the eye, and a slow phone keeps up. */
const PAGE_MS = 500;

// Desk, the phone's home: is anything wrong, what did the day make and from what, how close to the limits,
// then who made it (movers, accounts), the day's shape, and the latest fills.
export function DeskM() {
  // the page redraws at most twice a second (useLive hands its values over together)
  const sm = useLive((s) => s.snap?.summary, PAGE_MS);
  const exposure = useLive((s) => s.snap?.exposure, PAGE_MS);
  const accounts = useLive((s) => s.snap?.accounts, PAGE_MS);
  // the movers and the latest fills hold still under a resting finger
  const [held, hold] = useHold();
  const symbols = useLive((s) => s.snap?.symbols, PAGE_MS, held);
  const fills = useLive((s) => s.snap?.fills, PAGE_MS, held);
  const series = useStore((s) => s.snap?.series);
  const reconcile = useStore((s) => s.snap?.alerts.some((a) => a.active && a.rule === "reconcile") ?? false);
  const tz = useStore((s) => s.tz);
  const money = useMoney();
  const spark = useMemo(() => (series ?? []).map((p) => p.pnl_day), [series]);
  // the three that made the most and the three that lost the most: "which coin is losing money" is a look
  const [best, worstSyms] = useMemo(() => {
    const xs = (symbols ?? []).filter((r) => r.venue === "spot" && instPnl(r) !== 0).sort((a, b) => instPnl(b) - instPnl(a));
    return [xs.filter((r) => instPnl(r) > 0).slice(0, 3), xs.filter((r) => instPnl(r) < 0).reverse().slice(0, 3)];
  }, [symbols]);
  const fill = useFillSheet();
  const o10 = useSticky(accounts ?? [], (a) => [a.orders_10s, a.orders_10s_limit]);
  const o1d = useSticky(accounts ?? [], (a) => [a.orders_1d, a.orders_1d_limit]);
  if (!sm || !exposure) return null;
  const p = sm.pnl;
  const hedge = exposure.hedge_day?.hedge_pnl ?? null;
  const lastT = series?.length ? series[series.length - 1]!.t : null;
  const zone = tz === "utc" ? " UTC" : "";
  const accts = accounts ?? [];
  const equity = accts.reduce((s, a) => s + a.equity, 0);
  const mk = sm.markout_net_bps_1h;
  const invSub = (v: number) => (money(v, "short") === "0.00" ? "no inventory" : `inventory ${money(v, "short")}`);

  return (
    <>
      <AlertStrip />

      {/* the day's result, then the parts it is made of: the last bar ends at the hero's figure */}
      <Section>
        <Hero
          label="Day PnL"
          info={`Equity change since ${hm(sm.day_start, tz)}${zone}, net of transfers; 1h is the change over the last hour.`}
          v={sm.pnl_day}
          sub={
            <>
              1h <Money v={sm.pnl_1h} />
            </>
          }
        >
          <Sparkline
            values={spark}
            height={48}
            range={(v) => (usdShort(v) === usdShort(sm.pnl_day) ? "" : money(v, "pnlShort"))}
            ends={[hm(sm.day_start, tz), lastT != null ? hm(lastT, tz) + zone : ""]}
          />
        </Hero>
        <SplitRows
          waterfall
          rows={[
            {
              key: "mm",
              label: "Market making",
              info: `Each fill against the mid 60 s after it, minus fees. Against the fair at the fill instead: ${money(p.mm_spread)} USDT.`,
              v: p.mm,
            },
            {
              key: "inv",
              label: "Inventory PnL",
              info: "Trading PnL minus market making: what the inventory made after the first 60 s of each fill.",
              v: p.inventory,
            },
            { key: "hedge", label: "Hedge", info: "The futures legs since the day start: price at mark, minus fees, plus funding.", v: hedge },
            {
              key: "reb",
              label: "Rebates",
              info: "Market-maker rebates Binance credited since the day start, hourly per account; trading fees do not show them.",
              v: sm.rebates,
            },
            {
              key: "other",
              label: "Other",
              info:
                "Day PnL minus trading PnL, the hedge and the rebates." +
                (reconcile ? "\n\nA reconcile alert is active: a fill, transfer or asset the desk does not see." : ""),
              v: sm.other,
              tone: reconcile ? "warn" : undefined,
            },
          ]}
        />
      </Section>

      <Section title="Risk">
        <ExposureBar x={exposure} />
        {o10 && (
          <RateMeter
            label="Orders 10 s"
            who={o10.a.label}
            value={o10.v}
            limit={o10.lim}
            info={`New orders in the last 10 s against the venue's limit, for the account closest to it: ${o10.a.label}. Another account takes the row only once it is 5 points of the limit closer.`}
          />
        )}
        {o1d && (
          <RateMeter
            label="Orders 1 d"
            who={o1d.a.label}
            value={o1d.v}
            limit={o1d.lim}
            pct
            info={`Orders today against the venue's daily limit, for the account closest to it: ${o1d.a.label}, ${int(o1d.v)} of ${limitK(o1d.lim)}. Another account takes the row only once it is 5 points of the limit closer.`}
          />
        )}
      </Section>

      {/* activity: three figures, no heading; the 24 h and day counts live in their definitions */}
      <Section>
        <KV
          cols={3}
          items={[
            {
              label: "Fills / h",
              value: int(sm.fills_1h),
              info: `Fills in the last hour, all accounts. ${int(sm.fills_day)} today; ${int(sm.fills_24h)} spot fills of tracked markets in the last 24 h.`,
            },
            {
              label: "Volume",
              value: <Money v={sm.volume_day} kind="short" />,
              info: `Notional filled since the day start, USDT; ${money(sm.volume_24h, "short")} over the last 24 hours.`,
            },
            {
              label: "Markout 10 s",
              value: <Bps v={mk} />,
              info: "Last hour: the notional-weighted 10 s markout of the fills, net of the reference move.",
            },
          ]}
        />
      </Section>

      <div className="m-hold" {...hold}>
      {best.length > 0 && (
        <Section
          title="Best today · spot"
          info={INST_INFO}
          link={{ label: `All ${symbols?.length ?? 0}`, to: { page: "markets" } }}
        >
          {best.map((r) => (
            <InstrumentRow key={r.venue + r.symbol} r={r} sub={invSub(r.inv_value)} />
          ))}
        </Section>
      )}
      {worstSyms.length > 0 && (
        <Section
          title="Worst today · spot"
          info={INST_INFO}
          link={best.length ? undefined : { label: `All ${symbols?.length ?? 0}`, to: { page: "markets" } }}
        >
          {worstSyms.map((r) => (
            <InstrumentRow key={r.venue + r.symbol} r={r} sub={invSub(r.inv_value)} />
          ))}
        </Section>
      )}
      </div>

      <Section title="Accounts" right={<>equity {money(equity, "short")}</>}>
        {accts.map((a) => (
          <ListRow
            key={a.id}
            dot={<Dot ok={a.user_stream !== "down"} />}
            title={
              <>
                {a.label}
                {a.role === "master" && <Tag>master</Tag>}
                {a.user_stream === "down" && <Tag tone="crit">stream down</Tag>}
              </>
            }
            subtitle={`equity ${money(a.equity, "short")}`}
            primary={<Money v={a.pnl_day} />}
            to={{ page: "assets", detail: { kind: "account", id: a.id } }}
          />
        ))}
      </Section>

      <Section
        title="The day"
        info={
          "Day PnL: equity change since the day start, net of transfers. Trading PnL: market making plus inventory PnL. " +
          "Market making: each fill against the mid 60 s later, minus fees. Inventory PnL: trading PnL minus market making." +
          "\n\nVolume: notional filled per minute. Inventory and futures: notional, USDT." +
          "\n\nDrag sideways across the chart to read a minute. Tap a legend word to hide its line."
        }
        card={false}
      >
        <div className="m-desk-chart m-dim">
          <LazyMount height={300}>
            <DayChart phone height={220} />
          </LazyMount>
        </div>
      </Section>

      {fills && fills.length > 0 && (
        <div className="m-hold" {...hold}>
          <Section title="Latest fills" link={{ label: "All", to: { page: "fills" } }}>
            {fills.slice(0, 5).map((f) => (
              <FillRow key={f.id} f={f} onOpen={fill.open} />
            ))}
          </Section>
        </div>
      )}
      {fill.sheet}
    </>
  );
}

// ---- alert strip: the most urgent active alert, or nothing ----

function AlertStrip() {
  const alerts = useLive((s) => s.snap?.alerts, 1000);
  const keys = useStore((s) => s.hiddenAlerts);
  const tz = useStore((s) => s.tz);
  const hide = useStore((s) => s.hideAmounts);
  useNow(5000);
  // the Alerts tab's order: by level, then the one that has held longest; none hidden on this browser
  const active = useMemo(
    () => (alerts ?? []).filter((a) => a.active && a.level !== "info" && !isHidden(a, keys)).sort(byUrgency),
    [alerts, keys],
  );
  const top = active[0];
  if (!top) return null;
  const more = active.length - 1;
  return (
    <Section className="m-desk-alert">
      <ListRow
        lead={<LevelIcon level={top.level} size={18} />}
        tone={top.level === "crit" ? "crit" : "warn"}
        title={alertText(top, hide)}
        subtitle={`${RULES[top.rule]?.name ?? top.rule} · since ${hm(top.since, tz)}`}
        primary={<span className="m-fig">{heldFor(serverNow() - top.since)}</span>}
        to={{ page: "alerts", detail: { kind: "alert", id: top.id } }}
      />
      {more > 0 && (
        <ListRow dense className="m-desk-more" title={`${more} more ${more === 1 ? "alert" : "alerts"}`} to={{ page: "alerts" }} />
      )}
    </Section>
  );
}

// ---- risk ----

function ExposureBar({ x }: { x: Exposure }) {
  const money = useMoney();
  const beta = x.beta_source === "estimate" ? "β is the desk's estimate, which may differ from the engine's" : "β is configured per market";
  if (x.gap != null && x.band != null) {
    if (x.paused) {
      return (
        <LimitBar
          label="Hedge off"
          info={`${x.paused}: the hedge is off and its target is 0; the figure is the hedge symbols' futures notional still open, to be closed, against the band ±${money(x.band, "usd")}. USDT.`}
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
          `The band, ±${money(x.band, "usd")}, is the allowed size of the gap. USDT.`
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
      info={`Spot inventory value ${money(x.spot_value, "usd")} plus futures net notional ${money(x.futures_notional, "pnl")}, all accounts. No hedge band is set. USDT.`}
      value={x.net}
      limit={0}
      text={<Money v={x.net} color={false} />}
    />
  );
}

const INST_INFO =
  "Spot instruments by PnL today: market making plus inventory PnL, all accounts (the perps are the hedge, on Accounts). Best: the three that made the most; worst: the three that lost the most. Inventory: the holdings at mid, all accounts, USDT.";

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

/** A daily limit as the definitions write it: 160k. */
const limitK = (n: number) => (n >= 10_000 ? `${int(n / 1000)}k` : int(n));
