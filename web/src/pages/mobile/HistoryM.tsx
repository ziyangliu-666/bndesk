import { useMemo } from "react";
import { create } from "zustand";
import { useStore, serverNow } from "../../store";
import { useThrottled } from "../../hooks";
import { getJSON, type History as Hist } from "../../api";
import { DeskChart, type PnlView } from "../../components/HistoryChart";
import { int } from "../../format";
import { Chips, ListRow, Money, Section, Segmented, showInfo } from "../../components/mobile";
import type { DayPnl } from "../../protocol";
import { dayTitle } from "./index";
import { ChartState, DAY, PART_INFO, type PartKey, PARTS, useLoad } from "./shared";
import "./history.css";

// ---- History ----

type Range = "7" | "30" | "90" | "all";
const RANGES: { value: Range; label: string }[] = [
  { value: "7", label: "7D" },
  { value: "30", label: "30D" },
  { value: "90", label: "90D" },
  { value: "all", label: "All" },
];
// one bar (candle) per PnL day on every range: the week reads day by day, as the table under it
const STEP: Record<Range, number> = { "7": 86_400, "30": 86_400, "90": 86_400, all: 86_400 };
const REFRESH = 60_000;

// outside the page, so the choices survive switching tabs
const useHistM = create<{ range: Range; view: PnlView; set: (p: { range?: Range; view?: PnlView }) => void }>((set) => ({
  range: "7",
  view: "day",
  set: (p) => set(p),
}));

export function HistoryM() {
  const { range, view, set } = useHistM();
  const hide = useStore((s) => s.hideAmounts);
  const tz = useStore((s) => s.tz);
  const dayStart = useStore((s) => s.snap?.summary.day_start ?? 0);
  const allDays = useThrottled(useStore((s) => s.snap?.days), 1000);

  const step = STEP[range];
  const key = dayStart ? `${range}|${dayStart}` : null;
  const hist = useLoad<Hist>(
    key,
    (signal) => {
      const from = range === "all" ? 0 : dayStart - (Number(range) - 1) * DAY;
      return getJSON<Hist>("/api/history", { from, to: serverNow(), step }, signal);
    },
    REFRESH,
  );
  // only what was loaded for this range: a slow or failed load must not show the last range's days or step
  const cur = hist.key === key ? hist.data : null;
  const bars = cur?.bars ?? [];

  const days = useMemo(() => {
    const xs = (allDays ?? []).slice().reverse();
    return range === "all" ? xs : xs.slice(0, Number(range));
  }, [allDays, range]);
  // a day without its Day PnL counts its Trading PnL (said under the heading)
  const total = days.reduce((a, d) => a + (d.pnl_day ?? d.trading ?? 0), 0);
  const tradingOnly = days.filter((d) => d.pnl_day == null).length;
  // one scale for every row's bar: the largest positive and negative stacks
  const scale = useMemo(() => {
    let pos = 0;
    let neg = 0;
    for (const d of days) {
      const [p, n] = stackSums(d);
      pos = Math.max(pos, p);
      neg = Math.max(neg, n);
    }
    return { pos, neg };
  }, [days]);

  return (
    <>
      <Section card={false}>
        <div className="m-hist-controls">
          <Chips value={range} onChange={(v) => set({ range: v })} data={RANGES} label="Range" />
          <Segmented
            value={view === "cum" ? "cum" : "day"}
            onChange={(v) => set({ view: v })}
            data={[
              { value: "day", label: "Day" },
              { value: "cum", label: "Cumulative" },
            ]}
            label="View"
          />
        </div>
        <div className="m-hist-chart">
          {/* every range opens whole; each ends now, so the newest bar follows the live figures */}
          <DeskChart
            phone
            fitAll
            height={240}
            bars={bars}
            days={cur?.days ?? []}
            step={cur?.step ?? step}
            tz={tz}
            fitKey={hist.key}
            view={view}
          />
          <ChartState load={hist} empty={cur != null && bars.length === 0} />
        </div>
      </Section>

      <Section
        title="By day"
        info={
          "Each PnL day starts at the configured day start; newest first. Day PnL is the equity change net of transfers.\n\n" +
          "The bar under each day splits it: parts that made money stack right of the zero line, parts that lost stack left, " +
          "on one scale for all the days shown. Tap a day for its figures.\n\n" +
          "Some older days have only Trading PnL (market making plus inventory, rebuilt from the fills): the monitor " +
          "was not yet recording Day PnL and its split then. The total at the right adds those days' Trading PnL."
        }
        right={
          days.length ? (
            <>
              {daysText(days.length, range)} <Money v={total} />
            </>
          ) : undefined
        }
      >
        {tradingOnly > 0 && (
          <div className="m-hist-note">
            {tradingOnly === days.length ? "Trading PnL only: Day PnL was not recorded" : `${tradingOnly} days are Trading PnL only`}
          </div>
        )}
        {tradingOnly < days.length && !hide && <SplitKey />}
        {days.map((d, i) => (
          <DayRow key={d.day} d={d} scale={scale} today={i === 0 && d.day === allDays?.[allDays.length - 1]?.day} />
        ))}
        {!days.length && <div className="m-empty">No days kept yet</div>}
      </Section>
    </>
  );
}

