// Time labels for ExChart: the desk's UTC | Local choice (store.tz), bar-size aware.
import type { TzMode } from "../../format";

const pad = (n: number) => (n < 10 ? "0" + n : String(n));
export const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const DAY = 86_400_000;

export function parts(ms: number, tz: TzMode) {
  const d = new Date(ms);
  return tz === "utc"
    ? { y: d.getUTCFullYear(), mo: d.getUTCMonth(), d: d.getUTCDate(), h: d.getUTCHours(), mi: d.getUTCMinutes(), s: d.getUTCSeconds() }
    : { y: d.getFullYear(), mo: d.getMonth(), d: d.getDate(), h: d.getHours(), mi: d.getMinutes(), s: d.getSeconds() };
}

/** A bar's time for the legend: desktop `2026-10-16 06:15`, touch `16 Oct 06:15`; day bars the date only;
 *  bars under a minute with seconds. `step` is the bar size in ms. */
export function barLabel(ms: number, tz: TzMode, step: number, touch: boolean): string {
  const p = parts(ms, tz);
  const date = touch ? `${p.d} ${MON[p.mo]}` : `${p.y}-${pad(p.mo + 1)}-${pad(p.d)}`;
  if (step >= DAY) return date;
  const t = `${pad(p.h)}:${pad(p.mi)}` + (step < 60_000 ? `:${pad(p.s)}` : "");
  return `${date} ${t}`;
}

/** The time row of a touch value box: `10/16 06:15`, day bars `2026/10/16`. */
export function boxLabel(ms: number, tz: TzMode, step: number): string {
  const p = parts(ms, tz);
  if (step >= DAY) return `${p.y}/${pad(p.mo + 1)}/${pad(p.d)}`;
  return `${pad(p.mo + 1)}/${pad(p.d)} ${pad(p.h)}:${pad(p.mi)}` + (step < 60_000 ? `:${pad(p.s)}` : "");
}

/** Axis tick: year, month, `Oct 16` at day boundaries, else `06:15`. */
export function tickLabel(ms: number, tz: TzMode, kind: number): string {
  const p = parts(ms, tz);
  // TickMarkType: 0 Year, 1 Month, 2 DayOfMonth, 3 Time, 4 TimeWithSeconds
  if (kind === 0) return String(p.y);
  if (kind === 1) return MON[p.mo]!;
  if (kind === 2) return `${MON[p.mo]} ${p.d}`;
  if (kind === 4) return `${pad(p.h)}:${pad(p.mi)}:${pad(p.s)}`;
  return `${pad(p.h)}:${pad(p.mi)}`;
}
