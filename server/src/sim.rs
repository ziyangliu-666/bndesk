//! Simulated accounts on top of real public market data: run the full UI without keys.
//!
//! Two spot market makers quote around fair (reference mid x EWMA ratio) and get maker fills when the
//! real book trades through their quote, or with a probability that grows with the real mid move; a
//! third account keeps a futures position offsetting the spot inventory. Markouts come from the real
//! mids that follow.
use std::collections::HashMap;
use std::time::Duration;

use rand::rngs::StdRng;
use rand::{Rng, SeedableRng};

use crate::accounts::{Account, AccountRef, MarketRef, OnFill, Open, Transfer, TransfersRef};
use crate::app::Desk;
use crate::binance::rest::CLOCK;
use crate::config::{AccountCfg, MarketCfg, Ref};
use crate::feeds::now_ms;
use crate::fills::FillRec;
use crate::protocol::{Role, Side, Venue};

pub const SYMBOLS: [&str; 12] = ["BTCUSDT", "ETHUSDT", "SOLUSDT", "BNBUSDT", "XRPUSDT", "DOGEUSDT",
                                 "ADAUSDT", "LINKUSDT", "AVAXUSDT", "LTCUSDT", "TRXUSDT", "SUIUSDT"];
pub const CLIP_USD: f64 = 60.0;
pub const SPOT_MAKER: f64 = 0.0001;
pub const SPOT_TAKER: f64 = 0.0002;
pub const FUT_MAKER: f64 = 0.0002;
pub const FUT_TAKER: f64 = 0.0005;
pub const FUT_WALLET: f64 = 6_000.0;

fn start(id: &str) -> f64 {
    match id {
        "master" => 20_000.0,
        "sub-1" | "sub-2" => 6_000.0,
        _ => 0.0,
    }
}

pub fn markets() -> Vec<MarketCfg> {
    SYMBOLS
        .iter()
        .map(|s| {
            let mut m = MarketCfg::new(*s, Venue::Spot);
            m.reference = Some(Ref { symbol: s.to_string(), venue: Venue::Usdm });
            m
        })
        .collect()
}

pub fn accounts() -> Vec<Account> {
    let mut out = vec![];
    for (aid, role, label, fut) in [("master", Role::Master, "master", false), ("sub-1", Role::Sub, "sim mm 1", false),
                                    ("sub-2", Role::Sub, "sim mm 2", false), ("sub-3", Role::Sub, "sim futures", true)] {
        let mut c = AccountCfg::new(aid, label, &format!("{aid}@sim.invalid"), role);
        c.futures = fut;
        let a = Account::new(c, None, "");
        for f in a.feeds.iter().chain([&a.rest_feed]) {
            f.borrow_mut().set_up(true, Some("simulated"));
        }
        out.push(a);
    }
    out
}

/// Python's `float(f"{x:.4g}")`.
fn g4(x: f64) -> f64 {
    format!("{x:.3e}").parse().unwrap_or(x)
}

fn qty(price: f64) -> f64 {
    g4(CLIP_USD / price)
}

pub struct Sim {
    accounts: Vec<AccountRef>,
    by_id: HashMap<String, AccountRef>,
    makers: [AccountRef; 2],
    fut: AccountRef,
    market: MarketRef,
    transfers: TransfersRef,
    on_fill: OnFill,
    target_ratio: Option<f64>,
    asset_cap_usd: f64,
    rng: StdRng,
    quote_bps: HashMap<(String, String), f64>,
    cool: HashMap<(String, String), i64>,
    last_mid: HashMap<String, f64>,
    seq: u64,
    burst_until: i64,
}

