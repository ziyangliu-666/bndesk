import { Suspense, useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";
import { UnstyledButton } from "@mantine/core";
import { IconX } from "@tabler/icons-react";
import { arrival, back, hashOf, isSub, useStore, type Route } from "../../store";
import { TEXT_FIELD } from "../../responsive";
import { DETAILS, PAGES, routePage } from "../../pages/mobile";
import { preloadIdle, useFirstPage } from "../../lazyPage";
import { TopBar } from "./TopBar";
import { MobileNav } from "./MobileNav";
import { InfoSheet } from "./Info";
import { useFreshness } from "./StatusPill";
import { LoadBoundary } from "../LoadBoundary";
import "./shell.css";

/** The phone app: top bar, the route's page, bottom tab bar. The document scrolls, not a box inside it. */
export function MobileShell() {
  const route = useStore((s) => s.route);
  // the first page's chunk is there before it renders: it shows complete, never as a fallback
  const firstPage = useFirstPage(routePage(route));
  const ready = useStore((s) => s.snap != null) && firstPage;
  // the other tabs and pages once the first is drawn: a tap finds its page there
  useEffect(() => {
    if (ready) preloadIdle([...Object.values(PAGES).map((p) => p.C), ...Object.values(DETAILS)]);
  }, [ready]);
  const typing = useTyping();
  const app = useRef<HTMLDivElement>(null);
  useEdgeBack();
  useInputMode();
  return (
    <div ref={app} className={"m-app" + (typing ? " typing" : "")}>
      <StaleMark app={app} />
      <TopBar route={route} />
      {import.meta.env.VITE_MOCK === "1" && <DemoLine />}
      <main className="m-main" key={hashOf(route)}>
        {!ready ? (
          <div className="m-waiting">
            Waiting for the first snapshot from the server
          </div>
        ) : (
          <LoadBoundary phone>
            <Suspense fallback={<div className="m-loading" />}>
              <RoutePage route={route} />
              <ScrollOnArrive route={route} />
            </Suspense>
          </LoadBoundary>
        )}
      </main>
      <MobileNav />
      <InfoSheet />
    </div>
  );
}

/** Dims the figures while they are stale: a class on the shell's root, set from here so the freshness clock
 *  (every message, every 500 ms) re-renders this, not the shell. */
function StaleMark({ app }: { app: RefObject<HTMLDivElement | null> }) {
  const { stale } = useFreshness();
  useLayoutEffect(() => {
    app.current?.classList.toggle("stale", stale);
  });
  return null;
}

function RoutePage({ route }: { route: Route }) {
  const d = route.detail;
  if (!d) {
    const { C } = PAGES[route.page];
    return <C />;
  }
  switch (d.kind) {
    case "instrument": {
      const C = DETAILS.instrument;
      return <C symbol={d.symbol} venue={d.venue} />;
    }
    case "history-instrument": {
      const C = DETAILS["history-instrument"];
      return <C symbol={d.symbol} venue={d.venue} />;
    }
    case "account": {
      const C = DETAILS.account;
      return <C id={d.id} />;
    }
    case "day": {
      const C = DETAILS.day;
      return <C date={d.date} />;
    }
    case "alert": {
      const C = DETAILS.alert;
      return <C id={d.id} />;
    }
  }
}

/** A new page opens at the top; back, or coming back to a tab, returns to where the page was left. Rendered
 *  after the page, inside its Suspense boundary, so the page's content is there to scroll. A page that is
 *  still growing (charts mounting, a list loading) gets a few more tries, until the finger takes over. */
function ScrollOnArrive({ route }: { route: Route }) {
  useLayoutEffect(() => {
    const a = arrival(route);
    const y = a.how === "pop" || a.how === "tab" ? a.scroll : 0;
    window.scrollTo(0, y);
    if (y <= 0 || Math.abs(window.scrollY - y) < 2) return;
    let raf = 0;
    const until = performance.now() + 800;
    const stop = () => {
      cancelAnimationFrame(raf);
      for (const t of ["touchstart", "wheel", "keydown"]) window.removeEventListener(t, stop);
    };
    const again = () => {
      window.scrollTo(0, y);
      if (Math.abs(window.scrollY - y) >= 2 && performance.now() < until) raf = requestAnimationFrame(again);
      else stop();
    };
    for (const t of ["touchstart", "wheel", "keydown"]) window.addEventListener(t, stop, { passive: true });
    raf = requestAnimationFrame(again);
    return stop;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return null;
}

/** An app on the home screen has no browser back gesture on iOS: a swipe in from the left edge goes back
 *  from a page below a tab. Only there; in a browser the system's own gesture does it. */
function useEdgeBack() {
  useEffect(() => {
    const nav = navigator as Navigator & { standalone?: boolean };
    if (!(window.matchMedia("(display-mode: standalone)").matches || nav.standalone === true)) return;
    let from: { x: number; y: number } | null = null;
    const start = (e: TouchEvent) => {
      const t = e.touches[0];
      const el = e.target instanceof Element ? e.target : null;
      from =
        e.touches.length === 1 && t && t.clientX <= 24 && isSub(useStore.getState().route) &&
        !el?.closest(".m-sheet, .ex-host, .m-chips, .ex-chips, " + TEXT_FIELD)
          ? { x: t.clientX, y: t.clientY }
          : null;
    };
    const end = (e: TouchEvent) => {
      const t = e.changedTouches[0];
      const f = from;
      from = null;
      if (!f || !t) return;
      const dx = t.clientX - f.x;
      if (dx > 72 && Math.abs(t.clientY - f.y) < dx / 2) back();
    };
    const cancel = () => (from = null);
    document.addEventListener("touchstart", start, { passive: true });
    document.addEventListener("touchend", end, { passive: true });
    document.addEventListener("touchcancel", cancel, { passive: true });
    return () => {
      document.removeEventListener("touchstart", start);
      document.removeEventListener("touchend", end);
      document.removeEventListener("touchcancel", cancel);
    };
  }, []);
}

/** `html[data-input="touch"]` from a tap until the keyboard moves focus (Tab, arrows): focus rings are for the
 *  keyboard only. A browser may count focus handed back by code (a sheet closing returns it to the button that
 *  opened it) as keyboard focus and ring the button long after the tap. */
function useInputMode() {
  useEffect(() => {
    const root = document.documentElement;
    const tap = () => (root.dataset.input = "touch");
    const key = (e: KeyboardEvent) => {
      if (e.key === "Tab" || e.key.startsWith("Arrow")) delete root.dataset.input;
    };
    tap();
    document.addEventListener("pointerdown", tap, { capture: true, passive: true });
    document.addEventListener("keydown", key, { capture: true });
    return () => {
      delete root.dataset.input;
      document.removeEventListener("pointerdown", tap, { capture: true });
      document.removeEventListener("keydown", key, { capture: true });
    };
  }, []);
}

/** True while a text field has focus: the tab bar steps aside for the keyboard (iOS keeps it fixed). */
function useTyping(): boolean {
  const [typing, setTyping] = useState(false);
  useEffect(() => {
    const field = (t: EventTarget | null) => t instanceof HTMLElement && t.matches(TEXT_FIELD);
    const on = (e: FocusEvent) => field(e.target) && setTyping(true);
    const off = (e: FocusEvent) => field(e.target) && setTyping(false);
    document.addEventListener("focusin", on);
    document.addEventListener("focusout", off);
    return () => {
      document.removeEventListener("focusin", on);
      document.removeEventListener("focusout", off);
    };
  }, []);
  return typing;
}

const DEMO_SEEN = "bndesk-demo-line";

/** The mock build's notice, as one dismissible line instead of the desktop's dialog. */
function DemoLine() {
  const [open, setOpen] = useState(() => sessionStorage.getItem(DEMO_SEEN) == null);
  if (!open) return null;
  return (
    <div className="m-demo">
      <span>
        <b>Simulated data</b>, generated in this browser
      </span>
      <UnstyledButton
        aria-label="Dismiss"
        onClick={() => {
          sessionStorage.setItem(DEMO_SEEN, "1");
          setOpen(false);
        }}
      >
        <IconX size={16} stroke={2} />
      </UnstyledButton>
    </div>
  );
}
