import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { UnstyledButton } from "@mantine/core";
import { IconChevronRight } from "@tabler/icons-react";
import { navigate, type Route } from "../../store";
import { InfoLabel } from "./Info";

// ---- section: a heading, then its rows on the ground; a hairline rule above splits it from the last ----

export function Section({
  title,
  info,
  link,
  right,
  card = true,
  className,
  children,
}: {
  title?: ReactNode;
  /** Definition text; makes the title tappable. */
  info?: ReactNode;
  /** "All 64 ›" at the right of the title row. */
  link?: { label: ReactNode; to: Route };
  /** Anything else at the right of the title row (a count, a toggle). */
  right?: ReactNode;
  /** The body is a full-width block of rows split by inset rules (default); false hands the children the
   *  page's padded column as is (chips, a note, free layout). There are no cards: the name stays for callers. */
  card?: boolean;
  className?: string;
  children: ReactNode;
}) {
  return (
    <section className={"m-section " + (className ?? "")}>
      {(title != null || link || right != null) && (
        <header className="m-section-head">
          {title != null && (
            <h2 className="m-section-title">
              <InfoLabel label={title} info={info} />
            </h2>
          )}
          {(right != null || link) && (
            <div className="m-section-right">
              {right}
              {link && <MoreLink label={link.label} to={link.to} />}
            </div>
          )}
        </header>
      )}
      {card ? <div className="m-body">{children}</div> : children}
    </section>
  );
}

/** "All 64 ›": an accent link that opens a route. */
export function MoreLink({ label, to }: { label: ReactNode; to: Route }) {
  return (
    <UnstyledButton className="m-link" onClick={() => navigate(to)}>
      {label}
      <IconChevronRight size={15} stroke={2} />
    </UnstyledButton>
  );
}

/** Placeholder body for a screen that is not built yet. */
export function Coming({ what }: { what: ReactNode }) {
  return (
    <div className="m-coming">
      <b>{what}</b>
      <span>Coming to the phone layout.</span>
    </div>
  );
}

// ---- list row: the default list item ----

/**
 * Two lines on each side: title / subtitle on the left, primary / secondary figure on the right. The whole
 * row is the target when it has `to` (pushes the route, shows a chevron) or `onClick`. Rows inside one card
 * are split by inset rules.
 */
export function ListRow({
  title,
  subtitle,
  primary,
  secondary,
  lead,
  dot,
  to,
  onClick,
  chevron,
  tone,
  dense,
  wrap,
  className,
}: {
  title: ReactNode;
  subtitle?: ReactNode;
  primary?: ReactNode;
  secondary?: ReactNode;
  /** Before the text: a LevelIcon. A status dot goes in `dot` instead. */
  lead?: ReactNode;
  /** A status dot (ui.tsx Dot) in the left gutter, outside the text column, so the title starts on the page's
   *  left line like every other row. */
  dot?: ReactNode;
  to?: Route;
  onClick?: () => void;
  /** Defaults to true when the row navigates (`to`). */
  chevron?: boolean;
  /** Tints the title. */
  tone?: "warn" | "crit";
  /** 48 px instead of 56 px. */
  dense?: boolean;
  /** Subtitle wraps to two lines instead of truncating. */
  wrap?: boolean;
  className?: string;
}) {
  const cls = ["m-row", tone, dense ? "dense" : "", className].filter(Boolean).join(" ");
  const inner = (
    <>
      {dot != null && (
        <span className="m-row-dot" aria-hidden>
          {dot}
        </span>
      )}
      {lead != null && <span className="m-row-lead">{lead}</span>}
      <span className="m-row-main">
        <span className="m-row-title">{title}</span>
        {subtitle != null && <span className={"m-row-sub" + (wrap ? " wrap" : "")}>{subtitle}</span>}
      </span>
      {(primary != null || secondary != null) && (
        <span className="m-row-side">
          {primary != null && <span className="m-row-pri">{primary}</span>}
          {secondary != null && <span className="m-row-sec">{secondary}</span>}
        </span>
      )}
      {(chevron ?? to != null) && <IconChevronRight className="m-row-chev" size={18} stroke={1.75} />}
    </>
  );
  if (to || onClick) {
    return (
      <UnstyledButton className={cls} onClick={onClick ?? (() => navigate(to!))}>
        {inner}
      </UnstyledButton>
    );
  }
  return <div className={cls}>{inner}</div>;
}

