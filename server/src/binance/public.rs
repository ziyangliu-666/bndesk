//! Binance's public market data: what it lists.
use std::collections::HashMap;

use crate::market::SymbolInfo;

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
