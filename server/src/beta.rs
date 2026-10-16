//! Betas of the configured markets against one instrument, for a beta-weighted hedge target.
//!
//! Every `sample_s` each market's price (its reference if it has one, else its own mid) and the
//! beta instrument's mid are sampled; log returns over `horizon_s` (overlapping when longer than
//! `sample_s`: one per sample) feed exponentially weighted cov/var with a half-life. A longer horizon
//! takes in what a market follows the beta instrument with a lag. The estimate is shrunk to a prior
//! while samples are few: beta = clip(prior + w * (cov/var - prior)), w = n / (n + prior_samples).
use std::collections::{HashMap, VecDeque};

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, PartialEq)]
pub struct BetaCfg {
    pub vs: String,   // instrument key, e.g. "usdm:XYZUSDT"
    pub prior: f64,
    pub halflife_h: f64,
    pub prior_samples: f64,
    pub sample_s: f64,
    pub horizon_s: f64,   // return horizon, a whole number of samples (at least one)
    pub clip: f64,
    pub priors: HashMap<String, f64>,   // per market key, e.g. negative for a market that moves against beta_vs
}

impl BetaCfg {
    pub fn new(vs: impl Into<String>) -> Self {
        BetaCfg {
            vs: vs.into(),
            prior: 1.0,
            halflife_h: 8.0,
            prior_samples: 1440.0,
            sample_s: 10.0,
            horizon_s: 10.0,
            clip: 1.5,
            priors: HashMap::new(),
        }
    }
}

#[derive(Serialize, Deserialize)]
struct State {
    #[serde(default)]
    horizon_s: Option<f64>,   // None: kept before the horizon was configurable (one sample)
    #[serde(default)]
    sample_s: Option<f64>,
    var: f64,
    n_vs: i64,
    cov: HashMap<String, f64>,
    n: HashMap<String, i64>,
}

#[derive(Debug, Clone)]
pub struct Betas {
    pub cfg: BetaCfg,
    pub alpha: f64,
    pub var: f64,
    pub n_vs: i64,
    pub cov: HashMap<String, f64>,
    pub n: HashMap<String, i64>,
    /// the last `steps` + 1 prices of each market (the beta instrument under ""), one per sample
    pub last: HashMap<String, VecDeque<f64>>,
    pub steps: usize,
}

impl Betas {
    pub fn new(cfg: BetaCfg) -> Self {
        let alpha = 1.0 - 0.5f64.powf(cfg.sample_s / (cfg.halflife_h * 3600.0));
        let steps = ((cfg.horizon_s / cfg.sample_s).round() as usize).max(1);
        Betas { cfg, alpha, var: 0.0, n_vs: 0, cov: HashMap::new(), n: HashMap::new(), last: HashMap::new(), steps }
    }

    /// Adds p to k's prices; its log return over the horizon once they reach back that far.
    fn push(&mut self, k: &str, p: f64) -> Option<f64> {
        let q = self.last.entry(k.to_string()).or_default();
        q.push_back(p);
        if q.len() > self.steps + 1 {
            q.pop_front();
        }
        (q.len() == self.steps + 1).then(|| (p / q[0]).ln())
    }

