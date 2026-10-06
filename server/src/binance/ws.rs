//! WebSocket clients: public streams and user data.
use std::borrow::Cow;
use std::cell::RefCell;
use std::collections::HashSet;
use std::rc::Rc;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, Instant};

use futures_util::{SinkExt, StreamExt};
use serde::{Deserialize, Serialize};
use tokio::net::TcpStream;
use tokio::sync::mpsc;
use tokio::task::JoinHandle;
use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::tungstenite::protocol::WebSocketConfig;
use tokio_tungstenite::{MaybeTlsStream, WebSocketStream};

use crate::feeds::{Feed, FeedKind, FeedRef};

pub const SPOT_STREAM: &str = "wss://stream.binance.com:9443/stream";
pub const USDM_PUBLIC: &str = "wss://fstream.binance.com/public/stream";
pub const USDM_MARKET: &str = "wss://fstream.binance.com/market/stream";
pub const USDM_PRIVATE: &str = "wss://fstream.binance.com/private/ws/";
pub const WS_API: &str = "wss://ws-api.binance.com:443/ws-api/v3";

const HEARTBEAT: Duration = Duration::from_secs(30);
const CONNECT_TIMEOUT: Duration = Duration::from_secs(15);
const CLOSE_TIMEOUT: Duration = Duration::from_secs(10);

/// `on_data(stream, raw data JSON)` of a `StreamMux`.
pub type OnData = Rc<dyn Fn(&str, &str)>;

pub type WsStream = WebSocketStream<MaybeTlsStream<TcpStream>>;

/// Sends on a live connection from anywhere (queued, written by the connection's task); `close()`
/// ends the connection, which `run_ws` then reconnects.
#[derive(Clone, Debug)]
pub struct WsHandle {
    tx: mpsc::UnboundedSender<Message>,
}

impl WsHandle {
    pub fn send_text(&self, s: String) -> bool {
        self.tx.send(Message::text(s)).is_ok()
    }

    pub fn send_json<T: Serialize + ?Sized>(&self, v: &T) -> bool {
        self.send_text(serde_json::to_string(v).expect("json"))
    }

    pub fn close(&self) {
        let _ = self.tx.send(Message::Close(None));
    }

    /// The connection this handle wrote to has ended.
    pub fn is_closed(&self) -> bool {
        self.tx.is_closed()
    }
}

/// The connection as `on_open` sees it: it can send, and receive before the read loop starts
/// (e.g. wait for the `session.logon` reply).
pub struct WsConn {
    ws: WsStream,
    handle: WsHandle,
    rx: mpsc::UnboundedReceiver<Message>,
}

impl WsConn {
    pub fn handle(&self) -> WsHandle {
        self.handle.clone()
    }

    pub async fn send_text(&mut self, s: String) -> anyhow::Result<()> {
        self.ws.send(Message::text(s)).await?;
        Ok(())
    }

    pub async fn send_json<T: Serialize + ?Sized>(&mut self, v: &T) -> anyhow::Result<()> {
        self.send_text(serde_json::to_string(v)?).await
    }

    /// Next text message (control frames are handled and skipped); an error once the connection ends.
    pub async fn recv_text(&mut self) -> anyhow::Result<String> {
        while let Some(m) = self.ws.next().await {
            match m? {
                Message::Text(t) => return Ok(t.as_str().to_owned()),
                Message::Close(f) => anyhow::bail!("closed ({})", f.map_or(0, |f| u16::from(f.code))),
                _ => {}
            }
        }
        anyhow::bail!("closed")
    }
}

fn short(e: impl std::fmt::Display) -> String {
    let s = e.to_string();
    s.chars().take(200).collect()
}

/// Marks the feed stopped when the task running `run_ws` is cancelled (dropped).
struct Stopped(FeedRef);

impl Drop for Stopped {
    fn drop(&mut self) {
        if let Ok(mut f) = self.0.try_borrow_mut() {
            f.set_up(false, Some("stopped"));
        }
    }
}

pub async fn connect(url: &str) -> anyhow::Result<WsStream> {
    let cfg = WebSocketConfig::default().max_message_size(None).max_frame_size(None);
    let (ws, _) = tokio::time::timeout(CONNECT_TIMEOUT, tokio_tungstenite::connect_async_with_config(url, Some(cfg), true))
        .await
        .map_err(|_| anyhow::anyhow!("connect timeout"))??;
    Ok(ws)
}

