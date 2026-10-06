//! Books, mids, fair values and price rings per instrument.
use std::borrow::Cow;
use std::collections::HashMap;
use std::fmt;

use rustc_hash::FxHashMap;
use serde::de::{self, Deserializer, Visitor};
use serde::Deserialize;

use crate::clock::{CLOCK, now_ms};
pub use crate::protocol::Venue;

pub const QUOTE: &str = "USDT";
pub const STABLES: [&str; 8] = ["USDT", "USDC", "FDUSD", "TUSD", "USDP", "DAI", "BUSD", "USD1"];

pub fn key(symbol: &str, venue: Venue) -> String {
    format!("{venue}:{symbol}")
}

#[derive(Debug, Clone, PartialEq)]
pub struct SymbolInfo {
    pub base: String,
    pub quote: String,
    pub min_notional: f64,
}

impl SymbolInfo {
    pub fn new(base: &str, quote: &str, min_notional: f64) -> Self {
        SymbolInfo { base: base.into(), quote: quote.into(), min_notional }
    }
}

/// Exchange info per venue: venue -> symbol -> info.
pub type Info = HashMap<Venue, HashMap<String, SymbolInfo>>;

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

/// Mid as of each second of exchange time over the last N seconds (last tick in that second).
#[derive(Debug, Clone)]
pub struct MidRing {
    secs: Box<[i64]>,
    mids: Box<[f64]>,
    pub last: i64,
}

impl Default for MidRing {
    fn default() -> Self {
        MidRing::new()
    }
}

impl MidRing {
    pub const N: i64 = 600;

    pub fn new() -> Self {
        MidRing { secs: vec![-1; Self::N as usize].into(), mids: vec![0.0; Self::N as usize].into(), last: -1 }
    }

    pub fn put(&mut self, t_ms: i64, mid: f64) {
        let s = t_ms.div_euclid(1000);
        if s < self.last {
            return;
        }
        let i = s.rem_euclid(Self::N) as usize;
        self.secs[i] = s;
        self.mids[i] = mid;
        self.last = s;
    }

    pub fn at(&self, t_ms: i64) -> Option<f64> {
        let mut s = t_ms.div_euclid(1000).min(self.last);
        let lo = (self.last - Self::N).max(-1);
        while s > lo {
            let i = s.rem_euclid(Self::N) as usize;
            if self.secs[i] == s {
                return Some(self.mids[i]);
            }
            s -= 1;
        }
        None
    }
}

/// Every mid change of one instrument at ms resolution over the last KEEP_MS (bounded: older ticks
/// are compacted away, keeping the last one before the window so lookups at its edge still resolve).
#[derive(Debug, Clone, Default)]
pub struct FineRing {
    pub t: Vec<i64>,
    pub v: Vec<f64>,
}

impl FineRing {
    pub const KEEP_MS: i64 = 420_000;

    pub fn put(&mut self, mut t_ms: i64, mid: f64) {
        if let (Some(&lt), Some(&lv)) = (self.t.last(), self.v.last()) {
            if mid == lv {
                return;
            }
            if t_ms < lt {
                t_ms = lt;
            }
        }
        self.t.push(t_ms);
        self.v.push(mid);
        let n = self.t.len();
        if n >= 4096 && self.t[n / 2] < t_ms - Self::KEEP_MS {
            let cut = self.t.partition_point(|&x| x <= t_ms - Self::KEEP_MS) - 1;
            self.t.drain(..cut);
            self.v.drain(..cut);
        }
    }

    /// Last mid at or before t_ms.
    pub fn at(&self, t_ms: i64) -> Option<f64> {
        let i = self.t.partition_point(|&x| x <= t_ms);
        (i > 0).then(|| self.v[i - 1])
    }

    pub fn len(&self) -> usize {
        self.t.len()
    }

    pub fn is_empty(&self) -> bool {
        self.t.is_empty()
    }
}

/// Index of an instrument in `Market::insts` (stable for the process lifetime).
pub type InstId = usize;

