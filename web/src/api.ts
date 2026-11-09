import type { Venue } from "./protocol";
// REST reads for the history page. Same-origin; the session cookie rides along.

export interface HistBar {
  t: number;
  o: number;
  h: number;
  l: number;
  c: number;
  pi: number | null;
  mm: number | null; // market making against the reference fair, cumulative like pi
  edge?: number; // by fill time, summed since `from`: on the own mid at the fill
  quoting?: number; // ... on the own mid at the desk's horizon
  fair_mm?: number; // ... against the reference fair
  realized: number | null;
  hedge: number | null;
  rebates: number | null; // market-maker rebates, cumulative like pi
  inventory: number | null;
  futures: number | null;
  equity?: number | null; // equity of all accounts, last in the bar
  volume: number;
  fills: number;
}
/** The bars with market making on the own mid (`quoting`, by fill time) where the desk kept the trading split; the
 *  reference fair's mark stays in `fair_mm`. */
export function ownMid(h: History): History {
  for (const b of h.bars) if (b.pi != null && b.quoting != null) b.mm = b.quoting;
  return h;
}
export interface HistDay {
  day: string;
  start: number;
}
export interface History {
  step: number;
  bars: HistBar[];
  days: HistDay[];
}
export interface HistFill {
  t: number;
  side: "buy" | "sell";
  price: number;
  qty: number;
  account: string;
  venue: Venue;
  maker: boolean;
}
/** [t, o, h, l, c, v] */
export type Kline = [number, number, number, number, number, number];

type Params = Record<string, string | number>;

export async function getJSON<T>(path: string, params: Params, signal?: AbortSignal): Promise<T> {
  if (import.meta.env.VITE_MOCK === "1" && path.startsWith("/api/engine/")) {
    const { engineMock } = await import("./engineMock");
    await new Promise((r) => setTimeout(r, 80));
    return JSON.parse(JSON.stringify(engineMock(path, params))) as T;
  }
  if (import.meta.env.VITE_MOCK === "1") {
    const { mockApi } = await import("./historyMock");
    await new Promise((r) => setTimeout(r, 80));
    return JSON.parse(JSON.stringify(mockApi(path, params))) as T;
  }
  const qs = new URLSearchParams(Object.entries(params).map(([k, v]) => [k, String(v)]));
  const r = await fetch(`${path}?${qs}`, { cache: "no-store", credentials: "same-origin", signal });
  if (!r.ok) throw new Error(`${r.status} ${r.statusText}`.trim());
  return (await r.json()) as T;
}
