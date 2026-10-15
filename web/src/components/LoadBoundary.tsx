import { Component, type ReactNode } from "react";

// After a deploy, an open tab still asks for the old build's page chunks, which are gone: the import fails.
// The page reloads once to pick up the new build; if that does not help (or it was something else), one calm
// line with a Reload button instead of a blank page.

const RELOADED = "bndesk-chunk-reload";
/** A reload for a failed chunk within this long of the last one is a loop: show the line instead. */
const GUARD_MS = 60_000;

/** A failed dynamic import or preload (the wordings of Chrome, Safari, Firefox and Vite). */
export function isChunkError(e: unknown): boolean {
  const msg = e instanceof Error ? `${e.name} ${e.message}` : String(e);
  return /dynamically imported module|Importing a module script failed|module script|Unable to preload CSS|ChunkLoadError|Loading (CSS )?chunk/i.test(
    msg,
  );
}

/** Reload the page for a failed chunk, once: false when it was already tried a moment ago. */
export function reloadOnce(): boolean {
  try {
    const last = Number(sessionStorage.getItem(RELOADED) ?? 0);
    if (Date.now() - last < GUARD_MS) return false;
    sessionStorage.setItem(RELOADED, String(Date.now()));
  } catch {
    return false; // no storage, no guard: never reload on our own
  }
  location.reload();
  return true;
}

export function reloadNow() {
  try {
    sessionStorage.removeItem(RELOADED);
  } catch {
    /* ignore */
  }
  location.reload();
}

/** Around a page's Suspense: a page that fails to load or render shows one line with Reload, not a blank. */
export class LoadBoundary extends Component<{ phone?: boolean; children: ReactNode }, { error: unknown; reloading: boolean }> {
  state = { error: null as unknown, reloading: false };

  static getDerivedStateFromError(error: unknown) {
    return { error };
  }

  componentDidCatch(error: unknown) {
    if (isChunkError(error) && reloadOnce()) this.setState({ reloading: true });
  }

  render() {
    const { error, reloading } = this.state;
    if (error == null) return this.props.children;
    const phone = this.props.phone;
    if (reloading) return <div className={phone ? "m-load-error" : "load-error"}>Loading the new version</div>;
    return (
      <div className={phone ? "m-load-error" : "load-error"} role="alert">
        <span>{isChunkError(error) ? "This page could not be loaded." : "This page could not be shown."}</span>
        <button type="button" onClick={reloadNow}>
          Reload
        </button>
      </div>
    );
  }
}
