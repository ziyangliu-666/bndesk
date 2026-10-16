// Chart colours for the ex/ components: bndesk's own pure-black palette (theme.ts), never an exchange's.
import { C, SANS } from "../../theme";

export { C, SANS };
export { ACCOUNT_SERIES, FUT_COLOR, INV_COLOR, PNL_COLORS, PNL_STROKES, S1, S2, S3 } from "../../theme";

export const UP = C.up;
export const DOWN = C.down;
/** Plot background: the panel colour (regions sit on the black ground, split by 1 px rules). */
export const PLOT_BG = C.panel;
/** Horizontal grid only, faint. */
export const GRID = "rgba(32,38,47,0.55)";
export const CROSSHAIR = "rgba(195,202,213,0.38)";
/** A quiet reference line (zero, open). */
export const REF_LINE = "#3a4352";

/** `#rrggbb` → `rgba(r,g,b,a)`. Other inputs come back unchanged. */
export function rgba(hex: string, a: number): string {
  if (!/^#[0-9a-f]{6}$/i.test(hex)) return hex;
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${n >> 16},${(n >> 8) & 255},${n & 255},${a})`;
}

/** Up / down / ink by sign (P&L figures, changes). Zero and unknown are ink. */
export function signColor(v: number | null | undefined, eps = 0): string {
  if (v == null || !Number.isFinite(v)) return C.ink;
  return v > eps ? UP : v < -eps ? DOWN : C.ink;
}
