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

use crate::accounts::{self, Account, AccountRef, Dividend, MarketRef, OnDividend, OnFee, OnFeeChange, OnFill, Transfer, Transfers, TransfersRef};
use crate::alerts::Alerts;
use crate::backfill;
use crate::beta::Betas;
use crate::clock::{CLOCK, now_s};
use crate::config::{self as C, Config};
use crate::connector::{Connector, Exchanges, PublicFeed};
use crate::engine::{self, EngineScraper, EngineScraperRef};
use crate::feeds::{Feed, FeedKind, FeedRef, now_ms};
use crate::fills::{FillBook, FillRec};
use crate::market::{Book, Inst, Market};
use crate::metrics::{
    FillAgg, HOUR, MmSplit, account_row, aggregate_in, mm_split, beta_weighted_spot, exposure, hedge_day, inventory_assets, markout_stats,
    open_orders, symbol_rows,
};
use crate::pnl::{self, ALIVE_GAP_MS, ALIVE_STEP_MS, DAYS_SHOWN, PnlBook, PnlState, alive_spans};
use crate::protocol::{self as P, Role, Venue};
use crate::server::{self, DeskHealth, DeskSource, Hub, Patch};
use crate::sessions;
use crate::store::{AlertRow, DividendRow, EquityRow, Row, Store, TransferRow};
use crate::{auth, sim};

pub const DAY: i64 = sessions::DAY_MS;
pub const TICK_S: f64 = 0.125; // compute and push cadence
pub const TICKS_1S: u64 = 8;
/// no curve points this long after start
const WARMUP_S: f64 = 30.0;   // round(1 / TICK_S)
pub const ACCT_STEP: i64 = 45_000;   // per-account series grid: at most 1920 points a day
const MINUTE: i64 = 60_000;
/// The day opens at the last 1 s equity mark before its start if it is this recent (else at the roll's tick).
const ROLL_MARK_MS: i64 = 10_000;
/// Minute bars each `bars` message carries: the one that closed and those before it, for fills that came late.
const BARS_RESENT: i64 = 5;

/// What one compute produced; the patch and the alerts read it.
pub struct View {
    pub now: i64,
    pub desk: P::Desk,
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

/// What the page should draw: a part with nothing behind it (no futures anywhere, no rebate ever credited) is left
/// out, and Other goes on holding whatever the parts do not explain.
pub fn desk_shape(cfg: &Config, accounts: &[P::Account], days: &[P::DayPnl]) -> P::Desk {
    let moved = |v: Option<f64>| v.is_some_and(|x| x != 0.0);
    let perp_cfg = cfg.accounts.iter().chain(&cfg.master).any(|a| a.futures());
    let perps = perp_cfg || accounts.iter().any(|a| !a.positions.is_empty() || a.fut_wallet != 0.0);
    // something hedges: a perp account whose market hedges unless told otherwise, an instrument named as a hedge, a
    // position in one. A desk whose every perp is traded has the columns and tabs of futures, and no Hedge figure.
    let venues: Vec<Venue> = cfg.accounts.iter().chain(&cfg.master).flat_map(|a| a.markets.iter().copied().filter(|v| !v.is_spot())).collect();
    let wallet_hedges = accounts.iter().any(|a| a.fut_wallet != 0.0) && cfg.venues().any(|v| !v.is_spot() && cfg.roles.market(v) == P::InstRole::Hedge);
    P::Desk {
        currency: cfg.currency.clone(),
        quote: cfg.quote().into(),
        markets: cfg.venues().map(Venue::market).collect(),
        roles: cfg.roles.clone(),
        perps,
        hedge: cfg.roles.any_hedge(&venues)
            || wallet_hedges
            || cfg.target_ratio.is_some()
            || accounts.iter().any(|a| a.hedge_value != 0.0 || a.positions.iter().any(|p| !cfg.roles.traded(&p.symbol, p.venue)))
            || days.iter().any(|d| moved(d.hedge)),
        rebates: accounts.iter().any(|a| a.rebates != 0.0) || days.iter().any(|d| moved(d.rebates)),
        mm: cfg.market_making,
        earlier: None,
    }
}

pub type DeskRef = Rc<RefCell<Desk>>;
type Series3 = (Vec<i64>, Vec<f64>, Vec<f64>);

/// The P&L book over these accounts: a position is a balance or a perp's position across them, its scope the configured
/// instruments the book keeps, those filled today (`filled`) and the traded perps held, and what it knows of a perp's day
/// the accounts' sweep of it.
pub fn pnl_book(cfg: &Config, accounts: &[AccountRef], filled: Rc<RefCell<Vec<String>>>, day_start: i64, beta: pnl::BetaFn) -> PnlBook {
    let accts = accounts.to_vec();
    let balance = move |k: &str| -> f64 {
        match k.split_once(':') {
            None => accts.iter().map(|a| a.borrow().balances.get(k).map_or(0.0, |(f, l)| f + l)).sum(),
            // an account's positions are on its one perp market
            Some((venue, symbol)) => accts.iter().map(|a| a.borrow()).filter(|a| a.perp.as_str() == venue).map(|a| a.positions.get(symbol).map_or(0.0, |p| p.0)).sum(),
        }
    };
    let keys: Vec<String> = cfg.markets.iter().filter(|m| cfg.roles.booked(&m.symbol, m.venue)).map(|m| crate::market::key(&m.symbol, m.venue)).collect();
    let (accts, roles) = (accounts.to_vec(), cfg.roles.clone());
    // a traded perp held with no fill today is in scope, as equity has it: its move would otherwise read as Other
    let scope = move || -> Vec<String> {
        let mut out: Vec<String> = keys.iter().cloned().chain(filled.borrow().iter().cloned()).collect();
        for a in &accts {
            let a = a.borrow();
            out.extend(a.positions.iter().filter(|(s, p)| p.0 != 0.0 && roles.traded(s, a.perp)).map(|(s, _)| crate::market::key(s, a.perp)));
        }
        out
    };
    let accts = accounts.to_vec();
    let perp_day = move |k: &str, _upto: i64| -> pnl::PerpDay {
        let (venue, symbol) = k.split_once(':').unwrap_or(("", k));
        let mut out = pnl::PerpDay::default();
        for a in accts.iter().filter(|a| a.borrow().perp.as_str() == venue) {
            let d = a.borrow().perp_day(symbol);
            out.funding += d.funding;
            out.m0 = out.m0.or(d.m0);
        }
        out
    };
    let accts = accounts.to_vec();
    let taker = move |inst: &Inst| -> f64 {
        accts
            .iter()
            .map(|a| {
                let a = a.borrow();
                a.fee(inst.venue, &inst.symbol).or_else(|| a.fee(inst.venue, "*")).unwrap_or((0.0, 0.0)).1
            })
            .fold(0.0, f64::max)
            * 1e4
    };
    let mut book = PnlBook::new(day_start, Box::new(balance), Box::new(scope), beta, cfg.beta_vs.clone(), Some(Box::new(taker)));
    book.roles = cfg.roles.clone();
    book.perp_day = Box::new(perp_day);
    book
}

/// A day's real-money split: day PnL, Π split FIFO, the hedge legs, the rebates and what they leave unexplained.
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
    #[serde(default)]
    pub rebates: Option<f64>,
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
    /// the last logged gaps between Π's quantities and the balances (check_positions)
    pub position_gaps: String,
    pub exchanges: Exchanges,
    pub store: Rc<Store>,
    pub alerts: RefCell<Alerts>,
    pub engines: Vec<EngineScraperRef>,
    pub public_feeds: Vec<FeedRef>,
    pub day_start: Rc<Cell<i64>>,
    /// which stored money is in the desk's currency
    pub money: crate::store::Series,
    pub series: Vec<P::SeriesPoint>,
    /// market making and the hedge legs' P&L at each series point (the day chart's bars draw them)
    /// per series point: mm, hedge, quoting
    series_x: Vec<(Option<f64>, Option<f64>, Option<f64>)>,
    /// the minute bars from this minute on go out with the next tick (a minute has closed)
    new_bars: Option<i64>,
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
    pub streams: Vec<Rc<dyn PublicFeed>>,
    pub betas: Option<Rc<RefCell<Betas>>>,
    pub accounts: Vec<AccountRef>,
    pub view: Option<View>,
    pub hub: RefCell<Hub>,
    pub market: MarketRef,
    pub fills: Rc<RefCell<FillBook>>,
    pub transfers: TransfersRef,
    pub pnl: Rc<RefCell<PnlBook>>,
    pub book_filled: Rc<RefCell<Vec<String>>>,   // instruments the P&L book keeps filled today: in its scope (a set, insertion order)
    pub fixed_betas: Rc<HashMap<String, f64>>,
    pub on_fill: OnFill,
}