impl Sim {
    pub fn new(desk: &Desk) -> Self {
        let by_id: HashMap<String, AccountRef> = desk.accounts.iter().map(|a| (a.borrow().id.clone(), a.clone())).collect();
        Sim {
            accounts: desk.accounts.clone(),
            makers: [by_id["sub-1"].clone(), by_id["sub-2"].clone()],
            fut: by_id["sub-3"].clone(),
            by_id,
            market: desk.market.clone(),
            transfers: desk.transfers.clone(),
            on_fill: desk.on_fill.clone(),
            target_ratio: desk.cfg.target_ratio,
            asset_cap_usd: desk.cfg.alerts.asset_cap_usd,
            rng: StdRng::from_os_rng(),
            quote_bps: HashMap::new(),
            cool: HashMap::new(),
            last_mid: HashMap::new(),
            seq: 0,
            burst_until: 0,
        }
    }

    /// Initial balances, then replay today's reloaded fills and transfers so restarts stay consistent.
    pub fn setup(&mut self, desk: &Desk) {
        for a in &self.accounts {
            let mut a = a.borrow_mut();
            let s = start(&a.id);
            a.set_balances([("USDT", s, 0.0)], true);
            (a.spot_loaded, a.fut_loaded) = (true, true);
            (a.orders_10s_limit, a.orders_1d_limit) = (100, 200_000);
            a.set_fee(Venue::Spot, "*", SPOT_MAKER, SPOT_TAKER);
        }
        {
            let mut f = self.fut.borrow_mut();
            (f.fut_wallet, f.fut_available) = (FUT_WALLET, FUT_WALLET);
            f.set_fee(Venue::Usdm, "*", FUT_MAKER, FUT_TAKER);
        }
        self.by_id["sub-2"].borrow_mut().set_balances([("DOT", 0.5, 0.0)], false);   // a dust lot, discovered from the balance
        let fills: Vec<FillRec> = desk.fills.borrow().fills.iter().filter(|f| f.id.starts_with("sim")).cloned().collect();
        for f in fills {
            self.seq += 1;
            if let Some(a) = self.by_id.get(&f.account).cloned() {
                self.book(&a, &f);
            }
        }
        let recs: Vec<Transfer> = self.transfers.borrow().records.values().cloned().collect();
        for r in recs {
            self.move_(&r.frm, &r.to, &r.asset, r.amount);
        }
    }

    fn move_(&self, frm: &str, to: &str, asset: &str, amt: f64) {
        for (email, sgn) in [(frm, -1.0), (to, 1.0)] {
            if let Some(a) = self.accounts.iter().find(|a| a.borrow().email == email) {
                let mut a = a.borrow_mut();
                let (f, l) = a.balances.get(asset).copied().unwrap_or((0.0, 0.0));
                a.set_balances([(asset, f + sgn * amt, l)], false);
            }
        }
    }

    fn book(&self, a: &AccountRef, f: &FillRec) {
        let sgn = if f.side == Side::Buy { 1.0 } else { -1.0 };
        if f.venue == Venue::Spot {
            let base = {
                let mut m = self.market.borrow_mut();
                let i = m.ensure(&f.symbol, Venue::Spot, None);
                m.insts[i].base.clone()
            };
            let mut a = a.borrow_mut();
            let (q, _) = a.balances.get(&base).copied().unwrap_or((0.0, 0.0));
            let (u, _) = a.balances.get("USDT").copied().unwrap_or((0.0, 0.0));
            a.set_balances([(base.as_str(), (q + sgn * f.qty).max(0.0), 0.0), ("USDT", u - sgn * f.notional() - f.fee, 0.0)], false);
        } else {
            let mut a = a.borrow_mut();
            let (amt, mut entry) = a.positions.get(&f.symbol).copied().unwrap_or((0.0, 0.0));
            let q = sgn * f.qty;
            let new = amt + q;
            if amt == 0.0 || (amt > 0.0) == (q > 0.0) {
                entry = (entry * amt.abs() + f.price * f.qty) / new.abs();
            } else {
                a.fut_wallet += amt.abs().min(f.qty) * (f.price - entry) * if amt > 0.0 { 1.0 } else { -1.0 };
                if new != 0.0 && (new > 0.0) != (amt > 0.0) {
                    entry = f.price;
                }
            }
            a.fut_wallet -= f.fee;
            a.set_position(&f.symbol, new, if new != 0.0 { entry } else { 0.0 }, None, 0);
        }
    }

