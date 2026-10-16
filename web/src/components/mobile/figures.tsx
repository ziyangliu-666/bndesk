import { memo, useCallback, type ReactNode } from "react";
import { useElementSize } from "@mantine/hooks";
import { useStore } from "../../store";
import { DASH, int } from "../../format";
import { MASK, Money as AmountSpan, signTone, useAmount } from "../../mask";
import { DefinedLabel, InfoLabel, defineProps } from "./Info";

// ---- durations: one way to write a span of time on every phone page ----

/** "52 s", "1 min", "3 h 12 min", "2 d 3 h"; a dash when unknown. */
export function span(ms: number | null | undefined): string {
  if (ms == null || !Number.isFinite(ms)) return DASH;
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s} s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  if (h < 48) return m % 60 ? `${h} h ${m % 60} min` : `${h} h`;
  return h % 24 ? `${Math.floor(h / 24)} d ${h % 24} h` : `${Math.floor(h / 24)} d`;
}

// ---- money: USD figures that "Hide amounts" masks (the rules and the formats are in src/mask.tsx) ----

/** pnl: signed USD (+1,234.56, K from 10K); usd: unsigned; short: four significant figures (95.0K); pnlShort:
 *  signed short; full: the whole figure, never abbreviated (balances: 45,370.12). */
export type MoneyKind = "pnl" | "usd" | "short" | "pnlShort" | "full" | "k";

/**
 * The phone's sign colour for a figure as printed: "up", "down", or "" when it is missing or prints as zero
 * ("0.00", "0.0 bps" stay neutral and unsigned). Pass the printed text when the format rounds.
 */
export const tone = signTone;

/** `useAmount` with the phone's default kind, signed USD: `money(v)`, `money(v, "short")`. */
export function useMoney(): (v: number | null | undefined, kind?: MoneyKind) => string {
  const a = useAmount();
  return useCallback((v, kind = "pnl") => a(v, kind), [a]);
}

/** mask.tsx's Money with the phone's default kind (signed USD, coloured by sign). */
export const Money = memo(function Money(props: { v: number | null | undefined; kind?: MoneyKind; color?: boolean; unit?: string; className?: string }) {
  return <AmountSpan {...props} kind={props.kind ?? "pnl"} />;
});

// ---- hero: the one big figure of a screen ----

export function Hero({
  label,
  info,
  v,
  kind = "pnl",
  value,
  unit = "USDT",
  sub,
  right,
  tone,
  children,
}: {
  label: ReactNode;
  /** Definition text; makes the label tappable. */
  info?: ReactNode;
  /** Signed USD value; ignored when `value` is given. */
  v?: number | null;
  /** How `v` prints: signed (default) or a plain amount ("usd", not coloured). */
  kind?: MoneyKind;
  /** Pre-formatted figure (not masked); use for non-USD heroes. */
  value?: ReactNode;
  unit?: string;
  /** A short figure on the value's line, at the right: "1h +2.88". */
  sub?: ReactNode;
  /** Top-right of the label row (e.g. an eye toggle). */
  right?: ReactNode;
  tone?: "warn";
  /** Under the figure: a Sparkline or a chart. */
  children?: ReactNode;
}) {
  const hide = useStore((s) => s.hideAmounts);
  return (
    <div className="m-hero">
      <div className="m-hero-label">
        <InfoLabel label={label} info={info} />
        {right != null && <span className="m-hero-right">{right}</span>}
      </div>
      <div className="m-hero-line">
        {value == null && hide ? (
          // masked: "•••" at body size and muted, as every masked figure
          <span className="m-hero-value m-hero-hidden masked">{MASK}</span>
        ) : (
          <span className={"m-hero-value m-fig " + (tone ?? "")}>
            {value ?? <Money v={v} kind={kind} color={tone == null && kind === "pnl"} />}
            {unit && <span className="m-unit">{unit}</span>}
          </span>
        )}
        {sub != null && <span className="m-hero-sub">{sub}</span>}
      </div>
      {children != null && <div className="m-hero-chart">{children}</div>}
    </div>
  );
}

// ---- split rows: parts of a total, each signed, with bars on one shared scale ----

export interface SplitRow {
  key: string;
  label: ReactNode;
  /** Definition text: the whole row opens it (unless the row has its own onClick). */
  info?: ReactNode;
  v: number | null | undefined;
  /** Amber label and value (e.g. Other while a reconcile alert is active). */
  tone?: "warn";
  /** Printed instead of `v` (the bar still follows `v`): "1,500.00" for a row whose label carries the direction. */
  shown?: { v: number | null | undefined; kind: MoneyKind };
  onClick?: () => void;
}

