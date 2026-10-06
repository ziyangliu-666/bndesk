//! Trading P&L of the spot inventory: closed form for the day, decomposed on a live 1 s grid of exchange-clock
//! seconds, with the grid's gaps (monitor start after the day start, restarts, stalls) backfilled on a 1 min grid.
//!
//! Per instrument k (keyed by base asset): M_k(t) valuation price, R_k(t) mid of its reference, r_k(t) =
//! R_k(t) / R_k(t-1) - 1 (0 without a reference), r_b(t) the beta instrument's return, beta_k its beta.
//! Q0_k = inventory at the day start D: the current balance minus today's fills; then Q changes only by fills
//! (s q, before fees); a fill at t_f enters at the first grid point >= t_f.
//!
//! ```text
//!   Pi_k  = Q0_k (M_k(T) - M_k(D)) + sum_fills [s q (M_k(T) - p) - fee]                    trading P&L, day
//!   dPi(t) = sum_fills(t) [s q (M_k(t) - p) - fee] + sum_k Q_k(t-1) (M_k(t) - M_k(t-1))     ... per grid step
//!   dH(t)  = sum_k Q_k(t-1) M_k(t-1) r_k(t)                                                own-reference hedge
//!   dHm(t) = (sum_k beta_k Q_k(t-1) M_k(t-1)) r_b(t)                                       factor hedge
//!   S = Pi - H (hedged), A = Pi - Hm (factor-hedged)
//! ```
//!
//! Pi needs only M_k(D) (the 1 min kline open at D after a mid-day start) and M_k(T). H and Hm depend on the
//! path: grid steps are summed in UTC-hour blocks (live seconds in covered_s, backfilled ones in backfilled_s);
//! a day's standard error is Newey-West (lag 3) over its blocks.
//!
//! Notes: the market is passed per call (it lives in its own `RefCell`, as for `FillBook`); the callbacks
//! (balance, scope, beta, taker_bps) are boxed closures; maps whose order reaches a float sum or a request
//! order are kept in insertion order (`OMap`). `nz` treats a 0.0 float as missing.
use std::collections::{BTreeMap, HashMap, HashSet};
use std::fmt;
use std::marker::PhantomData;
use std::rc::Rc;

use serde::de::{MapAccess, Visitor};
use serde::ser::SerializeMap;
use serde::{Deserialize, Deserializer, Serialize, Serializer};

use crate::fills::{FillRec, sign};
use crate::market::{Inst, InstId, Market, Venue};
use crate::protocol::{self as P, Side};

pub const HOUR: i64 = 3_600_000;
pub const DAY: i64 = 86_400_000;
pub const MIN_S: i64 = 60;
pub const LAG_MS: i64 = 2_000;          // a grid second is booked this long after it ends, so its ticks and fills have arrived
pub const MAX_GAP_S: i64 = 590;         // the 1 s mid rings hold 600 s; a longer stall restarts the grid and the gap is backfilled
pub const MIN_BACKFILL_S: i64 = 1;      // a restart's gap, however short: unbooked, H misses the reference move in it
pub const COVER_SLACK_S: i64 = 300;     // unbooked seconds a day may have and still count as wholly booked
pub const DUST_USD: f64 = 1.0;          // inventory below this, without fills, is not worth a kline request
pub const DAYS_SHOWN: usize = 60;

/// Python truthiness of an optional float: None and 0.0 are both missing.
#[inline]
fn nz(x: Option<f64>) -> Option<f64> {
    x.filter(|v| *v != 0.0)
}

#[inline]
fn truthy(x: Option<f64>) -> bool {
    nz(x).is_some()
}

/// Python `-(-a // b)`: ceiling division.
#[inline]
fn ceil_div(a: i64, b: i64) -> i64 {
    -(-a).div_euclid(b)
}

/// Standard error of the sum of a block series, Newey-West with Bartlett weights.
pub fn nw_se(xs: &[f64], lag: usize) -> Option<f64> {
    let n = xs.len();
    if n < 2 {
        return None;
    }
    let nf = n as f64;
    let m = xs.iter().sum::<f64>() / nf;
    let x: Vec<f64> = xs.iter().map(|v| v - m).collect();
    let mut var = x.iter().map(|v| v * v).sum::<f64>() / nf;
    for k in 1..=lag {
        if k >= n {
            break;
        }
        let s: f64 = (k..n).map(|i| x[i] * x[i - k]).sum();
        var += 2.0 * (1.0 - k as f64 / (lag + 1) as f64) * s / nf;
    }
    Some((var.max(0.0) * nf).sqrt())
}

/// A map kept in insertion order (Python dict), serialized as a JSON object in that order.
#[derive(Debug, Clone, PartialEq)]
pub struct OMap<V> {
    entries: Vec<(String, V)>,
    idx: HashMap<String, usize>,
}

impl<V> Default for OMap<V> {
    fn default() -> Self {
        OMap { entries: Vec::new(), idx: HashMap::new() }
    }
}

impl<V> OMap<V> {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn get(&self, k: &str) -> Option<&V> {
        self.idx.get(k).map(|&i| &self.entries[i].1)
    }

    pub fn get_mut(&mut self, k: &str) -> Option<&mut V> {
        self.idx.get(k).map(|&i| &mut self.entries[i].1)
    }

    pub fn contains_key(&self, k: &str) -> bool {
        self.idx.contains_key(k)
    }

    /// Insert or replace (a replaced key keeps its place, as in a dict).
    pub fn insert(&mut self, k: impl Into<String>, v: V) {
        let k = k.into();
        if let Some(&i) = self.idx.get(&k) {
            self.entries[i].1 = v;
        } else {
            self.idx.insert(k.clone(), self.entries.len());
            self.entries.push((k, v));
        }
    }

    pub fn len(&self) -> usize {
        self.entries.len()
    }

    pub fn is_empty(&self) -> bool {
        self.entries.is_empty()
    }

    pub fn clear(&mut self) {
        self.entries.clear();
        self.idx.clear();
    }

    pub fn iter(&self) -> impl Iterator<Item = (&str, &V)> {
        self.entries.iter().map(|(k, v)| (k.as_str(), v))
    }

    pub fn iter_mut(&mut self) -> impl Iterator<Item = (&str, &mut V)> {
        self.entries.iter_mut().map(|(k, v)| (k.as_str(), v))
    }

    pub fn keys(&self) -> impl Iterator<Item = &str> {
        self.entries.iter().map(|(k, _)| k.as_str())
    }

    pub fn values(&self) -> impl Iterator<Item = &V> {
        self.entries.iter().map(|(_, v)| v)
    }

    pub fn values_mut(&mut self) -> impl Iterator<Item = &mut V> {
        self.entries.iter_mut().map(|(_, v)| v)
    }
}

impl<V> std::ops::Index<&str> for OMap<V> {
    type Output = V;
    fn index(&self, k: &str) -> &V {
        self.get(k).expect("key")
    }
}

impl<V> FromIterator<(String, V)> for OMap<V> {
    fn from_iter<I: IntoIterator<Item = (String, V)>>(it: I) -> Self {
        let mut m = OMap::new();
        for (k, v) in it {
            m.insert(k, v);
        }
        m
    }
}

impl<V: Serialize> Serialize for OMap<V> {
    fn serialize<S: Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        let mut m = s.serialize_map(Some(self.entries.len()))?;
        for (k, v) in &self.entries {
            m.serialize_entry(k, v)?;
        }
        m.end()
    }
}

impl<'de, V: Deserialize<'de>> Deserialize<'de> for OMap<V> {
    fn deserialize<D: Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        struct V_<V>(PhantomData<V>);
        impl<'de, V: Deserialize<'de>> Visitor<'de> for V_<V> {
            type Value = OMap<V>;
            fn expecting(&self, f: &mut fmt::Formatter) -> fmt::Result {
                f.write_str("an object")
            }
            fn visit_map<A: MapAccess<'de>>(self, mut a: A) -> Result<OMap<V>, A::Error> {
                let mut m = OMap::new();
                while let Some((k, v)) = a.next_entry::<String, V>()? {
                    m.insert(k, v);
                }
                Ok(m)
            }
        }
        d.deserialize_map(V_(PhantomData))
    }
}

#[derive(Debug, Clone, Default, PartialEq)]
pub struct Block {
    pub trading: f64,
    pub ref_hedge: f64,
    pub factor_hedge: f64,
    pub fills: i64,
    pub volume: f64,
    pub covered_s: i64,
    pub backfilled_s: i64,
}

impl Block {
    pub fn new(trading: f64, ref_hedge: f64, factor_hedge: f64, fills: i64, volume: f64, covered_s: i64,
               backfilled_s: i64) -> Self {
        Block { trading, ref_hedge, factor_hedge, fills, volume, covered_s, backfilled_s }
    }

    pub fn hedged(&self) -> f64 {
        self.trading - self.ref_hedge
    }

    pub fn factor(&self) -> f64 {
        self.trading - self.factor_hedge
    }

    pub fn booked_s(&self) -> i64 {
        self.covered_s + self.backfilled_s
    }
}

/// A row of the store's pnl_hour table: (t, trading, hedged, factor, ref_hedge, factor_hedge, fills, volume,
/// covered_s, backfilled_s); rows from before backfill existed read backfilled_s as 0.
#[derive(Debug, Clone, PartialEq)]
pub struct HourRow {
    pub t: i64,
    pub trading: f64,
    pub hedged: f64,
    pub factor: f64,
    pub ref_hedge: f64,
    pub factor_hedge: f64,
    pub fills: i64,
    pub volume: f64,
    pub covered_s: i64,
    pub backfilled_s: i64,
}

#[derive(Debug, Clone, PartialEq)]
pub struct Pos {
    pub base: String,
    pub inst: InstId,
    pub key: String,            // the instrument's key (for beta)
    pub q: f64,
    pub q0: f64,
    pub m: Option<f64>,         // M_k(t-1)
    pub r: Option<f64>,         // R_k(t-1)
    pub h: f64,                 // today's H_k
    pub m_start: Option<f64>,   // M when booking began: stands in for M_k(D) until that is known
    pub t0: i64,                // ms the opening quantity was taken from the balance at
}

