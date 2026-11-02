//! Hyperliquid's candles and 24 h figures. `/api/klines` and `/api/ticker` run off the desk's thread, so this is a pool of
//! its own, and shares the names with the connector.
use std::collections::HashMap;
use std::sync::Mutex;

use futures_util::FutureExt;
use futures_util::future::BoxFuture;
use serde_json::{Value, json};

use crate::clock::now_ms;
use crate::connector::{Kline, KlineError, KlineSource, RestError, Ticker};
use crate::protocol::Venue;

use super::names::NamesRef;
use super::rest::{Info, Reads, post_read, refusal};

/// Candles a response carries at most.
const PAGE: usize = 5000;
const TICKER_S: i64 = 5;
const RANGE_S: i64 = 60;
const DAY: i64 = 86_400_000;

fn px(c: &Value, k: &str) -> Option<f64> {
    match c.get(k)? {
        Value::String(s) => s.parse().ok(),
        v => v.as_f64(),
    }
}

/// `candleSnapshot` -> bars: prices are strings there, as the exchange answered on 2026-11-02, numbers in its docs.
pub fn parse_candles(rows: &Value) -> Vec<Kline> {
    rows.as_array()
        .into_iter()
        .flatten()
        .filter_map(|c| Some((c.get("t")?.as_i64()?, px(c, "o")?, px(c, "h")?, px(c, "l")?, px(c, "c")?, px(c, "v")?)))
        .collect()
}

pub fn candle_read(coin: &str, interval: &str, start: i64, end: i64) -> Value {
    json!({"type": "candleSnapshot", "req": {"coin": coin, "interval": interval, "startTime": start, "endTime": end}})
}

/// (open time, open, close) of the bars of `interval` of a desk symbol opening in [start, end]. It has no 1 s bars, and
/// answers for the last 5000 of an interval only.
pub async fn bars(info: &Info, names: &NamesRef, key: &str, interval: &str, start: i64, end: i64) -> anyhow::Result<Vec<(i64, f64, f64)>> {
    let (venue, symbol) = key.split_once(':').ok_or_else(|| anyhow::anyhow!("bad key {key}"))?;
    let none = || RestError { status: 400, body: format!("no {interval} bars of {key}") };
    let venue: Venue = venue.parse().map_err(|e: String| anyhow::anyhow!(e))?;
    let coin = names.read().expect("names").coin(symbol, venue).map(String::from).ok_or_else(none)?;
    if interval != "1m" {
        return Err(none().into());
    }
    let mut out = vec![];
    let mut t = start;
    while t <= end {
        let rows = parse_candles(&info.read(candle_read(&coin, interval, t, end)).await?);
        let n = rows.len();
        out.extend(rows.iter().map(|k| (k.0, k.1, k.4)));
        if n < PAGE {
            break;
        }
        t = out.last().map_or(end, |x| x.0) + 60_000;
    }
    Ok(out)
}

#[derive(Default)]
struct Cached {
    /// asked at, and desk symbol's (market, symbol) -> (mark, previous day's price, base volume, notional)
    ctxs: (i64, HashMap<(Venue, String), (f64, f64, f64, f64)>),
    /// each instrument's asked at, high, low
    ranges: HashMap<(Venue, String), (i64, f64, f64)>,
}

pub struct KlineProxy {
    http: reqwest::Client,
    base: String,
    names: NamesRef,
    cached: Mutex<Cached>,
}

impl KlineProxy {
    pub fn new(base: &str, names: NamesRef) -> Self {
        KlineProxy { http: crate::connector::client(), base: base.into(), names, cached: Mutex::default() }
    }

    async fn read(&self, body: &Value) -> Result<Value, KlineError> {
        let failed = |e: String| KlineError::Failed(format!("hyperliquid: {e}"));
        let (status, bytes) = post_read(&self.http, &self.base, body).await.map_err(|e| failed(e.to_string()))?;
        if status == 429 {
            return Err(KlineError::Throttled { wait_s: 60, text: "hyperliquid 429: retry in 60 s".into() });
        }
        if status >= 400 {
            let e = refusal(status, &bytes);
            return Err(if e.status == 400 { KlineError::Refused(e.to_string()) } else { failed(e.to_string()) });
        }
        serde_json::from_slice(&bytes).map_err(|e| failed(e.to_string()))
    }

