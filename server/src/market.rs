//! Books, mids, fair values and price rings per instrument.
use std::collections::{HashMap, HashSet, VecDeque};

use rustc_hash::FxHashMap;

use crate::clock::{CLOCK, now_ms};
pub use crate::protocol::Venue;

pub const STABLES: [&str; 8] = ["USDT", "USDC", "FDUSD", "TUSD", "USDP", "DAI", "BUSD", "USD1"];

pub fn is_stable(asset: &str) -> bool {
    STABLES.contains(&asset)
}

/// A pair of two stablecoins (USDCUSDT, FDUSDUSDT, ...): trading it converts one dollar into another, it is not
/// market making, so the fill statistics, markouts, market making, Π and the instrument lists leave it out.
pub fn is_conversion(symbol: &str) -> bool {
    STABLES.iter().any(|q| symbol.strip_suffix(q).is_some_and(is_stable))
}

/// What the desk's figures are in: `asset` is worth exactly 1, everything else its price in it.
#[derive(Debug, Clone, PartialEq)]
pub struct Numeraire {
    pub asset: String,
    /// The desk asks only for an asset's direct pair and counts a stablecoin a perp settles in at 1. This is a desk on
    /// Binance alone that names no currency, whose figures and requests stay what they have always been.
    pub par: bool,
}

impl Default for Numeraire {
    fn default() -> Self {
        Numeraire { asset: "USDT".into(), par: true }
    }
}

/// One step of an asset's way to the desk's currency: an instrument's price, or one over it.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Hop {
    pub inst: InstId,
    pub invert: bool,
}

/// A pair as a step away from one of its assets, while the way is being looked for.
#[derive(Debug, Clone)]
struct Edge {
    to: String,
    symbol: String,
    venue: Venue,
    invert: bool,
}

/// What each asset trades against on the spot markets (a perp does not price an asset), best first: a market's own
/// quote, then a stablecoin, then anything; by market, then by name.
fn edges(info: &Info) -> HashMap<String, Vec<Edge>> {
    let mut out: HashMap<String, Vec<(u8, Edge)>> = HashMap::new();
    for venue in Venue::all().filter(|v| v.is_spot()) {
        for (symbol, s) in info.get(&venue).into_iter().flatten() {
            let rank = |a: &str| if a == venue.market().quote { 0 } else if is_stable(a) { 1 } else { 2 };
            for (from, to, invert) in [(&s.base, &s.quote, false), (&s.quote, &s.base, true)] {
                out.entry(from.clone()).or_default().push((rank(to), Edge { to: to.clone(), symbol: symbol.clone(), venue, invert }));
            }
        }
    }
    out.into_iter()
        .map(|(a, mut v)| {
            v.sort_by(|x, y| (x.0, x.1.venue, &x.1.symbol).cmp(&(y.0, y.1.venue, &y.1.symbol)));
            (a, v.into_iter().map(|x| x.1).collect())
        })
        .collect()
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
            base: info.map_or_else(|| symbol.strip_suffix(venue.market().quote).unwrap_or(symbol).to_string(), |i| i.base.clone()),
            quote: info.map_or_else(|| venue.market().quote.to_string(), |i| i.quote.clone()),
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
    pub numeraire: Numeraire,
    edges: HashMap<String, Vec<Edge>>,
    /// asset -> its way to the desk's currency, once found
    paths: HashMap<String, Vec<Hop>>,
    /// assets whose way is being made: making it adds instruments, which ask for their quote's
    finding: HashSet<String>,
    pub on_new: Box<dyn FnMut(&Inst)>,
}

impl Market {
    pub fn new(info: Info, halflife_s: f64, max_spread_bps: f64) -> Self {
        Market {
            numeraire: Numeraire::default(),
            edges: edges(&info),
            paths: HashMap::new(),
            finding: HashSet::new(),
            info,
            halflife_s,
            max_spread_bps,
            insts: vec![],
            by_key: HashMap::new(),
            by_sym: Default::default(),
            on_new: Box::new(|_| {}),
        }
    }

