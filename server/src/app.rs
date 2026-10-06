//! The desk: wiring, tick loop and shutdown.
//!
//! The desk lives in an `Rc<RefCell<Desk>>` on a current_thread `LocalSet`; the parts that
//! user-stream callbacks, the backfill and the P&L book's closures reach (market, fills, P&L book,
//! accounts, transfers, store, tracked keys) are shared `Rc`s of their own, so a callback never needs
//! the desk itself. No borrow is held across an `.await`.
use std::cell::{Cell, RefCell};
use std::collections::{HashMap, HashSet};
use std::rc::Rc;
use std::time::Duration;

use anyhow::{Context, Result};
use clap::Parser;
use serde_json::Value;
use tokio::task::JoinHandle;
use tracing::{info, warn};

use crate::accounts::{self, Account, AccountRef, MarketRef, OnFee, OnFill, Transfer, Transfers, TransfersRef};
use crate::alerts::Alerts;
use crate::backfill;
use crate::beta::Betas;
use crate::binance::rest::{CLOCK, Rest, client, governors, sync_time};
use crate::binance::sign::credentials;
use crate::binance::weight::Governors;
use crate::binance::ws::{SPOT_STREAM, StreamMux, USDM_MARKET, USDM_PUBLIC};
use crate::clock::now_s;
use crate::config::{self as C, Config};
use crate::engine::{self, EngineScraper, EngineScraperRef};
use crate::feeds::{Feed, FeedKind, FeedRef, now_ms};
use crate::fills::{FillBook, FillRec};
use crate::market::{BookTicker, Info, Inst, Market, parse_exchange_info};
use crate::metrics::{
    FillAgg, HOUR, MmSplit, account_row, aggregate, mm_split, beta_weighted_spot, exposure, hedge_day, inventory_assets, markout_stats,
    open_orders, symbol_rows,
};
use crate::pnl::{self, ALIVE_GAP_MS, ALIVE_STEP_MS, DAYS_SHOWN, PnlBook, PnlState, alive_spans};
use crate::protocol::{self as P, Role, Venue};
use crate::server::{self, DeskHealth, DeskSource, Hub, Patch};
use crate::sessions;
use crate::store::{AlertRow, EquityRow, Row, Store, TransferRow};
use crate::{auth, sim};

pub const DAY: i64 = sessions::DAY_MS;
pub const TICK_S: f64 = 0.125; // compute and push cadence
pub const TICKS_1S: u64 = 8;
/// no curve points this long after start
const WARMUP_S: f64 = 30.0;   // round(1 / TICK_S)
pub const ACCT_STEP: i64 = 45_000;   // per-account series grid: at most 1920 points a day

/// What one compute produced; the patch and the alerts read it.
pub struct View {
    pub now: i64,
    pub summary: P::Summary,
    pub accounts: Vec<P::Account>,
    pub symbols: Vec<P::SymbolRow>,
    pub exposure: P::Exposure,
    pub engines: Vec<P::Engine>,
    pub alerts: Vec<P::Alert>,
    pub feeds: Vec<P::Feed>,
    pub markouts: P::MarkoutStats,
    pub agg: Rc<FillAgg>,
    pub orders: Vec<P::OpenOrder>,
    pub days: Vec<P::DayPnl>,
    pub hours: Vec<P::HourPnl>,
}

pub type DeskRef = Rc<RefCell<Desk>>;
type Series3 = (Vec<i64>, Vec<f64>, Vec<f64>);

/// A day's real-money split: day PnL, Π split FIFO, the hedge legs and what they leave unexplained.
#[derive(Debug, Clone, PartialEq, Default, serde::Serialize, serde::Deserialize)]
pub struct DayReal {
    pub pnl_day: f64,
    pub trading: f64,
    pub realized: f64,
    pub realized_old: f64,
    pub floating: f64,
    pub hedge: Option<f64>,
    pub other: Option<f64>,
    #[serde(default)]
    pub mm: Option<f64>,
    #[serde(default)]
    pub inventory: Option<f64>,
}

/// Accounts' day PnL now against their last points: large moves that cancel across accounts are a
/// transfer between them that one side's books show before the other's (or before the history does).
pub fn in_flight(pts: &[(f64, Option<f64>)], floor: f64) -> bool {
    let d: Vec<f64> = pts.iter().filter_map(|&(p, q)| q.map(|q| p - q)).collect();
    let big = d.iter().fold(0.0_f64, |m, x| m.max(x.abs()));
    big > floor && d.iter().sum::<f64>().abs() < 0.25 * big
}

pub struct Desk {
    pub cfg: Config,
    pub started: f64,
    pub govs: Governors,
    pub store: Rc<Store>,
    pub alerts: RefCell<Alerts>,
    pub engines: Vec<EngineScraperRef>,
    pub public_feed: FeedRef,
    pub day_start: Rc<Cell<i64>>,
    pub series: Vec<P::SeriesPoint>,
    agg: Option<(i64, Rc<FillAgg>)>,
    /// market making over today's fills, redone with the aggregate
    mm: Rc<MmSplit>,
    /// since when account points wait on a transfer in flight
    held: i64,
    /// each day's real-money split as it stood at its end (today's: now), kept in kv `dayreal:<day>`
    pub day_real: std::collections::BTreeMap<String, DayReal>,
    pub new_series: Vec<P::SeriesPoint>,
    pub acct_series: HashMap<String, Series3>,   // account -> (t, equity, pnl_day)
    pub new_acct: HashMap<String, Vec<(i64, f64, f64)>>,
    pub fill_protos: HashMap<String, P::Fill>,
    pub tracked: Rc<RefCell<HashSet<String>>>,
    pub muxes: Vec<Rc<RefCell<StreamMux>>>,
    pub betas: Option<Rc<RefCell<Betas>>>,
    pub accounts: Vec<AccountRef>,
    pub view: Option<View>,
    pub hub: RefCell<Hub>,
    pub market: MarketRef,
    pub fills: Rc<RefCell<FillBook>>,
    pub transfers: TransfersRef,
    pub pnl: Rc<RefCell<PnlBook>>,
    pub spot_filled: Rc<RefCell<Vec<String>>>,   // spot instruments filled today: in the P&L scope (a set, insertion order)
    pub fixed_betas: Rc<HashMap<String, f64>>,
    pub on_fill: OnFill,
    pub http: reqwest::Client,
}

fn dummy_pnl(day_start: i64) -> PnlBook {
    PnlBook::new(day_start, Box::new(|_| 0.0), Box::new(Vec::new), Box::new(|_| 1.0), None, None)
}

/// Python's `repr(float)` closely enough for the kv store (read back with float()).
fn repr(x: f64) -> String {
    format!("{x:?}")
}

