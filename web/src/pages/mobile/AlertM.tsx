import { useMemo, type ReactNode } from "react";
import { canHide, isHidden, useStore } from "../../store";
import { useNow } from "../../hooks";
import { bps, hm, hms, int, num, pct, price } from "../../format";
import { LevelIcon } from "../../components/ui";
import { KV, LimitBar, ListRow, Money, RateMeter, Section, Sparkline, SplitRows, Tag, span, useMoney } from "../../components/mobile";
import type { Account, Alert, Snapshot, Venue } from "../../protocol";
import type { RingPoint, Route } from "../../store";
import { bandDef, pctDigits, useRejectSpike, EngineFacts, EngineState, FeedRow, KillBar, LatencyTable, feedProblem, useQty } from "./shared";
import { RULES, alertText } from "./rules";
import "./ops.css";

/** One alert: what it says, what the rule means, how long it has held, and the live figures behind it. */
export function AlertM({ id }: { id: string }) {
  const alert = useStore((s) => s.snap?.alerts.find((a) => a.id === id));
  const tz = useStore((s) => s.tz);
  const hide = useStore((s) => s.hideAmounts);
  const keys = useStore((s) => s.hiddenAlerts);
  const hideAlert = useStore((s) => s.hideAlert);
  const showAlert = useStore((s) => s.showAlert);
  const now = useNow(1000) + useStore.getState().skew;

  if (!alert) {
    return (
      <Section>
        <div className="m-empty">This alert is no longer in the list.</div>
        <ListRow dense title="All alerts" to={{ page: "alerts" }} />
      </Section>
    );
  }
  const rule = RULES[alert.rule];
  const zone = tz === "utc" ? " UTC" : "";
  return (
    <>
      <Section>
        <div className={"m-ops-alert-text " + alert.level}>
          <LevelIcon level={alert.level} size={20} />
          <p>{alertText(alert, hide)}</p>
        </div>
        {/* the server rewrites the text at each check while the alert holds */}
        {alert.active && <p className="m-ops-asof">Text from the server's last check</p>}
        <KV
          cols={3}
          items={[
            { label: "Rule", value: rule?.name ?? alert.rule, info: rule?.means },
            { label: "Since", value: hms(alert.since, tz) + zone },
            alert.active ? { label: "Active for", value: span(now - alert.since) } : { label: "State", value: "cleared" },
          ]}
        />
      </Section>
      {/* a warning or info can leave the badge and the Desk on this browser until it clears; a critical one never */}
      {canHide(alert) && (
        <Section>
          {isHidden(alert, keys) ? (
            <ListRow dense chevron={false} title="Show this alert" subtitle="Hidden on this browser" onClick={() => showAlert(alert)} />
          ) : (
            <ListRow
              dense
              chevron={false}
              title="Hide this alert"
              subtitle="Off the badge and the Desk on this browser, until it clears"
              onClick={() => hideAlert(alert)}
            />
          )}
        </Section>
      )}
      {alert.active ? <Evidence a={alert} now={now} /> : <Subject a={alert} />}
    </>
  );
}

// ---- reading the subject out of the alert ----

/** The part of the id after "rule:", e.g. "sub-a" in "orders_10s:sub-a". */
const keyOf = (a: Alert) => (a.id.startsWith(a.rule + ":") ? a.id.slice(a.rule.length + 1) : "");

function accountOf(a: Alert, accounts: Account[]): Account | null {
  const k = keyOf(a).split(":")[0];
  return accounts.find((x) => x.id === k) ?? accounts.find((x) => a.text.startsWith(x.id + " ")) ?? null;
}

/** Instruments named after the text's last ": " ("no quote > 60s: BTCUSDT, ETHUSDT (usdm) +3"). */
function instrumentsOf(a: Alert, snap: Snapshot): { list: { symbol: string; venue: Venue }[]; more: number } {
  const i = a.text.lastIndexOf(": ");
  const tail = i >= 0 ? a.text.slice(i + 2) : a.text;
  let more = 0;
  const list: { symbol: string; venue: Venue }[] = [];
  for (let part of tail.split(", ")) {
    const m = / \+(\d+)$/.exec(part);
    if (m) {
      more = Number(m[1]);
      part = part.slice(0, m.index);
    }
    const venue: Venue = part.includes("(usdm)") ? "usdm" : "spot";
    const symbol = part.replace("(usdm)", "").trim().split(" ")[0]!;
    if (!symbol) continue;
    if (snap.symbols.some((s) => s.symbol === symbol && s.venue === venue)) list.push({ symbol, venue });
    else {
      // dust and the mock name the asset ("0.31 DOT"); find its USDT pair
      const hit = snap.symbols.find((s) => s.venue === "spot" && part.split(" ").some((w) => w && s.symbol === w + "USDT"));
      if (hit) list.push({ symbol: hit.symbol, venue: "spot" });
    }
  }
  return { list, more };
}

const limitFrom = (text: string) => {
  const m = /below\s+[-−]([\d,]+(?:\.\d+)?)/.exec(text);
  return m ? Number(m[1]!.replace(/,/g, "")) : null;
};

/** "hedge-1 p99 over 5,000us: …" -> 5000. */
const usLimit = (text: string) => {
  const m = /over\s+([\d,]+)\s*us/.exec(text);
  return m ? Number(m[1]!.replace(/,/g, "")) : null;
};

// ---- evidence, per rule ----

function Evidence({ a, now }: { a: Alert; now: number }) {
  const snap = useStore((s) => s.snap);
  if (!snap) return null;
  const acct = accountOf(a, snap.accounts);
  const key = keyOf(a);
  switch (a.rule) {
    case "exposure_gap":
      return <ExposureEv a={a} />;
    case "orders_10s":
    case "orders_1d":
      return <OrdersEv rule={a.rule} subject={acct} accounts={snap.accounts} />;
    case "stream_down":
    case "stream_silent":
      return <FeedsEv a={a} now={now} />;
    case "user_stream":
      return <FeedsEv a={a} now={now} subject={acct} />;
    case "rest_ban":
      return <FeedsEv a={a} now={now} kind="rest" />;
    case "stale_quote":
    case "dust":
      return <InstrumentsEv a={a} snap={snap} dust={a.rule === "dust"} />;
    case "engine":
    case "engine_latency": {
      const name = key.split(":")[0];
      const e = snap.engines.find((x) => x.name === name) ?? snap.engines.find((x) => a.text.startsWith(x.name + " "));
      return e ? <EngineEv name={e.name} latency={a.rule === "engine_latency"} limitUs={usLimit(a.text)} /> : <EnginesLink />;
    }
    case "drawdown":
    case "pnl_1h":
      return <PnlEv a={a} />;
    case "markout":
      return <MarkoutEv />;
    case "reconcile":
      return <ReconcileEv />;
    case "fee_change":
      return key === "expiry" ? <FeeExpiryEv /> : acct ? <FeesEv acct={acct} /> : <AccountsLink />;
    case "inventory":
      return <InventoryEv a={a} snap={snap} />;
    case "quote_idle":
      return acct ? <QuoteIdleEv acct={acct} /> : <AccountsLink />;
    case "futures_margin":
      return acct ? <MarginEv acct={acct} /> : <AccountsLink />;
    default:
      return acct ? (
        <Section>
          <AccountLink acct={acct} />
        </Section>
      ) : null;
  }
}

/** A cleared alert: no live figures (they would be about now, not about it), only where its subject lives. */
function Subject({ a }: { a: Alert }) {
  const snap = useStore((s) => s.snap);
  if (!snap) return null;
  const acct = accountOf(a, snap.accounts);
  if (acct) return <Section><AccountLink acct={acct} /></Section>;
  const to: Record<string, [string, Route]> = {
    stream_down: ["Feeds", { page: "system" }],
    stream_silent: ["Feeds", { page: "system" }],
    rest_ban: ["Feeds", { page: "system" }],
    engine: ["System", { page: "system" }],
    engine_latency: ["System", { page: "system" }],
    markout: ["Analysis", { page: "analysis" }],
    exposure_gap: ["Assets", { page: "assets" }],
    drawdown: ["Desk", { page: "desk" }],
    pnl_1h: ["Desk", { page: "desk" }],
    reconcile: ["Desk", { page: "desk" }],
  };
  const t = to[a.rule];
  const inst = a.rule === "stale_quote" || a.rule === "dust" || a.rule === "inventory" ? instrumentsOf(a, snap).list : [];
  if (!t && !inst.length) return null;
  return (
    <Section>
      {inst.map(({ symbol, venue }) => (
        <ListRow
          key={symbol + venue}
          dense
          title={
            <>
              {symbol}
              {venue === "usdm" && <Tag>perp</Tag>}
            </>
          }
          to={{ page: "desk", detail: { kind: "instrument", symbol, venue } }}
        />
      ))}
      {t && <ListRow dense title={t[0]} to={t[1]} />}
    </Section>
  );
}

/** Where an alert's subject could not be read from it: the accounts, so the page is not a dead end. */
function AccountsLink() {
  return (
    <Section>
      <ListRow dense title="Assets" to={{ page: "assets" }} />
    </Section>
  );
}

function AccountLink({ acct, note }: { acct: Account; note?: ReactNode }) {
  return (
    <ListRow
      dense
      title={
        <>
          {acct.label}
          <Tag>account</Tag>
        </>
      }
      primary={note}
      to={{ page: "assets", detail: { kind: "account", id: acct.id } }}
    />
  );
}

/** A trend under a figure: its name and its time span, then the line with its ends and range. */
function Trend({ label, span, children }: { label: ReactNode; span: ReactNode; children: ReactNode }) {
  return (
    <div className="m-ops-trend">
      <div className="m-ops-trend-head">
        <span>{label}</span>
        <span>{span}</span>
      </div>
      {children}
    </div>
  );
}

/** The ring's samples as a line: what they say since bndesk was opened, or over the alert's life when the
 *  ring reaches back that far. */
function RingTrend({ a, label, pick, refs }: { a: Alert; label: string; pick: (p: RingPoint) => number | null; refs?: number[] }) {
  const ring = useStore((s) => s.ring);
  const tz = useStore((s) => s.tz);
  const money = useMoney();
  const pts = ring.filter((p) => p.t >= a.since - 60_000);
  // the ring is this device's own: it reaches back only to when bndesk was opened here
  const opened = `since you opened bndesk${ring.length ? ` at ${hm(ring[0]!.t, tz)}` : ""}`;
  if (pts.length < 2)
    return (
      <Trend label={label} span={opened}>
        <div className="m-note m-ops-trend-wait">Starts now</div>
      </Trend>
    );
  const span = ring[0]!.t > a.since ? opened : `since it began at ${hm(a.since, tz)}`;
  return (
    <Trend label={label} span={span}>
      <Sparkline
        values={pts.map(pick)}
        height={48}
        color="var(--ink-2)"
        refs={refs}
        range={(x) => money(x, "pnlShort")}
        ends={[hm(pts[0]!.t, tz), "now"]}
      />
    </Trend>
  );
}

function ExposureEv({ a }: { a: Alert }) {
  const e = useStore((s) => s.snap?.exposure);
  const series = useStore((s) => s.snap?.series);
  const tz = useStore((s) => s.tz);
  const money = useMoney();
  // net exposure over the last hour, from the desk's own 5 s series
  const net = useMemo(() => {
    const pts = series ?? [];
    const end = pts.length ? pts[pts.length - 1]!.t : 0;
    return pts.filter((p) => p.t > end - 3_600_000);
  }, [series]);
  if (!e) return null;
  const band = e.band;
  return (
    <Section title="Now, USDT" link={{ label: "Assets", to: { page: "assets" } }}>
      {e.gap != null && band != null && !e.paused ? (
        <LimitBar
          label="Exposure gap"
          info={`Hedge target minus the futures notional of the hedge symbols (the trade that closes it; negative = sell more). ${bandDef(money(band, "usd"))} USDT.`}
          value={e.gap}
          limit={band}
          centered
        />
      ) : e.paused && band != null ? (
        <LimitBar
          label="Hedge to close"
          info={`${e.paused}: the hedge is off and its target is 0; this is the hedge symbols' futures notional still open, against the band ±${money(band, "usd")}. USDT.`}
          value={e.hedge_notional}
          limit={band}
          centered
        />
      ) : (
        <div className="m-empty">{e.paused ? `Hedge off (${e.paused}): the target is 0.` : "No hedge target set."}</div>
      )}
      <KV
        cols={3}
        items={[
          { label: "Hedge", info: "Futures notional of the hedge symbols.", value: money(e.hedge_notional) },
          {
            label: "Hedge target",
            info: `Hedge target = −${num(e.ratio, 2)} × Spot × beta: a short against the spot held, so it carries the opposite sign.`,
            value: money(e.target),
          },
          {
            label: "Spot × beta",
            info: `The spot inventory's value with each market weighted by its beta to the hedge instrument (${e.beta_source === "estimate" ? "the desk's estimate" : "configured"}). Hedge target = −${num(e.ratio, 2)} × this.`,
            value: money(e.beta_value, "usd"),
          },
        ]}
      />
      {e.paused ? (
        <RingTrend
          a={a}
          label={band != null ? `Hedge to close, band ±${money(band, "usd")} dashed` : "Hedge to close"}
          pick={(p) => p.hedge}
          refs={band != null ? [band, -band] : undefined}
        />
      ) : (
        <RingTrend
          a={a}
          label={band != null ? `Exposure gap, band ±${money(band, "usd")} dashed` : "Exposure gap"}
          pick={(p) => p.gap}
          refs={band != null ? [band, -band] : undefined}
        />
      )}
      {net.length > 1 && (
        <Trend label="Net exposure" span="last hour">
          <Sparkline
            values={net.map((p) => p.inventory + p.futures_notional)}
            height={48}
            color="var(--ink-2)"
            range={(x) => money(x, "pnlShort")}
            ends={[hm(net[0]!.t, tz), hm(net[net.length - 1]!.t, tz) + (tz === "utc" ? " UTC" : "")]}
          />
        </Trend>
      )}
    </Section>
  );
}

function OrdersEv({ rule, subject, accounts }: { rule: "orders_10s" | "orders_1d"; subject: Account | null; accounts: Account[] }) {
  const tenS = rule === "orders_10s";
  const list = accounts
    .filter((a) => (tenS ? a.orders_10s_limit : a.orders_1d_limit) > 0)
    .sort((x, y) => (x.id === subject?.id ? -1 : y.id === subject?.id ? 1 : 0));
  const digits = pctDigits(list.map((a) => a.orders_1d / a.orders_1d_limit));
  return (
    <Section
      title={tenS ? "Orders 10 s, by account" : "Orders 1 d, by account"}
      info={
        tenS
          ? "New orders in the last 10 s against Binance's limit."
          : `Orders today against Binance's daily limit${list[0] ? `, ${int(list[0].orders_1d_limit)}` : ""}.`
      }
    >
      {list.map((a) => (
        <RateMeter
          key={a.id}
          label={a.label}
          value={tenS ? a.orders_10s : a.orders_1d}
          limit={tenS ? a.orders_10s_limit : a.orders_1d_limit}
          pct={!tenS}
          digits={tenS ? 0 : digits}
        />
      ))}
      {subject && <AccountLink acct={subject} />}
    </Section>
  );
}

function FeedsEv({ a, now, kind, subject }: { a: Alert; now: number; kind?: "rest"; subject?: Account | null }) {
  const feeds = useStore((s) => s.snap?.feeds) ?? [];
  const alerts = useStore((s) => s.snap?.alerts);
  const key = keyOf(a);
  let list = feeds.filter((f) => (kind ? f.kind === kind : feedProblem(f, now, alerts)));
  // the alert's own feed first, even when it is back up
  const own = feeds.find((f) => f.name === key || (a.rule === "user_stream" && a.text.startsWith(f.name)));
  if (own && !list.includes(own)) list = [own, ...list];
  else if (own) list = [own, ...list.filter((f) => f !== own)];
  const bad = feeds.filter((f) => feedProblem(f, now, alerts)).length;
  return (
    <Section
      title={kind ? "REST pollers, now" : bad ? "Feeds that need a look, now" : "Feeds, now"}
      right={<>{int(feeds.length - bad)} of {int(feeds.length)} up</>}
      link={{ label: "Health", to: { page: "system" } }}
    >
      {list.map((f) => (
        <FeedRow key={f.name} f={f} now={now} alerts={alerts} />
      ))}
      {list.length === 0 && <div className="m-empty">Every feed is up now.</div>}
      {subject && <AccountLink acct={subject} />}
    </Section>
  );
}

function InstrumentsEv({ a, snap, dust }: { a: Alert; snap: Snapshot; dust: boolean }) {
  const tz = useStore((s) => s.tz);
  const qOf = useQty();
  const { list, more } = instrumentsOf(a, snap);
  if (!list.length) return null;
  return (
    <Section title={dust ? "Balance now" : "Instruments now"} right={more ? <>+{int(more)} not listed</> : undefined}>
      {list.map(({ symbol, venue }) => {
        const s = snap.symbols.find((x) => x.symbol === symbol && x.venue === venue);
        return (
          <ListRow
            key={symbol + venue}
            title={
              <>
                {symbol}
                {venue === "usdm" && <Tag>perp</Tag>}
              </>
            }
            subtitle={
              dust
                ? `${qOf(s?.inv_qty)} ${symbol.replace(/USDT$/, "")}`
                : `bid ${price(s?.bid)} · ask ${price(s?.ask)}`
            }
            primary={
              dust ? (
                <Money v={s?.inv_value} kind="short" />
              ) : (
                <span className="m-fig">
                  {s?.spread_bps != null ? num(s.spread_bps, 1) : "—"}
                  <span className="m-unit">bps spread</span>
                </span>
              )
            }
            secondary={dust ? undefined : s?.last_fill ? `last fill ${hm(s.last_fill, tz)}` : "no fill today"}
            to={{ page: "desk", detail: { kind: "instrument", symbol, venue } }}
          />
        );
      })}
    </Section>
  );
}

function EngineEv({ name, latency, limitUs }: { name: string; latency: boolean; limitUs?: number | null }) {
  const e = useStore((s) => s.snap?.engines.find((x) => x.name === name));
  const spike = useRejectSpike(name);
  if (!e) return null;
  return (
    <Section title={e.name} right={<EngineState e={e} />} link={{ label: "Health", to: { page: "system" } }}>
      {e.kill && <div className="m-ops-kill">Kill active{e.kill_reason ? `: ${e.kill_reason}` : ""}</div>}
      {latency ? <LatencyTable e={e} p99Limit={limitUs} /> : <KillBar e={e} />}
      <EngineFacts e={e} spike={spike} />
      {!latency && <LatencyTable e={e} />}
    </Section>
  );
}

function EnginesLink() {
  return (
    <Section>
      <ListRow dense title="Engine health" to={{ page: "system" }} />
    </Section>
  );
}

function PnlEv({ a }: { a: Alert }) {
  const sm = useStore((s) => s.snap?.summary);
  const series = useStore((s) => s.snap?.series);
  const tz = useStore((s) => s.tz);
  const money = useMoney();
  // the last hour of day PnL, from the desk's 5 s series
  const last = useMemo(() => {
    const pts = series ?? [];
    const end = pts.length ? pts[pts.length - 1]!.t : 0;
    return pts.filter((p) => p.t > end - 3_600_000);
  }, [series]);
  if (!sm) return null;
  const hour = a.rule === "pnl_1h";
  const lim = limitFrom(a.text);
  const v = hour ? sm.pnl_1h : sm.pnl_day;
  // where the limit sits on the day PnL line: the drawdown floor, or an hour's loss below where the hour began
  const at = lim == null ? null : hour ? (last[0] ? last[0].pnl_day - lim : null) : -lim;
  // drawn only when it is near the line: far off, it would flatten the line to nothing
  let lo = Infinity;
  let hi = -Infinity;
  for (const p of last) {
    lo = Math.min(lo, p.pnl_day);
    hi = Math.max(hi, p.pnl_day);
  }
  const near = at != null && at >= lo - (hi - lo) && at <= hi + (hi - lo);
  const ref = near && at != null ? [at] : undefined;
  const limLabel = at == null ? null : `limit ${money(at, "pnlShort")}${near ? " dashed" : at < lo ? " below the chart" : " above the chart"}`;
  return (
    <Section title="Now, USDT" link={{ label: "Desk", to: { page: "desk" } }}>
      {lim != null && (
        <LimitBar
          label={hour ? "Last hour" : "Day PnL"}
          info={hour ? "Last hour's PnL against the loss limit." : "Day PnL against the drawdown limit."}
          value={Math.max(0, -v)}
          limit={lim}
          text={
            <>
              <Money v={v} />
              <span className="m-lim-of"> / {money(-lim)}</span>
            </>
          }
        />
      )}
      <KV
        cols={2}
        items={
          lim == null
            ? [
                { label: "Day PnL", value: money(sm.pnl_day), v: sm.pnl_day },
                { label: "Last hour", value: money(sm.pnl_1h), v: sm.pnl_1h },
              ]
            : [
                hour
                  ? { label: "Day PnL", value: money(sm.pnl_day), v: sm.pnl_day }
                  : { label: "Last hour", value: money(sm.pnl_1h), v: sm.pnl_1h },
                { label: "Equity", value: money(sm.equity, "usd") },
              ]
        }
      />
      {last.length > 1 && (
        <Trend label="Day PnL, last hour" span={limLabel}>
          <Sparkline
            values={last.map((p) => p.pnl_day)}
            height={56}
            refs={ref}
            range={(x) => money(x, "pnlShort")}
            ends={[hm(last[0]!.t, tz), hm(last[last.length - 1]!.t, tz) + (tz === "utc" ? " UTC" : "")]}
          />
        </Trend>
      )}
    </Section>
  );
}

function MarkoutEv() {
  const sm = useStore((s) => s.snap?.summary);
  const mk = useStore((s) => s.snap?.markouts);
  if (!sm) return null;
  const i10 = mk?.horizons.indexOf(10) ?? -1;
  const day = i10 >= 0 ? mk!.all[i10] : null;
  const f = (v: number | null | undefined) => (v == null ? "—" : `${bps(v)} bps`);
  const hour = sm.markout_net_bps_1h;
  // one figure when the hour and the day read the same
  const same = f(hour) === f(day);
  return (
    <Section title="Markout 10 s" link={{ label: "Analysis", to: { page: "analysis" } }}>
      <KV
        cols={same ? 2 : 3}
        items={[
          {
            label: same ? "Last hour and today" : "Last hour",
            info:
              "Volume-weighted 10 s markout, net of the reference move from 1 s, over the last hour's fills" +
              (same ? " and over all of today's fills: both read the same." : "."),
            value: f(hour),
            v: hour,
          },
          ...(same ? [] : [{ label: "Today", info: "The same over all of today's fills.", value: f(day), v: day }]),
          { label: "Fills / h", value: int(sm.fills_1h) },
        ]}
      />
    </Section>
  );
}

function ReconcileEv() {
  const sm = useStore((s) => s.snap?.summary);
  const hedge = useStore((s) => s.snap?.exposure.hedge_day?.hedge_pnl ?? null);
  if (!sm) return null;
  return (
    <Section title="Day PnL split, USDT" link={{ label: "Desk", to: { page: "desk" } }}>
      <SplitRows
        rows={[
          { key: "mm", label: "Market making", v: sm.pnl.mm },
          { key: "inv", label: "Inventory PnL", v: sm.pnl.inventory },
          { key: "hedge", label: "Hedge", v: hedge },
          { key: "reb", label: "Rebates", v: sm.rebates },
          {
            key: "other",
            label: "Other",
            info: "Day PnL minus trading PnL, the hedge and the rebates: what none of them explains.",
            v: sm.other,
            tone: "warn",
          },
        ]}
        total={{ label: "Day PnL", v: sm.pnl_day }}
      />
    </Section>
  );
}

function FeesEv({ acct }: { acct: Account }) {
  return (
    <Section title="Commission" info="Maker and taker commission, bps; changed: differs from the first value seen.">
      {acct.fees.map((f) => (
        <ListRow
          key={f.venue}
          dense
          title={
            <>
              {f.venue === "usdm" ? "USD-M" : "Spot"}
              {f.changed && <Tag tone="warn">changed</Tag>}
            </>
          }
          primary={
            <span className="m-fig">
              {bps(f.maker_bps)} / {bps(f.taker_bps)}
              <span className="m-unit">bps</span>
            </span>
          }
          secondary="maker / taker"
        />
      ))}
      <AccountLink acct={acct} />
    </Section>
  );
}

function FeeExpiryEv() {
  const exp = useStore((s) => s.snap?.summary.fee_expiry);
  if (!exp) return null;
  return (
    <Section link={{ label: "Assets", to: { page: "assets" } }}>
      <KV items={[{ label: "Fee arrangement ends", value: exp, span: 2 }]} />
    </Section>
  );
}

function InventoryEv({ a, snap }: { a: Alert; snap: Snapshot }) {
  const money = useMoney();
  const named = instrumentsOf(a, snap).list.map((x) => x.symbol);
  const top = snap.symbols
    .filter((s) => s.venue === "spot" && Math.abs(s.inv_value) > 0)
    .sort((x, y) => (named.includes(y.symbol) ? 1 : 0) - (named.includes(x.symbol) ? 1 : 0) || Math.abs(y.inv_value) - Math.abs(x.inv_value))
    .slice(0, 5);
  return (
    <Section title="Inventory" right={<>value {money(snap.summary.inventory_value, "short")} · {int(snap.summary.inventory_assets)} assets</>}>
      {top.map((s) => (
        <ListRow
          key={s.symbol}
          dense
          title={s.symbol}
          tone={named.includes(s.symbol) ? "warn" : undefined}
          primary={<Money v={s.inv_value} kind="short" />}
          to={{ page: "desk", detail: { kind: "instrument", symbol: s.symbol, venue: "spot" } }}
        />
      ))}
    </Section>
  );
}

function QuoteIdleEv({ acct }: { acct: Account }) {
  const money = useMoney();
  return (
    <Section>
      <KV
        cols={3}
        items={[
          { label: "Free quote", value: money(acct.quote_free, "usd") },
          { label: "Resting bids", value: money(acct.bids_notional, "usd") },
          {
            label: "Bid use",
            info: "The share of the account's USDT tied up in its resting buy orders: resting bids ÷ (free USDT + resting bids). Near 100 %, there is little left to bid with.",
            value: pct(acct.utilization),
          },
        ]}
      />
      <AccountLink acct={acct} />
    </Section>
  );
}

function MarginEv({ acct }: { acct: Account }) {
  const money = useMoney();
  return (
    <Section>
      <KV
        cols={3}
        items={[
          { label: "Available", value: money(acct.fut_available, "usd") },
          { label: "Wallet", value: money(acct.fut_wallet, "usd") },
          { label: "uPnL", value: money(acct.fut_upnl), v: acct.fut_upnl },
        ]}
      />
      <AccountLink acct={acct} note={<>{int(acct.positions.length)} positions</>} />
    </Section>
  );
}
