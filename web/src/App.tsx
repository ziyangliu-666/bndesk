import { Suspense, useDeferredValue, useEffect } from "react";
import { Header, PAGE_KEYS } from "./components/Header";
import { AlertBanner } from "./components/AlertBanner";
import { DemoNotice } from "./components/DemoNotice";
import { deskPage, selectInstrument, useStore } from "./store";
import { StatusFooter } from "./components/ex/StatusFooter";
import type { Venue } from "./protocol";
import { useIsMobile } from "./hooks";
import { MobileShell } from "./components/mobile/MobileShell";
import { LoadBoundary } from "./components/LoadBoundary";
import { isPhoneLayout, isPhoneNow } from "./responsive";
import { lazyPage, preloadIdle, useFirstPage } from "./lazyPage";
import { routePage } from "./pages/mobile";

// Every page is its own chunk, so a phone, whose pages are lazy too (pages/mobile), never loads AG Grid. The
// first page loads with the entry; the others (and the Orders page's quote map) once the first is drawn, so a
// page switch finds its chunk there and shows at once. A switch to a page still loading keeps the page shown
// until the next one is ready, so a slow load never blanks the frame.
const Desk = lazyPage(() => import("./pages/Desk").then((m) => ({ default: m.Desk })));
const Analysis = lazyPage(() => import("./pages/Markouts").then((m) => ({ default: m.Markouts })));
const Assets = lazyPage(() => import("./pages/Accounts").then((m) => ({ default: m.Accounts })));
const System = lazyPage(() => import("./pages/Engine").then((m) => ({ default: m.Engine })));
const Orders = lazyPage(() => import("./pages/Orders").then((m) => ({ default: m.Orders })));
const History = lazyPage(() => import("./pages/History").then((m) => ({ default: m.History })));
const LOAD = [Desk, Analysis, Assets, System, Orders, History, { preload: () => import("./components/quotes").then((m) => m.QuoteMapEC.preload()) }];
const PAGE = { desk: Desk, analysis: Analysis, assets: Assets, system: System, orders: Orders, history: History };

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
  useEffect(() => {
    if (ready) preloadIdle(LOAD);
  }, [ready]);
  return (
    <div className="app">
      <Header />
      <AlertBanner />
      {import.meta.env.VITE_MOCK === "1" && <DemoNotice />}
      <main className="app-main">
        {!ready ? (
          <div className="waiting">Waiting for the first snapshot from the server</div>
        ) : (
          // one boundary for every page: a new one per page would show its fallback while a chunk loads, where
          // this one keeps the page on screen (the deferred page); a page's error clears on the next page
          <LoadBoundary reset={page}>
            <Suspense fallback={<div className="waiting">Loading the page</div>}>
              {page === "desk" ? (
                <Desk />
              ) : page === "history" ? (
                <History />
              ) : page === "analysis" ? (
                <Analysis />
              ) : page === "orders" ? (
                <Orders />
              ) : page === "assets" ? (
                <Assets />
              ) : (
                <System />
              )}
            </Suspense>
          </LoadBoundary>
        )}
      </main>
      <StatusFooter onInstrument={openFromFooter} />
    </div>
  );
}

const openFromFooter = (symbol: string, venue: Venue) => selectInstrument({ symbol, venue });
