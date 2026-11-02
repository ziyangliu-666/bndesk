//! What the desk needs from an exchange, whichever it is. A connector is a read-only thing: every method here reads, and
//! a connector's HTTP goes through a client that refuses all but its reads and what `allowed_writes` lists. What a read
//! looks like is the exchange's: a GET on one, a POST of a listed type to one path on another (`tests/readonly.rs`).
//! Nothing outside a connector's directory and this file names a connector.
use std::cell::Cell;
use std::rc::Rc;
use std::sync::Arc;
use std::time::Duration;

use anyhow::Result;
use futures_util::future::{BoxFuture, LocalBoxFuture};
use tokio::task::JoinHandle;

use crate::accounts::{AccountRef, Dividend, MarketRef, TransfersRef};
use crate::binance::Binance;
use crate::clock::TimeSync;
use crate::config::AccountCfg;
use crate::feeds::FeedRef;
use crate::hyperliquid::Hyperliquid;
use crate::market::{Info, Inst};
use crate::protocol::Venue;
use crate::sign::Credentials;

/// An exchange refused a request.
#[derive(Debug, thiserror::Error)]
#[error("HTTP {status}: {}", body.chars().take(200).collect::<String>())]
pub struct RestError {
    pub status: u16,
    pub body: String,
}

/// A request that is not a read: refused before it leaves the process.
#[derive(Debug, thiserror::Error)]
#[error("read-only monitor refuses {0}")]
pub struct PermissionError(pub String);

/// The desk's HTTP pool.
pub fn client() -> reqwest::Client {
    reqwest::Client::builder()
        .timeout(Duration::from_secs(15))
        .pool_idle_timeout(Duration::from_secs(90))
        .tcp_nodelay(true)
        .build()
        .expect("reqwest client")
}

pub type Reply<'a, T> = LocalBoxFuture<'a, Result<T>>;

/// The live market data of a connector: told each instrument the desk comes to track, it keeps the market's books and
/// marks up to date.
pub trait PublicFeed {
    fn watch(&self, inst: &Inst);
    fn feeds(&self) -> Vec<FeedRef>;
    fn stop(&self);
}

/// (open time, open, high, low, close, base volume).
pub type Kline = (i64, f64, f64, f64, f64, f64);

/// An instrument's last 24 h. An exchange that does not say a high or low gives none.
#[derive(Debug, Clone, PartialEq, serde::Serialize)]
pub struct Ticker {
    pub last: f64,
    pub open: f64,
    pub high: Option<f64>,
    pub low: Option<f64>,
    pub volume: f64,
    pub quote_volume: f64,
    pub t: i64,
}

/// Why bars could not be had.
pub enum KlineError {
    /// The exchange asked to be left alone this long.
    Throttled { wait_s: i64, text: String },
    /// A request it refuses as such: an unknown symbol, say.
    Refused(String),
    Failed(String),
}

/// Bars for the HTTP API, whose handlers run off the desk's thread: unlike the rest of a connector this must be `Send`.
pub trait KlineSource: Send + Sync {
    fn id(&self) -> &'static str;
    /// Up to `limit` bars of `interval` (1m, 5m, 15m, 30m, 1h, 4h, 1d, 1w) opening in [start, end].
    fn bars<'a>(&'a self, symbol: &'a str, venue: Venue, interval: &'a str, start: i64, end: i64, limit: i64)
                -> BoxFuture<'a, Result<Vec<Kline>, KlineError>>;
    /// The last 24 h, for a market the page has no socket of its own to. None: the page does not need it from here.
    fn ticker<'a>(&'a self, _symbol: &'a str, _venue: Venue) -> BoxFuture<'a, Result<Option<Ticker>, KlineError>> {
        Box::pin(std::future::ready(Ok(None)))
    }
}

/// An exchange has stopped answering this IP, or did lately.
pub struct RestBan {
    pub name: String,
    pub banned: bool,
    pub last: Option<(u16, f64)>,
    pub until_s: f64,
}

