//! Derived state: per-instrument rows, markout stats, exposure, summary.
//!
//! Each function takes what it reads (the market borrowed once by the caller, the accounts as
//! `AccountRef`s, the config). `exposure` takes the beta-weighted spot value and the clock instant as
//! arguments, so tests can pin both.
use std::collections::{BTreeMap, HashMap, HashSet};

use crate::accounts::{Account, AccountRef, FutLeg};
use crate::beta::Betas;
use crate::config::Config;
use crate::fills::{FillRec, HK, TK, TOX_HORIZONS};
use crate::market::{Market, STABLES};
use crate::pnl::OMap;
use crate::protocol::{self as P, Side, Venue};
use crate::sessions::pause;

pub const HOUR: i64 = 3_600_000;

pub fn day_pnl(equity: f64, equity_open: f64, transfers_in: f64) -> f64 {
    equity - equity_open - transfers_in
}

/// Weighted mean accumulator.
#[derive(Debug, Clone, Copy, Default, PartialEq)]
pub struct VW {
    pub s: f64,
    pub w: f64,
}

impl VW {
    pub fn add(&mut self, v: Option<f64>, w: f64) {
        if let Some(v) = v {
            self.s += v * w;
            self.w += w;
        }
    }

    pub fn value(&self) -> Option<f64> {
        (self.w > 0.0).then(|| self.s / self.w)
    }
}

#[derive(Debug, Clone, Default)]
pub struct InstAgg {
    pub fills: i64,
    pub buys: i64,
    pub sells: i64,
    pub volume: f64,
    pub edge: VW,
    pub mk: [VW; 4],   // indexed like HK
    pub last: Option<i64>,
    pub pos: f64,
    pub cost: f64,
}

/// Running average cost of a position (no FIFO): adds average in, reductions keep it, flips reset it.
pub fn avg_cost_step(pos: f64, cost: f64, signed_qty: f64, price: f64) -> (f64, f64) {
    let new = pos + signed_qty;
    let mut cost = cost;
    if pos == 0.0 || (pos > 0.0) == (signed_qty > 0.0) {
        cost = if new != 0.0 { (cost * pos.abs() + price * signed_qty.abs()) / new.abs() } else { 0.0 };
    } else if new == 0.0 || (new > 0.0) != (pos > 0.0) {
        cost = if new != 0.0 { price } else { 0.0 };
    }
    (new, cost)
}

#[derive(Debug, Clone, Default)]
pub struct FillAgg {
    pub by_inst: HashMap<String, InstAgg>,
    pub all: [VW; 4],
    pub buys: [VW; 4],
    pub sells: [VW; 4],
    pub raw: [VW; 4],
    pub fast: [VW; 4],
    pub tox: [VW; 5],
    pub tox_n: [i64; 5],
    pub hours: HashMap<i64, (i64, VW, VW, f64)>,
    pub pnl_day: f64,
    pub volume_day: f64,
    pub fills_1h: i64,
    pub mk10_1h: VW,
    pub mk10_30m: VW,
    pub n_30m: i64,
}

const H10: usize = 1;   // HK index of "10"
const H60: usize = 2;
const H300: usize = 3;

#[allow(clippy::needless_range_loop)]
pub fn aggregate(fills: &[FillRec], now: i64) -> FillAgg {
    let mut g = FillAgg::default();
    for f in fills {
        let a = g.by_inst.entry(f.key()).or_default();
        let n = f.notional();
        a.fills += 1;
        a.volume += n;
        g.volume_day += n;
        if f.side == Side::Buy {
            a.buys += 1;
        } else {
            a.sells += 1;
        }
        a.edge.add(f.edge_bps, n);
        let side = if f.side == Side::Buy { &mut g.buys } else { &mut g.sells };
        for i in 0..HK.len() {
            let m = f.mk.0[i];
            a.mk[i].add(m, n);
            g.all[i].add(m, n);
            side[i].add(m, n);
            g.raw[i].add(f.mk_raw.0[i], n);
            g.fast[i].add(f.mk_fast.0[i], n);
        }
        for i in 0..TK.len() {
            if let Some(d) = f.tox[i] {
                g.tox[i].add(Some(d), n);
                g.tox_n[i] += 1;
            }
        }
        let p = f.pnl("60");
        g.pnl_day += p;
        a.last = Some(f.ts);
        (a.pos, a.cost) = avg_cost_step(a.pos, a.cost, if f.side == Side::Buy { f.qty } else { -f.qty }, f.price);
        let hr = f.ts.div_euclid(HOUR).rem_euclid(24);
        let hs = g.hours.entry(hr).or_insert((0, VW::default(), VW::default(), 0.0));
        hs.0 += 1;
        hs.1.add(f.mk.0[H10], n);
        hs.2.add(f.mk.0[H60], n);
        hs.3 += p;
        if f.ts >= now - HOUR {
            g.fills_1h += 1;
            g.mk10_1h.add(f.mk.0[H10], n);
        }
        if f.ts >= now - HOUR / 2 && f.mk.0[H10].is_some() {
            g.n_30m += 1;
            g.mk10_30m.add(f.mk.0[H10], n);
        }
    }
    g
}

