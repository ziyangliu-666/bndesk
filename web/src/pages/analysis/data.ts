// Analysis data: /api/markouts for the chosen view (reference, side, account, venue, weighting, the
// distribution's horizon), fetched again every 5 s while the page is visible. The last report stays up while the
// next one loads, so a control change never blanks the page.
import { useEffect, useRef, useState } from "react";
import { getJSON } from "../../api";
import { usePageVisible } from "../../hooks";
import { useExPref } from "../../components/ex";
import type { MarkoutLine, MarkoutReport } from "../../protocol";

export type Ref = "net" | "fast" | "raw";
export type SideF = "all" | "buy" | "sell";
export type Weight = "notional" | "fill";
export type VenueF = "all" | "spot" | "usdm";

export interface View {
  ref: Ref;
  side: SideF;
  account: string; // "" = all
  venue: VenueF;
  weight: Weight;
  h: number; // the distribution's horizon, s
}

/** The main horizons (KPI strip, table columns), seconds. */
export const MAIN_H = [1, 10, 60, 300] as const;
export const POLL_MS = 5_000;

export const REF_OPTS: { value: Ref; label: string; title: string }[] = [
  { value: "net", label: "Net 1 s", title: "Net of the reference's move from 1 s after the fill" },
  { value: "fast", label: "Net 0.2 s", title: "Net of the reference's move from 0.2 s after the fill" },
  { value: "raw", label: "Raw", title: "Against the instrument's own mid only" },
];

/** The page's controls, remembered per layout (desktop and phone keep their own). */
export function useView(id: string) {
  const [ref, setRef] = useExPref<Ref>(id, "ref", "net", ["net", "fast", "raw"]);
  const [side, setSide] = useExPref<SideF>(id, "side", "all", ["all", "buy", "sell"]);
  const [account, setAccount] = useExPref<string>(id, "account", "");
  const [venue, setVenue] = useExPref<VenueF>(id, "venue", "all", ["all", "spot", "usdm"]);
  const [weight, setWeight] = useExPref<Weight>(id, "weight", "notional", ["notional", "fill"]);
  const [h, setH] = useExPref<number>(id, "h", 10);
  const view: View = { ref, side, account, venue, weight, h };
  return { view, setRef, setSide, setAccount, setVenue, setWeight, setH };
}

export function useMarkouts(v: View): { r: MarkoutReport | null; error: string | null; loading: boolean } {
  const visible = usePageVisible();
  const [state, setState] = useState<{ r: MarkoutReport | null; error: string | null; key: string }>({ r: null, error: null, key: "" });
  const key = `${v.ref}|${v.side}|${v.account}|${v.venue}|${v.weight}|${v.h}`;
  const live = useRef(true);
  useEffect(() => {
    live.current = true;
    if (!visible) return;
    const ac = new AbortController();
    let timer = 0;
    const params: Record<string, string | number> = { ref: v.ref, weight: v.weight, h: v.h };
    if (v.side !== "all") params.side = v.side;
    if (v.account) params.account = v.account;
    if (v.venue !== "all") params.venue = v.venue;
    const load = () => {
      getJSON<MarkoutReport>("/api/markouts", params, ac.signal)
        .then((r) => live.current && !ac.signal.aborted && setState({ r, error: null, key }))
        .catch((e: unknown) => !ac.signal.aborted && setState((s) => ({ ...s, error: e instanceof Error ? e.message : String(e) })))
        .finally(() => {
          if (!ac.signal.aborted) timer = window.setTimeout(load, POLL_MS);
        });
    };
    load();
    return () => {
      ac.abort();
      window.clearTimeout(timer);
    };
    // the view's fields are in `key`
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, visible]);
  useEffect(
    () => () => {
      live.current = false;
    },
    [],
  );
  return { r: state.r, error: state.error, loading: state.key !== key };
}

/** The line for the chosen side. */
export const sideLine = (r: MarkoutReport, side: SideF): MarkoutLine => (side === "buy" ? r.buy : side === "sell" ? r.sell : r.all);

/** Index of a horizon (s) in the report's path, -1 when absent. */
export const hIdx = (r: MarkoutReport | null, h: number) => (r ? r.horizons_s.indexOf(h) : -1);

/** A horizon as the axis and legends write it: −10 s, −0.5 s, Fill, 0.2 s, 5 min. */
export function hLabel(h: number, short = false): string {
  if (h === 0) return "Fill";
  const neg = h < 0 ? "−" : "";
  const a = Math.abs(h);
  if (a >= 60 && a % 60 === 0) return `${neg}${a / 60}${short ? "m" : " min"}`;
  return `${neg}${a}${short ? "s" : " s"}`;
}

export const MK_DEF =
  "Markout at h: side × (mid(t + h) / price − 1), bps; positive = the price went our way. Before the fill (h < 0) it " +
  "reads where the mid was then: a maker's quote is usually filled after the price has come to it. Net subtracts the " +
  "reference's move from 1 s (or 0.2 s) after the fill. A diagnostic, not P&L";
export const TOX_DEF =
  "Reference move D(h): how far the reference moved against the fill since 5 s before it, −side × (ref(t + h) / " +
  "ref(t − 5 s) − 1), bps. Positive = against us. A rise between the fill and 0.2 s is a jump that picked off the " +
  "quote before any hedge could trade";