impl Pos {
    pub fn new(base: &str, inst: InstId, key: &str, q: f64, q0: f64) -> Self {
        Pos { base: base.into(), inst, key: key.into(), q, q0, m: None, r: None, h: 0.0, m_start: None, t0: 0 }
    }
}

/// Today's fills of one base: sum s q, and the cash legs by quote asset and fee asset (for the closed form).
#[derive(Debug, Clone, Default)]
pub struct FillSum {
    pub sq: f64,
    pub cash: OMap<f64>,   // quote asset -> sum s q p
    pub fees: OMap<f64>,   // fee asset -> sum fee
}

/// What the book keeps of a fill (Python keeps the FillRec itself).
#[derive(Debug, Clone, PartialEq)]
pub struct PFill {
    pub ts: i64,
    pub symbol: String,
    pub venue: Venue,
    pub side: Side,
    pub price: f64,
    pub qty: f64,
    pub fee: f64,
    pub fee_asset: String,
}

impl From<&FillRec> for PFill {
    fn from(f: &FillRec) -> Self {
        PFill { ts: f.ts, symbol: f.symbol.clone(), venue: f.venue, side: f.side, price: f.price, qty: f.qty,
                fee: f.fee, fee_asset: f.fee_asset.clone() }
    }
}

/// (M, R) per base at a gap's start or end.
pub type Marks = OMap<(Option<f64>, Option<f64>)>;

/// Grid seconds (a, b] to backfill. only: restricted to these bases (a name that joined the scope late,
/// over intervals already booked without it); start / end: (M, R) per base and R_b at a and b when known
/// from the live grid (kline prices otherwise). id: identity (Python compares the object).
#[derive(Debug, Clone, PartialEq)]
pub struct Gap {
    pub id: u64,
    pub a: i64,
    pub b: i64,
    pub only: Option<HashSet<String>>,
    pub start: Option<Marks>,
    pub end: Option<Marks>,
    pub rb0: Option<f64>,
    pub rb1: Option<f64>,
}

impl Gap {
    pub fn new(a: i64, b: i64) -> Self {
        Gap { id: 0, a, b, only: None, start: None, end: None, rb0: None, rb1: None }
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct Plan {
    pub names: Vec<String>,
    pub fetch: Vec<(String, i64, i64)>,   // (instrument key, start ms, end ms)
}

/// 1 min klines of one instrument: price at a time = the open of the bar starting there, else the
/// open or close of the bar containing it (whichever is nearer), else the last close before.
#[derive(Debug, Clone, Default)]
pub struct Bars {
    pub t: Vec<i64>,
    pub o: Vec<f64>,
    pub c: Vec<f64>,
}

impl Bars {
    pub fn new(rows: impl IntoIterator<Item = (i64, f64, f64)>) -> Self {
        let mut rows: Vec<_> = rows.into_iter().collect();
        rows.sort_by(|x, y| x.0.cmp(&y.0).then(x.1.total_cmp(&y.1)).then(x.2.total_cmp(&y.2)));
        Bars { t: rows.iter().map(|r| r.0).collect(), o: rows.iter().map(|r| r.1).collect(),
               c: rows.iter().map(|r| r.2).collect() }
    }

    pub fn at(&self, t_ms: i64) -> Option<f64> {
        let i = self.t.partition_point(|&x| x <= t_ms);
        if i == 0 {
            return (!self.t.is_empty() && self.t[0] - t_ms <= 60_000).then(|| self.o[0]);
        }
        let i = i - 1;
        let d = t_ms - self.t[i];
        Some(if d < 30_000 { self.o[i] } else { self.c[i] })
    }
}

/// Where the previous run ended: its last booked second, R_b and (M, R) per base.
#[derive(Debug, Clone, PartialEq)]
pub struct Prev {
    pub t: i64,
    pub rb: Option<f64>,
    pub k: Marks,
}

/// Today's state saved by flush() (JSON in the store's kv `pnlstate:<day start>`):
/// {"t", "rb", "spans": [[a, b, 0 live | 1 backfilled]], "m0": {base: M_k(D)}, "k": {base: [H_k, M, R]}}.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct PnlState {
    #[serde(default)]
    pub t: Option<i64>,
    #[serde(default)]
    pub rb: Option<f64>,
    #[serde(default)]
    pub spans: Vec<[i64; 3]>,
    #[serde(default)]
    pub m0: OMap<f64>,
    #[serde(default)]
    pub k: OMap<(f64, Option<f64>, Option<f64>)>,
}

pub type BalanceFn = Box<dyn Fn(&str) -> f64>;
pub type ScopeFn = Box<dyn Fn() -> Vec<String>>;
pub type BetaFn = Box<dyn Fn(&str) -> f64>;
pub type TakerFn = Box<dyn Fn(&Inst) -> f64>;

/// balance(base): current total base balance across the desk's accounts; scope(): spot instrument
/// keys in scope besides those filled today; beta(inst key): its beta; taker_bps(inst): taker fee.
pub struct PnlBook {
    pub day_start: i64,
    pub balance: BalanceFn,
    pub scope: ScopeFn,
    pub beta: BetaFn,
    pub beta_vs: Option<String>,
    pub taker_bps: TakerFn,
    pub pos: OMap<Pos>,
    pub hours: BTreeMap<i64, Block>,
    pub dirty: HashSet<i64>,
    pub pending: Vec<(i64, Rc<PFill>)>,
    pub seen_sq: HashMap<String, f64>,     // today's fills, s q by base: all seen
    pub applied_sq: HashMap<String, f64>,  // ... and already in Q
    pub sums: HashMap<String, FillSum>,    // today's fills by base, for the closed form
    pub day_fills: HashMap<String, Vec<(i64, f64, Rc<PFill>)>>,   // base -> (grid second, s q, fill)
    pub saved: HashMap<String, f64>,       // today's H_k from before a restart
    pub m0: OMap<f64>,                     // M_k(D)
    pub spans: Vec<[i64; 3]>,              // today's booked intervals: [a, b, 0 live | 1 backfilled]
    pub live: Option<usize>,               // the live span being extended (index into spans)
    pub prev: Option<Prev>,                // end of the previous run
    pub gaps: Vec<Gap>,                    // waiting for backfill
    pub last: Option<i64>,                 // last booked grid second
    pub rb: Option<f64>,                   // R_b(t-1)
    next_gap: u64,
}

impl PnlBook {
    pub fn new(day_start: i64, balance: BalanceFn, scope: ScopeFn, beta: BetaFn, beta_vs: Option<String>,
               taker_bps: Option<TakerFn>) -> Self {
        PnlBook {
            day_start,
            balance,
            scope,
            beta,
            beta_vs,
            taker_bps: taker_bps.unwrap_or_else(|| Box::new(|_| 0.0)),
            pos: OMap::new(),
            hours: BTreeMap::new(),
            dirty: HashSet::new(),
            pending: vec![],
            seen_sq: HashMap::new(),
            applied_sq: HashMap::new(),
            sums: HashMap::new(),
            day_fills: HashMap::new(),
            saved: HashMap::new(),
            m0: OMap::new(),
            spans: vec![],
            live: None,
            prev: None,
            gaps: vec![],
            last: None,
            rb: None,
            next_gap: 0,
        }
    }

    pub fn d_s(&self) -> i64 {
        self.day_start.div_euclid(1000)
    }

    // inputs

    /// (base asset, the asset's own instrument, the fill's instrument) of a spot fill.
    fn base_of(m: &mut Market, f: &PFill) -> Option<(String, InstId, InstId)> {
        if f.venue != Venue::Spot {
            return None;
        }
        let inst = m.ensure(&f.symbol, Venue::Spot, None);
        let base = m.insts[inst].base.clone();
        let own = m.asset_inst(&base).unwrap_or(inst);
        Some((base, own, inst))
    }

    fn seen(&mut self, m: &Market, base: &str, inst: InstId, idx: i64, f: &Rc<PFill>) {
        let sq = sign(f.side) * f.qty;
        *self.seen_sq.entry(base.to_string()).or_insert(0.0) += sq;
        let s = self.sums.entry(base.to_string()).or_default();
        s.sq += sq;
        let quote = &m.insts[inst].quote;
        let c = s.cash.get(quote).copied().unwrap_or(0.0) + sq * f.price;
        s.cash.insert(quote.clone(), c);
        if f.fee != 0.0 && !f.fee_asset.is_empty() {
            let v = s.fees.get(&f.fee_asset).copied().unwrap_or(0.0) + f.fee;
            s.fees.insert(f.fee_asset.clone(), v);
        }
        self.day_fills.entry(base.to_string()).or_default().push((idx, sq, f.clone()));
    }

    fn add_applied(&mut self, base: &str, sq: f64) {
        *self.applied_sq.entry(base.to_string()).or_insert(0.0) += sq;
    }

    /// Today's fills from before a restart: already in the balances, so already in Q.
    pub fn load_fills<'a>(&mut self, m: &mut Market, fills: impl IntoIterator<Item = &'a FillRec>) {
        for f in fills {
            let f = Rc::new(PFill::from(f));
            if let Some((base, _, inst)) = Self::base_of(m, &f) {
                self.seen(m, &base, inst, ceil_div(f.ts, 1000), &f);
                self.add_applied(&base, sign(f.side) * f.qty);
            }
        }
        for v in self.day_fills.values_mut() {
            v.sort_by_key(|x| x.0);
        }
    }

    pub fn on_fill(&mut self, m: &mut Market, f: &FillRec) {
        self.on_fill_at(m, f, true)
    }

    /// live: off the user stream as it happened; else swept from REST later.
    pub fn on_fill_at(&mut self, m: &mut Market, f: &FillRec, live: bool) {
        let f = Rc::new(PFill::from(f));
        let Some((base, _, inst)) = Self::base_of(m, &f) else { return };
        if !live
            && let Some(t0) = self.pos.get(&base).map(|p| p.t0)
            && f.ts < t0
        {
            // from before the balance the opening quantity came from (a REST sweep after a restart): it is
            // in Q already, but was not taken out of Q0
            let sq = sign(f.side) * f.qty;
            self.seen(m, &base, inst, ceil_div(f.ts, 1000), &f);
            self.add_applied(&base, sq);
            if let Some(p) = self.pos.get_mut(&base) {
                p.q0 -= sq;
            }
            if let Some(v) = self.day_fills.get_mut(&base) {
                v.sort_by_key(|x| x.0);
            }
            return;
        }
        let mut idx = ceil_div(f.ts, 1000);
        if let Some(last) = self.last
            && idx <= last
        {
            idx = last + 1;   // arrived after its second was booked: the next one
        }
        self.seen(m, &base, inst, idx, &f);
        self.pending.push((idx, f));
    }

