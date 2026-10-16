import { useMemo, useRef, useState, type ReactNode } from "react";
import { UnstyledButton } from "@mantine/core";
import { IconEye, IconEyeOff } from "@tabler/icons-react";
import { isHidden, openMarkets, serverNow, useStore } from "../../store";
import { useNow } from "../../hooks";
import { hm, int, num } from "../../format";
import { LevelIcon } from "../../components/ui";
import { DefinedLabel, KV, LimitBar, ListRow, Money, RateMeter, Section, Segmented, defineProps, useHold, useLive, useMoney } from "../../components/mobile";
import { HEDGE_COLOR, INVPNL_COLOR, MM_COLOR, REBATE_COLOR } from "../../theme";
import type { Account, Exposure, SymbolRow } from "../../protocol";
import { Bps, FillRow, InstName, useFillSheet } from "./shared";
import { instPnl as instPnlOf } from "../../selectors";
import { pctOfMoney, useHide } from "../../mask";

/** A spot market's Trading PnL (the movers are spot only). */
const instPnl = (r: SymbolRow) => instPnlOf(r, null);
import { RULES, alertText, byUrgency, heldFor } from "./rules";
import { DeskChart } from "./desk/DeskChart";
import { QuotesMini } from "./desk/QuoteTouch";
import { QuoteLegend } from "../../components/quotes";
import "./desk.css";

/** How often the Desk takes the store's figures: twice a second is live to the eye, and a slow phone keeps up. */
const PAGE_MS = 500;
/** The quotes block moves faster: its dots are the point of it (a canvas redraw, no list to re-render). */
const QUOTES_MS = 250;

// Desk, the phone's home: what the day made and how it got there (hero, chart, the parts), where we quote now,
// how close to the limits, who made it, the latest fills.
export function DeskM() {
  // the page redraws at most twice a second (useLive hands its values over together)
  const sm = useLive((s) => s.snap?.summary, PAGE_MS);
  const exposure = useLive((s) => s.snap?.exposure, PAGE_MS);
  const accounts = useLive((s) => s.snap?.accounts, PAGE_MS);
  // the movers and the latest fills hold still under a resting finger
  const [held, hold] = useHold();
  const symbols = useLive((s) => s.snap?.symbols, PAGE_MS, held);
  const hide = useHide();
  const fills = useLive((s) => s.snap?.fills, PAGE_MS, held);
  const reconcile = useStore((s) => s.snap?.alerts.some((a) => a.active && a.rule === "reconcile") ?? false);
  const tz = useStore((s) => s.tz);
  const money = useMoney();
  const fill = useFillSheet();
  const o10 = useSticky(accounts ?? [], (a) => [a.orders_10s, a.orders_10s_limit]);
  const o1d = useSticky(accounts ?? [], (a) => [a.orders_1d, a.orders_1d_limit]);
  if (!sm || !exposure) return null;
  const p = sm.pnl;
  const hedge = exposure.hedge_day?.hedge_pnl ?? null;
  const zone = tz === "utc" ? " UTC" : "";
  const equity = (accounts ?? []).reduce((s, a) => s + a.equity, 0);
  const mk = sm.markout_net_bps_1h;
  const ofEquity = equity > 0 ? (sm.pnl_day / (equity - sm.pnl_day)) * 100 : null;

  return (
    <>
      <AlertLine />

      <DeskHero
        v={sm.pnl_day}
        sub={
          <>
            {ofEquity != null && <span className={"fig" + (hide ? " masked" : "")}>{pctOfMoney(ofEquity / 100, hide, 3)} of equity</span>}
          </>
        }
        since={`since ${hm(sm.day_start, tz)}${zone}`}
        h1={sm.pnl_1h}
        equity={equity}
      />

      <section className="dk-chart-sec">
        <DeskChart ms={PAGE_MS} />
      </section>

      <Section title="Day PnL split" right="USDT">
        <PartRows
          rows={[
            { key: "mm", label: "Market making", color: MM_COLOR, v: p.mm, info: `Each fill against the mid 60 s after it, minus fees. Against the fair at the fill instead: ${money(p.mm_spread)} USDT.` },
            { key: "inv", label: "Inventory PnL", color: INVPNL_COLOR, v: p.inventory, info: "Trading PnL minus market making: what the inventory made after the first 60 s of each fill." },
            { key: "hedge", label: "Hedge", color: HEDGE_COLOR, v: hedge },
            { key: "reb", label: "Rebates", color: REBATE_COLOR, v: sm.rebates },
            {
              key: "other",
              label: "Other",
              color: "#5b6474",
              v: sm.other,
              tone: reconcile ? "warn" : undefined,
              info: "Day PnL minus trading PnL, the hedge and the rebates." + (reconcile ? "\n\nA reconcile alert is active: a fill, transfer or asset the desk does not see." : ""),
            },
          ]}
        />
      </Section>

      <Section
        title="Quotes"
        right={
          <UnstyledButton className="m-link" onClick={() => openMarkets("quotes")}>
            All
          </UnstyledButton>
        }
        card={false}
        className="dk-quotes"
      >
        <QuoteLegend short className="dk-qlegend" />
        <QuotesMini n={8} ms={QUOTES_MS} />
      </Section>

      <Section title="Risk" className="dk-risk">
        <ExposureBar x={exposure} />
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
            label="Orders 1 d"
            who={o1d.a.label}
            value={o1d.v}
            limit={o1d.lim}
            pct
          />
        )}
      </Section>

      <Section>
        <KV
          cols={3}
          items={[
            {
              label: "Fills / h",
              value: int(sm.fills_1h),
            },
            {
              label: "Volume",
              value: <Money v={sm.volume_day} kind="short" />,
            },
            {
              label: "Markout 10 s",
              value: <Bps v={mk} />,
            },
          ]}
        />
      </Section>

      <div className="m-hold" {...hold}>
        <Movers symbols={symbols} />
      </div>

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

