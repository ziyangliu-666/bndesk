// Small presentational controls in bndesk's palette: Tabs, TextToggle, ChipRow, TickerStrip, TvAttribution.
import { useCallback, useEffect, useRef, useState, type CSSProperties, type ReactNode, type RefObject } from "react";
import type { Stroke } from "../../theme";
import "./ex.css";

export interface Option<V extends string = string> {
  value: V;
  label: ReactNode;
  /** Tooltip. */
  title?: string;
}

/**
 * Underline tabs: switch what a panel shows. Active = ink text with a short accent underline; the rest muted.
 * `count` adds a small muted figure after the label (`Fills 4,937`). `size` "md" is 14 px (panel heads, the
 * phone), "sm" 12 px.
 */
export function Tabs<V extends string>({
  items,
  value,
  onChange,
  size = "md",
  className,
  right,
}: {
  items: (Option<V> & { count?: number | string | null })[];
  value: V;
  onChange: (v: V) => void;
  size?: "sm" | "md";
  className?: string;
  /** Pushed to the right end of the row (filters, a fullscreen button). */
  right?: ReactNode;
}) {
  return (
    <div className={"ex-tabs " + size + (className ? " " + className : "")} role="tablist">
      {items.map((it) => (
        <button
          key={it.value}
          type="button"
          role="tab"
          aria-selected={it.value === value}
          className={"ex-tab" + (it.value === value ? " on" : "")}
          title={it.title}
          onClick={() => onChange(it.value)}
        >
          {it.label}
          {it.count != null && it.count !== "" && <span className="ex-tab-n">{it.count}</span>}
        </button>
      ))}
      {right != null && <div className="ex-tabs-right">{right}</div>}
    </div>
  );
}

/**
 * Text toggles for modes inside a toolbar (intervals, Line/Candles, Today/24h): no container; the active one
 * ink, the rest muted. Items with `value: "|"` draw a thin divider.
 */
export function TextToggle<V extends string>({
  options,
  value,
  onChange,
  className,
  label,
}: {
  options: (Option<V> | { value: "|" })[];
  value: V;
  onChange: (v: V) => void;
  className?: string;
  /** Accessible group name. */
  label?: string;
}) {
  return (
    <div className={"ex-tt" + (className ? " " + className : "")} role="radiogroup" aria-label={label}>
      {options.map((o, i) =>
        o.value === "|" ? (
          <span key={"d" + i} className="ex-tt-div" />
        ) : (
          <button
            key={o.value}
            type="button"
            role="radio"
            aria-checked={o.value === value}
            className={o.value === value ? "on" : ""}
            title={(o as Option<V>).title}
            onClick={() => onChange(o.value as V)}
          >
            {(o as Option<V>).label}
          </button>
        ),
      )}
    </div>
  );
}

export interface Chip {
  key: string;
  label: ReactNode;
  /** The key before the label: a short line sample in the series colour (and its stroke). */
  color?: string;
  /** The series' stroke, drawn in the key (theme.ts Stroke). Default solid. */
  stroke?: Stroke;
  /** A bar series (volume): the key is a small bar rather than a line. */
  bar?: boolean;
  /** Markers drawn as rings (our fills): the key is a ring. */
  ring?: boolean;
  title?: string;
}

const DASH: Record<Stroke, string | undefined> = { solid: undefined, dashed: "3 2.5", large: "6 3", dotted: "1.5 1.5", sparse: "1.5 3.5" };

/** The line sample of a chip or a legend key: the series' colour and stroke; hollow (an outline in muted) when
 *  the series is off. */
export function SeriesKey({ color, stroke = "solid", bar, ring, on = true }: { color: string; stroke?: Stroke; bar?: boolean; ring?: boolean; on?: boolean }) {
  if (ring)
    return (
      <svg className="ex-key" width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
        <circle cx="5" cy="5" r="3.5" fill="none" stroke={on ? color : "var(--muted)"} strokeWidth="1.5" />
      </svg>
    );
  if (bar)
    return (
      <svg className="ex-key" width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
        <rect x="1.5" y="2.5" width="7" height="7" fill={on ? color : "none"} stroke={on ? color : "var(--muted)"} strokeWidth="1" />
      </svg>
    );
  return (
    <svg className="ex-key" width="16" height="10" viewBox="0 0 16 10" aria-hidden="true">
      {on ? (
        <line x1="0" y1="5" x2="16" y2="5" stroke={color} strokeWidth="2" strokeDasharray={DASH[stroke]} />
      ) : (
        <rect x="0.5" y="3" width="15" height="4" rx="1" fill="none" stroke="var(--muted)" strokeWidth="1" />
      )}
    </svg>
  );
}