    pub fn load_hours<'a>(&mut self, rows: impl IntoIterator<Item = &'a HourRow>) {
        for r in rows {
            self.hours.insert(r.t, Block::new(r.trading, r.ref_hedge, r.factor_hedge, r.fills, r.volume, r.covered_s,
                                              r.backfilled_s));
        }
    }

    /// Today's state saved by flush(): booked spans, M_k(D), H_k and where the last run ended.
    /// legacy_syms: the `pnlsym:<day>` kv of before spans were kept, {base: [_, H_k, ...]}.
    pub fn load_state(&mut self, state: Option<PnlState>, legacy_syms: Option<&serde_json::Value>) {
        if let Some(state) = state {
            self.spans = state.spans;
            self.m0 = state.m0;
            self.saved = state.k.iter().map(|(b, v)| (b.to_string(), v.0)).collect();
            if let Some(t) = state.t {
                self.prev = Some(Prev { t, rb: state.rb, k: state.k.iter().map(|(b, v)| (b.to_string(), (v.1, v.2))).collect() });
            }
            return;
        }
        // from before spans were kept: an hour booked at all counts as booked
        if let Some(obj) = legacy_syms.and_then(|v| v.as_object()) {
            self.saved = obj.iter().map(|(b, v)| (b.clone(), v.get(1).and_then(|x| x.as_f64()).unwrap_or(0.0))).collect();
        }
        for (&t, blk) in &self.hours {
            if self.day_start <= t && t < self.day_start + DAY && blk.covered_s > 0 {
                self.spans.push([t.div_euclid(1000), (t + HOUR).div_euclid(1000), 0]);
            }
        }
    }

    /// Live spans can only lie where the monitor was running (from its 5 s equity rows); the
    /// rest of a saved live span was never booked and becomes a gap to backfill.
    pub fn clip_live(&mut self, alive: &[(i64, i64)]) {
        let mut out = vec![];
        for &[a, b, kind] in &self.spans {
            if kind != 0 {
                out.push([a, b, kind]);
                continue;
            }
            out.extend(alive.iter().filter(|&&(x, y)| b.min(y) > a.max(x)).map(|&(x, y)| [a.max(x), b.min(y), 0]));
        }
        self.spans = out;
    }

    // the grid

    pub fn started(&self) -> bool {
        self.last.is_some()
    }

    fn marks(&self) -> Marks {
        self.pos.iter().map(|(b, p)| (b.to_string(), (p.m, p.r))).collect()
    }

    /// Start booking at the current grid second; Q is the balance minus fills not yet booked. The
    /// day's unbooked intervals before it are queued for backfill.
    pub fn begin(&mut self, m: &mut Market, now: i64) {
        let t = (now - LAG_MS).div_euclid(1000);
        self.last = Some(t);
        let mut keep = vec![];
        for (idx, f) in std::mem::take(&mut self.pending) {
            if idx <= t {
                let b = Self::base_of(m, &f).expect("spot").0;
                self.add_applied(&b, sign(f.side) * f.qty);
            } else {
                keep.push((idx, f));
            }
        }
        self.pending = keep;
        self.sync_scope(m, t);
        let end = self.marks();
        let prev = self.prev.clone();
        for (a, b) in self.holes(t) {
            let start = prev.as_ref().filter(|p| p.t == a).map(|p| p.k.clone());
            let rb0 = if start.as_ref().is_some_and(|s| !s.is_empty()) { prev.as_ref().and_then(|p| p.rb) } else { None };
            self.queue(Gap { id: 0, a, b, only: None, start, end: (b == t).then(|| end.clone()), rb0,
                             rb1: if b == t { self.rb } else { None } });
        }
        self.spans.push([t, t, 0]);
        self.live = Some(self.spans.len() - 1);
    }

    /// Intervals of today before second t not in any span.
    pub fn holes(&self, t: i64) -> Vec<(i64, i64)> {
        let mut out = vec![];
        let mut cur = self.d_s();
        let mut spans = self.spans.clone();
        spans.sort();
        for [a, b, _] in spans {
            if a > cur {
                out.push((cur, a.min(t)));
            }
            cur = cur.max(b);
            if cur >= t {
                break;
            }
        }
        if cur < t {
            out.push((cur, t));
        }
        out.into_iter().filter(|(a, b)| b > a).collect()
    }

    fn push_gap(&mut self, mut g: Gap) {
        self.next_gap += 1;
        g.id = self.next_gap;
        self.gaps.push(g);
    }

    fn queue(&mut self, g: Gap) {
        if g.b - g.a >= MIN_BACKFILL_S || g.only.is_some() {
            self.push_gap(g);
        }
    }

    fn add(&mut self, m: &Market, base: &str, inst: InstId, t: i64) {
        let q0 = (self.balance)(base) - self.seen_sq.get(base).copied().unwrap_or(0.0);
        let mut p = Pos::new(base, inst, &m.insts[inst].key, q0 + self.applied_sq.get(base).copied().unwrap_or(0.0), q0);
        p.h = self.saved.get(base).copied().unwrap_or(0.0);
        p.t0 = t * 1000;
        // just started, the rings may not reach back to t yet: the current price stands in
        p.m = nz(m.insts[inst].ring.at(t * 1000 - 1)).or(m.px(inst));
        p.m_start = p.m;
        p.r = Self::ref_mid(m, inst, t, true);
        self.pos.insert(base, p);
        if self.live.is_some() && q0 != 0.0 {
            // joined the scope after booking began: its inventory over what is already booked needs backfill
            let d_s = self.d_s();
            let spans = self.spans.clone();
            for [a, b, _] in spans {
                if a < t && b > d_s {
                    let mut g = Gap::new(a.max(d_s), b.min(t));
                    g.only = Some(HashSet::from([base.to_string()]));
                    self.push_gap(g);
                }
            }
        }
    }

    fn sync_scope(&mut self, m: &mut Market, t: i64) {
        // Python iterates a set (arbitrary order); here scope order, then the pending fills' order
        let mut keys = (self.scope)();
        keys.extend(self.pending.iter().map(|(_, f)| format!("spot:{}", f.symbol)));
        let mut seen = HashSet::new();
        for k in keys {
            if !seen.insert(k.clone()) {
                continue;
            }
            let Some(inst) = m.id(&k) else { continue };
            if m.insts[inst].venue != Venue::Spot {
                continue;
            }
            let base = m.insts[inst].base.clone();
            let own = m.asset_inst(&base).unwrap_or(inst);
            if !self.pos.contains_key(&base) {
                self.add(m, &base, own, t);
            }
        }
        if let Some(bv) = &self.beta_vs
            && let Some(b) = m.get(bv)
            && self.rb.is_none()
        {
            self.rb = nz(b.ring.at(t * 1000 - 1)).or(b.mid());
        }
    }

    /// The reference's mid at second t; now: the current mid if the ring has none that old.
    fn ref_mid(m: &Market, inst: InstId, t: i64, now: bool) -> Option<f64> {
        let r = &m.insts[m.insts[inst].ref_?];
        nz(r.ring.at(t * 1000 - 1)).or(if now { r.mid() } else { None })
    }

    pub fn step(&mut self, m: &mut Market, now: i64) {
        let Some(mut last) = self.last else { return };
        let target = (now - LAG_MS).div_euclid(1000);
        if target <= last {
            return;
        }
        if target - last > MAX_GAP_S {   // stalled past the rings: restart the grid, backfill the gap
            let a = last;
            let start = self.marks();
            let rb0 = self.rb;
            last = target - 1;
            self.last = Some(last);
            let mut keep = vec![];
            for (idx, f) in std::mem::take(&mut self.pending) {   // fills inside the gap go into Q; the backfill books them
                if idx <= last {
                    let base = Self::base_of(m, &f).expect("spot").0;
                    let sq = sign(f.side) * f.qty;
                    if let Some(p) = self.pos.get_mut(&base) {
                        p.q += sq;
                    }
                    self.add_applied(&base, sq);
                } else {
                    keep.push((idx, f));
                }
            }
            self.pending = keep;
            self.rb = None;
            for p in self.pos.values_mut() {
                let mm = nz(m.insts[p.inst].ring.at(last * 1000 - 1)).or(p.m);
                let rr = nz(Self::ref_mid(m, p.inst, last, false)).or(p.r);
                (p.m, p.r) = (mm, rr);
            }
            self.sync_scope(m, last);
            if a >= self.d_s() {
                let end = self.marks();
                self.queue(Gap { id: 0, a, b: last, only: None, start: Some(start), end: Some(end), rb0, rb1: self.rb });
            }
            self.spans.push([last, last, 0]);
            self.live = Some(self.spans.len() - 1);
        }
        self.sync_scope(m, last);
        for t in last + 1..=target {
            self.second(m, t);
        }
        self.last = Some(target);
        if let Some(i) = self.live {
            self.spans[i][1] = target;
        }
    }

    fn block(&mut self, tm: i64) -> i64 {
        let hour = tm - tm.rem_euclid(HOUR);
        self.hours.entry(hour).or_default();
        self.dirty.insert(hour);
        hour
    }

    fn blk(&mut self, hour: i64) -> &mut Block {
        self.hours.get_mut(&hour).expect("block")
    }

    /// (price, fee) of a fill in USDT, at today's conversion prices.
    fn usd(m: &mut Market, f: &PFill, inst: InstId) -> (f64, f64) {
        let quote = m.insts[inst].quote.clone();
        let px = f.price * nz(m.asset_price(&quote)).unwrap_or(1.0);
        let fee = if f.fee != 0.0 && !f.fee_asset.is_empty() {
            f.fee * nz(m.asset_price(&f.fee_asset)).unwrap_or(0.0)
        } else {
            0.0
        };
        (px, fee)
    }

    fn second(&mut self, m: &mut Market, t: i64) {
        let tm = t * 1000 - 1;
        if tm >= self.day_start + DAY {
            self.roll(m, tm - (tm - self.day_start).rem_euclid(DAY), Some(t - 1));
        }
        let hour = self.block(tm);
        let (mut d_pi, mut d_h, mut expo) = (0.0, 0.0, 0.0);
        for p in self.pos.values_mut() {
            let inst = &m.insts[p.inst];
            let mid = nz(inst.ring.at(tm)).or(p.m);
            let rf = Self::ref_mid(m, p.inst, t, false);
            if let (Some(pm), Some(mid)) = (p.m, mid) {
                let dp = p.q * (mid - pm);
                let dh = match (nz(rf), nz(p.r)) {
                    (Some(rf), Some(pr)) => p.q * pm * (rf / pr - 1.0),
                    _ => 0.0,
                };
                expo += (self.beta)(&p.key) * p.q * pm;
                p.h += dh;
                d_pi += dp;
                d_h += dh;
            }
            p.m = mid;
            if truthy(rf) {
                p.r = rf;
            }
        }
        let mut d_hm = 0.0;
        if let Some(bv) = &self.beta_vs
            && let Some(b) = m.get(bv)
        {
            let rb = b.ring.at(tm);
            if let (Some(rb), Some(prb)) = (nz(rb), nz(self.rb)) {
                d_hm = expo * (rb / prb - 1.0);
            }
            if truthy(rb) {
                self.rb = rb;
            }
        }
        if !self.pending.is_empty() {
            let mut keep = vec![];
            for (idx, f) in std::mem::take(&mut self.pending) {
                if idx > t {
                    keep.push((idx, f));
                    continue;
                }
                let (base, own, inst) = Self::base_of(m, &f).expect("spot");
                if !self.pos.contains_key(&base) {
                    self.add(m, &base, own, t - 1);
                }
                let (px, fee) = Self::usd(m, &f, inst);
                let p = self.pos.get_mut(&base).expect("pos");
                if p.m.is_none() {
                    p.m = Some(px);
                }
                let sq = sign(f.side) * f.qty;
                d_pi += sq * (p.m.unwrap() - px) - fee;
                p.q += sq;
                self.add_applied(&base, sq);
                let blk = self.blk(hour);
                blk.fills += 1;
                blk.volume += px * f.qty;
            }
            // fills that arrived during this loop (none: single-threaded) would be lost
            self.pending = keep;
        }
        let blk = self.blk(hour);
        blk.trading += d_pi;
        blk.ref_hedge += d_h;
        blk.factor_hedge += d_hm;
        blk.covered_s += 1;
    }

    /// New day: Q carries over and M_k(D) is the last mark; the fills still pending are the new day's first.
    pub fn roll(&mut self, m: &mut Market, day_start: i64, t: Option<i64>) {
        self.day_start = day_start;
        self.seen_sq.clear();
        self.applied_sq.clear();
        self.sums.clear();
        self.day_fills.clear();
        for (idx, f) in self.pending.clone() {
            let (base, _, inst) = Self::base_of(m, &f).expect("spot");
            self.seen(m, &base, inst, idx, &f);
        }
        self.saved.clear();
        self.m0 = OMap::new();
        for p in self.pos.values_mut() {
            p.h = 0.0;
            p.q0 = p.q;
            p.m_start = p.m;
            if let Some(pm) = p.m {
                self.m0.insert(p.base.clone(), pm);
            }
        }
        self.prev = None;
        let t = t.unwrap_or_else(|| self.d_s());
        self.spans = vec![[t, t, 0]];
        self.live = Some(0);
    }

    // backfill

    /// Q_k after the fills booked by grid second t.
    pub fn q_at(&self, base: &str, t: i64) -> f64 {
        let mut q = self.pos[base].q0;
        for (idx, sq, _) in self.day_fills.get(base).map(Vec::as_slice).unwrap_or(&[]) {
            if *idx > t {
                break;
            }
            q += sq;
        }
        q
    }

    fn gap_fills(&self, base: &str, g: &Gap) -> Vec<(i64, f64, Rc<PFill>)> {
        self.day_fills.get(base).map_or_else(Vec::new, |v| {
            v.iter().filter(|x| g.a < x.0 && x.0 <= g.b).cloned().collect()
        })
    }

    /// Names with inventory or fills in the gap, and the 1 min klines to fetch: each name's own instrument
    /// and reference, and the beta instrument.
    pub fn plan(&self, m: &Market, g: &Gap) -> Plan {
        let mut names = vec![];
        let (lo, hi) = (g.a * 1000 - (g.a * 1000).rem_euclid(60_000), g.b * 1000);
        for (base, p) in self.pos.iter() {
            if let Some(only) = &g.only
                && !only.contains(base)
            {
                continue;
            }
            let fl = self.gap_fills(base, g);
            let mut q = self.q_at(base, g.a);
            let mut qmax = q.abs();
            for (_, sq, _) in &fl {
                q += sq;
                qmax = qmax.max(q.abs());
            }
            let px = nz(m.px(p.inst)).or(p.m);
            if !fl.is_empty() || (qmax != 0.0 && px.is_none_or(|px| qmax * px >= DUST_USD)) {
                names.push(base.to_string());
            }
        }
        let mut fetch = vec![];
        let mut seen = HashSet::new();
        for base in &names {
            let inst = &m.insts[self.pos[base].inst];
            let r = inst.ref_.map(|r| m.insts[r].key.clone());
            for k in [Some(inst.key.clone()), r].into_iter().flatten() {
                if seen.insert(k.clone()) {
                    fetch.push((k, lo, hi));
                }
            }
        }
        if !names.is_empty()
            && let Some(bv) = &self.beta_vs
            && !seen.contains(bv)
        {
            fetch.push((bv.clone(), lo, hi));
        }
        Plan { names, fetch }
    }

    /// Book a gap on a 1 min grid: the points are a, each minute boundary inside, and b.
    pub fn book_gap(&mut self, m: &mut Market, g: &Gap, plan: &Plan, bars: &HashMap<String, Bars>) {
        let mut pts = vec![g.a];
        pts.extend((g.a - g.a.rem_euclid(MIN_S) + MIN_S..g.b).step_by(MIN_S as usize));
        pts.push(g.b);
        let today = g.a >= self.d_s();
        let full = g.only.is_none();
        let px = |k: Option<&str>, t: i64| -> Option<f64> { k.and_then(|k| bars.get(k).and_then(|b| b.at(t * 1000))) };
        let keys = |m: &Market, p: &Pos| -> (String, Option<String>) {
            let inst = &m.insts[p.inst];
            (inst.key.clone(), inst.ref_.map(|r| m.insts[r].key.clone()))
        };
        struct St {
            base: String,
            key: String,
            rkey: Option<String>,
            q: f64,
            m: Option<f64>,
            r: Option<f64>,
            fl: Vec<(i64, f64, Rc<PFill>)>,
            i: usize,
        }
        let none = (None, None);
        let mut st: Vec<St> = vec![];
        for base in &plan.names {
            if st.iter().any(|s| &s.base == base) {
                continue;
            }
            let (key, rkey) = keys(m, &self.pos[base]);
            let (mut m0, r0) = *g.start.as_ref().and_then(|s| s.get(base)).unwrap_or(&none);
            if m0.is_none() && g.a == self.d_s() && let Some(&v) = self.m0.get(base) {
                m0 = Some(v);
            }
            let m0 = nz(m0).or(px(Some(&key), g.a));
            let r0 = nz(r0).or(px(rkey.as_deref(), g.a));
            if g.a == self.d_s() && !self.m0.contains_key(base) && let Some(v) = nz(m0) {
                self.m0.insert(base.clone(), v);
            }
            let fl = self.gap_fills(base, g);
            st.push(St { base: base.clone(), key, rkey, q: self.q_at(base, g.a), m: m0, r: r0, fl, i: 0 });
        }
        let bv = self.beta_vs.clone();
        let mut rb_prev = nz(g.rb0).or(px(bv.as_deref(), g.a));
        for j in 1..pts.len() {
            let (t, last) = (pts[j], j == pts.len() - 1);
            let hour = self.block(t * 1000 - 1);
            let (mut d_pi, mut d_h, mut expo) = (0.0, 0.0, 0.0);
            for s in st.iter_mut() {
                let e = if last { *g.end.as_ref().and_then(|e| e.get(&s.base)).unwrap_or(&none) } else { none };
                let (m_prev, r_prev) = (s.m, s.r);
                let mm = nz(e.0).or(nz(px(Some(&s.key), t))).or(m_prev);
                let r = nz(e.1).or(nz(px(s.rkey.as_deref(), t))).or(r_prev);
                if let (Some(mp), Some(mv)) = (m_prev, mm) {
                    d_pi += s.q * (mv - mp);
                    let dh = match (nz(r), nz(r_prev)) {
                        (Some(r), Some(rp)) => s.q * mp * (r / rp - 1.0),
                        _ => 0.0,
                    };
                    d_h += dh;
                    if today {
                        self.pos.get_mut(&s.base).expect("pos").h += dh;
                    }
                    expo += (self.beta)(&s.key) * s.q * mp;
                }
                while s.i < s.fl.len() && s.fl[s.i].0 <= t {
                    let (_, sq, f) = s.fl[s.i].clone();
                    if full {
                        let fi = m.ensure(&f.symbol, Venue::Spot, None);
                        let (fpx, fee) = Self::usd(m, &f, fi);
                        d_pi += sq * (nz(mm).unwrap_or(fpx) - fpx) - fee;
                        let blk = self.hours.get_mut(&hour).expect("block");
                        blk.fills += 1;
                        blk.volume += fpx * f.qty;
                    }
                    s.q += sq;
                    s.i += 1;
                }
                s.m = mm;
                s.r = r;
            }
            let rb = nz(if last { g.rb1 } else { None }).or(nz(px(bv.as_deref(), t))).or(rb_prev);
            let d_hm = match (nz(rb), nz(rb_prev)) {
                (Some(rb), Some(rp)) => expo * (rb / rp - 1.0),
                _ => 0.0,
            };
            rb_prev = rb;
            let blk = self.blk(hour);
            blk.ref_hedge += d_h;
            blk.factor_hedge += d_hm;
            if full {
                blk.trading += d_pi;
                blk.backfilled_s += t - pts[j - 1];
            }
        }
        if full {
            self.spans.push([g.a, g.b, 1]);
        }
    }

    /// Bases held at the day start whose M_k(D) is unknown and no queued backfill will supply it.
    pub fn need_m0(&self, m: &Market) -> Vec<String> {
        let from_gaps = self.gaps.iter().any(|g| g.a == self.d_s());
        let mut out = vec![];
        for (base, p) in self.pos.iter() {
            if self.m0.contains_key(base) || p.q0 == 0.0 || from_gaps {
                continue;
            }
            let px = nz(m.px(p.inst)).or(p.m);
            if px.is_none_or(|px| p.q0.abs() * px >= DUST_USD) {
                out.push(base.to_string());
            }
        }
        out
    }

    // outputs

    pub fn today(&self) -> Vec<(i64, &Block)> {
        self.hours.range(self.day_start..self.day_start + DAY).map(|(t, b)| (*t, b)).collect()
    }

    /// Cost of closing the inventory now: |Q M| x (half spread + taker fee).
    pub fn liquidation(&self, m: &Market) -> f64 {
        let mut out = 0.0;
        for p in self.pos.values() {
            let inst = &m.insts[p.inst];
            if let Some(mid) = nz(inst.mid())
                && p.q != 0.0
            {
                let half = (inst.ask - inst.bid) / 2.0 / mid * 1e4;
                out += (p.q * mid).abs() * (half + (self.taker_bps)(inst)) / 1e4;
            }
        }
        out
    }

    /// Closed-form trading P&L of one base today: Q_T M(T) - Q0 M(D) - cash paid - fees.
    pub fn pi_k(&self, m: &mut Market, p: &Pos) -> f64 {
        let Some(mt) = nz(m.px(p.inst)).or(p.m) else { return 0.0 };
        let m0 = nz(self.m0.get(&p.base).copied()).or(nz(p.m_start)).unwrap_or(mt);
        let Some(s) = self.sums.get(&p.base) else { return p.q0 * (mt - m0) };
        let mut out = (p.q0 + s.sq) * mt - p.q0 * m0;
        for (a, v) in s.cash.iter() {
            out -= v * nz(m.asset_price(a)).unwrap_or(1.0);
        }
        for (a, v) in s.fees.iter() {
            out -= v * nz(m.asset_price(a)).unwrap_or(0.0);
        }
        out
    }

    /// Π_k split over today's fills in time order, in USD: (realized, realized_old, floating). Sells take
    /// today's buys first, oldest first, and the inventory held at the day start (at M_k(D)) only when no
    /// buy of today is left. realized: sells against today's buys, minus today's fees; realized_old: sells
    /// against the opening inventory, or beyond it, at M_k(D); floating: what is left at M_k(T) against cost.
    pub fn fifo(&self, m: &mut Market, p: &Pos) -> (f64, f64, f64) {
        let Some(mt) = nz(m.px(p.inst)).or(p.m) else { return (0.0, 0.0, 0.0) };
        let m0 = nz(self.m0.get(&p.base).copied()).or(nz(p.m_start)).unwrap_or(mt);
        let mut lots: std::collections::VecDeque<(f64, f64)> = std::collections::VecDeque::new();   // today's buys
        // the inventory at the day start as Π takes it (balance minus today's fills: negative when a fill went unseen)
        let mut opening = p.q0;
        let mut fills: Vec<&Rc<PFill>> = self.day_fills.get(&p.base).map(|v| v.iter().map(|x| &x.2).collect()).unwrap_or_default();
        fills.sort_by_key(|f| f.ts);
        let (mut realized, mut old, mut fees) = (0.0, 0.0, 0.0);
        for f in fills {
            let quote = m.get(&crate::market::key(&f.symbol, f.venue)).map(|i| i.quote.clone());
            let qpx = quote.as_deref().and_then(|q| nz(m.asset_price(q))).unwrap_or(1.0);
            let px = f.price * qpx;
            if f.fee != 0.0 {
                fees += f.fee * nz(m.asset_price(&f.fee_asset)).unwrap_or(0.0);
            }
            if f.side == Side::Buy {
                lots.push_back((f.qty, px));
                continue;
            }
            let mut left = f.qty;
            while left > 1e-15 {
                let Some(lot) = lots.front_mut() else { break };
                let take = lot.0.min(left);
                realized += take * (px - lot.1);
                lot.0 -= take;
                left -= take;
                if lot.0 <= 1e-15 {
                    lots.pop_front();
                }
            }
            if left > 1e-15 {
                // from the opening inventory; beyond it, inventory the opening balance did not show
                old += left * (px - m0);
                opening -= left;
            }
        }
        let floating = lots.iter().map(|(q, c)| q * (mt - c)).sum::<f64>() + opening * (mt - m0);
        (realized - fees, old, floating)
    }

    pub fn fifo_total(&self, m: &mut Market) -> (f64, f64, f64) {
        let mut t = (0.0, 0.0, 0.0);
        for p in self.pos.values() {
            let (a, b, c) = self.fifo(m, p);
            t = (t.0 + a, t.1 + b, t.2 + c);
        }
        t
    }

    pub fn trading(&self, m: &mut Market) -> f64 {
        self.pos.values().map(|p| self.pi_k(m, p)).sum()
    }

    /// Booked (live or backfilled) over the whole span, so H covers what the closed-form Π covers.
    pub fn whole(blocks: &[&Block], span_s: f64) -> bool {
        blocks.iter().map(|b| b.booked_s()).sum::<i64>() as f64 >= span_s - COVER_SLACK_S as f64
    }

    pub fn s_a(blocks: &[&Block], pi: f64, whole: bool) -> (f64, f64) {
        // Π − H only when H spans the same time as Π; otherwise both from the booked seconds alone
        if whole {
            return (pi - blocks.iter().map(|b| b.ref_hedge).sum::<f64>(), pi - blocks.iter().map(|b| b.factor_hedge).sum::<f64>());
        }
        (blocks.iter().map(|b| b.hedged()).sum(), blocks.iter().map(|b| b.factor()).sum())
    }

    pub fn summary(&self, m: &mut Market) -> P::PnlSummary {
        let today = self.today();
        let blocks: Vec<&Block> = today.iter().map(|(_, b)| *b).collect();
        let tr: Vec<f64> = blocks.iter().map(|b| b.trading).collect();
        let hd: Vec<f64> = blocks.iter().map(|b| b.hedged()).collect();
        let fa: Vec<f64> = blocks.iter().map(|b| b.factor()).collect();
        let pi = if self.started() { self.trading(m) } else { tr.iter().sum() };
        let (realized, realized_old, floating) = self.fifo_total(m);
        let elapsed = self.last.map_or(0.0, |l| ((l + 1) * 1000 - self.day_start) as f64 / 1000.0);
        let whole = Self::whole(&blocks, elapsed);
        let (mut sv, mut av) = Self::s_a(&blocks, pi, whole);
        if whole {   // a gap waiting for backfill has its price move in Π already but not yet its hedge
            let (dh, dhm) = self.pending_hedge();
            (sv, av) = (sv - dh, av - dhm);
        }
        P::PnlSummary {
            trading: pi,
            trading_se: nw_se(&tr, 3),
            hedged: sv,
            hedged_se: nw_se(&hd, 3),
            factor: av,
            factor_se: nw_se(&fa, 3),
            ref_hedge: blocks.iter().map(|b| b.ref_hedge).sum(),
            factor_hedge: blocks.iter().map(|b| b.factor_hedge).sum(),
            liquidation: self.liquidation(m),
            covered_s: blocks.iter().map(|b| b.covered_s).sum(),
            backfilled_s: blocks.iter().map(|b| b.backfilled_s).sum(),
            realized,
            realized_old,
            floating,
            mm: 0.0,          // set by the desk from the fills' markouts (metrics::mm_split)
            mm_spread: 0.0,
            inventory: pi,
        }
    }

    /// H and Hm over the gaps not yet backfilled, from their end marks (the inventory at each start):
    /// what the backfill books, short of fills and the path inside the gap.
    pub fn pending_hedge(&self) -> (f64, f64) {
        let (mut dh, mut dhm) = (0.0, 0.0);
        for g in &self.gaps {
            let (Some(start), Some(end)) = (&g.start, &g.end) else { continue };
            if g.only.is_some() || start.is_empty() || end.is_empty() {
                continue;
            }
            let mut expo = 0.0;
            for (base, &(m0, r0)) in start.iter() {
                let r1 = end.get(base).and_then(|e| e.1);
                let Some(p) = self.pos.get(base) else { continue };
                let Some(m0) = nz(m0) else { continue };
                let q = self.q_at(base, g.a);
                if let (Some(r0), Some(r1)) = (nz(r0), nz(r1)) {
                    dh += q * m0 * (r1 / r0 - 1.0);
                }
                expo += (self.beta)(&p.key) * q * m0;
            }
            if let (Some(rb0), Some(rb1)) = (nz(g.rb0), nz(g.rb1)) {
                dhm += expo * (rb1 / rb0 - 1.0);
            }
        }
        (dh, dhm)
    }

    pub fn day_rows(&self, m: &mut Market) -> Vec<P::DayPnl> {
        let mut by: BTreeMap<i64, Vec<&Block>> = BTreeMap::new();
        for (&t, b) in &self.hours {
            by.entry(t - (t - self.day_start).rem_euclid(DAY)).or_default().push(b);
        }
        if self.started() {
            by.entry(self.day_start).or_default();
        }
        let skip = by.len().saturating_sub(DAYS_SHOWN);
        let mut out = vec![];
        for (&ds, blocks) in by.iter().skip(skip) {
            let bl: Vec<&Block> = blocks.iter().copied().filter(|b| b.booked_s() > 0).collect();
            let tr: Vec<f64> = bl.iter().map(|b| b.trading).collect();
            let hd: Vec<f64> = bl.iter().map(|b| b.hedged()).collect();
            let fa: Vec<f64> = bl.iter().map(|b| b.factor()).collect();
            let today = ds == self.day_start && self.started();
            let pi = if today { self.trading(m) } else { tr.iter().sum() };
            let span = if today { ((self.last.unwrap() + 1) * 1000 - ds) as f64 / 1000.0 } else { (DAY / 1000) as f64 };
            let (sv, av) = Self::s_a(&bl, pi, Self::whole(&bl, span));
            out.push(P::DayPnl {
                day: utc_day(ds),
                trading: pi,
                trading_se: nw_se(&tr, 3),
                hedged: sv,
                hedged_se: nw_se(&hd, 3),
                factor: av,
                factor_se: nw_se(&fa, 3),
                fills: bl.iter().map(|b| b.fills).sum(),
                volume: bl.iter().map(|b| b.volume).sum(),
                covered_s: bl.iter().map(|b| b.covered_s).sum(),
                backfilled_s: bl.iter().map(|b| b.backfilled_s).sum(),
                ..Default::default()
            });
        }
        out
    }

    pub fn hour_rows(&self) -> Vec<P::HourPnl> {
        self.today()
            .into_iter()
            .map(|(t, b)| P::HourPnl { t, trading: b.trading, hedged: b.hedged(), factor: b.factor(), fills: b.fills,
                                       volume: b.volume, mm: 0.0, inventory: b.trading })
            .collect()
    }

    /// Fills and volume over the 24 h to now: the hour blocks since, the oldest prorated.
    pub fn last_24h(&self, now: i64) -> (i64, f64) {
        let cur = now - now.rem_euclid(HOUR);
        let keep = 1.0 - (now - cur) as f64 / HOUR as f64;
        let (mut fills, mut volume) = (0.0, 0.0);
        for (&t, b) in &self.hours {
            let w = if t == cur - DAY { keep } else if cur - DAY < t && t <= cur { 1.0 } else { 0.0 };
            fills += w * b.fills as f64;
            volume += w * b.volume;
        }
        (fills.round_ties_even() as i64, volume)
    }

    /// Today's (Pi_k, S_k) by base asset.
    /// Today by base: (Π_k, S_k, realized incl. sales of the opening lot, floating).
    pub fn by_base(&self, m: &mut Market) -> OMap<(f64, f64, f64, f64)> {
        let mut out = OMap::new();
        for (b, p) in self.pos.iter() {
            let pi = self.pi_k(m, p);
            let (r, o, f) = self.fifo(m, p);
            out.insert(b, (pi, pi - p.h, r + o, f));
        }
        out
    }

    /// Hour rows changed since the last flush, and today's state, for the store.
    pub fn flush(&mut self) -> (Vec<HourRow>, PnlState) {
        let mut ts: Vec<i64> = self.dirty.drain().collect();
        ts.sort();
        let rows = ts
            .into_iter()
            .filter_map(|t| {
                self.hours.get(&t).map(|b| HourRow {
                    t,
                    trading: b.trading,
                    hedged: b.hedged(),
                    factor: b.factor(),
                    ref_hedge: b.ref_hedge,
                    factor_hedge: b.factor_hedge,
                    fills: b.fills,
                    volume: b.volume,
                    covered_s: b.covered_s,
                    backfilled_s: b.backfilled_s,
                })
            })
            .collect();
        let state = PnlState {
            t: self.last,
            rb: self.rb,
            spans: self.spans.clone(),
            m0: self.m0.clone(),
            k: self.pos.iter().map(|(b, p)| (b.to_string(), (p.h, p.m, p.r))).collect(),
        };
        (rows, state)
    }

    pub fn prune(&mut self, before: i64) {
        self.hours = self.hours.split_off(&before);
    }
}

