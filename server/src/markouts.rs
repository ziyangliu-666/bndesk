//! `/api/markouts`: today's fills seen one way (filters, reference, weighting), from the price path each fill
//! keeps (`FillRec::pm` / `pr`). Computed per request on the desk's thread: a pass over the day's fills.
use std::collections::HashMap;

use crate::fills::{FillRec, PATH_N, PATH_S};
use crate::protocol::{self as P, Side, Venue};

pub const BUCKET_MS: i64 = 900_000;
const J10: usize = 11; // PATH_S index of 10 s
const J60: usize = 14;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum Reference {
    #[default]
    Net,
    Fast,
    Raw,
}

#[derive(Debug, Clone, PartialEq, Default)]
pub struct Query {
    pub account: Option<String>,
    pub venue: Option<Venue>,
    pub side: Option<Side>,
    pub reference: Reference,
    pub by_fill: bool,
    /// PATH_S index of the distribution's horizon.
    pub h: usize,
}

impl Query {
    /// From the URL's parameters; a bad value is an error (a 400).
    pub fn parse(q: &HashMap<String, String>) -> Result<Query, String> {
        let get = |k: &str| q.get(k).map(String::as_str).filter(|s| !s.is_empty());
        let reference = match get("ref") {
            None | Some("net") => Reference::Net,
            Some("fast") => Reference::Fast,
            Some("raw") => Reference::Raw,
            Some(x) => return Err(format!("bad ref: {x:?}")),
        };
        let by_fill = match get("weight") {
            None | Some("notional") => false,
            Some("fill") => true,
            Some(x) => return Err(format!("bad weight: {x:?}")),
        };
        let h: f64 = match get("h") {
            None => 10.0,
            Some(x) => x.parse().map_err(|_| format!("bad h: {x:?}"))?,
        };
        let h = (0..PATH_N)
            .min_by(|&a, &b| (PATH_S[a] - h).abs().total_cmp(&(PATH_S[b] - h).abs()))
            .unwrap_or(J10);
        Ok(Query {
            account: get("account").map(str::to_string),
            venue: get("venue").map(str::parse).transpose()?,
            side: get("side").map(str::parse).transpose()?,
            reference,
            by_fill,
            h,
        })
    }
}

/// Weighted moments of one quantity: mean, standard error (variance over effective n − 1), share below 0.
#[derive(Debug, Clone, Copy, Default)]
struct Mom {
    n: i64,
    w: f64,
    wx: f64,
    wxx: f64,
    ww: f64,
    wneg: f64,
}

impl Mom {
    fn add(&mut self, x: f64, w: f64) {
        if !x.is_finite() || w <= 0.0 {
            return;
        }
        self.n += 1;
        self.w += w;
        self.wx += w * x;
        self.wxx += w * x * x;
        self.ww += w * w;
        if x < 0.0 {
            self.wneg += w;
        }
    }

    fn mean(&self) -> Option<f64> {
        (self.w > 0.0).then(|| self.wx / self.w)
    }

    fn se(&self) -> Option<f64> {
        if self.n < 2 || self.w <= 0.0 {
            return None;
        }
        let m = self.wx / self.w;
        let var = (self.wxx / self.w - m * m).max(0.0);
        let neff = self.w * self.w / self.ww;
        (neff > 1.0).then(|| (var / (neff - 1.0)).sqrt())
    }

    fn adverse(&self) -> Option<f64> {
        (self.w > 0.0).then(|| self.wneg / self.w)
    }
}

fn line(m: &[Mom; PATH_N]) -> P::MarkoutLine {
    P::MarkoutLine {
        n: m.iter().map(|x| x.n).collect(),
        mean: m.iter().map(Mom::mean).collect(),
        se: m.iter().map(Mom::se).collect(),
        adverse: m.iter().map(Mom::adverse).collect(),
    }
}

/// The fill's markout at path horizon j under the reference, bps.
fn value(f: &FillRec, j: usize, r: Reference) -> Option<f64> {
    let (raw, net, fast, _) = f.path_at(j)?;
    Some(match r {
        Reference::Net => net,
        Reference::Fast => fast,
        Reference::Raw => raw,
    })
}

/// A round bin width giving about `want` bins over `span`.
fn nice_width(span: f64, want: f64) -> f64 {
    let raw = (span / want).max(1e-6);
    let mag = 10f64.powf(raw.log10().floor());
    [1.0, 2.0, 2.5, 5.0, 10.0].iter().map(|k| k * mag).find(|w| *w >= raw).unwrap_or(10.0 * mag)
}

