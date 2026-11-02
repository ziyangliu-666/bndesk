//! Binance: request-weight governor, REST and WebSocket clients, and everything read from its JSON.
pub mod weight;
pub mod rest;
pub mod ws;
pub mod json;
pub mod events;
pub mod public;
pub mod klines;
pub mod reader;
pub mod account;

use std::cell::Cell;
use std::rc::Rc;
use std::sync::Arc;

use futures_util::FutureExt;
use serde_json::Value;
use tokio::task::JoinHandle;

use crate::accounts::{AccountRef, Dividend, MarketRef, TransfersRef};
use crate::config::AccountCfg;
use crate::connector::{AccountReader, Connector, KlineSource, PublicFeed, Reply, RestBan};
use crate::feeds::FeedRef;
use crate::market::Info;
use crate::protocol::Venue;
use crate::sign::Credentials;

use rest::{ALLOWED_WRITES, Rest, governors};
use weight::Governors;

/// Binance's spot and USD-M markets on one IP: one pool, one pair of request-weight governors.
pub struct Binance {
    http: reqwest::Client,
    govs: Governors,
    public: Rest,
}

impl Binance {
    pub fn new(http: reqwest::Client, feed: Option<FeedRef>) -> Self {
        let govs = governors();
        Binance { public: Rest::new(http.clone(), govs.clone(), None, feed), http, govs }
    }

    fn rest(&self, creds: Option<Rc<Credentials>>, feed: FeedRef) -> Rest {
        Rest::new(self.http.clone(), self.govs.clone(), creds, Some(feed))
    }
}

impl Connector for Binance {
    fn id(&self) -> &'static str {
        "binance"
    }

    fn markets(&self) -> Vec<Venue> {
        vec![Venue::SPOT, Venue::USDM]
    }

    fn allowed_writes(&self) -> &'static [(&'static str, &'static str)] {
        &ALLOWED_WRITES
    }

    fn sync_clock(&self) -> Reply<'_, ()> {
        rest::sync_time(&self.public).boxed_local()
    }

    fn keep_clock(&self) -> futures_util::future::LocalBoxFuture<'static, ()> {
        let rest = self.public.clone();
        async move {
            loop {
                tokio::select! {
                    _ = tokio::time::sleep(std::time::Duration::from_secs(600)) => {}
                    _ = rest::RESYNC.notified() => {}
                }
                if let Err(e) = rest::sync_time(&rest).await {
                    tracing::warn!("time sync failed: {e:#}");   // keep the last offset
                }
            }
        }
        .boxed_local()
    }

    fn instruments(&self) -> Reply<'_, Info> {
        async move {
            let spot: Value = self.public.get("/api/v3/exchangeInfo", &[], 20, false).await?;
            let usdm: Value = self.public.get("/fapi/v1/exchangeInfo", &[], 1, false).await?;
            let mut info = Info::new();
            info.insert(Venue::SPOT, public::parse_exchange_info(&spot));
            if let (Some(s10), Some(day)) = public::parse_order_limits(&spot) {
                let _ = public::ORDER_LIMITS.set((s10, day));
                tracing::info!("spot order limits from exchangeInfo: {s10} per 10 s, {day} per day");
            }
            info.insert(Venue::USDM, public::parse_exchange_info(&usdm));
            Ok(info)
        }
        .boxed_local()
    }

    fn public_feed(&self, market: MarketRef) -> Rc<dyn PublicFeed> {
        Rc::new(public::Streams::new(market))
    }

    fn book_tops(&self, venue: Venue) -> Reply<'_, Vec<(String, f64, f64)>> {
        async move {
            let (path, weight) = if venue == Venue::SPOT { ("/api/v3/ticker/bookTicker", 4) } else { ("/fapi/v1/ticker/bookTicker", 5) };
            let rows: Vec<Value> = self.public.get(path, &[], weight, false).await?;
            Ok(rows
                .iter()
                .filter_map(|r| {
                    let num = |k: &str| r.get(k).and_then(Value::as_str).and_then(|s| s.parse::<f64>().ok()).unwrap_or(0.0);
                    Some((r.get("symbol")?.as_str()?.to_string(), num("bidPrice"), num("askPrice")))
                })
                .collect())
        }
        .boxed_local()
    }

    fn bars<'a>(&'a self, key: &'a str, interval: &'a str, start: i64, end: i64) -> Reply<'a, Vec<(i64, f64, f64)>> {
        klines::klines_iv(&self.public, key, interval, start, end).boxed_local()
    }

    fn trade_at<'a>(&'a self, key: &'a str, t: i64) -> Reply<'a, Option<f64>> {
        klines::trade_at(&self.public, key, t).boxed_local()
    }

    fn mark_bars<'a>(&'a self, symbol: &'a str, from: i64, until: i64) -> Reply<'a, Vec<(i64, f64, f64)>> {
        klines::mark_bars(&self.public, symbol, from, until).boxed_local()
    }

    fn kline_source(&self) -> Arc<dyn KlineSource> {
        Arc::new(klines::KlineProxy::new())
    }

    fn rest_bans(&self) -> Vec<RestBan> {
        self.govs
            .iter()
            .map(|g| RestBan { name: g.name.clone(), banned: g.banned(), last: g.last_ban.get(), until_s: g.banned_until.get() })
            .collect()
    }

    fn credentials(&self, cfg: &AccountCfg) -> Result<Rc<Credentials>, String> {
        crate::sign::credentials(&cfg.api_key_env, &cfg.private_key_env, &cfg.secret_env).map(Rc::new)
    }

    fn start_accounts(&self, accounts: &[AccountRef], transfers: &TransfersRef, day_start: Rc<Cell<i64>>) -> Vec<JoinHandle<()>> {
        let mut tasks = vec![];
        let master = transfers.borrow().master.clone();
        let master_creds = master.as_ref().and_then(|m| m.borrow().creds.clone());
        for (i, a) in accounts.iter().enumerate() {
            let (via, creds, feed) = {
                let ab = a.borrow();
                (ab.via_master, ab.creds.clone(), ab.rest_feed.clone())
            };
            if via && let Some(mc) = &master_creds {
                tasks.extend(account::start_via_master(a, self.rest(Some(mc.clone()), feed), i as f64 * 3.0));
            } else {
                tasks.extend(account::start(a, self.rest(creds, feed)));
            }
        }
        if let Some(mc) = master_creds {
            let feed = transfers.borrow().feed.clone();
            let rest = self.rest(Some(mc), feed);
            tasks.push(tokio::task::spawn_local(account::run_transfers(transfers.clone(), rest, move || day_start.get())));
        }
        tasks
    }

    fn reader(&self, cfg: &AccountCfg) -> Result<Box<dyn AccountReader>, String> {
        let creds = self.credentials(cfg)?;
        Ok(Box::new(reader::Reader(Rest::new(self.http.clone(), governors(), Some(creds), None))))
    }

    fn is_rebate(&self, info: &str) -> bool {
        account::is_rebate(info)
    }

    fn distributions<'a>(&'a self, acct: &'a AccountRef, from: i64, to: i64) -> Reply<'a, Vec<(String, Dividend)>> {
        async move {
            let rest = {
                let a = acct.borrow();
                self.rest(a.creds.clone(), a.rest_feed.clone())
            };
            account::distributions(&rest, from, to).await
        }
        .boxed_local()
    }
}