fn vals(vs: &[VW]) -> Vec<Option<f64>> {
    vs.iter().map(VW::value).collect()
}

pub fn markout_stats(agg: &FillAgg) -> P::MarkoutStats {
    let by_hour = (0..24)
        .map(|h| {
            let (n, m10, m60, p) = agg.hours.get(&h).copied().unwrap_or_default();
            P::HourStats { hour: h, fills: n, mk10: m10.value(), mk60: m60.value(), pnl: p }
        })
        .collect();
    P::MarkoutStats {
        horizons: vec![1, 10, 60, 300],
        all: vals(&agg.all),
        buys: vals(&agg.buys),
        sells: vals(&agg.sells),
        raw: vals(&agg.raw),
        fast: vals(&agg.fast),
        by_hour,
        toxicity: P::Toxicity { horizons_s: TOX_HORIZONS.to_vec(), bps: vals(&agg.tox), fills: agg.tox_n.to_vec() },
    }
}

/// Python truthiness of an optional float: None and 0.0 are false.
fn truthy(x: Option<f64>) -> Option<f64> {
    x.filter(|v| *v != 0.0)
}

fn bps(a: Option<f64>, b: Option<f64>) -> Option<f64> {
    match (truthy(a), truthy(b)) {
        (Some(a), Some(b)) => Some((a / b - 1.0) * 1e4),
        _ => None,
    }
}

/// (bids, asks, best bid, best ask) of the resting orders on one instrument.
#[derive(Default, Clone, Copy)]
struct Quotes {
    bids: i64,
    asks: i64,
    bid: Option<f64>,
    ask: Option<f64>,
}

/// Market making over today's spot fills of the bases `tracked` takes, in USD at the instrument's own mid:
/// Σ s q (M(t + h) − p) − fee, the mid now for a fill younger than h; `spread`: the same at h = 0 against
/// the fair at the fill. By base and by UTC hour (start ms) too.
#[derive(Debug, Default)]
pub struct MmSplit {
    pub total: f64,
    pub spread: f64,
    pub by_base: HashMap<String, f64>,
    pub by_hour: HashMap<i64, f64>,
}

pub fn mm_split(m: &mut Market, fills: &[FillRec], horizon_s: i64, tracked: impl Fn(&str) -> bool) -> MmSplit {
    let h = HK.iter().position(|k| *k == horizon_s.to_string()).unwrap_or(2);
    let mut out = MmSplit::default();
    for f in fills.iter().filter(|f| f.venue == Venue::Spot) {
        let Some((base, quote, mid)) = m.get(&crate::market::key(&f.symbol, Venue::Spot)).map(|i| (i.base.clone(), i.quote.clone(), i.mid()))
        else {
            continue;
        };
        if !tracked(&base) {
            continue;
        }
        let qpx = m.asset_price(&quote).filter(|x| *x > 0.0).unwrap_or(1.0);
        let fee = if f.fee != 0.0 && !f.fee_asset.is_empty() { f.fee * m.asset_price(&f.fee_asset).unwrap_or(0.0) } else { 0.0 };
        let notional = f.notional() * qpx;
        let s = if f.side == Side::Buy { 1.0 } else { -1.0 };
        let gross = match f.mk_raw.0[h] {
            Some(bps) => notional * bps / 1e4,
            None => mid.map_or(0.0, |x| s * f.qty * (x - f.price) * qpx),
        };
        let v = gross - fee;
        out.total += v;
        out.spread += f.edge_bps.map_or(0.0, |e| notional * e / 1e4) - fee;
        *out.by_base.entry(base).or_insert(0.0) += v;
        *out.by_hour.entry(f.ts - f.ts.rem_euclid(3_600_000)).or_insert(0.0) += v;
    }
    out
}