/// Weighted quantile of (x, w) sorted by x.
fn quantile(xs: &[(f64, f64)], total: f64, q: f64) -> Option<f64> {
    let target = q * total;
    let mut acc = 0.0;
    for &(x, w) in xs {
        acc += w;
        if acc >= target {
            return Some(x);
        }
    }
    xs.last().map(|x| x.0)
}

fn dist(mut xs: Vec<(f64, f64)>, h: usize) -> P::MarkoutDist {
    let mut d = P::MarkoutDist { h: PATH_S[h], n: xs.len() as i64, ..Default::default() };
    if xs.is_empty() {
        return d;
    }
    xs.sort_by(|a, b| a.0.total_cmp(&b.0));
    let total: f64 = xs.iter().map(|x| x.1).sum();
    let q = |p: f64| quantile(&xs, total, p);
    d.mean = Some(xs.iter().map(|(x, w)| x * w).sum::<f64>() / total);
    d.median = q(0.5);
    d.p10 = q(0.1);
    d.p90 = q(0.9);
    let (a, b) = (q(0.01).unwrap_or(0.0), q(0.99).unwrap_or(0.0));
    let width = nice_width((b - a).max(0.5), 36.0);
    let lo = (a / width).floor() * width;
    let nbins = (((b - lo) / width).floor() as usize + 1).clamp(1, 80);
    let mut bins = vec![0.0; nbins];
    for &(x, w) in &xs {
        let k = ((x - lo) / width).floor().clamp(0.0, (nbins - 1) as f64) as usize;
        bins[k] += w / total;
    }
    d.lo = lo;
    d.width = width;
    d.bins = bins;
    d
}

#[derive(Default)]
struct Inst {
    fills: i64,
    notional: f64,
    edge: Mom,
    mk: [Mom; PATH_N],
    pnl: f64,
}

