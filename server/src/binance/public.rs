//! Binance's public market data: what it lists, books and marks, as it sends them.
use std::borrow::Cow;
use std::cell::RefCell;
use std::collections::HashMap;
use std::fmt;
use std::rc::Rc;

use serde::Deserialize;
use serde::de::{self, Deserializer, Visitor};

use crate::accounts::MarketRef;
use crate::connector::PublicFeed;
use crate::feeds::FeedRef;
use crate::market::{Book, Inst, Mark, Market, SymbolInfo};
use crate::protocol::Venue;

use super::ws::{SPOT_STREAM, StreamMux, USDM_MARKET, USDM_PUBLIC};

fn truthy(v: &serde_json::Value) -> bool {
    match v {
        serde_json::Value::Null => false,
        serde_json::Value::String(s) => !s.is_empty(),
        serde_json::Value::Number(n) => n.as_f64() != Some(0.0),
        serde_json::Value::Bool(b) => *b,
        _ => true,
    }
}

fn num(v: &serde_json::Value) -> f64 {
    match v {
        serde_json::Value::String(s) => s.trim().parse().unwrap_or(0.0),
        serde_json::Value::Number(n) => n.as_f64().unwrap_or(0.0),
        _ => 0.0,
    }
}

/// The spot order-rate limits (orders per 10 s, per day) exchangeInfo's `rateLimits` give; Binance's published
/// 100 and 200 000 until it has been read.
pub static ORDER_LIMITS: std::sync::OnceLock<(i64, i64)> = std::sync::OnceLock::new();

pub fn order_limits() -> (i64, i64) {
    *ORDER_LIMITS.get().unwrap_or(&(100, 200_000))
}

/// `rateLimits` ORDERS entries of an exchangeInfo: (orders per 10 s, orders per day), where given.
pub fn parse_order_limits(info: &serde_json::Value) -> (Option<i64>, Option<i64>) {
    let (mut s10, mut day) = (None, None);
    for r in info.get("rateLimits").and_then(|v| v.as_array()).map(Vec::as_slice).unwrap_or(&[]) {
        let g = |k: &str| r.get(k).and_then(|v| v.as_str()).unwrap_or("");
        let n = |k: &str| r.get(k).and_then(|v| v.as_i64());
        if g("rateLimitType") != "ORDERS" {
            continue;
        }
        match (g("interval"), n("intervalNum"), n("limit")) {
            ("SECOND", Some(10), Some(l)) => s10 = Some(l),
            ("DAY", Some(1), Some(l)) => day = Some(l),
            _ => {}
        }
    }
    (s10, day)
}

/// `/api/v3/exchangeInfo` or `/fapi/v1/exchangeInfo` -> trading symbols.
pub fn parse_exchange_info(info: &serde_json::Value) -> HashMap<String, SymbolInfo> {
    let mut out = HashMap::new();
    let Some(symbols) = info.get("symbols").and_then(|s| s.as_array()) else { return out };
    let st = |s: &serde_json::Value, k: &str| s.get(k).and_then(|v| v.as_str()).unwrap_or("TRADING").to_string();
    for s in symbols {
        if st(s, "status") != "TRADING" && st(s, "contractStatus") != "TRADING" {
            continue;
        }
        let mut mn = 0.0;
        for f in s.get("filters").and_then(|f| f.as_array()).map(Vec::as_slice).unwrap_or(&[]) {
            let ft = f.get("filterType").and_then(|v| v.as_str()).unwrap_or("");
            if ft == "NOTIONAL" || ft == "MIN_NOTIONAL" {
                mn = ["minNotional", "notional"]
                    .iter()
                    .filter_map(|k| f.get(*k))
                    .find(|v| truthy(v))
                    .map_or(0.0, num);
            }
        }
        let g = |k: &str| s.get(k).and_then(|v| v.as_str()).unwrap_or("").to_string();
        out.insert(g("symbol"), SymbolInfo { base: g("baseAsset"), quote: g("quoteAsset"), min_notional: mn });
    }
    out
}

