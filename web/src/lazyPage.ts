import { lazy, useEffect, useReducer, useState, type ComponentType, type LazyExoticComponent } from "react";

export type LazyPage<P> = LazyExoticComponent<ComponentType<P>> & {
  preload: () => Promise<unknown>;
  /** Loaded, or its last load failed (a render then tries again and the page's boundary shows the error). */
  settled: () => boolean;
};

/**
 * React.lazy whose chunk can be fetched ahead (`preload`). Once it has loaded, the first render takes the module
 * as it is, without suspending: React.lazy otherwise suspends once on a component's first render even when its
 * chunk is already there, and a Suspense boundary then shows its fallback for a frame or more.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function lazyPage<P = object>(load: () => Promise<{ default: ComponentType<any> }>): LazyPage<P> {
  let mod: { default: ComponentType<P> } | null = null;
  let failed = false;
  let pending: Promise<{ default: ComponentType<P> }> | null = null;
  const preload = () =>
    (pending ??= load().then(
      (m) => (mod = m),
      (e: unknown) => {
        pending = null; // a failed chunk is tried again on the next render (LoadBoundary reloads for a deploy)
        failed = true;
        throw e;
      },
    ));
  // a thenable that calls back at once: React.lazy reads it as resolved on the spot
  const C = lazy(() => (mod ? ({ then: (ok: (m: { default: ComponentType<P> }) => void) => ok(mod!) } as unknown as Promise<{ default: ComponentType<P> }>) : preload()));
  return Object.assign(C, { preload, settled: () => mod != null || failed });
}

/**
 * True once the page shown first has its chunk. The shell holds the page back until then rather than let it
 * suspend: a suspended page is retried at a low priority that a stream of store updates can put off for seconds
 * on a slow phone. Later pages are fetched ahead (preloadIdle) and switch under Suspense.
 */
export function useFirstPage(page: { preload: () => Promise<unknown>; settled: () => boolean }): boolean {
  const [first] = useState(() => page);
  const [, bump] = useReducer((x: number) => x + 1, 0);
  const ok = first.settled();
  useEffect(() => {
    if (ok) return;
    let live = true;
    void first
      .preload()
      .catch(() => {})
      .then(() => live && bump());
    return () => {
      live = false;
    };
  }, [first, ok]);
  return ok;
}

/** Fetch the chunks once the browser has drawn and is idle. */
export function preloadIdle(pages: { preload: () => Promise<unknown> }[]) {
  const w = window as Window & { requestIdleCallback?: (cb: () => void, o?: { timeout: number }) => number };
  const all = () => pages.forEach((p) => void p.preload().catch(() => {}));
  requestAnimationFrame(() => setTimeout(() => (w.requestIdleCallback ? w.requestIdleCallback(all, { timeout: 2000 }) : all()), 0));
}
