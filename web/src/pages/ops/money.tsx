// Money on the desktop pages (Orders, Assets, System, the accounts grid): USD figures that "Hide amounts" masks.
// Prices, quantities, bps, percentages and counts are never masked (the phone does the same, figures.tsx).
import { memo, useCallback } from "react";
import { useStore } from "../../store";
import { DASH, MINUS, compact } from "../../format";
import "./money.css";

export const MASK = "•••";

const NF2 = new Intl.NumberFormat("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

/**
 * USD the exchange way: the full figure with two decimals under a million (`45,370.12`), then an uppercase suffix
 * (`1.23M`). `sign` puts + on a positive figure (P&L, transfers). A figure that rounds to zero has no sign.
 */
export function money(v: number | null | undefined, sign = false): string {
  if (v == null || !Number.isFinite(v)) return DASH;
  const a = Math.abs(v);
  const s = a >= 1e6 ? compact(a) : NF2.format(a);
  if (!/[1-9]/.test(s)) return s;
  return v < 0 ? MINUS + s : sign && v > 0 ? "+" + s : s;
}

/** The masked form keeps the sign of a signed figure (`+•••`, `−•••`); unknown stays the dash. */
export function masked(v: number | null | undefined, sign = false): string {
  if (v == null || !Number.isFinite(v)) return DASH;
  return (v < 0 ? MINUS : sign && v > 0 ? "+" : "") + MASK;
}

/** `money` that follows Hide amounts: `const m = useMoney(); m(v)`, `m(v, true)` for signed figures. */
export function useMoney(): (v: number | null | undefined, sign?: boolean) => string {
  const hide = useStore((s) => s.hideAmounts);
  return useCallback((v, sign = false) => (hide ? masked(v, sign) : money(v, sign)), [hide]);
}

/** The setting itself, for grids (their column definitions depend on it) and bars (an empty track when hidden). */
export const useHide = () => useStore((s) => s.hideAmounts);

/** For AG Grid formatters outside React: reads the setting at format time. Rebuild columns when it changes. */
export const hideNow = () => useStore.getState().hideAmounts;

/**
 * A USD figure. `sign` writes + / − and colours it by sign (P&L); masked figures are muted and never coloured,
 * so `•••` does not read as a gain or a loss.
 */
export const Money = memo(function Money({
  v,
  sign = false,
  color = sign,
  className,
}: {
  v: number | null | undefined;
  sign?: boolean;
  color?: boolean;
  className?: string;
}) {
  const hide = useHide();
  const text = hide ? masked(v, sign) : money(v, sign);
  const tone = hide || !color || v == null || !/[1-9]/.test(text) ? "" : v > 0 ? "up" : v < 0 ? "down" : "";
  const cls = ["fig", tone, hide ? "ops-masked" : "", className ?? ""].filter(Boolean).join(" ");
  return <span className={cls}>{text}</span>;
});