fn pnl_flush(pnl: &RefCell<PnlBook>, store: &Store) {
    let (rows, state, ds) = {
        let mut p = pnl.borrow_mut();
        let (rows, state) = p.flush();
        (rows, state, p.day_start)
    };
    for r in rows {
        store.put(Row::PnlHour(crate::store::HourRow {
            t: r.t,
            trading: r.trading,
            hedged: r.hedged,
            factor: r.factor,
            ref_hedge: r.ref_hedge,
            factor_hedge: r.factor_hedge,
            fills: r.fills,
            volume: r.volume,
            covered_s: r.covered_s,
            backfilled_s: Some(r.backfilled_s),
        }));
    }
    store.put(Row::Kv(format!("pnlstate:{ds}"), serde_json::to_string(&state).expect("state serializes")));
}

impl Desk {
    fn new(cfg: Config, market: Market, govs: Governors, public_feed: FeedRef, http: reqwest::Client) -> Desk {
        let store = Rc::new(Store::new(&cfg.db));
        let s2 = store.clone();
        let alerts = Alerts::new(Box::new(move |a: &P::Alert| {
            s2.put(Row::Alert(AlertRow {
                id: a.id.clone(),
                since: a.since,
                rule: a.rule.clone(),
                level: a.level.as_str().into(),
                text: a.text.clone(),
                active: a.active,
            }))
        }));
        let day_start = sessions::day_start(now_ms(), cfg.day_start_min);
        let market = Rc::new(RefCell::new(market));
        let fills = Rc::new(RefCell::new(FillBook::new()));
        let pnl = Rc::new(RefCell::new(dummy_pnl(day_start)));
        let tracked: Rc<RefCell<HashSet<String>>> = Rc::default();
        let spot_filled: Rc<RefCell<Vec<String>>> = Rc::default();
        let on_fill: OnFill = {
            let (fills, market, tracked, spot_filled, pnl) =
                (fills.clone(), market.clone(), tracked.clone(), spot_filled.clone(), pnl.clone());
            Rc::new(move |f: FillRec| {
                let key = f.key();
                let spot = (f.venue == Venue::Spot).then(|| f.clone());
                let mut m = market.borrow_mut();
                // a fill that arrives late (a REST sweep) is not marked against today's fair
                let fresh = CLOCK.now() - f.ts < 5_000;
                if fills.borrow_mut().add(&mut m, f, fresh) {
                    tracked.borrow_mut().insert(key.clone());
                    if let Some(f) = spot {
                        let mut sf = spot_filled.borrow_mut();
                        if !sf.contains(&key) {
                            sf.push(key);
                        }
                        pnl.borrow_mut().on_fill_at(&mut m, &f, fresh);
                    }
                }
            })
        };
        Desk {
            started: now_s(),
            govs,
            alerts: RefCell::new(alerts),
            engines: cfg.engines.iter().map(|e| Rc::new(RefCell::new(EngineScraper::new(e.clone())))).collect(),
            public_feed,
            day_start: Rc::new(Cell::new(day_start)),
            series: vec![],
            agg: None,
            mm: Rc::default(),
            held: 0,
            day_real: std::collections::BTreeMap::new(),
            new_series: vec![],
            acct_series: HashMap::new(),
            new_acct: HashMap::new(),
            fill_protos: HashMap::new(),
            tracked,
            muxes: vec![],
            betas: cfg.beta.clone().map(|b| Rc::new(RefCell::new(Betas::new(b)))),
            accounts: vec![],
            view: None,
            hub: RefCell::new(Hub::new()),
            market,
            fills,
            transfers: Rc::new(RefCell::new(Transfers::new(None, vec![]))),
            pnl,
            spot_filled,
            fixed_betas: Rc::default(),
            on_fill,
            http,
            store,
            cfg,
        }
    }

    // lookups used by metrics and alerts

    pub fn day_start(&self) -> i64 {
        self.day_start.get()
    }

    pub fn account(&self, aid: &str) -> Option<&AccountRef> {
        self.accounts.iter().find(|a| a.borrow().id == aid)
    }

    pub fn all_feeds(&self) -> Vec<FeedRef> {
        let mut out: Vec<FeedRef> = self.muxes.iter().flat_map(|m| m.borrow().feeds()).collect();
        out.push(self.public_feed.clone());
        for a in &self.accounts {
            let a = a.borrow();
            out.extend(a.feeds.iter().cloned());
            out.push(a.rest_feed.clone());
        }
        if !self.cfg.simulate {
            out.push(self.transfers.borrow().feed.clone());
        }
        out.extend(self.engines.iter().map(|e| e.borrow().feed.clone()));
        out
    }

    // setup

    fn make_muxes(this: &DeskRef) {
        let market = this.borrow().market.clone();
        let (m1, m2, m3) = (market.clone(), market.clone(), market.clone());
        let spot_book = Rc::new(RefCell::new(StreamMux::new(SPOT_STREAM, "spot bookTicker",
            move |_, d| m1.borrow_mut().on_book_raw(Venue::Spot, d), 200)));
        let usdm_book = Rc::new(RefCell::new(StreamMux::new(USDM_PUBLIC, "usdm bookTicker",
            move |_, d| m2.borrow_mut().on_book_raw(Venue::Usdm, d), 200)));
        let usdm_mark = Rc::new(RefCell::new(StreamMux::new(USDM_MARKET, "usdm markPrice",
            move |_, d| m3.borrow_mut().on_mark_raw(d), 200)));
        let (sb, ub, um) = (spot_book.clone(), usdm_book.clone(), usdm_mark.clone());
        market.borrow_mut().on_new = Box::new(move |inst: &Inst| {
            let s = inst.symbol.to_lowercase();
            if inst.venue == Venue::Spot {
                sb.borrow_mut().add([format!("{s}@bookTicker")]);
            } else {
                ub.borrow_mut().add([format!("{s}@bookTicker")]);
                um.borrow_mut().add([format!("{s}@markPrice@1s")]);
            }
        });
        this.borrow_mut().muxes = vec![spot_book, usdm_book, usdm_mark];
    }

