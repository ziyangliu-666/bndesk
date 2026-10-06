import { useLayoutEffect, useRef, type ReactNode } from "react";
import { useStore } from "../store";
import { bps, hm, int, num, pnl, signClass, usd, usdShort } from "../format";
import type { Account, Exposure } from "../protocol";

export function Fig({
  label,
  value,
  v,
  unit,
  sub,
  tone,
  wide,
  lead,
  drop,
  tip,
}: {
  label: string;
  value: ReactNode;
  v?: number | null;
  unit?: string;
  sub?: ReactNode;
  tone?: "warn" | "crit" | "";
  wide?: boolean;
  lead?: boolean;
  drop?: number; // when the row is too short, figures leave in this order, lowest first
  tip: string;
}) {
  return (
    <div className={"kfig " + (lead ? "lead " : "") + (wide ? "wide " : "") + (tone ?? "")} title={tip} data-drop={drop}>
      <div className="kfig-label">{label}</div>
      <div className={"kfig-value fig " + (v !== undefined ? signClass(v) : "")}>
        {value}
        {unit && <span className="unit">{unit}</span>}
      </div>
      {sub != null && <div className="kfig-sub fig">{sub}</div>}
    </div>
  );
}

/** The fee most accounts pay, per venue; the master is left out when there are sub-accounts. */
export function fees(accounts: Account[]): { venues: { venue: string; text: string; mixed: boolean }[]; changed: boolean } {
  const subs = accounts.filter((a) => a.role !== "master");
  const by = new Map<string, Map<string, number>>();
  let changed = false;
  for (const a of subs.length ? subs : accounts) {
    for (const f of a.fees) {
      changed ||= f.changed;
      const m = by.get(f.venue) ?? new Map<string, number>();
      const k = `${num(f.maker_bps, 1)} / ${num(f.taker_bps, 1)}`;
      m.set(k, (m.get(k) ?? 0) + 1);
      by.set(f.venue, m);
    }
  }
  const venues: { venue: string; text: string; mixed: boolean }[] = [];
  for (const venue of ["spot", "usdm"]) {
    const m = by.get(venue);
    if (!m) continue;
    const [text] = [...m.entries()].sort((a, b) => b[1] - a[1])[0]!;
    venues.push({ venue, text, mixed: m.size > 1 });
  }
  return { venues, changed };
}

const betaNote = (x: Exposure) =>
  x.beta_source === "estimate" ? "β: desk estimate, may differ from the engine's" : "β: configured per market";

function exposureFig(x: Exposure) {
  const hasGap = x.gap != null && x.band != null;
  const over = hasGap && Math.abs(x.gap!) > x.band!;
  if (hasGap && x.paused) {
    return {
      value: pnl(x.hedge_notional),
      v: x.hedge_notional,
      sub: "hedge off, closing",
      label: x.paused,
      tone: over ? ("warn" as const) : ("" as const),
      tip: `${x.paused}: the hedge is off and its target is 0; the value is the hedge symbols' futures notional still open, to be closed. USDT.`,
    };
  }
  return {
    value: hasGap ? pnl(x.gap) : pnl(x.net),
    v: hasGap ? x.gap : x.net,
    sub: hasGap ? `target ${num(x.target, 0, true)}` : `spot ${usd(x.spot_value)}`,
    label: hasGap ? "Exposure gap" : "Net exposure",
    tone: over ? ("warn" as const) : ("" as const),
    tip: hasGap
      ? `Exposure gap: hedge target minus the futures notional of the hedge symbols (the trade that closes it; negative = sell more), where the target is −${num(x.ratio, 2)} × beta-weighted spot value (${betaNote(x)}). ` +
        `Band: ±${num(x.band, 0)}, the allowed size of the gap. USDT.`
      : `Net exposure: spot inventory value plus futures net notional, all accounts. Spot: spot inventory value; futures net notional ${pnl(x.futures_notional)}. USDT.`,
  };
}

