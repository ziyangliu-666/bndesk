// Hide amounts: the one place that decides what the eye masks and how a masked figure looks, on every page and
// both layouts.
//
// The rule:
//   masked   money (P&L, balances, equity, notionals, volumes in USDT), percentages of money (of equity, a day's
//            change of the total), quantities and inventory (they give the size away), and anything drawn from
//            them (chart axes, legends, last-value tags, bar lengths).
//   shown    prices, bps, counts, rates, times, percentages of a limit.
// A masked figure is `•••` in the muted colour: no sign, no green or red, so it reads as neither a gain nor a loss.
// Unknown stays `--` (masking it would suggest there is a figure).
//
// API
//   useHide() / hideNow()   the setting (hook / at call time, for AG Grid formatters; rebuild columns on change)
//   amount(v, kind, hide)   a figure's text; useAmount() binds it to the setting: `const a = useAmount(); a(v, "pnl")`
//   maskText(hide, text)    an already formatted text (chart formatters, compound strings)
//   <Money v kind />        a figure in a span: sign colour for signed kinds, muted when masked
//   useQty() / qtyText()    quantities
//   maskTone(hide, cls)     a sign class, dropped while masked
import { memo, useCallback, type ReactNode } from "react";
import { useStore } from "./store";
import { DASH, MINUS, compact, num, pnl, qty, qtyFixed, usd, usdShort } from "./format";

export const MASK = "•••";

/** The store's Hide amounts setting. */
export const useHide = () => useStore((s) => s.hideAmounts);

/** For formatters outside React (AG Grid): the setting at format time. Rebuild columns when it changes. */
export const hideNow = () => useStore.getState().hideAmounts;

/**
 * How an amount prints. Unsigned: `money` the full figure under a million, then 1.23M (desktop tables, Assets);
 * `usd` 2 decimals, K from 10K, M from 10M; `short` four significant figures (95.0K); `full` every digit
 * (balances, never shortened); `k` K / M / B with 2 decimals (volumes). The `pnl…` kinds are the same with a
 * sign (`pnl` = signed `usd`). A figure that rounds to zero has no sign.
 */
export type AmountKind = "money" | "usd" | "short" | "full" | "k" | "pnl" | "pnlMoney" | "pnlShort" | "pnlFull" | "pnlK";

const SIGNED: Record<AmountKind, boolean> = {
  money: false,
  usd: false,
  short: false,
  full: false,
  k: false,
  pnl: true,
  pnlMoney: true,
  pnlShort: true,
  pnlFull: true,
  pnlK: true,
};
export const signedKind = (k: AmountKind) => SIGNED[k];

/** True when a printed figure reads as zero ("0.00", "−0.0"): no digit 1–9 in it. */
export const readsZero = (text: string) => !/[1-9]/.test(text);

/** USD the exchange way: the full figure with two decimals under a million (`45,370.12`), then `1.23M`. */
export function money(v: number | null | undefined, sign = false): string {
  return amountText(v, sign ? "pnlMoney" : "money");
}

/** An amount's text, unmasked. */
export function amountText(v: number | null | undefined, kind: AmountKind): string {
  if (v == null || !Number.isFinite(v)) return DASH;
  const a = Math.abs(v);
  let s: string;
  switch (kind) {
    case "money":
    case "pnlMoney":
      s = a >= 1e6 ? compact(a) : num(a, 2);
      break;
    case "usd":
    case "pnl":
      s = usd(a);
      break;
    case "short":
    case "pnlShort":
      s = usdShort(a);
      break;
    case "full":
    case "pnlFull":
      s = num(a, 2);
      break;
    case "k":
    case "pnlK":
      s = compact(a);
      break;
  }
  if (readsZero(s)) return s;
  return v < 0 ? MINUS + s : SIGNED[kind] && v > 0 ? "+" + s : s;
}