/// A fill on a perp as the account's history has it: signed quantity, and the fee in `fee_asset`.
#[derive(Debug, Clone, PartialEq)]
pub struct PerpTrade {
    pub ts: i64,
    pub sq: f64,
    pub price: f64,
    pub fee: f64,
    pub fee_asset: String,
}

/// An account's balances read once: when they stood, if the exchange says, and each asset's free + locked.
pub struct Balances {
    pub updated: Option<i64>,
    pub rows: Vec<(String, f64)>,
}

/// An account read once, for `desk repair-day`.
pub trait AccountReader {
    fn balances(&self) -> Reply<'_, Balances>;
    /// Every perp position: (symbol, signed amount).
    fn perp_positions(&self) -> Reply<'_, Vec<(String, f64)>>;
    /// A symbol's fills from `from` on, oldest first.
    fn perp_trades<'a>(&'a self, symbol: &'a str, from: i64) -> Reply<'a, Vec<PerpTrade>>;
    /// A symbol's funding in [from, to]: (time, amount).
    fn perp_funding<'a>(&'a self, symbol: &'a str, from: i64, to: i64) -> Reply<'a, Vec<(i64, f64)>>;
}

pub trait Connector {
    /// What `exchange` says in the config.
    fn id(&self) -> &'static str;
    fn markets(&self) -> Vec<Venue>;
    /// The only requests it makes that are not reads: (method, path). Nothing that trades or moves money.
    fn allowed_writes(&self) -> &'static [(&'static str, &'static str)];

    /// The exchange's time, as last measured.
    fn clock(&self) -> &'static TimeSync;
    /// Measures it.
    fn sync_clock(&self) -> Reply<'_, ()>;
    /// Keeps it there: runs until cancelled.
    fn keep_clock(&self) -> LocalBoxFuture<'static, ()>;
    /// What each market lists.
    fn instruments(&self) -> Reply<'_, Info>;
    fn public_feed(&self, market: MarketRef) -> Rc<dyn PublicFeed>;
    /// The book tops of these symbols on a market: (symbol, bid, ask). May answer for more than it was asked.
    fn book_tops<'a>(&'a self, venue: Venue, symbols: &'a [String]) -> Reply<'a, Vec<(String, f64, f64)>>;
    /// (open time, open, close) of the bars of `interval` ("1s", where the market has them; "1m") of an instrument key
    /// opening in [start, end]; an error `RestError` with status 400 means there are none, for good.
    fn bars<'a>(&'a self, key: &'a str, interval: &'a str, start: i64, end: i64) -> Reply<'a, Vec<(i64, f64, f64)>>;
    /// The price of the first trade of an instrument key at or after `t` (within a minute), on a market with
    /// `trade_history`.
    fn trade_at<'a>(&'a self, key: &'a str, t: i64) -> Reply<'a, Option<f64>>;
    /// (open time, open, close) of a perp's 1 min mark price bars opening in [from, until], or the nearest it has.
    fn mark_bars<'a>(&'a self, symbol: &'a str, from: i64, until: i64) -> Reply<'a, Vec<(i64, f64, f64)>>;
    fn kline_source(&self) -> Arc<dyn KlineSource>;
    fn rest_bans(&self) -> Vec<RestBan>;

    /// The account's key, none if reading it takes none, or why it cannot be read.
    fn credentials(&self, cfg: &AccountCfg) -> Result<Option<Rc<Credentials>>, String>;
    /// Reads these accounts, all on this exchange, from here on, as `Event`s, and fills in the transfers.
    fn start_accounts(&self, accounts: &[AccountRef], transfers: &TransfersRef, day_start: Rc<Cell<i64>>) -> Vec<JoinHandle<()>>;
    /// An account's own reads, or why it cannot be read.
    fn reader(&self, cfg: &AccountCfg) -> Result<Box<dyn AccountReader>, String>;
    /// Whether a distribution with this description is a rebate. Stored rows keep the description.
    fn is_rebate(&self, info: &str) -> bool;
    /// The distributions credited to an account in [from, to).
    fn distributions<'a>(&'a self, acct: &'a AccountRef, from: i64, to: i64) -> Reply<'a, Vec<(String, Dividend)>>;
}