/// "%Y-%m-%d" of an epoch-ms instant, UTC.
pub fn utc_day(ms: i64) -> String {
    chrono::DateTime::from_timestamp_millis(ms).map_or_else(String::new, |d| d.format("%Y-%m-%d").to_string())
}

/// Seconds intervals covered by consecutive desk equity rows (one per 5 s while running).
/// (Kept here next to its only user, `PnlBook::clip_live`.)
pub fn alive_spans(ts_ms: &[i64], step_ms: i64, gap_ms: i64) -> Vec<(i64, i64)> {
    let mut ts = ts_ms.to_vec();
    ts.sort();
    let mut out: Vec<[i64; 2]> = vec![];
    for t in ts {
        match out.last_mut() {
            Some(l) if t - l[1] * 1000 <= gap_ms => l[1] = (t + step_ms).div_euclid(1000),
            _ => out.push([(t - step_ms).div_euclid(1000), (t + step_ms).div_euclid(1000)]),
        }
    }
    out.into_iter().map(|[a, b]| (a, b)).collect()
}

pub const ALIVE_STEP_MS: i64 = 5_000;
pub const ALIVE_GAP_MS: i64 = 60_000;

#[cfg(test)]
mod tests {
    //! P&L book cases (store round trips stand in with the rows themselves) and alive_spans.
    use super::*;
    use crate::fills::FillBook;
    use crate::market::{BookTicker, FineRing, Info, SymbolInfo};

