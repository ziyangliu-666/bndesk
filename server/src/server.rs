//! HTTP and WebSocket server.
//!
//! The desk runs on a current_thread `LocalSet` with `Rc` state; axum handlers must be `Send`. The bridge:
//! - `Hub` (owned by the desk) encodes each tick's messages once and broadcasts the shared bytes to every
//!   WebSocket task through a `tokio::sync::broadcast` channel; each message carries a sequence number.
//! - Handlers that need the desk itself (`/api/snapshot`, `/api/health`, a new client's snapshot) send a
//!   request over an mpsc channel; `answer` (a local task on the desk side) replies through a oneshot.
//!   A snapshot reply carries the sequence number of the last broadcast before it was encoded, so a new
//!   client skips the messages its snapshot already holds (fills and series are appended client-side).
//! - A WebSocket snapshot is the first screen's: the newest fills, the last minutes of the series (the minute
//!   bars hold the day), the last hour of each account. What it leaves out (`P::Older`, encoded with it) waits
//!   in the client's task until the page asks for it (the text `older`), once it has drawn the snapshot.
//! - axum has no permessage-deflate, so a message of `DEFLATE_MIN` bytes or more is compressed once (raw
//!   DEFLATE, shared by every client) and sent as a binary frame; the browser inflates it with
//!   `DecompressionStream("deflate-raw")`. Smaller messages stay text frames.
use std::net::SocketAddr;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, AtomicUsize, Ordering};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use axum::Router;
use axum::body::{Body, Bytes};
use axum::extract::ws::{Message, Utf8Bytes, WebSocket, WebSocketUpgrade};
use axum::extract::{Request, State};
use axum::http::{HeaderValue, Method, StatusCode, header};
use axum::middleware::{self, Next};
use axum::response::{IntoResponse, Response};
use flate2::Compression;
use flate2::write::DeflateEncoder;
use axum::routing::{any, get, post};
use serde::Serialize;
use serde_json::Value;
use tokio::sync::{broadcast, mpsc, oneshot, watch};
use tower_http::compression::CompressionLayer;
use tower_http::services::ServeFile;

use crate::auth::{self, Auth};
use crate::protocol as P;

pub const PATCH_KEYS: [&str; 11] = [
    "summary", "accounts", "symbols", "exposure", "engines", "alerts", "feeds", "markouts", "orders", "days", "hours",
];
pub const DEV_ORIGINS: [&str; 2] = ["http://localhost:5173", "http://127.0.0.1:5173"];
const SEND_TIMEOUT: Duration = Duration::from_secs(5);
const HEARTBEAT: Duration = Duration::from_secs(30);
const REPLY_TIMEOUT: Duration = Duration::from_secs(10);
const BACKLOG: usize = 256; // broadcast messages a client may fall behind before it is dropped
/// Messages this size or larger go out deflated (binary); smaller ones as text.
pub const DEFLATE_MIN: usize = 1024;
/// zlib-rs level 3: a 135 KB patch deflates to 21% in ~0.8 ms, a 3.4 MB snapshot to 25% in ~19 ms
/// (level 6 saves another 1 point for 1.2x / 2x the time).
const DEFLATE_LEVEL: u32 = 3;

/// `DESK_WEB_DIST`, else `web/dist` of the repository.
pub fn web_dist() -> PathBuf {
    std::env::var_os("DESK_WEB_DIST")
        .map(PathBuf::from)
        .unwrap_or_else(|| Path::new(env!("CARGO_MANIFEST_DIR")).join("..").join("web").join("dist"))
}

fn msg(kind: &str, data: &[u8]) -> Utf8Bytes {
    let mut b = Vec::with_capacity(data.len() + kind.len() + 20);
    b.extend_from_slice(b"{\"type\":\"");
    b.extend_from_slice(kind.as_bytes());
    b.extend_from_slice(b"\",\"data\":");
    b.extend_from_slice(data);
    b.push(b'}');
    Utf8Bytes::try_from(b).expect("JSON is UTF-8")
}

/// Raw DEFLATE (RFC 1951, no zlib/gzip header).
pub fn deflate(data: &[u8]) -> Vec<u8> {
    use std::io::Write;
    let mut e = DeflateEncoder::new(Vec::with_capacity(data.len() / 4 + 64), Compression::new(DEFLATE_LEVEL));
    e.write_all(data).expect("Vec write");
    e.finish().expect("Vec write")
}

/// The WebSocket frame for an encoded message: deflated binary from `DEFLATE_MIN` bytes, else text.
fn frame(m: Utf8Bytes) -> Message {
    if m.len() < DEFLATE_MIN { Message::Text(m) } else { Message::Binary(Bytes::from(deflate(m.as_bytes()))) }
}

/// The view's top-level keys a patch may carry (Python's `View`, minus `agg`), borrowed from the desk.
#[derive(Debug, Clone, Copy, Serialize)]
pub struct Patch<'a> {
    pub now: i64,
    pub summary: &'a P::Summary,
    pub accounts: &'a [P::Account],
    pub symbols: &'a [P::SymbolRow],
    pub exposure: &'a P::Exposure,
    pub engines: &'a [P::Engine],
    pub alerts: &'a [P::Alert],
    pub feeds: &'a [P::Feed],
    pub markouts: &'a P::MarkoutStats,
    pub orders: &'a [P::OpenOrder],
    pub days: &'a [P::DayPnl],
    pub hours: &'a [P::HourPnl],
}

