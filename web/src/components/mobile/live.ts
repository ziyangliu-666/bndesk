import { useCallback, useEffect, useRef, useState } from "react";
import { useStore } from "../../store";

type State = ReturnType<typeof useStore.getState>;

/**
 * A store value for a live list, handed to the page at most once per `ms` (trailing edge). Unlike
 * useThrottled(useStore(sel)) the page does not re-render on every message in between, only when the value
 * is handed over. While `paused` (a finger rests on the list, see useHold) nothing is handed over; the latest
 * value follows on release. `key` re-reads the value at once when the selector's inputs change.
 */
export function useLive<T>(sel: (s: State) => T, ms = 250, paused = false, key?: unknown): T {
  const selRef = useRef(sel);
  selRef.current = sel;
  const pausedRef = useRef(paused);
  pausedRef.current = paused;
  const [v, setV] = useState(() => sel(useStore.getState()));
  const shown = useRef(v);
  const last = useRef(0);
  const hand = useCallback(() => {
    const nv = selRef.current(useStore.getState());
    last.current = Date.now();
    if (Object.is(nv, shown.current)) return;
    shown.current = nv;
    setV(() => nv);
  }, []);
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const fire = () => {
      timer = undefined;
      if (!pausedRef.current) hand();
    };
    const off = useStore.subscribe((s) => {
      if (timer || pausedRef.current || Object.is(selRef.current(s), shown.current)) return;
      timer = setTimeout(fire, Math.max(0, last.current + ms - Date.now()));
    });
    return () => {
      off();
      if (timer) clearTimeout(timer);
    };
  }, [ms, hand]);
  // released, or the selector changed: catch up now
  useEffect(() => {
    if (!paused) hand();
  }, [paused, key, hand]);
  return v;
}

/**
 * True while a finger (or a mouse button) is down on the element given the returned props, and for `after`
 * ms once it lifts or the touch turns into a scroll: a live list holds its order meanwhile, so the row under
 * the finger stays the row that was touched. Spread the props on a wrapper of the list only (not on a sheet's
 * owner: React's events bubble out of portals).
 */
export function useHold(after = 1500) {
  const [held, setHeld] = useState(false);
  const t = useRef<ReturnType<typeof setTimeout>>(undefined);
  const off = useRef<(() => void) | undefined>(undefined);
  const up = useCallback(() => {
    off.current?.();
    off.current = undefined;
    clearTimeout(t.current);
    t.current = setTimeout(() => setHeld(false), after);
  }, [after]);
  // the release is heard on the window too: a mouse let go outside the list, or a pointer the list lost
  const down = useCallback(() => {
    clearTimeout(t.current);
    setHeld(true);
    if (off.current) return;
    window.addEventListener("pointerup", up, true);
    window.addEventListener("pointercancel", up, true);
    off.current = () => {
      window.removeEventListener("pointerup", up, true);
      window.removeEventListener("pointercancel", up, true);
    };
  }, [up]);
  useEffect(
    () => () => {
      off.current?.();
      clearTimeout(t.current);
    },
    [],
  );
  return [held, { onPointerDown: down, onPointerUp: up, onPointerCancel: up }] as const;
}
