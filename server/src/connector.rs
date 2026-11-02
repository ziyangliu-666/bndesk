//! What the desk needs from an exchange, whichever it is. A connector is a read-only thing: every method here reads, and
//! a connector's HTTP goes through a client that refuses every write but those `allowed_writes` lists
//! (`tests/readonly.rs`). Nothing outside a connector's directory and this file names a connector.
use std::cell::Cell;
use std::rc::Rc;
use std::sync::Arc;
use std::time::Duration;

use anyhow::Result;
use futures_util::future::{BoxFuture, LocalBoxFuture};
use tokio::task::JoinHandle;

use crate::accounts::{AccountRef, Dividend, MarketRef, TransfersRef};
use crate::binance::Binance;
use crate::config::AccountCfg;
use crate::feeds::FeedRef;
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
    /// The only requests other than GET it makes: (method, path). Nothing that trades or moves money.
    fn allowed_writes(&self) -> &'static [(&'static str, &'static str)];

    /// Sets the desk's clock to the exchange's.
    fn sync_clock(&self) -> Reply<'_, ()>;
    /// Keeps it there: runs until cancelled.
    fn keep_clock(&self) -> LocalBoxFuture<'static, ()>;
    /// What each market lists.
    fn instruments(&self) -> Reply<'_, Info>;
    fn public_feed(&self, market: MarketRef) -> Rc<dyn PublicFeed>;
    /// Every symbol's book top on a market: (symbol, bid, ask).
    fn book_tops(&self, venue: Venue) -> Reply<'_, Vec<(String, f64, f64)>>;
    /// (open time, open, close) of the bars of `interval` ("1s", where the market has them; "1m") of an instrument key
    /// opening in [start, end]; an error `RestError` with status 400 means there are none, for good.
    fn bars<'a>(&'a self, key: &'a str, interval: &'a str, start: i64, end: i64) -> Reply<'a, Vec<(i64, f64, f64)>>;
    /// The price of the first trade of an instrument key at or after `t` (within a minute).
    fn trade_at<'a>(&'a self, key: &'a str, t: i64) -> Reply<'a, Option<f64>>;
    /// (open time, open, close) of a perp's 1 min mark price bars opening in [from, until].
    fn mark_bars<'a>(&'a self, symbol: &'a str, from: i64, until: i64) -> Reply<'a, Vec<(i64, f64, f64)>>;
    fn kline_source(&self) -> Arc<dyn KlineSource>;
    fn rest_bans(&self) -> Vec<RestBan>;

    /// The account's key, or why it has none.
    fn credentials(&self, cfg: &AccountCfg) -> Result<Rc<Credentials>, String>;
    /// Reads the accounts from here on, as `Event`s, and fills in the transfers.
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
        _ => anyhow::bail!("no connector for exchange {id:?}"),
    }
}
