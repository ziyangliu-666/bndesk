// Small presentational controls in bndesk's palette: Tabs, TextToggle, ChipRow, TickerStrip, TvAttribution.
import type { CSSProperties, ReactNode } from "react";
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
  /** A short swatch in the series colour before the label. */
  color?: string;
  title?: string;
}

/**
 * The chip row under a chart: each chip shows or hides a series or overlay. Flat segmented look on the panel
 * (the desk's `lwc-chips`): on = ink on a raised plate, off = muted. "|" draws a divider. Scrolls sideways
 * when it overflows (phone). Pair with `useExHidden(id)` to share state with an ExChart of the same id.
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
  return (
    <div className={"ex-chips" + (className ? " " + className : "")} style={style} role="group" aria-label="Series">
      {items.map((it, i) =>
        it === "|" ? (
          <span key={"d" + i} className="ex-chip-div" />
        ) : (
          <button
            key={it.key}
            type="button"
            aria-pressed={isOn(it.key)}
            className={"ex-chip" + (isOn(it.key) ? " on" : "")}
            title={it.title}
            onClick={() => onToggle(it.key)}
          >
            {it.color && <span className="ex-chip-sw" style={{ background: it.color }} />}
            {it.label}
          </button>
        ),
      )}
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