impl<'a> Patch<'a> {
    pub fn of(s: &'a P::Snapshot) -> Patch<'a> {
        Patch {
            now: s.now,
            summary: &s.summary,
            accounts: &s.accounts,
            symbols: &s.symbols,
            exposure: &s.exposure,
            engines: &s.engines,
            alerts: &s.alerts,
            feeds: &s.feeds,
            markouts: &s.markouts,
            orders: &s.orders,
            days: &s.days,
            hours: &s.hours,
        }
    }

    /// PATCH_KEYS[i]'s value as JSON values (exact: from the numbers, not their text).
    fn value(&self, i: usize) -> Value {
        let v = match i {
            0 => serde_json::to_value(self.summary),
            1 => serde_json::to_value(self.accounts),
            2 => serde_json::to_value(self.symbols),
            3 => serde_json::to_value(self.exposure),
            4 => serde_json::to_value(self.engines),
            5 => serde_json::to_value(self.alerts),
            6 => serde_json::to_value(self.feeds),
            7 => serde_json::to_value(self.markouts),
            8 => serde_json::to_value(self.orders),
            9 => serde_json::to_value(self.days),
            _ => serde_json::to_value(self.hours),
        };
        v.expect("protocol types always serialize")
    }

    /// Each PATCH_KEYS value, encoded.
    fn parts(&self) -> [Vec<u8>; 11] {
        [
            P::encode(self.summary), P::encode(self.accounts), P::encode(self.symbols), P::encode(self.exposure),
            P::encode(self.engines), P::encode(self.alerts), P::encode(self.feeds), P::encode(self.markouts),
            P::encode(self.orders), P::encode(self.days), P::encode(self.hours),
        ]
    }
}

/// What `/api/health` needs from the desk; the server adds uptime, clients and the web build.
#[derive(Debug, Clone, Default)]
pub struct DeskHealth {
    pub simulate: bool,
    pub started: f64, // epoch seconds
    pub feeds_up: i64,
    pub feeds: i64,
    pub instruments: i64,
    pub instruments_with_mid: i64,
    pub fills_day: i64,
}

#[derive(Serialize)]
struct Health {
    ok: bool,
    simulate: bool,
    uptime_s: i64,
    feeds_up: i64,
    feeds: i64,
    instruments: i64,
    instruments_with_mid: i64,
    fills_day: i64,
    clients: usize,
    web_build: Option<i64>,
}

/// The desk side of the bridge: called on the desk's thread by `answer`.
pub trait DeskSource {
    /// The WebSocket's snapshot and what it leaves out: `P::encode` of `desk.snapshot_ws()`.
    fn snapshot(&self) -> (Vec<u8>, Vec<u8>);
    /// `P::encode(&desk.snapshot())`: everything (`/api/snapshot`).
    fn snapshot_full(&self) -> Vec<u8>;
    fn health(&self) -> DeskHealth;
}

/// A WebSocket snapshot: the sequence number of the last broadcast before it, its JSON, its `P::Older`'s.
type Snap = (u64, Bytes, Bytes);

pub enum Req {
    Snapshot(oneshot::Sender<Snap>),
    Full(oneshot::Sender<Bytes>),
    Health(oneshot::Sender<DeskHealth>),
}

#[derive(Clone)]
struct Out {
    seq: u64,
    frame: Message,
}

struct Shared {
    tx: broadcast::Sender<Out>,
    seq: AtomicU64,
    clients: AtomicUsize,
    req: mpsc::UnboundedSender<Req>,
    closing: watch::Sender<bool>,
}

impl Shared {
    /// Compresses (if large) once for every client.
    fn broadcast(&self, text: Utf8Bytes) {
        let frame = frame(text);
        let seq = self.seq.fetch_add(1, Ordering::SeqCst) + 1;
        let _ = self.tx.send(Out { seq, frame });
    }

    async fn snapshot(&self) -> Option<Snap> {
        let (tx, rx) = oneshot::channel();
        self.req.send(Req::Snapshot(tx)).ok()?;
        tokio::time::timeout(REPLY_TIMEOUT, rx).await.ok()?.ok()
    }

    async fn snapshot_full(&self) -> Option<Bytes> {
        let (tx, rx) = oneshot::channel();
        self.req.send(Req::Full(tx)).ok()?;
        tokio::time::timeout(REPLY_TIMEOUT, rx).await.ok()?.ok()
    }

