/**
 * Phone building blocks. Pages in pages/mobile import from here; styles are in src/mobile.css (prefix m-).
 * The full API and the design rules (no cards, no ⓘ, no repeated figures) are in the foundation notes.
 *
 * Layout
 *   Section      sentence-case heading (tap it for `info`; a "All 64 ›" `link`, or `right` facts) over a flat
 *                body on the ground; a hairline above splits it from the section before. `card={false}` hands
 *                the children the padded column (chips, a note).
 *   ListRow      the default list item: title / subtitle left, primary / secondary right, optional `lead`;
 *                `to` pushes a route (chevron shown), `onClick` for a sheet. 56 px (dense 44), whole row taps.
 *   KV           label / value grid, 2 or 3 columns; an item with `info` opens it on tap.
 *   Tag          a lowercase qualifier after a name ("perp", "master"); IconTile (bare icon), MoreLink, Coming.
 *   LazyMount    mounts children when scrolled near (charts below the fold).
 *
 * Figures (all USD goes through Money / useMoney, which honor Hide amounts; bps, % and counts never mask)
 *   Money        <Money v={x} kind="pnl|usd|short|pnlShort" unit="USDT" />
 *   useMoney()   formatter for figures inside strings.
 *   Hero         the screen's one big signed figure, a short figure on its line (`sub`), chart slot.
 *   SplitRows    parts of a total on one shared scale; `waterfall` when the total is already on screen.
 *   LimitBar     one line: label, bar, value / limit; ok < 80 %, warn ≥ 80 %, crit ≥ 100 %; `centered` for
 *                a ±band; `compact` for a bare 4 px bar. Lines up with SplitRows (same columns).
 *   RateMeter    an order rate against its limit ("17 / 100", "54%"), one figure row everywhere.
 *   span()       a span of time: "52 s", "1 min", "3 h 12 min".
 *   tone()       the sign colour of a figure as printed: zero ("0.00", "0.0") stays neutral.
 *   Sparkline    small line with its references: `ends` (times) and `range` (high / low).
 *
 * Controls
 *   Chips        horizontally scrolling single-choice toggles (sort, filter, range): Segmented on a scroller.
 *   Segmented    flat segments, the desk's toggle (UTC / Local, Off / On).
 *   Side         "+ buy" / "− sell" in the gain / loss colour (or bid / ask, long / short).
 *
 * Live lists
 *   useLive      a store value at most every `ms`, without re-rendering on every message; paused while held.
 *   useHold      true while a finger rests on a list and 1.5 s after: freeze its order under the finger.
 *   Info         a label that opens its definition sheet (dotted underline); InfoLabel; DefinedLabel +
 *                defineProps for rows that open it as a whole; showInfo().
 *   Sheet        bottom sheet (Mantine Drawer): grab handle drags it closed, back closes it. Never stack two.
 *
 * Shell (mounted by App on phones; pages don't use these directly)
 *   MobileShell, TopBar, StatusPill (+ useFreshness), MobileNav (+ useAlertCount), InfoSheet.
 */
export { Section, MoreLink, Coming, ListRow, IconTile, Tag, Chips, Segmented, Side, type ChipOption } from "./lists";
export {
  Money,
  useMoney,
  Hero,
  SplitRows,
  LimitBar,
  limitTone,
  RateMeter,
  span,
  tone,
  KV,
  Sparkline,
  type MoneyKind,
  type SplitRow,
  type KVItem,
  type LimitTone,
} from "./figures";
export { Info, InfoLabel, DefinedLabel, defineProps, showInfo } from "./Info";
export { Sheet } from "./Sheet";
export { LazyMount } from "./LazyMount";
export { useFreshness, type Fresh } from "./StatusPill";
export { useAlertCount } from "./MobileNav";
export { useLive, useHold } from "./live";