/** A bare 18 px icon slot for a row's `lead`. No tile: prefer no icon at all where the row has a name. */
export function IconTile({ children, color }: { children: ReactNode; color?: string }) {
  return (
    <span className="m-icon-tile" style={color ? { color } : undefined}>
      {children}
    </span>
  );
}

/** A short qualifier after a name, as on the desktop ("BTCUSDT perp"): small, lowercase, colored by tone. */
export function Tag({ children, tone }: { children: ReactNode; tone?: "up" | "down" | "warn" | "crit" }) {
  return <span className={"m-tag " + (tone ?? "")}>{children}</span>;
}

// ---- chips and segmented controls ----

export interface ChipOption<T extends string> {
  value: T;
  label: ReactNode;
  /** A muted count after the label. */
  count?: number;
}

/** A horizontally scrolling row of single-choice toggles (sort keys, filters, ranges): the same flat segments as
 *  Segmented (dark track, raised active segment), on a track that scrolls when it overflows. Bleeds to the
 *  screen edges inside the page padding. */
export function Chips<T extends string>({
  value,
  onChange,
  data,
  label,
}: {
  value: T;
  onChange: (v: T) => void;
  data: ChipOption<T>[];
  /** Accessible name of the group. */
  label?: string;
}) {
  // a choice made elsewhere (a link that opens one account's fills) starts in view
  const box = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const el = box.current;
    const on = el?.querySelector<HTMLElement>('[aria-pressed="true"]');
    if (!el || !on) return;
    const r = on.getBoundingClientRect();
    const b = el.getBoundingClientRect();
    if (r.right > b.right) el.scrollLeft += r.left + r.width / 2 - (b.left + b.width / 2);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  // a row that runs past an edge fades there, so the chips out of view read as more to scroll to
  const [fade, setFade] = useState("");
  const measure = useCallback(() => {
    const el = box.current;
    if (!el) return;
    const l = el.scrollLeft > 1;
    const r = el.scrollLeft + el.clientWidth < el.scrollWidth - 1;
    setFade((l ? " fade-l" : "") + (r ? " fade-r" : ""));
  }, []);
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    if (el.firstElementChild) ro.observe(el.firstElementChild);
    return () => ro.disconnect();
  }, [measure]);
  return (
    <div ref={box} className={"m-chips" + fade} onScroll={measure}>
      <Segmented value={value} onChange={onChange} data={data} label={label} />
    </div>
  );
}

/** Flat segments, the desk's toggle look: a dark track, the active segment raised, no frame per option.
 *  Every toggle on the phone is one of these (chip rows scroll them; settings use Off / On). */
export function Segmented<T extends string>({
  value,
  onChange,
  data,
  full,
  label,
}: {
  value: T;
  onChange: (v: T) => void;
  data: { value: T; label: ReactNode; count?: number }[];
  /** Stretch to the container width. */
  full?: boolean;
  label?: string;
}) {
  return (
    <div className={"m-seg" + (full ? " full" : "")} role="group" aria-label={label}>
      {data.map((o) => (
        <UnstyledButton key={o.value} aria-pressed={o.value === value} onClick={() => onChange(o.value)}>
          {o.label}
          {o.count != null && <span className="m-chip-n">{o.count}</span>}
        </UnstyledButton>
      ))}
    </div>
  );
}

/** A fill's or order's side as the desktop's tape writes it: "+ buy" in the gain colour, "− sell" in the loss
 *  colour; `words` swaps the words (orders: bid / ask; positions: long / short). */
export function Side({ side, words }: { side: "buy" | "sell"; words?: [string, string] }) {
  const buy = side === "buy";
  const text = words ? (buy ? words[0] : words[1]) : buy ? "+ buy" : "− sell";
  return <span className={"m-side " + (buy ? "up" : "down")}>{text}</span>;
}