pub fn symbol_rows(m: &mut Market, accounts: &[AccountRef], by_base: &OMap<(f64, f64, f64, f64)>, agg: &FillAgg,
                   mm: &MmSplit) -> Vec<P::SymbolRow> {
    let mut holdings: HashMap<String, f64> = HashMap::new();
    let mut dust_assets: HashSet<String> = HashSet::new();
    let mut positions: HashMap<String, f64> = HashMap::new();
    let mut quotes: HashMap<String, Quotes> = HashMap::new();
    for acct in accounts {
        let acct = acct.borrow();
        for (a, &(f, l)) in &acct.balances {
            *holdings.entry(a.clone()).or_insert(0.0) += f + l;
            if !STABLES.contains(&a.as_str())
                && f + l > 0.0
                && let Some(i) = m.asset_inst(a)
                && let Some(mid) = m.insts[i].mid()
                && (f + l) * mid < m.insts[i].min_notional
            {
                dust_assets.insert(a.clone());
            }
        }
        for (s, &(amt, _)) in &acct.positions {
            *positions.entry(s.clone()).or_insert(0.0) += amt;
        }
    }
    for acct in accounts {
        let acct = acct.borrow();
        for o in acct.open.values() {
            let q = quotes.entry(format!("{}:{}", o.venue, o.symbol)).or_default();
            if o.side == Side::Buy {
                q.bids += 1;
                q.bid = Some(truthy(q.bid).unwrap_or(0.0).max(o.price));
            } else {
                q.asks += 1;
                q.ask = Some(truthy(q.ask).unwrap_or(f64::INFINITY).min(o.price));
            }
        }
    }
    let mut ids: Vec<usize> = (0..m.insts.len()).collect();
    ids.sort_by(|&x, &y| {
        let (a, b) = (&m.insts[x], &m.insts[y]);
        (a.symbol.as_str(), a.venue.as_str()).cmp(&(b.symbol.as_str(), b.venue.as_str()))
    });
    let empty = InstAgg::default();
    let mut rows = Vec::with_capacity(ids.len());
    for id in ids {
        let (key, venue, base) = {
            let i = &m.insts[id];
            (i.key.clone(), i.venue, i.base.clone())
        };
        let own = venue == Venue::Spot && m.asset_inst(&base) == Some(id);
        let inst = &m.insts[id];
        let a = agg.by_inst.get(&key).unwrap_or(&empty);
        let mid = inst.mid();
        let rf = inst.ref_.map(|r| &m.insts[r]);
        let fair = m.fair(id);
        let (qty, dust) = if venue == Venue::Spot {
            (if own { holdings.get(&base).copied().unwrap_or(0.0) } else { 0.0 }, own && dust_assets.contains(&base))
        } else {
            (positions.get(&inst.symbol).copied().unwrap_or(0.0), false)
        };
        let q = quotes.get(&key).copied().unwrap_or_default();
        let cost = (a.pos != 0.0).then_some(a.cost);
        let (tp, hp, rp, fp) =
            if venue == Venue::Spot && own { by_base.get(&base).copied().unwrap_or((0.0, 0.0, 0.0, 0.0)) } else { (0.0, 0.0, 0.0, 0.0) };
        let px = truthy(m.px(id));
        let fair_t = truthy(fair);
        rows.push(P::SymbolRow {
            symbol: inst.symbol.clone(),
            venue,
            reference: rf.map(|r| r.key.clone()),
            mid,
            ref_mid: rf.and_then(|r| r.mid()),
            spread_bps: mid.map(|mid| (inst.ask - inst.bid) / mid * 1e4),
            basis_bps: if rf.is_some() { bps(mid, rf.and_then(|r| r.mid())) } else { None },
            inv_qty: qty,
            inv_value: px.map_or(0.0, |px| qty * px),
            avg_cost: cost,
            upnl: match (truthy(cost), mid) {
                (Some(c), Some(mid)) => Some((mid - c) * a.pos),
                _ => None,
            },
            fills_day: a.fills,
            buys_day: a.buys,
            sells_day: a.sells,
            volume_day: a.volume,
            edge_bps: a.edge.value(),
            mk10_bps: a.mk[H10].value(),
            mk60_bps: a.mk[H60].value(),
            mk300_bps: a.mk[H300].value(),
            trading_pnl: tp,
            hedged_pnl: hp,
            realized_pnl: rp,
            float_pnl: fp,
            mm_pnl: if venue == Venue::Spot && own { mm.by_base.get(&base).copied().unwrap_or(0.0) } else { 0.0 },
            inv_pnl: if venue == Venue::Spot && own { tp - mm.by_base.get(&base).copied().unwrap_or(0.0) } else { 0.0 },
            open_bids: q.bids,
            open_asks: q.asks,
            bid_dist_bps: match (truthy(q.bid), fair_t) {
                (Some(b), Some(f)) => Some((f - b) / f * 1e4),
                _ => None,
            },
            ask_dist_bps: match (truthy(q.ask), fair_t) {
                (Some(x), Some(f)) => Some((x - f) / f * 1e4),
                _ => None,
            },
            last_fill: a.last,
            dust,
            fair,
            bid: truthy(Some(inst.bid)),
            ask: truthy(Some(inst.ask)),
        });
    }
    rows
}

