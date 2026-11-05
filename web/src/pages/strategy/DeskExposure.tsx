// The desk's own view of the exposure and its hedge (the Exposure & hedge tab Accounts had): by account, the
// beta-weighted value against the hedge symbols' notional, the gap to the target, and today's lines. Strategy shows
// it whenever the engine is not pushing its own figures, so the gap is never missing from the page.
import { useMemo } from "react";
import { useStore } from "../../store";
import { hm } from "../../format";
import { C, FUT_COLOR, INV_COLOR } from "../../theme";
import { ExChart, useExPref, type ExSeries } from "../../components/ex";
import { Money, amount, useHide } from "../../mask";
import { IVS, IV_KEYS, STEP, useBucketed } from "../ops/series";
import { FundingPanel, HedgePanel } from "../Accounts";
import { cur, inventoryWord, notionalWord } from "../../desk";

function ExposureTable() {
  const x = useStore((s) => s.snap?.exposure);
  const tz = useStore((s) => s.tz);
  const hide = useHide();
  const mc = hide ? "masked" : "";
  if (!x)
    return (
      <section className="ops-panel">
        <header className="ops-head">
          <span className="ops-title">Exposure</span>
        </header>
        <div className="ops-empty">--</div>
      </section>
    );
  const over = x.gap != null && x.band != null && Math.abs(x.gap) > x.band;
  return (
    <section className="ops-panel">
      <header className="ops-head">
        <span className="ops-title">Exposure ({cur()})</span>
        {x.target != null && (
          <span className="ops-head-right">
            {x.paused ? (
              <span className={over ? "warn-text" : "muted"} title="Hedge off: target 0; the hedge still open is to be closed">
                {x.paused}
                {x.paused_until != null && ` until ${hm(x.paused_until, tz)}`}
              </span>
            ) : (
              <span
                className={"ops-target fig" + (over ? " warn-text" : "")}
                title={
                  `Hedge target: −${x.ratio} × beta-weighted spot value; band: allowed |gap|, ${cur()}. ` +
                  (x.beta_source === "estimate" ? "β: the desk's own estimate, may differ from the engine's." : "β: configured per market.")
                }
              >
                Target <b className={mc}>{amount(x.target, "pnlMoney", hide)}</b> · Band <b className={mc}>±{amount(x.band, "money", hide)}</b>
              </span>
            )}
          </span>
        )}
      </header>
      <div className="ops-body ops-scroll">
        <table className="ops-table">
          <thead>
            <tr>
              <th className="l">Account</th>
              <th title={`${inventoryWord()} value at mid, ${cur()}`}>{inventoryWord() === "Inventory" ? "Value" : "Spot value"}</th>
              <th title={`${notionalWord()}, net, signed, ${cur()}`}>{notionalWord()}</th>
              <th title={`${inventoryWord()} value + ${notionalWord().toLowerCase()}, ${cur()}`}>Net</th>
            </tr>
          </thead>
          <tbody>
            {x.by_account.map((r) => (
              <tr key={r.account}>
                <td className="l">{r.account}</td>
                <td>
                  <Money v={r.spot_value} />
                </td>
                <td>
                  <Money v={r.futures_notional} sign />
                </td>
                <td>
                  <Money v={r.net} sign />
                </td>
              </tr>
            ))}
            <tr className="total">
              <td className="l">Total</td>
              <td>
                <Money v={x.spot_value} />
              </td>
              <td>
                <Money v={x.futures_notional} sign />
              </td>
              <td>
                <Money v={x.net} sign />
              </td>
            </tr>
            {x.gap != null && (
              <>
                <tr className="sub">
                  <td className="l" title={`Beta-weighted spot value and hedge symbols' futures notional, ${cur()}`}>
                    Hedge (β-weighted)
                  </td>
                  <td>
                    <Money v={x.beta_value} />
                  </td>
                  <td>
                    <Money v={x.hedge_notional} sign />
                  </td>
                  <td />
                </tr>
                <tr className={over ? "warn-row" : "sub"}>
                  <td className="l" title={x.paused ? `Hedge off: futures notional still open, to be closed, ${cur()}` : `Target − hedge futures notional: the trade that closes the gap, ${cur()}`}>
                    {x.paused ? "To close" : "Gap vs target"}
                  </td>
                  <td />
                  <td />
                  <td>
                    <Money v={x.gap} sign color={!over} />
                  </td>
                </tr>
              </>
            )}
          </tbody>
        </table>
      </div>
    </section>
  );
}

/** Today's spot inventory, futures notional and their net, on the 5 s desk grid. */
function DeskExposureChart() {
  const series = useStore((s) => s.snap?.series);
  const x = useStore((s) => s.snap?.exposure);
  const now = useStore((s) => s.snap?.now);
  const hide = useHide();
  const [iv, setIv] = useExPref("assets-exp", "interval", "1m", IV_KEYS);
  const pts = useBucketed();
  const step = STEP[iv] ?? 0;
  // the 5 s series, then the table's live figures now: the legend at rest reads what the table does
  const cols = useMemo(() => {
    const s = series ?? [];
    const c = { t: s.map((p) => p.t), inv: s.map((p) => p.inventory), fut: s.map((p) => p.futures_notional), net: s.map((p) => p.inventory + p.futures_notional) };
    if (x && now != null && (!c.t.length || now > c.t[c.t.length - 1]!)) {
      c.t.push(now);
      c.inv.push(x.spot_value);
      c.fut.push(x.futures_notional);
      c.net.push(x.net);
    }
    return c;
  }, [series, x, now]);
  const fmt = (v: number) => amount(v, "pnlMoney", hide);
  const lines: ExSeries[] = [
    { key: "inv", kind: "line", label: inventoryWord(), color: INV_COLOR, data: pts("inv", cols.t, cols.inv, step), format: fmt },
    { key: "fut", kind: "line", label: notionalWord(), color: FUT_COLOR, data: pts("fut", cols.t, cols.fut, step), format: fmt },
    { key: "net", kind: "line", label: "Net", color: C.ink, width: 1, data: pts("net", cols.t, cols.net, step), format: fmt, lastValue: false },
  ];
  return (
    <section className="ops-panel ops-chart-panel">
      <ExChart
        id="assets-exp"
        title="Exposure"
        series={lines}
        intervals={IVS}
        interval={iv}
        onInterval={setIv}
        toolbarLeft={<span className="ops-chart-title">Exposure today</span>}
        fill
        fullscreen
        emptyText="No series yet"
      />
    </section>
  );
}

/** The desk's exposure, its hedge today and funding, under a line saying why it is the desk's and not the engine's. */
export function DeskExposure({ note }: { note: string }) {
  return (
    <div className="ops-tab-body ops-exp st-exp">
      <div className="st-desk-note">{note}</div>
      <ExposureTable />
      <div className="ops-col">
        <HedgePanel />
        <FundingPanel />
      </div>
      <DeskExposureChart />
    </div>
  );
}
