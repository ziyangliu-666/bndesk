// Fullscreen for a chart: the viewport in either orientation, ✕ to close; Android (and desktop browsers) also
// get the element fullscreen and, on a phone, the landscape lock. Back closes it (its own history entry).
import { useEffect, useId, useRef, type ReactNode } from "react";
import { createPortal } from "react-dom";
import type { NavState } from "../../store";
import "./ex.css";

type LockableOrientation = ScreenOrientation & { lock?: (o: string) => Promise<void>; unlock?: () => void };

/** The browser's fullscreen was entered by goFullscreen (and is left when the chart's overlay closes). */
let ours = false;

/**
 * Call in the click handler that opens a ChartFullscreen (the browser only allows it inside a user gesture):
 * on a touch screen, the document goes fullscreen and the phone locks to landscape (Android Chrome). Fails
 * quietly where unsupported (iPhone Safari); a desktop keeps its window and the overlay fills it.
 */
export function goFullscreen() {
  const el = document.documentElement;
  if (!window.matchMedia("(pointer: coarse)").matches || !el.requestFullscreen || document.fullscreenElement) return;
  el.requestFullscreen({ navigationUI: "hide" })
    .then(() => {
      ours = true;
      return (screen.orientation as LockableOrientation | undefined)?.lock?.("landscape");
    })
    .catch(() => {});
}

/**
 * Renders `children` (usually an ExChart with `fill`, or ExChart's own copy when it has `fullscreen`) over the
 * whole viewport, with `title` in a 40 px header. Call `goFullscreen()` in the click that opens it for the
 * browser fullscreen and landscape lock on Android; elsewhere (iPhone Safari) the overlay still fills the
 * viewport in whichever orientation the phone is held. Escape, leaving the browser fullscreen and the phone's
 * back all call `onClose`.
 *
 * ExChart with an `id` opens it through the store's `#/chart/<id>` route (`routed`); without one, this overlay
 * keeps a history entry of its own, the way the phone's sheets do: one Back closes it.
 */
export function ChartFullscreen({
  title,
  onClose,
  children,
  routed = false,
}: {
  title?: ReactNode;
  onClose: () => void;
  children: ReactNode;
  /** The store's chart route (`#/chart/<id>`, openChart) holds the history entry: no entry of its own. */
  routed?: boolean;
}) {
  const el = useRef<HTMLDivElement>(null);
  const id = "chart-" + useId();
  const close = useRef(onClose);
  close.current = onClose;
  const alive = useRef(false);

  // leaving the browser's fullscreen (Android back, a swipe) closes it; closing leaves the browser's fullscreen
  useEffect(() => {
    const onChange = () => {
      if (!document.fullscreenElement && ours) {
        ours = false;
        close.current();
      }
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && close.current();
    document.addEventListener("fullscreenchange", onChange);
    window.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("fullscreenchange", onChange);
      window.removeEventListener("keydown", onKey);
      // deferred, like the history entry below: StrictMode's re-run must not leave fullscreen
      setTimeout(() => {
        if (alive.current) return;
        try {
          (screen.orientation as LockableOrientation | undefined)?.unlock?.();
        } catch {
          /* not locked */
        }
        if (ours && document.fullscreenElement) document.exitFullscreen().catch(() => {});
        ours = false;
      });
    };
  }, []);

  // back closes it: an entry of its own while open (the store's navigation treats it like a sheet's)
  useEffect(() => {
    alive.current = true;
    if (routed) return () => void (alive.current = false);
    if ((history.state as NavState)?.sheet !== id) history.pushState({ ...(history.state ?? {}), sheet: id }, "", location.href);
    const onPop = () => (history.state as NavState)?.sheet !== id && close.current();
    window.addEventListener("popstate", onPop);
    return () => {
      window.removeEventListener("popstate", onPop);
      alive.current = false;
      // deferred: StrictMode runs this cleanup and the effect again at once; only a real close drops the entry
      setTimeout(() => {
        if (!alive.current && (history.state as NavState)?.sheet === id) history.back();
      });
    };
  }, [id, routed]);

  // the page under it does not scroll
  useEffect(() => {
    const prev = document.documentElement.style.overflow;
    document.documentElement.style.overflow = "hidden";
    return () => void (document.documentElement.style.overflow = prev);
  }, []);

  return createPortal(
    <div className="ex-fs" ref={el} role="dialog" aria-modal="true">
      {title != null && <div className="ex-fs-head">{title}</div>}
      <div className="ex-fs-body">{children}</div>
    </div>,
    document.body,
  );
}

/**
 * Phone: open a chart's fullscreen when the phone is turned sideways while `enabled` (the chart is on screen),
 * as exchange apps do. Pair with an IntersectionObserver / useInView for `enabled`.
 */
export function useLandscapeFullscreen(open: () => void, enabled: boolean) {
  const cb = useRef(open);
  cb.current = open;
  useEffect(() => {
    if (!enabled || !window.matchMedia("(pointer: coarse)").matches) return;
    const q = window.matchMedia("(orientation: landscape)");
    const on = () => q.matches && cb.current();
    q.addEventListener("change", on);
    return () => q.removeEventListener("change", on);
  }, [enabled]);
}
