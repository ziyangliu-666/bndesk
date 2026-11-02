//! Hyperliquid's reads: all of them a POST to `/info` with a `type`, none of them signed. So what makes this client
//! read-only is not the method: it knows one path and a list of types, and what it refuses never leaves the process.
//! Trading is `POST /exchange` with a signature from the account's wallet; no address here reaches that path and nothing
//! in this directory can sign.
use std::cell::Cell;
use std::future::Future;
use std::rc::Rc;
use std::time::Duration;

use anyhow::Result;
use reqwest::Method;
use serde_json::Value;

use crate::clock::{TimeSync, now_s};
use crate::connector::{PermissionError, RestBan, RestError};
use crate::feeds::FeedRef;

/// Hyperliquid's time, as `exchangeStatus` tells it.
pub static CLOCK: TimeSync = TimeSync::new();

pub const BASE: &str = "https://api.hyperliquid.xyz";
pub const WS_URL: &str = "wss://api.hyperliquid.xyz/ws";
pub const PATH: &str = "/info";

/// Every `type` this client asks, with its published request weight.
pub const READS: [(&str, i64); 13] = [
    ("exchangeStatus", 2),
    ("metaAndAssetCtxs", 20),
    ("spotMetaAndAssetCtxs", 20),
    ("l2Book", 2),
    ("candleSnapshot", 20),
    ("clearinghouseState", 2),
    ("spotClearinghouseState", 2),
    ("frontendOpenOrders", 20),
    ("userFillsByTime", 20),
    ("userFunding", 20),
    ("userNonFundingLedgerUpdates", 20),
    ("userFees", 20),
    ("userAbstraction", 20),
];

/// Weight per minute the exchange allows an IP, of which this client uses half.
const LIMIT: i64 = 1200;

/// A read, or it does not go out.
pub fn check_read(path: &str, body: &Value) -> Result<i64, PermissionError> {
    let ty = body.get("type").and_then(Value::as_str).unwrap_or("");
    if path != PATH {
        return Err(PermissionError(format!("POST {path}")));
    }
    if ["action", "signature", "nonce"].iter().any(|k| body.get(k).is_some()) {
        return Err(PermissionError(format!("POST {path}: a signed body")));
    }
    READS.iter().find(|r| r.0 == ty).map(|r| r.1).ok_or_else(|| PermissionError(format!("POST {path} of type {ty:?}")))
}

/// The one request this client can make, off the desk's thread or on it. (status, body).
pub async fn post_read(http: &reqwest::Client, base: &str, body: &Value) -> Result<(u16, Vec<u8>)> {
    check_read(PATH, body)?;
    let r = http.request(Method::POST, format!("{base}{PATH}")).header("content-type", "application/json").body(body.to_string()).send().await?;
    let status = r.status().as_u16();
    Ok((status, r.bytes().await?.to_vec()))
}

/// What a refused read means. It answers 422 to a type or interval it does not have and 500 with a body of `null` to a
/// coin it does not list: `RestError` 400 is what the desk reads as "none, for good".
pub fn refusal(status: u16, body: &[u8]) -> RestError {
    let text = String::from_utf8_lossy(body).into_owned();
    let none = status == 422 || (status == 500 && text.trim() == "null");
    RestError { status: if none { 400 } else { status }, body: text }
}

/// Weight spent this minute against half the limit, and the pause a 429 asks for. The exchange sends no count of its own.
#[derive(Debug, Default)]
pub struct Pace {
    minute: Cell<i64>,
    used: Cell<i64>,
    until: Cell<f64>,
    last: Cell<Option<(u16, f64)>>,
}

impl Pace {
    fn delay(&self, weight: i64, now: f64) -> f64 {
        if now < self.until.get() {
            return self.until.get() - now;
        }
        let m = (now / 60.0).floor() as i64;
        if m != self.minute.get() {
            self.minute.set(m);
            self.used.set(0);
        }
        if self.used.get() + weight > LIMIT / 2 { ((m + 1) * 60) as f64 - now + 0.05 } else { 0.0 }
    }

    async fn acquire(&self, weight: i64) {
        loop {
            let d = self.delay(weight, now_s());
            if d <= 0.0 {
                break;
            }
            tokio::time::sleep(Duration::from_secs_f64(d)).await;
        }
        self.used.set(self.used.get() + weight);
    }