    const DAY0: i64 = 0;

    fn close(a: f64, b: f64) -> bool {
        (a - b).abs() <= 1e-6 * b.abs().max(1e-12) || (a - b).abs() < 1e-12
    }

    macro_rules! approx {
        ($a:expr, $b:expr) => {{
            let (a, b): (f64, f64) = ($a, $b);
            assert!(close(a, b), "{} = {a} != {b}", stringify!($a));
        }};
    }

    fn market() -> Market {
        let mut info = Info::new();
        info.insert(Venue::Spot, HashMap::from([("XUSDT".to_string(), SymbolInfo::new("X", "USDT", 5.0))]));
        info.insert(Venue::Usdm, HashMap::new());
        let mut m = Market::new(info, 120.0, 100.0);
        m.ensure("XUSDT", Venue::Spot, Some(("XUSDT", Venue::Usdm)));
        m.ensure("BUSDT", Venue::Usdm, None);
        m
    }

    fn tick(m: &mut Market, t: i64, x: f64, r: f64, b: f64) {
        m.on_book(Venue::Spot, &BookTicker::new("XUSDT", x, x, Some(t)));
        m.on_book(Venue::Usdm, &BookTicker::new("XUSDT", r, r, Some(t)));
        m.on_book(Venue::Usdm, &BookTicker::new("BUSDT", b, b, Some(t)));
    }

