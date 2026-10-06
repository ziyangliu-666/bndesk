import { useEffect, useMemo, useState } from "react";
import { create } from "zustand";
import { Select, SegmentedControl } from "@mantine/core";
import { useStore, serverNow } from "../store";
import { getJSON, type HistBar, type HistDay, type HistFill, type History as Hist, type Kline } from "../api";
import { DeskChart, InstrumentChart } from "../components/HistoryChart";
import { DaysTable, HourBars } from "../components/PnlDays";

type Mode = "desk" | "instrument";

const STEPS = [60, 300, 900, 3600, 14400, 86400] as const;
const STEP_LABEL: Record<number, string> = { 60: "1m", 300: "5m", 900: "15m", 3600: "1h", 14400: "4h", 86400: "1d" };
const MAX_BARS = 5000; // bars per chunk; the server returns up to MAX_CHUNKS of them
const MAX_CHUNKS = 5;
const DAY = 86_400_000;
const REFRESH = 30_000;
const TAIL_REFRESH = 2_000; // the latest bars, so the lines move while the page is open

interface HistState {
  mode: Mode;
  step: number;
  inst: string | null; // "SYMBOL|venue"
  days: HistDay[];
  set: (p: Partial<Omit<HistState, "set">>) => void;
}
// Kept outside the page so the choices survive switching tabs.
const useHist = create<HistState>((set) => ({
  mode: "desk",
  step: 60,
  inst: null,
  days: [],
  set: (p) => set(p),
}));

/** The window for a step: `chunks` × MAX_BARS bars back from now, moved forward onto a day start (any known
 *  `dayStart`, else UTC midnight) so the running P&L starts from a day's open. */
function resolveRange(step: number, chunks: number, dayStart: number, now: number): { from: number; to: number } {
  const reach = now - chunks * MAX_BARS * step * 1000;
  return { from: reach + (((dayStart - reach) % DAY) + DAY) % DAY, to: now };
}

/** Each running total of `tail` (fetched from a later start) differs from `full`'s by a constant: it is read
 *  off the first bar both hold in full, and `tail` takes over from there. */
function joinTail(full: HistBar[], tail: HistBar[]): HistBar[] {
  if (!tail.length) return full;
  const j = full.findIndex((b) => b.t === tail[0]!.t);
  if (j < 0) return full;
  const off: Record<string, number> = { c: full[j]!.o - tail[0]!.o };
  for (const k of ["pi", "mm", "realized", "hedge"] as const) {
    for (let i = j; i < full.length - 1 && i - j < tail.length; i++) {
      const a = full[i]![k], b = tail[i - j]![k];
      if (a != null && b != null) {
        off[k] = a - b;
        break;
      }
    }
  }
  const add = (v: number | null, k: string) => (v == null || off[k] == null ? null : v + off[k]!);
  const c = off.c!;
  return [
    ...full.slice(0, j),
    ...tail.map((b) => ({
      ...b, o: b.o + c, h: b.h + c, l: b.l + c, c: b.c + c,
      pi: add(b.pi, "pi"), mm: add(b.mm, "mm"), realized: add(b.realized, "realized"), hedge: add(b.hedge, "hedge"),
    })),
  ];
}

type Load<T> = { key: string; data: T | null; err: string | null; loading: boolean };

function useFetch<T>(key: string | null, run: (signal: AbortSignal) => Promise<T>, live: boolean, every = REFRESH): Load<T> {
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
    const id = live ? setInterval(() => go(false), every) : undefined;
    return () => {
      ac.abort();
      if (id) clearInterval(id);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, live, every]);
  return st;
}

export function History() {
  const h = useHist();
  const tz = useStore((s) => s.tz);
  const symbols = useStore((s) => s.snap?.symbols);

  const instOptions = useMemo(() => {
    const rows = (symbols ?? []).slice().sort((a, b) => (a.venue === b.venue ? b.volume_day - a.volume_day : a.venue === "spot" ? -1 : 1));
    return rows.map((r) => ({ value: `${r.symbol}|${r.venue}`, label: r.venue === "usdm" ? `${r.symbol} perp` : r.symbol }));
  }, [symbols]);
  const inst = h.inst ?? instOptions[0]?.value ?? null;
  const [symbol, venue] = (inst ?? "|").split("|") as [string, "spot" | "usdm"];

  const step = h.step;
  const live = true; // the window ends at now: each refresh resolves it afresh
  // dragging to the left edge loads one more chunk of older bars, until the first desk day
  const viewKey = `${h.mode}|${inst}|${step}`;
  const [more, setMore] = useState({ key: "", chunks: 1 });
  const chunks = more.key === viewKey ? more.chunks : 1;
  const span = () => resolveRange(step, chunks, h.days[h.days.length - 1]?.start ?? 0, serverNow());

  const deskKey = h.mode === "desk" ? `${viewKey}#${chunks}` : null;
  const desk = useFetch<Hist>(
    deskKey,
    (signal) => {
      const r = span();
      return getJSON<Hist>("/api/history", { from: r.from, to: r.to, step }, signal);
    },
    false, // loaded once per view: the tail below keeps its end current
  );
  // the tail starts on the full data's second-to-last bar: complete there, so the two agree on it
  const full = desk.key === deskKey ? desk.data?.bars : undefined;
  const tailFrom = full && full.length >= 2 ? full[full.length - 2]!.t : null;
  const tailKey = deskKey && tailFrom != null ? `${deskKey}|${tailFrom}` : null;
  const tail = useFetch<Hist>(
    tailKey,
    (signal) => getJSON<Hist>("/api/history", { from: tailFrom!, to: serverNow(), step }, signal),
    live,
    TAIL_REFRESH,
  );
  const deskBars = useMemo(
    () => (full && tail.key === tailKey && tail.data ? joinTail(full, tail.data.bars) : (desk.data?.bars ?? [])),
    [full, tail.key, tail.data, tailKey, desk.data],
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

  const instKey = h.mode === "instrument" && symbol ? `${viewKey}#${chunks}` : null;
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
  const fetchKey = (h.mode === "desk" ? deskKey : instKey) ?? "";
  const stale = cur.key !== fetchKey;
  const onOlder = () => {
    if (cur.loading || cur.key !== fetchKey || chunks >= MAX_CHUNKS) return;
    // nothing older exists when the data starts more than a day after the start it was asked for
    const firstT = h.mode === "desk" ? desk.data?.bars[0]?.t : instr.data?.klines[0]?.[0];
    if (firstT == null || firstT > span().from + DAY) return;
    setMore({ key: viewKey, chunks: chunks + 1 });
  };
  const fitKey = cur.key.split("#")[0]!; // the view the loaded bars belong to: refit only once they arrive
  const empty = !cur.loading && !cur.err && cur.data != null && (h.mode === "desk" ? desk.data!.bars.length === 0 : instr.data!.klines.length === 0);

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
          value={String(step)}
          onChange={(v) => h.set({ step: Number(v) })}
          data={STEPS.map((s) => ({ value: String(s), label: STEP_LABEL[s]! }))}
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
          <DeskChart key="desk" bars={deskBars} days={h.days} step={desk.data?.step ?? step} tz={tz} fitKey={fitKey} onOlder={onOlder} />
        ) : (
          <InstrumentChart
            key="inst"
            klines={instr.data?.klines ?? []}
            fills={instr.data?.fills ?? []}
            days={h.days}
            step={instr.data?.step ?? step}
            tz={tz}
            fitKey={fitKey}
            onOlder={onOlder}
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