/** "7 days", or "20 days with data" when the range asks for more days than were kept. */
function daysText(n: number, range: Range): string {
  const base = n === 1 ? "1 day" : `${n} days`;
  return range !== "all" && n < Number(range) ? `${base} with data` : base;
}

/** The bar colors, as words; tapping it explains each part. */
function SplitKey() {
  return (
    <button
      type="button"
      className="m-hist-key m-tap"
      aria-haspopup="dialog"
      onClick={() =>
        showInfo(
          "The day's split",
          <div className="m-hist-defs">
            {PARTS.map((p) => (
              <p key={p.key}>
                <span className="m-hist-sw" style={{ background: p.color }} />
                <b>{p.label}</b> {PART_INFO[p.key]}
              </p>
            ))}
          </div>,
        )
      }
    >
      {PARTS.map((p) => (
        <span key={p.key} className="m-hist-key-item">
          <span className="m-hist-sw" style={{ background: p.color }} />
          {p.short}
        </span>
      ))}
    </button>
  );
}

const partVal = (d: DayPnl, k: PartKey) => d[k] ?? 0;

/** The positive and the negative stack's sizes. */
function stackSums(d: DayPnl): [number, number] {
  let p = 0;
  let n = 0;
  for (const { key } of PARTS) {
    const v = partVal(d, key);
    if (v > 0) p += v;
    else n -= v;
  }
  return [p, n];
}

function DayRow({ d, scale, today }: { d: DayPnl; scale: { pos: number; neg: number }; today: boolean }) {
  const span = scale.pos + scale.neg || 1;
  const zero = (scale.neg / span) * 100;
  const segs: { key: string; color: string; left: number; w: number }[] = [];
  let p = 0;
  let n = 0;
  for (const part of PARTS) {
    const v = partVal(d, part.key);
    if (!v) continue;
    const w = (Math.abs(v) / span) * 100;
    if (v > 0) {
      segs.push({ key: part.key, color: part.color, left: zero + p, w });
      p += w;
    } else {
      n += w;
      segs.push({ key: part.key, color: part.color, left: zero - n, w });
    }
  }
  const split = d.pnl_day != null;
  const hide = useStore((s) => s.hideAmounts);
  return (
    <ListRow
      className="m-hist-day"
      title={
        <>
          {dayTitle(d.day)}
          {today && <span className="m-tag">today</span>}
        </>
      }
      subtitle={
        <span className="m-hist-sub">
          {/* Hide amounts: no bar at all (its lengths, even its zero tick, would give the split away) */}
          {split ? (
            !hide && (
              <span className="m-hist-bar m-dim" style={{ ["--zero" as string]: `${zero}%` }} aria-hidden>
                {segs.map((s) => (
                  <span key={s.key} style={{ left: `${s.left}%`, width: `max(1px, ${s.w}%)`, background: s.color }} />
                ))}
              </span>
            )
          ) : (
            <span className="m-hist-nosplit">Trading PnL only</span>
          )}
          <span className={"m-hist-fills" + (split && hide ? " alone" : "")}>{int(d.fills)} fills</span>
        </span>
      }
      primary={split ? <Money v={d.pnl_day} /> : d.trading != null ? <Money v={d.trading} /> : <span className="muted">—</span>}
      to={{ page: "history", detail: { kind: "day", date: d.day } }}
    />
  );
}