    fn make_accounts(&mut self) {
        let mut accounts: Vec<AccountRef> = vec![];
        if self.cfg.simulate {
            accounts = sim::accounts().into_iter().map(Account::shared).collect();
        } else {
            let master_ok = self.cfg.master.as_ref().is_some_and(|m| credentials(&m.api_key_env, &m.private_key_env, &m.secret_env).is_ok());
            let cfgs: Vec<C::AccountCfg> = self.cfg.master.iter().cloned().chain(self.cfg.accounts.iter().cloned()).collect();
            for ac in cfgs {
                let (creds, reason) = match credentials(&ac.api_key_env, &ac.private_key_env, &ac.secret_env) {
                    Ok(c) => (Some(Rc::new(c)), String::new()),
                    Err(r) => {
                        warn!("account {}: {r}", ac.id);
                        (None, r)
                    }
                };
                let use_master = creds.is_none() && ac.role != Role::Master && !ac.email.is_empty() && master_ok;
                let mut acct = Account::new(ac, creds, &reason);
                if use_master {
                    acct.use_master();
                }
                accounts.push(acct.shared());
            }
        }
        let store = self.store.clone();
        let on_fee: OnFee = Rc::new(move |a: &Account, venue: Venue, symbol: &str, v: (f64, f64)| {
            store.put(Row::Kv(format!("fee:{}:{venue}:{symbol}", a.id), format!("{},{}", repr(v.0), repr(v.1))));
        });
        let spot_symbols: Vec<String> =
            self.cfg.markets.iter().filter(|m| m.venue == Venue::Spot).map(|m| m.symbol.clone()).collect();
        for a in &accounts {
            let mut a = a.borrow_mut();
            a.market = Some(self.market.clone());
            a.on_fill = self.on_fill.clone();
            a.on_fee = on_fee.clone();
            a.spot_symbols = spot_symbols.clone();
        }
        let master = accounts.iter().find(|a| a.borrow().role == Role::Master).cloned();
        if let Some(m) = &master
            && !m.borrow().cfg.show
        {
            accounts.retain(|a| !Rc::ptr_eq(a, m));   // still reads transfers and sub-accounts, but is not on the desk
        }
        self.accounts = accounts;
        let mut t = Transfers::new(master, self.accounts.clone());
        let store = self.store.clone();
        t.on_record = Rc::new(move |tid: &str, r: &Transfer| {
            store.put(Row::Transfer(TransferRow {
                id: tid.to_string(),
                ts: r.ts,
                from_email: r.frm.clone(),
                to_email: r.to.clone(),
                asset: r.asset.clone(),
                amount: r.amount,
            }));
        });
        self.transfers = Rc::new(RefCell::new(t));
        let mut m = self.market.borrow_mut();
        let mut tracked = self.tracked.borrow_mut();
        for mc in &self.cfg.markets {
            let id = m.ensure(&mc.symbol, mc.venue, mc.reference.as_ref().map(|r| (r.symbol.as_str(), r.venue)));
            tracked.insert(m.insts[id].key.clone());
            if let Some(r) = m.insts[id].ref_ {
                tracked.insert(m.insts[r].key.clone());
            }
        }
        self.fixed_betas = Rc::new(self.cfg.markets.iter().map(|mc| (format!("{}:{}", mc.venue, mc.symbol), mc.beta)).collect());
        if let Some((venue, sym)) = self.cfg.beta_vs.as_deref().and_then(|v| v.split_once(':'))
            && let Ok(venue) = venue.parse::<Venue>()
        {
            let id = m.ensure(sym, venue, None);
            tracked.insert(m.insts[id].key.clone());
        }
    }

    fn new_pnl_book(&self) -> PnlBook {
        let accts = self.accounts.clone();
        let balance = move |base: &str| -> f64 {
            accts.iter().map(|a| a.borrow().balances.get(base).map_or(0.0, |(f, l)| f + l)).sum()
        };
        let spot_keys: Vec<String> =
            self.cfg.markets.iter().filter(|m| m.venue == Venue::Spot).map(|m| format!("spot:{}", m.symbol)).collect();
        let sf = self.spot_filled.clone();
        let scope = move || -> Vec<String> { spot_keys.iter().cloned().chain(sf.borrow().iter().cloned()).collect() };
        let (betas, fixed) = (self.betas.clone(), self.fixed_betas.clone());
        let beta = move |k: &str| -> f64 {
            match &betas {
                Some(b) => b.borrow().beta(k),
                None => fixed.get(k).copied().unwrap_or(1.0),
            }
        };
        let accts = self.accounts.clone();
        let taker = move |inst: &Inst| -> f64 {
            accts
                .iter()
                .map(|a| {
                    let a = a.borrow();
                    a.fee(Venue::Spot, &inst.symbol).or_else(|| a.fee(Venue::Spot, "*")).unwrap_or((0.0, 0.0)).1
                })
                .fold(0.0, f64::max)
                * 1e4
        };
        PnlBook::new(self.day_start(), Box::new(balance), Box::new(scope), Box::new(beta), self.cfg.beta_vs.clone(),
                     Some(Box::new(taker)))
    }

    fn reload(&mut self) -> Result<()> {
        let ds = self.day_start();
        let data = self.store.load(ds, (DAYS_SHOWN as i64 + 1) * 24).context("store load")?;
        *self.fills.borrow_mut() = FillBook::new();
        *self.pnl.borrow_mut() = self.new_pnl_book();
        {
            let mut m = self.market.borrow_mut();
            let mut fills = self.fills.borrow_mut();
            let mut tracked = self.tracked.borrow_mut();
            let mut sf = self.spot_filled.borrow_mut();
            for f in data.fills {
                let key = f.key();
                let spot = f.venue == Venue::Spot;
                fills.add(&mut m, f, false);
                tracked.insert(key.clone());
                if spot && !sf.contains(&key) {
                    sf.push(key);
                }
            }
            let mut pnl = self.pnl.borrow_mut();
            pnl.load_fills(&mut m, fills.fills.iter());
            let hours: Vec<pnl::HourRow> = data
                .hours
                .iter()
                .map(|r| pnl::HourRow {
                    t: r.t,
                    trading: r.trading,
                    hedged: r.hedged,
                    factor: r.factor,
                    ref_hedge: r.ref_hedge,
                    factor_hedge: r.factor_hedge,
                    fills: r.fills,
                    volume: r.volume,
                    covered_s: r.covered_s,
                    backfilled_s: r.backfilled_s.unwrap_or(0),
                })
                .collect();
            pnl.load_hours(hours.iter());
            let state = data.kv.get(&format!("pnlstate:{ds}")).and_then(|s| match serde_json::from_str::<PnlState>(s) {
                Ok(v) => Some(v),
                Err(e) => {
                    warn!("pnlstate:{ds}: {e}");
                    None
                }
            });
            let legacy: Option<Value> = data.kv.get(&format!("pnlsym:{ds}")).and_then(|s| serde_json::from_str(s).ok());
            pnl.load_state(state, legacy.as_ref());
            // the grid was live where desk rows carry its P&L (rows from before it existed have none)
            let ts: Vec<i64> = data.equity.iter().filter(|r| r.account == "*" && r.trading.is_some()).map(|r| r.t).collect();
            pnl.clip_live(&alive_spans(&ts, ALIVE_STEP_MS, ALIVE_GAP_MS));
            for f in fills.take_dirty() {
                self.fill_protos.insert(f.id.clone(), f.proto());
            }
        }
        {
            let mut t = self.transfers.borrow_mut();
            for r in &data.transfers {
                t.records.insert(r.id.clone(), Transfer {
                    ts: r.ts,
                    frm: r.from_email.clone(),
                    to: r.to_email.clone(),
                    asset: r.asset.clone(),
                    amount: r.amount,
                });
            }
        }
        self.alerts.borrow_mut().load(&data.alerts);
        for (k, v) in &data.kv {
            if let Some(day) = k.strip_prefix("dayreal:") {
                match serde_json::from_str::<DayReal>(v) {
                    Ok(d) => {
                        self.day_real.insert(day.to_string(), d);
                    }
                    Err(e) => warn!("{k}: {e}"),
                }
            }
        }
        if let (Some(b), Some(v)) = (&self.betas, data.kv.get("beta"))
            && let Err(e) = b.borrow_mut().load(v)
        {
            warn!("beta state: {e:#}");
        }
        for a in &self.accounts {
            let mut a = a.borrow_mut();
            for (k, v) in &data.kv {
                let parts: Vec<&str> = k.splitn(4, ':').collect();
                if parts.len() == 4 && parts[0] == "fee" && parts[1] == a.id
                    && let Ok(venue) = parts[2].parse::<Venue>()
                {
                    let xs: Vec<f64> = v.split(',').filter_map(|x| x.trim().parse().ok()).collect();
                    if let [mk, tk] = xs[..] {
                        a.first_fees.insert((venue, parts[3].to_string()), (mk, tk));
                    }
                }
            }
        }
        for r in &data.equity {
            if r.account == "*" {
                if r.t.rem_euclid(5000) == 0 {
                    self.series.push(P::SeriesPoint {
                        t: r.t,
                        equity: r.equity,
                        pnl_day: r.pnl_day,
                        trading: r.trading,
                        hedged: r.hedged,
                        inventory: r.inventory,
                        futures_notional: r.futures_notional,
                    });
                }
            } else {
                self.acct_point(&r.account, r.t, r.equity, r.pnl_day, false);
            }
        }
        for a in &self.accounts {   // opening equity of today, saved when first set
            let mut a = a.borrow_mut();
            if let Some(v) = data.kv.get(&format!("open:{}:{ds}", a.id)).and_then(|v| v.parse::<f64>().ok()) {
                a.equity_open = Some(v);
            }
            // orders counted off the user stream today (read-only keys cannot ask Binance), so a restart keeps them
            if let Some(v) = data.kv.get(&format!("orders1d:{}:{ds}", a.id)).and_then(|v| v.parse::<i64>().ok()) {
                a.orders_1d = v;
            }
        }
        info!("reloaded {} fills, {} series points, {} transfers", self.fills.borrow().fills.len(), self.series.len(),
              self.transfers.borrow().records.len());
        Ok(())
    }