    fn banned(&self, status: u16, now: f64) {
        self.until.set(self.until.get().max(now + 60.0));
        self.last.set(Some((status, now)));
    }

    pub fn ban(&self) -> RestBan {
        RestBan { name: "hyperliquid".into(), banned: now_s() < self.until.get(), last: self.last.get(), until_s: self.until.get() }
    }
}

/// The reads an account's passes make (a fake in tests).
pub trait Reads {
    fn read(&self, body: Value) -> impl Future<Output = Result<Value>>;
}

/// The client: one IP's pool and pace; `feed`, what its requests count on.
#[derive(Clone)]
pub struct Info {
    http: reqwest::Client,
    base: Rc<str>,
    pub pace: Rc<Pace>,
    pub feed: Option<FeedRef>,
}

impl Info {
    pub fn new(http: reqwest::Client, base: &str, feed: Option<FeedRef>) -> Self {
        Info { http, base: base.into(), pace: Rc::default(), feed }
    }

    pub fn with_feed(&self, feed: FeedRef) -> Self {
        Info { feed: Some(feed), ..self.clone() }
    }
}

impl Reads for Info {
    async fn read(&self, body: Value) -> Result<Value> {
        let weight = check_read(PATH, &body)?;
        self.pace.acquire(weight).await;
        let (status, bytes) = post_read(&self.http, &self.base, &body).await?;
        if let Some(f) = &self.feed {
            f.borrow_mut().hit(1);
        }
        if status == 429 {
            self.pace.banned(status, now_s());
        }
        if status >= 400 {
            return Err(refusal(status, &bytes).into());
        }
        let v: Value = serde_json::from_slice(&bytes)?;
        // the published extra: a request is worth more the more it brings back
        if let Some(n) = v.as_array().map(Vec::len) {
            self.pace.used.set(self.pace.used.get() + n as i64 / 20);
        }
        Ok(v)
    }
}

/// The offset from the fastest of five round trips, as Binance's connector takes its own.
pub async fn sync_time(info: &impl Reads) -> Result<()> {
    let mut best: Option<(f64, f64)> = None;
    for _ in 0..5 {
        let t0 = now_s() * 1000.0;
        let r = info.read(serde_json::json!({"type": "exchangeStatus"})).await?;
        let t1 = now_s() * 1000.0;
        let server = r.get("time").and_then(Value::as_f64).ok_or_else(|| anyhow::anyhow!("exchangeStatus: no time"))?;
        if best.is_none_or(|(rtt, _)| t1 - t0 < rtt) {
            best = Some((t1 - t0, server - (t0 + t1) / 2.0));
        }
    }
    let (rtt, offset) = best.expect("five samples");
    anyhow::ensure!(rtt < 1000.0, "time sync: fastest round trip {rtt:.0} ms");
    CLOCK.set_offset_ms(offset as i64);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn only_the_listed_reads_go_out() {
        assert_eq!(check_read("/info", &json!({"type": "l2Book", "coin": "BTC"})).unwrap(), 2);
        for (path, body) in [
            ("/exchange", json!({"type": "l2Book"})),
            ("/info", json!({"type": "order"})),
            ("/info", json!({})),
            ("/info", json!({"type": "l2Book", "signature": {}})),
            ("/info", json!({"type": "l2Book", "action": {"type": "order"}})),
        ] {
            assert!(check_read(path, &body).is_err(), "{path} {body}");
        }
    }

    #[test]
    fn what_it_answers_for_nothing_reads_as_nothing() {
        assert_eq!(refusal(500, b"null").status, 400);
        assert_eq!(refusal(422, b"Failed to deserialize").status, 400);
        assert_eq!(refusal(500, b"oops").status, 500);
        assert_eq!(refusal(429, b"").status, 429);
    }

    #[test]
    fn pace_stays_under_half_and_stops_on_429() {
        let p = Pace::default();
        assert_eq!(p.delay(600, 60.0), 0.0);
        p.used.set(600);
        assert!((p.delay(2, 61.0) - 59.05).abs() < 1e-9);
        assert_eq!(p.delay(2, 120.0), 0.0);
        p.banned(429, 121.0);
        assert_eq!(p.delay(2, 121.0), 60.0);
        assert_eq!(p.ban().last, Some((429, 121.0)));
    }
}
