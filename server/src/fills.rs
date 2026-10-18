//! Fills: edge at fill, markouts and toxicity as their horizons mature.
use std::collections::{HashMap, HashSet};

use crate::market::{Market, key};
use crate::protocol::{self as P, Marks, Side, Venue};

pub const HORIZONS: [i64; 4] = [1, 10, 60, 300];
pub const HK: [&str; 4] = ["1", "10", "60", "300"];
pub const TAU_S: f64 = 1.0;               // hedge delay the net markouts assume
pub const TAU_FAST_S: f64 = 0.2;
pub const TOX_HORIZONS: [f64; 5] = [0.0, 0.2, 1.0, 60.0, 300.0];   // toxicity curve D(h), seconds after the fill
pub const TK: [&str; 5] = ["0", "0.2", "1", "60", "300"];
pub const TOX_BEFORE_S: f64 = 5.0;

/// Reference anchors kept per fill (Python `refs` keys "-5", "0", "0.2", "1"), offsets in ms.
pub const REF_ANCHORS: [(&str, i64); 4] = [("-5", -5_000), ("0", 0), ("0.2", 200), ("1", 1_000)];
const TOX_MS: [i64; 5] = [0, 200, 1_000, 60_000, 300_000];

/// The price path around a fill: dense horizons from 10 s before it to 300 s after, seconds.
pub const PATH_S: [f64; 17] = [-10.0, -5.0, -2.0, -1.0, -0.5, 0.0, 0.2, 0.5, 1.0, 2.0, 5.0, 10.0, 20.0, 30.0, 60.0, 120.0, 300.0];
pub const PATH_N: usize = PATH_S.len();
pub const PATH_MS: [i64; PATH_N] =
    [-10_000, -5_000, -2_000, -1_000, -500, 0, 200, 500, 1_000, 2_000, 5_000, 10_000, 20_000, 30_000, 60_000, 120_000, 300_000];
/// PATH index of each of HORIZONS (1, 10, 60, 300 s).
pub const PATH_OF_H: [usize; 4] = [8, 11, 14, 16];
/// A horizon's mark not taken live this long after t + h never will be (the desk was down, the ring has a
/// hole): it is due for the kline backfill, and until then the fill has no price at h.
pub const MARK_GRACE_MS: i64 = 30_000;
/// `FillRec::bf`: bit j, mark j came from klines; bit BF_NONE + j, klines have no price at t + h_j.
pub const BF_NONE: usize = 4;

pub fn sign(side: Side) -> f64 {
    if side == Side::Buy { 1.0 } else { -1.0 }
}

pub fn edge_bps(side: Side, fair: f64, price: f64) -> f64 {
    sign(side) * (fair - price) / fair * 1e4
}

/// (raw, net of reference) markout in bps. raw = s (m(t+h) / p - 1); net subtracts the reference move
/// from t+tau to t+h, s (R(t+h) / R(t+tau) - 1), so a reference jump right after the fill (before any
/// hedge could trade) is not counted as edge.
pub fn markout_bps(side: Side, price: f64, mid_h: f64, ref_tau: Option<f64>, ref_h: Option<f64>) -> (f64, Option<f64>) {
    let s = sign(side);
    let raw = s * (mid_h / price - 1.0) * 1e4;
    match (ref_tau.filter(|x| *x != 0.0), ref_h.filter(|x| *x != 0.0)) {
        (Some(rt), Some(rh)) => (raw, Some(raw - s * (rh / rt - 1.0) * 1e4)),
        _ => (raw, None),
    }
}

/// Reference move against the fill since 5 s before it: D(h) = -s (R(t+h) / R(t-5 s) - 1), bps.
pub fn toxicity_bps(side: Side, ref_before: f64, ref_h: f64) -> f64 {
    -sign(side) * (ref_h / ref_before - 1.0) * 1e4
}

