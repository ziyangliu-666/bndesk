// Hide amounts on the desktop Desk: money figures read "•••" (as on the phone); prices, bps, percentages and
// counts are never masked.
import { DASH } from "../../format";
import { useStore } from "../../store";

export const MASK = "•••";

/** The store's Hide amounts setting. */
export const useHide = () => useStore((s) => s.hideAmounts);

/** `text` or the mask. */
export const masked = (hide: boolean, text: string) => (hide ? MASK : text);

/** Unknown as the exchanges write it: `--`. */
export const dd = (text: string) => (text === DASH ? "--" : text);

/** The ticker's tone for a signed figure. */
export const tone = (v: number | null | undefined): "up" | "down" | undefined => (v == null || !Number.isFinite(v) || v === 0 ? undefined : v > 0 ? "up" : "down");
