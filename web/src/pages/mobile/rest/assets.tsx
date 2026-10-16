// Pieces of the phone Assets pages (AccountsM, AccountM): the hide-amounts eye, a gap bar against its band, a
// futures position row, and the today charts on ExChart.
import { useMemo } from "react";
import { IconEye, IconEyeOff } from "@tabler/icons-react";
import { useStore } from "../../../store";
import { useThrottled } from "../../../hooks";
import { compact, price, qty as fmtQty } from "../../../format";
import { ACCOUNT_SERIES, C, FUT_COLOR, INV_COLOR } from "../../../theme";
import { ExChart, type ExSeries } from "../../../components/ex";
import type { Account, Position } from "../../../protocol";
import { Amt, Row, amt } from "./ui";
import { MASK } from "../../../mask";
import "./assets.css";

/** The eye next to a hero's label: Hide amounts on and off. */
export function Eye() {
  const hide = useStore((s) => s.hideAmounts);
  const set = useStore((s) => s.setHideAmounts);
  return (
    <button type="button" className="r-eye" aria-pressed={hide} aria-label={hide ? "Show amounts" : "Hide amounts"} onClick={() => set(!hide)}>
      {hide ? <IconEyeOff size={18} stroke={1.75} /> : <IconEye size={18} stroke={1.75} />}
    </button>
  );
}

/**
 * A signed value against a ±band: label and value over a centred bar. Neutral grey inside the band's 80 %,
 * amber up to the band, red past it.
 */
export function GapBar({ label, value, band, onLabel }: { label: string; value: number | null; band: number | null; onLabel?: () => void }) {
  const hide = useStore((s) => s.hideAmounts);
  const u = value != null && band ? Math.abs(value) / band : null;
  const tone = u == null ? "" : u >= 1 ? "crit" : u >= 0.8 ? "warn" : "";
  const w = u == null ? 0 : Math.min(1, u) * 50;
  return (
    <div className={"a-gap " + tone}>
      <div className="a-gap-line">
        {onLabel ? (
          <button type="button" className="a-gap-l r-dotted" onClick={onLabel}>
            {label}
          </button>
        ) : (
          <span className="a-gap-l">{label}</span>
        )}
        <span className="a-gap-v r-fig">
          <span className="v">{amt(value, "pnl", hide)}</span>
          <span className="of"> / ±{amt(band, "full", hide)}</span>
        </span>
      </div>
      <div className="a-gap-track" aria-hidden>
        {!hide && value != null && <span className="a-gap-fill" style={value >= 0 ? { left: "50%", width: `${w}%` } : { left: `${50 - w}%`, width: `${w}%` }} />}
      </div>
    </div>
  );
}

/** A futures position: symbol and side, the account and size at entry; uPnL and today's P&L. */
export function PositionRow({ p, account }: { p: Position; account?: string }) {
  const hide = useStore((s) => s.hideAmounts);
  const long = p.amt >= 0;
  return (
    <Row
      title={
        <>
          {p.symbol}
          <span className={"a-side " + (long ? "up" : "down")}>{long ? "Long" : "Short"}</span>
        </>
      }
      sub={`${account ? account + " · " : ""}${hide ? MASK : fmtQty(p.amt, true)} @ ${price(p.entry)} · mark ${price(p.mark)}`}
      value={<Amt v={p.upnl} />}
      valueSub={
        <>
          Today <Amt v={p.pnl_day} />
        </>
      }
    />
  );
}

const NONE: never[] = [];

/** Today's desk equity, or the desk's inventory against the futures, on ExChart. */
export function DeskChart({ what }: { what: "equity" | "exposure" }) {
  const raw = useThrottled(useStore((s) => s.snap?.series), 2000) ?? NONE;
  const hide = useStore((s) => s.hideAmounts);
  const series = useMemo<ExSeries[]>(() => {
    const k = (v: number) => (hide ? MASK : compact(v, 2));
    if (what === "equity")
      return [{ key: "eq", kind: "area", label: "Equity", color: C.ink2, toggle: false, format: hide ? () => MASK : (v) => amt(v, "full"), data: raw.map((p) => ({ time: p.t, value: p.equity })) }];
    return [
      { key: "net", kind: "line", label: "Net", color: C.ink, format: k, data: raw.map((p) => ({ time: p.t, value: p.inventory + p.futures_notional })) },
      { key: "inv", kind: "line", label: "Spot", color: INV_COLOR, format: k, lastValue: false, data: raw.map((p) => ({ time: p.t, value: p.inventory })) },
      { key: "fut", kind: "line", label: "Futures", color: FUT_COLOR, format: k, lastValue: false, data: raw.map((p) => ({ time: p.t, value: p.futures_notional })) },
    ];
  }, [raw, hide, what]);
  return (
    <div className="r-chart">
      <ExChart
        id={what === "equity" ? "m-assets-eq" : "m-assets-exp"}
        title={what === "equity" ? "Equity today" : "Exposure today"}
        toolbarLeft={<span className="a-chart-t">{what === "equity" ? "Equity today (USDT)" : "Exposure today (USDT)"}</span>}
        series={series}
        height={220}
        fullscreen
        chips={what === "exposure"}
        emptyText="No points yet today"
      />
    </div>
  );
}

/** Each account's Day PnL through today, one line per account (at most six). */
export function AccountsChart({ accounts, only }: { accounts: Account[]; only?: string }) {
  const all = useThrottled(useStore((s) => s.snap?.account_series), 2000) ?? NONE;
  const hide = useStore((s) => s.hideAmounts);
  const series = useMemo<ExSeries[]>(() => {
    const by = new Map(all.map((a) => [a.account, a]));
    const list = accounts.filter((a) => by.has(a.id) && (!only || a.id === only)).slice(0, ACCOUNT_SERIES.length);
    const fmt = hide ? () => MASK : (v: number) => amt(v, "pnl");
    return list.map((a, i) => {
      const s = by.get(a.id)!;
      return only
        ? { key: a.id, kind: "baseline" as const, label: "Day PnL", signColor: true, toggle: false, format: fmt, data: s.t.map((t, j) => ({ time: t, value: s.pnl_day[j]! })) }
        : { key: a.id, kind: "line" as const, label: a.label, color: ACCOUNT_SERIES[i]!, format: fmt, lastValue: i === 0, legend: 1, data: s.t.map((t, j) => ({ time: t, value: s.pnl_day[j]! })) };
    });
  }, [all, accounts, only, hide]);
  return (
    <div className="r-chart">
      <ExChart
        id={only ? "m-account-pnl" : "m-assets-accts"}
        title={only ? "Day PnL" : "Day PnL by account"}
        toolbarLeft={<span className="a-chart-t">{only ? "Day PnL today (USDT)" : "Day PnL by account (USDT)"}</span>}
        series={series}
        // 204: the chip row clears the bottom bar on the first view of Assets
        height={only ? 200 : 204}
        fullscreen
        chips={!only}
        emptyText="No points yet today"
      />
    </div>
  );
}