    // derived state

    pub fn compute(&mut self, fills_changed: bool) {
        let now = CLOCK.now();
        // the fill aggregate walks every fill of the day: redone on new or matured fills, else once a second
        if fills_changed || self.agg.as_ref().is_none_or(|a| now - a.0 >= 1000) {
            self.agg = Some((now, Rc::new(aggregate(&self.fills.borrow().fills, now))));
            let pnl = self.pnl.borrow();
            let mut m = self.market.borrow_mut();
            self.mm = Rc::new(mm_split(&mut m, &self.fills.borrow().fills, self.cfg.mm_horizon_s, |b| pnl.pos.contains_key(b)));
        }
        let agg = self.agg.as_ref().expect("agg").1.clone();
        let mm = self.mm.clone();
        let mut m = self.market.borrow_mut();
        let mut accounts = Vec::with_capacity(self.accounts.len());
        let mut valued = Vec::with_capacity(self.accounts.len());
        for a in &self.accounts {
            let mut a = a.borrow_mut();
            valued.push(a.valued(&mut m));
            accounts.push(account_row(&mut m, &mut a, CLOCK.now()));
        }
        let pnl = self.pnl.borrow();
        let by_base = pnl.by_base(&mut m);
        let symbols = symbol_rows(&mut m, &self.accounts, &by_base, &agg, &mm);
        let bv = {
            let b = self.betas.as_ref().map(|b| b.borrow());
            beta_weighted_spot(&self.cfg, &mut m, &self.accounts, b.as_deref())
        };
        let mut expo = exposure(&self.cfg, &m, &accounts, bv, self.betas.is_some(), CLOCK.now());
        let mut ps = pnl.summary(&mut m);
        ps.mm = mm.total;
        ps.mm_spread = mm.spread;
        ps.inventory = ps.trading - mm.total;
        expo.hedge_day = Some(hedge_day(&self.cfg, &m, &self.accounts, ps.ref_hedge, ps.factor_hedge));
        let pnl_day: f64 = accounts.iter().zip(&valued).filter(|(_, v)| **v).map(|(r, _)| r.pnl_day).sum();
        let equity: f64 = accounts.iter().zip(&valued).filter(|(_, v)| **v).map(|(r, _)| r.equity).sum();
        let rf = self.series.iter().rev().find(|p| p.t <= now - HOUR).or(self.series.first());
        let ds = self.day_start();
        let (fills_24h, volume_24h) = pnl.last_24h(now);
        let summary = P::Summary {
            equity,
            pnl_day,
            pnl_1h: rf.map_or(pnl_day, |r| pnl_day - r.pnl_day),
            other: expo.hedge_day.as_ref().and_then(|h| h.hedge_pnl).map(|h| pnl_day - ps.trading - h),
            pnl: ps,
            markout_net_bps_1h: agg.mk10_1h.value(),
            fills_1h: agg.fills_1h,
            fills_day: self.fills.borrow().fills.len() as i64,
            volume_day: agg.volume_day,
            fills_24h,
            volume_24h,
            inventory_value: accounts.iter().map(|r| r.inventory_value).sum(),
            inventory_assets: inventory_assets(&mut m, &self.accounts),
            fee_expiry: self.cfg.fee_expiry.clone(),
            day_start: ds,
            sessions: sessions::windows(&self.cfg.sessions, ds, ds + DAY)
                .into_iter()
                .map(|(name, start, end)| P::SessionWindow { name, start, end })
                .collect(),
            events: sessions::event_marks(&self.cfg.events, ds, ds + DAY).into_iter().map(|(name, at)| P::EventMark { name, at }).collect(),
            session: sessions::state(&self.cfg.sessions, &self.cfg.events, now, self.cfg.day_start_min),
        };
        let orders = open_orders(&m, &self.accounts);
        let mut days = pnl.day_rows(&mut m);
        let today = crate::pnl::utc_day(ds);
        if let Some(h) = expo.hedge_day.as_ref() {
            self.day_real.insert(today.clone(), DayReal {
                pnl_day,
                trading: summary.pnl.trading,
                realized: summary.pnl.realized,
                realized_old: summary.pnl.realized_old,
                floating: summary.pnl.floating,
                hedge: h.hedge_pnl,
                other: summary.other,
                mm: Some(summary.pnl.mm),
                inventory: Some(summary.pnl.inventory),
            });
        }
        for d in days.iter_mut() {
            if let Some(r) = self.day_real.get(&d.day) {
                if d.day != today {
                    d.trading = r.trading;   // the closed form at the day's end, not the sum of its blocks
                }
                d.pnl_day = Some(r.pnl_day);
                d.realized = Some(r.realized);
                d.realized_old = Some(r.realized_old);
                d.floating = Some(r.floating);
                d.hedge = r.hedge;
                d.other = r.other;
                d.mm = r.mm;
                d.inventory = r.inventory;
            }
        }
        let mut hours = pnl.hour_rows();
        for h in hours.iter_mut() {
            h.mm = mm.by_hour.get(&h.t).copied().unwrap_or(0.0);
            h.inventory = h.trading - h.mm;
        }
        drop(pnl);
        drop(m);
        let feeds = self.all_feeds().iter().map(|f| f.borrow().proto()).collect();
        let engines = self.engines.iter().map(|e| e.borrow().engine()).collect();
        self.view = Some(View {
            now,
            summary,
            accounts,
            symbols,
            exposure: expo,
            engines,
            alerts: self.alerts.borrow().list(),
            feeds,
            markouts: markout_stats(&agg),
            agg,
            orders,
            days,
            hours,
        });
    }

