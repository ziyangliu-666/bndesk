//! Backfill of the P&L grid's gaps from 1 min klines, and M_k(D) for names held at the day start.
//!
//! Requests are few (only names with inventory or fills in a gap, at most 1000 bars each) and paced well
//! under the weight governor's share, so the backfill never bursts on an IP shared with trading.
use std::cell::RefCell;
use std::collections::HashMap;
use std::rc::Rc;
use std::time::Duration;

use tokio::time::sleep;
use tracing::{info, warn};

use crate::binance::rest::{Rest, RestError};
use crate::market::Market;
use crate::params;
use crate::pnl::{Bars, PnlBook};

/// Request weight per minute this task may spend, per API family.
pub fn budget(venue: &str) -> f64 {
    if venue == "spot" { 300.0 } else { 120.0 }
}

pub const MAX_BARS: i64 = 1000;

pub fn kline_weight(venue: &str, limit: i64) -> i64 {
    if venue == "spot" {
        return 2;
    }
    if limit < 100 {
        1
    } else if limit < 500 {
        2
    } else if limit <= 1000 {
        5
    } else {
        10
    }
}

fn num(v: &serde_json::Value) -> anyhow::Result<f64> {
    match v {
        serde_json::Value::String(s) => Ok(s.trim().parse()?),
        serde_json::Value::Number(n) => n.as_f64().ok_or_else(|| anyhow::anyhow!("bad number")),
        _ => anyhow::bail!("bad kline field {v}"),
    }
}

/// (open time, open, close) of the 1 min bars of an instrument key ("venue:SYMBOL") opening in [start, end].
pub async fn klines(rest: &Rest, key: &str, start: i64, end: i64) -> anyhow::Result<Vec<(i64, f64, f64)>> {
    let (venue, sym) = key.split_once(':').ok_or_else(|| anyhow::anyhow!("bad key {key}"))?;
    let path = if venue == "spot" { "/api/v3/klines" } else { "/fapi/v1/klines" };
    let mut out = vec![];
    let mut t = start;
    while t <= end {
        let limit = MAX_BARS.min((end - t).div_euclid(60_000) + 1);
        let w = kline_weight(venue, limit);
        let rows: Vec<Vec<serde_json::Value>> = rest
            .get(path, &params! {"symbol" => sym, "interval" => "1m", "startTime" => t, "endTime" => end, "limit" => limit}, w, false)
            .await?;
        sleep(Duration::from_secs_f64(w as f64 * 60.0 / budget(venue))).await;
        for r in &rows {
            let ot = r.first().and_then(|x| x.as_i64()).ok_or_else(|| anyhow::anyhow!("bad kline"))?;
            let o = num(r.get(1).ok_or_else(|| anyhow::anyhow!("short kline"))?)?;
            let c = num(r.get(4).ok_or_else(|| anyhow::anyhow!("short kline"))?)?;
            out.push((ot, o, c));
        }
        if (rows.len() as i64) < limit {
            break;
        }
        t = out.last().map_or(end, |x| x.0) + 60_000;
    }
    Ok(out)
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

async fn work(book: &impl BookAccess, rest: &Rest, on_booked: &mut impl FnMut()) -> anyhow::Result<()> {
    while let Some((g, plan)) = book.with(|b, m| b.gaps.first().cloned().map(|g| {
        let p = b.plan(m, &g);
        (g, p)
    })) {
        let mut bars = HashMap::new();
        for (key, lo, hi) in &plan.fetch {
            bars.insert(key.clone(), Bars::new(klines(rest, key, *lo, *hi).await?));
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
        let rows = klines(rest, &key, ds, ds).await?;
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
    Ok(())
}

/// Works the book's gap queue, then fetches M_k(D) still missing; retries on errors, backs off on 418 / 429.
pub async fn run(book: impl BookAccess, rest: Rest, mut on_booked: impl FnMut()) {
    loop {
        sleep(Duration::from_secs(5)).await;
        if !book.with(|b, _| b.started()) {
            continue;
        }
        if let Err(e) = work(&book, &rest, &mut on_booked).await {
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

    #[test]
    fn kline_weights() {
        assert_eq!(kline_weight("spot", 1000), 2);
        assert_eq!((kline_weight("usdm", 99), kline_weight("usdm", 100), kline_weight("usdm", 500)), (1, 2, 5));
        assert_eq!((kline_weight("usdm", 1000), kline_weight("usdm", 1001)), (5, 10));
    }
}
