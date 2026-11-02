//! Binance's WebSocket addresses, its combined public streams and its WS API.
use std::borrow::Cow;
use std::cell::RefCell;
use std::collections::HashSet;
use std::rc::Rc;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tokio::task::JoinHandle;

use crate::feeds::{Feed, FeedKind, FeedRef};
pub use crate::ws::{WsConn, WsHandle, WsStream, connect, run_ws};

pub const SPOT_STREAM: &str = "wss://stream.binance.com:9443/stream";
pub const USDM_PUBLIC: &str = "wss://fstream.binance.com/public/stream";
pub const USDM_MARKET: &str = "wss://fstream.binance.com/market/stream";
pub const USDM_PRIVATE: &str = "wss://fstream.binance.com/private/ws/";
pub const WS_API: &str = "wss://ws-api.binance.com:443/ws-api/v3";

/// `on_data(stream, raw data JSON)` of a `StreamMux`.
pub type OnData = Rc<dyn Fn(&str, &str)>;

/// A public connection with streams that sends nothing for this long is reconnected: the busiest
/// connection carries many markets, so a full minute of silence means it has stopped, not that they are quiet.
pub const PUBLIC_IDLE: Duration = Duration::from_secs(60);

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
        let task = tokio::task::spawn_local(run_ws(url, feed, on_msg, on_open, Some(PUBLIC_IDLE)));
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
    use futures_util::{SinkExt, StreamExt};
    use tokio::sync::mpsc;
    use tokio_tungstenite::tungstenite::Message;
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
