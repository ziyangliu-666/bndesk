//! Hyperliquid's public market data: `bbo` for books, `activeAssetCtx` for a perp's mark and funding.
use std::borrow::Cow;
use std::cell::RefCell;
use std::rc::Rc;
use std::time::Duration;

use serde::Deserialize;
use serde::de::{self, Deserializer};
use tokio::task::JoinHandle;

use crate::accounts::MarketRef;
use crate::connector::{PermissionError, PublicFeed};
use crate::feeds::{Feed, FeedKind, FeedRef};
use crate::market::{Book, Inst, Mark, Market};
use crate::ws::{WsConn, WsHandle, run_ws};

use super::PERP;
use super::names::NamesRef;
use super::rest::CLOCK;

/// The only messages this desk sends on a socket: `{"method":"post"}`, which carries orders, is not one of them.
pub const WS_METHODS: [&str; 2] = ["subscribe", "ping"];
/// What it subscribes to.
pub const SUBSCRIPTIONS: [&str; 8] =
    ["bbo", "activeAssetCtx", "userFills", "orderUpdates", "userFundings", "userNonFundingLedgerUpdates", "clearinghouseState", "spotState"];

/// The exchange allows 1000 subscriptions an IP; a perp takes two.
const SUBS_PER_CONN: usize = 400;
/// It drops a connection that has sent nothing for a minute.
const PING_EVERY: Duration = Duration::from_secs(30);
/// Book updates come only on a change: a whole connection this quiet has stopped.
const IDLE: Duration = Duration::from_secs(60);

/// A subscribe message, if it is one this desk may send.
pub fn subscribe(kind: &str, field: &str, value: &str) -> Result<String, PermissionError> {
    if !SUBSCRIPTIONS.contains(&kind) {
        return Err(PermissionError(format!("WS subscription {kind}")));
    }
    Ok(serde_json::json!({"method": WS_METHODS[0], "subscription": {"type": kind, field: value}}).to_string())
}

/// Keeps a connection alive until it ends.
pub fn keep_pinging(ws: WsHandle) {
    tokio::task::spawn_local(async move {
        let ping = serde_json::json!({"method": WS_METHODS[1]}).to_string();
        loop {
            tokio::time::sleep(PING_EVERY).await;
            if ws.is_closed() || !ws.send_text(ping.clone()) {
                return;
            }
        }
    });
}

fn de_px<'de, D: Deserializer<'de>>(d: D) -> Result<f64, D::Error> {
    let s = <Cow<'de, str>>::deserialize(d)?;
    s.parse().map_err(de::Error::custom)
}

#[derive(Deserialize)]
struct Envelope<'a> {
    #[serde(borrow)]
    channel: Cow<'a, str>,
    #[serde(borrow, default)]
    data: Option<sonic_rs::LazyValue<'a>>,
}

#[derive(Deserialize)]
struct Level {
    #[serde(deserialize_with = "de_px")]
    px: f64,
}

#[derive(Deserialize)]
struct Bbo<'a> {
    #[serde(borrow)]
    coin: Cow<'a, str>,
    time: i64,
    bbo: [Option<Level>; 2],
}

#[derive(Deserialize)]
struct Ctx {
    #[serde(rename = "markPx", deserialize_with = "de_px")]
    mark: f64,
    #[serde(deserialize_with = "de_px")]
    funding: f64,
}

#[derive(Deserialize)]
struct AssetCtx<'a> {
    #[serde(borrow)]
    coin: Cow<'a, str>,
    ctx: Ctx,
}

/// Funding is paid on the hour.
fn next_hour(now: i64) -> i64 {
    (now.div_euclid(3_600_000) + 1) * 3_600_000
}

