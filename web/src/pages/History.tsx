// Desktop History, Binance's "PnL analysis" with a chart page's frame: Desk | instrument tabs; ranges 7D 30D
// 90D All; intervals 15m 1H 4H 1D 1W; Daily | Cumulative | Candles; the chart with its legends, volume and
// inventory; the range's summary and calendar at the right; By day | By hour tables under it.
//
// The instrument is in the URL (#/history/<SYMBOL>/<venue>), a day too (#/day/<date> zooms to it); range,
// interval and mode are remembered on this browser. Each load is keyed by what it was asked for and drawn only
// under that key, so switching any of them clears the chart at once and shows the new bars when they land.
import { useEffect, useMemo, useRef } from "react";
import { navigate, useStore } from "../store";
import type { Venue } from "../protocol";
import { Tabs, TextToggle, useExHidden, useExPref, useKlines, type ExView, type KInterval } from "../components/ex";
import { DeskChart } from "./history/DeskChart";
import { InstChart } from "./history/InstChart";
import { InstrumentPicker } from "./history/Picker";
import { DeskSide, InstSide } from "./history/Side";
import { DeskDays, DeskHours, InstDays, InstHours } from "./history/Tables";
import {
  DAY,
  INTERVALS,
  IV_LABEL,
  IV_MS,
  MODES,
  RANGES,
  RANGE_LABEL,
  STEP_S,
  dayRows,
  deskRows,
  rangeFrom,
  useDeskHistory,
  useInstrumentFills,
  weekBars,
  type HInterval,
  type Mode,
  type Range,
  type Row,
} from "./history/data";
import "./history/history.css";

const INST_KEY = "ex.hist.inst";
const HIDDEN0 = ["pi", "other", "stack"];
/** Klines at most for an instrument's range (15m over All would be years of bars). */
const MAX_KLINES = 10_000;

function savedInst(): { symbol: string; venue: Venue } | null {
  try {
    const v = JSON.parse(localStorage.getItem(INST_KEY) ?? "null") as { symbol?: string; venue?: string } | null;
    return v?.symbol ? { symbol: v.symbol, venue: v.venue === "usdm" ? "usdm" : "spot" } : null;
  } catch {
    return null;
  }
}
function saveInst(v: { symbol: string; venue: Venue } | null) {
  try {
    localStorage.setItem(INST_KEY, JSON.stringify(v));
  } catch {
    /* private mode */
  }
}

const pad = (n: number) => (n < 10 ? "0" + n : String(n));
const ymd = (ms: number) => {
  const d = new Date(ms);
  return `${d.getUTCFullYear()}/${pad(d.getUTCMonth() + 1)}/${pad(d.getUTCDate())}`;
};