/** A sideways scroller's fade classes (" fade-l", " fade-r"): it fades at the edge it continues past. */
export function useScrollFade<T extends HTMLElement>(): [RefObject<T | null>, string, () => void] {
  const ref = useRef<T>(null);
  const [fade, setFade] = useState("");
  const measure = useCallback(() => {
    const el = ref.current;
    if (!el) return;
    const l = el.scrollLeft > 1;
    const r = el.scrollLeft + el.clientWidth < el.scrollWidth - 1;
    setFade((l ? " fade-l" : "") + (r ? " fade-r" : ""));
  }, []);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [measure]);
  return [ref, fade, measure];
}

/**
 * The chip row under a chart: each item shows or hides a series or overlay. No plate and no frame: a key (the
 * series' line sample) and the label, ink when on, muted with a hollow key when off. "|" draws a divider.
 * Scrolls sideways when it overflows (phone; 44 px tall targets there). Pair with `useExHidden(id)` to share
 * state with an ExChart of the same id.
 */
export function ChipRow({
  items,
  isOn,
  onToggle,
  className,
  style,
}: {
  items: (Chip | "|")[];
  isOn: (key: string) => boolean;
  onToggle: (key: string) => void;
  className?: string;
  style?: CSSProperties;
}) {
  const [ref, fade, measure] = useScrollFade<HTMLDivElement>();
  return (
    <div ref={ref} onScroll={measure} className={"ex-chips" + fade + (className ? " " + className : "")} style={style} role="group" aria-label="Series">
      {items.map((it, i) => {
        if (it === "|") return <span key={"d" + i} className="ex-chip-div" />;
        const on = isOn(it.key);
        return (
          <button key={it.key} type="button" aria-pressed={on} className={"ex-chip" + (on ? " on" : "")} title={it.title} onClick={() => onToggle(it.key)}>
            {it.color && <SeriesKey color={it.color} stroke={it.stroke} bar={it.bar} ring={it.ring} on={on} />}
            {it.label}
          </button>
        );
      })}
    </div>
  );
}

export type Tone = "up" | "down" | "warn" | "crit" | "muted" | undefined;

export interface TickerItem {
  label: ReactNode;
  value: ReactNode;
  tone?: Tone;
  /** Tooltip on the label (a definition); the label then gets a dotted underline. */
  title?: string;
}

/**
 * The ticker strip: an optional leading big value (`lead`), then label-over-value pairs (12 px muted label
 * over a 12–14 px ink value). "|" starts a new group (a 1 px rule between groups). Overflow is clipped on
 * desktop and scrolls sideways on touch.
 */
export function TickerStrip({
  lead,
  items,
  size = "sm",
  className,
  style,
}: {
  style?: CSSProperties;
  lead?: { title?: ReactNode; value: ReactNode; tone?: Tone; sub?: ReactNode };
  items: (TickerItem | "|")[];
  /** Value size: "sm" 12 px (desktop strip), "md" 14 px (phone stats row). */
  size?: "sm" | "md";
  className?: string;
}) {
  const groups: TickerItem[][] = [[]];
  for (const it of items) {
    if (it === "|") groups.push([]);
    else groups[groups.length - 1]!.push(it);
  }
  return (
    <div className={"ex-ticker " + size + (className ? " " + className : "")} style={style}>
      {lead && (
        <div className="ex-ticker-lead">
          {lead.title != null && <div className="ex-ticker-title">{lead.title}</div>}
          <div className={"ex-ticker-big fig " + (lead.tone ?? "")}>{lead.value}</div>
          {lead.sub != null && <div className="ex-ticker-sub">{lead.sub}</div>}
        </div>
      )}
      {groups
        .filter((g) => g.length)
        .map((g, i) => (
          <div key={i} className="ex-ticker-grp">
            {g.map((it, j) => (
              <div key={j} className="ex-pair">
                <span className={"ex-pair-l" + (it.title ? " dotted" : "")} title={it.title}>
                  {it.label}
                </span>
                <span className={"ex-pair-v fig " + (it.tone ?? "")}>{it.value}</span>
              </div>
            ))}
          </div>
        ))}
    </div>
  );
}

/** The TradingView attribution Lightweight Charts' licence asks for, as a link (the in-plot logo is off). */
export function TvAttribution({ className }: { className?: string }) {
  return (
    <a className={"ex-tv" + (className ? " " + className : "")} href="https://www.tradingview.com/" target="_blank" rel="noopener noreferrer">
      Charts by TradingView
    </a>
  );
}