export function KeyStrip() {
  // the parts it shows, not the whole snapshot: fills and series messages leave these untouched
  const sm = useStore((st) => st.snap?.summary);
  const exposure = useStore((st) => st.snap?.exposure);
  const tz = useStore((st) => st.tz);
  const row = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => fitRow(row.current)); // values change length as they tick
  useLayoutEffect(() => {
    const el = row.current;
    if (!el) return;
    const ro = new ResizeObserver(() => fitRow(el));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  if (!sm || !exposure) return <div className="keystrip" ref={row} />;
  const p = sm.pnl;
  const ex = exposureFig(exposure);
  const dayStart = `${hm(sm.day_start, tz)} ${tz === "utc" ? "UTC" : "local time"}`;

  const hedge = exposure.hedge_day?.hedge_pnl ?? null;

  return (
    <div className="keystrip" ref={row}>
      <div className="ksum" title="Day PnL = Market making + Inventory PnL + Hedge + Other">
        <Fig
          lead
          label="Day PnL"
          value={pnl(sm.pnl_day)}
          v={sm.pnl_day}
          unit="USDT"
          sub={
            <>
              1h <span className={signClass(sm.pnl_1h)}>{pnl(sm.pnl_1h)}</span>
            </>
          }
          tip={`Equity change since ${dayStart}, net of transfers; 1h is the change over the last hour.`}
        />
        <Op g="=" />
        <Fig
          label="Market making"
          value={pnl(p.mm)}
          v={p.mm}
          sub={
            <>
              spread <span className={signClass(p.mm_spread)}>{pnl(p.mm_spread)}</span>
            </>
          }
          tip="Each fill against the mid 60 s after it, minus fees; spread is the same against the fair at the fill."
        />
        <Op g="+" />
        <Fig
          label="Inventory PnL"
          value={pnl(p.inventory)}
          v={p.inventory}
          tip="Trading PnL minus market making: what the inventory made after the first 60 s of each fill."
        />
        <Op g="+" />
        <Fig
          label="Hedge"
          value={hedge != null ? pnl(hedge) : "—"}
          v={hedge}
          tip="The futures legs since the day start: price at mark, minus fees, plus funding."
        />
        <Op g="+" />
        <Fig
          label="Other"
          value={sm.other != null ? pnl(sm.other) : "—"}
          v={sm.other}
          tip="Day PnL minus trading PnL and the hedge."
        />
      </div>
      <Fig
        label="Inventory"
        drop={3}
        value={usd(sm.inventory_value)}
        tip={`Free plus locked balances of non-quote assets across accounts, valued at mid; ${sm.inventory_assets} assets.`}
      />
      <Fig label={ex.label} value={ex.value} v={ex.v} tone={ex.tone} wide tip={ex.tip} />
      <Fig
        label="Volume"
        drop={2}
        value={usdShort(sm.volume_day)}
        tip={`Notional filled since the day start; ${usdShort(sm.volume_24h)} over the last 24 hours.`}
      />
      <Fig
        label="Markout 10 s"
        value={sm.markout_net_bps_1h == null ? "—" : bps(sm.markout_net_bps_1h)}
        v={sm.markout_net_bps_1h}
        unit="bps"
        tip="Last hour: the notional-weighted 10 s markout of the fills, net of the reference move."
      />
      <Fig
        label="Fills / h"
        drop={1}
        value={int(sm.fills_1h)}
        tip={`Fills in the last hour, all accounts; ${int(sm.fills_day)} today, ${int(sm.fills_24h)} spot fills of tracked markets in the last 24 h.`}
      />
    </div>
  );
}

/** Shows every figure, then hides the droppable ones in order until the row fits. */
function fitRow(el: HTMLElement | null) {
  if (!el) return;
  const figs = [...el.querySelectorAll<HTMLElement>("[data-drop]")].sort((a, b) => +a.dataset.drop! - +b.dataset.drop!);
  for (const f of figs) f.style.display = "";
  for (const f of figs) {
    if (el.scrollWidth <= el.clientWidth) break;
    f.style.display = "none";
  }
}

/** The additive relation between the PnL tiles, in its own narrow column. */
function Op({ g }: { g: string }) {
  return (
    <div className="kop" aria-hidden>
      {g}
    </div>
  );
}