// ---- hero: Day PnL big, the eye that hides amounts, 1h and equity at the right ----

function DeskHero({ v, sub, since, h1, equity }: { v: number; sub: ReactNode; since: string; h1: number; equity: number }) {
  const hide = useStore((s) => s.hideAmounts);
  return (
    <section className="dk-hero">
      <div className="dk-hero-top">
        <span className="dk-hero-label">
          Day PnL (USDT) <span className="dk-hero-since">{since}</span>
        </span>
        <UnstyledButton
          className="dk-eye"
          aria-label={hide ? "Show amounts" : "Hide amounts"}
          aria-pressed={hide}
          onClick={() => useStore.getState().setHideAmounts(!hide)}
        >
          {hide ? <IconEyeOff size={18} stroke={1.75} /> : <IconEye size={18} stroke={1.75} />}
        </UnstyledButton>
      </div>
      <div className="dk-hero-row">
        <div className="dk-hero-main">
          <div className="dk-hero-v">
            <Money v={v} />
          </div>
          <div className="dk-hero-sub">{sub}</div>
        </div>
        <dl className="dk-hero-side">
          <div>
            <dt>1h PnL</dt>
            <dd>
              <Money v={h1} />
            </dd>
          </div>
          <div>
            <dt>Equity</dt>
            <dd>
              <Money v={equity} kind="full" />
            </dd>
          </div>
        </dl>
      </div>
    </section>
  );
}

// ---- the parts of the day: plain rows, a colour key that matches the chart's lines ----

interface Part {
  key: string;
  label: string;
  sub?: string;
  color: string;
  v: number | null | undefined;
  info?: string;
  tone?: "warn";
}

function PartRows({ rows }: { rows: Part[] }) {
  return (
    <>
      {rows.map((r) => (
        <div key={r.key} className={"dk-part" + (r.info ? " m-tap" : "")} {...defineProps(r.label, r.info)}>
          <i className="dk-key" style={{ background: r.color }} aria-hidden />
          <span className={"dk-part-l " + (r.tone ?? "")}>
            <DefinedLabel label={r.label} info={r.info} />
            {r.sub && <span className="dk-part-sub"> {r.sub}</span>}
          </span>
          <span className={"dk-part-v " + (r.tone ?? "")}>
            <Money v={r.v} color={r.tone == null} />
          </span>
        </div>
      ))}
    </>
  );
}

// ---- top movers: the best or the worst spot instruments today ----

function Movers({ symbols }: { symbols: SymbolRow[] | undefined }) {
  const [side, setSide] = useState<"best" | "worst">("best");
  const money = useMoney();
  const [best, worst] = useMemo(() => {
    const xs = (symbols ?? []).filter((r) => r.venue === "spot" && Math.abs(instPnl(r)) >= 0.005).sort((a, b) => instPnl(b) - instPnl(a));
    return [xs.filter((r) => instPnl(r) > 0).slice(0, 4), xs.filter((r) => instPnl(r) < 0).reverse().slice(0, 4)];
  }, [symbols]);
  const list = side === "best" ? best : worst;
  if (!best.length && !worst.length) return null;
  return (
    <Section
      title="Top movers"
      right={
        <Segmented
          label="Movers"
          value={side}
          onChange={setSide}
          data={[
            { value: "best", label: "Best" },
            { value: "worst", label: "Worst" },
          ]}
        />
      }
    >
      {list.map((r) => (
        <ListRow
          key={r.venue + r.symbol}
          title={<InstName r={r} />}
          subtitle={`Spot · ${money(r.inv_value, "short") === "0.00" ? "flat" : "inv " + money(r.inv_value, "short")} · ${int(r.fills_day)} fills`}
          primary={<Money v={instPnl(r)} />}
          secondary={`MM ${money(r.mm_pnl)} · Inv ${money(r.inv_pnl)}`}
          to={{ page: "desk", detail: { kind: "instrument", symbol: r.symbol, venue: r.venue } }}
        />
      ))}
      {list.length === 0 && <div className="m-empty">{side === "best" ? "Nothing has made money today yet." : "Nothing has lost money today."}</div>}
    </Section>
  );
}

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
