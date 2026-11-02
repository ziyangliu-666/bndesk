//! Backfill of the P&L grid's gaps from 1 min bars, M_k(D) for names held at the day start, and the
//! fills' marks the desk did not take live (it was down at t + h).
//!
//! Requests are few (only names with inventory or fills in a gap, at most 1000 bars each) and paced well
//! under the weight governor's share, so the backfill never bursts on an IP shared with trading.
use std::cell::RefCell;
use std::collections::{BTreeMap, HashMap};
use std::future::Future;
use std::rc::Rc;
use std::time::Duration;

use tokio::time::sleep;
use tracing::{info, warn};

use crate::connector::{Exchanges, RestError};
use crate::fills::{FillBook, HORIZONS};
use crate::market::Market;
use crate::pnl::{Bars, PnlBook};
use crate::protocol::Venue;

/// Bars a window of prices asks for at most.
pub const MAX_BARS: i64 = 1000;

/// Where backfilled prices come from: a connector, a mock in the tests.
pub trait Prices {
    /// (open time, open, close) of the bars of `interval` ("1s", "1m") of `key` opening in [start, end].
    fn bars(&self, key: &str, interval: &str, start: i64, end: i64) -> impl Future<Output = anyhow::Result<Vec<(i64, f64, f64)>>>;
    /// The price of the first aggregate trade of `key` at or after `t` (within a minute).
    fn trade_at(&self, key: &str, t: i64) -> impl Future<Output = anyhow::Result<Option<f64>>>;
}

/// The market of a key ("venue:SYMBOL").
fn venue_of(key: &str) -> Option<Venue> {
    key.split_once(':').and_then(|(v, _)| v.parse().ok())
}

/// Each key asked of its market's connector: a market this desk does not read has no prices.
impl Prices for Exchanges {
    async fn bars(&self, key: &str, interval: &str, start: i64, end: i64) -> anyhow::Result<Vec<(i64, f64, f64)>> {
        match venue_of(key).and_then(|v| self.of(v)) {
            Some(c) => c.bars(key, interval, start, end).await,
            None => Ok(vec![]),
        }
    }

    async fn trade_at(&self, key: &str, t: i64) -> anyhow::Result<Option<f64>> {
        match venue_of(key).and_then(|v| self.of(v)) {
            Some(c) => c.trade_at(key, t).await,
            None => Ok(None),
        }
    }
}

/// A request the exchange refuses as such (an unknown symbol, an interval it does not have) has no data, for good.
pub(crate) fn none_on_400<T: Default>(r: anyhow::Result<T>) -> anyhow::Result<T> {
    match r {
        Err(e) if e.downcast_ref::<RestError>().is_some_and(|re| re.status == 400) => Ok(T::default()),
        r => r,
    }
}

/// The close of the last 1 s bar opening at or before t's second: the price as the 1 s mid ring takes it
/// (its last mid in that second). `bars` sorted by open time.
pub fn close_at(bars: &[(i64, f64, f64)], t: i64) -> Option<f64> {
    let s = t.div_euclid(1000) * 1000;
    let i = bars.partition_point(|b| b.0 <= s);
    (i > 0).then(|| bars[i - 1].2)
}

/// The price at t inside 1 min bars: open → close of the minute holding t, linearly. The open is the minute's
/// first trade and the close its last, so the line is the expected path between them (a Brownian bridge's
/// mean); a minute with no bar keeps the close before it. `bars` sorted by open time.
pub fn interp_at(bars: &[(i64, f64, f64)], t: i64) -> Option<f64> {
    let i = bars.partition_point(|b| b.0 <= t);
    let (ot, o, c) = *bars.get(i.checked_sub(1)?)?;
    Some(if t - ot < 60_000 { o + (c - o) * (t - ot) as f64 / 60_000.0 } else { c })
}

/// A price backfilled at some time: from 1 s bars or a trade (`fine`), or from 1 min bars.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Px {
    pub v: f64,
    pub fine: bool,
}