/// Python's Desk.account_pnl: 0 until the opening equity is known and the account is valued.
pub fn account_pnl(acct: &Account, valued: bool, equity: f64) -> f64 {
    match acct.equity_open {
        Some(eo) if valued => day_pnl(equity, eo, acct.transfers_day),
        _ => 0.0,
    }
}

fn leg_pnl(leg: &FutLeg) -> Option<f64> {
    leg.price.map(|p| p - leg.fees + leg.funding)
}

/// The account's wire row; `now` is the exchange clock (orders per 10 s are trimmed to it).
pub fn account_row(m: &mut Market, acct: &mut Account, now: i64) -> P::Account {
    let (qf, ql, inv, _) = acct.spot_parts(m);
    let pos = acct.live_positions(m);
    let eq = acct.equity(m);
    let valued = acct.valued(m);
    let eo = acct.equity_open.unwrap_or(eq);
    acct.trim_orders(now);
    let (bids, asks) = acct.resting();
    P::Account {
        id: acct.id.clone(),
        label: acct.label.clone(),
        email: acct.email.clone(),
        role: acct.role,
        equity: eq,
        equity_open: eo,
        pnl_day: account_pnl(acct, valued, eq),
        transfers_day: acct.transfers_day,
        quote_free: qf,
        quote_locked: ql,
        inventory_value: inv,
        fut_wallet: acct.fut_wallet,
        fut_upnl: acct.fut_upnl(m),
        fut_available: acct.fut_available,
        positions: pos
            .into_iter()
            .map(|p| {
                let pnl_day = leg_pnl(&acct.fut_leg(m, &p.symbol));
                P::Position { symbol: p.symbol, amt: p.amt, entry: p.entry, mark: p.mark, upnl: p.upnl, notional: p.notional, pnl_day }
            })
            .collect(),
        orders_10s: acct.orders_10s,
        orders_10s_limit: acct.orders_10s_limit,
        orders_1d: acct.orders_1d,
        orders_1d_limit: acct.orders_1d_limit,
        open_orders: acct.open.len() as i64,
        bids_notional: bids,
        asks_notional: asks,
        utilization: if qf + bids > 0.0 { bids / (qf + bids) } else { 0.0 },
        fees: acct.fee_rows(),
        user_stream: acct.user_stream(),
        updated: acct.updated,
    }
}

