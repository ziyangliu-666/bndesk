import type { Msg } from "./protocol";
import { useStore } from "./store";

/** A binary frame is one raw-DEFLATE JSON message (the Rust server); a text frame is plain JSON. */
async function inflate(buf: ArrayBuffer): Promise<string> {
  const body = new Blob([buf]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
  return new Response(body).text();
}

/** `fn` once the browser has drawn what is queued now and is idle (or after a second at most). */
export function afterPaint(fn: () => void, timeout = 1000) {
  const ric = (window as Window & { requestIdleCallback?: (cb: () => void, o?: { timeout: number }) => number }).requestIdleCallback;
  requestAnimationFrame(() => setTimeout(() => (ric ? ric(fn, { timeout }) : fn()), 0));
}

let kick: (() => void) | null = null;

type Early = { ws: WebSocket; queue: (string | ArrayBuffer)[] };

/** index.html's socket, once, while it is still connecting or open. */
function takeEarly(): Early | null {
  const w = window as Window & { __deskWs?: Early };
  const e = w.__deskWs;
  delete w.__deskWs;
  return e && e.ws.readyState <= WebSocket.OPEN ? e : null;
}

/** Drop the socket and open a fresh one now, skipping any backoff wait. */
export function reconnectNow() {
  kick?.();
}

/** WebSocket client: snapshot on connect, then patch/fills/series; reconnect with backoff. */
export function connect(): () => void {
  const { apply, setConn } = useStore.getState();
  let ws: WebSocket | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let attempt = 0;
  let closed = false;
  let lastMsg = 0;
  // A half-open socket (dead upstream behind a proxy) never fires close; drop it after 10 s of silence.
  const watchdog = setInterval(() => {
    if (ws && ws.readyState === WebSocket.OPEN && Date.now() - lastMsg > 10_000) ws.close();
  }, 2000);

  const url = () => {
    const proto = location.protocol === "https:" ? "wss:" : "ws:";
    return `${proto}//${location.host}/ws`;
  };

  const schedule = () => {
    if (closed) return;
    setConn("reconnecting");
    const base = Math.min(10_000, 500 * 2 ** attempt);
    const delay = base / 2 + Math.random() * (base / 2);
    attempt++;
    timer = setTimeout(open, delay);
    // a closed socket may mean the session ended: go to the login page instead of retrying forever
    fetch("/api/health", { cache: "no-store" })
      .then((r) => {
        if (r.status === 401) location.href = "/login";
      })
      .catch(() => {});
  };

  const open = () => {
    if (closed) return;
    let sock: WebSocket | null = null;
    // the socket index.html opened while the scripts loaded, with what it has received (the first time only)
    const early = takeEarly();
    try {
      ws = early?.ws ?? new WebSocket(url());
      sock = ws;
    } catch {
      schedule();
      return;
    }
    ws.binaryType = "arraybuffer";
    // Inflating is async: messages go through one promise chain so a large binary snapshot is applied
    // before any small text patch behind it. A superseded socket's leftovers are dropped.
    let queue: Promise<void> = Promise.resolve();
    const handle = (text: string) => {
      if (ws !== sock) return;
      let m: Msg;
      try {
        m = JSON.parse(text) as Msg;
      } catch {
        return;
      }
      apply(m);
      // the snapshot holds the first screen; the rest of it (older fills, account points) once it is drawn
      if (m.type === "snapshot") afterPaint(() => ws === sock && sock.readyState === WebSocket.OPEN && sock.send("older"));
    };
    ws.onopen = () => {
      attempt = 0;
      lastMsg = Date.now();
    };
    const onData = (data: string | ArrayBuffer) => {
      lastMsg = Date.now();
      queue = queue
        .then(() => (typeof data === "string" ? data : inflate(data)))
        .then(handle, () => sock?.close()); // undecodable frame: reconnect for a fresh snapshot
    };
    ws.onmessage = (ev) => onData(ev.data as string | ArrayBuffer);
    if (early) {
      if (ws.readyState === WebSocket.OPEN) ws.onopen(new Event("open"));
      early.queue.forEach(onData);
    }
    ws.onclose = () => {
      if (ws !== sock) return; // replaced by reconnectNow
      ws = null;
      schedule();
    };
    // an error is followed by close; closing this socket (not whichever is current by then) makes sure of it
    ws.onerror = () => sock?.close();
  };

  /** A replaced socket says nothing more: no close to schedule a retry, no messages to apply. */
  const drop = (old: WebSocket | null) => {
    if (!old) return;
    old.onopen = old.onmessage = old.onclose = old.onerror = null;
    old.close();
  };

  kick = () => {
    if (closed) return;
    attempt = 0;
    clearTimeout(timer);
    const old = ws;
    ws = null;
    drop(old);
    setConn("reconnecting");
    open();
  };
  // A phone freezes a background tab and its socket may be dead without a close; on return, start over
  // unless messages are still arriving. Same for a page restored from the back-forward cache.
  const onVisible = () => {
    if (document.visibilityState === "visible" && Date.now() - lastMsg > 3000) kick?.();
  };
  const onShow = (e: PageTransitionEvent) => {
    if (e.persisted) kick?.();
  };
  document.addEventListener("visibilitychange", onVisible);
  window.addEventListener("pageshow", onShow);

  open();
  return () => {
    closed = true;
    kick = null;
    clearTimeout(timer);
    clearInterval(watchdog);
    document.removeEventListener("visibilitychange", onVisible);
    window.removeEventListener("pageshow", onShow);
    drop(ws);
    ws = null;
  };
}