    async fn health(&self) -> Option<DeskHealth> {
        let (tx, rx) = oneshot::channel();
        self.req.send(Req::Health(tx)).ok()?;
        tokio::time::timeout(REPLY_TIMEOUT, rx).await.ok()?.ok()
    }
}

/// The desk's end of the request channel; hand it to `answer`.
pub struct Requests {
    rx: mpsc::UnboundedReceiver<Req>,
    shared: Arc<Shared>,
}

/// Serves snapshot and health requests from the desk's thread (spawn_local it). Snapshot requests
/// that arrive together share one encoding.
pub async fn answer<D: DeskSource>(mut r: Requests, desk: D) {
    while let Some(first) = r.rx.recv().await {
        let mut pending = vec![first];
        while let Ok(q) = r.rx.try_recv() {
            pending.push(q);
        }
        let mut snap: Option<Snap> = None;
        for q in pending {
            match q {
                Req::Snapshot(tx) => {
                    let s = snap.get_or_insert_with(|| {
                        let (s, o) = desk.snapshot();
                        (r.shared.seq.load(Ordering::SeqCst), Bytes::from(s), Bytes::from(o))
                    });
                    let _ = tx.send(s.clone());
                }
                Req::Full(tx) => {
                    let _ = tx.send(Bytes::from(desk.snapshot_full()));
                }
                Req::Health(tx) => {
                    let _ = tx.send(desk.health());
                }
            }
        }
    }
}

/// Fans the desk state out to WebSocket clients: a snapshot on connect, then at most one
/// patch / fills / series / account_series / bars message each per tick. A patch holds only the top-level keys
/// that changed: whole, or under `diff` as the rows and fields that changed when that is shorter (an
/// instrument's prices, not the 195 rows of the blotter). Every client's state is the last one broadcast (a
/// snapshot is encoded between ticks from the view the last patch was made of), so the edits fit every client.
pub struct Hub {
    shared: Arc<Shared>,
    requests: Option<Requests>,
    /// each PATCH_KEYS value as last sent: its JSON, and as values for the next one's edits
    last: [Option<(Vec<u8>, Value)>; 11],
    full: bool,
}

impl Default for Hub {
    fn default() -> Self {
        Self::new()
    }
}

impl Hub {
    pub fn new() -> Hub {
        let (tx, _) = broadcast::channel(BACKLOG);
        let (req, rx) = mpsc::unbounded_channel();
        let shared = Arc::new(Shared {
            tx,
            seq: AtomicU64::new(0),
            clients: AtomicUsize::new(0),
            req,
            closing: watch::channel(false).0,
        });
        Hub { requests: Some(Requests { rx, shared: shared.clone() }), shared, last: Default::default(), full: false }
    }

    /// The request channel for `answer` (once).
    pub fn take_requests(&mut self) -> Option<Requests> {
        self.requests.take()
    }

    pub fn clients(&self) -> usize {
        self.shared.clients.load(Ordering::Relaxed)
    }

    /// Next tick sends every client a fresh snapshot (day roll).
    pub fn reset(&mut self) {
        self.last = Default::default();
        self.full = true;
    }

    /// One tick: `snapshot` is called (`P::encode` of `desk.snapshot_ws()`) only after a reset; the snapshot
    /// then goes out with its `older` (every client gets both).
    #[allow(clippy::too_many_arguments)]
    pub fn tick(&mut self, v: &Patch, fills: &[P::Fill], series: &[P::SeriesPoint], acct: &[P::AccountSeries],
                bars: &P::DayBars, snapshot: impl FnOnce() -> (Vec<u8>, Vec<u8>)) {
        if self.clients() == 0 {
            self.last = Default::default();
            return;
        }
        if self.full {
            self.full = false;
            let (s, o) = snapshot();
            self.shared.broadcast(msg("snapshot", &s));
            self.shared.broadcast(msg("older", &o));
            return;
        }
        let mut body: Vec<u8> = Vec::new();
        let mut diff = serde_json::Map::new();
        for (i, b) in v.parts().into_iter().enumerate() {
            if self.last[i].as_ref().is_some_and(|l| l.0 == b) {
                continue;
            }
            let val = v.value(i);
            // the rows or fields that changed, when that is shorter than the whole value
            match self.last[i].as_ref().and_then(|l| edits(&l.1, &val)) {
                Some(e) if P::encode(&e).len() < b.len() => {
                    diff.insert(PATCH_KEYS[i].to_string(), e);
                }
                _ => {
                    body.push(b',');
                    body.push(b'"');
                    body.extend_from_slice(PATCH_KEYS[i].as_bytes());
                    body.extend_from_slice(b"\":");
                    body.extend_from_slice(&b);
                }
            }
            self.last[i] = Some((b, val));
        }
        if !body.is_empty() || !diff.is_empty() {
            let mut p = format!("{{\"now\":{}", v.now).into_bytes();
            p.extend_from_slice(&body);
            if !diff.is_empty() {
                p.extend_from_slice(b",\"diff\":");
                p.extend_from_slice(&P::encode(&diff));
            }
            p.push(b'}');
            self.shared.broadcast(msg("patch", &p));
        }
        if !fills.is_empty() {
            self.shared.broadcast(msg("fills", &P::encode(fills)));
        }
        if !series.is_empty() {
            self.shared.broadcast(msg("series", &P::encode(series)));
        }
        if !acct.is_empty() {
            self.shared.broadcast(msg("account_series", &P::encode(acct)));
        }
        if !bars.is_empty() {
            self.shared.broadcast(msg("bars", &P::encode(bars)));
        }
    }

