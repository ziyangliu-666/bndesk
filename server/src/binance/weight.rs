//! Request-weight governor: stays under half the IP limit, stops on 429/418.
use std::cell::Cell;
use std::rc::Rc;
use std::time::Duration;

use crate::clock::now_s;

/// Per-IP request weight for one Binance API family: stays under `share` of the 1-minute
/// limit using the server's own X-*-USED-*WEIGHT-1M count, and stops on 429/418.
/// Shared (`Rc`) by every `Rest` on the same IP; interior `Cell`s, one thread.
#[derive(Debug)]
pub struct Governor {
    pub name: String,
    pub limit: i64,
    pub share: f64,
    pub used: Cell<i64>,
    pub minute: Cell<i64>,
    pub banned_until: Cell<f64>,
    pub last_ban: Cell<Option<(u16, f64)>>,
}

impl Governor {
    pub fn new(name: &str, limit: i64, share: f64) -> Self {
        Governor {
            name: name.into(),
            limit,
            share,
            used: Cell::new(0),
            minute: Cell::new(0),
            banned_until: Cell::new(0.0),
            last_ban: Cell::new(None),
        }
    }

    fn roll(&self, now: f64) {
        let m = (now / 60.0).floor() as i64;
        if m != self.minute.get() {
            self.minute.set(m);
            self.used.set(0);
        }
    }

    pub fn delay(&self, weight: i64, now: f64) -> f64 {
        if now < self.banned_until.get() {
            return self.banned_until.get() - now;
        }
        self.roll(now);
        if (self.used.get() + weight) as f64 > self.limit as f64 * self.share {
            return ((self.minute.get() + 1) * 60) as f64 - now + 0.05;
        }
        0.0
    }

    pub async fn acquire(&self, weight: i64) {
        loop {
            let d = self.delay(weight, now_s());
            if d <= 0.0 {
                break;
            }
            tokio::time::sleep(Duration::from_secs_f64(d)).await;
        }
        self.used.set(self.used.get() + weight);
    }

    /// Headers as (name, value) pairs, any case.
    pub fn update<'a>(&self, status: u16, headers: impl IntoIterator<Item = (&'a str, &'a str)>, now: Option<f64>) {
        let now = now.unwrap_or_else(now_s);
        self.roll(now);
        let mut retry = None;
        for (k, v) in headers {
            let k = k.to_ascii_lowercase();
            if k.starts_with("x-mbx-used-weight-1m") || k.starts_with("x-sapi-used-ip-weight-1m") {
                if let Ok(n) = v.trim().parse::<i64>() {
                    self.used.set(self.used.get().max(n));
                }
            } else if k == "retry-after" && retry.is_none() {
                retry = Some(v);
            }
        }
        if status == 418 || status == 429 {
            let secs = retry
                .and_then(|r| r.trim().parse::<f64>().ok())
                .unwrap_or(if status == 418 { 120.0 } else { 60.0 });
            self.banned_until.set(self.banned_until.get().max(now + secs));
            self.last_ban.set(Some((status, now)));
        }
    }

    pub fn banned(&self) -> bool {
        now_s() < self.banned_until.get()
    }
}

/// The governors of one IP (or account pool), one per API family.
#[derive(Debug, Clone)]
pub struct Governors {
    pub spot: Rc<Governor>,
    pub usdm: Rc<Governor>,
}

impl Governors {
    pub fn get(&self, fut: bool) -> &Rc<Governor> {
        if fut { &self.usdm } else { &self.spot }
    }

    pub fn iter(&self) -> impl Iterator<Item = &Rc<Governor>> {
        [&self.spot, &self.usdm].into_iter()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn stays_under_share_and_rolls() {
        let g = Governor::new("spot", 100, 0.5);
        let t = 600.0;
        assert_eq!(g.delay(10, t), 0.0);
        g.update(200, [("X-MBX-USED-WEIGHT-1M", "45")], Some(t));
        assert_eq!(g.used.get(), 45);
        assert!((g.delay(10, t + 1.0) - (59.0 + 0.05)).abs() < 1e-9);
        assert_eq!(g.delay(10, t + 60.0), 0.0);   // next minute
        assert_eq!(g.used.get(), 0);
    }

    #[test]
    fn ban_on_429_and_418() {
        let g = Governor::new("spot", 6000, 0.5);
        g.update(429, [("Retry-After", "7")], Some(1000.0));
        assert_eq!(g.delay(1, 1000.0), 7.0);
        assert_eq!(g.last_ban.get(), Some((429, 1000.0)));
        g.update(418, std::iter::empty(), Some(1001.0));
        assert_eq!(g.banned_until.get(), 1121.0);
    }
}