    #[allow(clippy::too_many_arguments)]
    fn fill(&mut self, a: &AccountRef, symbol: &str, venue: Venue, t: Option<i64>, side: Side, price: f64, q: f64, maker: bool) {
        self.seq += 1;
        let fee_rate = match (venue, maker) {
            (Venue::Spot, true) => SPOT_MAKER,
            (Venue::Spot, false) => SPOT_TAKER,
            (Venue::Usdm, true) => FUT_MAKER,
            (Venue::Usdm, false) => FUT_TAKER,
        };
        let id = a.borrow().id.clone();
        let mut f = FillRec::new(format!("sim:{id}:{venue}:{symbol}:{}:{}", CLOCK.now(), self.seq), t.unwrap_or_else(|| CLOCK.now()),
                                 id, symbol, venue, side, price, q);
        f.fee = price * q * fee_rate;
        f.fee_asset = "USDT".into();
        f.maker = maker;
        self.book(a, &f);
        (self.on_fill)(f);
    }

    fn maker_step(&mut self, now: i64) {
        let cap = self.asset_cap_usd * 0.45;
        for s in SYMBOLS {
            let (fair, mid, ibid, iask, base, min_notional, t) = {
                let m = self.market.borrow();
                let Some(i) = m.find(s, Venue::Spot) else { continue };
                let inst = &m.insts[i];
                (m.fair(i), inst.mid(), inst.bid, inst.ask, inst.base.clone(), inst.min_notional, inst.t)
            };
            let (Some(fair), Some(mid)) = (fair.filter(|x| *x != 0.0), mid) else { continue };
            let prev = self.last_mid.get(s).copied().unwrap_or(mid);
            self.last_mid.insert(s.to_string(), mid);
            let move_bps = (mid - prev) / prev * 1e4;
            for a in self.makers.clone() {
                let k = (a.borrow().id.clone(), s.to_string());
                if self.rng.random::<f64>() < 0.01 || !self.quote_bps.contains_key(&k) {
                    let v = self.rng.random_range(1.0..5.0);
                    self.quote_bps.insert(k.clone(), v);
                }
                let d = self.quote_bps[&k] / 1e4;
                let (bid, ask) = (fair * (1.0 - d), fair * (1.0 + d));
                Self::quotes(&a, s, bid, ask);
                if now < self.cool.get(&k).copied().unwrap_or(0) {
                    continue;
                }
                let (held, usdt) = {
                    let ab = a.borrow();
                    (ab.balances.get(&base).map_or(0.0, |x| x.0), ab.balances.get("USDT").map_or(0.0, |x| x.0))
                };
                let p = 0.004 + 0.03 * move_bps.abs().min(10.0);
                let side = if iask <= bid || (move_bps < 0.0 && self.rng.random::<f64>() < p) {
                    Some(Side::Buy)
                } else if ibid >= ask || (move_bps > 0.0 && self.rng.random::<f64>() < p) {
                    Some(Side::Sell)
                } else if self.rng.random::<f64>() < 0.002 {
                    Some(if self.rng.random_bool(0.5) { Side::Buy } else { Side::Sell })
                } else {
                    None
                };
                if side == Some(Side::Buy) && held * mid < cap && usdt > CLIP_USD * 2.0 {
                    self.fill(&a, s, Venue::Spot, t, Side::Buy, bid, qty(bid), true);
                } else if side == Some(Side::Sell) && held * mid > min_notional {
                    let q = qty(ask);
                    self.fill(&a, s, Venue::Spot, t, Side::Sell, ask, if (held - q) * mid < min_notional { held } else { q }, true);
                } else {
                    continue;
                }
                let c = now + self.rng.random_range(1500..=6000);
                self.cool.insert(k, c);
            }
        }
    }