    /// The snapshot of the current view (computed by the caller).
    pub fn snapshot(&self) -> P::Snapshot {
        let v = self.view.as_ref().expect("view computed");
        let fb = self.fills.borrow();
        let n = fb.fills.len();
        let fills = fb.fills[n.saturating_sub(2000)..]
            .iter()
            .rev()
            .map(|f| self.fill_protos.get(&f.id).cloned().unwrap_or_else(|| f.proto()))
            .collect();
        P::Snapshot {
            now: v.now,
            summary: v.summary.clone(),
            accounts: v.accounts.clone(),
            symbols: v.symbols.clone(),
            fills,
            series: self.series.clone(),
            exposure: v.exposure.clone(),
            engines: v.engines.clone(),
            alerts: v.alerts.clone(),
            feeds: v.feeds.clone(),
            markouts: v.markouts.clone(),
            orders: v.orders.clone(),
            days: v.days.clone(),
            hours: v.hours.clone(),
            account_series: self.account_series(),
        }
    }

    /// Today's per-account equity and day PnL on a 45 s grid.
    pub fn account_series(&self) -> Vec<P::AccountSeries> {
        self.accounts
            .iter()
            .filter_map(|a| {
                let id = a.borrow().id.clone();
                self.acct_series.get(&id).map(|s| P::AccountSeries { account: id, t: s.0.clone(), equity: s.1.clone(), pnl_day: s.2.clone() })
            })
            .collect()
    }

    /// Only the points not sent yet.
    pub fn account_series_new(&mut self) -> Vec<P::AccountSeries> {
        let mut out = vec![];
        for a in &self.accounts {
            let id = a.borrow().id.clone();
            if let Some(pts) = self.new_acct.get(&id).filter(|p| !p.is_empty()) {
                out.push(P::AccountSeries {
                    account: id,
                    t: pts.iter().map(|p| p.0).collect(),
                    equity: pts.iter().map(|p| p.1).collect(),
                    pnl_day: pts.iter().map(|p| p.2).collect(),
                });
            }
        }
        self.new_acct.clear();
        out
    }

    fn acct_point(&mut self, acct: &str, t: i64, eq: f64, pnl: f64, fresh: bool) {
        let s = self.acct_series.entry(acct.to_string()).or_default();
        if let Some(&last) = s.0.last()
            && t.div_euclid(ACCT_STEP) <= last.div_euclid(ACCT_STEP)
        {
            return;
        }
        s.0.push(t);
        s.1.push(eq);
        s.2.push(pnl);
        if fresh {
            self.new_acct.entry(acct.to_string()).or_default().push((t, eq, pnl));
        }
    }

    // loops

    fn fast(&mut self) -> Vec<P::Fill> {
        let dirty = {
            let m = self.market.borrow();
            let mut fb = self.fills.borrow_mut();
            fb.mature(&m, CLOCK.now());
            fb.take_dirty()
        };
        let mut out = Vec::with_capacity(dirty.len());
        for f in dirty {
            let p = f.proto();
            self.fill_protos.insert(f.id.clone(), p.clone());
            out.push(p);
            self.store.put(Row::Fill(Box::new(f)));
        }
        out
    }

    fn slow(&mut self) {
        let now = CLOCK.now();
        if now >= self.day_start() + DAY {
            self.roll(now);
        }
        for f in self.all_feeds() {
            f.borrow_mut().update_rate();
        }
        let ds = self.day_start();
        {
            let mut m = self.market.borrow_mut();
            let tr = self.transfers.borrow();
            let mut tracked = self.tracked.borrow_mut();
            for a in &self.accounts {
                let mut a = a.borrow_mut();
                let td = tr.net_in_live(&mut a, &mut m, ds, now);
                a.transfers_day = td;
                a.day_start = ds;
                if a.equity_open.is_none() && a.valued(&mut m) && tr.loaded {
                    let eo = a.equity(&mut m) - a.transfers_day;
                    a.equity_open = Some(eo);
                    self.store.put(Row::Kv(format!("open:{}:{ds}", a.id), repr(eo)));
                }
                for (s, (amt, _)) in &a.positions {
                    if *amt != 0.0 {
                        tracked.insert(format!("usdm:{s}"));
                    }
                }
                for o in a.open.values() {
                    tracked.insert(format!("{}:{}", o.venue, o.symbol));
                }
            }
        }
        if let Some(v) = &self.view {
            self.alerts.borrow_mut().evaluate(self, v, now);
        }
    }

