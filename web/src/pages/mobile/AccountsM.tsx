import { useCallback, useMemo, useRef, useState } from "react";
import type uPlot from "uplot";
import { useStore } from "../../store";
import { useNow } from "../../hooks";
import { DASH, bps, hm, hms, int, num, pct, price } from "../../format";
import { ACCOUNT_SERIES, C, FUT_COLOR, INV_COLOR, S1 } from "../../theme";
import { UPlot, axis, tooltipPlugin, touchCursorPlugin } from "../../components/UPlot";
import { timeAxis, usdTicks } from "../../components/uplotAxes";
import { Dot } from "../../components/ui";
import {
  Chips,
  Hero,
  KV,
  LazyMount,
  LimitBar,
  ListRow,
  Money,
  Section,
  SplitRows,
  Tag,
  defineProps,
  limitTone,
  span,
  useLive,
  useMoney,
  type KVItem,
} from "../../components/mobile";
import type { Account, Exposure, HedgeLeg } from "../../protocol";
import { bandDef, FigTable, PositionsTable, type PosRow, RateSections, TIP, useQty } from "./shared";
import "./accounts.css";

const betaNote = (x: Exposure) =>
  x.beta_source === "estimate" ? "β: the desk's own estimate, may differ from the engine's." : "β: configured per market.";

// ---- an account: name and day PnL, equity and bid use; its order rates are in the sections below ----

function AccountRow({ a, now }: { a: Account; now: number }) {
  const money = useMoney();
  const old = now - a.updated > 30_000;
  const util = a.utilization != null && Number.isFinite(a.utilization) ? a.utilization : null;
  const ut = util != null ? limitTone(util, 1) : "ok";
  return (
    <ListRow
      dot={<Dot ok={a.user_stream !== "down"} />}
      title={
        <>
          {a.label}
          {a.role === "master" && <Tag>master</Tag>}
        </>
      }
      subtitle={
        <>
          equity {money(a.equity, "short")}
          {util != null && (
            <span className={ut === "ok" ? "" : ut === "warn" ? "warn-text" : "m-acc-crit"}> · bid use {pct(util, 0)}</span>
          )}
          {a.user_stream === "down" && <span className="warn-text"> · stream down</span>}
          {old && <span className="warn-text"> · updated {span(now - a.updated)} ago</span>}
        </>
      }
      primary={<Money v={a.pnl_day} />}
      to={{ page: "accounts", detail: { kind: "account", id: a.id } }}
    />
  );
}

// ---- charts: one at a time ----

type ChartKey = "equity" | "accounts" | "inventory";

const CHART_H = 220;

