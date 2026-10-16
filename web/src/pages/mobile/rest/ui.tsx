// The phone's exchange grammar for History, Assets, Alerts, More, Analysis, Orders, System and Fills: page tabs
// with the accent underline, 56 px two-line rows without chevrons, label-over-value stats, a big hero figure,
// plain section heads. Amounts honour Hide amounts (•••); unknown is `--`.
import { memo, useCallback, type ReactNode } from "react";
import { navigate, type Route } from "../../../store";
import { Money, amount, signTone, useAmount, type AmountKind } from "../../../mask";
import { num } from "../../../format";
import { Tabs, type Option } from "../../../components/ex";
import { showInfo } from "../../../components/mobile";
import "./rest.css";

export const NA = "--";

// ---------------- figures (the Hide amounts rules and formats are in src/mask.tsx) ----------------

/** `pnl` +1,234.56 (the whole figure, signed), `full` 45,380.12 (balances are never shortened), `k` 59.80K,
 *  `pnlK` +59.80K. */
export type AmtKind = "pnl" | "full" | "k" | "pnlK";
const KIND: Record<AmtKind, AmountKind> = { pnl: "pnlFull", full: "full", k: "k", pnlK: "pnlK" };

/** A USD amount as text, `•••` when masked. */
export const amt = (v: number | null | undefined, kind: AmtKind = "pnl", hide = false): string => amount(v, KIND[kind], hide);

/** Sign class of a figure as printed ("" for zero and unknown). */
export const sgn = signTone;

/** `amt` bound to the Hide amounts setting. */
export function useAmt(): (v: number | null | undefined, kind?: AmtKind) => string {
  const a = useAmount();
  return useCallback((v, kind = "pnl") => a(v, KIND[kind]), [a]);
}

/** An amount in a span; signed kinds take the sign colour unless `plain`. */
export const Amt = memo(function Amt({ v, kind = "pnl", plain, className }: { v: number | null | undefined; kind?: AmtKind; plain?: boolean; className?: string }) {
  return <Money v={v} kind={KIND[kind]} color={plain ? false : undefined} className={className} />;
});

// ---------------- layout ----------------

/** The page's tabs: text with a short accent underline, full width, a rule under them. */
export function PageTabs<V extends string>({
  items,
  value,
  onChange,
  right,
}: {
  items: (Option<V> & { count?: number | string | null })[];
  value: V;
  onChange: (v: V) => void;
  right?: ReactNode;
}) {
  return (
    <div className="r-tabs">
      <Tabs items={items} value={value} onChange={onChange} right={right} />
    </div>
  );
}

/** A section: an optional head (14/500 title, muted facts at the right), then its body. A rule above. */
export function Sec({ title, right, info, children, flush, className }: { title?: ReactNode; right?: ReactNode; info?: string; children: ReactNode; flush?: boolean; className?: string }) {
  return (
    <section className={"r-sec" + (flush ? " flush" : "") + (className ? " " + className : "")}>
      {(title != null || right != null) && (
        <header className="r-head">
          {title != null &&
            (info ? (
              <button type="button" className="r-head-t r-dotted" onClick={() => showInfo(title, info)}>
                {title}
              </button>
            ) : (
              <h2 className="r-head-t">{title}</h2>
            ))}
          {right != null && <div className="r-head-r">{right}</div>}
        </header>
      )}
      {children}
    </section>
  );
}

/**
 * A list row, 56 px (48 `dense`): title over a muted line at the left, the value over a muted line at the right.
 * The whole row is the target (`to` or `onClick`); no chevron.
 */