    fn book(balance: f64) -> PnlBook {
        PnlBook::new(DAY0, Box::new(move |base| if base == "X" { balance } else { 0.0 }),
                     Box::new(|| vec!["spot:XUSDT".into()]), Box::new(|_| 0.5), Some("usdm:BUSDT".into()), None)
    }

    fn fill(id: &str, ts: i64, side: Side, price: f64, qty: f64) -> FillRec {
        FillRec::new(id, ts, "a", "XUSDT", Venue::Spot, side, price, qty)
    }

    fn fee(mut f: FillRec, fee: f64) -> FillRec {
        f.fee = fee;
        f.fee_asset = "USDT".into();
        f
    }

    fn ab(pb: &PnlBook) -> Vec<(i64, i64)> {
        pb.gaps.iter().map(|g| (g.a, g.b)).collect()
    }

    fn blocks_sum(pb: &PnlBook, f: fn(&Block) -> f64) -> f64 {
        pb.today().iter().map(|(_, b)| f(b)).sum()
    }

    fn state_rt(s: &PnlState) -> PnlState {
        serde_json::from_str(&serde_json::to_string(s).unwrap()).unwrap()
    }

    #[test]
    fn fifo_split_sums_to_pi() {
        // opening 2.5 at M(D) 97; sell 0.5 at 98 (no buy yet: from the opening inventory), buy 1 at 99
        // (fee 0.01), sell 1.5 at 101 (1 against today's buy, 0.5 from the opening inventory); mid now 100
        let mut m = market();
        tick(&mut m, 500, 100.0, 50.0, 200.0);
        let mut pb = book(1.5);
        pb.load_fills(&mut m, &[fill("a", 100, Side::Sell, 98.0, 0.5)]);
        pb.on_fill(&mut m, &fee(fill("b", 200, Side::Buy, 99.0, 1.0), 0.01));
        pb.on_fill(&mut m, &fill("c", 300, Side::Sell, 101.0, 1.5));
        pb.begin(&mut m, 3000);
        pb.m0.insert("X", 97.0);
        let p = &pb.pos["X"];
        approx!(p.q0, 2.5);
        let (r, o, f) = pb.fifo(&mut m, p);
        approx!(r, 1.0 * (101.0 - 99.0) - 0.01);
        approx!(o, 0.5 * (98.0 - 97.0) + 0.5 * (101.0 - 97.0));
        approx!(f, 1.5 * (100.0 - 97.0));
        approx!(r + o + f, pb.pi_k(&mut m, &pb.pos["X"]));
        // a balance below today's net buys (a sale not seen): the opening comes out negative, the split
        // still sums to Π
        let mut pb = book(0.5);
        pb.load_fills(&mut m, &[fill("a", 100, Side::Buy, 99.0, 1.0)]);
        pb.on_fill(&mut m, &fill("b", 200, Side::Sell, 101.0, 0.2));
        pb.begin(&mut m, 3000);
        pb.m0.insert("X", 97.0);
        approx!(pb.pos["X"].q0, -0.3);
        let (r, o, f) = pb.fifo(&mut m, &pb.pos["X"]);
        approx!(r + o + f, pb.pi_k(&mut m, &pb.pos["X"]));
    }