    pub fn handle(&self) -> HubHandle {
        HubHandle(self.shared.clone())
    }
}

/// What turns `old` into `new` for a patch's `diff`: an object's changed fields, or `[index, changed fields]` for each
/// changed row of an array of objects that kept its length. None when it must go whole: another shape, a row
/// count or a field set that changed.
fn edits(old: &Value, new: &Value) -> Option<Value> {
    fn fields(a: &serde_json::Map<String, Value>, b: &serde_json::Map<String, Value>) -> Option<Value> {
        if a.len() != b.len() {
            return None;
        }
        let mut out = serde_json::Map::new();
        for (k, v) in b {
            match a.get(k) {
                Some(x) if x == v => {}
                Some(_) => {
                    out.insert(k.clone(), v.clone());
                }
                None => return None,
            }
        }
        Some(Value::Object(out))
    }
    match (old, new) {
        (Value::Object(a), Value::Object(b)) => fields(a, b),
        (Value::Array(a), Value::Array(b)) if a.len() == b.len() => {
            let mut out = vec![];
            for (i, (x, y)) in a.iter().zip(b).enumerate() {
                if x == y {
                    continue;
                }
                let (Value::Object(x), Value::Object(y)) = (x, y) else { return None };
                out.push(Value::Array(vec![i.into(), fields(x, y)?]));
            }
            Some(Value::Array(out))
        }
        _ => None,
    }
}

/// The `Send` side of the hub, for the HTTP app.
#[derive(Clone)]
pub struct HubHandle(Arc<Shared>);

async fn client(shared: Arc<Shared>, mut ws: WebSocket) {
    let mut rx = shared.tx.subscribe(); // before the snapshot, so nothing between falls through
    let mut closing = shared.closing.subscribe();
    let Some((seq0, snap, older)) = shared.snapshot().await else { return };
    // deflating a snapshot takes a few ms: off the desk's thread
    let Ok(first) = tokio::task::spawn_blocking(move || frame(msg("snapshot", &snap))).await else { return };
    if !matches!(tokio::time::timeout(SEND_TIMEOUT, ws.send(first)).await, Ok(Ok(()))) {
        return;
    }
    // sent when the page asks (it has drawn the snapshot by then); it holds the snapshot's state, which the page
    // merges under whatever came since (fills it has not got, account points before its first)
    let mut older = Some(older);
    shared.clients.fetch_add(1, Ordering::Relaxed);
    let mut ping = tokio::time::interval_at(tokio::time::Instant::now() + HEARTBEAT, HEARTBEAT);
    let mut pong = true;
    loop {
        tokio::select! {
            m = rx.recv() => match m {
                Ok(o) if o.seq <= seq0 => {}
                Ok(o) => {
                    if !matches!(tokio::time::timeout(SEND_TIMEOUT, ws.send(o.frame)).await, Ok(Ok(()))) {
                        break;
                    }
                }
                Err(_) => break, // lagged (missed messages: it reconnects for a snapshot) or closed
            },
            m = ws.recv() => match m {
                Some(Ok(Message::Pong(_))) => pong = true,
                Some(Ok(Message::Text(t))) if t.as_str() == "older" => {
                    let Some(o) = older.take() else { continue };
                    let Ok(f) = tokio::task::spawn_blocking(move || frame(msg("older", &o))).await else { break };
                    if !matches!(tokio::time::timeout(SEND_TIMEOUT, ws.send(f)).await, Ok(Ok(()))) {
                        break;
                    }
                }
                Some(Ok(Message::Close(_))) | Some(Err(_)) | None => break,
                Some(Ok(_)) => {}
            },
            _ = ping.tick() => {
                if !pong {
                    break;
                }
                pong = false;
                if !matches!(tokio::time::timeout(SEND_TIMEOUT, ws.send(Message::Ping(Bytes::new()))).await, Ok(Ok(()))) {
                    break;
                }
            }
            _ = closing.changed() => break,
        }
    }
    shared.clients.fetch_sub(1, Ordering::Relaxed);
    let _ = tokio::time::timeout(Duration::from_secs(1), ws.send(Message::Close(None))).await;
}

#[derive(Clone)]
struct AppState {
    shared: Arc<Shared>,
    web_dist: Arc<PathBuf>,
}

fn json(body: Vec<u8>, ct: &'static str) -> Response {
    ([(header::CONTENT_TYPE, ct)], body).into_response()
}

fn unavailable() -> Response {
    (StatusCode::SERVICE_UNAVAILABLE, "desk not ready").into_response()
}

async fn ws_handler(State(st): State<AppState>, up: WebSocketUpgrade) -> Response {
    up.on_upgrade(move |ws| client(st.shared, ws))
}

async fn snapshot(State(st): State<AppState>) -> Response {
    match st.shared.snapshot_full().await {
        Some(b) => ([(header::CONTENT_TYPE, "application/json")], b).into_response(),
        None => unavailable(),
    }
}

fn epoch_s() -> f64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map_or(0.0, |d| d.as_secs_f64())
}