    fn point(&mut self) {
        let Some(v) = &self.view else { return };
        if now_s() - self.started < WARMUP_S {
            return;   // just started: balances, positions and transfers still settling would draw a false jump
        }
        {
            let mut m = self.market.borrow_mut();
            let all = self.accounts.iter().all(|a| {
                let a = a.borrow();
                !(a.creds.is_some() || self.cfg.simulate) || a.valued(&mut m)
            });
            if !all {
                return;   // a half-priced desk would draw a false jump in equity
            }
        }
        let t = v.now - v.now.rem_euclid(5000);
        let s = &v.summary;
        // the P&L grid rolls a couple of seconds after the desk's day: until then its numbers are the
        // ending day's, so the point leaves them out rather than start the new day at yesterday's Π
        let fresh = self.pnl.borrow().day_start == s.day_start;
        let some = |x: f64| fresh.then_some(x);
        let p = P::SeriesPoint {
            t,
            equity: s.equity,
            pnl_day: s.pnl_day,
            trading: some(s.pnl.trading),
            hedged: some(s.pnl.hedged),
            inventory: s.inventory_value,
            futures_notional: v.exposure.futures_notional,
        };
        if self.series.last().is_some_and(|l| l.t >= t) {
            return;
        }
        self.store.put(Row::Equity(EquityRow {
            t,
            account: "*".into(),
            equity: p.equity,
            pnl_day: p.pnl_day,
            markout_pnl: 0.0,
            inventory: p.inventory,
            futures_notional: p.futures_notional,
            trading: p.trading,
            hedged: p.hedged,
            realized: some(s.pnl.realized + s.pnl.realized_old),
            floating: some(s.pnl.floating),
            hedge: v.exposure.hedge_day.as_ref().and_then(|h| h.hedge_pnl).filter(|_| fresh),
            mm: some(s.pnl.mm),
        }));
        let mut rows = vec![];
        {
            let mut m = self.market.borrow_mut();
            for (r, a) in v.accounts.iter().zip(&self.accounts) {
                if a.borrow().valued(&mut m) {
                    rows.push((r.id.clone(), r.equity, r.pnl_day, r.inventory_value, r.positions.iter().map(|x| x.notional).sum::<f64>()));
                }
            }
        }
        self.series.push(p.clone());
        self.new_series.push(p);
        let pts: Vec<(f64, Option<f64>)> =
            rows.iter().map(|r| (r.2, self.acct_series.get(&r.0).and_then(|s| s.2.last().copied()))).collect();
        if in_flight(&pts, 50.0) {
            // a transfer between the desk's accounts seen on one side only: wait for the other, 5 min at most
            if self.held == 0 {
                self.held = t;
            }
            if t - self.held < 300_000 {
                return;
            }
        }
        self.held = 0;
        for (id, eq, pnl, inv, fut) in rows {
            self.store.put(Row::Equity(EquityRow {
                t,
                account: id.clone(),
                equity: eq,
                pnl_day: pnl,
                markout_pnl: 0.0,
                inventory: inv,
                futures_notional: fut,
                trading: Some(0.0),
                hedged: Some(0.0),
                ..Default::default()
            }));
            self.acct_point(&id, t, eq, pnl, true);
        }
    }

    /// The day's real-money split to kv, as it stands.
    fn put_day_real(&self, ds: i64) {
        let day = crate::pnl::utc_day(ds);
        if let Some(r) = self.day_real.get(&day)
            && let Ok(v) = serde_json::to_string(r)
        {
            self.store.put(Row::Kv(format!("dayreal:{day}"), v));
        }
    }

    fn roll(&mut self, now: i64) {
        self.put_day_real(self.day_start());   // the day that ends, as it ended
        let ds = sessions::day_start(now, self.cfg.day_start_min);
        self.day_start.set(ds);
        {
            let mut fb = self.fills.borrow_mut();
            fb.roll(ds);
            let keep: HashSet<&str> = fb.fills.iter().map(|f| f.id.as_str()).collect();
            self.fill_protos.retain(|k, _| keep.contains(k.as_str()));
        }
        self.series.clear();
        self.acct_series.clear();
        self.new_acct.clear();
        self.transfers.borrow_mut().roll(ds);
        let mut m = self.market.borrow_mut();
        for a in &self.accounts {
            let mut a = a.borrow_mut();
            a.transfers_day = 0.0;
            if a.no_order_counts {
                a.orders_1d = 0;
            }
            a.equity_open = if a.valued(&mut m) { Some(a.equity(&mut m)) } else { None };
            if let Some(eo) = a.equity_open {
                self.store.put(Row::Kv(format!("open:{}:{ds}", a.id), repr(eo)));
            }
        }
        self.hub.borrow_mut().reset();
        info!("day rolled to {ds}");
    }

    fn pnl_tick(&mut self, n: u64) {
        let now = CLOCK.now();
        if !self.pnl.borrow().started() {
            let mut m = self.market.borrow_mut();
            let readable: Vec<&AccountRef> = self
                .accounts
                .iter()
                .filter(|a| {
                    let a = a.borrow();
                    a.creds.is_some() || a.via_master || self.cfg.simulate
                })
                .collect();
            let valued = !readable.is_empty() && readable.iter().all(|a| a.borrow().valued(&mut m));
            let scope = (self.pnl.borrow().scope)();
            let priced = scope.iter().all(|k| m.get(k).is_none_or(|i| i.mid().is_some()));
            if valued && (priced || now_s() - self.started > 60.0) {
                let mut p = self.pnl.borrow_mut();
                p.begin(&mut m, now);
                let inv: f64 = p.pos.values().map(|x| x.q * m.px(x.inst).unwrap_or(0.0)).sum();
                info!("P&L grid started: {} instruments, inventory {inv:.2} USDT", p.pos.len());
            }
            return;
        }
        {
            let mut m = self.market.borrow_mut();
            self.pnl.borrow_mut().step(&mut m, now);
        }
        if n.is_multiple_of(60 * TICKS_1S) {
            pnl_flush(&self.pnl, &self.store);
            self.put_day_real(self.day_start());
            self.put_order_counts();
        }
    }

    fn put_order_counts(&self) {
        let ds = self.day_start();
        for a in &self.accounts {
            let a = a.borrow();
            if a.no_order_counts {
                self.store.put(Row::Kv(format!("orders1d:{}:{ds}", a.id), a.orders_1d.to_string()));
            }
        }
    }

    fn tick(&mut self, n: u64) {
        let dirty = self.fast();
        self.pnl_tick(n);
        if n.is_multiple_of(TICKS_1S) {
            self.slow();
        }
        self.compute(!dirty.is_empty());
        if n.is_multiple_of(TICKS_1S) {
            self.point();
        }
        let series = std::mem::take(&mut self.new_series);
        let acct = if self.new_acct.is_empty() { vec![] } else { self.account_series_new() };
        let v = self.view.as_ref().expect("view");
        let patch = Patch {
            now: v.now,
            summary: &v.summary,
            accounts: &v.accounts,
            symbols: &v.symbols,
            exposure: &v.exposure,
            engines: &v.engines,
            alerts: &v.alerts,
            feeds: &v.feeds,
            markouts: &v.markouts,
            orders: &v.orders,
            days: &v.days,
            hours: &v.hours,
        };
        self.hub.borrow_mut().tick(&patch, &dirty, &series, &acct, || P::encode(&self.snapshot()));
    }

    fn health(&self) -> DeskHealth {
        let feeds = self.all_feeds();
        let m = self.market.borrow();
        DeskHealth {
            simulate: self.cfg.simulate,
            started: self.started,
            feeds_up: feeds.iter().filter(|f| f.borrow().up).count() as i64,
            feeds: feeds.len() as i64,
            instruments: m.insts.len() as i64,
            instruments_with_mid: m.insts.iter().filter(|i| i.mid().is_some()).count() as i64,
            fills_day: self.fills.borrow().fills.len() as i64,
        }
    }
}

/// The desk side of the HTTP bridge.
struct Source(DeskRef);

impl DeskSource for Source {
    fn snapshot(&self) -> Vec<u8> {
        let mut d = self.0.borrow_mut();
        if d.view.is_none() {
            d.compute(true);
        }
        P::encode(&d.snapshot())
    }

