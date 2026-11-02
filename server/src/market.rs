//! Books, mids, fair values and price rings per instrument.
use std::collections::HashMap;

use rustc_hash::FxHashMap;

use crate::clock::{CLOCK, now_ms};
pub use crate::protocol::Venue;

pub const QUOTE: &str = "USDT";
pub const STABLES: [&str; 8] = ["USDT", "USDC", "FDUSD", "TUSD", "USDP", "DAI", "BUSD", "USD1"];

pub fn is_stable(asset: &str) -> bool {
    STABLES.contains(&asset)
}

/// A pair of two stablecoins (USDCUSDT, FDUSDUSDT, ...): trading it converts one dollar into another, it is not
/// market making, so the fill statistics, markouts, market making, Π and the instrument lists leave it out.
pub fn is_conversion(symbol: &str) -> bool {
    STABLES.iter().any(|q| symbol.strip_suffix(q).is_some_and(is_stable))
}

/// Every pair of two stablecoins as an SQL list ('USDCUSDT', ...).
pub fn conversion_list() -> String {
    let mut v = vec![];
    for b in STABLES {
        for q in STABLES.iter().filter(|q| **q != b) {
            v.push(format!("'{b}{q}'"));
        }
    }
    v.join(", ")
}

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
    pub mark_ring: Option<MidRing>,   // the mark as of each second, from the first one seen
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
            mark_ring: None,
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

/// A book's top as a connector reads it: the event time, when the exchange gives one.
#[derive(Debug, Clone, Copy)]
pub struct Book<'a> {
    pub symbol: &'a str,
    pub bid: f64,
    pub ask: f64,
    pub t: Option<i64>,
}

impl<'a> Book<'a> {
    pub fn new(symbol: &'a str, bid: f64, ask: f64, t: Option<i64>) -> Self {
        Book { symbol, bid, ask, t }
    }
}

/// A perp's mark price, funding rate (none between fundings) and next funding time.
#[derive(Debug, Clone, Copy)]
pub struct Mark<'a> {
    pub symbol: &'a str,
    pub price: f64,
    pub funding: Option<f64>,
    pub next_funding: Option<i64>,
}

pub struct Market {
    pub info: Info,
    pub halflife_s: f64,
    pub max_spread_bps: f64,   // wider books are not trusted for valuation
    /// Every instrument in creation order, indexed by `InstId`.
    pub insts: Vec<Inst>,
    by_key: HashMap<String, InstId>,
    by_sym: [FxHashMap<Box<str>, InstId>; Venue::COUNT],
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

    /// Keep the instrument's every mid change at ms resolution too (the price path around its fills).
    pub fn keep_fine(&mut self, id: InstId) {
        self.insts[id].fine.get_or_insert_with(FineRing::default);
    }

    pub fn known(&self, symbol: &str, venue: Venue) -> bool {
        self.info.get(&venue).is_some_and(|m| m.contains_key(symbol))
    }

    pub fn asset_inst(&mut self, asset: &str) -> Option<InstId> {
        let sym = format!("{asset}{QUOTE}");
        if let Some(id) = self.find(&sym, Venue::SPOT) {
            return Some(id);
        }
        self.known(&sym, Venue::SPOT).then(|| self.ensure(&sym, Venue::SPOT, None))
    }

    /// The asset's USD (USDT) price now: its USDT market's valuation price. USDT is 1; another stablecoin is
    /// priced like any asset (USDC at USDCUSDT's mid), 1 only while its pair has no price (or none is listed).
    pub fn asset_price(&mut self, asset: &str) -> Option<f64> {
        if asset == QUOTE {
            return Some(1.0);
        }
        if is_stable(asset) {
            return Some(self.asset_inst(asset).and_then(|i| self.px(i)).filter(|p| *p > 0.0).unwrap_or(1.0));
        }
        let inst = self.asset_inst(asset);
        if inst.is_none() && asset.starts_with("LD") && asset.len() > 2 {
            return self.asset_price(&asset[2..]);
        }
        inst.and_then(|i| self.px(i))
    }