    #[test]
    fn fill_swept_after_a_restart_corrects_the_opening_not_q() {
        // a buy of 0.5 at 99 while the monitor was down is in the balance (1.5) but was never seen: the
        // opening came out 1.5 instead of 1. Swept in later, Π returns to the truth and Q stays 1.5.
        let mut m = market();
        tick(&mut m, 200, 100.0, 50.0, 200.0);
        let mut pb = book(1.5);
        pb.begin(&mut m, 4000);
        pb.m0.insert("X", 97.0);
        approx!(pb.pi_k(&mut m, &pb.pos["X"]), 1.5 * 3.0);
        pb.on_fill_at(&mut m, &fill("late", 500, Side::Buy, 99.0, 0.5), false);
        let p = &pb.pos["X"];
        approx!(p.q0, 1.0);
        approx!(p.q, 1.5);
        assert!(pb.pending.is_empty());
        approx!(pb.pi_k(&mut m, &pb.pos["X"]), 1.0 * 3.0 + 0.5 * (100.0 - 99.0));
        let (r, o, f) = pb.fifo(&mut m, &pb.pos["X"]);
        approx!(r + o + f, 3.5);
    }

    #[test]
    fn small_grid_pi_h_s_hm_a() {
        // Start inventory 2 (balance 3 minus today's fills: an earlier sell of 0.5, the buy of 1 below);
        // the buy at 2.3 s enters at grid point 3, so second 3's revaluation still uses Q = 2.
        let mut m = market();
        tick(&mut m, 500, 100.0, 50.0, 200.0);
        tick(&mut m, 1500, 101.0, 51.0, 202.0);
        tick(&mut m, 2500, 102.0, 51.0, 202.0);
        tick(&mut m, 3500, 100.0, 50.0, 200.0);
        let mut pb = book(3.0);
        pb.load_fills(&mut m, &[fill("old", 100, Side::Sell, 98.0, 0.5)]);
        pb.on_fill(&mut m, &fee(fill("f", 2300, Side::Buy, 99.0, 1.0), 0.01));
        pb.begin(&mut m, 3000);   // first booked second is 2
        assert_eq!(ab(&pb), [(0, 1)]);
        pb.gaps.clear();          // its backfill is not under test here
        approx!(pb.pos["X"].q, 2.0);
        pb.step(&mut m, 6000);    // books seconds 2, 3, 4
        let hm4 = 0.5 * 3.0 * 102.0 * (200.0 / 202.0 - 1.0);
        approx!(blocks_sum(&pb, |b| b.trading), 0.99);   // the grid: from second 1 on
        let s = pb.summary(&mut m);
        approx!(s.ref_hedge, -2.0);
        approx!(s.factor_hedge, 1.0 + hm4);
        assert_eq!((s.covered_s, s.backfilled_s), (3, 0));
        approx!(pb.pos["X"].q, 3.0);
        let pi = 2.5 * (100.0 - 100.0) - 0.5 * (100.0 - 98.0) + 1.0 * (100.0 - 99.0) - 0.01;
        approx!(s.trading, pi);
        approx!(s.hedged, pi + 2.0);
        approx!(s.factor, pi - 1.0 - hm4);
        let bb = pb.by_base(&mut m)["X"];
        approx!(bb.0, pi);
        approx!(bb.1, pi + 2.0);
        pb.m0.insert("X", 97.0);   // once M(D) is known
        approx!(pb.summary(&mut m).trading, pi + 2.5 * 3.0);
        let hours = pb.hour_rows();
        assert_eq!(hours.len(), 1);
        assert_eq!(hours[0].fills, 1);
        approx!(hours[0].volume, 99.0);
    }

    #[test]
    fn late_fill_enters_next_unbooked_second() {
        let mut m = market();
        tick(&mut m, 500, 100.0, 50.0, 200.0);
        let mut pb = book(0.0);
        pb.begin(&mut m, 5000);   // booked through second 3
        pb.on_fill(&mut m, &fill("f", 2500, Side::Buy, 99.0, 1.0));
        assert_eq!(pb.pending[0].0, 4);
    }

    #[test]
    fn nw_se_matches_metric_review() {
        // Newey-West standard error, lag 3, reference values
        approx!(nw_se(&[1.5, -2.0, 0.25, 3.0, -1.0, 0.5, 2.25, -0.75], 3).unwrap(), 2.3038266400708194);
        approx!(nw_se(&[4.0, -1.0], 3).unwrap(), 1.7677669529663689);
        approx!(nw_se(&[1.0, 2.0, 3.0], 3).unwrap(), 1.0);
        assert_eq!(nw_se(&[5.0], 3), None);
    }

    #[test]
    fn hourly_blocks_round_trip() {
        let mut m = market();
        let mut pb = book(0.0);
        let h = 3_600_000;
        pb.hours = BTreeMap::from([(0, Block::new(1.0, 0.5, 0.25, 3, 300.0, 3600, 0)),
                                   (h, Block::new(-2.0, 1.0, -0.5, 1, 50.0, 1800, 600)),
                                   (25 * h, Block::new(4.0, 1.0, 1.0, 2, 80.0, 60, 0))]);
        pb.dirty = pb.hours.keys().copied().collect();
        let (rows, _) = pb.flush();
        // stand-in for the store round trip (Store.load(26 h, hours_back=48) returns all three rows)
        let mut pb2 = book(0.0);
        pb2.load_hours(&rows);
        assert_eq!(pb2.hours, pb.hours);
        let days = pb2.day_rows(&mut m);
        assert_eq!(days.iter().map(|d| d.day.as_str()).collect::<Vec<_>>(), ["1970-01-01", "1970-01-02"]);
        let d0 = &days[0];
        assert_eq!((d0.trading, d0.hedged, d0.factor, d0.fills, d0.volume, d0.covered_s, d0.backfilled_s),
                   (-1.0, -2.5, -0.75, 4, 350.0, 5400, 600));
        approx!(d0.trading_se.unwrap(), nw_se(&[1.0, -2.0], 3).unwrap());
        assert_eq!(days[1].trading_se, None);
    }

    #[test]
    fn markout_net_from_tau_and_toxicity_sign() {
        // Buy at 10 s; the reference drops 10 bps within 200 ms, then another ~10 bps by 1 s.
        let mut info = Info::new();
        info.insert(Venue::Spot, HashMap::new());
        info.insert(Venue::Usdm, HashMap::new());
        let mut m = Market::new(info, 120.0, 100.0);
        m.ensure("XUSDT", Venue::Spot, Some(("XUSDT", Venue::Usdm)));
        for (t, r) in [(4_000, 50.0), (10_100, 49.95), (10_900, 49.90), (11_500, 49.95)] {
            m.on_book(Venue::Usdm, &BookTicker::new("XUSDT", r, r, Some(t)));
        }
        for t in [9_000, 11_000, 20_000] {
            m.on_book(Venue::Spot, &BookTicker::new("XUSDT", 100.0, 100.0, Some(t)));
        }
        let mut fb = FillBook::new();
        fb.add(&mut m, fill("a", 10_000, Side::Buy, 100.0, 1.0), true);
        fb.mature(&m, 21_000);
        let f = fb.get("a").unwrap();
        approx!(f.mk_raw.0[1].unwrap(), 0.0);
        approx!(f.mk.0[1].unwrap(), -(49.95 / 49.90 - 1.0) * 1e4);   // net from R(t + 1 s)
        approx!(f.mk_fast.0[1].unwrap(), 0.0);                        // net from R(t + 0.2 s)
        approx!(f.tox[0].unwrap(), 0.0);
        approx!(f.tox[1].unwrap(), 10.0);                             // moved against the buy: positive
        approx!(f.tox[2].unwrap(), 20.0);
        fb.add(&mut m, fill("b", 10_000, Side::Sell, 100.0, 1.0), true);
        fb.mature(&m, 21_000);
        approx!(fb.get("b").unwrap().tox[1].unwrap(), -10.0);
    }

    #[test]
    fn fine_ring_bounded_and_keeps_edge() {
        let mut r = FineRing::default();
        for i in 0..200_000i64 {
            r.put(i * 10, 100.0 + (i % 7) as f64);
        }
        assert!((r.len() as i64) < 2 * FineRing::KEEP_MS / 10 + 4096);
        let last = 199_999 * 10;
        assert_eq!(r.at(last), Some(100.0 + (199_999 % 7) as f64));
        assert!(r.at(last - FineRing::KEEP_MS).is_some());
        r.put(5, 1.0);   // out of order: clamped to the last time
        assert_eq!(r.at(last), Some(1.0));
    }

    /// 1 min bars opening at 0, 60 s, ...; each closes at the next one's open.
    fn bars(vals: &[f64]) -> Bars {
        Bars::new(vals.iter().enumerate().map(|(i, &v)| (i as i64 * 60_000, v, vals[(i + 1).min(vals.len() - 1)])))
    }

    fn flat(v: f64, n: i64) -> Bars {
        Bars::new((0..n).map(|i| (i * 60_000, v, v)))
    }