/// Hot path: one message of the public feed. Anything else on the socket is left alone.
pub fn on_public(m: &mut Market, names: &NamesRef, msg: &str) {
    let Ok(env) = sonic_rs::from_str::<Envelope>(msg) else { return };
    let Some(data) = &env.data else { return };
    let names = names.read().expect("names");
    match env.channel.as_ref() {
        "bbo" => {
            if let Ok(d) = sonic_rs::from_str::<Bbo>(data.as_raw_str())
                && let Some((symbol, venue)) = names.symbol(&d.coin)
            {
                let [b, a] = d.bbo.map(|l| l.map_or(0.0, |l| l.px));
                m.on_book(venue, &Book::new(symbol, b, a, Some(d.time)));
            }
        }
        "activeAssetCtx" => {
            if let Ok(d) = sonic_rs::from_str::<AssetCtx>(data.as_raw_str())
                && let Some((symbol, venue)) = names.symbol(&d.coin)
            {
                m.on_mark(venue, &Mark { symbol, price: d.ctx.mark, funding: Some(d.ctx.funding), next_funding: Some(next_hour(CLOCK.now())) });
            }
        }
        _ => {}
    }
}

struct Conn {
    subs: Vec<String>,
    ws: Option<WsHandle>,
    feed: FeedRef,
    task: Option<JoinHandle<()>>,
}

/// Subscriptions split over connections, sent again on each reconnect: its subscriptions are not in a URL here.
pub struct Streams {
    url: String,
    names: NamesRef,
    market: MarketRef,
    conns: RefCell<Vec<Rc<RefCell<Conn>>>>,
}

impl Streams {
    pub fn new(url: &str, names: NamesRef, market: MarketRef) -> Self {
        Streams { url: url.into(), names, market, conns: RefCell::default() }
    }

    fn add(&self, sub: String) {
        let need = self.conns.borrow().last().is_none_or(|c| c.borrow().subs.len() >= SUBS_PER_CONN);
        if need {
            self.spawn();
        }
        let conns = self.conns.borrow();
        let mut c = conns.last().expect("a connection").borrow_mut();
        if let Some(ws) = c.ws.as_ref().filter(|ws| !ws.is_closed()) {
            ws.send_text(sub.clone());
        }
        c.subs.push(sub);
        let n = c.subs.len();
        c.feed.borrow_mut().detail = format!("{n} streams");
    }

    fn spawn(&self) {
        let n = self.conns.borrow().len() + 1;
        let feed = Feed::shared(format!("hyperliquid books #{n}"), FeedKind::Public, "");
        let c = Rc::new(RefCell::new(Conn { subs: vec![], ws: None, feed: feed.clone(), task: None }));
        self.conns.borrow_mut().push(c.clone());
        let c1 = c.clone();
        let on_open = async move |ws: &mut WsConn| -> anyhow::Result<()> {
            let subs = {
                let mut c = c1.borrow_mut();
                c.ws = Some(ws.handle());
                let n = c.subs.len();
                c.feed.borrow_mut().detail = format!("{n} streams");
                c.subs.clone()
            };
            for s in subs {
                ws.send_text(s).await?;
            }
            keep_pinging(ws.handle());
            Ok(())
        };
        let (market, names, url) = (self.market.clone(), self.names.clone(), self.url.clone());
        let on_msg = move |m: &str| on_public(&mut market.borrow_mut(), &names, m);
        let task = tokio::task::spawn_local(run_ws(move || url.clone(), feed, on_msg, on_open, Some(IDLE)));
        c.borrow_mut().task = Some(task);
    }
}

impl PublicFeed for Streams {
    fn watch(&self, inst: &Inst) {
        let coin = self.names.read().expect("names").live_coin(&inst.symbol, inst.venue).map(String::from);
        // a coin it does not list would close the connection, and with it every other instrument's book
        let Some(coin) = coin else {
            tracing::warn!("{}: not listed, no book", inst.key);
            return;
        };
        self.add(subscribe("bbo", "coin", &coin).expect("listed"));
        if inst.venue == PERP {
            self.add(subscribe("activeAssetCtx", "coin", &coin).expect("listed"));
        }
    }

    fn feeds(&self) -> Vec<FeedRef> {
        self.conns.borrow().iter().map(|c| c.borrow().feed.clone()).collect()
    }

    fn stop(&self) {
        for c in self.conns.borrow().iter() {
            if let Some(t) = &c.borrow().task {
                t.abort();
            }
        }
    }
}

impl Drop for Streams {
    fn drop(&mut self) {
        self.stop();
    }
}