#[derive(Debug, Clone, PartialEq)]
pub struct FillRec {
    pub id: String,
    pub ts: i64,
    pub account: String,
    pub symbol: String,
    pub venue: Venue,
    pub side: Side,
    pub price: f64,
    pub qty: f64,
    pub fee: f64,
    pub fee_asset: String,
    pub maker: bool,
    pub fair: Option<f64>,
    pub edge_bps: Option<f64>,
    pub ref0: Option<f64>,          // reference mid at the fill instant
    pub has_ref: bool,
    pub mk: Marks,                  // net, tau = 1 s (raw without a reference); indexed like HK
    pub mk_raw: Marks,
    pub mk_fast: Marks,             // net, tau = 0.2 s
    pub tox: [Option<f64>; 5],      // D(h), bps; indexed like TK
    pub refs: [Option<f64>; 4],     // reference anchors, indexed like REF_ANCHORS
    /// The instrument's mid and the reference's at each PATH_S horizon (at 1, 10, 60 and 300 s the 1 s ring's
    /// mid, as the markouts take it; the ms ring's elsewhere).
    pub pm: [Option<f64>; PATH_N],
    pub pr: [Option<f64>; PATH_N],
    /// Marks backfilled from klines (bit j) and horizons klines could not price (bit BF_NONE + j).
    pub bf: u8,
}

/// A fill's price at a horizon, as market making values it.
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum MarkAt {
    /// the raw markout, bps (taken live or backfilled)
    Bps(f64),
    /// younger than h (plus the grace): valued at the mid now
    Young,
    /// h has passed and no price at t + h is known (yet): left out until the backfill brings one
    Unmarked,
}

impl FillRec {
    #[allow(clippy::too_many_arguments)]
    pub fn new(id: impl Into<String>, ts: i64, account: impl Into<String>, symbol: impl Into<String>, venue: Venue,
               side: Side, price: f64, qty: f64) -> Self {
        FillRec {
            id: id.into(),
            ts,
            account: account.into(),
            symbol: symbol.into(),
            venue,
            side,
            price,
            qty,
            fee: 0.0,
            fee_asset: String::new(),
            maker: true,
            fair: None,
            edge_bps: None,
            ref0: None,
            has_ref: false,
            mk: Marks::default(),
            mk_raw: Marks::default(),
            mk_fast: Marks::default(),
            tox: [None; 5],
            refs: [None; 4],
            pm: [None; PATH_N],
            pr: [None; PATH_N],
            bf: 0,
        }
    }

    pub fn key(&self) -> String {
        key(&self.symbol, self.venue)
    }

    pub fn notional(&self) -> f64 {
        self.price * self.qty
    }

    /// A trade between two stablecoins (`market::is_conversion`): on the tape, marked, and out of every fill
    /// statistic (aggregates, markouts, market making, Π, the instrument lists, the alerts).
    pub fn conversion(&self) -> bool {
        crate::market::is_conversion(&self.symbol)
    }

    /// Markout P&L at horizon h ("1", "10", "60", "300"), USDT.
    pub fn pnl(&self, h: &str) -> f64 {
        let i = HK.iter().position(|k| *k == h).expect("horizon");
        self.mk.0[i].map_or(0.0, |m| m * self.notional() / 1e4)
    }

    /// (raw, net τ = 1 s, net τ = 0.2 s, toxicity D) in bps at PATH_S[j], from the stored path. The definitions
    /// are the markouts' and D(h)'s, so at 1, 10, 60 and 300 s they equal `mk_raw`, `mk` and `mk_fast`.
    pub fn path_at(&self, j: usize) -> Option<(f64, f64, f64, Option<f64>)> {
        let mid = self.pm[j].filter(|x| *x != 0.0)?;
        let rh = self.pr[j];
        let (raw, net) = markout_bps(self.side, self.price, mid, self.refs[3], rh);
        let (_, fast) = markout_bps(self.side, self.price, mid, self.refs[2], rh);
        let tox = match (self.refs[0].filter(|x| *x != 0.0), rh.filter(|x| *x != 0.0)) {
            (Some(r5), Some(rh)) => Some(toxicity_bps(self.side, r5, rh)),
            _ => None,
        };
        Some((raw, net.unwrap_or(raw), fast.unwrap_or(raw), tox))
    }