/// Read one connection until it ends: Ok(close code) on a close, Err on an error.
async fn read_loop(conn: &mut WsConn, feed: &FeedRef, on_msg: &mut impl FnMut(&str)) -> anyhow::Result<u16> {
    let mut ping = tokio::time::interval_at(tokio::time::Instant::now() + HEARTBEAT, HEARTBEAT);
    let mut last_rx = Instant::now();
    loop {
        tokio::select! {
            m = conn.ws.next() => {
                last_rx = Instant::now();
                match m {
                    Some(Ok(Message::Text(t))) => {
                        feed.borrow_mut().hit(1);
                        on_msg(t.as_str());
                    }
                    Some(Ok(Message::Close(f))) => return Ok(f.map_or(1005, |f| u16::from(f.code))),
                    Some(Ok(_)) => {}
                    Some(Err(e)) => return Err(e.into()),
                    None => return Ok(1006),
                }
            }
            out = conn.rx.recv() => match out {
                Some(Message::Close(_)) | None => {
                    let _ = tokio::time::timeout(CLOSE_TIMEOUT, conn.ws.close(None)).await;
                    return Ok(1000);
                }
                Some(m) => conn.ws.send(m).await?,
            },
            _ = ping.tick() => {
                if last_rx.elapsed() > HEARTBEAT + HEARTBEAT / 2 {
                    anyhow::bail!("heartbeat timeout");
                }
                conn.ws.send(Message::Ping(Default::default())).await?;
            }
        }
    }
}

/// Connect, dispatch text messages, reconnect with backoff; returns only on cancel (drop).
/// `on_msg` gets the raw JSON text; `on_open` runs on each new connection before the read loop.
pub async fn run_ws<U, M, O>(mut url: U, feed: FeedRef, mut on_msg: M, mut on_open: O)
where
    U: FnMut() -> String,
    M: FnMut(&str),
    O: AsyncFnMut(&mut WsConn) -> anyhow::Result<()>,
{
    let _stopped = Stopped(feed.clone());
    let mut backoff = 1.0f64;
    loop {
        let res: anyhow::Result<u16> = async {
            let ws = connect(&url()).await?;
            {
                let mut f = feed.borrow_mut();
                f.error.clear();
                f.set_up(true, Some(""));
            }
            backoff = 1.0;
            let (tx, rx) = mpsc::unbounded_channel();
            let mut conn = WsConn { ws, handle: WsHandle { tx }, rx };
            on_open(&mut conn).await?;
            read_loop(&mut conn, &feed, &mut on_msg).await
        }
        .await;
        {
            let mut f = feed.borrow_mut();
            let detail = match &res {
                Ok(code) if f.error.is_empty() => format!("closed ({code})"),
                Ok(_) => f.error.clone(),
                Err(e) => short(format!("{e:#}")),
            };
            f.set_up(false, Some(&detail));
        }
        tokio::time::sleep(Duration::from_secs_f64(backoff)).await;
        backoff = (backoff * 2.0).min(30.0);
    }
}

static IDS: AtomicU64 = AtomicU64::new(1);

fn next_id() -> u64 {
    IDS.fetch_add(1, Ordering::Relaxed)
}

#[derive(Serialize)]
struct Subscribe<'a> {
    method: &'static str,
    params: &'a [String],
    id: u64,
}

/// A combined-stream message: `data` is left unparsed (raw JSON slice).
#[derive(Deserialize)]
struct Envelope<'a> {
    #[serde(borrow, default)]
    stream: Option<Cow<'a, str>>,
    #[serde(borrow, default)]
    data: Option<sonic_rs::LazyValue<'a>>,
}

/// Hot path: split a combined-stream message into (stream, raw data JSON) without building a tree.
pub fn on_combined(msg: &str, on_data: &dyn Fn(&str, &str)) {
    if let Ok(env) = sonic_rs::from_str::<Envelope>(msg)
        && let Some(data) = &env.data
    {
        let raw = data.as_raw_str();
        if raw != "null" {
            on_data(env.stream.as_deref().unwrap_or(""), raw);
        }
    }
}

struct Conn {
    streams: Vec<String>,
    in_url: usize,
    ws: Option<WsHandle>,
    feed: FeedRef,
    task: Option<JoinHandle<()>>,
}

