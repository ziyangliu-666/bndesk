// Klines for ExChart: history from the server's /api/klines (Binance's, proxied and cached; generated in mock
// mode), and the forming candle kept live from Binance's public kline stream, falling back to the desk's own
// mid for the instrument when the stream is not available.
import { useEffect, useRef, useState } from "react";
import { getJSON, type Kline } from "../../api";
import { serverNow, useStore } from "../../store";
import type { Venue } from "../../protocol";

export type KInterval = "1m" | "5m" | "15m" | "30m" | "1h" | "4h" | "1d" | "1w";

export const INTERVAL_MS: Record<KInterval, number> = {
  "1m": 60_000,
  "5m": 300_000,
  "15m": 900_000,
  "30m": 1_800_000,
  "1h": 3_600_000,
  "4h": 14_400_000,
  "1d": 86_400_000,
  "1w": 604_800_000,
};

/** Every interval comes from the server (server/src/history.rs INTERVALS). A server from before 30m and 1w were
 *  added answers 400 to them: they are then built here from a finer one, 30m from 15m and 1w from 1d. */
const DERIVED: Partial<Record<KInterval, KInterval>> = { "30m": "15m", "1w": "1d" };

/** Monday 00:00 UTC is a week's start (Binance); the epoch was a Thursday. */
const WEEK_OFFSET = 4 * 86_400_000;

/** The start of the bar `ms` falls in. `interval` is a name or a bar size in ms (aligned to the epoch). */
export function barStart(ms: number, interval: KInterval | number): number {
  if (interval === "1w") return Math.floor((ms - WEEK_OFFSET) / INTERVAL_MS["1w"]) * INTERVAL_MS["1w"] + WEEK_OFFSET;
  const step = typeof interval === "number" ? interval : INTERVAL_MS[interval];
  return Math.floor(ms / step) * step;
}

