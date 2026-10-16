import { useEffect, type ReactNode } from "react";
import { UnstyledButton } from "@mantine/core";
import { IconChartCandle, IconDots, IconLayoutDashboard, IconListDetails, IconWallet } from "@tabler/icons-react";
import { isHidden, switchTab, useStore, type Tab } from "../../store";

const TABS: { tab: Tab; label: string; icon: (active: boolean) => ReactNode }[] = [
  { tab: "desk", label: "Desk", icon: (a) => <IconLayoutDashboard size={22} stroke={a ? 2 : 1.6} /> },
  { tab: "markets", label: "Markets", icon: (a) => <IconListDetails size={22} stroke={a ? 2 : 1.6} /> },
  { tab: "history", label: "History", icon: (a) => <IconChartCandle size={22} stroke={a ? 2 : 1.6} /> },
  { tab: "assets", label: "Assets", icon: (a) => <IconWallet size={22} stroke={a ? 2 : 1.6} /> },
  { tab: "more", label: "More", icon: (a) => <IconDots size={22} stroke={a ? 2 : 1.6} /> },
];

/** Active warnings and critical alerts not hidden on this browser: the count, and whether any is critical. */
export function useAlertCount(): { n: number; crit: boolean } {
  const alerts = useStore((s) => s.snap?.alerts);
  const keys = useStore((s) => s.hiddenAlerts);
  let n = 0;
  let crit = false;
  for (const a of alerts ?? []) {
    if (!a.active || a.level === "info" || isHidden(a, keys)) continue;
    n++;
    crit ||= a.level === "crit";
  }
  return { n, crit };
}

/** The bottom tab bar: Desk · Markets · History · Assets · More (alerts are the top bar's bell). A tap on another tab shows the page that tab was left on; a tap on the current tab goes
 *  back to its own page, or to the top of it. */
export function MobileNav() {
  const route = useStore((s) => s.route);
  const current = useStore((s) => s.tab);
  const { n } = useAlertCount();
  useEffect(() => {
    document.title = n ? `(${n}) bndesk` : "bndesk";
  }, [n]);
  return (
    <nav className="m-nav" aria-label="Pages">
      {TABS.map((t) => {
        const active = t.tab === current;
        return (
          <UnstyledButton
            key={t.tab}
            className="m-tab"
            aria-current={active ? "page" : undefined}
            onClick={() => {
              if (active && route.page === t.tab && !route.detail) window.scrollTo({ top: 0, behavior: "smooth" });
              else switchTab(t.tab, active ? { page: t.tab } : undefined);
            }}
          >
            <span className="m-tab-icon">{t.icon(active)}</span>
            {t.label}
          </UnstyledButton>
        );
      })}
    </nav>
  );
}