/// Combined public streams split over connections of at most `cap` streams; streams can be
/// added at run time (SUBSCRIBE on a live connection, or in the URL of the next connect).
/// Connections run as `spawn_local` tasks: call `add` inside a `LocalSet`.
pub struct StreamMux {
    pub base: String,
    pub name: String,
    on_data: OnData,
    pub cap: usize,
    conns: Vec<Rc<RefCell<Conn>>>,
    known: HashSet<String>,
}

impl StreamMux {
    /// `on_data(stream, data)` gets the stream name and the raw JSON of the message's `data`.
    pub fn new(base: &str, name: &str, on_data: impl Fn(&str, &str) + 'static, cap: usize) -> Self {
        StreamMux { base: base.into(), name: name.into(), on_data: Rc::new(on_data), cap, conns: vec![], known: HashSet::new() }
    }

    pub fn feeds(&self) -> Vec<FeedRef> {
        self.conns.iter().map(|c| c.borrow().feed.clone()).collect()
    }

    pub fn known(&self) -> &HashSet<String> {
        &self.known
    }

    pub fn add<S: AsRef<str>>(&mut self, streams: impl IntoIterator<Item = S>) {
        let mut new: Vec<String> = vec![];
        for s in streams {
            let s = s.as_ref();
            if !self.known.contains(s) {
                self.known.insert(s.to_string());
                new.push(s.to_string());
            }
        }
        let mut new = &new[..];
        while !new.is_empty() {
            if self.conns.last().is_none_or(|c| c.borrow().streams.len() >= self.cap) {
                self.spawn();
            }
            let mut c = self.conns.last().unwrap().borrow_mut();
            let n = (self.cap - c.streams.len()).min(new.len());
            let (take, rest) = new.split_at(n);
            new = rest;
            c.streams.extend_from_slice(take);
            if let Some(ws) = c.ws.as_ref().filter(|ws| !ws.is_closed()) {
                ws.send_json(&Subscribe { method: "SUBSCRIBE", params: take, id: next_id() });
            }
            c.feed.borrow_mut().detail = format!("{} streams", c.streams.len());
        }
    }

    fn spawn(&mut self) {
        let feed = Feed::shared(format!("{} #{}", self.name, self.conns.len() + 1), FeedKind::Public, "");
        let c = Rc::new(RefCell::new(Conn { streams: vec![], in_url: 0, ws: None, feed: feed.clone(), task: None }));
        self.conns.push(c.clone());
        let on_data = self.on_data.clone();
        let on_msg = move |m: &str| on_combined(m, &*on_data);
        let (c1, c2, base) = (c.clone(), c.clone(), self.base.clone());
        let on_open = async move |ws: &mut WsConn| -> anyhow::Result<()> {
            let late = {
                let mut c = c1.borrow_mut();
                c.ws = Some(ws.handle());
                c.streams[c.in_url..].to_vec()
            };
            if !late.is_empty() {
                ws.send_json(&Subscribe { method: "SUBSCRIBE", params: &late, id: next_id() }).await?;
            }
            let c = c1.borrow();
            c.feed.borrow_mut().detail = format!("{} streams", c.streams.len());
            Ok(())
        };
        let url = move || {
            let mut c = c2.borrow_mut();
            c.ws = None;
            c.in_url = c.streams.len();
            format!("{base}?streams={}", c.streams.join("/"))
        };
        let task = tokio::task::spawn_local(run_ws(url, feed, on_msg, on_open));
        c.borrow_mut().task = Some(task);
    }

    pub fn stop(&mut self) {
        for c in &self.conns {
            if let Some(t) = &c.borrow().task {
                t.abort();
            }
        }
    }
}

impl Drop for StreamMux {
    fn drop(&mut self) {
        self.stop();
    }
}

/// The only WS API requests the monitor sends: authenticate and subscribe to user data.
pub const WS_API_METHODS: [&str; 3] = ["session.logon", "userDataStream.subscribe", "userDataStream.subscribe.signature"];

#[derive(Serialize)]
struct ApiCall<'a, P: Serialize> {
    id: &'a str,
    method: &'a str,
    #[serde(skip_serializing_if = "Option::is_none")]
    params: Option<P>,
}

