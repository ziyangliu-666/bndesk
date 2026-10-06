import type { Msg } from "./protocol";
import { useStore } from "./store";

/** A binary frame is one raw-DEFLATE JSON message (the Rust server); a text frame is plain JSON. */
async function inflate(buf: ArrayBuffer): Promise<string> {
  const body = new Blob([buf]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
  return new Response(body).text();
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
    try {
      ws = new WebSocket(url());
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
    };
    ws.onopen = () => {
      attempt = 0;
      lastMsg = Date.now();
    };
    ws.onmessage = (ev) => {
      lastMsg = Date.now();
      const data = ev.data as string | ArrayBuffer;
      queue = queue
        .then(() => (typeof data === "string" ? data : inflate(data)))
        .then(handle, () => sock?.close()); // undecodable frame: reconnect for a fresh snapshot
    };
    ws.onclose = () => {
      if (ws === sock) ws = null;
      schedule();
    };
    ws.onerror = () => {
      ws?.close();
    };
  };

  open();
  return () => {
    closed = true;
    clearTimeout(timer);
    clearInterval(watchdog);
    ws?.close();
  };
}