/// The report for one view of today's fills; `now` and `day_start` in ms.
pub fn report(fills: &[FillRec], q: &Query, now: i64, day_start: i64) -> P::MarkoutReport {
    let mut sides = [[Mom::default(); PATH_N]; 3]; // all, buy, sell
    let mut tox = [Mom::default(); PATH_N];
    let mut edge = Mom::default();
    let (mut n, mut notional, mut pnl) = (0i64, 0.0, 0.0);
    let mut at_h: Vec<(f64, f64)> = vec![];
    let nb = ((now - day_start).max(0) / BUCKET_MS + 1) as usize;
    let mut buckets: Vec<(i64, f64, Mom, Mom)> = vec![(0, 0.0, Mom::default(), Mom::default()); nb.min(200)];
    let mut insts: HashMap<(&str, Venue), Inst> = HashMap::new();
    for f in fills {
        if q.account.as_ref().is_some_and(|a| *a != f.account) || q.venue.is_some_and(|v| v != f.venue) {
            continue;
        }
        let w = if q.by_fill { 1.0 } else { f.notional() };
        let vals: [Option<f64>; PATH_N] = std::array::from_fn(|j| value(f, j, q.reference));
        let si = if f.side == Side::Buy { 1 } else { 2 };
        for (j, v) in vals.iter().enumerate() {
            if let Some(v) = v {
                sides[0][j].add(*v, w);
                sides[si][j].add(*v, w);
            }
        }
        if q.side.is_some_and(|s| s != f.side) {
            continue;
        }
        n += 1;
        notional += f.notional();
        if let Some(e) = f.edge_bps {
            edge.add(e, w);
        }
        let p60 = vals[J60].map_or(0.0, |v| v * f.notional() / 1e4);
        pnl += p60;
        for (j, m) in tox.iter_mut().enumerate() {
            if let Some((_, _, _, Some(d))) = f.path_at(j) {
                m.add(d, w);
            }
        }
        if let Some(v) = vals[q.h] {
            at_h.push((v, w));
        }
        let k = (f.ts - day_start).div_euclid(BUCKET_MS);
        if let Some(b) = usize::try_from(k).ok().and_then(|k| buckets.get_mut(k)) {
            b.0 += 1;
            b.1 += f.notional();
            if let Some(v) = vals[J10] {
                b.2.add(v, w);
            }
            if let Some(v) = vals[J60] {
                b.3.add(v, w);
            }
        }
        let a = insts.entry((f.symbol.as_str(), f.venue)).or_default();
        a.fills += 1;
        a.notional += f.notional();
        if let Some(e) = f.edge_bps {
            a.edge.add(e, w);
        }
        for (j, v) in vals.iter().enumerate() {
            if let Some(v) = v {
                a.mk[j].add(*v, w);
            }
        }
        a.pnl += p60;
    }
    let mut by_instrument: Vec<P::MarkoutInst> = insts
        .into_iter()
        .map(|((symbol, venue), a)| P::MarkoutInst {
            symbol: symbol.to_string(),
            venue,
            fills: a.fills,
            notional: a.notional,
            edge: a.edge.mean(),
            mean: a.mk.iter().map(Mom::mean).collect(),
            se10: a.mk[J10].se(),
            adverse10: a.mk[J10].adverse(),
            pnl: a.pnl,
        })
        .collect();
    by_instrument.sort_by(|a, b| b.notional.total_cmp(&a.notional).then_with(|| a.symbol.cmp(&b.symbol)));
    P::MarkoutReport {
        now,
        day_start,
        horizons_s: PATH_S.to_vec(),
        fills: n,
        notional,
        edge: edge.mean(),
        pnl,
        all: line(&sides[0]),
        buy: line(&sides[1]),
        sell: line(&sides[2]),
        tox: line(&tox),
        dist: dist(at_h, q.h),
        by_time: buckets
            .into_iter()
            .enumerate()
            .map(|(k, (fills, notional, m10, m60))| P::MarkoutBucket {
                t: day_start + k as i64 * BUCKET_MS,
                fills,
                notional,
                mk10: m10.mean(),
                mk60: m60.mean(),
            })
            .collect(),
        by_instrument,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::fills::{FillBook, PATH_OF_H};
    use crate::market::{BookTicker, Info, Market};
    use approx::assert_relative_eq;

    fn q(pairs: &[(&str, &str)]) -> Result<Query, String> {
        Query::parse(&pairs.iter().map(|(k, v)| (k.to_string(), v.to_string())).collect())
    }

    #[test]
    fn query_parses_and_rejects() {
        let d = q(&[]).unwrap();
        assert_eq!((d.reference, d.by_fill, PATH_S[d.h]), (Reference::Net, false, 10.0));
        let x = q(&[("ref", "raw"), ("weight", "fill"), ("h", "-0.4"), ("side", "sell"), ("venue", "spot"), ("account", "a")]).unwrap();
        assert_eq!((x.reference, x.by_fill, PATH_S[x.h], x.side, x.venue), (Reference::Raw, true, -0.5, Some(Side::Sell), Some(Venue::Spot)));
        assert_eq!(x.account.as_deref(), Some("a"));
        assert!(q(&[("ref", "x")]).is_err());
        assert!(q(&[("side", "both")]).is_err());
        assert!(q(&[("h", "ten")]).is_err());
    }

    #[test]
    fn moments_mean_se_and_adverse() {
        let mut m = Mom::default();
        for x in [1.0, -1.0, 3.0, 5.0] {
            m.add(x, 1.0);
        }
        assert_relative_eq!(m.mean().unwrap(), 2.0);
        // sample sd of [1, -1, 3, 5] is sqrt(20 / 3); se = sd / 2
        assert_relative_eq!(m.se().unwrap(), (20.0f64 / 3.0).sqrt() / 2.0, max_relative = 1e-12);
        assert_relative_eq!(m.adverse().unwrap(), 0.25);
        let mut one = Mom::default();
        one.add(4.0, 2.0);
        assert_eq!((one.mean(), one.se()), (Some(4.0), None));
    }

    fn market() -> Market {
        let mut info = Info::new();
        info.insert(Venue::Spot, Default::default());
        info.insert(Venue::Usdm, Default::default());
        Market::new(info, 120.0, 100.0)
    }

    /// A buy at 100 whose instrument's mid walks 100.2 (before) -> 100.1 (at) -> 100.0 (after), the reference
    /// flat at 50 until 2 s after the fill, then +2 bps.
    fn book() -> (Market, FillBook) {
        let mut m = market();
        let x = m.ensure("XUSDT", Venue::Spot, Some(("XUSDT", Venue::Usdm)));
        m.keep_fine(x); // a configured market: kept from the start
        let mut fb = FillBook::new();
        let t0 = 100_000;
        for (dt, s, r) in [(-20_000, 100.2, 50.0), (-300, 100.1, 50.0), (1_500, 100.0, 50.0), (2_500, 100.0, 50.01)] {
            m.on_book(Venue::Usdm, &BookTicker::new("XUSDT", r, r, Some(t0 + dt)));
            m.on_book(Venue::Spot, &BookTicker::new("XUSDT", s, s, Some(t0 + dt)));
        }
        fb.add(&mut m, crate::fills::FillRec::new("a", t0, "acct", "XUSDT", Venue::Spot, Side::Buy, 100.0, 2.0), true);
        fb.mature(&m, t0 + 302_000);
        (m, fb)
    }

    #[test]
    fn path_matches_the_markouts_and_reads_before_the_fill() {
        let (_m, fb) = book();
        let f = fb.get("a").unwrap();
        // at 1, 10, 60, 300 s the path equals the fill's own markouts
        for (h, j) in PATH_OF_H.iter().enumerate() {
            let (raw, net, fast, _) = f.path_at(*j).unwrap();
            assert_relative_eq!(raw, f.mk_raw.0[h].unwrap(), max_relative = 1e-12);
            assert_relative_eq!(net, f.mk.0[h].unwrap(), max_relative = 1e-12);
            assert_relative_eq!(fast, f.mk_fast.0[h].unwrap(), max_relative = 1e-12);
        }
        // 10 s and 0.5 s before: mid 100.2 against a buy at 100 = +20 bps; at the fill, at ms resolution, the
        // 100.1 of 0.3 s before: +10 bps
        assert_relative_eq!(f.path_at(0).unwrap().0, 20.0, max_relative = 1e-9);
        assert_relative_eq!(f.path_at(4).unwrap().0, 20.0, max_relative = 1e-9);
        assert_relative_eq!(f.path_at(5).unwrap().0, 10.0, max_relative = 1e-9);
        // 2 s after the reference has not moved: D = 0; at 300 s it is up 2 bps, toward a buy: D = -2
        assert_relative_eq!(f.path_at(9).unwrap().3.unwrap(), 0.0, epsilon = 1e-9);
        assert_relative_eq!(f.path_at(16).unwrap().3.unwrap(), -2.0, max_relative = 1e-6);
    }

    #[test]
    fn report_filters_weights_and_buckets() {
        let (_m, mut fb) = book();
        let mut s = crate::fills::FillRec::new("b", 200_000, "other", "YUSDT", Venue::Spot, Side::Sell, 10.0, 1.0);
        s.pm = [Some(9.999); PATH_N]; // a sell at 10 that the mid stays 1 bp under: +1 bps everywhere
        s.edge_bps = Some(3.0);
        fb.fills.push(s);
        let fills = &fb.fills;
        let r = report(fills, &q(&[]).unwrap(), 1_000_000, 0);
        assert_eq!(r.fills, 2);
        assert_eq!(r.horizons_s.len(), PATH_N);
        assert_eq!(r.all.n[16], 2);
        assert_eq!((r.buy.n[16], r.sell.n[16]), (1, 1));
        assert_relative_eq!(r.sell.mean[0].unwrap(), 1.0, max_relative = 1e-9);
        // notional weights: the buy (200 USDT) against the sell (10 USDT, +1 bps)
        let buy300 = r.buy.mean[16].unwrap();
        assert_relative_eq!(r.all.mean[16].unwrap(), (buy300 * 200.0 + 10.0) / 210.0, max_relative = 1e-9);
        let rf = report(fills, &q(&[("weight", "fill")]).unwrap(), 1_000_000, 0);
        assert_relative_eq!(rf.all.mean[16].unwrap(), (buy300 + 1.0) / 2.0, max_relative = 1e-9);
        // side and account filters
        let rs = report(fills, &q(&[("side", "sell")]).unwrap(), 1_000_000, 0);
        assert_eq!((rs.fills, rs.by_instrument.len(), rs.all.n[16]), (1, 1, 2));
        assert_relative_eq!(rs.edge.unwrap(), 3.0);
        assert_eq!(report(fills, &q(&[("account", "acct")]).unwrap(), 1_000_000, 0).fills, 1);
        // buckets: 15 min from the day start, both fills in the first
        assert_eq!(r.by_time.len(), 2);
        assert_eq!((r.by_time[0].t, r.by_time[0].fills, r.by_time[1].t), (0, 2, BUCKET_MS));
        // instruments by notional; the distribution at 10 s holds both
        assert_eq!(r.by_instrument[0].symbol, "XUSDT");
        assert_eq!(r.dist.n, 2);
        assert_relative_eq!(r.dist.bins.iter().sum::<f64>(), 1.0, max_relative = 1e-9);
    }

    #[test]
    fn dist_bins_and_quantiles() {
        let xs: Vec<(f64, f64)> = (0..100).map(|i| (i as f64 / 10.0 - 5.0, 1.0)).collect();
        let d = dist(xs, J10);
        assert_eq!(d.n, 100);
        assert_relative_eq!(d.mean.unwrap(), -0.05, epsilon = 1e-9);
        assert_relative_eq!(d.median.unwrap(), -0.1, epsilon = 1e-9);
        assert!(d.width > 0.0 && d.bins.len() > 10 && d.bins.len() <= 80);
        assert!(d.lo <= -4.9);
        assert_relative_eq!(d.bins.iter().sum::<f64>(), 1.0, max_relative = 1e-9);
        assert_eq!(nice_width(10.0, 36.0), 0.5);
    }
}