    /// What an exchange lists, read after the desk started: instruments made in the meantime take it up.
    pub fn add_info(&mut self, info: Info) {
        for (venue, symbols) in info {
            for inst in self.insts.iter_mut().filter(|i| i.venue == venue) {
                if let Some(s) = symbols.get(&inst.symbol) {
                    (inst.base, inst.quote, inst.min_notional) = (s.base.clone(), s.quote.clone(), s.min_notional);
                }
            }
            self.info.insert(venue, symbols);
        }
        self.edges = edges(&self.info);
        self.paths.clear();
        if !self.numeraire.par {
            let quotes: Vec<String> = self.insts.iter().map(|i| i.quote.clone()).collect();
            for q in quotes {
                self.path(&q);
            }
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
                if !self.numeraire.par {
                    let quote = self.insts[id].quote.clone();
                    self.path(&quote);
                }
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

    /// Cash to the desk: a stablecoin, or the asset its figures are in.
    pub fn is_cash(&self, asset: &str) -> bool {
        is_stable(asset) || asset == self.numeraire.asset
    }

    /// A stablecoin with no pair to price it counts as 1 on a desk in dollars, and is not priced on any other.
    fn fallback(&self, asset: &str) -> Option<f64> {
        (is_stable(asset) && (self.numeraire.par || is_stable(&self.numeraire.asset))).then_some(1.0)
    }

    /// The pairs from an asset to the desk's currency, shortest first, at most three. A desk in dollars stops at any
    /// stablecoin, and a stablecoin's own way there is its pair with the currency or nothing: not through BTC.
    fn route(&self, asset: &str) -> Option<Vec<Edge>> {
        let target = self.numeraire.asset.as_str();
        let dollars = is_stable(target);
        let mut seen = HashSet::from([asset.to_string()]);
        let mut queue: VecDeque<(String, Vec<Edge>)> = VecDeque::from([(asset.to_string(), vec![])]);
        while let Some((at, way)) = queue.pop_front() {
            if way.len() == 3 {
                continue;
            }
            for e in self.edges.get(&at).into_iter().flatten() {
                if !seen.insert(e.to.clone()) {
                    continue;
                }
                let mut next = way.clone();
                next.push(e.clone());
                if e.to == target || (dollars && is_stable(&e.to) && !is_stable(asset)) {
                    return Some(next);
                }
                if !(dollars && is_stable(asset)) {
                    queue.push_back((e.to.clone(), next));
                }
            }
        }
        (dollars && is_stable(asset)).then(Vec::new)
    }

    /// The way from an asset to the desk's currency, its instruments made and watched.
    fn path(&mut self, asset: &str) -> Option<Vec<Hop>> {
        if asset == self.numeraire.asset {
            return Some(vec![]);
        }
        if let Some(p) = self.paths.get(asset) {
            return Some(p.clone());
        }
        let sym = format!("{asset}{}", self.numeraire.asset);
        let spot: Vec<Venue> = Venue::all().filter(|v| v.is_spot()).collect();
        if let Some(venue) = spot.iter().copied().find(|v| self.find(&sym, *v).is_some() || self.known(&sym, *v)) {
            let hops = vec![Hop { inst: self.ensure(&sym, venue, None), invert: false }];
            self.paths.insert(asset.to_string(), hops.clone());
            return Some(hops);
        }
        if self.numeraire.par || !self.finding.insert(asset.to_string()) {
            return None;
        }
        let route = self.route(asset);
        let mut hops = vec![];
        let mut last = asset.to_string();
        for e in route.iter().flatten() {
            hops.push(Hop { inst: self.ensure(&e.symbol, e.venue, None), invert: e.invert });
            last.clone_from(&e.to);
        }
        if route.is_some() && last != asset && last != self.numeraire.asset {
            hops.extend(self.path(&last).unwrap_or_default());   // a desk in dollars: the stablecoin it stopped at
        }
        self.finding.remove(asset);
        if route.is_some() {
            self.paths.insert(asset.to_string(), hops.clone());
        }
        route.map(|_| hops)
    }

    /// The instrument an asset is first priced on.
    pub fn asset_inst(&mut self, asset: &str) -> Option<InstId> {
        self.path(asset)?.first().map(|h| h.inst)
    }

    /// Every instrument on an asset's way to the desk's currency, by key: what its price at a past time needs bars of.
    pub fn path_keys(&mut self, asset: &str) -> Vec<String> {
        self.path(asset).unwrap_or_default().iter().map(|h| self.insts[h.inst].key.clone()).collect()
    }

    fn hops_px(&self, hops: &[Hop], price: impl Fn(&Inst, InstId) -> Option<f64>) -> Option<f64> {
        let mut x = 1.0;
        let dollars = is_stable(&self.numeraire.asset);
        for h in hops {
            let inst = &self.insts[h.inst];
            // a pair of two dollars with no quote: 1, as a stablecoin with no pair is
            let p = match price(inst, h.inst) {
                Some(p) => p,
                None if dollars && is_conversion(&inst.symbol) => 1.0,
                None => return None,
            };
            if h.invert {
                if p == 0.0 {
                    return None;
                }
                x /= p;
            } else {
                x *= p;
            }
        }
        Some(x)
    }

    /// The asset's price in the desk's currency now, along a way already made: what `&Market` can ask.
    pub fn rate(&self, asset: &str) -> Option<f64> {
        if asset == self.numeraire.asset {
            return Some(1.0);
        }
        let x = self.paths.get(asset).and_then(|h| self.hops_px(h, |_, i| self.px(i)));
        if is_stable(asset) {
            return x.filter(|p| *p > 0.0).or_else(|| self.fallback(asset));
        }
        x
    }

    /// `rate` as of a time on the 1 s rings, the price now where they do not reach.
    fn rate_at(&self, asset: &str, ring_t: i64) -> Option<f64> {
        if asset == self.numeraire.asset {
            return Some(1.0);
        }
        let x = self.paths.get(asset).and_then(|h| self.hops_px(h, |inst, i| inst.ring.at(ring_t).filter(|p| *p != 0.0).or_else(|| self.px(i))));
        if is_stable(asset) {
            return x.filter(|p| *p > 0.0).or_else(|| self.fallback(asset));
        }
        x
    }

    /// The asset's price in the desk's currency now: 1 for the currency itself, else the product of the pairs on its way
    /// there. A stablecoin with no pair, or none quoted yet, on a desk in dollars is 1.
    pub fn asset_price(&mut self, asset: &str) -> Option<f64> {
        let found = self.path(asset).is_some();
        if !found && !is_stable(asset) && asset.starts_with("LD") && asset.len() > 2 {
            return self.asset_price(&asset[2..]);
        }
        self.rate(asset)
    }

    /// The asset's price at t_ms: its pairs at the end of the last whole second before (from the 1 s rings, so it no
    /// longer changes once asked after that second), else the price now when a ring does not reach back that far.
    /// Stablecoins as in `asset_price`.
    pub fn asset_price_at(&mut self, asset: &str, t_ms: i64) -> Option<f64> {
        let found = self.path(asset).is_some();
        if !found && !is_stable(asset) && asset.starts_with("LD") && asset.len() > 2 {
            return self.asset_price_at(&asset[2..], t_ms);
        }
        self.rate_at(asset, t_ms.div_euclid(1000) * 1000 - 1)
    }

    /// An asset's price is due and has not come: an instrument on its way has no quote and has had less than `wait_ms` to
    /// get one.
    pub fn waiting(&mut self, asset: &str, wait_ms: i64) -> bool {
        let now = now_ms();
        self.path(asset).unwrap_or_default().iter().any(|h| self.px(h.inst).is_none_or(|p| p <= 0.0) && now - self.insts[h.inst].created <= wait_ms)
    }

    /// What one unit of an instrument's own price is worth in the desk's currency: of a perp, what it settles in.
    pub fn unit(&self, id: InstId) -> Option<f64> {
        if self.numeraire.par {
            return Some(1.0);
        }
        self.rate(&self.insts[id].quote)
    }

    fn unit_at(&self, id: InstId, t_ms: i64) -> Option<f64> {
        if self.numeraire.par {
            return Some(1.0);
        }
        self.rate_at(&self.insts[id].quote, t_ms)
    }

    /// An amount a perp's wallet pays or takes in `asset`, in the desk's currency.
    pub fn settled(&mut self, asset: &str, x: f64) -> f64 {
        if asset.is_empty() || (self.numeraire.par && matches!(asset, "USDT" | "USDC")) {
            return x;
        }
        x * self.asset_price(asset).unwrap_or(0.0)
    }

    /// A perp wallet in `asset` is worth this much a unit, once its way is made (`waiting` makes it).
    pub fn settle_rate(&self, asset: &str) -> f64 {
        if self.numeraire.par {
            return 1.0;
        }
        self.rate(asset).unwrap_or(0.0)
    }

    /// Assets of this desk nothing listed prices in its currency: what a desk refuses to start with.
    pub fn unpriced<'a>(&mut self, assets: impl IntoIterator<Item = &'a str>) -> Vec<String> {
        let mut out: Vec<String> = assets.into_iter().filter(|a| self.path(a).is_none() && self.fallback(a).is_none()).map(String::from).collect();
        out.sort();
        out.dedup();
        out
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

    /// What a unit of a position in the instrument is worth in the desk's currency, as equity has it: a perp at its mark,
    /// as the exchange counts unrealized P&L, spot at `px`. Π uses this, so it moves as equity does.
    pub fn value(&self, id: InstId) -> Option<f64> {
        let inst = &self.insts[id];
        let own = if inst.venue.is_spot() { self.px(id) } else { inst.mark.filter(|x| *x != 0.0).or_else(|| self.px(id)) };
        Some(own? * self.unit(id)?)
    }

    /// `value` as of t_ms, from the 1 s rings.
    pub fn value_at(&self, id: InstId, t_ms: i64) -> Option<f64> {
        let inst = &self.insts[id];
        let own = inst.mark_ring.as_ref().and_then(|r| r.at(t_ms)).filter(|x| *x != 0.0).or_else(|| inst.ring.at(t_ms));
        Some(own? * self.unit_at(id, t_ms)?)
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

    /// A desk that named its currency, or reads more than Binance.
    fn numeraire(mut m: Market, asset: &str) -> Market {
        m.numeraire = Numeraire { asset: asset.into(), par: false };
        m
    }

    fn pairs(venue: Venue, rows: &[(&str, &str)]) -> (Venue, HashMap<String, SymbolInfo>) {
        (venue, rows.iter().map(|(b, q)| (format!("{b}{q}"), SymbolInfo::new(b, q, 5.0))).collect())
    }

    #[test]
    fn a_desk_in_usdt_prices_an_asset_on_another_exchange_through_what_it_is_quoted_in() {
        let mut i = info(&[("BTCUSDT", SymbolInfo::new("BTC", "USDT", 5.0)), ("USDCUSDT", SymbolInfo::new("USDC", "USDT", 5.0))]);
        i.extend([pairs(Venue::HL_SPOT, &[("HYPE", "USDC"), ("HYPE", "USDE"), ("HYPE", "DAI"), ("BTC", "USDC"), ("PIP", "DAI"), ("ODD", "HYPE")]),
                  (Venue::HL, HashMap::from([("ONLYPERP".to_string(), SymbolInfo::new("ONLYPERP", "USDC", 10.0))]))]);
        let mut m = numeraire(Market::new(i, 120.0, 100.0), "USDT");
        // its market's own quote first, then a stablecoin; a perp is not a price of an asset
        assert_eq!(m.asset_inst("HYPE").map(|i| m.insts[i].key.clone()), Some("hlspot:HYPEUSDC".to_string()));
        assert_eq!(m.asset_inst("PIP").map(|i| m.insts[i].key.clone()), Some("hlspot:PIPDAI".to_string()));
        assert_eq!(m.asset_inst("ONLYPERP"), None);
        assert_eq!(m.asset_inst("BTC").map(|i| m.insts[i].key.clone()), Some("spot:BTCUSDT".to_string()));
        m.on_book(Venue::HL_SPOT, &Book::new("HYPEUSDC", 87.0, 87.2, Some(1)));
        // USDC not quoted yet: 1
        assert_relative_eq!(m.asset_price("HYPE").unwrap(), 87.1, max_relative = 1e-12);
        m.on_book(Venue::SPOT, &Book::new("USDCUSDT", 0.999, 0.999, Some(1)));
        assert_relative_eq!(m.asset_price("USDC").unwrap(), 0.999, max_relative = 1e-12);
        assert_relative_eq!(m.asset_price("HYPE").unwrap(), 87.1 * 0.999, max_relative = 1e-12);
        // in anything else it goes on to what that is priced in
        m.asset_inst("ODD");
        m.on_book(Venue::HL_SPOT, &Book::new("ODDHYPE", 2.0, 2.0, Some(1)));
        assert_relative_eq!(m.asset_price("ODD").unwrap(), 2.0 * 87.1 * 0.999, max_relative = 1e-12);
    }

    #[test]
    fn a_desk_in_a_currency_with_no_dollars_converts_everything_and_assumes_nothing() {
        let mut i = info(&[("BTCEUR", SymbolInfo::new("BTC", "EUR", 5.0)), ("EURUSDT", SymbolInfo::new("EUR", "USDT", 5.0)),
                           ("ETHUSDT", SymbolInfo::new("ETH", "USDT", 5.0)), ("USDCUSDT", SymbolInfo::new("USDC", "USDT", 5.0))]);
        i.insert(Venue::HL_SPOT, HashMap::from([("FDUSDUSDE".to_string(), SymbolInfo::new("FDUSD", "USDE", 5.0))]));
        let mut m = numeraire(Market::new(i, 120.0, 100.0), "EUR");
        assert_eq!(m.asset_price("EUR"), Some(1.0));
        for a in ["BTC", "USDT", "ETH", "USDC"] {
            assert_eq!(m.asset_price(a), None);   // not quoted yet: not assumed to be anything
        }
        // a direct pair, one over a pair, through a stablecoin, and two of those
        m.on_book(Venue::SPOT, &Book::new("BTCEUR", 90_000.0, 90_000.0, Some(1)));
        assert_relative_eq!(m.asset_price("BTC").unwrap(), 90_000.0);
        m.on_book(Venue::SPOT, &Book::new("EURUSDT", 1.25, 1.25, Some(1)));
        assert_relative_eq!(m.asset_price("USDT").unwrap(), 0.8);
        m.on_book(Venue::SPOT, &Book::new("ETHUSDT", 3000.0, 3000.0, Some(1)));
        assert_relative_eq!(m.asset_price("ETH").unwrap(), 2400.0);
        m.on_book(Venue::SPOT, &Book::new("USDCUSDT", 1.0, 1.0, Some(1)));
        assert_relative_eq!(m.asset_price("USDC").unwrap(), 0.8);
        // a stablecoin nothing connects: unknown, where a desk in dollars counts it 1
        assert_eq!(m.asset_price("DAI"), None);
        assert_eq!(m.unpriced(["USDT", "DAI", "FDUSD"]), ["DAI", "FDUSD"]);
        assert!(m.is_cash("EUR") && m.is_cash("USDT") && !m.is_cash("BTC"));
    }

    #[test]
    fn a_position_is_valued_in_the_desks_currency_at_what_it_settles_in() {
        let mut i = info(&[("USDCUSDT", SymbolInfo::new("USDC", "USDT", 5.0))]);
        i.get_mut(&Venue::USDM).unwrap().insert("BTCUSDC".into(), SymbolInfo::new("BTC", "USDC", 5.0));
        let build = |m: &mut Market| {
            let x = m.ensure("BTCUSDC", Venue::USDM, None);
            m.on_mark(Venue::USDM, &Mark { symbol: "BTCUSDC", price: 100.0, funding: None, next_funding: None });
            m.on_book(Venue::SPOT, &Book::new("USDCUSDT", 0.99, 0.99, Some(1)));
            x
        };
        // as it always was
        let mut par = Market::new(i.clone(), 120.0, 100.0);
        let x = build(&mut par);
        assert_eq!(par.value(x), Some(100.0));
        assert_eq!(par.settled("USDC", 2.0), 2.0);
        assert_eq!(par.settle_rate("USDC"), 1.0);
        // converted
        let mut m = numeraire(Market::new(i, 120.0, 100.0), "USDT");
        let x = build(&mut m);
        assert_relative_eq!(m.value(x).unwrap(), 99.0);
        assert_relative_eq!(m.settled("USDC", 2.0), 1.98);
        assert_relative_eq!(m.settle_rate("USDC"), 0.99);
    }

    #[test]
    fn par_keeps_to_the_direct_pair_and_asks_for_nothing_new() {
        let mut m = Market::new(info(&[("XBTC", SymbolInfo::new("X", "BTC", 5.0)), ("BTCUSDT", SymbolInfo::new("BTC", "USDT", 5.0))]), 120.0, 100.0);
        assert_eq!(m.asset_price("X"), None);
        assert_eq!(m.path_keys("X"), Vec::<String>::new());
        assert!(m.get("spot:XBTC").is_none());
    }

    #[test]
    fn a_listing_read_late_joins_what_was_made_before_it() {
        let mut m = Market::new(Info::new(), 120.0, 100.0);
        let x = m.ensure("KPEPE", Venue::HL, None);
        assert_eq!((m.insts[x].base.as_str(), m.insts[x].quote.as_str()), ("KPEPE", "USDC"));
        m.add_info(Info::from([(Venue::HL, HashMap::from([("KPEPE".to_string(), SymbolInfo::new("KPEPE", "USDC", 10.0))])),
                               (Venue::HL_SPOT, HashMap::from([("HYPEUSDC".to_string(), SymbolInfo::new("HYPE", "USDC", 10.0))]))]));
        assert_eq!((m.insts[x].quote.as_str(), m.insts[x].min_notional), ("USDC", 10.0));
        m.numeraire = Numeraire { asset: "USDC".into(), par: false };
        assert!(m.asset_inst("HYPE").is_some());
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
