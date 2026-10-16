// A thin usage bar for limits (orders per 10 s and per day, bid use): neutral grey while far from the limit,
// amber above 80 %, red at or above it. No green or red for sides: a notional is not a gain or a loss.
// `neutral` never changes colour (a notional on a shared scale); `empty` draws the track only (Hide amounts).
export function LimitBar({ value, limit, empty = false, neutral = false }: { value: number; limit: number; empty?: boolean; neutral?: boolean }) {
  const r = limit > 0 && Number.isFinite(value) ? value / limit : 0;
  const tone = neutral ? "" : r >= 1 ? " crit" : r > 0.8 ? " warn" : "";
  return (
    <span className={"ops-bar" + tone} aria-hidden>
      {!empty && <span style={{ width: `${Math.min(100, Math.max(0, r * 100))}%` }} />}
    </span>
  );
}

/** Level of a usage ratio, for the figure next to its bar. */
export const limitTone = (r: number) => (r >= 1 ? "crit-text" : r > 0.8 ? "warn-text" : "");
