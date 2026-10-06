import { useEffect, useMemo, useState } from "react";
import { create } from "zustand";
import { Select, SegmentedControl } from "@mantine/core";
import { useStore, serverNow } from "../store";
import { getJSON, type HistDay, type HistFill, type History as Hist, type Kline } from "../api";
import { DeskChart, InstrumentChart } from "../components/HistoryChart";
import { DaysTable, HourBars } from "../components/PnlDays";

type Mode = "desk" | "instrument";
type Range = "today" | "7d" | "30d" | "all" | "day";

const STEPS = [60, 300, 900, 3600, 14400, 86400] as const;
const STEP_LABEL: Record<number, string> = { 60: "1m", 300: "5m", 900: "15m", 3600: "1h", 14400: "4h", 86400: "1d" };
const DEFAULT_STEP: Record<Range, number> = { today: 60, day: 60, "7d": 900, "30d": 3600, all: 86400 };
const MAX_BARS = 5000;
const DAY = 86_400_000;
const REFRESH = 30_000;

interface HistState {
  mode: Mode;
  range: Range;
  day: string | null;
  step: number;
  inst: string | null; // "SYMBOL|venue"
  days: HistDay[];
  set: (p: Partial<Omit<HistState, "set">>) => void;
}
// Kept outside the page so the choices survive switching tabs.
const useHist = create<HistState>((set) => ({
  mode: "desk",
  range: "today",
  day: null,
  step: 60,
  inst: null,
  days: [],
  set: (p) => set(p),
}));

function resolveRange(range: Range, day: string | null, days: HistDay[], now: number): { from: number; to: number; live: boolean } {
  const utcMidnight = Math.floor(now / DAY) * DAY;
  switch (range) {
    case "today": {
      const last = [...days].reverse().find((d) => d.start <= now);
      return { from: last?.start ?? utcMidnight, to: now, live: true };
    }
    case "7d":
      return { from: now - 7 * DAY, to: now, live: true };
    case "30d":
      return { from: now - 30 * DAY, to: now, live: true };
    case "all":
      return { from: days[0]?.start ?? now - 90 * DAY, to: now, live: true };
    case "day": {
      const i = days.findIndex((d) => d.day === day);
      if (i < 0) return { from: utcMidnight, to: now, live: true };
      const next = days[i + 1];
      return { from: days[i]!.start, to: next ? next.start - 1 : now, live: !next };
    }
  }
}
const barsFor = (from: number, to: number, step: number) => Math.ceil((to - from) / (step * 1000));
function fitStep(step: number, from: number, to: number): number {
  return STEPS.find((s) => s >= step && barsFor(from, to, s) <= MAX_BARS) ?? 86400;
}

type Load<T> = { key: string; data: T | null; err: string | null; loading: boolean };