    #[test]
    fn backfill_from_day_start_matches_closed_form() {
        // Monitor starts 300 s into the day holding 3 X, 1 of it bought at 99 at 125 s: the gap (0, 300] is
        // booked on a 1 min grid from klines, the fill entering at 180 s, and the grid's Pi then equals the
        // closed form; H and Hm follow the same steps.
        let mut m = market();
        tick(&mut m, 299_500, 105.0, 52.5, 210.0);
        let mut pb = book(3.0);
        pb.load_fills(&mut m, &[fee(fill("f", 125_000, Side::Buy, 99.0, 1.0), 0.02)]);
        pb.begin(&mut m, 302_000);
        assert_eq!(ab(&pb), [(0, 300)]);
        let g = pb.gaps[0].clone();
        let plan = pb.plan(&m, &g);
        assert_eq!(plan.names, ["X"]);
        let mut keys: Vec<&str> = plan.fetch.iter().map(|f| f.0.as_str()).collect();
        keys.sort();
        assert_eq!(keys, ["spot:XUSDT", "usdm:BUSDT", "usdm:XUSDT"]);
        let (tok, rf, beta) = ([100.0, 101.0, 102.0, 103.0, 104.0], [50.0, 50.5, 51.0, 51.5, 52.0],
                               [200.0, 201.0, 199.0, 202.0, 204.0]);
        let bs = HashMap::from([("spot:XUSDT".to_string(), bars(&tok)), ("usdm:XUSDT".to_string(), bars(&rf)),
                                ("usdm:BUSDT".to_string(), bars(&beta))]);
        pb.book_gap(&mut m, &g, &plan, &bs);
        pb.gaps.remove(0);
        assert_eq!(pb.m0["X"], 100.0);
        // expected steps: points 0, 60, ..., 240, then 300 at the live grid's own marks (105, 52.5, 210)
        let mm: Vec<f64> = tok.iter().copied().chain([105.0]).collect();
        let rr: Vec<f64> = rf.iter().copied().chain([52.5]).collect();
        let bb: Vec<f64> = beta.iter().copied().chain([210.0]).collect();
        let (mut q, mut pi, mut h, mut hm) = (2.0, 0.0, 0.0, 0.0);
        for j in 1..6 {
            pi += q * (mm[j] - mm[j - 1]);
            h += q * mm[j - 1] * (rr[j] / rr[j - 1] - 1.0);
            hm += 0.5 * q * mm[j - 1] * (bb[j] / bb[j - 1] - 1.0);
            if j == 3 {   // the fill at 125 s enters at 180 s
                pi += 1.0 * (mm[j] - 99.0) - 0.02;
                q += 1.0;
            }
        }
        approx!(blocks_sum(&pb, |b| b.trading), pi);
        approx!(blocks_sum(&pb, |b| b.ref_hedge), h);
        approx!(blocks_sum(&pb, |b| b.factor_hedge), hm);
        let s = pb.summary(&mut m);
        approx!(s.trading, 2.0 * (105.0 - 100.0) + (105.0 - 99.0) - 0.02);
        approx!(s.trading, pi);
        approx!(s.hedged, pi - h);
        approx!(s.factor, pi - hm);
        assert_eq!((s.covered_s, s.backfilled_s), (0, 300));
        assert_eq!(pb.hour_rows()[0].fills, 1);
        approx!(pb.pos["X"].h, h);
        assert!(pb.holes(300).is_empty());
    }

    #[test]
    fn restart_gap_joins_previous_run_and_stall_is_backfilled() {
        // A run books 0..100 s live, saves its state and stops; the next starts at 400 s. The gap (100, 400]
        // starts from the saved marks, so the day's grid Pi still equals the closed form. A stall inside the
        // second run (with a fill in it) is backfilled too, and the fill counted once.
        let mut m = market();
        tick(&mut m, 0, 100.0, 50.0, 200.0);
        let mut pb = book(2.0);
        pb.m0.insert("X", 100.0);
        pb.begin(&mut m, 2_000);   // booked from second 0
        for t in (1000..101_000).step_by(1000) {
            tick(&mut m, t, 100.0 + t as f64 / 100_000.0, 50.0, 200.0);
        }
        pb.step(&mut m, 102_000);   // ... through second 100
        let (rows, state) = pb.flush();
        assert_eq!(state.t, Some(100));
        assert_eq!(state.spans, [[0, 100, 0]]);
        let m_end = pb.pos["X"].m;

        for t in (101_000..400_000).step_by(1000) {
            tick(&mut m, t, 103.0 + t as f64 / 1e6, 51.0, 199.0);
        }
        let mut pb2 = book(2.0);
        pb2.load_hours(&rows);   // stand-in for Store.load(0, hours_back=1)
        pb2.load_state(Some(state_rt(&state)), None);
        pb2.begin(&mut m, 402_000);
        let g = pb2.gaps[0].clone();
        assert_eq!((g.a, g.b), (100, 400));
        assert_eq!(g.start.as_ref().unwrap()["X"].0, m_end);
        let plan = pb2.plan(&m, &g);
        let bs = HashMap::from([("spot:XUSDT".to_string(), flat(103.2, 8)), ("usdm:XUSDT".to_string(), flat(51.0, 8)),
                                ("usdm:BUSDT".to_string(), flat(199.0, 8))]);
        pb2.book_gap(&mut m, &g, &plan, &bs);
        pb2.gaps.remove(0);
        approx!(blocks_sum(&pb2, |b| b.trading), pb2.summary(&mut m).trading);

        // a stall: nothing booked from 400 to 1100 s; a sell of 0.5 at 104 at 700 s arrives meanwhile
        pb2.on_fill(&mut m, &fill("s", 700_000, Side::Sell, 104.0, 0.5));
        for t in (1_090_000..1_101_000).step_by(1000) {
            tick(&mut m, t, 104.5, 51.0, 199.0);
        }
        pb2.step(&mut m, 1_102_000);
        let g = pb2.gaps[0].clone();
        assert_eq!((g.a, g.b), (400, 1099));
        approx!(pb2.pos["X"].q, 1.5);
        let plan = pb2.plan(&m, &g);
        assert_eq!(plan.names, ["X"]);
        let bs = HashMap::from([
            ("spot:XUSDT".to_string(), Bars::new((360_000..1_100_000).step_by(60_000).map(|t| (t, 104.0, 104.0)))),
            ("usdm:XUSDT".to_string(), flat(51.0, 8)),
            ("usdm:BUSDT".to_string(), flat(199.0, 8)),
        ]);
        pb2.book_gap(&mut m, &g, &plan, &bs);
        pb2.gaps.remove(0);
        let s = pb2.summary(&mut m);
        approx!(blocks_sum(&pb2, |b| b.trading), s.trading);
        approx!(s.trading, 2.0 * (104.5 - 100.0) - 0.5 * (104.5 - 104.0));
        assert_eq!(pb2.today().iter().map(|(_, b)| b.fills).sum::<i64>(), 1);
        assert_eq!(s.covered_s + s.backfilled_s, 1100);
    }

    #[test]
    fn short_restart_gap_does_not_swing_s_before_the_backfill() {
        // A 30 s restart while the reference rises 2 %: before the backfill S must not take the price move
        // without its hedge, nor change when the gap is booked.
        let mut m = market();
        tick(&mut m, 0, 100.0, 50.0, 200.0);
        let mut pb = book(2.0);
        pb.m0.insert("X", 100.0);
        pb.begin(&mut m, 2_000);
        for t in (1000..101_000).step_by(1000) {
            tick(&mut m, t, 100.0, 50.0, 200.0);
        }
        pb.step(&mut m, 102_000);
        let (_, state) = pb.flush();
        for t in (101_000..131_000).step_by(1000) {
            tick(&mut m, t, 102.0, 51.0, 200.0);   // instrument and reference both up 2 % during the restart
        }
        let mut pb2 = book(2.0);
        let rows: Vec<HourRow> = pb.hours.iter().map(|(&t, b)| HourRow {
            t, trading: b.trading, hedged: b.hedged(), factor: b.factor(), ref_hedge: b.ref_hedge,
            factor_hedge: b.factor_hedge, fills: b.fills, volume: b.volume, covered_s: b.covered_s,
            backfilled_s: b.backfilled_s,
        }).collect();
        pb2.load_hours(&rows);
        pb2.load_state(Some(state_rt(&state)), None);
        pb2.begin(&mut m, 132_000);
        assert_eq!(ab(&pb2), [(100, 130)]);
        pb2.step(&mut m, 133_000);
        let s = pb2.summary(&mut m);
        let h_gap = 2.0 * 100.0 * (51.0 / 50.0 - 1.0);
        approx!(s.trading, 4.0);            // closed form: 2 x (102 - 100)
        approx!(s.hedged, 4.0 - h_gap);     // the gap's hedge from its end marks, before the backfill
        let g = pb2.gaps[0].clone();
        let plan = pb2.plan(&m, &g);
        let bs = HashMap::from([("spot:XUSDT".to_string(), flat(102.0, 4)), ("usdm:XUSDT".to_string(), flat(51.0, 4)),
                                ("usdm:BUSDT".to_string(), flat(200.0, 4))]);
        pb2.book_gap(&mut m, &g, &plan, &bs);
        pb2.gaps.remove(0);
        approx!(pb2.summary(&mut m).hedged, 4.0 - h_gap);   // unchanged by the backfill
    }

    #[test]
    fn s_and_a_use_the_booked_span_when_coverage_is_partial() {
        // one booked hour: grid Π 2, H 1.5, Hm 1; the closed-form Π (10) also covers unbooked time
        let b = Block::new(2.0, 1.5, 1.0, 3, 100.0, 3600, 0);
        let whole = PnlBook::whole(&[&b], 3600.0);
        let partial = PnlBook::whole(&[&b], 7200.0);
        assert!(whole && !partial);
        assert_eq!(PnlBook::s_a(&[&b], 10.0, whole), (8.5, 9.0));     // Π − H, Π − Hm over the whole span
        assert_eq!(PnlBook::s_a(&[&b], 10.0, partial), (0.5, 1.0));   // booked seconds only
    }

    #[test]
    fn live_spans_are_clipped_to_when_the_monitor_ran() {
        let alive = alive_spans(&[100_000, 105_000, 110_000, 400_000, 405_000], ALIVE_STEP_MS, ALIVE_GAP_MS);
        assert_eq!(alive, [(95, 115), (395, 410)]);
        let mut pb = book(0.0);
        pb.spans = vec![[0, 3600, 0], [500, 600, 1]];
        pb.clip_live(&alive);
        assert_eq!(pb.spans, [[95, 115, 0], [395, 410, 0], [500, 600, 1]]);
    }

    #[test]
    fn bars_at_and_state_json() {
        let b = Bars::new([(60_000, 2.0, 3.0), (0, 1.0, 2.0)]);
        assert_eq!((b.at(-60_000), b.at(-60_001), b.at(0), b.at(29_999), b.at(30_000), b.at(500_000)),
                   (Some(1.0), None, Some(1.0), Some(1.0), Some(2.0), Some(3.0)));
        // the stored state's JSON shape, key order kept
        let st: PnlState = serde_json::from_str(
            r#"{"t": 100, "rb": 200.0, "spans": [[0, 100, 0]], "m0": {"X": 100.0}, "k": {"Y": [0.5, 1.0, null], "X": [1.5, 2.0, 3.0]}}"#).unwrap();
        assert_eq!(st.k.keys().collect::<Vec<_>>(), ["Y", "X"]);
        assert_eq!(serde_json::to_string(&st).unwrap(),
                   r#"{"t":100,"rb":200.0,"spans":[[0,100,0]],"m0":{"X":100.0},"k":{"Y":[0.5,1.0,null],"X":[1.5,2.0,3.0]}}"#);
    }
}
