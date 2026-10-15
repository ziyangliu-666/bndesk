import { useMemo, useState } from "react";
import { useStore } from "../../store";
import { int } from "../../format";
import { Chips, Section, Segmented, useHold, useLive } from "../../components/mobile";
import { FillRow, useFillSheet, type FillFig } from "./shared";
import "./ops.css";

const N = 100;
const EMPTY: never[] = [];

const FIGS: { value: FillFig; label: string }[] = [
  { value: "edge", label: "Edge" },
  { value: "10", label: "10 s" },
  { value: "60", label: "60 s" },
];

const FIG_DEF: Record<string, string> = {
  edge: "Edge at the fill: side × (fair − price) / fair, bps. Positive: bought under or sold over the fair.",
  mk: "Markout after the fill: side × (mid / price − 1), net of the reference move from 1 s after the fill where a reference exists, bps. A dash is a horizon not yet reached. Diagnostic, not PnL.",
};

/** All fills: the newest 100, filtered by account (`#/fills/<account>` opens on one); a tap shows every field of one. */
export function FillsM() {
  // the list holds still under a resting finger
  const [held, hold] = useHold();
  const fills = useLive((s) => s.snap?.fills, 250, held) ?? EMPTY;
  const accounts = useLive((s) => s.snap?.accounts, 1000) ?? EMPTY;
  const fillsDay = useStore((s) => s.snap?.summary.fills_day);
  // #/fills/<account> opens on that account; one the desk does not know opens on all
  const [acct, setAcct] = useState(() => {
    const st = useStore.getState();
    const want = st.route.account;
    return want && st.snap?.accounts.some((a) => a.id === want) ? want : "all";
  });
  const [fig, setFig] = useState<FillFig>("edge");
  const fill = useFillSheet();

  const counts = useMemo(() => {
    const m = new Map<string, number>();
    for (const f of fills) m.set(f.account, (m.get(f.account) ?? 0) + 1);
    return m;
  }, [fills]);
  const ids = accounts.filter((a) => counts.has(a.id) || a.id === acct).map((a) => a.id);
  for (const k of counts.keys()) if (!ids.includes(k)) ids.push(k);
  const labelOf = (id: string) => accounts.find((a) => a.id === id)?.label ?? id;

  const shown = (acct === "all" ? fills : fills.filter((f) => f.account === acct)).slice(0, N);

  return (
    <>
      {(ids.length > 1 || acct !== "all") && (
        <Section card={false}>
          <Chips
            value={acct}
            onChange={setAcct}
            label="Account"
            data={[{ value: "all", label: "All" }, ...ids.map((id) => ({ value: id, label: labelOf(id), count: counts.get(id) ?? 0 }))]}
          />
        </Section>
      )}
      <div className="m-hold" {...hold}>
        <Section
          title={
            shown.length < N ? `${int(shown.length)} fills` : `Newest ${N}${acct === "all" && fillsDay != null ? ` of ${int(fillsDay)}` : ""}`
          }
          info={`The newest of the desk's recent fills, all accounts or the one chosen above. ${FIG_DEF.edge}\n\n${FIG_DEF.mk}`}
          right={<Segmented value={fig} onChange={setFig} data={FIGS} label="Figure" />}
        >
          {shown.map((f) => (
            <FillRow key={f.id} f={f} onOpen={fill.open} account={acct === "all"} fig={fig} />
          ))}
          {shown.length === 0 && <div className="m-empty">No fills today.</div>}
        </Section>
      </div>
      {fill.sheet}
    </>
  );
}