    /// Horizon j's raw mark, or whether the fill is too young for it or has none.
    pub fn mark_at(&self, j: usize, now: i64) -> MarkAt {
        match self.mk_raw.0[j] {
            Some(b) => MarkAt::Bps(b),
            None if now < self.ts + HORIZONS[j] * 1000 + MARK_GRACE_MS => MarkAt::Young,
            None => MarkAt::Unmarked,
        }
    }

    /// Klines were asked for horizon j's price and had none.
    pub fn unpriceable(&self, j: usize) -> bool {
        self.bf & (1 << (BF_NONE + j)) != 0
    }

    /// The net marks wait for the reference at t + h: the fill had a reference, and its anchor 1 s after.
    fn wants_ref(&self) -> bool {
        self.has_ref && self.refs[3].is_some_and(|x| x != 0.0)
    }

    pub fn matured(&self) -> bool {
        self.mk_raw.0[3].is_some() && (!self.has_ref || self.tox[4].is_some())
    }

    pub fn proto(&self) -> P::Fill {
        P::Fill {
            id: self.id.clone(),
            ts: self.ts,
            account: self.account.clone(),
            symbol: self.symbol.clone(),
            venue: self.venue,
            side: self.side,
            price: self.price,
            qty: self.qty,
            notional: self.notional(),
            fee: self.fee,
            fee_asset: self.fee_asset.clone(),
            maker: self.maker,
            fair: self.fair,
            edge_bps: self.edge_bps,
            mk: self.mk,
            mk_raw: self.mk_raw,
            mk_fast: self.mk_fast,
            conversion: self.conversion(),
        }
    }
}

/// A fill's horizons (indices into HORIZONS) due for the kline backfill: the instrument's price at t + h, or
/// (`MarkNeed::reference`) the reference's for the net marks.
#[derive(Debug, Clone, PartialEq)]
pub struct MarkNeed {
    pub id: String,
    pub key: String,
    pub ts: i64,
    pub js: Vec<usize>,
}

/// TOX_HORIZONS index of each of HORIZONS, where D(h) is kept at that horizon.
const TOX_OF_H: [Option<usize>; 4] = [Some(2), None, Some(3), Some(4)];

/// Today's fills, oldest first, with markouts filled in as their horizons pass. Takes the market
/// per call (it lives in its own `RefCell`).
#[derive(Debug, Default)]
pub struct FillBook {
    pub fills: Vec<FillRec>,
    by_id: HashMap<String, usize>,
    pending: Vec<String>,
    dirty: Vec<String>,
    dirty_set: HashSet<String>,
}

impl FillBook {
    pub fn new() -> Self {
        FillBook::default()
    }

    pub fn get(&self, id: &str) -> Option<&FillRec> {
        self.by_id.get(id).map(|&i| &self.fills[i])
    }

    pub fn contains(&self, id: &str) -> bool {
        self.by_id.contains_key(id)
    }

    fn reindex(&mut self) {
        self.by_id = self.fills.iter().enumerate().map(|(i, f)| (f.id.clone(), i)).collect();
    }

    fn mark_dirty(&mut self, id: &str) {
        if self.dirty_set.insert(id.to_string()) {
            self.dirty.push(id.to_string());
        }
    }

    pub fn add(&mut self, market: &mut Market, mut f: FillRec, fresh: bool) -> bool {
        if self.by_id.contains_key(&f.id) {
            return false;
        }
        let inst = market.ensure(&f.symbol, f.venue, None);
        market.keep_fine(inst);   // the path around its next fills, at ms resolution
        if fresh {
            f.fair = market.fair(inst);
            f.edge_bps = f.fair.filter(|x| *x != 0.0).map(|fair| edge_bps(f.side, fair, f.price));
            if market.insts[inst].ref_.is_some() {
                f.has_ref = true;
            }
        }
        let id = f.id.clone();
        let matured = f.matured();
        self.fills.push(f);
        let n = self.fills.len();
        if n > 1 && self.fills[n - 1].ts < self.fills[n - 2].ts {
            self.fills.sort_by_key(|x| x.ts);
            self.reindex();
        } else {
            self.by_id.insert(id.clone(), n - 1);
        }
        if !matured {
            self.pending.push(id.clone());
        }
        self.mark_dirty(&id);
        true
    }

