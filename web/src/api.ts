// REST reads for the history page. Same-origin; the session cookie rides along.

export interface HistBar {
  t: number;
  o: number;
  h: number;
  l: number;
  c: number;
  pi: number | null;
  mm: number | null; // market making, cumulative like pi
  realized: number | null;
  hedge: number | null;
  inventory: number | null;
  futures: number | null;
  volume: number;
  fills: number;
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
  venue: "spot" | "usdm";
  maker: boolean;
}
/** [t, o, h, l, c, v] */
export type Kline = [number, number, number, number, number, number];

type Params = Record<string, string | number>;

export async function getJSON<T>(path: string, params: Params, signal?: AbortSignal): Promise<T> {
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