/// A price as Binance sends it (a decimal string) or as a number.
fn de_px<'de, D: Deserializer<'de>>(d: D) -> Result<f64, D::Error> {
    struct V;
    impl Visitor<'_> for V {
        type Value = f64;
        fn expecting(&self, f: &mut fmt::Formatter) -> fmt::Result {
            f.write_str("a price")
        }
        fn visit_str<E: de::Error>(self, s: &str) -> Result<f64, E> {
            s.parse().map_err(E::custom)
        }
        fn visit_f64<E: de::Error>(self, v: f64) -> Result<f64, E> {
            Ok(v)
        }
        fn visit_i64<E: de::Error>(self, v: i64) -> Result<f64, E> {
            Ok(v as f64)
        }
        fn visit_u64<E: de::Error>(self, v: u64) -> Result<f64, E> {
            Ok(v as f64)
        }
    }
    d.deserialize_any(V)
}

/// Like `de_px`, with null and "" as None.
fn de_opt_px<'de, D: Deserializer<'de>>(d: D) -> Result<Option<f64>, D::Error> {
    struct V;
    impl<'de> Visitor<'de> for V {
        type Value = Option<f64>;
        fn expecting(&self, f: &mut fmt::Formatter) -> fmt::Result {
            f.write_str("a price or null")
        }
        fn visit_unit<E: de::Error>(self) -> Result<Self::Value, E> {
            Ok(None)
        }
        fn visit_none<E: de::Error>(self) -> Result<Self::Value, E> {
            Ok(None)
        }
        fn visit_some<D2: Deserializer<'de>>(self, d: D2) -> Result<Self::Value, D2::Error> {
            d.deserialize_any(V)
        }
        fn visit_str<E: de::Error>(self, s: &str) -> Result<Self::Value, E> {
            if s.is_empty() { Ok(None) } else { s.parse().map(Some).map_err(E::custom) }
        }
        fn visit_f64<E: de::Error>(self, v: f64) -> Result<Self::Value, E> {
            Ok(Some(v))
        }
        fn visit_i64<E: de::Error>(self, v: i64) -> Result<Self::Value, E> {
            Ok(Some(v as f64))
        }
        fn visit_u64<E: de::Error>(self, v: u64) -> Result<Self::Value, E> {
            Ok(Some(v as f64))
        }
    }
    d.deserialize_any(V)
}

/// bookTicker payload: symbol, best bid / ask, event time (absent on spot and REST).
#[derive(Debug, Deserialize)]
struct BookTicker<'a> {
    #[serde(borrow)]
    s: Cow<'a, str>,
    #[serde(deserialize_with = "de_px")]
    b: f64,
    #[serde(deserialize_with = "de_px")]
    a: f64,
    #[serde(rename = "E", default)]
    e: Option<i64>,
}

/// markPrice payload: mark price, funding rate ("" between fundings), next funding time.
#[derive(Debug, Deserialize)]
struct MarkPrice<'a> {
    #[serde(borrow)]
    s: Cow<'a, str>,
    #[serde(deserialize_with = "de_px")]
    p: f64,
    #[serde(default, deserialize_with = "de_opt_px")]
    r: Option<f64>,
    #[serde(rename = "T", default)]
    t: Option<i64>,
}

/// Hot path: a bookTicker payload as raw JSON (from the stream mux). Malformed payloads are dropped.
pub fn on_book_raw(m: &mut Market, venue: Venue, data: &str) {
    if let Ok(d) = sonic_rs::from_str::<BookTicker>(data) {
        m.on_book(venue, &Book::new(&d.s, d.b, d.a, d.e));
    }
}

pub fn on_mark_raw(m: &mut Market, venue: Venue, data: &str) {
    if let Ok(d) = sonic_rs::from_str::<MarkPrice>(data) {
        m.on_mark(venue, &Mark { symbol: &d.s, price: d.p, funding: d.r, next_funding: d.t.filter(|t| *t != 0) });
    }
}

