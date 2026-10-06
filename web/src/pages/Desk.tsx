import { KeyStrip } from "../components/KeyStrip";
import { DayChart } from "../components/DayChart";
import { SymbolsGrid } from "../components/SymbolsGrid";
import { FillsTape } from "../components/FillsTape";
import { AccountsGrid } from "../components/AccountsGrid";
import { Panel } from "../components/ui";
import { useStore } from "../store";

export function Desk() {
  const n = useStore((st) => st.snap?.accounts.length ?? 0);
  // header + grid header + rows + totals row, so the grid needs no inner scroll
  const accH = 30 + 27 + 24 * (n + (n > 1 ? 1 : 0)) + 4;
  return (
    <div className="desk" style={{ gridTemplateRows: `auto clamp(180px, 24vh, 380px) minmax(0, 1fr) ${accH}px` }}>
      <KeyStrip />
      <DayChart />
      <div className="desk-mid">
        <SymbolsGrid />
        <FillsTape />
      </div>
      <Panel className="accounts-panel" title="Accounts" bodyClass="grid-body">
        <AccountsGrid />
      </Panel>
    </div>
  );
}