#[derive(Debug, Clone)]
pub struct Inst {
    pub id: InstId,
    pub symbol: String,
    pub venue: Venue,
    pub key: String,
    pub base: String,
    pub quote: String,
    pub min_notional: f64,
    /// The reference instrument (Python `ref`, a key there).
    pub ref_: Option<InstId>,
    pub bid: f64,
    pub ask: f64,
    pub t: Option<i64>,
    pub recv: Option<i64>,
    pub created: i64,
    pub ratio: Option<f64>,
    pub good: Option<f64>,   // last mid seen with a tight book
    pub ratio_t: i64,
    pub ring: MidRing,
    pub fine: Option<FineRing>,   // kept for instruments that are another's reference
    pub mark: Option<f64>,
    pub funding: Option<f64>,
    pub next_funding: Option<i64>,
}

impl Inst {
    fn new(id: InstId, symbol: &str, venue: Venue, info: Option<&SymbolInfo>) -> Self {
        Inst {
            id,
            symbol: symbol.into(),
            venue,
            key: key(symbol, venue),
            base: info.map_or_else(|| symbol.strip_suffix(QUOTE).unwrap_or(symbol).to_string(), |i| i.base.clone()),
            quote: info.map_or_else(|| QUOTE.to_string(), |i| i.quote.clone()),
            min_notional: info.map_or(5.0, |i| i.min_notional),
            ref_: None,
            bid: 0.0,
            ask: 0.0,
            t: None,
            recv: None,
            created: now_ms(),
            ratio: None,
            good: None,
            ratio_t: 0,
            ring: MidRing::new(),
            fine: None,
            mark: None,
            funding: None,
            next_funding: None,
        }
    }

    pub fn mid(&self) -> Option<f64> {
        (self.bid > 0.0 && self.ask > 0.0).then(|| (self.bid + self.ask) / 2.0)
    }
}

pub fn ewma_ratio(prev: Option<f64>, prev_t: i64, x: f64, t: i64, halflife_s: f64) -> f64 {
    match prev {
        None => x,
        Some(prev) => {
            let a = 1.0 - 0.5f64.powf((t - prev_t).max(0) as f64 / 1000.0 / halflife_s);
            prev + a * (x - prev)
        }
    }
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
pub struct BookTicker<'a> {
    #[serde(borrow)]
    pub s: Cow<'a, str>,
    #[serde(deserialize_with = "de_px")]
    pub b: f64,
    #[serde(deserialize_with = "de_px")]
    pub a: f64,
    #[serde(rename = "E", default)]
    pub e: Option<i64>,
}

impl<'a> BookTicker<'a> {
    pub fn new(s: &'a str, b: f64, a: f64, e: Option<i64>) -> Self {
        BookTicker { s: Cow::Borrowed(s), b, a, e }
    }
}

/// markPrice payload: mark price, funding rate ("" between fundings), next funding time.
#[derive(Debug, Deserialize)]
pub struct MarkPrice<'a> {
    #[serde(borrow)]
    pub s: Cow<'a, str>,
    #[serde(deserialize_with = "de_px")]
    pub p: f64,
    #[serde(default, deserialize_with = "de_opt_px")]
    pub r: Option<f64>,
    #[serde(rename = "T", default)]
    pub t: Option<i64>,
}

pub struct Market {
    pub info: Info,
    pub halflife_s: f64,
    pub max_spread_bps: f64,   // wider books are not trusted for valuation
    /// Every instrument in creation order, indexed by `InstId`.
    pub insts: Vec<Inst>,
    by_key: HashMap<String, InstId>,
    by_sym: [FxHashMap<Box<str>, InstId>; 2],
    pub on_new: Box<dyn FnMut(&Inst)>,
}

impl Market {
    pub fn new(info: Info, halflife_s: f64, max_spread_bps: f64) -> Self {
        Market {
            info,
            halflife_s,
            max_spread_bps,
            insts: vec![],
            by_key: HashMap::new(),
            by_sym: Default::default(),
            on_new: Box::new(|_| {}),
        }
    }

    /// The instrument by key ("spot:XUSDT").
    pub fn get(&self, k: &str) -> Option<&Inst> {
        self.by_key.get(k).map(|&i| &self.insts[i])
    }