/**
 * One row per part: label, bar, signed value. Bars share one scale with zero in the middle of the track, the
 * same line as a centered LimitBar (exposure gap), so every signed bar on a screen starts from one zero; the
 * largest reach fills its half. `waterfall` draws each part from where the previous ones left off, so the
 * last bar ends at the total: use it when the rows add up to a figure shown above (don't repeat that total).
 * With Hide amounts on, the bars are empty tracks (their lengths would give the amounts away).
 */
export function SplitRows({
  rows,
  total,
  kind = "pnl",
  waterfall,
  ink,
}: {
  rows: SplitRow[];
  /** An emphasized last row with the sum. Only when the sum is not already on screen. */
  total?: { label: ReactNode; info?: ReactNode; v: number | null | undefined };
  kind?: MoneyKind;
  waterfall?: boolean;
  /** Values and bars in ink, not the sign's colour: parts that are not P&L (equity change, transfers). */
  ink?: boolean;
}) {
  const hide = useStore((s) => s.hideAmounts);
  const money = useMoney();
  const val = (v: number | null | undefined) => (v != null && Number.isFinite(v) ? v : 0);
  // each row's bar runs from a to b on the value axis
  const spans: [number, number][] = [];
  let run = 0;
  for (const r of rows) {
    const v = val(r.v);
    spans.push(waterfall ? [run, run + v] : [0, v]);
    run += waterfall ? v : 0;
  }
  let reach = 0;
  for (const [a, b] of spans) reach = Math.max(reach, Math.abs(a), Math.abs(b));
  const x = (v: number) => 50 + (v / (reach || 1)) * 50;
  return (
    <div className="m-split" style={{ ["--zero" as string]: "50%" }}>
      {rows.map((r, i) => {
        const [a, b] = spans[i]!;
        const left = x(Math.min(a, b));
        const w = Math.abs(x(b) - x(a));
        const sign = tone(r.v, money(r.v, kind));
        const body = (
          <>
            <span className={"m-split-label " + (r.tone ?? "")}>
              <DefinedLabel label={r.label} info={r.onClick ? undefined : r.info} />
            </span>
            <span className={"m-dbar m-dim" + (hide ? " m-veil" : "")} aria-hidden>
              {w > 0 && !hide && sign && (
                <span className={"m-dbar-fill " + (ink ? "" : sign)} style={{ left: `${left}%`, width: `max(2px, ${w}%)` }} />
              )}
            </span>
            <span className={"m-split-value " + (r.tone ?? "")}>
              <Money v={r.shown ? r.shown.v : r.v} kind={r.shown ? r.shown.kind : kind} color={r.tone == null && !ink} />
            </span>
          </>
        );
        const tap = r.onClick
          ? { role: "button", tabIndex: 0, onClick: r.onClick }
          : defineProps(r.label, r.info);
        return (
          <div key={r.key} className={"m-split-row" + ("onClick" in tap ? " m-tap" : "")} {...tap}>
            {body}
          </div>
        );
      })}
      {total && (
        <div className={"m-split-row total" + (total.info ? " m-tap" : "")} {...defineProps(total.label, total.info)}>
          <span className="m-split-label">
            <DefinedLabel label={total.label} info={total.info} />
          </span>
          <span />
          <span className="m-split-value">
            <Money v={total.v} kind={kind} />
          </span>
        </div>
      )}
    </div>
  );
}

// ---- limit bar: a value against its limit ----

export type LimitTone = "ok" | "warn" | "crit";
/** ok below 80 % of the limit, warn from 80 %, crit at or past it. */
export const limitTone = (value: number, limit: number): LimitTone => {
  const r = limit > 0 ? Math.abs(value) / limit : 0;
  return r >= 1 ? "crit" : r >= 0.8 ? "warn" : "ok";
};

/**
 * One line: label, bar, "value / limit". The same columns as SplitRows, so risk rows line up under the split.
 * With `info` the whole row opens the definition.
 */
