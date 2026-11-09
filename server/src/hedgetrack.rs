//! The hedge against the engine's own target: what the hedge would have made sitting on the target the engine
//! pushes (`hedge_target`, a signed notional in the desk's currency), what it made, and the gap between them.
//!
//! Each second the hedge legs (the perps that hedge, and the spot assets that do) are read at their mids, and
//!
//! ```text
//!   r(t)      = Σ_l q_l(t-1) (P_l(t) - P_l(t-1)) / Σ_l q_l(t-1) P_l(t-1)      the hedge's return (its legs' mean move when flat)
//!   ideal    += T(t-1) r(t)                                                   a hedge held at the target
//!   carry    += Σ_l q_l(t-1) (P_l(t) - P_l(t-1))                              the hedge as held, at mid
//! ```
//!
//! P_l is a unit of leg l in the desk's currency, at mid on both the hedge and the inventory (`PnlBook` marks the
//! inventory at its mids). The hedge's price P&L at mid is carry plus its fills against the mid at each fill; less
//! ideal, that is the tracking in price, split by the hedge fills' markout at the desk's horizon (fill markout)
//! and the rest (position lag: the position away from the target as the hedge moved). A gap in the live steps (a
//! restart, the desk's first start of a day) is stepped on 1 min klines with the target from the engine's
//! samples and each leg's position from its fills.
use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};

pub const HOUR: i64 = 3_600_000;
/// The engine's metrics the track reads, by FastMM's names (the web's strategy page reads the same).
pub const TARGET: &str = "hedge_target";
pub const BAND: &str = "hedge_band";
pub const BETA: &str = "beta";
/// A target older than this is no target: the engine is not pushing.
pub const TARGET_MAX_AGE_MS: i64 = 60_000;

/// A hedge leg now: its key ("usdm:XUSDT", or a spot asset's instrument), signed quantity, and a unit's value at mid
/// in the desk's currency.
#[derive(Debug, Clone, PartialEq)]
pub struct Leg {
    pub key: String,
    pub q: f64,
    pub px: f64,
}

/// One day of the track, kept in kv `hedgetrack:<day start>`.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct Track {
    pub day: i64,
    /// the first step of the day (ms); later than the day start when the desk started later and could not step back
    pub start: Option<i64>,
    pub last: Option<i64>,
    /// T(t-1)
    pub target: Option<f64>,
    /// each leg at the last step: (q, px)
    pub legs: BTreeMap<String, (f64, f64)>,
    pub ideal: f64,
    pub carry: f64,
    /// seconds stepped with a target
    pub target_s: i64,
    /// by UTC hour start: carry and ideal
    pub carry_h: BTreeMap<i64, f64>,
    pub ideal_h: BTreeMap<i64, f64>,
}

impl Track {
    pub fn new(day: i64) -> Track {
        Track { day, ..Default::default() }
    }

    /// The next day: the legs and target carry over, the sums restart.
    pub fn roll(&self, day: i64) -> Track {
        Track { day, start: self.last.map(|_| day), last: self.last.map(|l| l.max(day)), target: self.target, legs: self.legs.clone(), ..Default::default() }
    }

    /// One step to `t` (ms): the legs and the target now (None without a fresh one). A leg without a price keeps
    /// its last one.
    pub fn step(&mut self, t: i64, legs: &[Leg], target: Option<f64>) {
        if let Some(last) = self.last.filter(|l| t > *l) {
            let (mut held, mut d) = (0.0, 0.0);
            let (mut moves, mut n) = (0.0, 0);
            for (k, &(q, px)) in &self.legs {
                held += q * px;
                if let Some(l) = legs.iter().find(|l| &l.key == k && l.px > 0.0)
                    && px > 0.0
                {
                    d += q * (l.px - px);
                    moves += l.px / px - 1.0;
                    n += 1;
                }
            }
            let r = if held.abs() > 1e-9 { d / held } else if n > 0 { moves / n as f64 } else { 0.0 };
            let hour = (t - 1) - (t - 1).rem_euclid(HOUR);
            if let Some(tp) = self.target {
                self.ideal += tp * r;
                *self.ideal_h.entry(hour).or_default() += tp * r;
                self.target_s += (t - last) / 1000;
            }
            self.carry += d;
            *self.carry_h.entry(hour).or_default() += d;
        } else if self.last.is_some() {
            return;
        }
        self.start.get_or_insert(t);
        for l in legs {
            if l.px > 0.0 {
                self.legs.insert(l.key.clone(), (l.q, l.px));
            } else if let Some(e) = self.legs.get_mut(&l.key) {
                e.0 = l.q;
            }
        }
        self.legs.retain(|k, (q, _)| *q != 0.0 || legs.iter().any(|l| &l.key == k));
        self.target = target;
        self.last = Some(t);
    }
}

/// The engine's named metric in a push (`{"metrics": [{"name", "value"}]}`).
pub fn metric(payload: &serde_json::Value, name: &str) -> Option<f64> {
    payload.get("metrics")?.as_array()?.iter().find(|m| m.get("name").and_then(|n| n.as_str()) == Some(name))?.get("value")?.as_f64()
}

/// Standard deviation (n - 1) of `xs`; None under 3 values.
pub fn sd(xs: &[f64]) -> Option<f64> {
    if xs.len() < 3 {
        return None;
    }
    let n = xs.len() as f64;
    let m = xs.iter().sum::<f64>() / n;
    Some((xs.iter().map(|x| (x - m).powi(2)).sum::<f64>() / (n - 1.0)).sqrt())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn leg(q: f64, px: f64) -> Leg {
        Leg { key: "usdm:HUSDT".into(), q, px }
    }

    #[test]
    fn ideal_and_carry_on_the_hedges_move() {
        let mut t = Track::new(0);
        // short 10 at 100 (-1000) against a target of -1500
        t.step(1000, &[leg(-10.0, 100.0)], Some(-1500.0));
        // the hedge falls 1 %: it makes 10, the target would have made 15
        t.step(2000, &[leg(-10.0, 99.0)], Some(-1500.0));
        assert!((t.carry - 10.0).abs() < 1e-9 && (t.ideal - 15.0).abs() < 1e-9);
        // flat now, the target 0: the next move counts for neither
        t.step(3000, &[leg(0.0, 99.0)], Some(0.0));
        t.step(4000, &[leg(0.0, 98.0)], None);
        assert!((t.carry - 10.0).abs() < 1e-9 && (t.ideal - 15.0).abs() < 1e-9);
        // flat with a target: the leg's own move is the hedge's return
        t.step(5000, &[leg(0.0, 98.0)], Some(-980.0));
        t.step(6000, &[leg(0.0, 97.02)], Some(-980.0));
        assert!((t.ideal - 24.8).abs() < 1e-9);
        assert_eq!((t.start, t.target_s), (Some(1000), 4));
        // a step back in time is not taken
        t.step(5500, &[leg(0.0, 1.0)], Some(1.0));
        assert_eq!(t.last, Some(6000));
        let r = t.roll(86_400_000);
        assert_eq!((r.ideal, r.target, r.legs.len()), (0.0, Some(-980.0), 1));
    }

    #[test]
    fn engine_metric_and_sd() {
        let p = serde_json::json!({"metrics": [{"name": "hedge_target", "value": -3.5}, {"name": "beta", "value": 0.3}]});
        assert_eq!(metric(&p, TARGET), Some(-3.5));
        assert_eq!(metric(&p, "nope"), None);
        assert_eq!(sd(&[1.0, 2.0]), None);
        assert!((sd(&[1.0, 2.0, 3.0]).unwrap() - 1.0).abs() < 1e-12);
    }
}
