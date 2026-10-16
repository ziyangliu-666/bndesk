import { useCallback, useEffect, useRef, useState } from "react";
import { useStore } from "../../store";

type State = ReturnType<typeof useStore.getState>;

// Hand-overs due at the same moment run in one task, so React renders them together: the due times are
// multiples of `ms` on the clock, and one timer serves each.
const due = new Map<number, Set<() => void>>();
function at(ms: number, fn: () => void): () => void {
  const t = Math.ceil((Date.now() + 1) / ms) * ms;
  let fns = due.get(t);
  if (!fns) {
    const set = (fns = new Set());
    due.set(t, set);
    setTimeout(() => {
      due.delete(t);
      set.forEach((f) => f());
    }, t - Date.now());
  }
  fns.add(fn);
  return () => fns.delete(fn);
}

/**
 * A store value for a live list, handed to the page at most once per `ms` (trailing edge; on the clock's
 * multiples of `ms`, together with the page's other live values). Unlike
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
  const hand = useCallback(() => {
    const nv = selRef.current(useStore.getState());
    if (Object.is(nv, shown.current)) return;
    shown.current = nv;
    setV(() => nv);
  }, []);
  useEffect(() => {
    let cancel: (() => void) | undefined;
    const fire = () => {
      cancel = undefined;
      if (!pausedRef.current) hand();
    };
    const off = useStore.subscribe((s) => {
      if (cancel || pausedRef.current || Object.is(selRef.current(s), shown.current)) return;
      cancel = at(ms, fire);
    });
    return () => {
      off();
      cancel?.();
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