    fn health(&self) -> DeskHealth {
        self.0.borrow().health()
    }
}

// tasks

async fn bootstrap(http: &reqwest::Client, govs: &Governors, feed: &FeedRef, cfg: &Config) -> Market {
    let rest = Rest::new(http.clone(), govs.clone(), None, Some(feed.clone()));
    loop {
        let r: Result<(Value, Value)> = async {
            sync_time(&rest).await?;
            let spot: Value = rest.get("/api/v3/exchangeInfo", &[], 20, false).await?;
            let usdm: Value = rest.get("/fapi/v1/exchangeInfo", &[], 1, false).await?;
            Ok((spot, usdm))
        }
        .await;
        match r {
            Ok((spot, usdm)) => {
                feed.borrow_mut().set_up(true, Some(&format!("clock offset {} ms", CLOCK.offset_ms())));
                let mut info: Info = HashMap::new();
                info.insert(Venue::Spot, parse_exchange_info(&spot));
                info.insert(Venue::Usdm, parse_exchange_info(&usdm));
                return Market::new(info, cfg.fair_halflife_s, cfg.mark_max_spread_bps);
            }
            Err(e) => {
                // network at startup: keep trying
                let d: String = format!("{e:#}").chars().take(200).collect();
                feed.borrow_mut().set_up(false, Some(&d));
                warn!("bootstrap failed: {e:#}");
                tokio::time::sleep(Duration::from_secs(5)).await;
            }
        }
    }
}

async fn ticker(desk: DeskRef) {
    let mut n = 0u64;
    loop {
        tokio::time::sleep(Duration::from_secs_f64(TICK_S)).await;
        desk.borrow_mut().tick(n);
        n += 1;
    }
}

async fn beta_loop(desk: DeskRef) {
    let (b, market, tracked, store, markets) = {
        let d = desk.borrow();
        let Some(b) = d.betas.clone() else { return };
        (b, d.market.clone(), d.tracked.clone(), d.store.clone(), d.cfg.markets.clone())
    };
    let (vs_venue, vs_sym, sample_s) = {
        let bb = b.borrow();
        let (v, s) = bb.cfg.vs.split_once(':').unwrap_or(("usdm", bb.cfg.vs.as_str()));
        (v.parse::<Venue>().unwrap_or(Venue::Usdm), s.to_string(), bb.cfg.sample_s)
    };
    let vs = {
        let mut m = market.borrow_mut();
        let id = m.ensure(&vs_sym, vs_venue, None);
        tracked.borrow_mut().insert(m.insts[id].key.clone());
        id
    };
    let mut n = 0u64;
    loop {
        tokio::time::sleep(Duration::from_secs_f64(sample_s)).await;
        {
            let m = market.borrow();
            let mut prices: Vec<(String, Option<f64>)> = vec![];
            for mc in &markets {
                if let Some(id) = m.find(&mc.symbol, mc.venue)
                    && id != vs
                {
                    let src = m.insts[id].ref_.unwrap_or(id);
                    prices.push((m.insts[id].key.clone(), m.insts[src].mid()));
                }
            }
            b.borrow_mut().sample(m.insts[vs].mid(), prices.iter().map(|(k, p)| (k.as_str(), *p)));
        }
        n += 1;
        if n.is_multiple_of(30) {
            store.put(Row::Kv("beta".into(), b.borrow().dump()));
        }
    }
}

async fn prune(desk: DeskRef) {
    loop {
        {
            let d = desk.borrow();
            let now = now_ms() as f64;
            let day = DAY as f64;
            d.store.prune((now - d.cfg.keep_fine_days * day) as i64, (now - d.cfg.keep_days * day) as i64);
            d.pnl.borrow_mut().prune(d.day_start() - DAYS_SHOWN as i64 * DAY);
        }
        tokio::time::sleep(Duration::from_secs(3600)).await;
    }
}

/// bookTicker streams only send on change: price instruments that have not ticked yet from REST.
async fn seed_books(market: MarketRef, rest: Rest) {
    loop {
        for (venue, path, weight) in [(Venue::Spot, "/api/v3/ticker/bookTicker", 4), (Venue::Usdm, "/fapi/v1/ticker/bookTicker", 5)] {
            if !market.borrow().insts.iter().any(|i| i.t.is_none() && i.venue == venue) {
                continue;
            }
            let rows: Vec<Value> = match rest.get(path, &[], weight, false).await {
                Ok(r) => r,
                Err(e) => {
                    warn!("seed {venue} books: {e:#}");
                    continue;
                }
            };
            let mut m = market.borrow_mut();
            for r in &rows {
                let num = |k: &str| r.get(k).and_then(Value::as_str).and_then(|s| s.parse::<f64>().ok()).unwrap_or(0.0);
                let Some(sym) = r.get("symbol").and_then(Value::as_str) else { continue };
                let (b, a) = (num("bidPrice"), num("askPrice"));
                if let Some(id) = m.find(sym, venue)
                    && m.insts[id].t.is_none()
                    && b > 0.0
                    && a > 0.0
                {
                    m.on_book(venue, &BookTicker::new(sym, b, a, None));
                }
            }
        }
        tokio::time::sleep(Duration::from_secs(60)).await;
    }
}

async fn resync(rest: Rest) {
    loop {
        tokio::time::sleep(Duration::from_secs(600)).await;
        if let Err(e) = sync_time(&rest).await {
            warn!("time sync failed: {e:#}");   // keep the last offset
        }
    }
}

/// First SIGINT or SIGTERM. The handlers stay installed, so a second signal (fly sends SIGINT, then
/// SIGTERM) is ignored and cannot cut the final flush short.
async fn shutdown_signal() {
    use tokio::signal::unix::{SignalKind, signal};
    let (Ok(mut i), Ok(mut t)) = (signal(SignalKind::interrupt()), signal(SignalKind::terminate())) else {
        std::future::pending::<()>().await;
        return;
    };
    tokio::select! {
        _ = i.recv() => {}
        _ = t.recv() => {}
    }
    info!("signal: shutting down");
}

fn is_local(listen: &str) -> bool {
    let host = listen.rsplit_once(':').map_or("", |x| x.0).trim_matches(|c| c == '[' || c == ']');
    matches!(host, "127.0.0.1" | "localhost" | "::1")
}