pub async fn ws_api_call<P: Serialize>(ws: &mut WsConn, rid: &str, method: &str, params: Option<P>) -> anyhow::Result<()> {
    if !WS_API_METHODS.contains(&method) {
        return Err(super::rest::PermissionError(format!("WS API {method}")).into());
    }
    ws.send_json(&ApiCall { id: rid, method, params }).await
}

#[cfg(test)]
mod tests {
    #![allow(clippy::result_large_err)]
    use super::*;
    use tokio_tungstenite::tungstenite::handshake::server::{Request, Response};

    #[test]
    fn combined_envelope_hands_raw_data() {
        let got = RefCell::new(vec![]);
        let f = |s: &str, d: &str| got.borrow_mut().push((s.to_string(), d.to_string()));
        on_combined(r#"{"stream":"x@bookTicker","data":{"s":"X","b":"1.5","a":"1.6"}}"#, &f);
        on_combined(r#"{"result":null,"id":3}"#, &f);
        on_combined(r#"{"stream":"y","data":null}"#, &f);
        on_combined("[1,2]", &f);
        on_combined(r#"{"data":{"e":1}}"#, &f);
        assert_eq!(*got.borrow(), [
            ("x@bookTicker".to_string(), r#"{"s":"X","b":"1.5","a":"1.6"}"#.to_string()),
            (String::new(), r#"{"e":1}"#.to_string()),
        ]);
    }

    /// StreamMux against a local server: streams in the URL, data delivered, a late add sent as SUBSCRIBE.
    #[tokio::test(flavor = "current_thread")]
    async fn mux_subscribes_and_delivers() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let (tx, mut rx) = mpsc::unbounded_channel::<String>();
        tokio::spawn(async move {
            let (s, _) = listener.accept().await.unwrap();
            let tx2 = tx.clone();
            let mut ws = tokio_tungstenite::accept_hdr_async(s, move |req: &Request, resp: Response| {
                tx2.send(req.uri().to_string()).unwrap();
                Ok(resp)
            })
            .await
            .unwrap();
            ws.send(Message::text(r#"{"stream":"a@bookTicker","data":{"s":"A","b":"1","a":"2"}}"#)).await.unwrap();
            while let Some(Ok(m)) = ws.next().await {
                if let Message::Text(t) = m {
                    tx.send(t.as_str().to_string()).unwrap();
                }
            }
        });
        let local = tokio::task::LocalSet::new();
        local
            .run_until(async move {
                let got: Rc<RefCell<Vec<(String, String)>>> = Rc::default();
                let g = got.clone();
                let mut mux = StreamMux::new(&format!("ws://{addr}/stream"), "t", move |s, d| {
                    g.borrow_mut().push((s.into(), d.into()))
                }, 200);
                mux.add(["a@bookTicker", "b@bookTicker", "a@bookTicker"]);
                assert_eq!(rx.recv().await.unwrap(), "/stream?streams=a@bookTicker/b@bookTicker");
                while got.borrow().is_empty() {
                    tokio::time::sleep(Duration::from_millis(5)).await;
                }
                assert_eq!(got.borrow()[0], ("a@bookTicker".into(), r#"{"s":"A","b":"1","a":"2"}"#.into()));
                assert!(mux.feeds()[0].borrow().up);
                mux.add(["c@bookTicker"]);
                let sub: serde_json::Value = serde_json::from_str(&rx.recv().await.unwrap()).unwrap();
                assert_eq!(sub["method"], "SUBSCRIBE");
                assert_eq!(sub["params"], serde_json::json!(["c@bookTicker"]));
                assert_eq!(mux.feeds()[0].borrow().detail, "3 streams");
                mux.stop();
            })
            .await;
    }

    #[test]
    fn mux_splits_at_cap() {
        let local = tokio::task::LocalSet::new();
        let rt = tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap();
        local.block_on(&rt, async {
            let mut mux = StreamMux::new("ws://127.0.0.1:9/stream", "t", |_, _| {}, 2);
            mux.add(["a", "b", "c", "d", "e"]);
            let sizes: Vec<usize> = mux.conns.iter().map(|c| c.borrow().streams.len()).collect();
            assert_eq!(sizes, [2, 2, 1]);
            assert_eq!(mux.feeds()[1].borrow().name, "t #2");
            mux.stop();
        });
    }
}