    pub fn id(&self, k: &str) -> Option<InstId> {
        self.by_key.get(k).copied()
    }

    /// The instrument by symbol and venue, without building a key.
    pub fn find(&self, symbol: &str, venue: Venue) -> Option<InstId> {
        self.by_sym[venue.index()].get(symbol).copied()
    }

    pub fn ensure(&mut self, symbol: &str, venue: Venue, ref_: Option<(&str, Venue)>) -> InstId {
        let id = match self.find(symbol, venue) {
            Some(id) => id,
            None => {
                let id = self.insts.len();
                let inst = Inst::new(id, symbol, venue, self.info.get(&venue).and_then(|m| m.get(symbol)));
                self.by_key.insert(inst.key.clone(), id);
                self.by_sym[venue.index()].insert(symbol.into(), id);
                self.insts.push(inst);
                (self.on_new)(&self.insts[id]);
                id
            }
        };
        if let Some((rs, rv)) = ref_
            && self.insts[id].ref_.is_none()
        {
            let r = self.ensure(rs, rv, None);
            self.insts[id].ref_ = Some(r);
            if self.insts[r].fine.is_none() {
                self.insts[r].fine = Some(FineRing::default());
            }
        }
        id
    }

    pub fn known(&self, symbol: &str, venue: Venue) -> bool {
        self.info.get(&venue).is_some_and(|m| m.contains_key(symbol))
    }

    pub fn asset_inst(&mut self, asset: &str) -> Option<InstId> {
        let sym = format!("{asset}{QUOTE}");
        if let Some(id) = self.find(&sym, Venue::Spot) {
            return Some(id);
        }
        self.known(&sym, Venue::Spot).then(|| self.ensure(&sym, Venue::Spot, None))
    }

    pub fn asset_price(&mut self, asset: &str) -> Option<f64> {
        if STABLES.contains(&asset) {
            return Some(1.0);
        }
        let inst = self.asset_inst(asset);
        if inst.is_none() && asset.starts_with("LD") && asset.len() > 2 {
            return self.asset_price(&asset[2..]);
        }
        inst.and_then(|i| self.px(i))
    }

    fn ref_mid(&self, inst: &Inst) -> Option<f64> {
        inst.ref_.and_then(|r| self.insts[r].mid())
    }

    /// Valuation price: the mid while the book is tight; when it gapes (a thin book whose best
    /// level just went) the reference-implied fair, else the last tight mid.
    pub fn px(&self, id: InstId) -> Option<f64> {
        let inst = &self.insts[id];
        let mid = inst.mid();
        if let Some(m) = mid
            && (inst.ask - inst.bid) / m * 1e4 <= self.max_spread_bps
        {
            return Some(m);
        }
        if let (Some(ratio), Some(rm)) = (inst.ratio, self.ref_mid(inst)) {
            return Some(rm * ratio);
        }
        inst.good.filter(|g| *g != 0.0).or(mid)
    }

    /// Hot path: a bookTicker payload as raw JSON (from the stream mux). Malformed payloads are dropped.
    pub fn on_book_raw(&mut self, venue: Venue, data: &str) {
        if let Ok(d) = sonic_rs::from_str::<BookTicker>(data) {
            self.on_book(venue, &d);
        }
    }

    pub fn on_book(&mut self, venue: Venue, d: &BookTicker) {
        let Some(id) = self.find(&d.s, venue) else { return };
        let t = d.e.unwrap_or_else(|| CLOCK.now());
        let recv = now_ms();
        let (max_spread, halflife) = (self.max_spread_bps, self.halflife_s);
        let inst = &mut self.insts[id];
        (inst.bid, inst.ask, inst.t, inst.recv) = (d.b, d.a, Some(t), Some(recv));
        let Some(mid) = inst.mid() else { return };
        let tight = (inst.ask - inst.bid) / mid * 1e4 <= max_spread;
        if tight {
            inst.good = Some(mid);
        }
        let px = self.px(id).filter(|p| *p != 0.0).unwrap_or(mid);
        let rm = self.ref_mid(&self.insts[id]);
        let inst = &mut self.insts[id];
        inst.ring.put(t, px);
        if let Some(f) = inst.fine.as_mut() {
            f.put(t, px);
        }
        if tight && let Some(rm) = rm.filter(|r| *r != 0.0) {
            inst.ratio = Some(ewma_ratio(inst.ratio, inst.ratio_t, mid / rm, t, halflife));
            inst.ratio_t = t;
        }
    }

