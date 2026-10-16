// Binance's rolling 24 h stats per instrument (last, open, high, low, volume), from its public `<sym>@miniTicker`
// stream, straight from the browser: one combined-stream socket per venue, shared by every subscriber, which
// subscribes and unsubscribes instruments as components come and go. In mock mode the stats come from the
// mock's minute path (historyMock), once a second.
import { useCallback, useMemo, useSyncExternalStore } from "react";
import type { Venue } from "../../protocol";

export interface Ticker24h {
  /** Last price. */
  last: number;
  /** Price 24 h ago. */
  open: number;
  high: number;
  low: number;
  /** Base-asset volume, 24 h. */
  volume: number;
  /** Quote (USDT) volume, 24 h. */
  quoteVolume: number;
  /** last − open. */
  change: number;
  /** (last − open) / open × 100. */
  changePct: number;
  /** Event time, ms. */
  t: number;
}

const MOCK = import.meta.env.VITE_MOCK === "1";
const URL: Record<Venue, string> = {
  spot: "wss://stream.binance.com:9443/stream",
  // USD-M market streams live under /market (DESIGN.md); verified with SUBSCRIBE on 2026-10-16
  usdm: "wss://fstream.binance.com/market/stream",
};

const keyOf = (symbol: string, venue: Venue) => `${venue}:${symbol}`;
const streamOf = (symbol: string) => `${symbol.toLowerCase()}@miniTicker`;

const data = new Map<string, Ticker24h>();
const listeners = new Map<string, Set<() => void>>();
const refs = new Map<string, number>();

function emit(k: string) {
  listeners.get(k)?.forEach((f) => f());
}

/** When each instrument's stats last came, local clock: stats older than STALE_MS are dropped (shown as --, not
 *  as live), and an instrument nobody shows any more forgets its stats. */
const got = new Map<string, number>();
const STALE_MS = 60_000;
let sweeper: ReturnType<typeof setInterval> | undefined;
function sweep() {
  const now = Date.now();
  for (const [k, t] of got)
    if (now - t > STALE_MS) {
      got.delete(k);
      if (data.delete(k)) emit(k);
    }
  if (!got.size) {
    clearInterval(sweeper);
    sweeper = undefined;
  }
}

function put(k: string, x: { c: number; o: number; h: number; l: number; v: number; q: number; E: number }) {
  got.set(k, Date.now());
  sweeper ??= setInterval(sweep, 5000);
  data.set(k, {
    last: x.c,
    open: x.o,
    high: x.h,
    low: x.l,
    volume: x.v,
    quoteVolume: x.q,
    change: x.c - x.o,
    changePct: x.o ? ((x.c - x.o) / x.o) * 100 : 0,
    t: x.E,
  });
  emit(k);
}

// ---- one socket per venue ----

interface Conn {
  ws: WebSocket | null;
  /** Streams this socket has asked for. */
  on: Set<string>;
  tries: number;
  retry?: ReturnType<typeof setTimeout>;
  idle?: ReturnType<typeof setTimeout>;
  flush?: ReturnType<typeof setTimeout>;
  id: number;
}
const conns: Record<Venue, Conn> = { spot: { ws: null, on: new Set(), tries: 0, id: 1 }, usdm: { ws: null, on: new Set(), tries: 0, id: 1 } };

/** The streams a venue's subscribers want now. */
function wanted(venue: Venue): Set<string> {
  const out = new Set<string>();
  for (const [k, n] of refs) if (n > 0 && k.startsWith(venue + ":")) out.add(streamOf(k.slice(venue.length + 1)));
  return out;
}

function open(venue: Venue) {
  const c = conns[venue];
  if (c.ws || typeof WebSocket === "undefined") return;
  let ws: WebSocket;
  try {
    ws = new WebSocket(URL[venue]);
  } catch {
    return;
  }
  c.ws = ws;
  c.on = new Set();
  ws.onopen = () => {
    c.tries = 0;
    sync(venue);
  };
  ws.onmessage = (ev) => {
    let m: { stream?: string; data?: { s: string; c: string; o: string; h: string; l: string; v: string; q: string; E: number } };
    try {
      m = JSON.parse(ev.data as string);
    } catch {
      return;
    }
    const d = m.data;
    if (!d?.s) return;
    put(keyOf(d.s, venue), { c: +d.c, o: +d.o, h: +d.h, l: +d.l, v: +d.v, q: +d.q, E: d.E });
  };
  ws.onclose = () => {
    c.ws = null;
    c.on = new Set();
    if (!wanted(venue).size) return;
    // slower each time, up to a minute
    c.retry = setTimeout(() => open(venue), Math.min(60_000, 1000 * 2 ** c.tries++));
  };
  ws.onerror = () => ws.close();
}