/// The prices of `key` at times `ts` (sorted): a market with 1 s bars from those in windows of MAX_BARS seconds, else
/// from 1 min bars; a market without them from the first trade at or after each time.
pub async fn prices_at(src: &impl Prices, key: &str, ts: &[i64]) -> anyhow::Result<Vec<Option<Px>>> {
    let mut out = vec![None; ts.len()];
    let second_bars = venue_of(key).is_some_and(|v| v.market().second_bars);
    if !second_bars {
        for (k, &t) in ts.iter().enumerate() {
            out[k] = none_on_400(src.trade_at(key, t).await)?.map(|v| Px { v, fine: true });
        }
        return Ok(out);
    }
    let mut k = 0;
    while k < ts.len() {
        let start = ts[k].div_euclid(1000) * 1000;
        let end = start + (MAX_BARS - 1) * 1000;
        let n = ts[k..].partition_point(|&t| t < end + 1000);
        let bars = none_on_400(src.bars(key, "1s", start, end).await)?;
        if bars.is_empty() {
            let (a, b) = (start.div_euclid(60_000) * 60_000, ts[k + n - 1]);
            let mins = none_on_400(src.bars(key, "1m", a, b).await)?;
            for (o, &t) in out[k..k + n].iter_mut().zip(&ts[k..k + n]) {
                *o = interp_at(&mins, t).map(|v| Px { v, fine: false });
            }
        } else {
            for (o, &t) in out[k..k + n].iter_mut().zip(&ts[k..k + n]) {
                *o = close_at(&bars, t).map(|v| Px { v, fine: true });
            }
        }
        k += n;
    }
    Ok(out)
}

/// Access to the fills and the market for one synchronous step (never held across an await).
pub trait FillAccess {
    fn with_fills<R>(&self, f: impl FnOnce(&mut FillBook, &Market) -> R) -> R;
}

impl FillAccess for (Rc<RefCell<FillBook>>, Rc<RefCell<Market>>) {
    fn with_fills<R>(&self, f: impl FnOnce(&mut FillBook, &Market) -> R) -> R {
        f(&mut self.0.borrow_mut(), &self.1.borrow())
    }
}

/// Backfill the marks due and missing at `now`: the instruments' prices at t + h first (what market making
/// needs), then the references' for the net marks. A 1 min price stands only for h >= 60 s (at 1 or 10 s the
/// minute's path is no estimate); a horizon no source prices is marked so and not asked again. Returns the
/// marks booked.
pub async fn backfill_marks(fills: &impl FillAccess, src: &impl Prices, now: i64) -> anyhow::Result<usize> {
    backfill_marks_with(fills, src, now, true).await
}

/// As `backfill_marks`; without `refs`, only the instruments' prices (what market making needs), not the
/// references' for the net marks.
pub async fn backfill_marks_with(fills: &impl FillAccess, src: &impl Prices, now: i64, refs: bool) -> anyhow::Result<usize> {
    let mut booked = 0;
    for phase in [false, true] {
        if phase && !refs {
            break;
        }
        let needs = fills.with_fills(|fb, m| if phase { fb.ref_needs(m) } else { fb.mark_needs(now) });
        // key -> (time, fill id, horizon), each key's times sorted
        let mut by_key: BTreeMap<String, Vec<(i64, String, usize)>> = BTreeMap::new();
        for n in needs {
            for &j in &n.js {
                by_key.entry(n.key.clone()).or_default().push((n.ts + HORIZONS[j] * 1000, n.id.clone(), j));
            }
        }
        for (key, mut pts) in by_key {
            pts.sort();
            let px = if key.is_empty() {
                vec![None; pts.len()]
            } else {
                prices_at(src, &key, &pts.iter().map(|p| p.0).collect::<Vec<_>>()).await?
            };
            let got = fills.with_fills(|fb, _| {
                let mut got = 0;
                for ((_, id, j), px) in pts.iter().zip(px) {
                    let v = px.filter(|p| p.fine || HORIZONS[*j] >= 60).map(|p| p.v);
                    if phase {
                        fb.backfill_net(id, *j, v);
                    } else {
                        fb.backfill_raw(id, *j, v);
                    }
                    got += v.is_some() as usize;
                }
                got
            });
            booked += got;
            info!("backfilled {got} of {} {} from {}", pts.len(), if phase { "reference marks" } else { "fill marks" },
                  if key.is_empty() { "nowhere (no reference)" } else { key.as_str() });
        }
    }
    Ok(booked)
}

/// Access to the book and the market for one synchronous step (never held across an await).
pub trait BookAccess {
    fn with<R>(&self, f: impl FnOnce(&mut PnlBook, &mut Market) -> R) -> R;
}

impl BookAccess for (Rc<RefCell<PnlBook>>, Rc<RefCell<Market>>) {
    fn with<R>(&self, f: impl FnOnce(&mut PnlBook, &mut Market) -> R) -> R {
        f(&mut self.0.borrow_mut(), &mut self.1.borrow_mut())
    }
}