export function Row({
  title,
  sub,
  value,
  valueSub,
  lead,
  to,
  onClick,
  dense,
  tone,
  sub2,
  className,
}: {
  title: ReactNode;
  sub?: ReactNode;
  value?: ReactNode;
  valueSub?: ReactNode;
  lead?: ReactNode;
  to?: Route;
  onClick?: () => void;
  dense?: boolean;
  tone?: "warn" | "crit";
  /** The left text may take two lines (alert text). */
  sub2?: boolean;
  className?: string;
}) {
  const cls = ["r-row", dense ? "dense" : "", tone ?? "", className ?? ""].filter(Boolean).join(" ");
  const body = (
    <>
      {lead != null && <span className="r-row-lead">{lead}</span>}
      <span className="r-row-l">
        <span className="r-row-t">{title}</span>
        {sub != null && <span className={"r-row-s" + (sub2 ? " two" : "")}>{sub}</span>}
      </span>
      {(value != null || valueSub != null) && (
        <span className="r-row-r">
          {value != null && <span className="r-row-v">{value}</span>}
          {valueSub != null && <span className="r-row-s">{valueSub}</span>}
        </span>
      )}
    </>
  );
  if (to || onClick)
    return (
      <button type="button" className={cls} onClick={onClick ?? (() => navigate(to!))}>
        {body}
      </button>
    );
  return <div className={cls}>{body}</div>;
}

export interface Stat {
  label: ReactNode;
  value: ReactNode;
  tone?: "up" | "down" | "warn" | "crit" | "";
  /** A definition: the label is dotted and a tap opens it. */
  info?: string;
  /** A tap opens something (a day): the whole cell is the target. */
  onClick?: () => void;
  /** Columns it spans. */
  span?: number;
}

/** Label-over-value pairs on a grid: 12 px muted label over a 14 px value. */
export function Stats({ items, cols = 3, className }: { items: Stat[]; cols?: 2 | 3 | 4; className?: string }) {
  return (
    <div className={"r-stats c" + cols + (className ? " " + className : "")}>
      {items.map((it, i) => {
        const style = it.span ? { gridColumn: `span ${it.span}` } : undefined;
        const value = <span className={"r-stat-v r-fig " + (it.tone ?? "")}>{it.value}</span>;
        // a defined term: the whole cell (label and figure, 44 px and more) opens its definition
        return it.info || it.onClick ? (
          <button key={i} type="button" className="r-stat r-stat-tap" style={style} onClick={it.onClick ?? (() => showInfo(it.label, it.info))}>
            <span className={"r-stat-l" + (it.info && !it.onClick ? " r-dotted" : "")}>{it.label}</span>
            {value}
          </button>
        ) : (
          <div key={i} className="r-stat" style={style}>
            <span className="r-stat-l">{it.label}</span>
            {value}
          </div>
        );
      })}
    </div>
  );
}

/** The screen's big figure: a muted label line (with an optional control at the right), the figure, one line
 *  under it. */
export function Big({ label, value, sub, right, tone }: { label: ReactNode; value: ReactNode; sub?: ReactNode; right?: ReactNode; tone?: string }) {
  return (
    <div className="r-big">
      <div className="r-big-l">{label}</div>
      <div className="r-big-line">
        <span className={"r-big-v r-fig " + (tone ?? "")}>{value}</span>
        {right}
      </div>
      {sub != null && <div className="r-big-s">{sub}</div>}
    </div>
  );
}

/** Centered muted line in an empty list. */
export function Empty({ children }: { children: ReactNode }) {
  return <div className="r-empty">{children}</div>;
}

/** The figure tone of a limit use: ok, warn ≥ 80 %, crit ≥ 100 %. */
export const limitCls = (u: number | null | undefined): "" | "warn" | "crit" => (u == null ? "" : u >= 1 ? "crit" : u >= 0.8 ? "warn" : "");

/**
 * A use against its limit on one line: label, value (`17 / 100` or `37.0%`) and a thin bar under them;
 * neutral grey, amber from 80 %, red at the limit.
 */
export function Meter({ label, value, limit, pct, digits = 1, sub }: { label: ReactNode; value: number; limit: number; pct?: boolean; digits?: number; sub?: ReactNode }) {
  const u = limit > 0 ? value / limit : null;
  const tone = limitCls(u);
  const text = u == null ? NA : pct ? `${(u * 100).toFixed(digits)}%` : `${num(value)} / ${num(limit)}`;
  return (
    <div className={"r-meter " + tone}>
      <div className="r-meter-line">
        <span className="r-meter-l">{label}</span>
        {sub != null && <span className="r-meter-s">{sub}</span>}
        <span className="r-meter-v r-fig">{text}</span>
      </div>
      <div className="r-meter-track" aria-hidden>
        <span style={{ width: `${Math.min(1, u ?? 0) * 100}%` }} />
      </div>
    </div>
  );
}