/// Books and marks: one stream mux per kind of payload.
pub struct Streams {
    spot_book: Rc<RefCell<StreamMux>>,
    usdm_book: Rc<RefCell<StreamMux>>,
    usdm_mark: Rc<RefCell<StreamMux>>,
}

impl Streams {
    pub fn new(market: MarketRef) -> Self {
        let (m1, m2, m3) = (market.clone(), market.clone(), market);
        Streams {
            spot_book: Rc::new(RefCell::new(StreamMux::new(SPOT_STREAM, "spot bookTicker",
                move |_, d| on_book_raw(&mut m1.borrow_mut(), Venue::SPOT, d), 200))),
            usdm_book: Rc::new(RefCell::new(StreamMux::new(USDM_PUBLIC, "usdm bookTicker",
                move |_, d| on_book_raw(&mut m2.borrow_mut(), Venue::USDM, d), 200))),
            usdm_mark: Rc::new(RefCell::new(StreamMux::new(USDM_MARKET, "usdm markPrice",
                move |_, d| on_mark_raw(&mut m3.borrow_mut(), Venue::USDM, d), 200))),
        }
    }
}

impl PublicFeed for Streams {
    fn watch(&self, inst: &Inst) {
        let s = inst.symbol.to_lowercase();
        if inst.venue == Venue::SPOT {
            self.spot_book.borrow_mut().add([format!("{s}@bookTicker")]);
        } else {
            self.usdm_book.borrow_mut().add([format!("{s}@bookTicker")]);
            self.usdm_mark.borrow_mut().add([format!("{s}@markPrice@1s")]);
        }
    }

    fn feeds(&self) -> Vec<FeedRef> {
        [&self.spot_book, &self.usdm_book, &self.usdm_mark].iter().flat_map(|m| m.borrow().feeds()).collect()
    }

    fn stop(&self) {
        for m in [&self.spot_book, &self.usdm_book, &self.usdm_mark] {
            m.borrow_mut().stop();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn order_limits_from_exchange_info() {
        let info = serde_json::json!({"rateLimits": [
            {"rateLimitType": "REQUEST_WEIGHT", "interval": "MINUTE", "intervalNum": 1, "limit": 6000},
            {"rateLimitType": "ORDERS", "interval": "SECOND", "intervalNum": 10, "limit": 100},
            {"rateLimitType": "ORDERS", "interval": "DAY", "intervalNum": 1, "limit": 200000}]});
        assert_eq!(parse_order_limits(&info), (Some(100), Some(200_000)));
        assert_eq!(parse_order_limits(&serde_json::json!({})), (None, None));
    }

    #[test]
    fn exchange_info() {
        let v: serde_json::Value = serde_json::from_str(r#"{"symbols":[
            {"symbol":"AUSDT","status":"TRADING","baseAsset":"A","quoteAsset":"USDT","filters":[{"filterType":"NOTIONAL","minNotional":"5.00"}]},
            {"symbol":"BUSDT","status":"BREAK","baseAsset":"B","quoteAsset":"USDT","filters":[]},
            {"symbol":"DUSDT","status":"BREAK","contractStatus":"SETTLING","baseAsset":"D","quoteAsset":"USDT","filters":[]},
            {"symbol":"CUSDT","status":"TRADING","contractStatus":"TRADING","baseAsset":"C","quoteAsset":"USDT","filters":[{"filterType":"MIN_NOTIONAL","notional":"100"}]}]}"#).unwrap();
        let i = parse_exchange_info(&v);
        // kept unless both status and contractStatus say otherwise (a missing one counts as TRADING)
        assert_eq!(i.len(), 3);
        assert_eq!(i["AUSDT"], SymbolInfo::new("A", "USDT", 5.0));
        assert_eq!(i["CUSDT"].min_notional, 100.0);
    }
}