/// beta_value: beta_weighted_spot(..); estimate: betas are estimated (else fixed); now: exchange clock.
pub fn exposure(cfg: &Config, m: &Market, accounts: &[P::Account], beta_value: f64, estimate: bool, now: i64) -> P::Exposure {
    let by: Vec<P::AccountExposure> = accounts
        .iter()
        .map(|a| {
            let fut: f64 = a.positions.iter().map(|p| p.notional).sum();
            P::AccountExposure { account: a.id.clone(), spot_value: a.inventory_value, futures_notional: fut, net: a.inventory_value + fut }
        })
        .collect();
    let spot: f64 = by.iter().map(|b| b.spot_value).sum();
    let fut: f64 = by.iter().map(|b| b.futures_notional).sum();
    let hedges: HashSet<&str> = cfg.hedge_symbols.iter().map(String::as_str).collect();
    let hedge: f64 = accounts
        .iter()
        .flat_map(|a| a.positions.iter())
        .filter(|p| hedges.is_empty() || hedges.contains(p.symbol.as_str()))
        .map(|p| p.notional)
        .sum();
    let (mut target, mut band, mut gap) = (None, None, None);
    let off = cfg.target_ratio.and_then(|_| pause(&cfg.hedge_pauses, now));
    if let Some(ratio) = cfg.target_ratio {
        let t = if off.is_some() { 0.0 } else { -ratio * beta_value };
        target = Some(t);
        band = Some(cfg.band_usd.unwrap_or(0.0).max(cfg.band_frac * t.abs()));
        gap = Some(t - hedge);   // futures notional to trade to reach the target
    }
    let mut pos: BTreeMap<&str, f64> = BTreeMap::new();
    for a in accounts {
        for p in &a.positions {
            *pos.entry(p.symbol.as_str()).or_insert(0.0) += p.amt;
        }
    }
    let funding = pos
        .into_iter()
        .map(|(s, amt)| {
            let inst = m.get(&format!("usdm:{s}"));
            P::Funding { symbol: s.to_string(), rate: inst.and_then(|i| i.funding), next: inst.and_then(|i| i.next_funding), position: amt }
        })
        .collect();
    let (paused, paused_until) = off.map_or((None, None), |(n, u)| (Some(n), Some(u)));
    P::Exposure {
        spot_value: spot,
        futures_notional: fut,
        net: spot + fut,
        target,
        band,
        gap,
        by_account: by,
        funding,
        beta_value,
        hedge_notional: hedge,
        ratio: cfg.target_ratio,
        paused,
        paused_until,
        beta_source: if estimate { "estimate" } else { "fixed" }.into(),
        hedge_day: None,
    }
}

/// The inventory's drift today against what the futures legs made: the hedge symbols, or every futures
/// symbol held or traded today when none are configured.
pub fn hedge_day(cfg: &Config, m: &Market, accounts: &[AccountRef], ref_hedge: f64, factor_hedge: f64) -> P::HedgeDay {
    let hedges: HashSet<&str> = cfg.hedge_symbols.iter().map(String::as_str).collect();
    let mut by: BTreeMap<String, P::HedgeLeg> = BTreeMap::new();
    for a in accounts {
        let a = a.borrow();
        let mut syms: HashSet<&str> = a.fut_day.keys().map(String::as_str).collect();
        syms.extend(a.positions.iter().filter(|(_, (q, _))| *q != 0.0).map(|(s, _)| s.as_str()));
        for s in syms {
            if !hedges.is_empty() && !hedges.contains(s) {
                continue;
            }
            let l = a.fut_leg(m, s);
            let b = by.entry(s.to_string()).or_insert_with(|| P::HedgeLeg {
                symbol: s.to_string(),
                mark0: l.m0,
                mark: l.mark,
                price_pnl: Some(0.0),
                ..Default::default()
            });
            b.qty0 += l.q0;
            b.qty += l.q;
            b.mark0 = b.mark0.or(l.m0);
            b.mark = b.mark.or(l.mark);
            b.fills += l.fills;
            b.price_pnl = match (b.price_pnl, l.price) {
                (Some(x), Some(y)) => Some(x + y),
                _ => None,
            };
            b.fees += l.fees;
            b.funding += l.funding;
        }
    }
    let legs: Vec<P::HedgeLeg> = by
        .into_values()
        .map(|mut b| {
            b.pnl = b.price_pnl.map(|p| p - b.fees + b.funding);
            b
        })
        .collect();
    let price = legs.iter().map(|x| x.price_pnl).sum::<Option<f64>>();
    let fees: f64 = legs.iter().map(|x| x.fees).sum();
    let funding: f64 = legs.iter().map(|x| x.funding).sum();
    let pnl = price.map(|p| p - fees + funding);
    let ratio = |d: f64| pnl.filter(|_| d.abs() > 1e-9).map(|p| -p / d);
    P::HedgeDay {
        inventory_drift: ref_hedge,
        factor_drift: factor_hedge,
        residual_drift: ref_hedge - factor_hedge,
        hedge_pnl: pnl,
        price_pnl: price,
        fees,
        funding,
        offset_factor: ratio(factor_hedge),
        offset_total: ratio(ref_hedge),
        net: pnl.map(|p| ref_hedge + p),
        legs,
    }
}