/** A zero line on signed charts. */
const zeroLine: uPlot.Plugin = {
  hooks: {
    draw: (u) => {
      const y = Math.round(u.valToPos(0, "y", true)) + 0.5;
      const { top, height, left, width } = u.bbox;
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

interface Line {
  label: string;
  color: string;
}

/** `rest`: what the readout line shows while no finger reads a time: the latest point, a key of the lines with
 *  their latest values (several lines), or nothing (the latest value is on the page already). */
function Plot({
  lines,
  data,
  signed,
  wrap,
  rest = "latest",
}: {
  lines: Line[];
  data: uPlot.AlignedData;
  signed: boolean;
  wrap?: boolean;
  rest?: "latest" | "key" | "none";
}) {
  const tz = useStore((s) => s.tz);
  const hide = useStore((s) => s.hideAmounts);
  const money = useMoney();
  const read = useRef<HTMLDivElement>(null);
  const key = lines.map((l) => l.label).join("|");
  const options = useCallback(
    (width: number, height: number): uPlot.Options => {
      const ticks = usdTicks(signed);
      return {
        width,
        height,
        padding: [8, 4, 0, 0],
        legend: { show: false },
        cursor: { y: false, points: { size: 7, width: 2, stroke: C.panel }, drag: { x: false, y: false } },
        scales: {
          x: { time: false },
          y: {
            range: (_u, min, max) => {
              const pad = Math.max(1, (max - min) * 0.08);
              return signed ? [Math.min(0, min) - pad, Math.max(0, max) + pad] : [min - pad, max + pad];
            },
          },
        },
        axes: [
          timeAxis(tz, { space: 64 }),
          axis({ size: 48, values: (u, s, a, sp, inc) => (hide ? s.map(() => "") : ticks(u, s, a, sp, inc)) }),
        ],
        series: [{}, ...lines.map((l) => ({ label: l.label, stroke: l.color, width: 1.75, spanGaps: true, points: { show: false } }))],
        plugins: [
          ...(signed ? [zeroLine] : []),
          touchCursorPlugin(),
          tooltipPlugin(
            (u, i) => {
              const t = u.data[0][i];
              if (t == null) return null;
              return {
                title: hm(t * 1000, tz) + (tz === "utc" ? " UTC" : ""),
                rows: lines.map((l, k) => ({
                  color: l.color,
                  label: l.label,
                  value: money(u.data[k + 1]![i] ?? null, signed ? "pnl" : "usd"),
                })),
              };
            },
            { mode: "strip", strip: read.current, rest },
          ),
        ],
      };
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [tz, hide, money, key, signed, rest],
  );
  return (
    <div className="m-acc-chart">
      <div ref={read} className={"m-acc-read m-fig" + (wrap ? " wrap" : "")} />
      <div className="m-acc-plot m-dim" style={{ height: CHART_H }}>
        <UPlot options={options} data={data} />
      </div>
    </div>
  );
}

function SeriesPlot({ k }: { k: ChartKey }) {
  const series = useStore((s) => s.snap?.series);
  const all = useStore((s) => s.snap?.account_series);
  const accounts = useStore((s) => s.snap?.accounts);
  const desk = useMemo<uPlot.AlignedData>(() => {
    const pts = series ?? [];
    return k === "equity"
      ? [pts.map((p) => p.t / 1000), pts.map((p) => p.equity)]
      : [pts.map((p) => p.t / 1000), pts.map((p) => p.inventory), pts.map((p) => p.futures_notional)];
  }, [series, k]);
  // the accounts in list order, at most six lines, on one time grid
  const shown = useMemo(() => {
    const by = new Map((all ?? []).map((a) => [a.account, a]));
    return (accounts ?? []).filter((a) => by.has(a.id)).slice(0, ACCOUNT_SERIES.length).map((a) => ({ label: a.label, s: by.get(a.id)! }));
  }, [all, accounts]);
  const perAccount = useMemo<uPlot.AlignedData>(() => {
    const ts = Array.from(new Set(shown.flatMap((x) => x.s.t))).sort((a, b) => a - b);
    const idx = new Map(ts.map((t, i) => [t, i]));
    const cols = shown.map((x) => {
      const col = new Array<number | null>(ts.length).fill(null);
      x.s.t.forEach((t, i) => (col[idx.get(t)!] = x.s.pnl_day[i]!));
      return col;
    });
    return [ts.map((t) => t / 1000), ...cols];
  }, [shown]);
  const accLines = useMemo(() => shown.map((x, i) => ({ label: x.label, color: ACCOUNT_SERIES[i]! })), [shown]);
  if (k === "accounts") {
    if (!shown.length) return <div className="m-empty">No account series yet</div>;
    return <Plot lines={accLines} data={perAccount} signed wrap rest="key" />;
  }
  if (!series?.length) return <div className="m-empty">No series yet</div>;
  return k === "equity" ? <Plot lines={EQ} data={desk} signed={false} rest="none" /> : <Plot lines={INV} data={desk} signed />;
}

const EQ: Line[] = [{ label: "Equity", color: S1 }];
const INV: Line[] = [
  { label: "Inventory", color: INV_COLOR },
  { label: "Futures", color: FUT_COLOR },
];

const CHART_INFO: Record<ChartKey, string> = {
  equity: "Desk equity since the day start, all accounts, USDT.",
  accounts:
    "Each account's day PnL: equity minus equity at the day start, minus net transfers in. Points every 45 s. USDT.",
  inventory: "Spot inventory value at mid and futures net notional, all accounts, USDT.",
};

function Charts() {
  const [k, setK] = useState<ChartKey>("equity");
  return (
    <Section
      // the chips name the chart; the heading only says the scope
      title="Charts"
      info={`Equity: ${CHART_INFO.equity}\n\nDay PnL by account: ${CHART_INFO.accounts}\n\nInventory: ${CHART_INFO.inventory}`}
      right="today, USDT"
      card={false}
    >
      <Chips
        label="Chart"
        value={k}
        onChange={setK}
        data={[
          { value: "equity", label: "Equity" },
          { value: "accounts", label: "Day PnL by account" },
          { value: "inventory", label: "Inventory" },
        ]}
      />
      <LazyMount height={CHART_H + 48}>
        <SeriesPlot key={k} k={k} />
      </LazyMount>
    </Section>
  );
}

// ---- the page ----

export function AccountsM() {
  const sm = useStore((s) => s.snap?.summary);
  const x = useStore((s) => s.snap?.exposure);
  const accounts = useLive((s) => s.snap?.accounts, 250);
  const tz = useStore((s) => s.tz);
  const now = useNow(1000) + useStore.getState().skew;
  const money = useMoney();
  const positions = useMemo<PosRow[]>(
    () => (accounts ?? []).flatMap((a) => a.positions.map((p) => ({ ...p, account: a.label }))),
    [accounts],
  );
  if (!sm || !x || !accounts) return null;
  const labelOf = (id: string) => accounts.find((a) => a.id === id)?.label ?? id;
  const hasGap = x.gap != null && x.band != null;
  // the account with the largest net exposure, either way
  const top = x.by_account.reduce<(typeof x.by_account)[number] | null>((m, r) => (!m || Math.abs(r.net) > Math.abs(m.net) ? r : m), null);

  // the next funding of any held perp
  const nextF = x.funding.reduce<number | null>((m, f) => (f.next != null && (m == null || f.next < m) ? f.next : m), null);
  const fundingInfo =
    "Funding on the perps held, per interval.\n\n" +
    (x.funding.length
      ? x.funding
          .map(
            (f) =>
              `${f.symbol}: rate ${f.rate == null ? DASH : bps(f.rate * 1e4) + " bps"}, position ${num(f.position, 4, true)}, ` +
              `next ${f.next == null ? DASH : `${hms(f.next, tz)} (${span(f.next - now)})`}`,
          )
          .join("\n\n")
      : "No perps held.");

  const totals: KVItem[] = [
    {
      label: "Net exposure",
      info: `Spot inventory value plus futures net notional, all accounts: spot ${money(x.spot_value, "usd")} + futures ${money(x.futures_notional)}. USDT.`,
      value: <Money v={x.net} color={false} />,
    },
  ];
  if (x.target != null)
    totals.push({
      label: "Hedge target",
      info:
        `Hedge target: −${num(x.ratio, 2)} × beta-weighted spot value (${money(x.beta_value, "usd")}). ${betaNote(x)} ` +
        `The hedge symbols' futures notional now: ${money(x.hedge_notional)}. USDT.`,
      value: <Money v={x.target} color={false} />,
    });
  totals.push({
    label: "Funding in",
    info: fundingInfo,
    value: nextF != null ? span(nextF - now) : DASH,
  });

  const hd = x.hedge_day;
  const inv = sm.pnl.inventory;
  const offset = hd && hd.hedge_pnl != null && Math.abs(inv) > 1e-9 ? -hd.hedge_pnl / inv : null;

  return (
    <>
      <Section>
        <Hero
          label="Desk equity"
          info={`${TIP.equity} All accounts. Day: ${TIP.dayPnl}`}
          v={sm.equity}
          kind="usd"
          sub={
            <>
              day <Money v={sm.pnl_day} />
            </>
          }
        />
        {hasGap && x.paused ? (
          <LimitBar
            label={x.paused}
            info={
              `${x.paused}: the hedge is off and its target is 0; the value is the hedge symbols' futures notional still open, to be closed` +
              `${x.paused_until != null ? `, until ${hm(x.paused_until, tz)}` : ""}. Band: ±${money(x.band, "usd")}. USDT.`
            }
            value={x.hedge_notional}
            limit={x.band!}
            centered
          />
        ) : hasGap ? (
          <LimitBar
            label="Exposure gap"
            info={
              `Hedge target minus the futures notional of the hedge symbols (the trade that closes it; negative = sell more), where the target is ` +
              `−${num(x.ratio, 2)} × beta-weighted spot value. ${betaNote(x)} ${bandDef(money(x.band, "usd"))} USDT.`
            }
            value={x.gap!}
            limit={x.band!}
            centered
          />
        ) : null}
        <KV cols={totals.length as 2 | 3} items={totals} />
      </Section>

      <Section
        title="Accounts"
        info={`Day PnL: ${TIP.dayPnl}\n\nEquity: ${TIP.equity}\n\nBid use: ${TIP.bid} Near 100 %, there is little USDT left to bid with.`}
        right="day PnL"
      >
        {accounts.map((a) => (
          <AccountRow key={a.id} a={a} now={now} />
        ))}
      </Section>

      <RateSections accounts={accounts.filter((a) => a.orders_10s_limit > 0 || a.orders_1d_limit > 0)} />

      {positions.length > 0 && (
        <Section title="Futures positions">
          <PositionsTable rows={positions} showAccount />
        </Section>
      )}

      <Section
        title="Exposure"
        info="Spot inventory value and futures net notional per account, USDT. The account with the largest net exposure either way is named at the right."
        right={top ? <>largest net: {labelOf(top.account)}</> : undefined}
      >
        <FigTable
          head="Account"
          cols={[
            { label: "Spot", info: "Spot inventory value at mid, USDT." },
            { label: "Futures", info: "Futures net notional, signed, USDT." },
            { label: "Net", info: "Spot value + futures notional, USDT." },
          ]}
          rows={x.by_account.map((r) => ({
            key: r.account,
            title: r === top ? <b>{labelOf(r.account)}</b> : labelOf(r.account),
            cells: [
              <Money v={r.spot_value} kind="short" />,
              <Money v={r.futures_notional} kind="pnlShort" color={false} />,
              <Money v={r.net} kind="pnlShort" color={false} />,
            ],
          }))}
        />
      </Section>

      {hd && (
        <Section
          title="Inventory and hedge, today"
          info="Since the day start: the Inventory PnL of the Desk, against what the futures legs made."
          right={offset != null ? <span {...defineProps("Hedge offset", "How much of the Inventory PnL the hedge offset: −Hedge ÷ Inventory PnL. 100 % cancels it exactly; over 100 %, the hedge made more than the inventory lost (or lost more than it made).")} className="m-tap m-acc-offset"><span className="m-defined">hedge offset {pct(offset, 0)}</span></span> : undefined}
        >
          <SplitRows
            waterfall
            rows={[
              { key: "inv", label: "Inventory PnL", info: "Trading PnL minus market making: what the inventory made after the first 60 s of each fill.", v: inv },
              { key: "hedge", label: "Hedge", info: "The futures legs since the day start: price at mark, minus fees, plus funding.", v: hd.hedge_pnl },
            ]}
            total={{ label: "Net", info: "Inventory PnL plus the hedge.", v: inv + (hd.hedge_pnl ?? 0) }}
          />
          {hd.legs.length > 0 && <Legs legs={hd.legs} />}
        </Section>
      )}

      <Charts />
    </>
  );
}

/** The hedge legs: only what the positions above don't show (the day start's size, today's fills, fees and the
 *  day start's mark); size now, mark now and today's P&L are in the positions. */
function Legs({ legs }: { legs: HedgeLeg[] }) {
  const q = useQty();
  return (
    <FigTable
      head="Leg"
      cols={[
        { label: "Start", info: "Position at the day start, base-asset units." },
        { label: "Fills", info: "Futures fills today." },
        { label: "Fees", info: "Fees today, a cost, USDT." },
      ]}
      rows={legs.map((l) => ({
        key: l.symbol,
        title: l.symbol,
        cells: [q(l.qty0, true), int(l.fills), <Money v={-l.fees} kind="pnlShort" />],
        sub: <>mark at the day start {price(l.mark0)}</>,
      }))}
    />
  );
}
