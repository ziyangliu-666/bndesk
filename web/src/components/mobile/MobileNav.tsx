import { useEffect, type ReactNode } from "react";
import { UnstyledButton } from "@mantine/core";
import { IconBell, IconChartCandle, IconDots, IconLayoutDashboard, IconWallet } from "@tabler/icons-react";
import { switchTab, useStore, type Tab } from "../../store";

const TABS: { tab: Tab; label: string; icon: (active: boolean) => ReactNode }[] = [
  { tab: "desk", label: "Desk", icon: (a) => <IconLayoutDashboard size={22} stroke={a ? 2 : 1.6} /> },
  { tab: "alerts", label: "Alerts", icon: (a) => <IconBell size={22} stroke={a ? 2 : 1.6} /> },
  { tab: "accounts", label: "Accounts", icon: (a) => <IconWallet size={22} stroke={a ? 2 : 1.6} /> },
  { tab: "history", label: "History", icon: (a) => <IconChartCandle size={22} stroke={a ? 2 : 1.6} /> },
  { tab: "more", label: "More", icon: (a) => <IconDots size={22} stroke={a ? 2 : 1.6} /> },
];

/** Active warnings and critical alerts: the count, and whether any is critical. */
export function useAlertCount(): { n: number; crit: boolean } {
  const alerts = useStore((s) => s.snap?.alerts);
  let n = 0;
  let crit = false;
  for (const a of alerts ?? []) {
    if (!a.active || a.level === "info") continue;
    n++;
    crit ||= a.level === "crit";
  }
  return { n, crit };
}

/** The bottom tab bar. A tap on another tab shows the page that tab was left on; a tap on the current tab goes
 *  back to its own page, or to the top of it. */
export function MobileNav() {
  const route = useStore((s) => s.route);
  const current = useStore((s) => s.tab);
  const { n, crit } = useAlertCount();
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
            <span className="m-tab-icon">
              {t.icon(active)}
              {t.tab === "alerts" && n > 0 && (
                <span className={"m-badge" + (crit ? " crit" : "")} aria-label={`${n} active`}>
                  {n > 99 ? "99+" : n}
                </span>
              )}
            </span>
            {t.label}
          </UnstyledButton>
        );
      })}
    </nav>
  );
}