    /// Every instrument's day figures: both lists, at most every few seconds whatever the number of pages asking.
    async fn refresh_ctxs(&self, now: i64) -> Result<(), KlineError> {
        if now - self.cached.lock().expect("cache").ctxs.0 < TICKER_S * 1000 {
            return Ok(());
        }
        let perps = self.read(&json!({"type": "metaAndAssetCtxs"})).await?;
        let spots = self.read(&json!({"type": "spotMetaAndAssetCtxs"})).await?;
        let mut by = HashMap::new();
        let names = self.names.read().expect("names");
        let row = |c: &Value| Some((px(c, "markPx")?, px(c, "prevDayPx")?, px(c, "dayBaseVlm")?, px(c, "dayNtlVlm")?));
        let universe = perps.get(0).and_then(|m| m.get("universe")).and_then(Value::as_array);
        let ctxs = perps.get(1).and_then(Value::as_array);
        for (u, c) in universe.into_iter().flatten().zip(ctxs.into_iter().flatten()) {
            if let (Some((symbol, venue)), Some(r)) = (u.get("name").and_then(Value::as_str).and_then(|n| names.symbol(n)), row(c)) {
                by.insert((venue, symbol.to_string()), r);
            }
        }
        for c in spots.get(1).and_then(Value::as_array).into_iter().flatten() {
            if let (Some((symbol, venue)), Some(r)) = (c.get("coin").and_then(Value::as_str).and_then(|n| names.symbol(n)), row(c)) {
                by.insert((venue, symbol.to_string()), r);
            }
        }
        drop(names);
        self.cached.lock().expect("cache").ctxs = (now, by);
        Ok(())
    }

    /// The day's high and low from hourly candles: the day figures do not say them.
    async fn range(&self, coin: &str, key: &(Venue, String), now: i64) -> Result<(f64, f64), KlineError> {
        if let Some(r) = self.cached.lock().expect("cache").ranges.get(key).filter(|r| now - r.0 < RANGE_S * 1000) {
            return Ok((r.1, r.2));
        }
        let rows = parse_candles(&self.read(&candle_read(coin, "1h", now - DAY, now)).await?);
        let high = rows.iter().map(|k| k.2).fold(f64::NEG_INFINITY, f64::max);
        let low = rows.iter().map(|k| k.3).fold(f64::INFINITY, f64::min);
        self.cached.lock().expect("cache").ranges.insert(key.clone(), (now, high, low));
        Ok((high, low))
    }
}

impl KlineSource for KlineProxy {
    fn id(&self) -> &'static str {
        "hyperliquid"
    }

    fn bars<'a>(&'a self, symbol: &'a str, venue: Venue, interval: &'a str, start: i64, end: i64, _limit: i64)
                -> BoxFuture<'a, Result<Vec<Kline>, KlineError>> {
        async move {
            let coin = self.names.read().expect("names").coin(symbol, venue).map(String::from);
            let coin = coin.ok_or_else(|| KlineError::Refused(format!("{venue}:{symbol} is not listed")))?;
            Ok(parse_candles(&self.read(&candle_read(&coin, interval, start, end)).await?))
        }
        .boxed()
    }

    fn ticker<'a>(&'a self, symbol: &'a str, venue: Venue) -> BoxFuture<'a, Result<Option<Ticker>, KlineError>> {
        async move {
            let now = now_ms();
            let coin = self.names.read().expect("names").coin(symbol, venue).map(String::from);
            let coin = coin.ok_or_else(|| KlineError::Refused(format!("{venue}:{symbol} is not listed")))?;
            self.refresh_ctxs(now).await?;
            let key = (venue, symbol.to_string());
            let row = self.cached.lock().expect("cache").ctxs.1.get(&key).copied();
            let Some((last, open, volume, quote_volume)) = row else { return Ok(None) };
            let (high, low) = self.range(&coin, &key, now).await?;
            let some = |x: f64| x.is_finite().then_some(x);
            Ok(Some(Ticker { last, open, high: some(high.max(last)), low: some(low.min(last)), volume, quote_volume, t: now }))
        }
        .boxed()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn candles_as_the_exchange_sent_them_and_as_its_docs_say() {
        let rows = json!([
            {"t": 1793598960000i64, "T": 1793599019999i64, "s": "BTC", "i": "1m", "o": "78353.0", "c": "78348.0", "h": "78358.0", "l": "78343.0", "v": "20.21322", "n": 116},
            {"t": 60000, "T": 119999, "s": "BTC", "i": "1m", "o": 1.5, "c": 2.5, "h": 3.0, "l": 1.0, "v": 4.0, "n": 1},
        ]);
        assert_eq!(parse_candles(&rows), [(1793598960000, 78353.0, 78358.0, 78343.0, 78348.0, 20.21322), (60000, 1.5, 3.0, 1.0, 2.5, 4.0)]);
    }
}
