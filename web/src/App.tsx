import { lazy, Suspense, useDeferredValue, useEffect } from "react";
import { Header, PAGE_KEYS } from "./components/Header";
import { AlertBanner } from "./components/AlertBanner";
import { DemoNotice } from "./components/DemoNotice";
import { deskPage, useStore } from "./store";
import { useIsMobile } from "./hooks";
import { MobileShell } from "./components/mobile/MobileShell";
import { LoadBoundary } from "./components/LoadBoundary";
import { isPhoneLayout } from "./responsive";

// Every page is its own chunk, so a phone, whose pages are lazy too (pages/mobile), never loads AG Grid. The
// desktop fetches all of them as soon as it mounts (while the first snapshot is on its way), and a page switch
// keeps the page shown until the next one is ready, so a slow load never blanks the frame.
const LOAD = {
  desk: () => import("./pages/Desk").then((m) => ({ default: m.Desk })),
  markouts: () => import("./pages/Markouts").then((m) => ({ default: m.Markouts })),
  accounts: () => import("./pages/Accounts").then((m) => ({ default: m.Accounts })),
  engine: () => import("./pages/Engine").then((m) => ({ default: m.Engine })),
  orders: () => import("./pages/Orders").then((m) => ({ default: m.Orders })),
  history: () => import("./pages/History").then((m) => ({ default: m.History })),
};
const Desk = lazy(LOAD.desk);
const Markouts = lazy(LOAD.markouts);
const Accounts = lazy(LOAD.accounts);
const Engine = lazy(LOAD.engine);
const Orders = lazy(LOAD.orders);
const History = lazy(LOAD.history);

export function App() {
  const mobile = useIsMobile();

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return;
      // the desktop's page keys; the phone has its tab bar (a keyboard on a phone is for typing)
      const p = isPhoneLayout() ? undefined : PAGE_KEYS[e.key];
      if (p) useStore.getState().setPage(p);
      if (e.key === "t") {
        const s = useStore.getState();
        s.setTz(s.tz === "utc" ? "local" : "utc");
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  return mobile ? <MobileShell /> : <DesktopApp />;
}

function DesktopApp() {
  // deferred: a page whose chunk is still loading suspends the deferred render, not the one on screen
  const page = useDeferredValue(deskPage(useStore((s) => s.page)));
  const ready = useStore((s) => s.snap != null);
  useEffect(() => Object.values(LOAD).forEach((load) => void load().catch(() => {})), []);
  return (
    <div className="app">
      <Header />
      <AlertBanner />
      {import.meta.env.VITE_MOCK === "1" && <DemoNotice />}
      <main className="app-main">
        {!ready ? (
          <div className="waiting">Waiting for the first snapshot from the server</div>
        ) : (
          <LoadBoundary key={page}>
            <Suspense fallback={<div className="waiting">Loading the page</div>}>
              {page === "desk" ? (
                <Desk />
              ) : page === "history" ? (
                <History />
              ) : page === "markouts" ? (
                <Markouts />
              ) : page === "orders" ? (
                <Orders />
              ) : page === "accounts" ? (
                <Accounts />
              ) : (
                <Engine />
              )}
            </Suspense>
          </LoadBoundary>
        )}
      </main>
    </div>
  );
}