/// Spot inventory value weighted by each market's beta (configured, or estimated against the
/// beta instrument); with markets_only, assets outside the configured spot markets are left out.
pub fn beta_weighted_spot(cfg: &Config, m: &mut Market, accounts: &[AccountRef], est: Option<&Betas>) -> f64 {
    let mut betas: HashMap<String, f64> = HashMap::new();
    for mc in &cfg.markets {
        if mc.venue != Venue::Spot {
            continue;
        }
        let k = format!("{}:{}", mc.venue, mc.symbol);
        let base = m.get(&k).map_or_else(|| mc.symbol.strip_suffix("USDT").unwrap_or(&mc.symbol).to_string(), |i| i.base.clone());
        betas.insert(base, est.map_or(mc.beta, |e| e.beta(&k)));
    }
    let mut total = 0.0;
    for acct in accounts {
        let acct = acct.borrow();
        for (a, &(f, l)) in &acct.balances {
            if STABLES.contains(&a.as_str()) || (cfg.markets_only && !betas.contains_key(a)) {
                continue;
            }
            if let Some(p) = truthy(m.asset_price(a)) {
                total += (f + l) * p * betas.get(a).copied().unwrap_or(1.0);
            }
        }
    }
    total
}

pub fn inventory_assets(m: &mut Market, accounts: &[AccountRef]) -> i64 {
    let mut held: HashMap<String, f64> = HashMap::new();
    for acct in accounts {
        for (a, &(f, l)) in &acct.borrow().balances {
            if !STABLES.contains(&a.as_str()) {
                *held.entry(a.clone()).or_insert(0.0) += f + l;
            }
        }
    }
    held.iter()
        .filter(|(a, q)| **q > 0.0 && truthy(m.asset_price(a)).is_some_and(|p| **q * p >= 1.0))
        .count() as i64
}

/// Every resting order with its distance from fair: positive = passive (bid below, ask above).
pub fn open_orders(m: &Market, accounts: &[AccountRef]) -> Vec<P::OpenOrder> {
    let mut out = vec![];
    for acct in accounts {
        let acct = acct.borrow();
        for (k, o) in &acct.open {
            let fair = m.find(&o.symbol, o.venue).and_then(|i| m.fair(i));
            let dist = truthy(fair).map(|f| if o.side == Side::Buy { f - o.price } else { o.price - f } / f * 1e4);
            out.push(P::OpenOrder {
                id: format!("{}:{k}", acct.id),
                account: acct.id.clone(),
                symbol: o.symbol.clone(),
                venue: o.venue,
                side: o.side,
                price: o.price,
                qty: o.left,
                notional: o.price * o.left,
                fair,
                dist_bps: dist,
                since: acct.open_since.get(k).copied(),
            });
        }
    }
    out.sort_by(|a, b| {
        (a.symbol.as_str(), a.side.as_str()).cmp(&(b.symbol.as_str(), b.side.as_str())).then(b.price.total_cmp(&a.price))
    });
    out
}

#[cfg(test)]
mod tests {
    //! Avg cost, day P&L, beta-weighted spot, exposure target / band / pause.
    use super::*;
    use crate::config::{AccountCfg, MarketCfg, load};
    use crate::market::{BookTicker, Info, SymbolInfo};
    use crate::protocol::Role;
    use crate::sessions::utc;
    use approx::assert_relative_eq;

    #[test]
    fn test_avg_cost() {
        let (p, c) = avg_cost_step(0.0, 0.0, 1.0, 100.0);
        let (p, c) = avg_cost_step(p, c, 1.0, 110.0);
        assert_eq!(p, 2.0);
        assert_relative_eq!(c, 105.0);
        let (p, c) = avg_cost_step(p, c, -1.0, 120.0);
        assert_eq!(p, 1.0);
        assert_relative_eq!(c, 105.0);
        let (p, c) = avg_cost_step(p, c, -3.0, 90.0);
        assert_eq!((p, c), (-2.0, 90.0));
    }

    #[test]
    fn test_day_pnl_excludes_transfers() {
        // equity 10_000 at open, 1000 transferred in, 700 net in: +40 of trading
        assert_relative_eq!(day_pnl(10_740.0, 10_000.0, 700.0), 40.0, epsilon = 1e-9);
    }