async fn health(State(st): State<AppState>) -> Response {
    let Some(d) = st.shared.health().await else { return unavailable() };
    let web_build = match tokio::fs::metadata(st.web_dist.join("index.html")).await {
        Ok(m) if m.is_file() => m
            .modified()
            .ok()
            .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
            .map(|d| d.as_secs() as i64),
        _ => None,
    };
    let body = Health {
        ok: true,
        simulate: d.simulate,
        uptime_s: (epoch_s() - d.started).round_ties_even() as i64,
        feeds_up: d.feeds_up,
        feeds: d.feeds,
        instruments: d.instruments,
        instruments_with_mid: d.instruments_with_mid,
        fills_day: d.fills_day,
        clients: st.shared.clients.load(Ordering::Relaxed),
        web_build,
    };
    json(serde_json::to_vec(&body).expect("health serializes"), "application/json; charset=utf-8")
}

async fn healthz() -> &'static str {
    "ok"
}

async fn serve_file(path: PathBuf, req: Request) -> Response {
    match ServeFile::new(path).precompressed_br().precompressed_gzip().try_call(req).await {
        Ok(r) => r.map(Body::new),
        Err(e) => (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()).into_response(),
    }
}

/// A file under web/dist, else index.html (client-side routes), else a hint.
async fn spa(State(st): State<AppState>, req: Request) -> Response {
    if req.method() != Method::GET && req.method() != Method::HEAD {
        return (StatusCode::METHOD_NOT_ALLOWED, "405: Method Not Allowed").into_response();
    }
    let raw = req.uri().path().trim_start_matches('/');
    let rel = urlencoding::decode(raw).map(|c| c.into_owned()).unwrap_or_else(|_| raw.to_string());
    let dist = st.web_dist.as_path();
    if !rel.is_empty()
        && let Ok(f) = tokio::fs::canonicalize(dist.join(&rel)).await
        && let Ok(root) = tokio::fs::canonicalize(dist).await
        && f != root
        && f.starts_with(&root)
        && tokio::fs::metadata(&f).await.is_ok_and(|m| m.is_file())
    {
        return serve_file(f, req).await;
    }
    let index = dist.join("index.html");
    if tokio::fs::metadata(&index).await.is_ok_and(|m| m.is_file()) {
        let mut r = serve_file(index, req).await;
        r.headers_mut().insert(header::CACHE_CONTROL, HeaderValue::from_static("no-cache"));
        return r;
    }
    "desk API: /api/snapshot, /api/health, /api/history, /api/fills, /api/klines, /ws (web/dist not built)\n".into_response()
}

/// Dev server CORS (only without auth).
async fn cors(req: Request, next: Next) -> Response {
    let origin = req.headers().get(header::ORIGIN).cloned();
    let mut resp = if req.method() == Method::OPTIONS { Response::new(Body::empty()) } else { next.run(req).await };
    if let Some(o) = origin
        && DEV_ORIGINS.iter().any(|d| o.as_bytes() == d.as_bytes())
        && resp.status() != StatusCode::SWITCHING_PROTOCOLS
    {
        let h = resp.headers_mut();
        h.insert(header::ACCESS_CONTROL_ALLOW_ORIGIN, o);
        h.insert(header::ACCESS_CONTROL_ALLOW_METHODS, HeaderValue::from_static("GET, OPTIONS"));
        h.insert(header::ACCESS_CONTROL_ALLOW_HEADERS, HeaderValue::from_static("Content-Type"));
    }
    resp
}

/// `history`: the read-only `/api/history`, `/api/fills`, `/api/klines` (behind auth like the rest).
pub fn make_app(hub: &HubHandle, auth: Option<Auth>, web_dist: PathBuf, history: Arc<crate::history::Api>) -> Router {
    let st = AppState { shared: hub.0.clone(), web_dist: Arc::new(web_dist) };
    // gzip for HTTP; the WebSocket deflates its large messages itself (`frame`)
    let http = Router::new()
        .route("/healthz", get(healthz))
        .route("/api/snapshot", get(snapshot))
        .route("/api/health", get(health))
        .fallback(spa)
        .with_state(st.clone())
        .merge(crate::history::routes(history))
        .layer(CompressionLayer::new());
    let mut app = Router::new().route("/ws", get(ws_handler)).with_state(st).merge(http);
    match auth {
        Some(a) => {
            app = app
                .merge(Router::new()
                    .route("/login", any(auth::login))
                    .route("/logout", post(auth::logout))
                    .with_state(a.clone()))
                .layer(middleware::from_fn_with_state(a, auth::middleware));
        }
        None => app = app.layer(middleware::from_fn(cors)),
    }
    app.layer(middleware::from_fn(auth::security_headers))
}

/// A running HTTP server; `cleanup` stops it without waiting on open dashboards.
pub struct Server {
    pub addr: SocketAddr,
    shared: Arc<Shared>,
    stop: oneshot::Sender<()>,
    task: tokio::task::JoinHandle<std::io::Result<()>>,
}

