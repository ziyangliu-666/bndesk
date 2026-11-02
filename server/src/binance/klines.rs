//! Binance's klines and trades: paced under the request-weight governor for the backfill, and a plain proxy for the
//! history page.
use std::time::Duration;

use futures_util::FutureExt;
use futures_util::future::BoxFuture;
use reqwest::header;
use tokio::time::sleep;

use crate::backfill::MAX_BARS;
use crate::connector::{Kline, KlineError, KlineSource};
use crate::params;
use crate::protocol::Venue;

use super::rest::{FAPI, Rest, SPOT};

/// Request weight per minute this task may spend, per API family.
pub fn budget(venue: &str) -> f64 {
    if venue == "spot" { 300.0 } else { 120.0 }
}

pub fn kline_weight(venue: &str, limit: i64) -> i64 {
    if venue == "spot" {
        return 2;
    }
    if limit < 100 {
        1
    } else if limit < 500 {
        2
    } else if limit <= 1000 {
        5
    } else {
        10
    }
}

fn num(v: &serde_json::Value) -> anyhow::Result<f64> {
    match v {
        serde_json::Value::String(s) => Ok(s.trim().parse()?),
        serde_json::Value::Number(n) => n.as_f64().ok_or_else(|| anyhow::anyhow!("bad number")),
        _ => anyhow::bail!("bad kline field {v}"),
    }
}

fn interval_ms(interval: &str) -> i64 {
    if interval == "1s" { 1000 } else { 60_000 }
}

/// Wait out a request's share of the budget.
async fn pace(venue: &str, weight: i64) {
    sleep(Duration::from_secs_f64(weight as f64 * 60.0 / budget(venue))).await;
}

/// (open time, open, close) of the bars of `interval` ("1s": spot only, "1m") of an instrument key ("venue:SYMBOL")
/// opening in [start, end].
pub async fn klines_iv(rest: &Rest, key: &str, interval: &str, start: i64, end: i64) -> anyhow::Result<Vec<(i64, f64, f64)>> {
    let (venue, sym) = key.split_once(':').ok_or_else(|| anyhow::anyhow!("bad key {key}"))?;
    let path = if venue == "spot" { "/api/v3/klines" } else { "/fapi/v1/klines" };
    let step = interval_ms(interval);
    let mut out = vec![];
    let mut t = start;
    while t <= end {
        let limit = MAX_BARS.min((end - t).div_euclid(step) + 1);
        let w = kline_weight(venue, limit);
        let rows: Vec<Vec<serde_json::Value>> = rest
            .get(path, &params! {"symbol" => sym, "interval" => interval, "startTime" => t, "endTime" => end, "limit" => limit}, w, false)
            .await?;
        pace(venue, w).await;
        for r in &rows {
            let ot = r.first().and_then(|x| x.as_i64()).ok_or_else(|| anyhow::anyhow!("bad kline"))?;
            let o = num(r.get(1).ok_or_else(|| anyhow::anyhow!("short kline"))?)?;
            let c = num(r.get(4).ok_or_else(|| anyhow::anyhow!("short kline"))?)?;
            out.push((ot, o, c));
        }
        if (rows.len() as i64) < limit {
            break;
        }
        t = out.last().map_or(end, |x| x.0) + step;
    }
    Ok(out)
}

/// The price of the first aggregate trade of `key` at or after `t` (within a minute).
pub async fn trade_at(rest: &Rest, key: &str, t: i64) -> anyhow::Result<Option<f64>> {
    let (venue, sym) = key.split_once(':').ok_or_else(|| anyhow::anyhow!("bad key {key}"))?;
    let (path, w) = if venue == "spot" { ("/api/v3/aggTrades", 4) } else { ("/fapi/v1/aggTrades", 20) };
    let rows: Vec<serde_json::Value> = rest
        .get(path, &params! {"symbol" => sym, "startTime" => t, "endTime" => t + 60_000, "limit" => 1}, w, false)
        .await?;
    pace(venue, w).await;
    rows.first().and_then(|r| r.get("p")).map(num).transpose()
}