pub async fn run(mut cfg: Config) -> Result<()> {
    let auth = match std::env::var("DESK_PASSWORD_HASH").ok().filter(|v| !v.is_empty()) {
        Some(pw) => Some(auth::Auth::new(&pw, &cfg.db).context("auth db")?),
        None if !is_local(&cfg.listen) => anyhow::bail!("refusing to listen on a public address without DESK_PASSWORD_HASH"),
        None => None,
    };
    if cfg.simulate {
        cfg.markets.extend(sim::markets());
        if cfg.target_ratio.is_none() {
            cfg.target_ratio = Some(1.0);
            cfg.band_usd = Some(cfg.band_usd.filter(|b| *b != 0.0).unwrap_or(250.0));
        }
    }
    let mut sig = Box::pin(shutdown_signal());
    let http = client();
    let govs = governors();
    let public_feed = Feed::shared("public rest", FeedKind::Rest, "");
    let market = tokio::select! {
        m = bootstrap(&http, &govs, &public_feed, &cfg) => m,
        _ = &mut sig => return Ok(()),
    };
    let desk: DeskRef = Rc::new(RefCell::new(Desk::new(cfg, market, govs.clone(), public_feed.clone(), http.clone())));
    Desk::make_muxes(&desk);
    {
        let mut d = desk.borrow_mut();
        d.make_accounts();
        d.reload()?;
        d.store.start().context("store")?;
    }
    let mut tasks: Vec<JoinHandle<()>> = vec![];
    let (simulate, listen) = {
        let d = desk.borrow();
        (d.cfg.simulate, d.cfg.listen.clone())
    };
    let public = Rest::new(http.clone(), govs.clone(), None, Some(public_feed.clone()));
    {
        let d = desk.borrow();
        if simulate {
            let mut s = sim::Sim::new(&d);
            s.setup(&d);
            tasks.push(tokio::task::spawn_local(s.run()));
        } else {
            let master = d.transfers.borrow().master.clone();
            let master_creds = master.as_ref().and_then(|m| m.borrow().creds.clone());
            for (i, a) in d.accounts.iter().enumerate() {
                let (via, creds, feed) = {
                    let ab = a.borrow();
                    (ab.via_master, ab.creds.clone(), ab.rest_feed.clone())
                };
                if via && let Some(mc) = &master_creds {
                    tasks.extend(accounts::start_via_master(a, Rest::new(http.clone(), govs.clone(), Some(mc.clone()), Some(feed)),
                                                            i as f64 * 3.0));
                } else {
                    tasks.extend(accounts::start(a, Rest::new(http.clone(), govs.clone(), creds, Some(feed))));
                }
            }
            if let Some(mc) = master_creds {
                let t = d.transfers.clone();
                let feed = t.borrow().feed.clone();
                let ds = d.day_start.clone();
                let rest = Rest::new(http.clone(), govs.clone(), Some(mc), Some(feed));
                tasks.push(tokio::task::spawn_local(accounts::run_transfers(t, rest, move || ds.get())));
            }
        }
        for e in &d.engines {
            tasks.push(tokio::task::spawn_local(engine::run(e.clone(), http.clone())));
        }
    }
    tasks.push(tokio::task::spawn_local(ticker(desk.clone())));
    tasks.push(tokio::task::spawn_local(resync(public.clone())));
    tasks.push(tokio::task::spawn_local(seed_books(desk.borrow().market.clone(), public.clone())));
    tasks.push(tokio::task::spawn_local(prune(desk.clone())));
    if !simulate {
        let d = desk.borrow();
        let (pnl, store) = (d.pnl.clone(), d.store.clone());
        tasks.push(tokio::task::spawn_local(backfill::run((d.pnl.clone(), d.market.clone()), public.clone(),
                                                          move || pnl_flush(&pnl, &store))));
    }
    if desk.borrow().betas.is_some() {
        tasks.push(tokio::task::spawn_local(beta_loop(desk.clone())));
    }
    let requests = desk.borrow().hub.borrow_mut().take_requests().expect("requests taken once");
    tasks.push(tokio::task::spawn_local(server::answer(requests, Source(desk.clone()))));
    let handle = desk.borrow().hub.borrow().handle();
    let history = {
        let d = desk.borrow();
        crate::history::Api::new(d.cfg.db.clone(), d.cfg.day_start_min)
    };
    let app = server::make_app(&handle, auth, server::web_dist(), history);
    let srv = server::serve(&handle, app, &listen).await.with_context(|| format!("listen {listen}"))?;
    info!("listening on http://{} (simulate={simulate})", srv.addr);
    sig.await;
    for t in &tasks {
        t.abort();
    }
    for m in &desk.borrow().muxes {
        m.borrow_mut().stop();
    }
    srv.cleanup().await;
    let d = desk.borrow();
    if d.pnl.borrow().started() {
        pnl_flush(&d.pnl, &d.store);
        d.put_order_counts();
        d.put_day_real(d.day_start());
    }
    d.store.close();
    info!("stopped");
    Ok(())
}

#[derive(Parser, Debug)]
#[command(name = "desk", about = "Read-only Binance multi-account desk monitor")]
struct Args {
    #[arg(long, default_value = "desk.toml")]
    config: String,
    /// synthetic accounts over real public market data
    #[arg(long)]
    simulate: bool,
    /// host:port, overrides [server] listen
    #[arg(long)]
    listen: Option<String>,
    /// print a random password and its hash for DESK_PASSWORD_HASH, then exit
    #[arg(long)]
    new_password: bool,
    /// hash a password read from stdin, then exit
    #[arg(long)]
    hash_password: bool,
}

pub fn main() {
    let args = Args::parse();
    if args.new_password || args.hash_password {
        let pw = if args.new_password {
            let pw = auth::new_password();
            println!("password: {pw}");
            pw
        } else {
            eprint!("Password: ");
            let mut s = String::new();
            if std::io::stdin().read_line(&mut s).is_err() {
                std::process::exit(1);
            }
            s.trim_end_matches(['\r', '\n']).to_string()
        };
        println!("DESK_PASSWORD_HASH={}", auth::hash_password(&pw));
        return;
    }
    tracing_subscriber::fmt()
        .with_env_filter(tracing_subscriber::EnvFilter::try_from_default_env().unwrap_or_else(|_| "info".into()))
        .init();
    let mut cfg = match C::load(&args.config) {
        Ok(c) => c,
        Err(e) => {
            eprintln!("{e:#}");
            std::process::exit(1);
        }
    };
    cfg.simulate = cfg.simulate || args.simulate;
    if let Some(l) = args.listen {
        cfg.listen = l;
    }
    let rt = tokio::runtime::Builder::new_current_thread().enable_all().build().expect("tokio runtime");
    let local = tokio::task::LocalSet::new();
    if let Err(e) = local.block_on(&rt, run(cfg)) {
        eprintln!("{e:#}");
        std::process::exit(1);
    }
}

#[cfg(test)]
mod tests {
    #[test]
    fn transfer_in_flight_between_accounts_is_held() {
        use super::in_flight;
        assert!(in_flight(&[(-380.7, Some(3.4)), (386.6, Some(2.7)), (1.0, Some(0.9))], 50.0));
        assert!(!in_flight(&[(3.8, Some(3.4)), (2.2, Some(2.7))], 50.0));
        assert!(!in_flight(&[(-80.0, Some(3.0)), (2.0, Some(2.0))], 50.0));
        assert!(!in_flight(&[(-380.7, None), (386.6, None)], 50.0));
    }
}