    fn quotes(a: &AccountRef, symbol: &str, bid: f64, ask: f64) {
        let mut a = a.borrow_mut();
        let id = a.id.clone();
        a.open.insert(format!("spot:{id}:{symbol}:b"), Open { symbol: symbol.into(), venue: Venue::Spot, side: Side::Buy, price: bid, left: qty(bid) });
        a.open.insert(format!("spot:{id}:{symbol}:a"), Open { symbol: symbol.into(), venue: Venue::Spot, side: Side::Sell, price: ask, left: qty(ask) });
        a.traded.insert(format!("spot:{symbol}"));
    }

    fn hedge_step(&mut self) {
        let ratio = self.target_ratio.filter(|r| *r != 0.0).unwrap_or(1.0);
        for s in SYMBOLS {
            let (base, fbid, fask, ft) = {
                let m = self.market.borrow();
                let (Some(sp), Some(fu)) = (m.find(s, Venue::Spot), m.find(s, Venue::Usdm)) else { continue };
                let fu = &m.insts[fu];
                if fu.mid().is_none() {
                    continue;
                }
                (m.insts[sp].base.clone(), fu.bid, fu.ask, fu.t)
            };
            let held: f64 = self.makers.iter().map(|a| a.borrow().balances.get(&base).map_or(0.0, |x| x.0)).sum();
            let amt = self.fut.borrow().positions.get(s).map_or(0.0, |x| x.0);
            let gap = -ratio * held - amt;
            if gap.abs() * (fbid + fask) / 2.0 > 40.0 {
                let side = if gap > 0.0 { Side::Buy } else { Side::Sell };
                let fut = self.fut.clone();
                self.fill(&fut, s, Venue::Usdm, ft, side, if side == Side::Buy { fask } else { fbid }, g4(gap.abs()), false);
            }
        }
        let m = self.market.borrow();
        let mut f = self.fut.borrow_mut();
        let pos = f.live_positions(&m);
        let upnl: f64 = pos.iter().map(|p| p.upnl).sum();
        let margin = pos.iter().map(|p| p.notional.abs()).sum::<f64>() * 0.1;
        f.fut_available = f.fut_wallet + upnl - margin;
    }

    fn orders_step(&mut self) {
        for a in self.makers.clone() {
            if self.rng.random::<f64>() < 0.004 {
                self.burst_until = now_ms() + 15_000;
            }
            let target = if now_ms() < self.burst_until { self.rng.random_range(85.0..95.0) } else { self.rng.random_range(20.0..60.0) };
            let mut a = a.borrow_mut();
            a.orders_10s = (a.orders_10s as f64 + (target - a.orders_10s as f64) * 0.5) as i64;
            a.orders_1d += a.orders_10s / 10;
            a.updated = now_ms();
        }
    }

    pub async fn run(mut self) {
        let t0 = now_ms();
        let mut transferred = self.transfers.borrow().records.values().any(|r| r.to == "sub-1@sim.invalid");
        let mut n = 0u64;
        loop {
            tokio::time::sleep(Duration::from_millis(250)).await;
            let now = CLOCK.now();
            self.maker_step(now);
            n += 1;
            if n.is_multiple_of(4) {
                self.orders_step();
            }
            if n.is_multiple_of(8) {
                self.hedge_step();
            }
            if !transferred && now_ms() - t0 > 30_000 {
                transferred = true;
                let rec = Transfer { ts: CLOCK.now(), frm: "master@sim.invalid".into(), to: "sub-1@sim.invalid".into(),
                                     asset: "USDT".into(), amount: 1000.0 };
                self.transfers.borrow_mut().add(&format!("sim-{}", rec.ts), rec.clone());
                self.move_(&rec.frm, &rec.to, &rec.asset, rec.amount);
            }
        }
    }
}