impl Server {
    pub async fn cleanup(self) {
        let _ = self.shared.closing.send(true);
        let _ = self.stop.send(());
        let mut task = self.task;
        if tokio::time::timeout(Duration::from_secs(2), &mut task).await.is_err() {
            task.abort();
        }
    }
}

/// Binds `listen` ("host:port", "[v6]:port", ":port" = 127.0.0.1) and serves `app` on a spawned task.
pub async fn serve(hub: &HubHandle, app: Router, listen: &str) -> std::io::Result<Server> {
    let (host, port) = listen.rsplit_once(':').unwrap_or(("", listen));
    let host = host.trim_matches(|c| c == '[' || c == ']');
    let host = if host.is_empty() { "127.0.0.1" } else { host };
    let port: u16 = port.parse().map_err(|_| std::io::Error::other(format!("bad listen address {listen:?}")))?;
    let listener = tokio::net::TcpListener::bind((host, port)).await?;
    let addr = listener.local_addr()?;
    let (stop, stopped) = oneshot::channel::<()>();
    let task = tokio::spawn(async move {
        axum::serve(listener, app.into_make_service_with_connect_info::<SocketAddr>())
            .with_graceful_shutdown(async move {
                let _ = stopped.await;
            })
            .await
    });
    Ok(Server { addr, shared: hub.0.clone(), stop, task })
}

#[cfg(test)]
mod tests {
    use super::*;
    use futures_util::{SinkExt, StreamExt};
    use std::collections::HashSet;

    #[test]
    fn test_patch_keys_cover_snapshot() {
        let a: HashSet<&str> = PATCH_KEYS.into_iter().collect();
        let skip = ["now", "fills", "series", "account_series", "bars"];
        let b: HashSet<&str> = P::SNAPSHOT_KEYS.into_iter().filter(|k| !skip.contains(k)).collect();
        assert_eq!(a, b);
        // Patch's fields are "now" then PATCH_KEYS, in order
        let s = P::Snapshot::default();
        let v = serde_json::to_value(Patch::of(&s)).unwrap();
        let keys: Vec<&str> = v.as_object().unwrap().keys().map(String::as_str).collect();
        let mut want = vec!["now"];
        want.extend(PATCH_KEYS);
        let mut keys_sorted = keys.clone();
        keys_sorted.sort();
        want.sort();
        assert_eq!(keys_sorted, want);
    }

    fn inflate(b: &[u8]) -> String {
        use std::io::Read;
        let mut s = String::new();
        flate2::read::DeflateDecoder::new(b).read_to_string(&mut s).unwrap();
        s
    }

    fn text(m: &Message) -> String {
        match m {
            Message::Text(t) => t.to_string(),
            Message::Binary(b) => inflate(b),
            m => panic!("unexpected frame {m:?}"),
        }
    }

    fn drain(rx: &mut broadcast::Receiver<Out>) -> Vec<String> {
        let mut out = vec![];
        while let Ok(o) = rx.try_recv() {
            out.push(text(&o.frame));
        }
        out
    }

    #[test]
    fn large_messages_go_deflated_once() {
        let hub = Hub::new();
        let mut rx1 = hub.shared.tx.subscribe();
        let mut rx2 = hub.shared.tx.subscribe();
        let small = msg("fills", b"[]");
        hub.shared.broadcast(small.clone());
        let rows: Vec<String> = (0..2000).map(|i| format!("{{\"symbol\":\"S{i}\",\"mid\":{}.25}}", i * 7)).collect();
        let big = msg("patch", format!("{{\"now\":1,\"symbols\":[{}]}}", rows.join(",")).as_bytes());
        assert!(big.len() >= DEFLATE_MIN);
        hub.shared.broadcast(big.clone());
        let (a, b) = (rx1.try_recv().unwrap(), rx1.try_recv().unwrap());
        assert!(matches!(&a.frame, Message::Text(t) if *t == small));
        let Message::Binary(z) = &b.frame else { panic!("big message not binary") };
        assert!(z.len() * 4 < big.len());
        assert_eq!(inflate(z), big.as_str());
        let v: serde_json::Value = serde_json::from_str(&inflate(z)).unwrap();
        assert_eq!(v["data"]["symbols"][1999]["symbol"], "S1999");
        // every receiver gets the same compressed buffer
        rx2.try_recv().unwrap();
        let Message::Binary(z2) = rx2.try_recv().unwrap().frame else { panic!() };
        assert_eq!(z2.as_ptr(), z.as_ptr());
    }

