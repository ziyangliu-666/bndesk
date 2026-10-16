// A chart's remembered choices (interval, modes, hidden series), per chart id, on this browser.
import { useCallback, useState } from "react";
import { useStore } from "../../store";

const KEY = (id: string, name: string) => `ex.${id}.${name}`;

function read<T>(id: string, name: string, fallback: T): T {
  try {
    const v = localStorage.getItem(KEY(id, name));
    return v == null ? fallback : (JSON.parse(v) as T);
  } catch {
    return fallback;
  }
}

/**
 * `useState` remembered in localStorage under `ex.<id>.<name>`: a chart's interval, its modes. Without an id it
 * is plain state. `allowed`, when given, guards against a stored value the chart no longer offers.
 *
 *   const [iv, setIv] = useExPref("inst", "interval", "5m", ["1m", "5m", "15m"]);
 */
export function useExPref<T>(id: string | undefined, name: string, fallback: T, allowed?: readonly T[]): [T, (v: T) => void] {
  const [v, setV] = useState<T>(() => {
    const x = id ? read(id, name, fallback) : fallback;
    return allowed && !allowed.includes(x) ? fallback : x;
  });
  const set = useCallback(
    (x: T) => {
      setV(x);
      if (!id) return;
      try {
        localStorage.setItem(KEY(id, name), JSON.stringify(x));
      } catch {
        /* private mode */
      }
    },
    [id, name],
  );
  return [v, set];
}

const NONE: string[] = [];

/**
 * The keys hidden on a chart (series and overlays alike: "vol", "fills", "quotes"), kept in the store's
 * per-chart `hidden` map (persisted as `desk.hidden`). `initial` applies until the user first toggles.
 * ExChart and ChipRow share it when given the same id.
 */
export function useExHidden(id: string, initial: string[] = NONE): { hidden: string[]; toggle: (key: string) => void; isOn: (key: string) => boolean } {
  const stored = useStore((s) => s.hidden["ex." + id]);
  const hidden = stored ?? initial;
  const toggle = useCallback(
    (key: string) => {
      const cur = useStore.getState().hidden["ex." + id] ?? initial;
      useStore.getState().setHidden("ex." + id, cur.includes(key) ? cur.filter((k) => k !== key) : [...cur, key]);
    },
    [id, initial],
  );
  return { hidden, toggle, isOn: (k: string) => !hidden.includes(k) };
}
