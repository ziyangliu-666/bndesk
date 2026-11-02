//! A WebSocket connection that stays up: connect, read, ping, reconnect with backoff, keeping a feed's health. What is
//! sent on it and what its messages mean are a connector's.
use std::time::{Duration, Instant};

use futures_util::{SinkExt, StreamExt};
use serde::Serialize;
use tokio::net::TcpStream;
use tokio::sync::mpsc;
use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::tungstenite::protocol::WebSocketConfig;
use tokio_tungstenite::{MaybeTlsStream, WebSocketStream};

use crate::feeds::FeedRef;

const HEARTBEAT: Duration = Duration::from_secs(30);
const CONNECT_TIMEOUT: Duration = Duration::from_secs(15);
const CLOSE_TIMEOUT: Duration = Duration::from_secs(10);

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
/// With `idle`, a connection that answers pings but sends no data for that long is ended too.
async fn read_loop(conn: &mut WsConn, feed: &FeedRef, on_msg: &mut impl FnMut(&str), idle: Option<Duration>) -> anyhow::Result<u16> {
    let mut ping = tokio::time::interval_at(tokio::time::Instant::now() + HEARTBEAT, HEARTBEAT);
    let mut last_rx = Instant::now();
    let mut last_data = Instant::now();
    loop {
        tokio::select! {
            m = conn.ws.next() => {
                last_rx = Instant::now();
                match m {
                    Some(Ok(Message::Text(t))) => {
                        last_data = Instant::now();
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
                if let Some(idle) = idle && last_data.elapsed() > idle {
                    anyhow::bail!("no data for {}s", idle.as_secs());
                }
                conn.ws.send(Message::Ping(Default::default())).await?;
            }
        }
    }
}

/// Connect, dispatch text messages, reconnect with backoff; returns only on cancel (drop).
/// `on_msg` gets the raw JSON text; `on_open` runs on each new connection before the read loop.
pub async fn run_ws<U, M, O>(mut url: U, feed: FeedRef, mut on_msg: M, mut on_open: O, idle: Option<Duration>)
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
            read_loop(&mut conn, &feed, &mut on_msg, idle).await
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