/** An amount's text, `•••` when masked (unknown stays `--`). */
export function amount(v: number | null | undefined, kind: AmountKind = "money", hide = false): string {
  if (v == null || !Number.isFinite(v)) return DASH;
  return hide ? MASK : amountText(v, kind);
}

/** `amount` bound to the setting. */
export function useAmount(): (v: number | null | undefined, kind?: AmountKind) => string {
  const hide = useHide();
  return useCallback((v, kind = "money") => amount(v, kind, hide), [hide]);
}

/** An already formatted text, masked: `•••` unless it is the unknown `--` (or empty). */
export function maskText(hide: boolean, text: string): string {
  return hide && text !== DASH && text !== "" ? MASK : text;
}

/** An already formatted text as a node: the muted `•••` span when masked. */
export function maskNode(hide: boolean, text: string): ReactNode {
  const t = maskText(hide, text);
  return t === MASK ? <span className="masked">{MASK}</span> : t;
}

/** A formatter that masks: wraps a chart / grid format function. */
export const maskFormat =
  <T,>(hide: boolean, f: (v: T) => string) =>
  (v: T): string =>
    maskText(hide, f(v));

/** A sign class ("up" / "down"), dropped while masked. */
export const maskTone = <T extends string | undefined>(hide: boolean, cls: T): T | "" => (hide ? "" : cls);

/** The sign class of a figure as printed: "" when it is unknown or reads as zero. */
export function signTone(v: number | null | undefined, text?: string): "" | "up" | "down" {
  if (v == null || !Number.isFinite(v) || v === 0) return "";
  if (text != null && readsZero(text)) return "";
  return v > 0 ? "up" : "down";
}

/** A quantity, masked: a size gives the amount away even where the price does not. */
/** A quantity, or the mask; `d`: fixed decimals (a column's, format.qtyDecimals) instead of trimmed ones. */
export function qtyText(v: number | null | undefined, hide: boolean, sign = false, d?: number): string {
  return v == null || !Number.isFinite(v) ? DASH : hide ? MASK : d == null ? qty(v, sign) : qtyFixed(v, d, sign);
}
export function useQty(): (v: number | null | undefined, sign?: boolean) => string {
  const hide = useHide();
  return useCallback((v, sign = false) => qtyText(v, hide, sign), [hide]);
}

/** A percentage of money (of equity, a day's change of a total), masked like the money: `+0.06%`. */
export function pctOfMoney(v: number | null | undefined, hide: boolean, d = 2): string {
  if (v == null || !Number.isFinite(v)) return DASH;
  if (hide) return MASK;
  const s = Math.abs(v * 100).toFixed(d);
  if (readsZero(s)) return s + "%";
  return (v > 0 ? "+" : MINUS) + s + "%";
}

/** Signed USD as `pnl` from format.ts (desk tables), masked. */
export const pnlText = (v: number | null | undefined, hide: boolean) => (v == null || !Number.isFinite(v) ? DASH : hide ? MASK : pnl(v));

/**
 * A USD figure in a span. Signed kinds (or `sign`) print + / − and take the sign colour unless `color` is false;
 * masked figures are muted (class `masked`) and never coloured. `unit` adds a small unit after it ("USDT").
 */
export const Money = memo(function Money({
  v,
  kind,
  sign = false,
  color,
  unit,
  className,
}: {
  v: number | null | undefined;
  kind?: AmountKind;
  /** Shorthand for the signed `pnlMoney` when no kind is given (desktop tables). */
  sign?: boolean;
  color?: boolean;
  unit?: string;
  className?: string;
}) {
  const hide = useHide();
  const k: AmountKind = kind ?? (sign ? "pnlMoney" : "money");
  const text = amount(v, k, hide);
  const tint = (color ?? SIGNED[k]) && !hide ? signTone(v, text) : "";
  const cls = ["fig", tint, hide && text === MASK ? "masked" : "", className ?? ""].filter(Boolean).join(" ");
  return (
    <span className={cls}>
      {text}
      {unit && <span className="m-unit">{unit}</span>}
    </span>
  );
});