    /// Fill in markouts and toxicity whose horizon has passed (now in exchange-synced ms); every
    /// horizon waits one more second so the ticks up to it have arrived.
    pub fn mature(&mut self, m: &Market, now: i64) {
        let pending = std::mem::take(&mut self.pending);
        let mut keep = Vec::with_capacity(pending.len());
        for id in pending {
            let Some(&i) = self.by_id.get(&id) else { continue };
            let f = &mut self.fills[i];
            let inst = m.find(&f.symbol, f.venue);
            let mut changed = false;
            if let Some(inst) = inst
                && f.has_ref
            {
                for (j, (_, dt)) in REF_ANCHORS.iter().enumerate() {
                    if f.refs[j].is_none() && now >= f.ts + dt + 1000 {
                        f.refs[j] = m.ref_at(inst, f.ts + dt);
                    }
                }
                if f.ref0.is_none() && f.refs[1].is_some() {
                    f.ref0 = f.refs[1];
                }
                let r5 = f.refs[0];
                for (j, h) in TOX_MS.iter().enumerate() {
                    if f.tox[j].is_some() || now < f.ts + h + 1000 {
                        continue;
                    }
                    let rh = m.ref_at(inst, f.ts + h);
                    if let (Some(r5), Some(rh)) = (r5.filter(|x| *x != 0.0), rh.filter(|x| *x != 0.0)) {
                        f.tox[j] = Some(toxicity_bps(f.side, r5, rh));
                        changed = true;
                    }
                }
            }
            if let Some(inst) = inst {
                let i = &m.insts[inst];
                for (j, dt) in PATH_MS.iter().enumerate() {
                    let t = f.ts + dt;
                    if f.pm[j].is_some() || now < t + 1000 {
                        continue;
                    }
                    f.pm[j] = if PATH_OF_H.contains(&j) {
                        i.ring.at(t)
                    } else {
                        i.fine.as_ref().and_then(|r| r.at(t)).or_else(|| i.ring.at(t))
                    };
                    if f.has_ref {
                        f.pr[j] = m.ref_at(inst, t);
                    }
                }
            }
            for (j, h) in HORIZONS.iter().enumerate() {
                if f.mk_raw.0[j].is_some() {
                    continue;
                }
                let t = f.ts + h * 1000;
                if now < t + 1000 {
                    break;
                }
                let Some(mid) = inst.and_then(|i| m.insts[i].ring.at(t)) else { continue };
                let ref_h = inst.filter(|_| f.has_ref).and_then(|i| m.ref_at(i, t));
                let (raw, net) = markout_bps(f.side, f.price, mid, f.refs[3], ref_h);
                let (_, fast) = markout_bps(f.side, f.price, mid, f.refs[2], ref_h);
                f.mk_raw.0[j] = Some(raw);
                f.mk.0[j] = Some(net.unwrap_or(raw));
                f.mk_fast.0[j] = Some(fast.unwrap_or(raw));
                changed = true;
            }
            let alive = !f.matured() && now < f.ts + 600_000;
            if changed {
                self.mark_dirty(&id);
            }
            if alive {
                keep.push(id);
            }
        }
        self.pending = keep;
    }

    /// Fills whose marks are due and missing (`MarkAt::Unmarked`), but for the horizons klines had no price at.
    pub fn mark_needs(&self, now: i64) -> Vec<MarkNeed> {
        self.fills
            .iter()
            .filter_map(|f| {
                let js: Vec<usize> =
                    (0..HORIZONS.len()).filter(|&j| f.mark_at(j, now) == MarkAt::Unmarked && !f.unpriceable(j)).collect();
                (!js.is_empty()).then(|| MarkNeed { id: f.id.clone(), key: f.key(), ts: f.ts, js })
            })
            .collect()
    }

    /// Backfilled raw marks whose net marks wait for the reference: `key` is the reference's instrument.
    pub fn ref_needs(&self, m: &Market) -> Vec<MarkNeed> {
        self.fills
            .iter()
            .filter(|f| f.wants_ref())
            .filter_map(|f| {
                let js: Vec<usize> = (0..HORIZONS.len()).filter(|&j| f.mk_raw.0[j].is_some() && f.mk.0[j].is_none()).collect();
                if js.is_empty() {
                    return None;
                }
                let key = m.find(&f.symbol, f.venue).and_then(|i| m.insts[i].ref_).map_or_else(String::new, |r| m.insts[r].key.clone());
                Some(MarkNeed { id: f.id.clone(), key, ts: f.ts, js })
            })
            .collect()
    }

