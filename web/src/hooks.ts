import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from "react";
import { isPhoneNow, PHONE_WATCH, setPhoneLayout, typingNow } from "./responsive";

const hidden = () => typeof document !== "undefined" && document.visibilityState === "hidden";

function onVisibility(fn: () => void): () => void {
  document.addEventListener("visibilitychange", fn);
  return () => document.removeEventListener("visibilitychange", fn);
}

/** Re-render on an interval and return local Date.now(). No ticks while the page is hidden. */
export function useNow(ms = 1000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const tick = () => !hidden() && setNow(Date.now());
    const id = setInterval(tick, ms);
    const off = onVisibility(tick);
    return () => {
      clearInterval(id);
      off();
    };
  }, [ms]);
  return now;
}

/** True while the page is visible (not a background tab, not a locked phone). */
export function usePageVisible(): boolean {
  return useSyncExternalStore(onVisibility, () => !hidden());
}

/** Phone layout. Read synchronously so a phone never mounts the desktop tree for a frame; also marks
 *  `html.is-phone`, which lets the document scroll instead of the app frame. Held while a text field has
 *  focus: the on-screen keyboard resizes the viewport, and a flip would unmount the field being typed in. */
export function useIsMobile(): boolean {
  const [m, setM] = useState(isPhoneNow);
  useEffect(() => {
    let t: ReturnType<typeof setTimeout> | undefined;
    const check = () => !typingNow() && setM(isPhoneNow());
    // the keyboard closes after the field loses focus: look again once it has
    const blur = () => {
      clearTimeout(t);
      t = setTimeout(check, 400);
    };
    const qs = PHONE_WATCH.map((q) => window.matchMedia(q));
    qs.forEach((q) => q.addEventListener("change", check));
    window.addEventListener("resize", check);
    window.addEventListener("orientationchange", check);
    document.addEventListener("focusout", blur);
    return () => {
      clearTimeout(t);
      qs.forEach((q) => q.removeEventListener("change", check));
      window.removeEventListener("resize", check);
      window.removeEventListener("orientationchange", check);
      document.removeEventListener("focusout", blur);
    };
  }, []);
  useLayoutEffect(() => {
    setPhoneLayout(m);
    document.documentElement.classList.toggle("is-phone", m);
  }, [m]);
  return m;
}

/** The value, updated at most once per `ms` (trailing edge): live lists render at a steady rate. */
export function useThrottled<T>(value: T, ms = 250): T {
  const [out, setOut] = useState(value);
  const last = useRef(0);
  useEffect(() => {
    const wait = last.current + ms - Date.now();
    if (wait <= 0) {
      last.current = Date.now();
      setOut(() => value);
      return;
    }
    const id = setTimeout(() => {
      last.current = Date.now();
      setOut(() => value);
    }, wait);
    return () => clearTimeout(id);
  }, [value, ms]);
  return out;
}

/** True once the element is within `margin` of the viewport (and, with `once` false, while it is). */
export function useInView<E extends Element>(margin = "200px", once = true): [(el: E | null) => void, boolean] {
  const [el, setEl] = useState<E | null>(null);
  const [seen, setSeen] = useState(false);
  useEffect(() => {
    if (!el) return;
    if (typeof IntersectionObserver === "undefined") return setSeen(true);
    const io = new IntersectionObserver(
      ([e]) => {
        if (!e) return;
        if (!once) return setSeen(e.isIntersecting);
        if (e.isIntersecting) {
          setSeen(true);
          io.disconnect();
        }
      },
      { rootMargin: margin },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [el, margin, once]);
  return [setEl, seen];
}