    #[test]
    fn tick_sends_changed_keys_only() {
        let mut hub = Hub::new();
        let mut rx = hub.shared.tx.subscribe();
        let mut s = P::Snapshot::default();
        let nb = P::DayBars::default();
        hub.tick(&Patch::of(&s), &[], &[], &[], &nb, || unreachable!());
        assert!(drain(&mut rx).is_empty()); // no clients
        hub.shared.clients.store(1, Ordering::Relaxed);
        hub.tick(&Patch::of(&s), &[], &[], &[], &nb, || unreachable!());
        let m = drain(&mut rx);
        assert_eq!(m.len(), 1);
        let v: serde_json::Value = serde_json::from_str(&m[0]).unwrap();
        assert_eq!(v["type"], "patch");
        assert_eq!(v["data"].as_object().unwrap().len(), 12);
        s.now = 5;
        hub.tick(&Patch::of(&s), &[], &[], &[], &nb, || unreachable!());
        assert!(drain(&mut rx).is_empty()); // only "now" moved
        s.summary.equity = 2.5;
        let f = P::Fill { id: "f".into(), ..Default::default() };
        hub.tick(&Patch::of(&s), std::slice::from_ref(&f), &[], &[], &nb, || unreachable!());
        let m = drain(&mut rx);
        assert_eq!(m.len(), 2);
        let v: serde_json::Value = serde_json::from_str(&m[0]).unwrap();
        let keys: Vec<&String> = v["data"].as_object().unwrap().keys().collect();
        assert_eq!(keys, ["diff", "now"]); // the one field that changed
        assert_eq!(v["data"]["diff"], serde_json::json!({"summary": {"equity": 2.5}}));
        assert_eq!(v["data"]["now"], 5);
        assert!(m[1].starts_with("{\"type\":\"fills\",\"data\":[{\"id\":\"f\""));
        let bars = P::DayBars { t: vec![60_000], volume: vec![2.5], ..Default::default() };
        hub.tick(&Patch::of(&s), &[], &[], &[], &bars, || unreachable!());
        assert_eq!(drain(&mut rx), [r#"{"type":"bars","data":{"t":[60000],"equity":[],"pnl_day":[],"trading":[],"mm":[],"hedge":[],"inventory":[],"futures":[],"volume":[2.5]}}"#]);
        hub.reset();
        hub.tick(&Patch::of(&s), &[f], &[], &[], &nb, || (b"{\"x\":1}".to_vec(), b"{\"y\":2}".to_vec()));
        assert_eq!(drain(&mut rx), ["{\"type\":\"snapshot\",\"data\":{\"x\":1}}", "{\"type\":\"older\",\"data\":{\"y\":2}}"]);
    }

    #[test]
    fn patch_sends_changed_rows_and_fields() {
        let mut hub = Hub::new();
        let mut rx = hub.shared.tx.subscribe();
        hub.shared.clients.store(1, Ordering::Relaxed);
        let nb = P::DayBars::default();
        let row = |s: &str, mid: f64| P::SymbolRow { symbol: s.into(), mid: Some(mid), ..Default::default() };
        let mut s = P::Snapshot { symbols: (0..20).map(|i| row(&format!("S{i}"), i as f64)).collect(), ..Default::default() };
        hub.tick(&Patch::of(&s), &[], &[], &[], &nb, || unreachable!());
        drain(&mut rx);
        s.symbols[3].mid = Some(3.5);
        s.symbols[3].bid = Some(3.4);
        s.symbols[7].mid = None;
        s.summary.equity = 2.5;
        hub.tick(&Patch::of(&s), &[], &[], &[], &nb, || unreachable!());
        let m = drain(&mut rx);
        let v: serde_json::Value = serde_json::from_str(&m[0]).unwrap();
        assert_eq!(v["data"]["diff"]["symbols"], serde_json::json!([[3, {"mid": 3.5, "bid": 3.4}], [7, {"mid": null}]]));
        assert_eq!(v["data"]["diff"]["summary"], serde_json::json!({"equity": 2.5}));
        assert!(v["data"].get("symbols").is_none());
        // a row more: the whole list
        s.symbols.push(row("S20", 20.0));
        hub.tick(&Patch::of(&s), &[], &[], &[], &nb, || unreachable!());
        let v: serde_json::Value = serde_json::from_str(&drain(&mut rx)[0]).unwrap();
        assert_eq!(v["data"]["symbols"].as_array().unwrap().len(), 21);
        assert!(v["data"].get("diff").is_none());
        // every row changed: whole again (the edits would be longer)
        for r in &mut s.symbols {
            r.mid = Some(-1.0);
        }
        hub.tick(&Patch::of(&s), &[], &[], &[], &nb, || unreachable!());
        let v: serde_json::Value = serde_json::from_str(&drain(&mut rx)[0]).unwrap();
        assert!(v["data"]["symbols"].is_array() || v["data"]["diff"]["symbols"].is_array());
    }

    struct Fake(std::rc::Rc<std::cell::Cell<i64>>);

    impl DeskSource for Fake {
        fn snapshot(&self) -> (Vec<u8>, Vec<u8>) {
            (format!("{{\"n\":{}}}", self.0.get()).into_bytes(), b"{\"o\":1}".to_vec())
        }
        fn snapshot_full(&self) -> Vec<u8> {
            format!("{{\"full\":{}}}", self.0.get()).into_bytes()
        }
        fn health(&self) -> DeskHealth {
            DeskHealth { feeds: 3, started: epoch_s() - 10.0, ..Default::default() }
        }
    }

    #[tokio::test(flavor = "current_thread")]
    async fn serves_ws_and_http() {
        let local = tokio::task::LocalSet::new();
        local
            .run_until(async {
                let dir = tempfile::tempdir().unwrap();
                std::fs::write(dir.path().join("index.html"), "<html>").unwrap();
                std::fs::create_dir(dir.path().join("assets")).unwrap();
                std::fs::write(dir.path().join("assets/a.js"), "js").unwrap();
                let mut hub = Hub::new();
                let n = std::rc::Rc::new(std::cell::Cell::new(1));
                tokio::task::spawn_local(answer(hub.take_requests().unwrap(), Fake(n.clone())));
                let h = hub.handle();
                let srv = serve(&h, make_app(&h, None, dir.path().to_path_buf(), crate::history::Api::new(dir.path().join("d.db"), 0)), "127.0.0.1:0").await.unwrap();
                let base = format!("http://{}", srv.addr);
                let get = |p: &str| reqwest::get(format!("{base}{p}"));
                assert_eq!(get("/healthz").await.unwrap().text().await.unwrap(), "ok");
                assert_eq!(get("/api/snapshot").await.unwrap().text().await.unwrap(), "{\"full\":1}");
                let r = get("/assets/a.js").await.unwrap();
                assert_eq!(r.headers()["x-frame-options"], "DENY");
                assert_eq!(r.text().await.unwrap(), "js");
                let r = get("/some/route").await.unwrap();
                assert_eq!(r.headers()["cache-control"], "no-cache");
                assert_eq!(r.text().await.unwrap(), "<html>");
                assert_eq!(get("/../../etc/passwd").await.unwrap().text().await.unwrap(), "<html>");
                assert_eq!(get("/assets%2f..%2f..%2f..%2fetc%2fpasswd").await.unwrap().text().await.unwrap(), "<html>");
                let c = reqwest::Client::new();
                assert_eq!(c.post(format!("{base}/x")).send().await.unwrap().status(), 405);
                let r = c.request(Method::OPTIONS, format!("{base}/api/snapshot"))
                    .header("Origin", "http://localhost:5173").send().await.unwrap();
                assert_eq!(r.headers()["access-control-allow-origin"], "http://localhost:5173");

                let (mut ws, _) = tokio_tungstenite::connect_async(format!("ws://{}/ws", srv.addr)).await.unwrap();
                let m = ws.next().await.unwrap().unwrap();
                assert_eq!(m.to_text().unwrap(), "{\"type\":\"snapshot\",\"data\":{\"n\":1}}"); // small: text
                while hub.clients() == 0 {
                    tokio::time::sleep(Duration::from_millis(5)).await;
                }
                let s = P::Snapshot::default();
                hub.tick(&Patch::of(&s), &[], &[], &[], &P::DayBars::default(), || unreachable!());
                let m = ws.next().await.unwrap().unwrap();
                assert!(m.is_binary()); // a full patch is over DEFLATE_MIN
                assert!(inflate(&m.into_data()).starts_with("{\"type\":\"patch\",\"data\":{\"now\":0,\"summary\":"));
                // what the snapshot left out, once asked for
                ws.send(tokio_tungstenite::tungstenite::Message::text("older")).await.unwrap();
                let m = ws.next().await.unwrap().unwrap();
                assert_eq!(m.to_text().unwrap(), "{\"type\":\"older\",\"data\":{\"o\":1}}");
                let hv: serde_json::Value = get("/api/health").await.unwrap().json().await.unwrap();
                assert_eq!(hv["clients"], 1);
                assert_eq!(hv["feeds"], 3);
                assert_eq!(hv["uptime_s"], 10);
                assert!(hv["web_build"].is_i64());
                ws.close(None).await.unwrap();
                srv.cleanup().await;
            })
            .await;
    }

    #[tokio::test(flavor = "current_thread")]
    async fn auth_guards_routes() {
        let dir = tempfile::tempdir().unwrap();
        let auth = Auth::new(&auth::hash_password("pw"), &dir.path().join("d.db")).unwrap();
        let hub = Hub::new();
        let h = hub.handle();
        let srv = serve(&h, make_app(&h, Some(auth), dir.path().to_path_buf(),
                                       crate::history::Api::new(dir.path().join("d.db"), 0)), "127.0.0.1:0").await.unwrap();
        let c = reqwest::Client::builder().redirect(reqwest::redirect::Policy::none()).build().unwrap();
        let base = format!("http://{}", srv.addr);
        assert_eq!(c.get(format!("{base}/healthz")).send().await.unwrap().status(), 200);
        assert_eq!(c.get(format!("{base}/api/snapshot")).send().await.unwrap().status(), 401);
        for p in ["/api/history", "/api/fills", "/api/klines?symbol=BTCUSDT"] {
            assert_eq!(c.get(format!("{base}{p}")).send().await.unwrap().status(), 401, "{p}");
        }
        let r = c.get(format!("{base}/")).send().await.unwrap();
        assert_eq!((r.status().as_u16(), &r.headers()["location"]), (303, &"/login".parse::<HeaderValue>().unwrap()));
        assert_eq!(c.get(format!("{base}/login")).send().await.unwrap().status(), 200);
        srv.cleanup().await;
    }
}