/// A book's top, from a book read: the exchange has no list of tops.
pub fn top_of(book: &serde_json::Value) -> Option<(f64, f64)> {
    let side = |i: usize| book.get("levels")?.get(i)?.get(0)?.get("px")?.as_str()?.parse::<f64>().ok();
    Some((side(0)?, side(1)?))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::market::SymbolInfo;
    use serde_json::json;
    use std::collections::HashMap;
    use std::sync::{Arc, RwLock};

    fn names() -> NamesRef {
        let mut n = super::super::names::Names::default();
        n.read(&json!([{"universe": [{"name": "BTC"}, {"name": "kPEPE"}]}, []]),
               &json!([{"universe": [{"tokens": [150, 0], "name": "@107"}], "tokens": [{"name": "USDC", "index": 0}, {"name": "HYPE", "index": 150}]}, []]));
        Arc::new(RwLock::new(n))
    }

    fn market() -> Market {
        let mut i = crate::market::Info::new();
        i.insert(PERP, HashMap::from([("KPEPE".to_string(), SymbolInfo::new("KPEPE", "USDC", 10.0))]));
        let mut m = Market::new(i, 120.0, 100.0);
        m.ensure("BTC", PERP, None);
        m.ensure("KPEPE", PERP, None);
        m.ensure("HYPEUSDC", super::super::SPOT, None);
        m
    }

    #[test]
    fn messages_as_the_exchange_sent_them() {
        // captured from wss://api.hyperliquid.xyz/ws on 2026-11-02
        let (mut m, n) = (market(), names());
        on_public(&mut m, &n, r#"{"channel":"bbo","data":{"coin":"BTC","time":1793600591705,"bbo":[{"px":"78194.0","sz":"5.39557","n":15},{"px":"78195.0","sz":"5.70095","n":24}]}}"#);
        on_public(&mut m, &n, r#"{"channel":"bbo","data":{"coin":"@107","time":1793600592042,"bbo":[{"px":"87.338","sz":"43.17","n":3},{"px":"87.339","sz":"95.18","n":4}]}}"#);
        on_public(&mut m, &n, r#"{"channel":"activeAssetCtx","data":{"coin":"kPEPE","ctx":{"funding":"0.0000125","openInterest":"11747418136.0","prevDayPx":"0.004979","dayNtlVlm":"20179467.4278789945","premium":"0.0","oraclePx":"0.004823","markPx":"0.004822","midPx":"0.004822","impactPxs":["0.00482","0.004824"],"dayBaseVlm":"4107353956.0"}}}"#);
        on_public(&mut m, &n, r#"{"channel":"subscriptionResponse","data":{"method":"subscribe","subscription":{"type":"bbo","coin":"BTC"}}}"#);
        on_public(&mut m, &n, r#"{"channel":"pong"}"#);
        let btc = m.get("hl:BTC").unwrap();
        assert_eq!((btc.bid, btc.ask, btc.t), (78194.0, 78195.0, Some(1793600591705)));
        assert_eq!(m.get("hlspot:HYPEUSDC").unwrap().bid, 87.338);
        let k = m.get("hl:KPEPE").unwrap();
        assert_eq!((k.mark, k.funding), (Some(0.004822), Some(0.0000125)));
        assert!(k.next_funding.unwrap() % 3_600_000 == 0);
    }

    #[test]
    fn one_side_of_a_book_empty_is_no_mid() {
        let (mut m, n) = (market(), names());
        on_public(&mut m, &n, r#"{"channel":"bbo","data":{"coin":"BTC","time":5,"bbo":[null,{"px":"2","sz":"1","n":1}]}}"#);
        assert_eq!(m.get("hl:BTC").unwrap().mid(), None);
    }

    #[test]
    fn it_subscribes_to_what_is_listed_and_can_send_nothing_else() {
        assert_eq!(subscribe("bbo", "coin", "BTC").unwrap(), r#"{"method":"subscribe","subscription":{"coin":"BTC","type":"bbo"}}"#);
        assert!(subscribe("order", "coin", "BTC").is_err());
        assert!(!WS_METHODS.contains(&"post"));
    }

    #[test]
    fn a_book_read() {
        let b = json!({"coin": "BTC", "time": 1, "levels": [[{"px": "78293.0", "sz": "0.3", "n": 1}], [{"px": "78294.0", "sz": "0.1", "n": 1}]]});
        assert_eq!(top_of(&b), Some((78293.0, 78294.0)));
        assert_eq!(top_of(&json!({"levels": [[], []]})), None);
    }
}