    pub fn on_mark_raw(&mut self, data: &str) {
        if let Ok(d) = sonic_rs::from_str::<MarkPrice>(data) {
            self.on_mark(&d);
        }
    }

    pub fn on_mark(&mut self, d: &MarkPrice) {
        if let Some(id) = self.find(&d.s, Venue::Usdm) {
            let inst = &mut self.insts[id];
            inst.mark = Some(d.p);
            inst.funding = d.r;
            inst.next_funding = d.t.filter(|t| *t != 0);
        }
    }

    pub fn fair(&self, id: InstId) -> Option<f64> {
        let inst = &self.insts[id];
        if let (Some(ratio), Some(rm)) = (inst.ratio, self.ref_mid(inst)) {
            return Some(rm * ratio);
        }
        inst.mid()
    }

    pub fn mid_at(&self, k: &str, t_ms: i64) -> Option<f64> {
        self.get(k).and_then(|i| i.ring.at(t_ms))
    }

    /// The reference's mid at or before t_ms, at ms resolution.
    pub fn ref_at(&self, id: InstId, t_ms: i64) -> Option<f64> {
        let r = self.insts[id].ref_?;
        self.insts[r].fine.as_ref()?.at(t_ms)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use approx::assert_relative_eq;

    fn info(spot: &[(&str, SymbolInfo)]) -> Info {
        let mut i = Info::new();
        i.insert(Venue::Spot, spot.iter().cloned().map(|(k, v)| (k.to_string(), v)).collect());
        i.insert(Venue::Usdm, HashMap::new());
        i
    }

    fn book(m: &mut Market, venue: Venue, json: &str) {
        m.on_book_raw(venue, json);
    }

    #[test]
    fn ewma_half_life() {
        let r = ewma_ratio(None, 0, 1.0, 0, 120.0);
        assert_eq!(r, 1.0);
        let r = ewma_ratio(Some(r), 0, 2.0, 120_000, 120.0);
        assert_relative_eq!(r, 1.5);
        let r = ewma_ratio(Some(1.0), 0, 2.0, 240_000, 120.0);
        assert_relative_eq!(r, 1.75);
    }

    #[test]
    fn fair_uses_reference_times_ratio() {
        let mut m = Market::new(info(&[("XUSDT", SymbolInfo::new("X", "USDT", 5.0))]), 120.0, 100.0);
        let x = m.ensure("XUSDT", Venue::Spot, Some(("XUSDT", Venue::Usdm)));
        book(&mut m, Venue::Usdm, r#"{"s": "XUSDT", "b": "99.9", "a": "100.1", "E": 1000}"#);
        book(&mut m, Venue::Spot, r#"{"s": "XUSDT", "b": "100.9", "a": "101.1", "E": 1000}"#);
        assert_relative_eq!(m.insts[x].ratio.unwrap(), 1.01, max_relative = 1e-12);
        book(&mut m, Venue::Usdm, r#"{"s": "XUSDT", "b": "109.9", "a": "110.1", "E": 2000}"#);
        assert_relative_eq!(m.fair(x).unwrap(), 111.1, max_relative = 1e-12);
        assert_eq!(m.insts[x].base, "X");
    }

    #[test]
    fn mid_ring_carry_forward() {
        let mut r = MidRing::new();
        r.put(10_500, 1.0);
        r.put(12_200, 2.0);
        assert_eq!(r.at(10_999), Some(1.0));
        assert_eq!(r.at(11_500), Some(1.0));
        assert_eq!(r.at(12_000), Some(2.0));
        assert_eq!(r.at(9_000), None);
    }

    #[test]
    fn gaping_book_is_valued_at_fair_not_mid() {
        let mut m = Market::new(info(&[]), 120.0, 100.0);
        let tok = m.ensure("AUSDT", Venue::Spot, Some(("AUSDT", Venue::Usdm)));
        m.ensure("AUSDT", Venue::Usdm, None);
        book(&mut m, Venue::Usdm, r#"{"s": "AUSDT", "b": "99.99", "a": "100.01", "E": 1000}"#);
        book(&mut m, Venue::Spot, r#"{"s": "AUSDT", "b": "100.98", "a": "101.02", "E": 1000}"#);   // tight: ratio 1.01
        assert_relative_eq!(m.px(tok).unwrap(), 101.0, max_relative = 1e-12);
        let ratio = m.insts[tok].ratio;
        book(&mut m, Venue::Spot, r#"{"s": "AUSDT", "b": "100.98", "a": "140.00", "E": 2000}"#);   // best ask gone: mid 120.49
        assert_relative_eq!(m.px(tok).unwrap(), 101.0, max_relative = 1e-6);
        assert_eq!(m.insts[tok].ratio, ratio);
        assert_relative_eq!(m.insts[tok].ring.at(2_000).unwrap(), 101.0, max_relative = 1e-6);
    }

    #[test]
    fn book_numbers_rest_shape_and_marks() {
        let mut m = Market::new(info(&[]), 120.0, 100.0);
        let x = m.ensure("XUSDT", Venue::Usdm, None);
        book(&mut m, Venue::Usdm, r#"{"s":"XUSDT","b":50,"a":50.5,"E":7}"#);
        assert_eq!((m.insts[x].bid, m.insts[x].ask, m.insts[x].t), (50.0, 50.5, Some(7)));
        CLOCK.set_fixed(Some(99));
        m.on_book(Venue::Usdm, &BookTicker::new("XUSDT", 1.0, 2.0, None));   // REST shape: no E
        CLOCK.set_fixed(None);
        assert_eq!(m.insts[x].t, Some(99));
        book(&mut m, Venue::Usdm, r#"{"s":"NOPE","b":"1","a":"2"}"#);
        m.on_mark_raw(r#"{"e":"markPriceUpdate","E":1,"s":"XUSDT","p":"11.5","i":"11","P":"11","r":"0.0001","T":1700000000000}"#);
        assert_eq!((m.insts[x].mark, m.insts[x].funding, m.insts[x].next_funding), (Some(11.5), Some(0.0001), Some(1_700_000_000_000)));
        m.on_mark_raw(r#"{"s":"XUSDT","p":"12","r":"","T":0}"#);
        assert_eq!((m.insts[x].mark, m.insts[x].funding, m.insts[x].next_funding), (Some(12.0), None, None));
    }

    #[test]
    fn asset_price_stables_ld_and_known() {
        let mut m = Market::new(info(&[("BTCUSDT", SymbolInfo::new("BTC", "USDT", 5.0))]), 120.0, 100.0);
        assert_eq!(m.asset_price("USDC"), Some(1.0));
        assert_eq!(m.asset_price("LDUSDT"), Some(1.0));
        assert_eq!(m.asset_price("BTC"), None);   // known, no book yet
        assert!(m.get("spot:BTCUSDT").is_some());
        book(&mut m, Venue::Spot, r#"{"s":"BTCUSDT","b":"100","a":"100.02"}"#);
        assert_relative_eq!(m.asset_price("LDBTC").unwrap(), 100.01, max_relative = 1e-12);
        assert_eq!(m.asset_price("ZZZ"), None);
        assert!(m.get("spot:ZZZUSDT").is_none());
    }

    #[test]
    fn fine_ring_compacts() {
        let mut f = FineRing::default();
        for i in 0..5000i64 {
            f.put(i * 1000, i as f64);
        }
        assert!(f.len() < 5000);
        assert_eq!(f.at(4_999_000), Some(4999.0));
        assert_eq!(f.at(4_999_000 - FineRing::KEEP_MS), Some((4999 - 420) as f64));
        f.put(10, 1.0);   // out of order: clamps to the last time
        assert_eq!(*f.t.last().unwrap(), 4_999_000);
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
