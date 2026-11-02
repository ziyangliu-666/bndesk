//! Hyperliquid: an account is an address, its reads take no key and its perps share one margin account. Everything read
//! from its JSON is here, and so is every endpoint: see `rest` for why this connector cannot trade.
pub mod rest;
pub mod names;
pub mod public;
pub mod klines;
pub mod events;
pub mod account;
pub mod reader;

use std::cell::Cell;
use std::rc::Rc;
use std::sync::{Arc, RwLock};

use futures_util::FutureExt;
use serde_json::json;
use tokio::task::JoinHandle;

use crate::accounts::{AccountRef, Dividend, MarketRef, TransfersRef};
use crate::clock::TimeSync;
use crate::config::AccountCfg;
use crate::connector::{AccountReader, Connector, KlineSource, PublicFeed, Reply, RestBan};
use crate::feeds::FeedRef;
use crate::market::Info;
use crate::protocol::Venue;
use crate::sign::Credentials;

use names::NamesRef;
use rest::{Info as Client, Reads};

pub const PERP: Venue = Venue::HL;
pub const SPOT: Venue = Venue::HL_SPOT;

pub struct Hyperliquid {
    client: Client,
    names: NamesRef,
    base: String,
    ws_url: String,
}

impl Hyperliquid {
    pub fn new(http: reqwest::Client, feed: Option<FeedRef>) -> Self {
        Self::with_bases(http, feed, rest::BASE, rest::WS_URL)
    }

    /// Its REST and WebSocket at other addresses (a stand-in server in tests).
    pub fn with_bases(http: reqwest::Client, feed: Option<FeedRef>, base: &str, ws_url: &str) -> Self {
        Hyperliquid { client: Client::new(http, base, feed), names: Arc::new(RwLock::new(names::Names::default())), base: base.into(), ws_url: ws_url.into() }
    }
}

/// The account's address, from the environment like any other account's identity: lowercase, as its ledger writes them.
pub fn address(cfg: &AccountCfg) -> Result<String, String> {
    let name = if cfg.address_env.is_empty() { "(address_env unset)" } else { &cfg.address_env };
    let v = std::env::var(&cfg.address_env).ok().filter(|v| !v.is_empty()).ok_or_else(|| format!("no address: env {name} is empty"))?;
    let hex = v.strip_prefix("0x").filter(|h| h.len() == 40 && h.bytes().all(|b| b.is_ascii_hexdigit()));
    hex.ok_or_else(|| format!("env {name} is not an address: 0x and 40 hex digits"))?;
    Ok(v.to_lowercase())
}

impl Connector for Hyperliquid {
    fn id(&self) -> &'static str {
        "hyperliquid"
    }

    fn markets(&self) -> Vec<Venue> {
        vec![PERP, SPOT]
    }

    fn allowed_writes(&self) -> &'static [(&'static str, &'static str)] {
        &[]
    }

    fn clock(&self) -> &'static TimeSync {
        &rest::CLOCK
    }

    fn sync_clock(&self) -> Reply<'_, ()> {
        rest::sync_time(&self.client).boxed_local()
    }

    fn keep_clock(&self) -> futures_util::future::LocalBoxFuture<'static, ()> {
        let client = self.client.clone();
        async move {
            loop {
                tokio::time::sleep(std::time::Duration::from_secs(600)).await;
                if let Err(e) = rest::sync_time(&client).await {
                    tracing::warn!("hyperliquid time sync failed: {e:#}");   // keep the last offset
                }
            }
        }
        .boxed_local()
    }

    fn instruments(&self) -> Reply<'_, Info> {
        async move {
            let perps = self.client.read(json!({"type": "metaAndAssetCtxs"})).await?;
            let spots = self.client.read(json!({"type": "spotMetaAndAssetCtxs"})).await?;
            Ok(self.names.write().expect("names").read(&perps, &spots))
        }
        .boxed_local()
    }

    fn public_feed(&self, market: MarketRef) -> Rc<dyn PublicFeed> {
        Rc::new(public::Streams::new(&self.ws_url, self.names.clone(), market))
    }

    fn book_tops<'a>(&'a self, venue: Venue, symbols: &'a [String]) -> Reply<'a, Vec<(String, f64, f64)>> {
        async move {
            let mut out = vec![];
            for symbol in symbols {
                let coin = self.names.read().expect("names").live_coin(symbol, venue).map(String::from);
                let Some(coin) = coin else { continue };
                let book = self.client.read(json!({"type": "l2Book", "coin": coin})).await?;
                if let Some((b, a)) = public::top_of(&book) {
                    out.push((symbol.clone(), b, a));
                }
            }
            Ok(out)
        }
        .boxed_local()
    }

    fn bars<'a>(&'a self, key: &'a str, interval: &'a str, start: i64, end: i64) -> Reply<'a, Vec<(i64, f64, f64)>> {
        klines::bars(&self.client, &self.names, key, interval, start, end).boxed_local()
    }

    /// It keeps no trades to ask for by time: `Market::trade_history` sends the desk to 1 min bars instead.
    fn trade_at<'a>(&'a self, _key: &'a str, _t: i64) -> Reply<'a, Option<f64>> {
        async move { Ok(None) }.boxed_local()
    }

    /// It keeps no mark price candles: a trade candle is the nearest it has.
    fn mark_bars<'a>(&'a self, symbol: &'a str, from: i64, until: i64) -> Reply<'a, Vec<(i64, f64, f64)>> {
        async move {
            let key = format!("{PERP}:{symbol}");
            klines::bars(&self.client, &self.names, &key, "1m", from, until).await
        }
        .boxed_local()
    }

    fn kline_source(&self) -> Arc<dyn KlineSource> {
        Arc::new(klines::KlineProxy::new(&self.base, self.names.clone()))
    }

    fn rest_bans(&self) -> Vec<RestBan> {
        vec![self.client.pace.ban()]
    }

    /// None: an address is all reading an account takes.
    fn credentials(&self, cfg: &AccountCfg) -> Result<Option<Rc<Credentials>>, String> {
        address(cfg).map(|_| None)
    }

    fn start_accounts(&self, accounts: &[AccountRef], transfers: &TransfersRef, _day_start: Rc<Cell<i64>>) -> Vec<JoinHandle<()>> {
        let mut tasks = vec![];
        for (i, a) in accounts.iter().enumerate() {
            let (user, feed) = {
                let ab = a.borrow();
                (address(&ab.cfg), ab.rest_feed.clone())
            };
            let Ok(user) = user else { continue };
            tasks.extend(account::start(a, &user, &self.names, self.client.with_feed(feed), transfers, &self.ws_url, i as f64 * 3.0));
        }
        tasks
    }

    fn reader(&self, cfg: &AccountCfg) -> Result<Box<dyn AccountReader>, String> {
        Ok(Box::new(reader::Reader { read: self.client.clone(), user: address(cfg)?, names: self.names.clone() }))
    }

    /// Its maker rebates are negative fees on the fills, and it has no distributions.
    fn is_rebate(&self, _info: &str) -> bool {
        false
    }

    fn distributions<'a>(&'a self, _acct: &'a AccountRef, _from: i64, _to: i64) -> Reply<'a, Vec<(String, Dividend)>> {
        async move { Ok(vec![]) }.boxed_local()
    }
}
