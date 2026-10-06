//! Read-only REST client: refuses every write except the USD-M listenKey.
use std::rc::Rc;
use std::time::Duration;

use reqwest::Method;
use serde::de::DeserializeOwned;

pub use crate::clock::{CLOCK, TimeSync};
use crate::clock::now_s;
use crate::feeds::FeedRef;

use super::sign::{Credentials, query, quote};
use super::weight::{Governor, Governors};

pub const SPOT: &str = "https://api.binance.com";
pub const FAPI: &str = "https://fapi.binance.com";

/// The only non-GET calls the monitor makes: creating and keeping alive a USD-M listen key.
pub const ALLOWED_WRITES: [(&str, &str); 2] = [("POST", "/fapi/v1/listenKey"), ("PUT", "/fapi/v1/listenKey")];

#[derive(Debug, thiserror::Error)]
#[error("HTTP {status}: {}", body.chars().take(200).collect::<String>())]
pub struct RestError {
    pub status: u16,
    pub body: String,
}

/// Python's PermissionError for a write the read-only monitor refuses.
#[derive(Debug, thiserror::Error)]
#[error("read-only monitor refuses {0}")]
pub struct PermissionError(pub String);

pub fn governors() -> Governors {
    Governors { spot: Rc::new(Governor::new("spot", 6000, 0.5)), usdm: Rc::new(Governor::new("usdm", 2400, 0.5)) }
}

pub fn check_method(method: &str, path: &str) -> Result<(), PermissionError> {
    if method != "GET" && !ALLOWED_WRITES.contains(&(method, path)) {
        return Err(PermissionError(format!("{method} {path}")));
    }
    Ok(())
}

/// Request parameters in order: (name, value already formatted).
pub type Params = Vec<(String, String)>;

/// Build `Params` from `name => value` pairs with any `Display` values.
#[macro_export]
macro_rules! params {
    ($($k:expr => $v:expr),* $(,)?) => {
        vec![$(($k.to_string(), $v.to_string())),*] as $crate::binance::rest::Params
    };
}

/// A REST client for one key (or none) on one IP: shares the IP's governors and the HTTP pool.
#[derive(Clone)]
pub struct Rest {
    pub client: reqwest::Client,
    pub govs: Governors,
    pub creds: Option<Rc<Credentials>>,
    pub feed: Option<FeedRef>,
}

pub fn client() -> reqwest::Client {
    reqwest::Client::builder()
        .timeout(Duration::from_secs(15))
        .pool_idle_timeout(Duration::from_secs(90))
        .tcp_nodelay(true)
        .build()
        .expect("reqwest client")
}

impl Rest {
    pub fn new(client: reqwest::Client, govs: Governors, creds: Option<Rc<Credentials>>, feed: Option<FeedRef>) -> Self {
        Rest { client, govs, creds, feed }
    }

    pub async fn get<T: DeserializeOwned>(&self, path: &str, params: &[(String, String)], weight: i64, signed: bool) -> anyhow::Result<T> {
        self.request("GET", path, params, weight, signed).await
    }

    /// POST (create) or PUT (keep alive) the USD-M listen key.
    pub async fn listen_key<T: DeserializeOwned>(&self, method: &str) -> anyhow::Result<T> {
        self.request(method, "/fapi/v1/listenKey", &[], 1, false).await
    }

    async fn request<T: DeserializeOwned>(&self, method: &str, path: &str, params: &[(String, String)], weight: i64, signed: bool) -> anyhow::Result<T> {
        check_method(method, path)?;
        let fut = path.starts_with("/fapi");
        let gov = self.govs.get(fut);
        gov.acquire(weight).await;
        let qs = if signed {
            let creds = self.creds.as_ref().ok_or_else(|| anyhow::anyhow!("signed {path} without credentials"))?;
            let mut p: Vec<(&str, String)> = params.iter().map(|(k, v)| (k.as_str(), v.clone())).collect();
            p.push(("recvWindow", "10000".into()));
            p.push(("timestamp", CLOCK.now().to_string()));
            let qs = query(&p);
            let sig = quote(&creds.signer.sign(&qs), "");
            format!("{qs}&signature={sig}")
        } else {
            query(params)
        };
        let mut url = String::with_capacity(64 + qs.len());
        url.push_str(if fut { FAPI } else { SPOT });
        url.push_str(path);
        if !qs.is_empty() {
            url.push('?');
            url.push_str(&qs);
        }
        let method = Method::from_bytes(method.as_bytes())?;
        let mut req = self.client.request(method, url);
        if let Some(c) = &self.creds {
            req = req.header("X-MBX-APIKEY", &c.api_key);
        }
        let r = req.send().await?;
        let status = r.status().as_u16();
        gov.update(status, r.headers().iter().map(|(k, v)| (k.as_str(), v.to_str().unwrap_or(""))), Some(now_s()));
        let body = r.bytes().await?;
        if let Some(f) = &self.feed {
            f.borrow_mut().hit(1);
        }
        if status >= 400 {
            return Err(RestError { status, body: String::from_utf8_lossy(&body).into_owned() }.into());
        }
        Ok(serde_json::from_slice(&body)?)
    }
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct ServerTime {
    server_time: f64,
}

pub async fn sync_time(rest: &Rest) -> anyhow::Result<()> {
    let t0 = now_s() * 1000.0;
    let r: ServerTime = rest.get("/api/v3/time", &[], 1, false).await?;
    let t1 = now_s() * 1000.0;
    CLOCK.set_offset_ms((r.server_time - (t0 + t1) / 2.0) as i64);
    Ok(())
}