    /// Book the instrument's price at t + h_j from klines (None: they have none there, and are not asked again).
    /// The net marks follow at once without a reference, else from `backfill_net`.
    pub fn backfill_raw(&mut self, id: &str, j: usize, mid: Option<f64>) {
        let Some(&i) = self.by_id.get(id) else { return };
        let f = &mut self.fills[i];
        if f.mk_raw.0[j].is_some() {
            return;
        }
        match mid.filter(|x| *x > 0.0) {
            None => f.bf |= 1 << (BF_NONE + j),
            Some(mid) => {
                let (raw, _) = markout_bps(f.side, f.price, mid, None, None);
                f.mk_raw.0[j] = Some(raw);
                f.bf |= 1 << j;
                if !f.wants_ref() {
                    f.mk.0[j] = Some(raw);
                    f.mk_fast.0[j] = Some(raw);
                }
            }
        }
        self.mark_dirty(id);
    }

    /// Book the reference at t + h_j for a backfilled raw mark: the net marks (raw without it, as live) and
    /// D(h) where it is kept.
    pub fn backfill_net(&mut self, id: &str, j: usize, ref_h: Option<f64>) {
        let Some(&i) = self.by_id.get(id) else { return };
        let f = &mut self.fills[i];
        let Some(raw) = f.mk_raw.0[j] else { return };
        if f.mk.0[j].is_some() {
            return;
        }
        let s = sign(f.side);
        let rh = ref_h.filter(|x| *x != 0.0);
        let net = |rt: Option<f64>| match (rt.filter(|x| *x != 0.0), rh) {
            (Some(rt), Some(rh)) => raw - s * (rh / rt - 1.0) * 1e4,
            _ => raw,
        };
        f.mk.0[j] = Some(net(f.refs[3]));
        f.mk_fast.0[j] = Some(net(f.refs[2]));
        if let (Some(k), Some(r5), Some(rh)) = (TOX_OF_H[j], f.refs[0].filter(|x| *x != 0.0), rh)
            && f.tox[k].is_none()
        {
            f.tox[k] = Some(toxicity_bps(f.side, r5, rh));
        }
        self.mark_dirty(id);
    }

    /// The fills added or changed since the last call, in first-change order.
    pub fn take_dirty(&mut self) -> Vec<FillRec> {
        self.dirty_set.clear();
        std::mem::take(&mut self.dirty).iter().filter_map(|id| self.get(id).cloned()).collect()
    }