fn dummy_pnl(day_start: i64) -> PnlBook {
    PnlBook::new(day_start, Box::new(|_| 0.0), Box::new(Vec::new), Box::new(|_| 1.0), None, None)
}

/// Python's `repr(float)` closely enough for the kv store (read back with float()).
fn repr(x: f64) -> String {
    format!("{x:?}")
}

fn pnl_flush(pnl: &RefCell<PnlBook>, store: &Store, money: &crate::store::Series) {
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
    store.put(Row::Kv(money.key(&format!("pnlstate:{ds}")), serde_json::to_string(&state).expect("state serializes")));
}

impl Desk {
    fn new(cfg: Config, market: Market, exchanges: Exchanges, public_feeds: Vec<FeedRef>) -> Desk {
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
        let book_filled: Rc<RefCell<Vec<String>>> = Rc::default();
        let roles = cfg.roles.clone();
        let on_fill: OnFill = {
            let (fills, market, tracked, book_filled, pnl) =
                (fills.clone(), market.clone(), tracked.clone(), book_filled.clone(), pnl.clone());
            Rc::new(move |f: FillRec| {
                let key = f.key();
                // a conversion between stablecoins is kept on the tape, out of the P&L scope and Π
                let booked = (roles.booked(&f.symbol, f.venue) && !f.conversion()).then(|| f.clone());
                let mut m = market.borrow_mut();
                // a fill that arrives late (a REST sweep) is not marked against today's fair
                let fresh = CLOCK.now() - f.ts < 5_000;
                if fills.borrow_mut().add(&mut m, f, fresh) {
                    tracked.borrow_mut().insert(key.clone());
                    if let Some(f) = booked {
                        let mut sf = book_filled.borrow_mut();
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
            position_gaps: String::new(),
            exchanges,
            alerts: RefCell::new(alerts),
            engines: cfg.engines.iter().map(|e| Rc::new(RefCell::new(EngineScraper::new(e.clone())))).collect(),
            public_feeds,
            day_start: Rc::new(Cell::new(day_start)),
            money: crate::store::Series::one(&cfg.numeraire.asset),
            series: vec![],
            series_x: vec![],
            new_bars: None,
            agg: None,
            mm: Rc::default(),
            held: 0,
            day_real: std::collections::BTreeMap::new(),
            new_series: vec![],
            acct_series: HashMap::new(),
            new_acct: HashMap::new(),
            fill_protos: HashMap::new(),
            tracked,
            streams: vec![],
            betas: cfg.beta.clone().map(|b| Rc::new(RefCell::new(Betas::new(b)))),
            accounts: vec![],
            view: None,
            // compute and push at 8 Hz: the pages move with the market
            hub: RefCell::new({
                let mut h = Hub::new();
                h.set_every(1);
                h
            }),
            market,
            fills,
            transfers: Rc::new(RefCell::new(Transfers::new(None, vec![]))),
            pnl,
            book_filled,
            fixed_betas: Rc::default(),
            on_fill,
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
        let mut out: Vec<FeedRef> = self.streams.iter().flat_map(|s| s.feeds()).collect();
        out.extend(self.public_feeds.iter().cloned());
        for a in &self.accounts {
            let a = a.borrow();
            out.extend(a.feeds.iter().cloned());
            out.push(a.rest_feed.clone());
        }
        // the master's transfers: only an exchange with a master has that feed to show
        if !self.cfg.simulate && self.cfg.venues().any(|v| v.market().wallet) {
            out.push(self.transfers.borrow().feed.clone());
        }
        out.extend(self.engines.iter().map(|e| e.borrow().feed.clone()));
        out
    }

    // setup

    /// Each instrument the market comes to track is watched by the public feed of its market's connector.
    fn make_streams(&mut self) {
        let mut routes: Vec<Option<Rc<dyn PublicFeed>>> = vec![None; Venue::COUNT];
        for c in self.exchanges.iter() {
            let streams = c.public_feed(self.market.clone());
            for v in c.markets() {
                routes[v.index()] = Some(streams.clone());
            }
            self.streams.push(streams);
        }
        self.market.borrow_mut().on_new = Box::new(move |inst| {
            if let Some(s) = &routes[inst.venue.index()] {
                s.watch(inst);
            }
        });
    }

    fn make_accounts(&mut self) {
        let mut accounts: Vec<AccountRef> = vec![];
        if self.cfg.simulate {
            accounts = sim::accounts(sim::Plan::of(&self.cfg.exchanges[0])).into_iter().map(Account::shared).collect();
        } else {
            let read = |ac: &C::AccountCfg| match self.exchanges.named(&ac.exchange) {
                Some(c) => c.credentials(ac),
                None => Err(format!("no connector for exchange {:?}", ac.exchange)),
            };
            let master_ok = self.cfg.master.as_ref().is_some_and(|m| read(m).is_ok());
            let cfgs: Vec<C::AccountCfg> = self.cfg.master.iter().cloned().chain(self.cfg.accounts.iter().cloned()).collect();
            for ac in cfgs {
                let (creds, readable, reason) = match read(&ac) {
                    Ok(c) => (c, true, String::new()),
                    Err(r) => {
                        warn!("account {}: {r}", ac.id);
                        (None, false, r)
                    }
                };
                let use_master = !readable && ac.role != Role::Master && !ac.email.is_empty() && master_ok;
                let mut acct = Account::new(ac, creds, &reason);
                acct.readable = readable;
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
        let store = self.store.clone();
        let on_fee_change: OnFeeChange = Rc::new(move |a: &Account, venue: Venue, symbol: &str, since: Option<i64>| {
            let k = format!("feechg:{}:{venue}:{symbol}", a.id);
            store.put(since.map_or(Row::KvDel(k.clone()), |t| Row::Kv(k, t.to_string())));
        });
        let store = self.store.clone();
        let on_dividend: OnDividend = Rc::new(move |a: &Account, id: &str, d: &Dividend| {
            store.put(Row::Dividend(DividendRow {
                id: format!("{}:{id}", a.id),
                ts: d.ts,
                account: a.id.clone(),
                asset: d.asset.clone(),
                amount: d.amount,
                info: d.info.clone(),
            }));
        });
        let roles = Rc::new(self.cfg.roles.clone());
        for a in &accounts {
            let mut a = a.borrow_mut();
            a.roles = roles.clone();
            // an account is asked about the symbols of its own exchange
            let exchange = a.cfg.exchange.clone();
            let mine = || self.cfg.markets.iter().filter(|m| m.venue.on(&exchange));
            if a.cfg.futures() {
                a.perp_symbols = mine().filter(|m| !m.venue.is_spot() && self.cfg.roles.traded(&m.symbol, m.venue)).map(|m| m.symbol.clone()).collect();
            }
            let spot_symbols: Vec<String> = mine().filter(|m| m.venue.is_spot()).map(|m| m.symbol.clone()).collect();
            a.market = Some(self.market.clone());
            a.on_fill = self.on_fill.clone();
            a.on_fee = on_fee.clone();
            a.on_fee_change = on_fee_change.clone();
            a.on_dividend = on_dividend.clone();
            a.spot_symbols = spot_symbols;
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
                usd: r.usd,
            }));
        });
        self.transfers = Rc::new(RefCell::new(t));
        let mut m = self.market.borrow_mut();
        let mut tracked = self.tracked.borrow_mut();
        for mc in &self.cfg.markets {
            let id = m.ensure(&mc.symbol, mc.venue, mc.reference.as_ref().map(|r| (r.symbol.as_str(), r.venue)));
            m.keep_fine(id);   // the markout path's pre-fill and sub-second mids
            tracked.insert(m.insts[id].key.clone());
            if let Some(r) = m.insts[id].ref_ {
                tracked.insert(m.insts[r].key.clone());
            }
        }
        // the stablecoins' USDT pairs (USDCUSDT, ...) from the start: equity and transfers value a stablecoin
        // other than USDT at its pair's price, which must be there before one arrives
        for a in crate::market::STABLES {
            m.asset_inst(a);
        }
        // and what a perp account's wallet is counted in: asked for from then on with no way to make one
        if !m.numeraire.par {
            for a in &self.accounts {
                m.asset_inst(a.borrow().perp.market().settle);
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
        let (betas, fixed) = (self.betas.clone(), self.fixed_betas.clone());
        let beta = move |k: &str| -> f64 {
            match &betas {
                Some(b) => b.borrow().beta(k),
                None => fixed.get(k).copied().unwrap_or(1.0),
            }
        };
        pnl_book(&self.cfg, &self.accounts, self.book_filled.clone(), self.day_start(), Box::new(beta))
    }

    fn reload(&mut self) -> Result<()> {
        let ds = self.day_start();
        self.money = self.store.series(self.cfg.quote(), &self.cfg.numeraire.asset, CLOCK.now()).context("store series")?;
        let mut data = self.store.load(ds, (DAYS_SHOWN as i64 + 1) * 24).context("store load")?;
        // money in another currency stays stored and is not read; the hour the currency changed in starts again
        data.equity.retain(|r| self.money.has(r.t));
        data.hours.retain(|r| self.money.has(r.t));
        *self.fills.borrow_mut() = FillBook::new();
        *self.pnl.borrow_mut() = self.new_pnl_book();
        {
            let mut t = self.transfers.borrow_mut();
            for r in &data.transfers {
                t.records.insert(r.id.clone(), Transfer {
                    ts: r.ts,
                    frm: r.from_email.clone(),
                    to: r.to_email.clone(),
                    asset: r.asset.clone(),
                    amount: r.amount,
                    usd: r.usd,
                });
            }
        }
        {
            let mut m = self.market.borrow_mut();
            let mut fills = self.fills.borrow_mut();
            let mut tracked = self.tracked.borrow_mut();
            let mut sf = self.book_filled.borrow_mut();
            for f in data.fills {
                let key = f.key();
                let booked = self.cfg.roles.booked(&f.symbol, f.venue) && !f.conversion();
                // a traded perp filled today, flat now: its day is still swept, for fills the stream did not give
                if !f.venue.is_spot() && booked
                    && let Some(a) = self.accounts.iter().find(|a| a.borrow().id == f.account)
                {
                    a.borrow_mut().traded.insert(key.clone());
                }
                fills.add(&mut m, f, false);
                tracked.insert(key.clone());
                if booked && !sf.contains(&key) {
                    sf.push(key);
                }
            }
            // marks the desk was down for: the backfill task asks klines for them (until then out of market making)
            let due = fills.mark_needs(CLOCK.now()).len();
            if due > 0 {
                info!("{due} fills reloaded with marks due and missing: queued for the kline backfill");
            }
            let mut pnl = self.pnl.borrow_mut();
            pnl.load_fills(&mut m, fills.fills.iter());
            // today's transfers of the desk's assets, as valued then (rows not valued yet are booked once they are)
            pnl.load_flows(&mut m, &self.transfers.borrow().desk_flows(ds.max(self.money.from())));
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
            let state = data.kv.get(&self.money.key(&format!("pnlstate:{ds}"))).and_then(|s| match serde_json::from_str::<PnlState>(s) {
                Ok(v) => Some(v),
                Err(e) => {
                    warn!("pnlstate:{ds}: {e}");
                    None
                }
            });
            let legacy: Option<Value> = data.kv.get(&self.money.key(&format!("pnlsym:{ds}"))).and_then(|s| serde_json::from_str(s).ok());
            pnl.load_state(state, legacy.as_ref());
            // the grid was live where desk rows carry its P&L (rows from before it existed have none)
            let ts: Vec<i64> = data.equity.iter().filter(|r| r.account == "*" && r.trading.is_some()).map(|r| r.t).collect();
            pnl.clip_live(&alive_spans(&ts, ALIVE_STEP_MS, ALIVE_GAP_MS));
            for f in fills.take_dirty() {
                self.fill_protos.insert(f.id.clone(), f.proto());
            }
        }
        self.alerts.borrow_mut().load(&data.alerts);
        let mut days: Vec<(&str, usize, &String)> = data.kv.iter().filter_map(|(k, v)| self.money.day_key(k).map(|(d, n)| (d, n, v))).collect();
        days.sort_by_key(|x| x.1);
        for (day, _, v) in days {
            match serde_json::from_str::<DayReal>(v) {
                Ok(d) => {
                    self.day_real.insert(day.to_string(), d);
                }
                Err(e) => warn!("dayreal:{day}: {e}"),
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
                // a change seen before the restart keeps its clock
                if parts.len() == 4 && parts[0] == "feechg" && parts[1] == a.id
                    && let Ok(venue) = parts[2].parse::<Venue>()
                    && let Ok(t) = v.parse::<i64>()
                {
                    a.fee_changed.insert((venue, parts[3].to_string()), t);
                }
            }
        }
        for r in &data.equity {
            if r.account == "*" {
                if r.t.rem_euclid(5000) == 0 {
                    self.series_x.push((r.mm, r.hedge, r.quoting));
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
            let pre = format!("{}:", a.id);
            for r in data.dividends.iter().filter(|r| r.id.starts_with(&pre)) {
                let id = r.id[pre.len()..].to_string();
                let rebate = self.exchanges.named(&a.cfg.exchange).is_some_and(|c| c.is_rebate(&r.info));
                a.dividends.insert(id, Dividend { ts: r.ts, asset: r.asset.clone(), amount: r.amount, info: r.info.clone(), rebate });
            }
            if let Some(v) = data.kv.get(&self.money.key(&format!("open:{}:{ds}", a.id))).and_then(|v| v.parse::<f64>().ok()) {
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
            {
                let m = self.market.borrow();
                let unit = |f: &FillRec| m.find(&f.symbol, f.venue).and_then(|i| m.unit(i)).unwrap_or(1.0);
                self.agg = Some((now, Rc::new(aggregate_in(&self.fills.borrow().fills, now, &self.cfg.roles, unit))));
            }
            let pnl = self.pnl.borrow();
            let mut m = self.market.borrow_mut();
            self.mm = Rc::new(mm_split(&mut m, &self.fills.borrow().fills, self.cfg.mm_horizon_s, now, &self.cfg.roles, |b| pnl.pos.contains_key(b)));
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
        ps.mm_unmarked_fills = mm.unmarked;
        ps.mm_unmarked_notional = mm.unmarked_notional;
        ps.inventory = ps.trading - mm.total;
        let hj = crate::fills::HK.iter().position(|k| *k == self.cfg.mm_horizon_s.to_string()).unwrap_or(2);
        ps.edge = mm.own.edge;
        ps.carry = ps.trading - mm.own.edge;
        ps.quoting = mm.own.quoting[hj];
        ps.holding = ps.trading - ps.quoting;
        ps.quoting_curve = mm.own.quoting.to_vec();
        let spot_legs = pnl.hedge_legs(&mut m, i64::MAX);
        expo.hedge_day = Some(hedge_day(&self.cfg, &m, &self.accounts, ps.ref_hedge, ps.factor_hedge, spot_legs));
        let pnl_day: f64 = accounts.iter().zip(&valued).filter(|(_, v)| **v).map(|(r, _)| r.pnl_day).sum();
        let rebates: f64 = accounts.iter().zip(&valued).filter(|(_, v)| **v).map(|(r, _)| r.rebates).sum();
        let equity: f64 = accounts.iter().zip(&valued).filter(|(_, v)| **v).map(|(r, _)| r.equity).sum();
        let rf = self.series.iter().rev().find(|p| p.t <= now - HOUR).or(self.series.first());
        let ds = self.day_start();
        let (fills_24h, volume_24h) = pnl.last_24h(now);
        let summary = P::Summary {
            equity,
            pnl_day,
            pnl_1h: rf.map_or(pnl_day, |r| pnl_day - r.pnl_day),
            rebates,
            other: expo.hedge_day.as_ref().and_then(|h| h.hedge_pnl).map(|h| pnl_day - ps.trading - h - rebates),
            pnl: ps,
            markout_net_bps_1h: agg.mk10_1h.value(),
            fills_1h: agg.fills_1h,
            fills_day: agg.fills_day,
            volume_day: agg.volume_day,
            fills_24h,
            volume_24h,
            inventory_value: expo.spot_value,
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
        // the split is kept only while the P&L grid is on the desk's day: across the roll one of them is still on
        // the other day (the grid rolls a couple of seconds after the desk, later when the loop stalls), and the
        // kept day would mix the new day's Π with the ending day's Day PnL and market making (2026-10-19 was kept
        // with Π −1.43 and Other +22.40 where its last row had Π +25.89 and Other −3.50)
        if let Some(h) = expo.hedge_day.as_ref()
            && pnl.day_start == ds
        {
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
                rebates: Some(rebates),
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
                d.rebates = r.rebates;
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
        let mut desk = desk_shape(&self.cfg, &accounts, &days);
        desk.earlier = self.money.earlier().map(|(until, currency)| P::Earlier { until, currency });
        self.view = Some(View {
            now,
            desk,
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

    /// The snapshot of the current view (computed by the caller): the newest MAX_FILLS of today's fills, the
    /// series and account points in full, and the minute bars.
    pub fn snapshot(&self) -> P::Snapshot {
        let mut s = self.snapshot_with(P::MAX_FILLS, i64::MIN);
        s.series = self.series.clone();
        s
    }

    /// The WebSocket's snapshot and what it leaves out: the newest `WS_FILLS` fills, the last `WS_SERIES_MS`
    /// of the series (the minute bars hold the day before it), the last `WS_ACCOUNT_MS` of each account.
    pub fn snapshot_ws(&self) -> (P::Snapshot, P::Older) {
        let now = self.view.as_ref().expect("view computed").now;
        let acct_from = now - P::WS_ACCOUNT_MS;
        let mut s = self.snapshot_with(P::WS_FILLS, acct_from);
        let from = self.series.partition_point(|p| p.t < now - P::WS_SERIES_MS);
        s.series = self.series[from..].to_vec();
        let older = P::Older {
            fills: self.recent_fills(P::MAX_FILLS).into_iter().skip(P::WS_FILLS).collect(),
            account_series: self.account_series_in(i64::MIN, acct_from),
        };
        (s, older)
    }

    /// The newest `n` of today's fills, newest first.
    fn recent_fills(&self, n: usize) -> Vec<P::Fill> {
        let fb = self.fills.borrow();
        let k = fb.fills.len();
        fb.fills[k.saturating_sub(n)..]
            .iter()
            .rev()
            .map(|f| self.fill_protos.get(&f.id).cloned().unwrap_or_else(|| f.proto()))
            .collect()
    }

    /// The view, the newest `fills` fills, each account's points from `acct_from`, every minute bar; no series.
    fn snapshot_with(&self, fills: usize, acct_from: i64) -> P::Snapshot {
        let v = self.view.as_ref().expect("view computed");
        P::Snapshot {
            now: v.now,
            desk: v.desk.clone(),
            summary: v.summary.clone(),
            accounts: v.accounts.clone(),
            symbols: v.symbols.clone(),
            fills: self.recent_fills(fills),
            series: vec![],
            exposure: v.exposure.clone(),
            engines: v.engines.clone(),
            alerts: v.alerts.clone(),
            feeds: v.feeds.clone(),
            markouts: v.markouts.clone(),
            orders: v.orders.clone(),
            days: v.days.clone(),
            hours: v.hours.clone(),
            account_series: self.account_series_in(acct_from, i64::MAX),
            bars: self.day_bars(i64::MIN),
        }
    }

    /// Today's minute bars from `from`'s minute on: each minute's last series point, and the notional filled in it.
    pub fn day_bars(&self, from: i64) -> P::DayBars {
        day_bars(&self.series, &self.series_x, &self.fills.borrow().fills, from)
    }

    /// Today's per-account equity and day PnL on a 45 s grid, the points in [from, to).
    pub fn account_series_in(&self, from: i64, to: i64) -> Vec<P::AccountSeries> {
        self.accounts
            .iter()
            .filter_map(|a| {
                let id = a.borrow().id.clone();
                self.acct_series.get(&id).map(|s| {
                    let (a, b) = (s.0.partition_point(|t| *t < from), s.0.partition_point(|t| *t < to));
                    P::AccountSeries { account: id, t: s.0[a..b].to_vec(), equity: s.1[a..b].to_vec(), pnl_day: s.2[a..b].to_vec() }
                })
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
        for mut f in dirty {
            if f.fee_usd.is_none() {
                f.fee_usd = Some(if f.fee != 0.0 && !f.fee_asset.is_empty() { f.fee * self.market.borrow_mut().asset_price(&f.fee_asset).unwrap_or(0.0) } else { 0.0 });
            }
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
            self.transfers.borrow_mut().value(&mut m, now);
            let tr = self.transfers.borrow();
            // a transfer before the currency changed is in the opening equity it left behind
            let since = ds.max(self.money.from());
            {
                // Π books the same transfers Day PnL takes off; it waits for its own day roll, a couple of
                // seconds after the desk's
                let mut pnl = self.pnl.borrow_mut();
                if pnl.day_start == ds {
                    pnl.set_flows(&mut m, &tr.desk_flows(since), now);
                }
            }
            let mut tracked = self.tracked.borrow_mut();
            for a in &self.accounts {
                let mut a = a.borrow_mut();
                let td = tr.net_in_live(&a, since);
                a.transfers_day = td;
                a.day_start = ds;
                a.equity_mark = if a.can_open(&mut m) { Some((now, a.equity(&mut m))) } else { None };
                if let Some(eo) = a.take_opening(&mut m, tr.ready()) {
                    self.store.put(Row::Kv(self.money.key(&format!("open:{}:{ds}", a.id)), repr(eo)));
                }
                for (s, (amt, _)) in &a.positions {
                    if *amt != 0.0 {
                        tracked.insert(crate::market::key(s, a.perp));
                    }
                }
                for o in a.open.values() {
                    tracked.insert(format!("{}:{}", o.venue, o.symbol));
                }
                a.expire_fees(now);
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
                !(a.readable || self.cfg.simulate) || a.valued(&mut m)
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
        let prev = self.series.last().map(|l| l.t);
        if prev.is_some_and(|l| l >= t) {
            return;
        }
        if let Some(prev) = prev
            && t.div_euclid(MINUTE) > prev.div_euclid(MINUTE)
        {
            // a minute closed: its bar, and the few before it (fills that came late), go out
            self.new_bars = Some(prev - prev.rem_euclid(MINUTE) - (BARS_RESENT - 1) * MINUTE);
        }
        let hedge = v.exposure.hedge_day.as_ref().and_then(|h| h.hedge_pnl).filter(|_| fresh);
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
            hedge,
            mm: some(s.pnl.mm),
            rebates: some(s.rebates),
            edge: some(s.pnl.edge),
            quoting: some(s.pnl.quoting),
        }));
        let mut rows = vec![];
        {
            let mut m = self.market.borrow_mut();
            for ((r, e), a) in v.accounts.iter().zip(&v.exposure.by_account).zip(&self.accounts) {
                if a.borrow().valued(&mut m) {
                    rows.push((r.id.clone(), r.equity, r.pnl_day, e.spot_value, e.futures_notional));
                }
            }
        }
        self.series.push(p.clone());
        self.series_x.push((some(s.pnl.mm), hedge, some(s.pnl.quoting)));
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
            self.store.put(Row::Kv(self.money.key(&format!("dayreal:{day}")), v));
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
        self.series_x.clear();
        self.new_bars = None;
        self.acct_series.clear();
        self.new_acct.clear();
        self.transfers.borrow_mut().roll(ds);
        let mut m = self.market.borrow_mut();
        for a in &self.accounts {
            let mut a = a.borrow_mut();
            a.transfers_day = 0.0;
            a.dividends.retain(|_, d| d.ts >= ds);
            if a.no_order_counts {
                a.orders_1d = 0;
            }
            // the equity at the day start, not at this tick (a second or more later): what was made in between
            // (fills, funding at the day start) is the new day's, as Π and the hedge legs count it
            let now_eq = if a.can_open(&mut m) { Some(a.equity(&mut m)) } else { None };
            a.equity_open = opening_equity(a.equity_mark, ds, now_eq);
            a.funding_stream.retain(|x| x.0 >= ds);
            if let Some(eo) = a.equity_open {
                self.store.put(Row::Kv(self.money.key(&format!("open:{}:{ds}", a.id)), repr(eo)));
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
                    a.readable || a.via_master || self.cfg.simulate
                })
                .collect();
            let valued = !readable.is_empty() && readable.iter().all(|a| a.borrow().valued(&mut m));
            let scope = (self.pnl.borrow().scope)();
            let priced = scope.iter().all(|k| m.get(k).is_none_or(|i| i.mid().is_some()));
            if valued && (priced || now_s() - self.started > 60.0) {
                let mut p = self.pnl.borrow_mut();
                p.begin(&mut m, now);
                let inv: f64 = p.pos.values().map(|x| x.q * m.px(x.inst).unwrap_or(0.0)).sum();
                info!("P&L grid started: {} instruments, inventory {inv:.2} {}", p.pos.len(), self.cfg.currency);
            }
            return;
        }
        {
            let mut m = self.market.borrow_mut();
            self.pnl.borrow_mut().step(&mut m, now);
        }
        if n.is_multiple_of(60 * TICKS_1S) {
            self.check_positions();
            pnl_flush(&self.pnl, &self.store, &self.money);
            self.put_day_real(self.day_start());
            self.put_order_counts();
        }
    }

    /// Π's quantities against the accounts' balances, once a minute: a gap (a fill Π missed or booked twice,
    /// across a restart) makes the Day PnL's Other move with that asset's price. Logged when it changes.
    fn check_positions(&mut self) {
        let mut bal: HashMap<String, f64> = HashMap::new();
        for a in &self.accounts {
            let a = a.borrow();
            for (asset, (f, l)) in &a.balances {
                *bal.entry(asset.clone()).or_insert(0.0) += f + l;
            }
            for (s, (amt, _)) in &a.positions {
                *bal.entry(crate::market::key(s, a.perp)).or_insert(0.0) += amt;
            }
        }
        let gaps = {
            let mut m = self.market.borrow_mut();
            self.pnl.borrow().position_gaps(&mut m, &bal, 2.0)
        };
        let text = gaps.iter().map(|(b, q, x)| format!("{b} {q} vs {x}")).collect::<Vec<_>>().join(", ");
        if text != self.position_gaps {
            if text.is_empty() {
                info!("P&L positions match the balances again");
            } else {
                tracing::warn!("P&L position differs from the balance (Π vs accounts): {text}");
            }
            self.position_gaps = text;
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
        let bars = self.new_bars.take().map(|from| self.day_bars(from)).unwrap_or_default();
        let v = self.view.as_ref().expect("view");
        let patch = Patch {
            desk: &v.desk,
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
        self.hub.borrow_mut().tick(&patch, &dirty, &series, &acct, &bars, || {
            let (s, o) = self.snapshot_ws();
            (P::encode(&s), P::encode(&o))
        });
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
    fn snapshot(&self) -> (Vec<u8>, Vec<u8>) {
        let mut d = self.0.borrow_mut();
        if d.view.is_none() {
            d.compute(true);
        }
        let (s, o) = d.snapshot_ws();
        (P::encode(&s), P::encode(&o))
    }

    fn snapshot_full(&self) -> Vec<u8> {
        let mut d = self.0.borrow_mut();
        if d.view.is_none() {
            d.compute(true);
        }
        P::encode(&d.snapshot())
    }

    fn health(&self) -> DeskHealth {
        self.0.borrow().health()
    }

    fn markouts(&self, q: &crate::markouts::Query) -> Option<Vec<u8>> {
        let d = self.0.borrow();
        let fills = d.fills.borrow();
        Some(P::encode(&crate::markouts::report(&fills.fills, q, CLOCK.now(), d.day_start())))
    }
}

// tasks

/// An exchange's clock and what it lists, its feed saying how that went.
async fn read_exchange(connector: &dyn Connector, feed: &FeedRef) -> Result<crate::market::Info> {
    let r: Result<_> = async {
        connector.sync_clock().await?;
        connector.instruments().await
    }
    .await;
    match &r {
        Ok(_) => feed.borrow_mut().set_up(true, Some(&format!("clock offset {} ms", connector.clock().offset_ms()))),
        Err(e) => {
            // network at startup: keep trying
            let d: String = format!("{e:#}").chars().take(200).collect();
            feed.borrow_mut().set_up(false, Some(&d));
            warn!("bootstrap of {} failed: {e:#}", connector.id());
        }
    }
    r
}

/// How long a desk waits at startup for an exchange that does not answer, once another has.
const BOOT_WAIT: Duration = Duration::from_secs(60);

/// The market, once every exchange has said what it lists; or, past BOOT_WAIT with at least one that has, without the
/// others (their indices returned for `late_exchange`), so one exchange down does not keep the rest off the page.
async fn bootstrap(exchanges: &Exchanges, feeds: &[FeedRef], cfg: &Config) -> (Market, Vec<usize>) {
    let started = std::time::Instant::now();
    let all: Vec<&Rc<dyn Connector>> = exchanges.iter().collect();
    let mut info = crate::market::Info::new();
    let mut missing: Vec<usize> = (0..all.len()).collect();
    loop {
        let mut still = vec![];
        for i in missing {
            match read_exchange(&**all[i], &feeds[i]).await {
                Ok(x) => info.extend(x),
                Err(_) => still.push(i),
            }
        }
        missing = still;
        if missing.is_empty() || (missing.len() < all.len() && started.elapsed() >= BOOT_WAIT) {
            let mut m = Market::new(info, cfg.fair_halflife_s, cfg.mark_max_spread_bps);
            m.numeraire = cfg.numeraire.clone();
            return (m, missing);
        }
        tokio::time::sleep(Duration::from_secs(5)).await;
    }
}

/// A currency something on the desk has no way to: refused, where it would read as 0 for ever. With an exchange still to
/// answer there may yet be one, so it is only said.
fn check_currency(market: &mut Market, cfg: &Config, all_read: bool) -> Result<()> {
    let mut assets: Vec<&str> = cfg.accounts.iter().chain(&cfg.master).filter(|a| a.futures()).map(|a| a.perp().market().settle).collect();
    assets.extend(cfg.exchanges.iter().filter_map(|e| Venue::of(e).next()).map(|v| v.market().quote));
    let quotes: Vec<String> = cfg.markets.iter().filter_map(|mc| market.info.get(&mc.venue).and_then(|i| i.get(&mc.symbol)).map(|i| i.quote.clone())).collect();
    assets.extend(quotes.iter().map(String::as_str));
    let none = market.unpriced(assets);
    if none.is_empty() {
        return Ok(());
    }
    let say = format!("desk.currency {}: nothing listed on {} prices {} in it", cfg.numeraire.asset, cfg.exchanges.join(", "), none.join(", "));
    if all_read {
        anyhow::bail!(say);
    }
    warn!("{say}, with an exchange still to answer");
    Ok(())
}

/// An exchange that was down when the desk started: its listing joins the market when it comes back.
async fn late_exchange(market: MarketRef, connector: Rc<dyn Connector>, feed: FeedRef) {
    loop {
        tokio::time::sleep(Duration::from_secs(30)).await;
        if let Ok(info) = read_exchange(&*connector, &feed).await {
            market.borrow_mut().add_info(info);
            info!("{}: listing read", connector.id());
            return;
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
        (v.parse::<Venue>().unwrap_or(Venue::USDM), s.to_string(), bb.cfg.sample_s)
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

/// Book streams may only send on a change: price instruments that have not ticked yet from the exchange's list of tops.
async fn seed_books(market: MarketRef, connector: Rc<dyn Connector>) {
    loop {
        for venue in connector.markets() {
            let unseen: Vec<String> = market.borrow().insts.iter().filter(|i| i.t.is_none() && i.venue == venue).map(|i| i.symbol.clone()).collect();
            if unseen.is_empty() {
                continue;
            }
            let rows = match connector.book_tops(venue, &unseen).await {
                Ok(r) => r,
                Err(e) => {
                    warn!("seed {venue} books: {e:#}");
                    continue;
                }
            };
            let mut m = market.borrow_mut();
            for (sym, b, a) in &rows {
                if let Some(id) = m.find(sym, venue)
                    && m.insts[id].t.is_none()
                    && *b > 0.0
                    && *a > 0.0
                {
                    m.on_book(venue, &Book::new(sym, *b, *a, None));
                }
            }
        }
        tokio::time::sleep(Duration::from_secs(60)).await;
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

/// Past days kept from before the desk read rebates: each account's rebates of the day, once (the day then
/// keeps them), and Other less them. A day an account cannot be asked about is left for the next start.
/// One request at a time, 2 s apart, a minute after the start.
async fn rebate_days(desk: DeskRef, keyed: Vec<AccountRef>) {
    tokio::time::sleep(Duration::from_secs(60)).await;
    let (days, start_min, exchanges) = {
        let d = desk.borrow();
        let today = crate::pnl::utc_day(d.day_start());
        let days: Vec<String> = d.day_real.iter().filter(|(k, r)| r.rebates.is_none() && **k != today).map(|(k, _)| k.clone()).collect();
        (days, d.cfg.day_start_min, d.exchanges.clone())
    };
    for day in days {
        let Ok(date) = chrono::NaiveDate::parse_from_str(&day, "%Y-%m-%d") else { continue };
        let ds = date.and_hms_opt(0, 0, 0).expect("midnight").and_utc().timestamp_millis() + start_min * 60_000;
        let mut sum = 0.0;
        let mut all = true;
        for a in &keyed {
            let exchange = a.borrow().cfg.exchange.clone();
            let Some(connector) = exchanges.named(&exchange) else { continue };
            match connector.distributions(a, ds, ds + DAY).await {
                Ok(rows) => sum += accounts::past_rebates(a, &rows),
                Err(e) => {
                    warn!("rebates of {day}, {}: {e:#}", a.borrow().id);
                    all = false;
                }
            }
            tokio::time::sleep(Duration::from_secs(2)).await;
        }
        if !all {
            continue;
        }
        let mut d = desk.borrow_mut();
        if let Some(r) = d.day_real.get_mut(&day) {
            r.rebates = Some(sum);
            r.other = r.other.map(|o| o - sum);
            info!("rebates of {day}: {sum:.2} {}", d.cfg.currency);
        }
        d.put_day_real(ds);
    }
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
    let plan = sim::Plan::of(&cfg.exchanges[0]);
    if cfg.simulate {
        sim::set_up(&mut cfg, plan);
    }
    let mut sig = Box::pin(shutdown_signal());
    let http = crate::connector::client();
    let public_feeds: Vec<FeedRef> = cfg.exchanges.iter().enumerate()
        .map(|(i, e)| Feed::shared(if i == 0 { "public rest".to_string() } else { format!("{e} rest") }, FeedKind::Rest, ""))
        .collect();
    let exchanges = Exchanges::open(&cfg.exchanges, &http, &public_feeds.iter().cloned().map(Some).collect::<Vec<_>>())?;
    let (mut market, late) = tokio::select! {
        m = bootstrap(&exchanges, &public_feeds, &cfg) => m,
        _ = &mut sig => return Ok(()),
    };
    check_currency(&mut market, &cfg, late.is_empty())?;
    let desk: DeskRef = Rc::new(RefCell::new(Desk::new(cfg, market, exchanges.clone(), public_feeds.clone())));
    {
        let mut d = desk.borrow_mut();
        d.make_streams();
        d.make_accounts();
        d.reload()?;
        d.store.start().context("store")?;
    }
    let mut tasks: Vec<JoinHandle<()>> = vec![];
    let (simulate, listen) = {
        let d = desk.borrow();
        (d.cfg.simulate, d.cfg.listen.clone())
    };
    {
        let d = desk.borrow();
        if simulate {
            let mut s = sim::Sim::new(&d, plan);
            s.setup(&d);
            tasks.push(tokio::task::spawn_local(s.run()));
        } else {
            for c in exchanges.iter() {
                let mine: Vec<AccountRef> = d.accounts.iter().filter(|a| a.borrow().cfg.exchange.eq_ignore_ascii_case(c.id())).cloned().collect();
                tasks.extend(c.start_accounts(&mine, &d.transfers, d.day_start.clone()));
            }
        }
        for e in &d.engines {
            tasks.push(tokio::task::spawn_local(engine::run(e.clone(), http.clone())));
        }
    }
    if !simulate {
        let d = desk.borrow();
        let keyed: Vec<AccountRef> = d.accounts.iter().filter(|a| a.borrow().readable).cloned().collect();
        tasks.push(tokio::task::spawn_local(rebate_days(desk.clone(), keyed)));
    }
    tasks.push(tokio::task::spawn_local(ticker(desk.clone())));
    for c in exchanges.iter() {
        tasks.push(tokio::task::spawn_local(c.keep_clock()));
        tasks.push(tokio::task::spawn_local(seed_books(desk.borrow().market.clone(), c.clone())));
    }
    for i in late {
        let c = exchanges.iter().nth(i).expect("an exchange of this desk").clone();
        tasks.push(tokio::task::spawn_local(late_exchange(desk.borrow().market.clone(), c, public_feeds[i].clone())));
    }
    tasks.push(tokio::task::spawn_local(prune(desk.clone())));
    if !simulate {
        let d = desk.borrow();
        let (pnl, store, money) = (d.pnl.clone(), d.store.clone(), d.money.clone());
        tasks.push(tokio::task::spawn_local(backfill::run((d.pnl.clone(), d.market.clone()), (d.fills.clone(), d.market.clone()),
                                                          exchanges.clone(), || CLOCK.now(), move || pnl_flush(&pnl, &store, &money))));
    }
    if desk.borrow().betas.is_some() {
        tasks.push(tokio::task::spawn_local(beta_loop(desk.clone())));
    }
    let requests = desk.borrow().hub.borrow_mut().take_requests().expect("requests taken once");
    tasks.push(tokio::task::spawn_local(server::answer(requests, Source(desk.clone()))));
    let handle = desk.borrow().hub.borrow().handle();
    let history = {
        let d = desk.borrow();
        crate::history::Api::new(d.cfg.db.clone(), d.cfg.day_start_min, d.exchanges.kline_source())
            .retention(d.cfg.keep_fine_days, d.cfg.keep_days)
            .roles(d.cfg.roles.clone())
            .money(d.money.clone())
            .mm_horizon(d.cfg.mm_horizon_s)
    };
    history.warm();
    // the engine's own figures, pushed from its box (its token in BNDESK_INGEST_TOKEN)
    let telemetry = crate::telemetry::Telemetry::open(&desk.borrow().cfg.db, std::env::var("BNDESK_INGEST_TOKEN").ok())
        .context("engine telemetry db")?;
    // agents' reads of all of it (`BNDESK_READ_TOKEN`, or the session)
    let agent = crate::agent::Agent::new(history.clone(), telemetry.clone(), handle.clone(), desk.borrow().cfg.mm_horizon_s);
    let extra = crate::telemetry::routes(telemetry).merge(crate::agent::routes(agent));
    let app = server::make_app_with(&handle, auth, server::web_dist(), history, extra);
    let srv = server::serve(&handle, app, &listen).await.with_context(|| format!("listen {listen}"))?;
    info!("listening on http://{} (simulate={simulate})", srv.addr);
    sig.await;
    for t in &tasks {
        t.abort();
    }
    for s in &desk.borrow().streams {
        s.stop();
    }
    srv.cleanup().await;
    let d = desk.borrow();
    if d.pnl.borrow().started() {
        pnl_flush(&d.pnl, &d.store, &d.money);
        d.put_order_counts();
        d.put_day_real(d.day_start());
    }
    d.store.close();
    info!("stopped");
    Ok(())
}

#[derive(Parser, Debug)]
#[command(name = "desk", about = "Read-only multi-account desk monitor")]
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
    #[command(subcommand)]
    cmd: Option<Cmd>,
}

#[derive(clap::Subcommand, Debug)]
enum Cmd {
    /// Recompute past days' market making with the missed 60 s marks backfilled from klines (see recompute.rs),
    /// then exit
    RecomputeMm {
        /// first day, YYYY-MM-DD (UTC date of the day start)
        #[arg(long)]
        from: String,
        /// last day, YYYY-MM-DD
        #[arg(long)]
        to: String,
        /// print what would change, write nothing
        #[arg(long)]
        dry_run: bool,
    },
    /// Rebuild a past day's desk rows from --from to --to (HH:MM): the gaps the desk could not write filled, the
    /// split of the rows there recomputed from the day's fills (see repair.rs), then exit
    RepairDay {
        /// the day, YYYY-MM-DD (UTC date of the day start)
        #[arg(long)]
        day: String,
        #[arg(long)]
        from: String,
        #[arg(long, default_value = "24:00")]
        to: String,
        /// take the kept day's hedge from the recompute too (the desk counted its legs wrongly that day)
        #[arg(long)]
        hedge: bool,
        /// print what would change, write nothing
        #[arg(long)]
        dry_run: bool,
        /// the rows as written, to this CSV
        #[arg(long)]
        csv: Option<String>,
    },
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
    if let Some(Cmd::RecomputeMm { from, to, dry_run }) = &args.cmd {
        if let Err(e) = rt.block_on(crate::recompute::run(&cfg, from, to, *dry_run)) {
            eprintln!("{e:#}");
            std::process::exit(1);
        }
        return;
    }
    if let Some(Cmd::RepairDay { day, from, to, hedge, dry_run, csv }) = &args.cmd {
        if let Err(e) = rt.block_on(crate::repair::run(&cfg, day, from, to, *hedge, *dry_run, csv.as_deref())) {
            eprintln!("{e:#}");
            std::process::exit(1);
        }
        return;
    }
    let local = tokio::task::LocalSet::new();
    if let Err(e) = local.block_on(&rt, run(cfg)) {
        eprintln!("{e:#}");
        std::process::exit(1);
    }
}

/// A day's opening equity: the last 1 s mark before the day start `ds` when it is at most ROLL_MARK_MS old, else
/// the equity at the roll's tick (`now`, None while unvalued).
fn opening_equity(mark: Option<(i64, f64)>, ds: i64, now: Option<f64>) -> Option<f64> {
    match mark {
        Some((t, v)) if t < ds && ds - t <= ROLL_MARK_MS => Some(v),
        _ => now,
    }
}

/// Minute bars from `from`'s minute on: each minute's last point of `series` (with its `x`: market making,
/// hedge), money in cents, and the notional of `fills` in the minute (conversions between stablecoins left out).
fn day_bars(series: &[P::SeriesPoint], x: &[(Option<f64>, Option<f64>, Option<f64>)], fills: &[FillRec], from: i64) -> P::DayBars {
    let cents = |v: f64| (v * 100.0).round() / 100.0;
    let mut b = P::DayBars::default();
    let start = series.partition_point(|p| p.t < from.saturating_sub(from.rem_euclid(MINUTE)));
    for (p, (mm, hedge, quoting)) in series[start..].iter().zip(&x[start..]) {
        let m = p.t - p.t.rem_euclid(MINUTE);
        if b.t.last() != Some(&m) {
            b.t.push(m);
            b.trading.push(None);
            b.mm.push(None);
            b.quoting.push(None);
            b.hedge.push(None);
            b.equity.push(0.0);
            b.pnl_day.push(0.0);
            b.inventory.push(0.0);
            b.futures.push(0.0);
        }
        let i = b.t.len() - 1;
        b.equity[i] = cents(p.equity);
        b.pnl_day[i] = cents(p.pnl_day);
        b.trading[i] = p.trading.map(cents).or(b.trading[i]);
        b.mm[i] = mm.map(cents).or(b.mm[i]);
        b.quoting[i] = quoting.map(cents).or(b.quoting[i]);
        b.hedge[i] = hedge.map(cents).or(b.hedge[i]);
        b.inventory[i] = cents(p.inventory);
        b.futures[i] = cents(p.futures_notional);
    }
    let first = b.t.first().copied().unwrap_or(i64::MAX);
    let mut vol: HashMap<i64, f64> = HashMap::new();
    for f in fills.iter().filter(|f| f.ts >= first && !f.conversion()) {
        *vol.entry(f.ts - f.ts.rem_euclid(MINUTE)).or_default() += f.notional();
    }
    b.volume = b.t.iter().map(|t| cents(vol.get(t).copied().unwrap_or(0.0))).collect();
    b
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_part_with_nothing_behind_it_is_left_out() {
        let mut cfg = Config::default();
        let mut acct = P::Account::default();
        let d = desk_shape(&cfg, std::slice::from_ref(&acct), &[]);
        assert_eq!(d, P::Desk { currency: "USDT".into(), quote: "USDT".into(), markets: P::MARKETS[..2].iter().collect(), roles: P::Roles::default(), perps: false, hedge: false, rebates: false, mm: true, earlier: None });
        // a day kept with zeros is not a hedge or a rebate
        let zero = P::DayPnl { hedge: Some(0.0), rebates: Some(0.0), ..Default::default() };
        assert!(!desk_shape(&cfg, &[], std::slice::from_ref(&zero)).hedge);
        // futures on any account, a position held, a kept day's figure
        let kept = P::DayPnl { hedge: Some(-1.0), rebates: Some(0.5), ..Default::default() };
        let d = desk_shape(&cfg, &[], std::slice::from_ref(&kept));
        assert!(d.hedge && d.rebates);
        // a desk whose perps are all traded has futures and no hedge, unless one instrument hedges
        cfg.roles.set_market(P::Venue::USDM, P::InstRole::Traded);
        let mut held = P::Account { fut_wallet: 5.0, ..Default::default() };
        held.positions.push(P::Position { symbol: "AUSDT".into(), venue: P::Venue::USDM, amt: 1.0, ..Default::default() });
        let mut c2 = cfg.clone();
        let mut b = crate::config::AccountCfg::new("b", "b", "", P::Role::Sub);
        b.markets.push(P::Venue::USDM);
        c2.accounts.push(b);
        let d = desk_shape(&c2, std::slice::from_ref(&held), &[]);
        assert!(d.perps && !d.hedge);
        c2.roles.set("HUSDT", P::Venue::USDM, P::InstRole::Hedge);
        assert!(desk_shape(&c2, std::slice::from_ref(&held), &[]).hedge);
        cfg.roles = P::Roles::default();
        acct.fut_wallet = 5.0;
        acct.rebates = 0.1;
        let d = desk_shape(&cfg, std::slice::from_ref(&acct), &[]);
        assert!(d.hedge && d.rebates);
        let mut a = crate::config::AccountCfg::new("a", "a", "", P::Role::Sub);
        a.markets.push(P::Venue::USDM);
        cfg.accounts.push(a);
        assert!(desk_shape(&cfg, &[], &[]).hedge);
    }
    use crate::protocol::Side;

    #[test]
    fn day_bars_take_each_minutes_last_point() {
        let pt = |t: i64, pnl: f64, trading: Option<f64>| P::SeriesPoint { t, pnl_day: pnl, equity: 100.0 + pnl, trading, ..Default::default() };
        let series = [pt(60_000, 1.004, Some(0.5)), pt(65_000, 2.0, None), pt(125_000, 3.333, Some(1.0)), pt(185_000, 4.0, Some(2.0))];
        let x = [(Some(0.1), None, None), (None, Some(-1.0), None), (Some(0.2), Some(-2.0), Some(0.3)), (None, None, None)];
        let fill = |ts: i64| FillRec::new("f", ts, "a", "S", Venue::SPOT, Side::Buy, 2.0, 1.5);
        let fills = [fill(61_000), fill(70_000), fill(130_000), fill(10_000)];
        let b = day_bars(&series, &x, &fills, i64::MIN);
        assert_eq!(b.t, [60_000, 120_000, 180_000]);
        assert_eq!(b.pnl_day, [2.0, 3.33, 4.0]);
        assert_eq!(b.equity, [102.0, 103.33, 104.0]);
        // a null leaves the minute's last value standing
        assert_eq!(b.trading, [Some(0.5), Some(1.0), Some(2.0)]);
        assert_eq!(b.mm, [Some(0.1), Some(0.2), None]);
        assert_eq!(b.hedge, [Some(-1.0), Some(-2.0), None]);
        assert_eq!(b.volume, [6.0, 3.0, 0.0]);
        let b = day_bars(&series, &x, &fills, 150_000);
        assert_eq!((b.t, b.volume), (vec![120_000, 180_000], vec![3.0, 0.0]));
    }

    #[test]
    fn the_day_opens_at_the_last_mark_before_its_start() {
        let ds = 86_400_000;
        // the roll ran late, after fills and funding at the day start had moved the equity
        assert_eq!(opening_equity(Some((ds - 800, 1_000.0)), ds, Some(1_004.0)), Some(1_000.0));
        // a mark from after the start, or too old (the desk was stalled or restarted), is not the start's
        assert_eq!(opening_equity(Some((ds + 200, 1.0)), ds, Some(2.0)), Some(2.0));
        assert_eq!(opening_equity(Some((ds - ROLL_MARK_MS - 1, 1.0)), ds, Some(2.0)), Some(2.0));
        assert_eq!(opening_equity(None, ds, None), None);
    }

    #[test]
    fn transfer_in_flight_between_accounts_is_held() {
        use super::in_flight;
        assert!(in_flight(&[(-380.7, Some(3.4)), (386.6, Some(2.7)), (1.0, Some(0.9))], 50.0));
        assert!(!in_flight(&[(3.8, Some(3.4)), (2.2, Some(2.7))], 50.0));
        assert!(!in_flight(&[(-80.0, Some(3.0)), (2.0, Some(2.0))], 50.0));
        assert!(!in_flight(&[(-380.7, None), (386.6, None)], 50.0));
    }

    /// A desk that changes currency reads none of what was stored in the old one, and all of it again if it changes back.
    #[test]
    fn a_desk_that_changes_currency_starts_a_new_series() {
        let dir = tempfile::tempdir().unwrap();
        let db = dir.path().join("d.db");
        let ds = sessions::day_start(now_ms(), 0);
        let yesterday = crate::pnl::utc_day(ds - DAY);
        {
            let c = crate::store::open(&db).unwrap();
            let t = (now_ms() - 60_000).max(ds + 5000);
            let t = t - t.rem_euclid(5000);
            c.execute("INSERT INTO equity (t, account, equity, pnl_day, markout_pnl, inventory, futures_notional) VALUES (?, '*', 1000, 5, 0, 0, 0)", [t]).unwrap();
            c.execute("INSERT INTO kv VALUES (?, '990')", [format!("open:a:{ds}")]).unwrap();
            c.execute("INSERT INTO kv VALUES (?, ?)", rusqlite::params![format!("dayreal:{yesterday}"), serde_json::to_string(&DayReal { pnl_day: 7.0, ..Default::default() }).unwrap()]).unwrap();
        }
        let desk = |asset: &str, par: bool| -> Desk {
            let mut cfg = Config { db: db.clone(), currency: asset.into(), numeraire: crate::market::Numeraire { asset: asset.into(), par }, ..Default::default() };
            cfg.accounts = vec![C::AccountCfg::new("a", "a", "", Role::Sub)];
            let mut m = Market::new(Default::default(), 120.0, 100.0);
            m.numeraire = cfg.numeraire.clone();
            let mut d = Desk::new(cfg, m, Exchanges::open_once(&["binance".to_string()]).unwrap(), vec![]);
            d.make_accounts();
            d.reload().unwrap();
            d
        };
        // unchanged: as it was
        let d = desk("USDT", true);
        assert_eq!((d.series.len(), d.day_real[&yesterday].pnl_day, d.accounts[0].borrow().equity_open), (1, 7.0, Some(990.0)));
        assert!(d.money.earlier().is_none());
        drop(d);
        // in euros: nothing of it, and the desk says since when
        let d = desk("EUR", false);
        assert!(d.series.is_empty() && d.day_real.is_empty() && d.accounts[0].borrow().equity_open.is_none());
        let (until, was) = d.money.earlier().unwrap();
        assert!(until > ds - DAY && was == "USDT");
        // what it stores goes under its own keys
        assert_eq!(d.money.key("open:a:1"), "open:a:1#1");
        drop(d);
        let c = crate::store::open(&db).unwrap();
        c.execute("INSERT INTO kv VALUES (?, ?)", rusqlite::params![format!("dayreal:{yesterday}#1"), serde_json::to_string(&DayReal { pnl_day: 1.0, ..Default::default() }).unwrap()]).unwrap();
        // the stored rows are as they were
        let n: i64 = c.query_row("SELECT count(*) FROM equity", [], |r| r.get(0)).unwrap();
        assert_eq!(n, 1);
        // back: the old series reads again, the euros' does not, and today opens anew for the new span
        let d = desk("USDT", true);
        assert_eq!((d.series.len(), d.day_real[&yesterday].pnl_day, d.accounts[0].borrow().equity_open), (1, 7.0, None));
    }
}
