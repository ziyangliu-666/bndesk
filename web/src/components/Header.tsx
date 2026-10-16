import { IconEye, IconEyeOff } from "@tabler/icons-react";
import { deskPage, useStore, type DeskPage } from "../store";

const PAGES: { value: DeskPage; label: string }[] = [
  { value: "desk", label: "Desk" },
  { value: "history", label: "History" },
  { value: "analysis", label: "Analysis" },
  { value: "orders", label: "Orders" },
  { value: "assets", label: "Assets" },
  { value: "system", label: "System" },
];

/** Keys 1–6 switch the desktop's pages (App.tsx); the nav's tooltips say which. */
export const PAGE_KEYS: Record<string, DeskPage> = Object.fromEntries(PAGES.map((p, i) => [String(i + 1), p.value]));

/**
 * The desktop's top nav, 44 px: the name, the pages as text tabs (ink with a short accent underline when
 * active), then Hide amounts and Log out at the right. Connection, clock and time zone are in the footer.
 */
export function Header() {
  const page = deskPage(useStore((s) => s.page));
  const setPage = useStore((s) => s.setPage);
  return (
    <header className="app-head">
      <div className="brand">bndesk</div>
      <nav className="app-nav" aria-label="Pages">
        {PAGES.map((p, i) => (
          <button
            key={p.value}
            type="button"
            className={"app-nav-tab" + (p.value === page ? " on" : "")}
            aria-current={p.value === page ? "page" : undefined}
            title={`${p.label} (key ${i + 1})`}
            onClick={() => setPage(p.value)}
          >
            {p.label}
          </button>
        ))}
      </nav>
      <div className="head-right">
        <HideAmounts />
        {import.meta.env.VITE_MOCK !== "1" && (
          <form method="post" action="/logout" className="logout">
            <button type="submit" title="End this browser's session">
              Log out
            </button>
          </form>
        )}
      </div>
    </header>
  );
}

function HideAmounts() {
  const hide = useStore((s) => s.hideAmounts);
  const set = useStore((s) => s.setHideAmounts);
  return (
    <button
      type="button"
      className={"head-icon" + (hide ? " on" : "")}
      aria-pressed={hide}
      title={hide ? "Amounts hidden. Show amounts" : "Hide amounts"}
      aria-label={hide ? "Show amounts" : "Hide amounts"}
      onClick={() => set(!hide)}
    >
      {hide ? <IconEyeOff size={18} stroke={1.6} /> : <IconEye size={18} stroke={1.6} />}
    </button>
  );
}

/** "asia closes" after "asia" reads as "closes": the session name is already there. */
export const nextEvent = (ev: string | null, cur: string | null) =>
  !ev ? "the next event" : cur && ev.startsWith(cur + " ") ? ev.slice(cur.length + 1) : ev;
