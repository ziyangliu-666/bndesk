// Our fills on one instrument (symbol + venue) over a chart's range, for every instrument chart (Desk, History,
// the phone): /api/fills for the range, then the range's tail fetched again every 15 s, then the live tape after
// that. Kept per instrument while a chart shows it (and a few after), so a chart that loads earlier bars only
// asks for the part before what it has, and fills in the middle of a long session are never missing (the
// store's tape holds the desk's newest 2000 only).
import { useEffect, useMemo, useState } from "react";
import { getJSON, type HistFill } from "../../api";
import { serverNow, useStore } from "../../store";
import type { Fill, Venue } from "../../protocol";

/** /api/fills answers at most this many (server history.rs MAX_FILLS). */
const PAGE = 20_000;
/** Pages per request round (a busy instrument over 90 days): the rest comes on the next round. */
const PAGES = 5;
const TAIL_MS = 15_000;
const KEEP = 8;

interface Entry {
  key: string;
  symbol: string;
  venue: Venue;
  /** Ascending by time; [from, to) is covered. */
  fills: HistFill[];
  from: number;
  to: number;
  busy: boolean;
  subs: Set<() => void>;
  timer: ReturnType<typeof setTimeout> | null;
  /** The wanted start (the earliest any chart asked for). */
  want: number;
}
const entries = new Map<string, Entry>();

/** [from, to) from /api/fills, paged; `end`: where the result stops covering (to, or earlier when cut). */
async function fetchRange(symbol: string, venue: Venue, from: number, to: number): Promise<{ fills: HistFill[]; end: number }> {
  const out: HistFill[] = [];
  let f = from;
  for (let i = 0; i < PAGES; i++) {
    const page = await getJSON<HistFill[]>("/api/fills", { symbol, venue, from: f, to });
    const mine = page.filter((x) => x.venue === venue);
    if (page.length < PAGE) {
      out.push(...mine);
      return { fills: out, end: to };
    }
    // a full page may stop inside a millisecond: keep what is before it and ask again from that millisecond
    const last = page[page.length - 1]!.t;
    const before = mine.filter((x) => x.t < last);
    if (before.length === mine.length) {
      out.push(...mine); // one millisecond fills the page: nothing better to do
      f = last + 1;
    } else {
      out.push(...before);
      f = last;
    }
  }
  return { fills: out, end: f };
}

function notify(e: Entry) {
  for (const cb of e.subs) cb();
}

async function pull(e: Entry) {
  if (e.busy) return;
  e.busy = true;
  try {
    const now = serverNow();
    if (!e.fills.length && e.to <= e.from) {
      // first load
      const r = await fetchRange(e.symbol, e.venue, e.want, now);
      e.fills = r.fills;
      e.from = e.want;
      e.to = r.end;
    } else {
      if (e.want < e.from) {
        // earlier bars: only the part before what is held
        const r = await fetchRange(e.symbol, e.venue, e.want, e.from);
        // cut short: what came is complete up to its end only, so keep the old start until it all came
        if (r.end >= e.from) {
          e.fills = r.fills.concat(e.fills);
          e.from = e.want;
        }
      }
      // the tail: from where the held fills stop to now
      const r = await fetchRange(e.symbol, e.venue, e.to, serverNow());
      if (r.fills.length) e.fills = e.fills.concat(r.fills);
      e.to = r.end;
    }
  } catch {
    /* the next round tries again */
  } finally {
    e.busy = false;
  }
  notify(e);
}

function schedule(e: Entry) {
  if (e.timer) clearTimeout(e.timer);
  e.timer = null;
  if (!e.subs.size) return;
  e.timer = setTimeout(async () => {
    if (document.visibilityState !== "hidden") await pull(e);
    schedule(e);
  }, TAIL_MS);
}

function subscribe(symbol: string, venue: Venue, from: number, cb: () => void): () => void {
  const key = `${symbol}|${venue}`;
  let e = entries.get(key);
  if (!e) {
    e = { key, symbol, venue, fills: [], from, to: from, busy: false, subs: new Set(), timer: null, want: from };
    entries.set(key, e);
  }
  const entry = e;
  // most recently used last (the oldest unwatched ones go first)
  entries.delete(key);
  entries.set(key, entry);
  for (const [k, x] of entries) {
    if (entries.size <= KEEP) break;
    if (!x.subs.size && k !== key) entries.delete(k);
  }
  entry.subs.add(cb);
  const earlier = from < entry.want;
  if (earlier) entry.want = from;
  if (!entry.busy && (earlier || entry.to <= entry.from)) void pull(entry).then(() => schedule(entry));
  else schedule(entry);
  return () => {
    entry.subs.delete(cb);
    if (!entry.subs.size && entry.timer) {
      clearTimeout(entry.timer);
      entry.timer = null;
    }
  };
}

export interface InstFills {
  /** Our fills from `from` on, oldest first: the history, then the live tape after it. */
  fills: HistFill[];
  /** The history covers all of [from, now) (an inventory rebuilt backwards through the fills holds). */
  complete: boolean;
  loading: boolean;
}

const NONE: HistFill[] = [];
const toHist = (f: Fill): HistFill => ({ t: f.ts, side: f.side, price: f.price, qty: f.qty, account: f.account, venue: f.venue, maker: f.maker });

/** Our fills on `symbol` / `venue` from `from` (ms; null: none wanted) to now, kept current. */
export function useInstFills(symbol: string | null, venue: Venue, from: number | null): InstFills {
  const [, bump] = useState(0);
  useEffect(() => {
    if (!symbol || from == null) return;
    return subscribe(symbol, venue, from, () => bump((n) => n + 1));
  }, [symbol, venue, from]);
  const e = symbol ? entries.get(`${symbol}|${venue}`) : undefined;
  const live = useStore((s) => s.snap?.fills);
  const held = e?.fills;
  const to = e?.to ?? 0;
  const fills = useMemo(() => {
    if (!held || from == null) return NONE;
    // the tape (newest first) after what the history covers; before that the history has them
    const tail: HistFill[] = [];
    for (const f of live ?? []) {
      if (f.ts < to) break;
      if (f.symbol === symbol && f.venue === venue) tail.push(toHist(f));
    }
    tail.reverse();
    let i = 0;
    while (i < held.length && held[i]!.t < from) i++;
    const base = i ? held.slice(i) : held;
    return tail.length ? base.concat(tail) : base;
  }, [held, to, live, symbol, venue, from]);
  const ready = !!e && e.to > e.from;
  return { fills: ready ? fills : NONE, complete: ready && e!.from <= (from ?? Infinity), loading: !!symbol && from != null && !ready };
}