async fn work(book: &impl BookAccess, fills: &impl FillAccess, src: &impl Prices, now: &impl Fn() -> i64,
              on_booked: &mut impl FnMut()) -> anyhow::Result<()> {
    while let Some((g, plan)) = book.with(|b, m| b.gaps.first().cloned().map(|g| {
        let p = b.plan(m, &g);
        (g, p)
    })) {
        let mut bars = HashMap::new();
        for (key, lo, hi) in &plan.fetch {
            bars.insert(key.clone(), Bars::new(src.bars(key, "1m", *lo, *hi).await?));
        }
        let booked = book.with(|b, m| {
            if b.gaps.first().is_some_and(|x| x.id == g.id) {
                b.book_gap(m, &g, &plan, &bars);
                b.gaps.remove(0);
                true
            } else {
                false
            }
        });
        if booked {
            let only = g.only.as_ref().map_or_else(|| "all".to_string(), |o| {
                let mut v: Vec<&str> = o.iter().map(String::as_str).collect();
                v.sort();
                v.join(",")
            });
            info!("backfilled {} s ({}) for {} names with {} kline series", g.b - g.a, only, plan.names.len(), plan.fetch.len());
            on_booked();
        }
    }
    let need = book.with(|b, m| b.need_m0(m));
    for base in &need {
        let key = book.with(|b, _| match b.pos.get(base) {
            Some(p) if !b.m0.contains_key(base) => Some((p.key.clone(), b.day_start)),
            _ => None,
        });
        let Some((key, ds)) = key else { continue };
        let rows = src.bars(&key, "1m", ds, ds).await?;
        book.with(|b, _| {
            if let Some(px) = Bars::new(rows).at(b.day_start).filter(|v| *v != 0.0) {
                b.m0.insert(base.clone(), px);
            }
        });
    }
    if !need.is_empty() {
        info!("day-start prices for {} names", need.len());
        on_booked();
    }
    backfill_marks(fills, src, now()).await?;
    Ok(())
}