    /// One sampling step: vs_px is the beta instrument's price, prices maps market -> price.
    pub fn sample<'a>(&mut self, vs_px: Option<f64>, prices: impl IntoIterator<Item = (&'a str, Option<f64>)>) {
        let vs_px = match vs_px {
            Some(v) if v > 0.0 => v,
            _ => return,
        };
        let r = self.push("", vs_px);
        let a = self.alpha;
        if let Some(r) = r {
            self.var += a * (r * r - self.var);
            self.n_vs += 1;
        }
        for (k, p) in prices {
            let p = match p {
                Some(p) if p > 0.0 => p,
                _ => {
                    self.last.remove(k);   // no price this step: restart its return chain
                    continue;
                }
            };
            let (Some(rk), Some(r)) = (self.push(k, p), r) else { continue };
            let c = self.cov.entry(k.to_string()).or_insert(0.0);
            *c += a * (rk * r - *c);
            *self.n.entry(k.to_string()).or_insert(0) += 1;
        }
    }

    pub fn beta(&self, k: &str) -> f64 {
        let c = &self.cfg;
        let prior = c.priors.get(k).copied().unwrap_or(c.prior);
        let n = self.n.get(k).copied().unwrap_or(0);
        if n == 0 || self.var <= 0.0 {
            return prior;
        }
        let w = n as f64 / (n as f64 + c.prior_samples);
        (prior + w * (self.cov[k] / self.var - prior)).clamp(-c.clip, c.clip)
    }

    pub fn dump(&self) -> String {
        let st = State {
            horizon_s: Some(self.cfg.horizon_s),
            sample_s: Some(self.cfg.sample_s),
            var: self.var,
            n_vs: self.n_vs,
            cov: self.cov.clone(),
            n: self.n.clone(),
        };
        serde_json::to_string(&st).expect("beta state serializes")
    }

    /// State kept for another horizon or sample interval is not taken: the estimate starts again.
    pub fn load(&mut self, s: &str) -> anyhow::Result<()> {
        let d: State = serde_json::from_str(s)?;
        let kept = (d.horizon_s.unwrap_or(d.sample_s.unwrap_or(self.cfg.sample_s)), d.sample_s.unwrap_or(self.cfg.sample_s));
        anyhow::ensure!(kept == (self.cfg.horizon_s, self.cfg.sample_s),
                        "kept for a {} s horizon sampled every {} s, not {} s every {} s", kept.0, kept.1,
                        self.cfg.horizon_s, self.cfg.sample_s);
        (self.var, self.n_vs, self.cov, self.n) = (d.var, d.n_vs, d.cov, d.n);
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use rand::{Rng, SeedableRng};

    fn gauss(rng: &mut rand::rngs::StdRng, sigma: f64) -> f64 {
        // Box-Muller (Python's random.gauss draws differ; the test checks a tolerance, not a value)
        let u1: f64 = 1.0 - rng.random::<f64>();
        let u2: f64 = rng.random::<f64>();
        sigma * (-2.0 * u1.ln()).sqrt() * (2.0 * std::f64::consts::PI * u2).cos()
    }

    #[test]
    fn beta_estimate_shrinks_to_prior_then_learns() {
        let mut cfg = BetaCfg::new("usdm:VS");
        cfg.prior = 0.4;
        cfg.prior_samples = 100.0;
        let mut b = Betas::new(cfg);
        assert_eq!(b.beta("x"), 0.4);
        let mut rng = rand::rngs::StdRng::seed_from_u64(1);
        let (mut vs, mut px) = (100.0f64, 100.0f64);
        for _ in 0..5000 {
            let r = gauss(&mut rng, 1e-3);
            vs *= r.exp();
            px *= (0.8 * r + gauss(&mut rng, 2e-4)).exp();
            b.sample(Some(vs), [("x", Some(px))]);
        }
        assert!((b.beta("x") - 0.8).abs() <= 0.06, "{}", b.beta("x"));
        let mut c = Betas::new(b.cfg.clone());
        c.load(&b.dump()).unwrap();
        approx::assert_relative_eq!(c.beta("x"), b.beta("x"), max_relative = 1e-12);
    }

    #[test]
    fn a_longer_horizon_takes_in_a_lagged_follower() {
        // x makes the beta instrument's move 0.8 times over, three samples later
        let run = |horizon_s: f64| {
            let mut cfg = BetaCfg::new("usdm:VS");
            (cfg.prior, cfg.prior_samples, cfg.sample_s, cfg.horizon_s) = (0.0, 1.0, 15.0, horizon_s);
            let mut b = Betas::new(cfg);
            let mut rng = rand::rngs::StdRng::seed_from_u64(2);
            let (mut vs, mut px) = (100.0f64, 100.0f64);
            let mut moves = VecDeque::from([0.0; 3]);
            for _ in 0..20_000 {
                let r = gauss(&mut rng, 1e-3);
                vs *= r.exp();
                moves.push_back(r);
                px *= (0.8 * moves.pop_front().unwrap() + gauss(&mut rng, 2e-4)).exp();
                b.sample(Some(vs), [("x", Some(px))]);
            }
            b
        };
        assert!(run(15.0).beta("x").abs() < 0.1);
        let b = run(900.0);
        assert!((b.beta("x") - 0.8).abs() <= 0.1, "{}", b.beta("x"));
        let mut c = Betas::new(BetaCfg::new("usdm:VS"));   // 10 s returns: state kept for 900 s is not taken
        assert!(c.load(&b.dump()).is_err());
        c.load(r#"{"var": 1.0, "n_vs": 1, "cov": {}, "n": {}}"#).unwrap();   // kept before the horizon: 10 s
    }
}