/// (open time, open, close) of a USD-M symbol's 1 min mark price bars opening in [from, until].
pub async fn mark_bars(rest: &Rest, symbol: &str, from: i64, until: i64) -> anyhow::Result<Vec<(i64, f64, f64)>> {
    const MIN: i64 = 60_000;
    let mut marks = vec![];
    let mut t = from;
    while t < until {
        let q = params! {"symbol" => symbol, "interval" => "1m", "startTime" => t, "endTime" => until, "limit" => 1000};
        let rows: Vec<Vec<serde_json::Value>> = rest.get("/fapi/v1/markPriceKlines", &q, 5, false).await?;
        let n = rows.len();
        for r in rows {
            let f = |i: usize| r.get(i).and_then(|v| v.as_str()).and_then(|s| s.parse::<f64>().ok());
            if let (Some(ot), Some(o), Some(cl)) = (r.first().and_then(serde_json::Value::as_i64), f(1), f(4)) {
                marks.push((ot, o, cl));
            }
        }
        if n < 1000 {
            break;
        }
        t = marks.last().map_or(until, |x| x.0 + MIN);
    }
    Ok(marks)
}

/// `/api/klines`' source: Binance's public klines, on a pool of its own and off the desk's thread.
pub struct KlineProxy {
    http: reqwest::Client,
    spot: String,
    fapi: String,
}

impl KlineProxy {
    pub fn new() -> Self {
        Self::with_bases(SPOT, FAPI)
    }

    /// `spot` / `fapi`: base URLs of the kline endpoints (a stand-in server in tests).
    pub fn with_bases(spot: &str, fapi: &str) -> Self {
        KlineProxy { http: crate::connector::client(), spot: spot.into(), fapi: fapi.into() }
    }
}

impl Default for KlineProxy {
    fn default() -> Self {
        Self::new()
    }
}

impl KlineSource for KlineProxy {
    fn id(&self) -> &'static str {
        "binance"
    }

    fn bars<'a>(&'a self, symbol: &'a str, venue: Venue, interval: &'a str, start: i64, end: i64, limit: i64)
                -> BoxFuture<'a, Result<Vec<Kline>, KlineError>> {
        async move {
            let (base, path) = if venue == Venue::SPOT { (&self.spot, "/api/v3/klines") } else { (&self.fapi, "/fapi/v1/klines") };
            let r = self
                .http
                .get(format!("{base}{path}"))
                .query(&[("symbol", symbol), ("interval", interval), ("startTime", &start.to_string()), ("endTime", &end.to_string()),
                         ("limit", &limit.to_string())])
                .send()
                .await
                .map_err(|e| KlineError::Failed(format!("binance: {e}")))?;
            let st = r.status();
            if st.as_u16() == 429 || st.as_u16() == 418 {
                let wait = r.headers().get(header::RETRY_AFTER).and_then(|v| v.to_str().ok()?.parse::<i64>().ok()).unwrap_or(60);
                return Err(KlineError::Throttled { wait_s: wait, text: format!("binance {st}: retry in {wait} s") });
            }
            let body = r.text().await.map_err(|e| KlineError::Failed(format!("binance: {e}")))?;
            if !st.is_success() {
                let text = format!("binance {st}: {body}");
                return Err(if st.is_client_error() { KlineError::Refused(text) } else { KlineError::Failed(text) });
            }
            parse_klines(&body).map_err(|e| KlineError::Failed(format!("binance klines: {e}")))
        }
        .boxed()
    }
}

fn parse_klines(body: &str) -> anyhow::Result<Vec<Kline>> {
    let raw: Vec<Vec<serde_json::Value>> = serde_json::from_str(body)?;
    raw.iter()
        .map(|r| {
            let f = |i: usize| r.get(i).ok_or_else(|| anyhow::anyhow!("short kline")).and_then(num);
            let t = r.first().and_then(|x| x.as_i64()).ok_or_else(|| anyhow::anyhow!("bad kline time"))?;
            Ok((t, f(1)?, f(2)?, f(3)?, f(4)?, f(5)?))
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn kline_weights() {
        assert_eq!(kline_weight("spot", 1000), 2);
        assert_eq!((kline_weight("usdm", 99), kline_weight("usdm", 100), kline_weight("usdm", 500)), (1, 2, 5));
        assert_eq!((kline_weight("usdm", 1000), kline_weight("usdm", 1001)), (5, 10));
    }
}