export function LimitBar({
  label,
  info,
  value,
  limit,
  centered,
  money = true,
  format,
  text,
  sub,
  compact,
}: {
  label?: ReactNode;
  info?: ReactNode;
  value: number;
  limit: number;
  /** A ±limit band around zero (exposure gap): the fill grows from the middle. */
  centered?: boolean;
  /** USD figures (masked by Hide amounts); false for counts. */
  money?: boolean;
  /** Overrides the figure format (gets value and limit). */
  format?: (v: number) => string;
  /** Replaces the right-hand "value / limit" text. */
  text?: ReactNode;
  /** Small line under the row: [left, right] or one node. */
  sub?: ReactNode | [ReactNode, ReactNode];
  /** Bar only, 4 px, no padding: for rows and cards. */
  compact?: boolean;
}) {
  const money_ = useMoney();
  const hide = useStore((s) => s.hideAmounts);
  // the limit is printed with the value's own formatter: −112.92 / ±210.42
  const fmt = format ?? ((v: number) => (money ? money_(v, centered ? "pnl" : "usd") : int(v)));
  const tone = limitTone(value, limit);
  // masked amounts: an empty track, the fill's length would give the amount away
  const r = limit > 0 && !(money && hide) ? Math.min(1, Math.abs(value) / limit) : 0;
  const fill = centered
    ? value >= 0
      ? { left: "50%", width: `${r * 50}%` }
      : { left: `${50 - r * 50}%`, width: `${r * 50}%` }
    : { width: `${r * 100}%` };
  const bar = (
    <div className={"m-lim-track m-dim" + (centered ? " centered" : "") + (money && hide ? " m-veil" : "")}>
      <span className="m-lim-fill" style={fill} />
    </div>
  );
  if (compact) return <div className={"m-lim compact " + tone}>{bar}</div>;
  const [subL, subR] = Array.isArray(sub) ? sub : [sub, null];
  return (
    <div className={"m-lim " + tone + (info ? " m-tap" : "")} {...defineProps(label, info)}>
      {label != null && (
        <span className="m-lim-label">
          <DefinedLabel label={label} info={info} />
        </span>
      )}
      {bar}
      <span className={"m-lim-value m-fig " + (tone === "ok" ? "" : tone)}>
        {text ?? (
          <>
            {fmt(value)}
            <span className="m-lim-of">
              {" / "}
              {centered ? "±" : ""}
              {fmt(Math.abs(limit)).replace(/^\+/, "")}
            </span>
          </>
        )}
      </span>
      {(subL != null || subR != null) && (
        <div className="m-lim-sub">
          <span>{subL}</span>
          {subR != null && <span>{subR}</span>}
        </div>
      )}
    </div>
  );
}

// ---- order-rate meter: one look for an account's order rate (and bid use) against its limit ----

/** "17 / 100" for counts, "54%" for the daily count and shares (`digits` decimals); a dash without a limit. */
function rateText(value: number, limit: number, pct?: boolean, digits = 0): ReactNode {
  if (!(limit > 0)) return DASH;
  if (pct) return `${((100 * value) / limit).toFixed(digits)}%`;
  return (
    <>
      {int(value)}
      <span className="m-lim-of"> / {int(limit)}</span>
    </>
  );
}

/**
 * An order-rate meter, one figure row everywhere (label · bar · value, the LimitBar columns): Orders 10 s as
 * "17 / 100", Orders today and Bid use as "54%" (`pct`, `digits` decimals when accounts would otherwise read
 * alike). Amber from 80 %, red at the limit; a dash and an empty track without a limit. `who` names the account
 * in front of the value (the Desk's worst account).
 */
export function RateMeter({
  label,
  info,
  value,
  limit,
  pct,
  digits,
  who,
}: {
  label: ReactNode;
  info?: ReactNode;
  value: number;
  limit: number;
  pct?: boolean;
  digits?: number;
  who?: ReactNode;
}) {
  const text = (
    <>
      {who != null && <span className="m-lim-who">{who}</span>}
      {rateText(value, limit, pct, digits)}
    </>
  );
  const has = limit > 0;
  return <LimitBar label={label} info={info} value={has ? value : 0} limit={has ? limit : 1} money={false} text={text} />;
}

// ---- key / value grid ----

export interface KVItem {
  label: ReactNode;
  value: ReactNode;
  /** Definition text: the whole cell opens it. */
  info?: ReactNode;
  /** Colors the value by sign (none when the printed value reads zero or is masked). */
  v?: number | null;
  tone?: "warn" | "crit";
  /** Columns this item takes. */
  span?: number;
}

export function KV({ items, cols = 2 }: { items: KVItem[]; cols?: 2 | 3 }) {
  return (
    <div className="m-kv" style={{ ["--kv-cols" as string]: cols }}>
      {items.map((it, i) => (
        <div
          key={i}
          className={"m-kv-item" + (it.info ? " m-tap" : "")}
          style={it.span ? { gridColumn: `span ${it.span}` } : undefined}
          {...defineProps(it.label, it.info)}
        >
          <span className="m-kv-label">
            <DefinedLabel label={it.label} info={it.info} />
          </span>
          <span
            className={
              "m-kv-value m-fig " + (it.tone ?? (it.v !== undefined ? tone(it.v, typeof it.value === "string" ? it.value : undefined) : ""))
            }
          >
            {it.value}
          </span>
        </div>
      ))}
    </div>
  );
}

// ---- sparkline ----

/**
 * A small line: a dot on the last value, a dashed zero line when the values cross zero. Colored by the last
 * value's sign unless `color` is given. Values are spaced evenly; nulls are skipped. Give it its references so
 * it reads as data, not decoration: `ends` labels the two ends (times), `range` prints the high and low at
 * the right.
 */
