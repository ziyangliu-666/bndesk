import { Suspense, useDeferredValue, useEffect } from "react";
import { Header, PAGE_KEYS } from "./components/Header";
import { AlertBanner } from "./components/AlertBanner";
import { DemoNotice } from "./components/DemoNotice";
import { deskPage, useStore } from "./store";
import { useIsMobile } from "./hooks";
import { MobileShell } from "./components/mobile/MobileShell";
import { LoadBoundary } from "./components/LoadBoundary";
import { isPhoneLayout, isPhoneNow } from "./responsive";
import { lazyPage, useFirstPage } from "./lazyPage";
import { routePage } from "./pages/mobile";

// Every page is its own chunk, so a phone, whose pages are lazy too (pages/mobile), never loads AG Grid. The
// desktop fetches all of them as soon as it mounts (while the first snapshot is on its way), and a page switch
// keeps the page shown until the next one is ready, so a slow load never blanks the frame.
const Desk = lazyPage(() => import("./pages/Desk").then((m) => ({ default: m.Desk })));
const Markouts = lazyPage(() => import("./pages/Markouts").then((m) => ({ default: m.Markouts })));
const Accounts = lazyPage(() => import("./pages/Accounts").then((m) => ({ default: m.Accounts })));
const Engine = lazyPage(() => import("./pages/Engine").then((m) => ({ default: m.Engine })));
const Orders = lazyPage(() => import("./pages/Orders").then((m) => ({ default: m.Orders })));
const History = lazyPage(() => import("./pages/History").then((m) => ({ default: m.History })));
const LOAD = [Desk, Markouts, Accounts, Engine, Orders, History];
const PAGE = { desk: Desk, markouts: Markouts, accounts: Accounts, engine: Engine, orders: Orders, history: History };

/** The layout's Desk, fetched at once (index.html has already asked for its files): it is ready to draw when the
 *  first snapshot lands, instead of being asked for only then. */
export function preloadFirst() {
  const r = useStore.getState().route;
  void (isPhoneNow() ? routePage(r) : PAGE[deskPage(r.page)]).preload().catch(() => {});
}

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
  // the first page's chunk is there before it renders: it shows complete, never as a fallback
  const firstPage = useFirstPage(PAGE[page]);
  const ready = useStore((s) => s.snap != null) && firstPage;
  useEffect(() => LOAD.forEach((p) => void p.preload().catch(() => {})), []);
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