    /// The asset's USD price at t_ms: its mid at the end of the last whole second before (from the 1 s ring,
    /// so it no longer changes once asked after that second), else the price now when the ring does not reach
    /// back that far. Stablecoins as in `asset_price`: USDT 1, another at its USDT pair's price then, 1 when it
    /// has none.
    pub fn asset_price_at(&mut self, asset: &str, t_ms: i64) -> Option<f64> {
        if asset == QUOTE {
            return Some(1.0);
        }
        if is_stable(asset) {
            let i = self.asset_inst(asset);
            let at = i.and_then(|i| self.insts[i].ring.at(t_ms.div_euclid(1000) * 1000 - 1).or_else(|| self.px(i)));
            return Some(at.filter(|p| *p > 0.0).unwrap_or(1.0));
        }
        match self.asset_inst(asset) {
            Some(i) => self.insts[i].ring.at(t_ms.div_euclid(1000) * 1000 - 1).filter(|p| *p != 0.0).or_else(|| self.px(i)),
            None if asset.starts_with("LD") && asset.len() > 2 => self.asset_price_at(&asset[2..], t_ms),
            None => None,
        }
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

    /// What a position in the instrument is worth a unit of, as equity has it: a perp at its mark, as the exchange
    /// counts unrealized P&L, spot at `px`. Π uses this, so it moves as equity does.
    pub fn value(&self, id: InstId) -> Option<f64> {
        let inst = &self.insts[id];
        if inst.venue.is_spot() {
            return self.px(id);
        }
        inst.mark.filter(|x| *x != 0.0).or_else(|| self.px(id))
    }

    /// `value` as of t_ms, from the 1 s rings.
    pub fn value_at(&self, id: InstId, t_ms: i64) -> Option<f64> {
        let inst = &self.insts[id];
        inst.mark_ring.as_ref().and_then(|r| r.at(t_ms)).filter(|x| *x != 0.0).or_else(|| inst.ring.at(t_ms))
    }

    pub fn on_book(&mut self, venue: Venue, d: &Book) {
        let Some(id) = self.find(d.symbol, venue) else { return };
        let t = d.t.unwrap_or_else(|| CLOCK.now());
        let recv = now_ms();
        let (max_spread, halflife) = (self.max_spread_bps, self.halflife_s);
        let inst = &mut self.insts[id];
        (inst.bid, inst.ask, inst.t, inst.recv) = (d.bid, d.ask, Some(t), Some(recv));
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

    pub fn on_mark(&mut self, venue: Venue, d: &Mark) {
        if let Some(id) = self.find(d.symbol, venue) {
            let inst = &mut self.insts[id];
            inst.mark = Some(d.price);
            inst.mark_ring.get_or_insert_with(MidRing::new).put(CLOCK.now(), d.price);
            inst.funding = d.funding;
            inst.next_funding = d.next_funding;
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
        i.insert(Venue::SPOT, spot.iter().cloned().map(|(k, v)| (k.to_string(), v)).collect());
        i.insert(Venue::USDM, HashMap::new());
        i
    }

    fn book(m: &mut Market, venue: Venue, json: &str) {
        crate::binance::public::on_book_raw(m, venue, json);
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
        let x = m.ensure("XUSDT", Venue::SPOT, Some(("XUSDT", Venue::USDM)));
        book(&mut m, Venue::USDM, r#"{"s": "XUSDT", "b": "99.9", "a": "100.1", "E": 1000}"#);
        book(&mut m, Venue::SPOT, r#"{"s": "XUSDT", "b": "100.9", "a": "101.1", "E": 1000}"#);
        assert_relative_eq!(m.insts[x].ratio.unwrap(), 1.01, max_relative = 1e-12);
        book(&mut m, Venue::USDM, r#"{"s": "XUSDT", "b": "109.9", "a": "110.1", "E": 2000}"#);
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
        let tok = m.ensure("AUSDT", Venue::SPOT, Some(("AUSDT", Venue::USDM)));
        m.ensure("AUSDT", Venue::USDM, None);
        book(&mut m, Venue::USDM, r#"{"s": "AUSDT", "b": "99.99", "a": "100.01", "E": 1000}"#);
        book(&mut m, Venue::SPOT, r#"{"s": "AUSDT", "b": "100.98", "a": "101.02", "E": 1000}"#);   // tight: ratio 1.01
        assert_relative_eq!(m.px(tok).unwrap(), 101.0, max_relative = 1e-12);
        let ratio = m.insts[tok].ratio;
        book(&mut m, Venue::SPOT, r#"{"s": "AUSDT", "b": "100.98", "a": "140.00", "E": 2000}"#);   // best ask gone: mid 120.49
        assert_relative_eq!(m.px(tok).unwrap(), 101.0, max_relative = 1e-6);
        assert_eq!(m.insts[tok].ratio, ratio);
        assert_relative_eq!(m.insts[tok].ring.at(2_000).unwrap(), 101.0, max_relative = 1e-6);
    }

    #[test]
    fn book_numbers_rest_shape_and_marks() {
        let mut m = Market::new(info(&[]), 120.0, 100.0);
        let x = m.ensure("XUSDT", Venue::USDM, None);
        book(&mut m, Venue::USDM, r#"{"s":"XUSDT","b":50,"a":50.5,"E":7}"#);
        assert_eq!((m.insts[x].bid, m.insts[x].ask, m.insts[x].t), (50.0, 50.5, Some(7)));
        CLOCK.set_fixed(Some(99));
        m.on_book(Venue::USDM, &Book::new("XUSDT", 1.0, 2.0, None));   // REST shape: no E
        CLOCK.set_fixed(None);
        assert_eq!(m.insts[x].t, Some(99));
        book(&mut m, Venue::USDM, r#"{"s":"NOPE","b":"1","a":"2"}"#);
        crate::binance::public::on_mark_raw(&mut m, Venue::USDM, r#"{"e":"markPriceUpdate","E":1,"s":"XUSDT","p":"11.5","i":"11","P":"11","r":"0.0001","T":1700000000000}"#);
        assert_eq!((m.insts[x].mark, m.insts[x].funding, m.insts[x].next_funding), (Some(11.5), Some(0.0001), Some(1_700_000_000_000)));
        crate::binance::public::on_mark_raw(&mut m, Venue::USDM, r#"{"s":"XUSDT","p":"12","r":"","T":0}"#);
        assert_eq!((m.insts[x].mark, m.insts[x].funding, m.insts[x].next_funding), (Some(12.0), None, None));
    }

    #[test]
    fn asset_price_stables_ld_and_known() {
        let mut m = Market::new(info(&[("BTCUSDT", SymbolInfo::new("BTC", "USDT", 5.0))]), 120.0, 100.0);
        assert_eq!(m.asset_price("USDC"), Some(1.0));   // no USDCUSDT listed: 1
        assert_eq!(m.asset_price("LDUSDT"), Some(1.0));
        assert_eq!(m.asset_price("BTC"), None);   // known, no book yet
        assert!(m.get("spot:BTCUSDT").is_some());
        book(&mut m, Venue::SPOT, r#"{"s":"BTCUSDT","b":"100","a":"100.02"}"#);
        assert_relative_eq!(m.asset_price("LDBTC").unwrap(), 100.01, max_relative = 1e-12);
        assert_eq!(m.asset_price("ZZZ"), None);
        assert!(m.get("spot:ZZZUSDT").is_none());
    }

    #[test]
    fn stablecoins_at_their_usdt_pair() {
        let mut m = Market::new(info(&[("USDCUSDT", SymbolInfo::new("USDC", "USDT", 5.0))]), 120.0, 100.0);
        // listed, no book yet: 1 until it is quoted
        assert_eq!(m.asset_price("USDC"), Some(1.0));
        assert_eq!(m.asset_price_at("USDC", 5_000), Some(1.0));
        assert_eq!(m.asset_price("USDT"), Some(1.0));
        book(&mut m, Venue::SPOT, r#"{"s":"USDCUSDT","b":"1.0011","a":"1.0012","E":10500}"#);
        assert_relative_eq!(m.asset_price("USDC").unwrap(), 1.00115, max_relative = 1e-12);
        assert_relative_eq!(m.asset_price("LDUSDC").unwrap(), 1.00115, max_relative = 1e-12);
        assert_relative_eq!(m.asset_price_at("USDC", 11_200).unwrap(), 1.00115, max_relative = 1e-12);
        book(&mut m, Venue::SPOT, r#"{"s":"USDCUSDT","b":"1.0001","a":"1.0003","E":12500}"#);
        // at a time: the mid at the end of the last whole second before it
        assert_relative_eq!(m.asset_price_at("USDC", 12_700).unwrap(), 1.00115, max_relative = 1e-12);
        assert_relative_eq!(m.asset_price_at("USDC", 13_100).unwrap(), 1.0002, max_relative = 1e-12);
        assert_eq!(m.asset_price("USDT"), Some(1.0));
        assert_eq!(m.asset_price_at("USDT", 13_100), Some(1.0));
        assert_eq!(m.asset_price("FDUSD"), Some(1.0));   // not listed here: 1
    }

    #[test]
    fn conversion_pairs() {
        for s in ["USDCUSDT", "FDUSDUSDT", "FDUSDUSDC", "USD1USDT", "TUSDUSDT"] {
            assert!(is_conversion(s), "{s}");
        }
        for s in ["BTCUSDT", "BTCUSDC", "USDTTRY", "EURUSDT", "USDT", "CRCLBUSDT"] {
            assert!(!is_conversion(s), "{s}");
        }
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
}
