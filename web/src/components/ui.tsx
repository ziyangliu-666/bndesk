import { useRef, type MouseEvent, type ReactNode } from "react";
import { useStore } from "../store";
import { IconAlertTriangle, IconInfoCircle, IconAlertOctagon } from "@tabler/icons-react";
import { C } from "../theme";
import { signClass } from "../format";

export function Panel({
  title,
  right,
  children,
  className,
  bodyClass,
}: {
  title?: ReactNode;
  right?: ReactNode;
  children: ReactNode;
  className?: string;
  bodyClass?: string;
}) {
  return (
    <section className={"panel " + (className ?? "")}>
      {title != null && (
        <header className="panel-head">
          <h2>{title}</h2>
          {right != null && <div className="panel-right">{right}</div>}
        </header>
      )}
      <div className={"panel-body " + (bodyClass ?? "")}>{children}</div>
    </section>
  );
}

export function Legend({ items }: { items: { color: string; label: string; kind?: "line" | "rect" }[] }) {
  return (
    <div className="legend">
      {items.map((it) => (
        <span key={it.label} className="legend-item">
          <span
            className={it.kind === "rect" ? "legend-rect" : "legend-line"}
            style={{ background: it.color }}
          />
          {it.label}
        </span>
      ))}
    </div>
  );
}

/** A signed figure: sign is always in the text; color agrees. */
export function Num({ v, text, className }: { v: number | null | undefined; text: string; className?: string }) {
  return <span className={"num " + signClass(v) + " " + (className ?? "")}>{text}</span>;
}

/** Thin meter. Fill goes amber above 80 %, red at or above 100 %. */
export function Meter({ value, limit, width }: { value: number; limit: number; width?: number | string }) {
  const r = limit > 0 ? value / limit : 0;
  const color = r >= 1 ? C.crit : r > 0.8 ? C.warn : C.accent;
  const track = r >= 1 ? "rgba(240,82,82,0.18)" : r > 0.8 ? "rgba(227,165,59,0.18)" : "rgba(126,166,246,0.16)";
  return (
    <span className="meter" style={{ width: width ?? "100%", background: track }}>
      <span className="meter-fill" style={{ width: `${Math.min(100, r * 100)}%`, background: color }} />
    </span>
  );
}

export function LevelIcon({ level, size = 14 }: { level: "info" | "warn" | "crit"; size?: number }) {
  if (level === "crit") return <IconAlertOctagon size={size} color={C.crit} stroke={2} aria-label="critical" />;
  if (level === "warn") return <IconAlertTriangle size={size} color={C.warn} stroke={2} aria-label="warning" />;
  return <IconInfoCircle size={size} color={C.ink2} stroke={2} aria-label="info" />;
}

export function Dot({ ok, warn }: { ok: boolean; warn?: boolean }) {
  return <span className="dot" style={{ background: ok ? C.up : warn ? C.warn : C.crit }} />;
}

/** State word with a dot so it never relies on color alone. */
export function StateTag({ state }: { state: string }) {
  const s = state.toLowerCase();
  const ok = ["up", "running", "live", "ok", "connected"].includes(s);
  const na = s === "n/a" || s === "";
  const warn = ["reconnecting", "degraded", "paused", "cooldown", "stale"].includes(s);
  return (
    <span className={"state " + (ok ? "ok" : na ? "na" : warn ? "warn" : "bad")}>
      {!na && <Dot ok={ok} warn={warn} />}
      {na ? "n/a" : state}
    </span>
  );
}

/** "usdm:ETHUSDT" -> "ETHUSDT perp", "spot:ETHUSDT" -> "ETHUSDT spot". */
export function refLabel(ref: string | null | undefined): string {
  if (!ref) return "none";
  const [venue, sym] = ref.includes(":") ? ref.split(":", 2) : ["usdm", ref];
  return `${sym} ${venue === "usdm" ? "perp" : "spot"}`;
}

/** Instrument name with a muted perp suffix, so a spot pair and its perp never read the same. */
export function InstrumentName({ symbol, venue }: { symbol: string; venue: string }) {
  return (
    <span className="sym">
      {symbol}
      {venue === "usdm" && <span className="sym-suffix">perp</span>}
    </span>
  );
}

const NONE: string[] = [];

/**
 * Show / hide a chart's series from its legend words, kept per chart in the store.
 * Click toggles one; Alt-click or double-click shows only that one, and again shows all.
 */
export function useSeriesToggle(chart: string, names: string[]) {
  const hidden = useStore((s) => s.hidden[chart] ?? NONE);
  const before = useRef<string[]>(hidden);
  const set = (h: string[]) => useStore.getState().setHidden(chart, h);
  const solo = (name: string, from: string[]) => {
    const others = names.filter((n) => n !== name);
    const isSolo = !from.includes(name) && others.every((n) => from.includes(n));
    set(isSolo ? [] : others);
  };
  const click = (name: string, e: MouseEvent) => {
    e.preventDefault();
    if (e.altKey) return solo(name, hidden);
    if (e.detail === 2) return solo(name, before.current);
    before.current = hidden;
    set(hidden.includes(name) ? hidden.filter((n) => n !== name) : [...hidden, name]);
  };
  const off = (name: string) => hidden.includes(name);
  return { hidden, off, click };
}

/** A series name in its line color; click to show or hide the series. */
export function SeriesWord({
  name,
  label,
  color,
  t,
}: {
  name: string;
  label?: string;
  color?: string;
  t: ReturnType<typeof useSeriesToggle>;
}) {
  return (
    <span
      className={"sw" + (t.off(name) ? " off" : "")}
      style={color ? { color } : undefined}
      onClick={(e) => t.click(name, e)}
      onMouseDown={(e) => e.detail > 1 && e.preventDefault()}
      title="Click to show or hide; Alt-click or double-click to show only this one"
    >
      {label ?? name}
    </span>
  );
}