export function History() {
  const route = useStore((s) => s.route);
  const tz = useStore((s) => s.tz);
  const hide = useStore((s) => s.hideAmounts);
  const dayStart = useStore((s) => s.snap?.summary.day_start ?? null);
  const snapDays = useStore((s) => s.snap?.days);
  const symbols = useStore((s) => s.snap?.symbols);

  const inst = route.detail?.kind === "history-instrument" ? { symbol: route.detail.symbol, venue: route.detail.venue } : null;
  const focusDay = route.detail?.kind === "day" ? route.detail.date : null;

  // a plain #/history comes back to the instrument last looked at
  useEffect(() => {
    const r = useStore.getState().route;
    const saved = savedInst();
    if (!r.detail && saved) navigate({ page: "history", detail: { kind: "history-instrument", ...saved } }, { push: false });
  }, []);
  const pickInst = (symbol: string, venue: Venue) => {
    saveInst({ symbol, venue });
    navigate({ page: "history", detail: { kind: "history-instrument", symbol, venue } }, { push: false });
  };
  const pickDesk = () => {
    saveInst(null);
    navigate({ page: "history" }, { push: false });
  };
  const lastInst = useRef(inst ?? savedInst());
  if (inst) lastInst.current = inst;

  const [range, setRange] = useExPref<Range>("hist", "range", "30d", RANGES);
  const [iv, setIv] = useExPref<HInterval>("hist", "interval", "1d", INTERVALS);
  const [mode, setMode] = useExPref<Mode>("hist", "mode", "daily", MODES);
  const { hidden, toggle } = useExHidden("hist", HIDDEN0);
  const [tab, setTab] = useExPref<"day" | "hour">("hist", "table", "day", ["day", "hour"]);

  const from = dayStart == null ? null : rangeFrom(range, dayStart);

  // ---- desk ----
  const desk = useDeskHistory(STEP_S[iv], inst ? null : from);
  const daily = useDeskHistory(86_400, inst ? null : from);
  const hours = useDeskHistory(3600, !inst && tab === "hour" ? dayStart : null);
  const prevRows = useRef<Row[] | null>(null);
  const rows = useMemo(() => {
    if (dayStart == null || !desk.bars.length) return (prevRows.current = []);
    const r = iv === "1w" ? deskRows(weekBars(desk.bars), "week", dayStart, null) : deskRows(desk.bars, "day", dayStart, prevRows.current);
    prevRows.current = r;
    return r;
  }, [desk.bars, iv, dayStart]);
  const hourRows = useMemo(() => (dayStart == null ? [] : deskRows(hours.bars, "day", dayStart, null)), [hours.bars, dayStart]);
  const days = useMemo(() => (from == null ? [] : dayRows(snapDays, daily.bars, daily.days, from)), [snapDays, daily.bars, daily.days, from]);
  const todayDay = snapDays?.[snapDays.length - 1]?.day ?? null;

  // ---- instrument ----
  const nBars = from == null || dayStart == null ? 0 : Math.min(MAX_KLINES, Math.ceil((dayStart + DAY - from) / IV_MS[iv]));
  const kl = useKlines(inst && nBars ? inst.symbol : null, inst?.venue ?? "spot", iv as KInterval, { bars: nBars });
  const fills = useInstrumentFills(inst?.symbol ?? null, inst?.venue ?? "spot", inst ? from : null);
  const instRow = inst ? symbols?.find((s) => s.symbol === inst.symbol && s.venue === inst.venue) : undefined;
  const avgCost = instRow?.avg_cost ?? null;

  // ---- zoom to a chosen day: the chart's view while a day is chosen (ExChart applies it after each load) ----
  const focusStart = focusDay ? (days.find((d) => d.day === focusDay)?.start ?? null) : null;
  const view = useMemo<ExView | null>(() => {
    if (focusStart == null) return null;
    const span = iv === "1w" ? 70 * DAY : iv === "1d" ? 10 * DAY : 0;
    return { time: { from: focusStart - span, to: focusStart + DAY + span } };
  }, [focusStart, iv]);
  const onDay = (day: string) => navigate({ page: "history", detail: { kind: "day", date: day } }, { push: false });

  // ---- toolbar ----
  const ivOptions = INTERVALS.map((v) => ({ value: v, label: IV_LABEL[v] }));
  const rangeToggle = (
    <>
      <TextToggle label="Range" options={RANGES.map((r) => ({ value: r, label: RANGE_LABEL[r] }))} value={range} onChange={setRange} />
      <span className="ex-tt-div hx-tb-div" />
    </>
  );
  const dailyLabel = iv === "1d" ? "Daily" : iv === "1w" ? "Weekly" : "Per bar";
  const modes = [
    {
      label: "Chart type",
      value: mode,
      onChange: (v: string) => setMode(v as Mode),
      options: [
        { value: "daily", label: dailyLabel, title: "What each bar made" },
        { value: "cum", label: "Cumulative", title: "Running total from the start of the range" },
        { value: "candles", label: "Candles", title: iv === "1w" ? "Each week's PnL from 0 at its start" : "Each bar's PnL since its day start" },
      ],
    },
  ];
  const span = from == null || dayStart == null ? "" : `${ymd(range === "all" && desk.bars[0] ? desk.bars[0].t : from)} – ${ymd(dayStart)} ${tz === "utc" ? "UTC" : ""}`;

  const instTitle = inst ? `${inst.symbol}${inst.venue === "usdm" ? " Perp" : ""} · ${RANGE_LABEL[range]}` : "";
  return (
    <div className="page hx-page">
      <section className="panel hx-chart">
        <div className="hx-head">
          <div className="ex-tabs md" role="tablist">
            <button type="button" role="tab" aria-selected={!inst} className={"ex-tab" + (!inst ? " on" : "")} onClick={pickDesk}>
              Desk
            </button>
            <InstrumentPicker value={inst ?? lastInst.current} active={!!inst} onPick={pickInst} />
          </div>
          <span className="hx-span muted fig">{span}</span>
        </div>
        <div className="hx-chart-body">
          {inst ? (
            <InstChart
              key="inst"
              symbol={inst.symbol}
              bars={kl.bars}
              fills={fills.fills}
              interval={iv}
              avgCost={avgCost}
              loading={kl.loading || nBars === 0}
              error={kl.error}
              toolbarLeft={rangeToggle}
              intervals={ivOptions}
              onInterval={(v) => setIv(v as HInterval)}
              view={view}
              hide={hide}
            />
          ) : (
            <DeskChart
              key="desk"
              rows={rows}
              interval={iv}
              mode={mode}
              hidden={hidden}
              onToggle={toggle}
              loading={desk.loading || from == null}
              error={desk.error}
              toolbarLeft={rangeToggle}
              intervals={ivOptions}
              onInterval={(v) => setIv(v as HInterval)}
              modes={modes}
              view={view}
              hide={hide}
            />
          )}
        </div>
      </section>
      <section className="panel hx-side">
        {inst ? (
          <InstSide title={instTitle} fills={fills.fills} bars={kl.bars} loading={kl.loading || fills.loading} hide={hide} today={instRow} />
        ) : (
          <DeskSide rows={days} title={`Desk · ${RANGE_LABEL[range]}`} todayDay={todayDay} selected={focusDay} onDay={onDay} hide={hide} />
        )}
      </section>
      <section className="panel hx-table">
        <div className="hx-head">
          <Tabs
            items={[
              { value: "day", label: "By day" },
              { value: "hour", label: "By hour (today)" },
            ]}
            value={tab}
            onChange={setTab}
          />
          <span className="hx-span muted">{inst ? "Our fills" : "USDT"}</span>
        </div>
        <div className="hx-table-body">
          {inst ? (
            tab === "day" ? (
              <InstDays fills={fills.fills} dayStart={dayStart ?? 0} hide={hide} />
            ) : (
              <InstHours fills={fills.fills} dayStart={dayStart ?? 0} tz={tz} hide={hide} />
            )
          ) : tab === "day" ? (
            <DeskDays rows={days} todayDay={todayDay} selected={focusDay} onDay={onDay} hide={hide} />
          ) : (
            <DeskHours rows={hourRows} tz={tz} hide={hide} />
          )}
        </div>
      </section>
    </div>
  );
}
