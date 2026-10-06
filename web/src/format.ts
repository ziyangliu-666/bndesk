// Number and time formatting. Every signed figure carries its sign; minus is U+2212.

export const MINUS = "−";
export const DASH = "—";

const nf = (d: number) =>
  new Intl.NumberFormat("en-US", { minimumFractionDigits: d, maximumFractionDigits: d });
const NF: Record<number, Intl.NumberFormat> = {};
function fmtFixed(v: number, d: number): string {
  const f = (NF[d] ??= nf(d));
  return f.format(v);
}

function signed(abs: string, v: number, sign: boolean): string {
  if (v < 0) return MINUS + abs;
  if (sign && v > 0) return "+" + abs;
  return abs;
}

/** USD: 2 decimals, k suffix at or above 10k (m at or above 10m). */
export function usd(v: number | null | undefined, sign = false): string {
  if (v == null || !Number.isFinite(v)) return DASH;
  const a = Math.abs(v);
  let s: string;
  if (a >= 1e7) s = fmtFixed(a / 1e6, 2) + "m";
  else if (a >= 1e4) s = fmtFixed(a / 1e3, 2) + "k";
  else s = fmtFixed(a, 2);
  // a value that rounds to zero shows no sign
  if (s === "0.00") return s;
  return signed(s, v, sign);
}

/** USD in at most four significant figures, for tight sub-lines: 950.12, 9,501, 95.0k, 950k, 9.50m. */
export function usdShort(v: number | null | undefined): string {
  if (v == null || !Number.isFinite(v)) return DASH;
  const a = Math.abs(v);
  let s: string;
  if (a >= 1e7) s = fmtFixed(a / 1e6, 1) + "m";
  else if (a >= 1e6) s = fmtFixed(a / 1e6, 2) + "m";
  else if (a >= 1e5) s = fmtFixed(a / 1e3, 0) + "k";
  else if (a >= 1e4) s = fmtFixed(a / 1e3, 1) + "k";
  else if (a >= 1e3) s = fmtFixed(a, 0);
  else s = fmtFixed(a, 2);
  return signed(s, v, false);
}

/** USD always signed (PnL, gaps, transfers). */
export const pnl = (v: number | null | undefined) => usd(v, true);

/** bps: 1 decimal, always signed. */
export function bps(v: number | null | undefined, sign = true): string {
  if (v == null || !Number.isFinite(v)) return DASH;
  const s = fmtFixed(Math.abs(v), 1);
  if (s === "0.0") return s;
  return signed(s, v, sign);
}

export function num(v: number | null | undefined, d = 0, sign = false): string {
  if (v == null || !Number.isFinite(v)) return DASH;
  const s = fmtFixed(Math.abs(v), d);
  if (Number(s.replace(/,/g, "")) === 0) return s;
  return signed(s, v, sign);
}

export function int(v: number | null | undefined): string {
  return num(v, 0);
}

/** Price: significant precision by magnitude. */
export function price(v: number | null | undefined): string {
  if (v == null || !Number.isFinite(v)) return DASH;
  const a = Math.abs(v);
  const d = a >= 1000 ? 2 : a >= 10 ? 3 : a >= 1 ? 4 : a >= 0.01 ? 5 : 7;
  return num(v, d);
}

/** Quantity with up to 6 decimals, trailing zeros trimmed, signed. */
export function qty(v: number | null | undefined, sign = false): string {
  if (v == null || !Number.isFinite(v)) return DASH;
  const a = Math.abs(v);
  const d = a >= 1000 ? 0 : a >= 1 ? 3 : 6;
  let s = fmtFixed(a, d);
  if (s.includes(".")) s = s.replace(/0+$/, "").replace(/\.$/, "");
  if (s === "0") return s;
  return signed(s, v, sign);
}

export function pct(v: number | null | undefined, d = 0): string {
  if (v == null || !Number.isFinite(v)) return DASH;
  return fmtFixed(v * 100, d) + "%";
}

// ---- time ----

export type TzMode = "utc" | "local";

const pad = (n: number) => (n < 10 ? "0" + n : String(n));

export function hms(ms: number | null | undefined, tz: TzMode): string {
  if (ms == null) return DASH;
  const d = new Date(ms);
  return tz === "utc"
    ? `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`
    : `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

export function hm(ms: number, tz: TzMode): string {
  const d = new Date(ms);
  return tz === "utc"
    ? `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`
    : `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** Compact duration: 4s, 3m 05s, 2h 14m, 3d 4h. */
export function dur(ms: number | null | undefined): string {
  if (ms == null || !Number.isFinite(ms)) return DASH;
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${pad(s % 60)}s`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h}h ${pad(m % 60)}m`;
  return `${Math.floor(h / 24)}d ${h % 24}h`;
}

/** Short age for narrow cells: 42s, 13m, 2h 05m. */
export function age(ms: number | null | undefined): string {
  if (ms == null || !Number.isFinite(ms)) return DASH;
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  return `${Math.floor(m / 60)}h ${pad(m % 60)}m`;
}

/** Countdown clock h:mm:ss. */
export function countdown(ms: number | null | undefined): string {
  if (ms == null || !Number.isFinite(ms)) return DASH;
  const s = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(s / 3600);
  return `${h}:${pad(Math.floor((s % 3600) / 60))}:${pad(s % 60)}`;
}

export function signClass(v: number | null | undefined): string {
  if (v == null || !Number.isFinite(v) || v === 0) return "";
  return v > 0 ? "up" : "down";
}

/** Standard error as "± 1.23" (USD, unsigned); dash when there is none yet. */
export function se(v: number | null | undefined): string {
  return v == null || !Number.isFinite(v) ? "± —" : "± " + usd(v);
}
