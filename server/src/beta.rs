//! Betas of the configured markets against one instrument, for a beta-weighted hedge target.
//!
//! Every `sample_s` each market's price (its reference if it has one, else its own mid) and the
//! beta instrument's mid are sampled; log returns feed exponentially weighted cov/var with a
//! half-life. The estimate is shrunk to a prior while samples are few:
//! beta = clip(prior + w * (cov/var - prior)), w = n / (n + prior_samples).
use std::collections::HashMap;

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, PartialEq)]
pub struct BetaCfg {
    pub vs: String,   // instrument key, e.g. "usdm:XYZUSDT"
    pub prior: f64,
    pub halflife_h: f64,
    pub prior_samples: f64,
    pub sample_s: f64,
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
            clip: 1.5,
            priors: HashMap::new(),
        }
    }
}

#[derive(Serialize, Deserialize)]
struct State {
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
    pub last: HashMap<String, f64>,
}

impl Betas {
    pub fn new(cfg: BetaCfg) -> Self {
        let alpha = 1.0 - 0.5f64.powf(cfg.sample_s / (cfg.halflife_h * 3600.0));
        Betas { cfg, alpha, var: 0.0, n_vs: 0, cov: HashMap::new(), n: HashMap::new(), last: HashMap::new() }
    }

    /// One sampling step: vs_px is the beta instrument's price, prices maps market -> price.
    pub fn sample<'a>(&mut self, vs_px: Option<f64>, prices: impl IntoIterator<Item = (&'a str, Option<f64>)>) {
        let vs_px = match vs_px {
            Some(v) if v > 0.0 => v,
            _ => return,
        };
        let prev = self.last.insert(String::new(), vs_px);
        let Some(prev) = prev else {
            for (k, p) in prices {
                if let Some(p) = p.filter(|p| *p != 0.0) {
                    self.last.insert(k.to_string(), p);
                }
            }
            return;
        };
        let r = (vs_px / prev).ln();
        let a = self.alpha;
        self.var += a * (r * r - self.var);
        self.n_vs += 1;
        for (k, p) in prices {
            let p = match p {
                Some(p) if p > 0.0 => p,
                _ => {
                    self.last.remove(k);   // no price this step: restart its return chain
                    continue;
                }
            };
            let q = match self.last.get_mut(k) {
                Some(q) => std::mem::replace(q, p),
                None => {
                    self.last.insert(k.to_string(), p);
                    continue;
                }
            };
            let c = self.cov.entry(k.to_string()).or_insert(0.0);
            *c += a * ((p / q).ln() * r - *c);
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
        serde_json::to_string(&State { var: self.var, n_vs: self.n_vs, cov: self.cov.clone(), n: self.n.clone() })
            .expect("beta state serializes")
    }

    pub fn load(&mut self, s: &str) -> anyhow::Result<()> {
        let d: State = serde_json::from_str(s)?;
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
}