/// The connector of an exchange the config names. `http`: the desk's pool; `feed`, what public requests count on.
pub fn open(id: &str, http: reqwest::Client, feed: Option<FeedRef>) -> Result<Rc<dyn Connector>> {
    match id {
        "binance" => Ok(Rc::new(Binance::new(http, feed))),
        "hyperliquid" => Ok(Rc::new(Hyperliquid::new(http, feed))),
        _ => anyhow::bail!("no connector for exchange {id:?}"),
    }
}

/// The connectors of a desk: `Venue::market().exchange` picks one. The first's clock is the desk's.
#[derive(Clone)]
pub struct Exchanges(Vec<Rc<dyn Connector>>);

impl Exchanges {
    /// One connector per id; `feeds` beside them, what each one's public requests count on.
    pub fn open(ids: &[String], http: &reqwest::Client, feeds: &[Option<FeedRef>]) -> Result<Exchanges> {
        let list: Vec<Rc<dyn Connector>> = ids.iter().zip(feeds).map(|(id, f)| open(id, http.clone(), f.clone())).collect::<Result<_>>()?;
        Ok(Exchanges::from(list))
    }

    pub fn from(list: Vec<Rc<dyn Connector>>) -> Exchanges {
        if let Some(c) = list.first() {
            c.clock().lead();
        }
        Exchanges(list)
    }

    /// Connectors with no feed, for a command that runs once.
    pub fn open_once(ids: &[String]) -> Result<Exchanges> {
        Self::open(ids, &client(), &vec![None; ids.len()])
    }

    /// What every market lists.
    pub async fn instruments(&self) -> Result<Info> {
        let mut info = Info::new();
        for c in &self.0 {
            info.extend(c.instruments().await?);
        }
        Ok(info)
    }

    pub fn iter(&self) -> impl Iterator<Item = &Rc<dyn Connector>> {
        self.0.iter()
    }

    pub fn first(&self) -> &Rc<dyn Connector> {
        &self.0[0]
    }

    pub fn named(&self, exchange: &str) -> Option<&Rc<dyn Connector>> {
        self.0.iter().find(|c| c.id().eq_ignore_ascii_case(exchange))
    }

    pub fn of(&self, venue: Venue) -> Option<&Rc<dyn Connector>> {
        self.0.iter().find(|c| venue.on(c.id()))
    }

    /// What every market's bars come from: a market with no connector here has none.
    pub fn kline_source(&self) -> Arc<dyn KlineSource> {
        let sources: Vec<(&'static str, Arc<dyn KlineSource>)> = self.0.iter().map(|c| (c.id(), c.kline_source())).collect();
        Arc::new(KlineRoutes(sources))
    }
}

struct KlineRoutes(Vec<(&'static str, Arc<dyn KlineSource>)>);

impl KlineRoutes {
    fn of(&self, venue: Venue) -> Result<&Arc<dyn KlineSource>, KlineError> {
        self.0.iter().find(|(id, _)| venue.on(id)).map(|x| &x.1).ok_or_else(|| KlineError::Refused(format!("this desk does not read {venue}")))
    }
}

impl KlineSource for KlineRoutes {
    fn id(&self) -> &'static str {
        self.0.first().map_or("exchange", |x| x.0)
    }

    fn bars<'a>(&'a self, symbol: &'a str, venue: Venue, interval: &'a str, start: i64, end: i64, limit: i64)
                -> BoxFuture<'a, Result<Vec<Kline>, KlineError>> {
        match self.of(venue) {
            Ok(s) => s.bars(symbol, venue, interval, start, end, limit),
            Err(e) => Box::pin(std::future::ready(Err(e))),
        }
    }

    fn ticker<'a>(&'a self, symbol: &'a str, venue: Venue) -> BoxFuture<'a, Result<Option<Ticker>, KlineError>> {
        match self.of(venue) {
            Ok(s) => s.ticker(symbol, venue),
            Err(e) => Box::pin(std::future::ready(Err(e))),
        }
    }
}
