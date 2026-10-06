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
        }
    }

    pub fn key(&self) -> String {
        key(&self.symbol, self.venue)
    }

    pub fn notional(&self) -> f64 {
        self.price * self.qty
    }

    /// Markout P&L at horizon h ("1", "10", "60", "300"), USDT.
    pub fn pnl(&self, h: &str) -> f64 {
        let i = HK.iter().position(|k| *k == h).expect("horizon");
        self.mk.0[i].map_or(0.0, |m| m * self.notional() / 1e4)
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
        }
    }
}

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
}
