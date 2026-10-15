import { useStore, serverNow } from "../../store";
import { getJSON, type History as Hist } from "../../api";
import { hm, int, num, usdShort } from "../../format";
import { Hero, KV, Money, Section, Sparkline, SplitRows, DefinedLabel, defineProps, tone, useMoney } from "../../components/mobile";
import type { DayPnl } from "../../protocol";
import { DAY, PARTS, PART_INFO, useLoad } from "./shared";
import "./history.css";

const DEF_SE =
  "± is the likely error of the figure: its standard error, from how much the day's hourly results varied (Newey–West, lag 3).";

/** One PnL day: its result and split, its path through the day, the model figures and the activity. */
export function DayM({ date }: { date: string }) {
  const days = useStore((s) => s.snap?.days);
  const dayStart = useStore((s) => s.snap?.summary.day_start ?? 0);
  const today = days?.[days.length - 1]?.day;
  const d = days?.find((x) => x.day === date);
  const money = useMoney();
  // the day's start: today's, moved back by whole days
  const start = today ? dayStart - Math.round((Date.parse(today + "T00:00:00Z") - Date.parse(date + "T00:00:00Z")) / DAY) * DAY : 0;
  if (!d) return <div className="m-empty">This day is not among the {days?.length ?? 0} the desk keeps.</div>;
  const live = date === today;
  const h = (s: number) => num(s / 3600, 1);
  const coverage = `${h(d.covered_s + d.backfilled_s)} h`;

  const kept = d.pnl_day != null;

  return (
    <>
      <Section>
        {kept ? (
          <Hero
            label="Day PnL"
            info="Equity change over the day, net of transfers. The rows below split it: each bar starts where the one above ended, so the last ends at the day's figure."
            v={d.pnl_day}
            sub={live ? "so far" : undefined}
          >
            <DayPath start={start} live={live} hero={d.pnl_day} />
          </Hero>
        ) : (
          // the monitor was not recording Day PnL then; the trading figures are rebuilt from the fills
          <Hero
            label="Trading PnL"
            info={`Market making plus inventory PnL, fees included, not hedged; rebuilt from the day's fills and prices. ${DEF_SE}`}
            v={d.trading}
            sub={d.trading_se != null ? <span className="m-fig">± {money(d.trading_se, "usd")}</span> : undefined}
          />
        )}
        {kept ? (
          <SplitRows waterfall rows={PARTS.map((p) => ({ key: p.key, label: p.label, info: PART_INFO[p.key], v: d[p.key] }))} />
        ) : (
          <div className="m-hist-unkept">Day PnL was not recorded this day</div>
        )}
      </Section>

      <Section
        title="Hedged views"
        info={`Trading PnL: market making plus inventory PnL, fees included, not hedged. Ref-hedged and beta-hedged take off what the inventory would have made on its references, or on the beta instrument. ${DEF_SE}`}
        right="± likely error"
      >
        <SeRows d={d} trading={kept} />
      </Section>

      <Section title="Activity">
        <KV
          cols={3}
          items={[
            { label: "Fills", info: "Spot fills booked that day.", value: int(d.fills) },
            { label: "Volume", info: "Notional of the spot fills booked that day, USDT.", value: <Money v={d.volume} kind="short" /> },
            {
              label: "Hours covered",
              info:
                `Hours of the day the trading figures cover: ${h(d.covered_s)} h recorded live` +
                (d.backfilled_s > 0 ? `, ${h(d.backfilled_s)} h rebuilt from 1-minute candles where the monitor was down.` : "."),
              value: coverage,
            },
          ]}
        />
      </Section>
    </>
  );
}

/** The day PnL through the day, every 5 min, with its times and range. */
function DayPath({ start, live, hero }: { start: number; live: boolean; hero: number | null }) {
  const tz = useStore((s) => s.tz);
  const money = useMoney();
  const key = start ? `day|${start}` : null;
  const hist = useLoad<Hist>(
    key,
    (signal) => getJSON<Hist>("/api/history", { from: start, to: Math.min(start + DAY, serverNow()), step: 300 }, signal),
    live ? 60_000 : 0,
  );
  const bars = (hist.key === key ? (hist.data?.bars ?? []) : []).filter((b) => b.t < start + DAY);
  const zone = tz === "utc" ? " UTC" : "";
  if (!bars.length)
    return <div className="m-hist-path-wait">{hist.err ? "Could not load the day's path" : hist.loading ? "" : "No path kept for this day"}</div>;
  const end = live ? bars[bars.length - 1]!.t + 300_000 : start + DAY;
  // a whole past day ends at 24:00, not at a second 00:00
  const endLabel = !live && hm(end, tz) === hm(start, tz) ? "24:00" : hm(end, tz);
  return (
    <Sparkline
      values={[0, ...bars.map((b) => b.c)]}
      height={56}
      // a high or low that reads as the hero's figure is not printed twice
      range={(v) => (usdShort(v) === usdShort(hero) ? "" : money(v, "pnlShort"))}
      ends={[hm(start, tz), endLabel + zone]}
    />
  );
}

/** Trading, hedged and factor-hedged PnL with their standard errors, on one scale with zero where it falls. */
function SeRows({ d, trading = true }: { d: DayPnl; trading?: boolean }) {
  const money = useMoney();
  const all = [
    { key: "t", label: "Trading PnL", v: d.trading, se: d.trading_se, info: "Market making plus inventory PnL, fees included; not hedged. USDT." },
    {
      key: "h",
      label: "Ref-hedged",
      v: d.hedged,
      se: d.hedged_se,
      info: "Trading PnL minus what the inventory would have made on each instrument's own reference, hedged with a 0–1 s delay. USDT.",
    },
    {
      key: "f",
      label: "Beta-hedged",
      v: d.factor,
      se: d.factor_se,
      info: "Trading PnL minus what the inventory would have made on the beta instrument, each market weighted by its beta. USDT.",
    },
  ];
  // without a Day PnL the hero shows Trading PnL: not twice
  const rows = trading ? all : all.slice(1);
  const hide = useStore((s) => s.hideAmounts);
  // zero in the middle, as every signed bar on the phone; the widest reach (value ± error) fills its half
  let reach = 0;
  for (const r of rows) reach = Math.max(reach, Math.abs(r.v) + (r.se ?? 0));
  const x = (v: number) => 50 + (v / (reach || 1)) * 50;
  return (
    <>
      {rows.map((r) => {
        const info = `${r.info} ${DEF_SE}`;
        const a = x(Math.min(0, r.v));
        const b = x(Math.max(0, r.v));
        return (
          <div key={r.key} className="m-pm-row m-tap" {...defineProps(r.label, info)}>
            <span className="m-pm-label">
              <DefinedLabel label={r.label} info={info} />
            </span>
            <span className={"m-pm-track m-dim" + (hide ? " m-veil" : "")} style={{ ["--zero" as string]: `${x(0)}%` }} aria-hidden>
              {!hide && <span className={"m-pm-fill " + tone(r.v, money(r.v))} style={{ left: `${a}%`, width: `max(2px, ${b - a}%)` }} />}
              {!hide && r.se != null && r.se > 0 && (
                <span className="m-pm-se" style={{ left: `${x(r.v - r.se)}%`, width: `${x(r.v + r.se) - x(r.v - r.se)}%` }} />
              )}
            </span>
            <span className="m-pm-value">
              <Money v={r.v} />
              <small className="m-fig">± {r.se == null ? "—" : money(r.se, "usd")}</small>
            </span>
          </div>
        );
      })}
    </>
  );
}