    #[test]
    fn test_beta_weighted_spot_and_hedge_symbols() {
        let mut info: Info = HashMap::new();
        info.insert(Venue::Spot, HashMap::from([
            ("AAAUSDT".to_string(), SymbolInfo::new("AAA", "USDT", 0.0)),
            ("BBBUSDT".to_string(), SymbolInfo::new("BBB", "USDT", 0.0)),
        ]));
        let mut m = Market::new(info, 120.0, 50.0);
        m.ensure("AAAUSDT", Venue::Spot, None);
        m.ensure("BBBUSDT", Venue::Spot, None);
        m.on_book(Venue::Spot, &BookTicker::new("AAAUSDT", 10.0, 10.0, Some(1)));
        m.on_book(Venue::Spot, &BookTicker::new("BBBUSDT", 2.0, 2.0, Some(1)));
        let mut a = Account::new(AccountCfg::new("a", "a", "a@x.io", Role::Sub), None, "");
        a.set_balances([("USDT", 500.0, 0.0), ("AAA", 3.0, 1.0), ("BBB", 10.0, 0.0)], true);
        let accounts = vec![a.shared()];
        let mut cfg = Config::default();
        let mut mc = MarketCfg::new("AAAUSDT", Venue::Spot);
        mc.beta = 1.5;
        cfg.markets = vec![mc];
        cfg.markets_only = false;
        // AAA 40 USD at beta 1.5, BBB 20 USD at the default beta 1, quote excluded
        assert_relative_eq!(beta_weighted_spot(&cfg, &mut m, &accounts, None), 80.0, epsilon = 1e-9);
        cfg.markets_only = true;   // BBB is not a configured market
        assert_relative_eq!(beta_weighted_spot(&cfg, &mut m, &accounts, None), 60.0, epsilon = 1e-9);
    }

    #[test]
    fn test_exposure_target_band_and_pause() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("d.toml");
        std::fs::write(&p, "[exposure]\ntarget_ratio = 1.0\nband_usd = 200\nband_frac = 0.25\nhedge_symbols = [\"HUSDT\"]\n\
            [[exposure.pauses]]\nname = \"hedge off\"\ntz = \"Europe/London\"\nstart = \"fri 21:00\"\nend = \"sun 21:00\"\n\
            [[markets]]\nsymbol = \"AAAUSDT\"\nbeta = 1.0\n").unwrap();
        let cfg = load(&p).unwrap();
        let acct = P::Account {
            id: "a".into(),
            inventory_value: 1000.0,
            positions: vec![P::Position { symbol: "HUSDT".into(), notional: -700.0, amt: -1.0, ..Default::default() }],
            ..Default::default()
        };
        let m = Market::new(HashMap::new(), 120.0, 50.0);
        let accts = [acct];
        let e = exposure(&cfg, &m, &accts, 1000.0, false, utc(2026, 10, 5, 6, 0));
        assert_relative_eq!(e.target.unwrap(), -1000.0);
        assert_relative_eq!(e.gap.unwrap(), -300.0);
        assert_relative_eq!(e.band.unwrap(), 250.0);
        assert!(e.paused.is_none());
        assert_eq!(e.beta_source, "fixed");
        assert_eq!(exposure(&cfg, &m, &accts, 400.0, false, utc(2026, 10, 5, 6, 0)).band, Some(200.0));   // the floor
        let e = exposure(&cfg, &m, &accts, 400.0, false, utc(2026, 10, 10, 12, 0));   // Saturday
        assert_eq!(e.target, Some(0.0));
        assert_relative_eq!(e.gap.unwrap(), 700.0);
        assert_eq!(e.paused.as_deref(), Some("hedge off"));
        assert_eq!(e.paused_until, Some(utc(2026, 10, 11, 20, 0)));
    }

    #[test]
    fn hedge_day_sums_legs() {
        let m = Market::new(HashMap::new(), 120.0, 50.0);
        let cfg = Config::default();
        let h = hedge_day(&cfg, &m, &[], 10.0, 4.0);
        assert_eq!((h.residual_drift, h.hedge_pnl, h.price_pnl, h.net), (6.0, Some(0.0), Some(0.0), Some(10.0)));
        assert_eq!((h.offset_factor, h.offset_total), (Some(-0.0), Some(-0.0)));
        assert!(h.legs.is_empty());
    }
}