export function Sparkline({
  values,
  height = 40,
  color,
  zero = true,
  ends,
  range,
  refs,
}: {
  values: (number | null | undefined)[];
  height?: number;
  color?: string;
  zero?: boolean;
  /** Levels drawn as dashed amber lines and kept inside the scale: a limit, a band's edges. */
  refs?: number[];
  /** Under the line, at its two ends: e.g. the day start and now. */
  ends?: [ReactNode, ReactNode];
  /** Formats the high and low printed at the right edge. */
  range?: (v: number) => string;
}) {
  const { ref, width: boxW } = useElementSize<HTMLDivElement>();
  const gutter = range ? 48 : 0;
  const width = Math.max(0, boxW - gutter);
  const pts: [number, number][] = [];
  values.forEach((v, i) => v != null && Number.isFinite(v) && pts.push([i, v]));
  let path = "";
  let last: [number, number] | null = null;
  let zeroY: number | null = null;
  let lo = Infinity;
  let hi = -Infinity;
  for (const [, v] of pts) {
    lo = Math.min(lo, v);
    hi = Math.max(hi, v);
  }
  const lines = (refs ?? []).filter((v) => Number.isFinite(v));
  let refY: number[] = [];
  // the high and the low are printed at their own height, so a dashed limit at the edge is not read as them
  let hiY = 0;
  let loY = height;
  if (width > 0 && pts.length > 1) {
    let a = Math.min(lo, ...lines);
    let b = Math.max(hi, ...lines);
    if (zero && a < 0 && b > 0) zeroY = 0;
    if (b === a) {
      b += 1;
      a -= 1;
    }
    const pad = 3;
    const n = values.length - 1;
    const x = (i: number) => pad + (i / n) * (width - 2 * pad);
    const y = (v: number) => pad + (1 - (v - a) / (b - a)) * (height - 2 * pad);
    // at most ~2 points per pixel
    const stride = Math.max(1, Math.floor(pts.length / (width * 2)));
    const d: string[] = [];
    for (let k = 0; k < pts.length; k += stride) d.push(`${x(pts[k]![0]).toFixed(1)},${y(pts[k]![1]).toFixed(1)}`);
    const tail = pts[pts.length - 1]!;
    d.push(`${x(tail[0]).toFixed(1)},${y(tail[1]).toFixed(1)}`);
    path = "M" + d.join("L");
    last = [x(tail[0]), y(tail[1])];
    if (zeroY != null) zeroY = y(0);
    refY = lines.map(y);
    hiY = y(hi);
    loY = y(lo);
  }
  const lastV = pts.length ? pts[pts.length - 1]![1] : 0;
  const stroke = color ?? (lastV > 0 ? "var(--up)" : lastV < 0 ? "var(--down)" : "var(--ink-2)");
  return (
    <div className="m-spark-box m-dim">
      <div ref={ref} className="m-spark-plot" style={{ height }}>
        {width > 0 && (
          <svg className="m-spark" width={width} height={height} aria-hidden>
            {zeroY != null && <line x1={0} x2={width} y1={zeroY} y2={zeroY} stroke="var(--rule)" strokeDasharray="3 3" />}
            {refY.map((ry, i) => (
              <line key={i} x1={0} x2={width} y1={ry} y2={ry} stroke="var(--warn)" strokeOpacity={0.6} strokeDasharray="2 3" />
            ))}
            {path && <path d={path} fill="none" stroke={stroke} strokeWidth={1.5} strokeLinejoin="round" />}
            {last && <circle cx={last[0]} cy={last[1]} r={2.5} fill={stroke} />}
          </svg>
        )}
        {range && pts.length > 1 && (
          <span className="m-spark-range m-fig" style={{ width: gutter, height }}>
            {range(hi) === range(lo) ? (
              <span style={{ top: Math.max(5, Math.min(height - 5, (hiY + loY) / 2)) }}>{range(hi)}</span>
            ) : loY - hiY >= 13 ? (
              <>
                <span style={{ top: Math.max(5, Math.min(height - 5, hiY)) }}>{range(hi)}</span>
                <span style={{ top: Math.max(5, Math.min(height - 5, loY)) }}>{range(lo)}</span>
              </>
            ) : (
              // too close to sit at their own heights: high over low, one block between them, never on each other
              <span className="m-spark-pair" style={{ top: Math.max(14, Math.min(height - 14, (hiY + loY) / 2)) }}>
                {range(hi)}
                <br />
                {range(lo)}
              </span>
            )}
          </span>
        )}
      </div>
      {ends && (
        <div className="m-spark-ends m-fig" style={{ marginRight: gutter }}>
          <span>{ends[0]}</span>
          <span>{ends[1]}</span>
        </div>
      )}
    </div>
  );
}