    pub fn roll(&mut self, day_start: i64) {
        self.fills.retain(|f| f.ts >= day_start);
        self.reindex();
        let by_id = &self.by_id;
        self.pending.retain(|id| by_id.contains_key(id));
        self.dirty.clear();
        self.dirty_set.clear();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::market::{BookTicker, Info};
    use approx::assert_relative_eq;

    #[test]
    fn markout_raw_and_net() {
        let (raw, net) = markout_bps(Side::Buy, 100.0, 100.10, None, None);
        assert_relative_eq!(raw, 10.0, max_relative = 1e-9);
        assert_eq!(net, None);
        let (raw, net) = markout_bps(Side::Buy, 100.0, 100.10, Some(50.0), Some(50.025));   // reference +5 bps
        assert_relative_eq!(raw, 10.0, max_relative = 1e-9);
        assert_relative_eq!(net.unwrap(), 5.0, max_relative = 1e-9);
        let (raw, net) = markout_bps(Side::Sell, 100.0, 99.80, Some(50.0), Some(49.95));   // reference -10 bps
        assert_relative_eq!(raw, 20.0, max_relative = 1e-9);
        assert_relative_eq!(net.unwrap(), 10.0, max_relative = 1e-9);
    }

    #[test]
    fn edge() {
        assert_relative_eq!(edge_bps(Side::Buy, 100.0, 99.9), 10.0, max_relative = 1e-9);
        assert_relative_eq!(edge_bps(Side::Sell, 100.0, 99.9), -10.0, max_relative = 1e-9);
    }

    fn market() -> Market {
        let mut info = Info::new();
        info.insert(Venue::Spot, Default::default());
        info.insert(Venue::Usdm, Default::default());
        Market::new(info, 120.0, 100.0)
    }

    #[test]
    fn fillbook_matures_on_exchange_time() {
        let mut m = market();
        m.ensure("XUSDT", Venue::Spot, Some(("XUSDT", Venue::Usdm)));
        for (t, s, r) in [(0, 100.0, 50.0), (1_000, 100.1, 50.025), (10_000, 100.2, 50.0)] {
            m.on_book(Venue::Usdm, &BookTicker::new("XUSDT", r, r, Some(t)));
            m.on_book(Venue::Spot, &BookTicker::new("XUSDT", s, s, Some(t)));
        }
        let mut fb = FillBook::new();
        fb.add(&mut m, FillRec::new("a", 0, "acct", "XUSDT", Venue::Spot, Side::Buy, 100.0, 1.0), true);
        fb.mature(&m, 1_500);
        assert_eq!(fb.get("a").unwrap().mk.0[0], None);
        fb.mature(&m, 2_000);
        // net is measured from the reference 1 s after the fill, so at 1 s it equals raw
        let f = fb.get("a").unwrap();
        assert_relative_eq!(f.mk_raw.0[0].unwrap(), 10.0, max_relative = 1e-9);
        assert_relative_eq!(f.mk.0[0].unwrap(), 10.0, max_relative = 1e-9);
        fb.mature(&m, 11_000);
        let f = fb.get("a").unwrap();
        assert_relative_eq!(f.mk_raw.0[1].unwrap(), 20.0, max_relative = 1e-9);
        assert_relative_eq!(f.mk.0[1].unwrap(), 20.0 - (50.0 / 50.025 - 1.0) * 1e4, max_relative = 1e-9);
        assert_eq!(f.pnl("60"), 0.0);
    }

    #[test]
    fn add_sorts_dedups_and_rolls() {
        let mut m = market();
        let mut fb = FillBook::new();
        let f = |id: &str, ts| FillRec::new(id, ts, "a", "XUSDT", Venue::Spot, Side::Sell, 1.0, 1.0);
        assert!(fb.add(&mut m, f("b", 20), true));
        assert!(fb.add(&mut m, f("a", 10), true));
        assert!(!fb.add(&mut m, f("a", 10), true));
        assert_eq!(fb.fills.iter().map(|x| x.id.as_str()).collect::<Vec<_>>(), ["a", "b"]);
        assert_eq!(fb.get("b").unwrap().ts, 20);
        assert_eq!(fb.take_dirty().iter().map(|x| x.id.as_str()).collect::<Vec<_>>(), ["b", "a"]);
        assert!(fb.take_dirty().is_empty());
        fb.roll(15);
        assert_eq!(fb.fills.len(), 1);
        assert!(fb.get("a").is_none() && fb.get("b").is_some());
        assert_eq!(fb.get("b").unwrap().proto().side, Side::Sell);
    }

    #[test]
    fn mark_at_young_unmarked_backfilled() {
        let mut f = FillRec::new("a", 0, "acct", "XUSDT", Venue::Spot, Side::Buy, 100.0, 1.0);
        let due = 60_000 + MARK_GRACE_MS;
        assert_eq!(f.mark_at(2, 30_000), MarkAt::Young);
        assert_eq!(f.mark_at(2, due - 1), MarkAt::Young);    // the live path still has the grace to take it
        assert_eq!(f.mark_at(2, due), MarkAt::Unmarked);     // never the mid now: the fill is left out
        f.mk_raw.0[2] = Some(-3.0);
        assert_eq!(f.mark_at(2, 30_000), MarkAt::Bps(-3.0));
        assert_eq!(f.mark_at(2, 10 * due), MarkAt::Bps(-3.0));
    }

    #[test]
    fn backfill_books_marks_and_their_flags() {
        let mut m = market();
        let mut fb = FillBook::new();
        let mut f = FillRec::new("a", 0, "acct", "XUSDT", Venue::Spot, Side::Buy, 100.0, 1.0);
        f.mk_raw.0[0] = Some(1.0);   // 1 s taken live, the desk down from then
        f.mk.0[0] = Some(1.0);
        f.mk_fast.0[0] = Some(1.0);
        fb.add(&mut m, f, false);
        fb.add(&mut m, FillRec::new("young", 320_000, "acct", "XUSDT", Venue::Spot, Side::Sell, 100.0, 1.0), false);
        fb.take_dirty();
        let now = 400_000;
        // 10, 60, 300 s are due for "a"; "young" only 1 and 10 s
        let needs = fb.mark_needs(now);
        assert_eq!(needs.iter().map(|n| (n.id.as_str(), n.js.clone())).collect::<Vec<_>>(),
                   [("a", vec![1, 2, 3]), ("young", vec![0, 1])]);
        assert_eq!(needs[0].key, "spot:XUSDT");
        fb.backfill_raw("a", 2, Some(100.2));
        fb.backfill_raw("a", 3, None);     // klines have no price there
        let f = fb.get("a").unwrap();
        assert_relative_eq!(f.mk_raw.0[2].unwrap(), 20.0, max_relative = 1e-9);
        assert_eq!((f.mk.0[2], f.mk_fast.0[2]), (f.mk_raw.0[2], f.mk_raw.0[2]));   // no reference: net = raw
        assert_eq!(f.mark_at(2, now), MarkAt::Bps(f.mk_raw.0[2].unwrap()));
        assert_eq!((f.bf, f.unpriceable(3), f.mark_at(3, now)), (0b1000_0100, true, MarkAt::Unmarked));
        assert_eq!(fb.take_dirty().len(), 1);
        // the unpriceable horizon is not asked again; a mark taken already is not overwritten
        assert_eq!(fb.mark_needs(now)[0].js, vec![1]);
        fb.backfill_raw("a", 0, Some(500.0));
        assert_eq!(fb.get("a").unwrap().mk_raw.0[0], Some(1.0));
    }

    #[test]
    fn backfill_net_waits_for_the_reference() {
        let mut m = market();
        m.ensure("XUSDT", Venue::Spot, Some(("XUSDT", Venue::Usdm)));
        let mut fb = FillBook::new();
        let mut f = FillRec::new("a", 0, "acct", "XUSDT", Venue::Spot, Side::Buy, 100.0, 1.0);
        f.has_ref = true;
        f.refs = [Some(50.0), Some(50.0), Some(50.0), Some(50.0)];
        fb.add(&mut m, f, false);
        fb.add(&mut m, FillRec::new("b", 0, "acct", "XUSDT", Venue::Spot, Side::Sell, 100.0, 1.0), false);
        fb.backfill_raw("a", 2, Some(100.2));
        fb.backfill_raw("b", 2, Some(100.2));
        let a = fb.get("a").unwrap();
        assert!(a.mk_raw.0[2].is_some() && a.mk.0[2].is_none());   // net still to come
        let needs = fb.ref_needs(&m);
        assert_eq!(needs.len(), 1);
        assert_eq!((needs[0].id.as_str(), needs[0].key.as_str(), needs[0].js.clone()), ("a", "usdm:XUSDT", vec![2]));
        fb.backfill_net("a", 2, Some(50.05));   // the reference +10 bps
        let a = fb.get("a").unwrap();
        assert_relative_eq!(a.mk.0[2].unwrap(), 10.0, max_relative = 1e-9);
        assert_relative_eq!(a.mk_fast.0[2].unwrap(), 10.0, max_relative = 1e-9);
        assert_relative_eq!(a.tox[3].unwrap(), -10.0, max_relative = 1e-9);   // D(60 s): the reference went with the buy
        assert!(fb.ref_needs(&m).is_empty());
        // without the reference at t + h, net is raw, as live
        fb.backfill_raw("a", 3, Some(100.1));
        fb.backfill_net("a", 3, None);
        let a = fb.get("a").unwrap();
        assert_eq!(a.mk.0[3], a.mk_raw.0[3]);
        assert_eq!(a.tox[4], None);
    }
}