/// Works the book's gap queue, then fetches M_k(D) still missing, then the fills' missing marks (`now`: the
/// exchange-synced clock, ms; the fills write themselves out as changed); retries on errors, backs off on 418 / 429.
pub async fn run(book: impl BookAccess, fills: impl FillAccess, src: impl Prices, now: impl Fn() -> i64, mut on_booked: impl FnMut()) {
    loop {
        sleep(Duration::from_secs(5)).await;
        if !book.with(|b, _| b.started()) {
            continue;
        }
        if let Err(e) = work(&book, &fills, &src, &now, &mut on_booked).await {
            if let Some(re) = e.downcast_ref::<RestError>() {
                warn!("backfill: {re}");
                sleep(Duration::from_secs(if matches!(re.status, 418 | 429) { 300 } else { 60 })).await;
            } else {
                warn!("backfill: {e}");
                sleep(Duration::from_secs(60)).await;
            }
        }
        sleep(Duration::from_secs(25)).await;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    use crate::fills::{FillRec, MarkAt};
    use crate::market::Info;
    use crate::protocol::{Side, Venue};
    use approx::assert_relative_eq;

    /// Klines and trades from tables, logging each request.
    #[derive(Default)]
    struct Mock {
        secs: HashMap<String, Vec<(i64, f64, f64)>>,   // key -> 1 s bars
        mins: HashMap<String, Vec<(i64, f64, f64)>>,
        trade: HashMap<String, f64>,                  // key -> the price of every trade
        log: RefCell<Vec<String>>,
    }

    impl Prices for Mock {
        async fn bars(&self, key: &str, interval: &str, start: i64, end: i64) -> anyhow::Result<Vec<(i64, f64, f64)>> {
            self.log.borrow_mut().push(format!("{interval} {key} {start} {end}"));
            let t = if interval == "1s" { &self.secs } else { &self.mins };
            Ok(t.get(key).map(|v| v.iter().copied().filter(|b| b.0 >= start && b.0 <= end).collect()).unwrap_or_default())
        }

        async fn trade_at(&self, key: &str, t: i64) -> anyhow::Result<Option<f64>> {
            self.log.borrow_mut().push(format!("trade {key} {t}"));
            if key.ends_with("BAD") {
                return Err(RestError { status: 400, body: "{\"code\":-1121}".into() }.into());
            }
            Ok(self.trade.get(key).copied())
        }
    }

    #[test]
    fn close_and_interpolation() {
        let secs = [(0, 1.0, 1.5), (1000, 1.5, 2.0), (3000, 2.0, 3.0)];
        assert_eq!((close_at(&secs, -1), close_at(&secs, 0), close_at(&secs, 999)), (None, Some(1.5), Some(1.5)));
        assert_eq!((close_at(&secs, 1500), close_at(&secs, 2500), close_at(&secs, 9000)), (Some(2.0), Some(2.0), Some(3.0)));
        let mins = [(0, 10.0, 16.0), (120_000, 20.0, 20.0)];
        assert_eq!(interp_at(&mins, -1), None);
        assert_relative_eq!(interp_at(&mins, 30_000).unwrap(), 13.0);
        assert_eq!(interp_at(&mins, 90_000), Some(16.0));   // a minute without trades keeps the close before
    }

    #[tokio::test(flavor = "current_thread")]
    async fn prices_in_windows_with_fallbacks() {
        let mut src = Mock::default();
        src.secs.insert("spot:A".into(), (0..2000).map(|s| (s * 1000, s as f64, s as f64 + 0.5)).collect());
        src.mins.insert("spot:B".into(), vec![(0, 10.0, 16.0)]);
        src.trade.insert("usdm:A".into(), 7.0);
        let p = prices_at(&src, "spot:A", &[1_500, 900_000, 1_200_000]).await.unwrap();
        assert_eq!(p, [Some(Px { v: 1.5, fine: true }), Some(Px { v: 900.5, fine: true }), Some(Px { v: 1200.5, fine: true })]);
        // the first two in one window of 1000 bars, the third in the next
        assert_eq!(*src.log.borrow(), ["1s spot:A 1000 1000000", "1s spot:A 1200000 2199000"]);
        // no 1 s klines: the minute's line
        assert_eq!(prices_at(&src, "spot:B", &[30_000]).await.unwrap(), [Some(Px { v: 13.0, fine: false })]);
        // USD-M from trades; a symbol Binance refuses has no price (and no error)
        assert_eq!(prices_at(&src, "usdm:A", &[5]).await.unwrap(), [Some(Px { v: 7.0, fine: true })]);
        assert_eq!(prices_at(&src, "usdm:BAD", &[5]).await.unwrap(), [None]);
    }

    #[tokio::test(flavor = "current_thread")]
    async fn marks_backfilled_from_mocked_klines() {
        let mut info: Info = HashMap::new();
        info.insert(Venue::SPOT, Default::default());
        info.insert(Venue::USDM, Default::default());
        let mut market = Market::new(info, 120.0, 100.0);
        market.ensure("XUSDT", Venue::SPOT, Some(("XUSDT", Venue::USDM)));
        let mut fb = FillBook::new();
        let mut a = FillRec::new("a", 0, "acct", "XUSDT", Venue::SPOT, Side::Buy, 100.0, 1.0);   // with a reference
        a.has_ref = true;
        a.refs = [Some(50.0); 4];
        fb.add(&mut market, a, false);
        fb.add(&mut market, FillRec::new("b", 0, "acct", "YUSDT", Venue::SPOT, Side::Sell, 10.0, 1.0), false);   // 1 min klines only
        let fills = (Rc::new(RefCell::new(fb)), Rc::new(RefCell::new(market)));
        let mut src = Mock::default();
        src.secs.insert("spot:XUSDT".into(), (0..400).map(|s| (s * 1000, 100.0, 100.0 + s as f64 / 100.0)).collect());
        src.mins.insert("spot:YUSDT".into(), (0..6).map(|k| (k * 60_000, 9.0, 9.0)).collect());
        src.trade.insert("usdm:XUSDT".into(), 50.05);
        let now = 400_000;
        let n = backfill_marks(&fills, &src, now).await.unwrap();
        assert_eq!(n, 4 + 2 + 4);   // a: 4 raw + 4 net; b: 60 and 300 s from 1 min bars
        {
            let fb = fills.0.borrow();
            let a = fb.get("a").unwrap();
            assert_relative_eq!(a.mk_raw.0[2].unwrap(), 60.0, max_relative = 1e-9);   // 100.6 at t + 60 s
            assert_relative_eq!(a.mk.0[2].unwrap(), 50.0, max_relative = 1e-9);       // less the reference's +10 bps
            assert_eq!(a.bf, 0b1111);
            let b = fb.get("b").unwrap();
            assert_relative_eq!(b.mk_raw.0[2].unwrap(), 1000.0, max_relative = 1e-9);   // sold at 10, 9 after
            assert_eq!(b.mk.0[2], b.mk_raw.0[2]);
            // a minute's line is no price at 1 or 10 s: those are marked unpriceable and not asked again
            assert!(b.unpriceable(0) && b.unpriceable(1) && b.mark_at(0, now) == MarkAt::Unmarked);
        }
        src.log.borrow_mut().clear();
        assert_eq!(backfill_marks(&fills, &src, now).await.unwrap(), 0);
        assert!(src.log.borrow().is_empty());
    }
}