/** One bar. `volume` in the base asset (Binance's `v`); quote volume ≈ volume × close. */
export interface Candle {
  time: number; // bar start, ms
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

const fromKline = (k: Kline): Candle => ({ time: k[0], open: k[1], high: k[2], low: k[3], close: k[4], volume: k[5] });

/** Coarser bars from finer ones (sorted). */
export function aggregate(bars: readonly Candle[], interval: KInterval): Candle[] {
  const out: Candle[] = [];
  for (const b of bars) {
    const t = barStart(b.time, interval);
    const last = out[out.length - 1];
    if (last && last.time === t) {
      last.high = Math.max(last.high, b.high);
      last.low = Math.min(last.low, b.low);
      last.close = b.close;
      last.volume += b.volume;
    } else out.push({ ...b, time: t });
  }
  return out;
}

export type KlineSource = "binance" | "mid" | null;

export interface KlinesState {
  /** Oldest first. Empty while loading (and at once after a change of symbol or interval). Earlier bars keep
   *  their object identity across live updates, so ExChart updates only the last bar. */
  bars: Candle[];
  loading: boolean;
  error: string | null;
  /** What moves the forming candle: Binance's kline stream, the desk's own mid, or nothing yet. */
  live: KlineSource;
}

export interface KlinesOptions {
  /** Bars of history to load. Default 500. */
  bars?: number;
  /** Use Binance's public kline stream for the forming candle (never in mock mode). Default true. */
  stream?: boolean;
}

const MOCK = import.meta.env.VITE_MOCK === "1";

function streamUrl(symbol: string, venue: Venue, iv: KInterval): string {
  const s = `${symbol.toLowerCase()}@kline_${iv}`;
  // USD-M's market-data streams moved under /market (DESIGN.md: bookTicker under /public, the rest /market)
  return venue === "spot" ? `wss://stream.binance.com:9443/ws/${s}` : `wss://fstream.binance.com/market/ws/${s}`;
}

/**
 * `useKlines(symbol, venue, interval)`: an instrument's bars for ExChart's candles. History comes from
 * `/api/klines` (mock: generated around the instrument's mid). The forming candle follows Binance's public
 * `<sym>@kline_<interval>` stream when it connects, else the desk's mid for that instrument (store), so it is
 * live in mock mode and when Binance is unreachable from the browser. A change of symbol or interval empties
 * `bars` at once (no stale bars under a new label) and sets `loading` until the new ones arrive.
 * `symbol` null: nothing is loaded.
 */
export function useKlines(symbol: string | null, venue: Venue, interval: KInterval, opts: KlinesOptions = {}): KlinesState {
  const n = opts.bars ?? 500;
  const useStream = (opts.stream ?? true) && !MOCK;
  const key = symbol ? `${symbol}|${venue}|${interval}|${n}` : "";
  const [st, setSt] = useState<{ key: string; bars: Candle[]; error: string | null; live: KlineSource }>({ key: "", bars: [], error: null, live: null });
  const keyRef = useRef(key);
  keyRef.current = key;

  useEffect(() => {
    if (!symbol) return;
    const ac = new AbortController();
    let done = false;
    let lastStream = 0; // local ms of the last kline message
    let ws: WebSocket | null = null;
    let wsTimer: ReturnType<typeof setTimeout> | undefined;
    let tries = 0;
    const step = INTERVAL_MS[interval];
    // updates that arrive before the history: applied once it is in
    const set = (fn: (bars: Candle[]) => Candle[] | null, live?: KlineSource) =>
      setSt((s) => {
        if (s.key !== key || !s.bars.length) return s;
        const next = fn(s.bars);
        if (!next) return live && live !== s.live ? { ...s, live } : s;
        return { ...s, bars: next, live: live ?? s.live };
      });

    // ---- history ----
    const to = serverNow();
    const from = to - n * step;
    setSt({ key, bars: [], error: null, live: null });
    const load = (iv: KInterval) => getJSON<Kline[]>("/api/klines", { symbol, venue, interval: iv, from, to }, ac.signal);
    load(interval)
      .then(
        (ks) => ks.map(fromKline),
        (e: unknown) => {
          const base = DERIVED[interval];
          if (!base || !(e instanceof Error) || !e.message.startsWith("400")) throw e;
          return load(base).then((ks) => aggregate(ks.map(fromKline), interval));
        },
      )
      .then((bars) => {
        if (done) return;
        setSt({ key, bars, error: bars.length ? null : "No klines for this instrument", live: null });
      })
      .catch((e: unknown) => {
        if (done) return;
        setSt({ key, bars: [], error: e instanceof Error ? e.message : String(e), live: null });
      });

    // ---- the forming candle: Binance's stream ----
    const openStream = () => {
      if (done || !useStream || typeof WebSocket === "undefined") return;
      try {
        ws = new WebSocket(streamUrl(symbol, venue, interval));
      } catch {
        return;
      }
      ws.onmessage = (ev) => {
        let k: { t: number; o: string; h: string; l: string; c: string; v: string } | undefined;
        try {
          k = (JSON.parse(ev.data as string) as { k?: typeof k }).k;
        } catch {
          return;
        }
        if (!k) return;
        lastStream = Date.now();
        tries = 0;
        const bar: Candle = { time: k.t, open: +k.o, high: +k.h, low: +k.l, close: +k.c, volume: +k.v };
        set((bars) => {
          const last = bars[bars.length - 1]!;
          if (bar.time < last.time) return null;
          return bar.time === last.time ? bars.slice(0, -1).concat(bar) : bars.concat(bar);
        }, "binance");
      };
      ws.onclose = () => {
        ws = null;
        // a few retries, slower each time; the mid carries the candle meanwhile
        if (!done && tries < 6) wsTimer = setTimeout(openStream, 2000 * 2 ** tries++);
      };
      ws.onerror = () => ws?.close();
    };
    openStream();

    // ---- the forming candle: the desk's mid, when the stream is quiet ----
    let lastMid: number | null = null;
    let pending = false;
    const onMid = () => {
      pending = false;
      if (done || Date.now() - lastStream < 10_000) return;
      const row = useStore.getState().snap?.symbols.find((r) => r.symbol === symbol && r.venue === venue);
      const mid = row?.mid;
      if (mid == null || !Number.isFinite(mid)) return;
      lastMid = mid;
      const t = barStart(serverNow(), interval);
      set((bars) => {
        const last = bars[bars.length - 1]!;
        if (t < last.time) return null;
        if (t > last.time) return bars.concat({ time: t, open: mid, high: mid, low: mid, close: mid, volume: 0 });
        if (mid === last.close && mid <= last.high && mid >= last.low) return null;
        return bars.slice(0, -1).concat({ ...last, high: Math.max(last.high, mid), low: Math.min(last.low, mid), close: mid });
      }, "mid");
    };
    // at most four updates a second
    const unsub = useStore.subscribe((s, prev) => {
      if (s.snap?.symbols === prev.snap?.symbols || pending) return;
      pending = true;
      setTimeout(onMid, 250);
    });
    // a new bar starts on time even with a still mid
    const tick = setInterval(() => lastMid != null && onMid(), 5_000);

    return () => {
      done = true;
      ac.abort();
      unsub();
      clearInterval(tick);
      clearTimeout(wsTimer);
      if (ws) {
        ws.onclose = ws.onmessage = ws.onerror = null;
        ws.close();
      }
    };
  }, [key, symbol, venue, interval, n, useStream]);

  const mine = st.key === key;
  return {
    bars: mine ? st.bars : EMPTY,
    loading: !!symbol && (!mine || (!st.bars.length && !st.error)),
    error: mine ? st.error : null,
    live: mine ? st.live : null,
  };
}

const EMPTY: Candle[] = [];