/** Ask for what is wanted and drop what is not (batched: a page mounting many rows sends one message). */
function sync(venue: Venue) {
  const c = conns[venue];
  clearTimeout(c.flush);
  c.flush = setTimeout(() => {
    const want = wanted(venue);
    if (!want.size) {
      // nobody left: close after a while (a page switch often comes straight back)
      clearTimeout(c.idle);
      c.idle = setTimeout(() => {
        if (wanted(venue).size || !c.ws) return;
        const ws = c.ws;
        c.ws = null;
        ws.onclose = ws.onmessage = ws.onerror = null;
        ws.close();
      }, 30_000);
      return;
    }
    clearTimeout(c.idle);
    if (!c.ws) return open(venue);
    if (c.ws.readyState !== WebSocket.OPEN) return; // onopen syncs
    const add = [...want].filter((s) => !c.on.has(s));
    const drop = [...c.on].filter((s) => !want.has(s));
    if (add.length) c.ws.send(JSON.stringify({ method: "SUBSCRIBE", params: add, id: c.id++ }));
    if (drop.length) c.ws.send(JSON.stringify({ method: "UNSUBSCRIBE", params: drop, id: c.id++ }));
    add.forEach((s) => c.on.add(s));
    drop.forEach((s) => c.on.delete(s));
  }, 50);
}

// ---- mock: the stats of the mock's minute path, each second ----

let mockTimer: ReturnType<typeof setInterval> | undefined;
function mockTick() {
  void import("../../historyMock").then(({ mockTicker24h }) => {
    for (const [k, n] of refs) {
      if (n <= 0) continue;
      const [venue, symbol] = k.split(":") as [Venue, string];
      const x = mockTicker24h(symbol, venue);
      if (x) put(k, { c: x.last, o: x.open, h: x.high, l: x.low, v: x.volume, q: x.quoteVolume, E: Date.now() });
    }
  });
}

function retain(k: string) {
  refs.set(k, (refs.get(k) ?? 0) + 1);
  if (MOCK) {
    if (!mockTimer) mockTimer = setInterval(mockTick, 1000);
    if (!data.has(k)) mockTick();
    return;
  }
  sync(k.split(":")[0] as Venue);
}

function release(k: string) {
  const n = (refs.get(k) ?? 0) - 1;
  if (n > 0) refs.set(k, n);
  else {
    refs.delete(k);
    // its stream stops: what it last said would read as live on a later mount (a quick re-subscribe, a list
    // re-filtered, keeps it)
    setTimeout(() => {
      if (refs.has(k)) return;
      data.delete(k);
      got.delete(k);
    }, 5000);
  }
  if (MOCK) {
    if (!refs.size) {
      clearInterval(mockTimer);
      mockTimer = undefined;
    }
    return;
  }
  sync(k.split(":")[0] as Venue);
}

function subscribe(keys: readonly string[], fn: () => void): () => void {
  for (const k of keys) {
    (listeners.get(k) ?? listeners.set(k, new Set()).get(k)!).add(fn);
    retain(k);
  }
  return () => {
    for (const k of keys) {
      listeners.get(k)?.delete(fn);
      release(k);
    }
  };
}

/**
 * An instrument's Binance 24 h stats (`<sym>@miniTicker`), live (about once a second), or null until the first
 * message (and when Binance is unreachable from the browser: show `--`). `symbol` null: nothing.
 *
 *   const t = useTicker24h("ETHUSDT", "spot");   // t?.changePct, t?.high, t?.low, t?.quoteVolume
 */
export function useTicker24h(symbol: string | null, venue: Venue): Ticker24h | null {
  const k = symbol ? keyOf(symbol, venue) : "";
  const sub = useCallback((fn: () => void) => (k ? subscribe([k], fn) : () => {}), [k]);
  return useSyncExternalStore(
    sub,
    () => (k ? (data.get(k) ?? null) : null),
    () => null,
  );
}

/**
 * Many instruments' 24 h stats at once (a markets list): a Map keyed `"<venue>:<SYMBOL>"`. One subscription per
 * instrument on the shared sockets; a new Map whenever any of them updates.
 */
export function useTickers24h(list: readonly { symbol: string; venue: Venue }[]): ReadonlyMap<string, Ticker24h> {
  const keys = useMemo(() => [...new Set(list.map((i) => keyOf(i.symbol, i.venue)))].sort(), [list]);
  const sig = keys.join(",");
  // the snapshot must be stable between updates: a version bumped by the listener
  const box = useMemo(() => ({ v: 0, seen: -1, map: new Map<string, Ticker24h>() as ReadonlyMap<string, Ticker24h> }), [sig]);
  useSyncExternalStore(
    // eslint-disable-next-line react-hooks/exhaustive-deps
    useMemo(() => (fn: () => void) => subscribe(keys, () => ((box.v += 1), fn())), [sig]),
    () => box.v,
    () => 0,
  );
  if (box.seen !== box.v) {
    const m = new Map<string, Ticker24h>();
    for (const k of keys) {
      const x = data.get(k);
      if (x) m.set(k, x);
    }
    box.map = m;
    box.seen = box.v;
  }
  return box.map;
}

/** The map key useTickers24h uses. */
export const tickerKey = keyOf;

/** Outside React: call `fn` with each update of an instrument's 24 h stats; returns the unsubscribe. */
export function watchTicker24h(symbol: string, venue: Venue, fn: (t: Ticker24h) => void): () => void {
  const k = keyOf(symbol, venue);
  return subscribe([k], () => {
    const x = data.get(k);
    if (x) fn(x);
  });
}