function useFetch<T>(key: string | null, run: (signal: AbortSignal) => Promise<T>, live: boolean): Load<T> {
  const [st, setSt] = useState<Load<T>>({ key: "", data: null, err: null, loading: false });
  useEffect(() => {
    if (!key) return;
    let ac = new AbortController();
    const go = (first: boolean) => {
      ac = new AbortController();
      if (first) setSt((s) => ({ ...s, loading: true, err: null }));
      run(ac.signal).then(
        (data) => setSt({ key, data, err: null, loading: false }),
        (e: unknown) => {
          if ((e as Error).name === "AbortError") return;
          setSt((s) => ({ ...s, err: (e as Error).message || "request failed", loading: false }));
        },
      );
    };
    go(true);
    const id = live ? setInterval(() => go(false), REFRESH) : undefined;
    return () => {
      ac.abort();
      if (id) clearInterval(id);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, live]);
  return st;
}

export function History() {
  const h = useHist();
  const tz = useStore((s) => s.tz);
  const symbols = useStore((s) => s.snap?.symbols);
  // Live ranges end at "now": the keys name the range, and each fetch resolves it afresh.
  const now = serverNow();

  const instOptions = useMemo(() => {
    const rows = (symbols ?? []).slice().sort((a, b) => (a.venue === b.venue ? b.volume_day - a.volume_day : a.venue === "spot" ? -1 : 1));
    return rows.map((r) => ({ value: `${r.symbol}|${r.venue}`, label: r.venue === "usdm" ? `${r.symbol} perp` : r.symbol }));
  }, [symbols]);
  const inst = h.inst ?? instOptions[0]?.value ?? null;
  const [symbol, venue] = (inst ?? "|").split("|") as [string, "spot" | "usdm"];

  const { from, to, live } = resolveRange(h.range, h.day, h.days, now);
  const step = fitStep(h.step, from, to);
  const span = () => resolveRange(h.range, h.day, h.days, serverNow());
  const rangeKey = live ? `${h.range}|${h.day}|${h.days[0]?.start ?? ""}` : `${from}|${to}`;

  const deskKey = h.mode === "desk" ? `desk|${rangeKey}|${step}` : null;
  const desk = useFetch<Hist>(
    deskKey,
    (signal) => {
      const r = span();
      return getJSON<Hist>("/api/history", { from: r.from, to: r.to, step }, signal);
    },
    live,
  );
  useEffect(() => {
    const d = desk.data?.days;
    if (d && d.length && (d.length !== h.days.length || d[d.length - 1]!.start !== h.days[h.days.length - 1]?.start)) h.set({ days: d });
  }, [desk.data, h]);
  // The day list also comes along when the page opens in instrument mode.
  useEffect(() => {
    if (h.days.length) return;
    const n = serverNow();
    getJSON<Hist>("/api/history", { from: n - 60_000, to: n, step: 60 }).then(
      (r) => r.days?.length && useHist.getState().set({ days: r.days }),
      () => {},
    );
  }, [h.days.length]);

  const instKey = h.mode === "instrument" && symbol ? `inst|${symbol}|${venue}|${rangeKey}|${step}` : null;
  const instr = useFetch<{ klines: Kline[]; fills: HistFill[]; step: number }>(
    instKey,
    async (signal) => {
      const r = span();
      const [klines, fills] = await Promise.all([
        getJSON<Kline[]>("/api/klines", { symbol, venue, interval: STEP_LABEL[step]!, from: r.from, to: r.to }, signal),
        getJSON<HistFill[]>("/api/fills", { symbol, from: r.from, to: r.to }, signal),
      ]);
      return { klines, fills: fills.filter((f) => f.venue === venue), step };
    },
    live,
  );

  const cur = h.mode === "desk" ? desk : instr;
  const fitKey = (h.mode === "desk" ? deskKey : instKey) ?? "";
  const stale = cur.key !== fitKey;
  const empty = !cur.loading && !cur.err && cur.data != null && (h.mode === "desk" ? desk.data!.bars.length === 0 : instr.data!.klines.length === 0);

  const pickRange = (r: Range) => h.set({ range: r, day: null, step: DEFAULT_STEP[r] });
  const dayOptions = [...h.days].reverse().map((d) => ({ value: d.day, label: d.day }));
  const fills = instr.data?.fills.length ?? 0;

  return (
    <div className="page history">
      <div className="hist-bar">
        <SegmentedControl
          size="xs"
          className="mini-seg"
          value={h.mode}
          onChange={(v) => h.set({ mode: v as Mode })}
          data={[
            { value: "desk", label: "Desk" },
            { value: "instrument", label: "Instrument" },
          ]}
        />
        {h.mode === "instrument" && (
          <Select
            size="xs"
            className="hist-select hist-sym"
            searchable
            value={inst}
            onChange={(v) => v && h.set({ inst: v })}
            data={instOptions}
            allowDeselect={false}
            comboboxProps={{ transitionProps: { duration: 0 } }}
            maxDropdownHeight={420}
            aria-label="Instrument"
            spellCheck={false}
          />
        )}
        <span className="hist-sep" />
        <SegmentedControl
          size="xs"
          className="mini-seg"
          value={h.range === "day" ? "" : h.range}
          onChange={(v) => pickRange(v as Range)}
          data={[
            { value: "today", label: "Today" },
            { value: "7d", label: "7d" },
            { value: "30d", label: "30d" },
            { value: "all", label: "All" },
          ]}
        />
        <Select
          size="xs"
          className="hist-select hist-day"
          placeholder="Day"
          value={h.range === "day" ? h.day : null}
          onChange={(v) => (v ? h.set({ range: "day", day: v, step: DEFAULT_STEP.day }) : pickRange("today"))}
          data={dayOptions}
          comboboxProps={{ transitionProps: { duration: 0 } }}
          maxDropdownHeight={360}
          aria-label="Day"
        />
        <span className="hist-sep" />
        <SegmentedControl
          size="xs"
          className="mini-seg"
          value={String(step)}
          onChange={(v) => h.set({ step: Number(v) })}
          data={STEPS.map((s) => ({ value: String(s), label: STEP_LABEL[s]!, disabled: barsFor(from, to, s) > MAX_BARS }))}
        />
        <div className="hist-status">
          {cur.err ? (
            <span className="warn-text">{cur.err}</span>
          ) : cur.loading ? (
            <span className="muted">loading</span>
          ) : h.mode === "instrument" && cur.data ? (
            <span className="muted fig">
              {fills} {fills === 1 ? "fill" : "fills"} on {venue === "usdm" ? "USD-M" : "spot"}
            </span>
          ) : null}
        </div>
      </div>
      <section className="panel hist-panel">
        {h.mode === "desk" ? (
          <DeskChart key="desk" bars={desk.data?.bars ?? []} days={h.days} step={desk.data?.step ?? step} tz={tz} fitKey={desk.key} />
        ) : (
          <InstrumentChart
            key="inst"
            klines={instr.data?.klines ?? []}
            fills={instr.data?.fills ?? []}
            days={h.days}
            step={instr.data?.step ?? step}
            tz={tz}
            fitKey={instr.key}
          />
        )}
        {(empty || (cur.err && !cur.data)) && <div className="hist-empty">{cur.err ? "Could not load history" : "No data in this range"}</div>}
        {stale && cur.loading && cur.data == null && <div className="hist-empty">Loading</div>}
      </section>
      <div className="hist-days">
        <DaysTable />
        <HourBars />
      </div>
    </div>
  );
}
