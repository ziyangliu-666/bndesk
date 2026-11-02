//! Per-account state: balances, futures, orders and fees, as a connector reports them (`Account::apply`).
use std::cell::RefCell;
use std::collections::{BTreeMap, HashMap, HashSet, VecDeque};
use std::rc::Rc;

use crate::config::AccountCfg;
use crate::feeds::{Feed, FeedKind, FeedRef, now_ms};
use crate::fills::FillRec;
use crate::market::{Market, QUOTE, STABLES};
use crate::pnl::Flow;
use crate::protocol::{self as P, Role, Side, UserStream, Venue};
use crate::sign::Credentials;

pub const MOVE_HOLD_MS: i64 = 180_000;
pub const STALE_MS: i64 = 60_000;   // a stream value this much older than a REST request no longer outranks the REST one

pub type MarketRef = Rc<RefCell<Market>>;
pub type AccountRef = Rc<RefCell<Account>>;
/// Called with each fill seen on a user stream. Runs while the account is borrowed: must not borrow it.
pub type OnFill = Rc<dyn Fn(FillRec)>;
/// Called with each commission baseline per (venue, symbol): the first rate seen, or a change once held
/// `FEE_CHANGE_HOLD_MS`.
pub type OnFee = Rc<dyn Fn(&Account, Venue, &str, (f64, f64))>;
/// Called when a commission change is first seen (its time) and when it ends (None): back to the baseline,
/// or held long enough to become it.
pub type OnFeeChange = Rc<dyn Fn(&Account, Venue, &str, Option<i64>)>;
/// A commission change is reported this long from when it was seen, then becomes the baseline.
pub const FEE_CHANGE_HOLD_MS: i64 = 24 * 3_600_000;
/// Called once per new asset distribution (the store keeps them).
pub type OnDividend = Rc<dyn Fn(&Account, &str, &Dividend)>;

/// A resting order: (symbol, venue, side, price, qty left).
#[derive(Debug, Clone, PartialEq)]
pub struct Open {
    pub symbol: String,
    pub venue: Venue,
    pub side: Side,
    pub price: f64,
    pub left: f64,
}

/// A balance change apart from trading seen on a user stream (a transfer, seconds before the history shows
/// it): signed amount d of the asset at time t, valued once at px, the asset's USD price at t.
#[derive(Debug, Clone, PartialEq)]
pub struct Move {
    pub t: i64,
    pub asset: String,
    pub d: f64,
    pub px: Option<f64>,
}

impl Move {
    pub fn new(t: i64, asset: &str, d: f64) -> Self {
        Move { t, asset: asset.into(), d, px: None }
    }
}

/// An asset distribution credited to the account: a market-maker rebate, an airdrop, a staking reward. Trading
/// commissions do not show it, so Day PnL has it and Π does not. `rebate`, which the connector tells from its own
/// description of it, is the desk's Rebates line; the others are kept but stay in Other.
#[derive(Debug, Clone, PartialEq)]
pub struct Dividend {
    pub ts: i64,
    pub asset: String,
    pub amount: f64,
    pub info: String,
    pub rebate: bool,
}

/// What an exchange says about an account, however it says it. A connector reads its own JSON into these and
/// `Account::apply` holds what the desk does with them: which balance or position is newer than the one held (`u`,
/// an update time; `t0`, when a request went out) is decided here, not in a connector.
#[derive(Debug, Clone, PartialEq)]
pub enum Event {
    /// Free and locked of the assets named, as of `u`.
    Balances { u: i64, rows: Vec<(String, f64, f64)> },
    /// Every balance as of `u`: an asset absent is zero, an asset updated since keeps what it has.
    BalanceSnapshot { u: i64, rows: HashMap<String, (f64, f64)> },
    /// Every balance, from a read with no update time (through a parent account).
    BalancesRead { rows: Vec<(String, f64, f64)> },
    /// A balance change apart from trading.
    Move(Move),
    /// An order was placed at t, for a desk that counts them itself (`CountOrdersHere`).
    OrderPlaced { t: i64 },
    Order { venue: Venue, symbol: String, id: String, side: Side, price: f64, left: f64, open: bool, created: Option<i64> },
    /// Every order resting on a market: (symbol, id, side, price, left, open, created).
    #[allow(clippy::type_complexity)]
    OpenOrders { venue: Venue, rows: Vec<(String, String, Side, f64, f64, bool, Option<i64>)> },
    /// A fill as it happened; `perp_trade`, a perp's trade id: it also goes into the day of that symbol at once, since
    /// the position moves with it.
    Fill { fill: Box<FillRec>, perp_trade: Option<i64> },
    /// What a perp account's update carries, as of `u`: funding in USD for the one position held, transfers (asset,
    /// signed amount), the settlement asset's balance, and positions (symbol, amount, entry).
    PerpUpdate { u: i64, funding: Option<f64>, moves: Vec<(String, f64)>, settle: Option<f64>, positions: Vec<(String, f64, f64)> },
    /// The perp account read at `t0`: wallet in USD, of it the settlement asset's (balance, update time), and the
    /// positions (symbol, amount, entry, update time).
    PerpSnapshot { t0: i64, wallet: f64, settle: Option<(f64, i64)>, upnl: f64, available: f64, positions: Vec<(String, f64, f64, i64)> },
    /// The perp account's totals and its positions (symbol, amount, entry), from reads with no update time.
    PerpTotalsRead { wallet: f64, upnl: f64, available: f64 },
    PerpPositionsRead { rows: Vec<(String, f64, f64)> },
    /// A sweep of the day from `ds` begins: days before it go.
    PerpDayStart { ds: i64 },
    /// A symbol's day as swept; fills held that it does not list are newer than it and stay.
    PerpDay { symbol: String, day: FutDay },
    Fee { venue: Venue, symbol: String, maker: f64, taker: f64, now: i64 },
    /// The exchange's own order counts and limits: (count, limit) per 10 s and per day.
    OrderCounts { per_10s: Option<(i64, i64)>, per_day: Option<(i64, i64)> },
    /// The exchange will not give order counts to this key: count `OrderPlaced` against these limits.
    CountOrdersHere { per_10s: i64, per_day: i64 },
    Distribution { id: String, row: Dividend },
}

/// (symbol, amt, entry, mark, upnl, notional) at live marks.
#[derive(Debug, Clone, PartialEq)]
pub struct LivePosition {
    pub symbol: String,
    pub venue: Venue,
    pub amt: f64,
    pub entry: f64,
    pub mark: f64,
    pub upnl: f64,
    pub notional: f64,
}

/// One futures symbol's day: fills by trade id (time, signed qty, price, fee in USD), funding received, mark
/// at the start. REST fills the day in; the user stream adds each fill as it happens, so the fills always
/// match the live position until the next REST pass.
#[derive(Debug, Clone, PartialEq)]
pub struct FutDay {
    pub ds: i64,
    pub trades: BTreeMap<i64, (i64, f64, f64, f64)>,
    pub funding: f64,
    pub m0: Option<f64>,
    /// when the REST pass that gave `funding` asked for it (ms; 0 before any): stream funding from then on adds to it
    pub rest_t: i64,
}

impl FutDay {
    pub fn new(ds: i64) -> Self {
        FutDay { ds, trades: BTreeMap::new(), funding: 0.0, m0: None, rest_t: 0 }
    }
}

/// Today on one futures symbol: qty at the day start, qty now, mark at the start, mark now, fills,
/// price P&L, fees, funding.
#[derive(Debug, Clone, PartialEq)]
pub struct FutLeg {
    pub q0: f64,
    pub q: f64,
    pub m0: Option<f64>,
    pub mark: Option<f64>,
    pub fills: i64,
    pub price: Option<f64>,
    pub fees: f64,
    pub funding: f64,
}

fn venue_key(venue: Venue, x: impl std::fmt::Display) -> String {
    format!("{}:{x}", venue.as_str())
}

fn same_fee(a: (f64, f64), b: (f64, f64)) -> bool {
    (a.0 - b.0).abs() <= 1e-9 && (a.1 - b.1).abs() <= 1e-9
}

/// One account as the monitor sees it: balances, futures, orders, fees.
pub struct Account {
    pub cfg: AccountCfg,
    pub id: String,
    pub label: String,
    pub email: String,
    pub role: Role,
    pub creds: Option<Rc<Credentials>>,
    pub balances: HashMap<String, (f64, f64)>,
    // account update time (ms) of each asset's balance held: REST updateTime or stream u; a snapshot or
    // event older than what is held is not applied (a REST read can be overtaken by a fill on the stream)
    pub bal_u: HashMap<String, i64>,
    pub spot_loaded: bool,
    pub fut_loaded: bool,
    pub fut_wallet: f64,
    pub fut_upnl_rest: f64,
    pub fut_available: f64,
    pub fut_usdt: f64,     // USDT wallet balance inside fut_wallet, kept fresh from the stream
    pub fut_usdt_u: i64,   // its update time
    pub positions: HashMap<String, (f64, f64)>,   // symbol -> (amt, entry), on `perp`
    pub perp: Venue,                              // the market the account's positions are on
    pub pos_u: HashMap<String, i64>,              // symbol -> update time of the position held
    pub orders_10s: i64,
    pub orders_10s_limit: i64,
    pub orders_1d: i64,
    pub orders_1d_limit: i64,
    pub open: HashMap<String, Open>,       // venue:orderId -> order
    pub open_since: HashMap<String, i64>,  // venue:orderId -> creation time
    pub traded: HashSet<String>,           // venue:symbol filled or quoted
    pub fees: Vec<((Venue, String), (f64, f64))>,   // insertion-ordered like the Python dict
    pub first_fees: HashMap<(Venue, String), (f64, f64)>,   // the baseline a rate is compared with
    pub fee_changed: HashMap<(Venue, String), i64>,       // since when a rate differs from its baseline
    pub equity_open: Option<f64>,
    /// the equity at the last 1 s tick while valued (exchange ms, value): the next day opens at the one before it
    pub equity_mark: Option<(i64, f64)>,
    /// funding the futures stream reported (time, symbol, USD) since the day start: counts until REST has it
    pub funding_stream: Vec<(i64, String, f64)>,
    pub day_start: i64,                      // set by the desk; the futures day below is read from it
    pub fut_day: HashMap<String, FutDay>,
    /// spot symbols whose fills the desk tracks (set by the desk): a connector's sweep of the day's fills reads these
    pub spot_symbols: Vec<String>,
    // symbol -> today's futures fills, funding and opening mark
    pub transfers_day: f64,
    pub updated: i64,
    pub feeds: Vec<FeedRef>,
    pub rest_feed: FeedRef,
    pub on_fill: OnFill,
    pub on_fee: OnFee,
    pub on_fee_change: OnFeeChange,
    pub market: Option<MarketRef>,
    pub via_master: bool,
    pub moves: Vec<Move>,   // balance changes apart from trading, from the user streams
    pub dividends: BTreeMap<String, Dividend>,   // id -> today's asset distributions
    pub on_dividend: OnDividend,
    pub no_order_counts: bool,
    pub stream_limits: (i64, i64),   // with no_order_counts: orders per 10 s and per day
    pub new_ts: VecDeque<i64>,
}

impl Account {
    pub fn new(cfg: AccountCfg, creds: Option<Rc<Credentials>>, reason: &str) -> Self {
        let feeds: Vec<FeedRef> = cfg.markets.iter().map(|v| Feed::shared(format!("{} {v} user", cfg.id), FeedKind::User, "")).collect();
        let rest_feed = Feed::shared(format!("{} rest", cfg.id), FeedKind::Rest, "");
        if creds.is_none() {
            for f in feeds.iter().chain([&rest_feed]) {
                f.borrow_mut().detail = reason.to_string();
            }
        }
        Account {
            id: cfg.id.clone(),
            label: cfg.label.clone(),
            email: cfg.email.clone(),
            role: cfg.role,
            creds,
            balances: HashMap::new(),
            bal_u: HashMap::new(),
            spot_loaded: false,
            fut_loaded: !cfg.futures(),
            fut_wallet: 0.0,
            fut_upnl_rest: 0.0,
            fut_available: 0.0,
            fut_usdt: 0.0,
            fut_usdt_u: 0,
            positions: HashMap::new(),
            perp: cfg.perp(),
            pos_u: HashMap::new(),
            orders_10s: 0,
            orders_10s_limit: 0,
            orders_1d: 0,
            orders_1d_limit: 0,
            open: HashMap::new(),
            open_since: HashMap::new(),
            traded: HashSet::new(),
            fees: vec![],
            first_fees: HashMap::new(),
            fee_changed: HashMap::new(),
            equity_open: None,
            equity_mark: None,
            funding_stream: vec![],
            day_start: 0,
            fut_day: HashMap::new(),
            spot_symbols: vec![],
            transfers_day: 0.0,
            updated: 0,
            feeds,
            rest_feed,
            on_fill: Rc::new(|_| {}),
            on_fee: Rc::new(|_, _, _, _| {}),
            on_fee_change: Rc::new(|_, _, _, _| {}),
            market: None,
            via_master: false,
            moves: vec![],
            dividends: BTreeMap::new(),
            on_dividend: Rc::new(|_, _, _| {}),
            no_order_counts: false,
            stream_limits: (0, 0),
            new_ts: VecDeque::new(),
            cfg,
        }
    }

    pub fn shared(self) -> AccountRef {
        Rc::new(RefCell::new(self))
    }

    pub fn ready(&self) -> bool {
        self.spot_loaded && self.fut_loaded
    }

    /// Python's `valued` property (`self.market` passed in: the caller holds the market borrow).
    pub fn valued(&self, m: &mut Market) -> bool {
        self.ready() && self.spot_parts(m).3
    }

    /// Today's market-maker rebates, USD at each asset's price when credited.
    pub fn rebates(&self, m: &mut Market) -> f64 {
        self.dividends
            .values()
            .filter(|d| d.ts >= self.day_start && d.rebate)
            .map(|d| d.amount * m.asset_price_at(&d.asset, d.ts).or_else(|| m.asset_price(&d.asset)).unwrap_or(0.0))
            .sum()
    }

    /// Records a distribution not seen before.
    pub fn add_dividend(&mut self, id: &str, d: Dividend) {
        if !self.dividends.contains_key(id) {
            (self.on_dividend)(self, id, &d);
            self.dividends.insert(id.to_string(), d);
        }
    }

    /// Notional of resting (bids, asks).
    pub fn resting(&self) -> (f64, f64) {
        let (mut b, mut a) = (0.0, 0.0);
        for o in self.open.values() {
            if o.side == Side::Buy {
                b += o.price * o.left;
            } else {
                a += o.price * o.left;
            }
        }
        (b, a)
    }

    pub fn user_stream(&self) -> UserStream {
        if self.via_master {
            return UserStream::NA;
        }
        if self.feeds.iter().all(|f| f.borrow().up) { UserStream::Up } else { UserStream::Down }
    }

    /// Orders placed as seen on the user stream, where the exchange will not tell a read-only key its own count.
    /// Orders the exchange rejects never reach the stream, so this can read lower than its count.
    pub fn count_new(&mut self, t: i64) {
        if !self.no_order_counts {
            return;
        }
        self.new_ts.push_back(t);
        self.orders_1d += 1;
        self.trim_orders(t);
    }

    pub fn trim_orders(&mut self, now: i64) {
        if !self.no_order_counts {
            return;
        }
        while self.new_ts.front().is_some_and(|&t| t <= now - 10_000) {
            self.new_ts.pop_front();
        }
        let (l10, l1d) = self.stream_limits;
        (self.orders_10s, self.orders_10s_limit, self.orders_1d_limit) = (self.new_ts.len() as i64, l10, l1d);
    }

    /// No key of its own: balances and futures come from the master's sub-account endpoints;
    /// fills, orders and order counts need the account's own key.
    pub fn use_master(&mut self) {
        self.via_master = true;
        self.feeds = vec![];
        self.fut_loaded = false;
        self.rest_feed = Feed::shared(format!("{} via master", self.id), FeedKind::Rest, "");
    }

    // valuation

    /// (quote free, quote locked, inventory value, all priced). Quote = the stablecoins, in USDT: USDT at 1,
    /// another at its USDT pair's price (`Market::asset_price`, the price transfers are valued at too, so a
    /// stablecoin that comes in and is converted makes no P&L of its own); one whose pair is listed but not
    /// yet quoted holds the valuation back, like any asset.
    pub fn spot_parts(&self, m: &mut Market) -> (f64, f64, f64, bool) {
        let (mut qf, mut ql, mut inv) = (0.0, 0.0, 0.0);
        let mut priced = true;
        for (a, &(f, l)) in &self.balances {
            if STABLES.contains(&a.as_str()) {
                let px = if a == QUOTE {
                    1.0
                } else {
                    let inst = m.asset_inst(a);
                    let quoted = inst.and_then(|i| m.px(i)).is_some_and(|p| p > 0.0);
                    if !quoted && f + l != 0.0 {
                        priced = priced && inst.is_none_or(|i| now_ms() - m.insts[i].created > 30_000);
                    }
                    m.asset_price(a).unwrap_or(1.0)
                };
                qf += f * px;
                ql += l * px;
            } else if f + l > 0.0 {
                match m.asset_price(a) {
                    // wait briefly for a quote; then an unquoted asset counts as 0
                    None => {
                        let inst = m.asset_inst(a);
                        priced = priced && inst.is_none_or(|i| now_ms() - m.insts[i].created > 30_000);
                    }
                    Some(p) => inv += (f + l) * p,
                }
            }
        }
        (qf, ql, inv, priced)
    }

    /// (symbol, amt, entry, mark, upnl, notional) at live marks.
    pub fn live_positions(&self, m: &Market) -> Vec<LivePosition> {
        let mut out = vec![];
        for (s, &(amt, entry)) in &self.positions {
            if amt == 0.0 {
                continue;
            }
            let mark = m
                .find(s, self.perp)
                .and_then(|i| m.insts[i].mark.filter(|x| *x != 0.0).or_else(|| m.insts[i].mid()))
                .filter(|x| *x != 0.0)
                .unwrap_or(entry);
            out.push(LivePosition { symbol: s.clone(), venue: self.perp, amt, entry, mark, upnl: (mark - entry) * amt, notional: amt * mark });
        }
        out
    }

    /// Today on futures symbol s. Price P&L = Q0 (M_T - M_D) + sum s q (M_T - p): the same closed form as
    /// the spot Π; None while the opening mark is unknown and a position was held at the start.
    pub fn fut_leg(&self, m: &Market, s: &str) -> FutLeg {
        let q = self.positions.get(s).map_or(0.0, |p| p.0);
        let mark = m
            .find(s, self.perp)
            .and_then(|i| m.insts[i].mark.filter(|x| *x != 0.0).or_else(|| m.insts[i].mid()))
            .filter(|x| *x != 0.0);
        let Some(d) = self.fut_day.get(s).filter(|d| d.ds == self.day_start) else {
            return FutLeg { q0: q, q, m0: None, mark, fills: 0, price: None, fees: 0.0, funding: 0.0 };
        };
        let q0 = q - d.trades.values().map(|t| t.1).sum::<f64>();
        let fees = d.trades.values().map(|t| t.3).sum();
        let price = match mark {
            Some(mk) if d.m0.is_some() || q0.abs() < 1e-12 => Some(
                d.m0.map_or(0.0, |m0| q0 * (mk - m0)) + d.trades.values().map(|&(_, sq, px, _)| sq * (mk - px)).sum::<f64>(),
            ),
            _ => None,
        };
        // REST's funding as of its pass, and what the stream reported after it (REST picks that up within a minute)
        let streamed: f64 =
            self.funding_stream.iter().filter(|(t, sym, _)| sym == s && *t >= d.ds && *t >= d.rest_t).map(|x| x.2).sum();
        FutLeg { q0, q, m0: d.m0, mark, fills: d.trades.len() as i64, price, fees, funding: d.funding + streamed }
    }

    pub fn fut_upnl(&self, m: &Market) -> f64 {
        if self.positions.is_empty() {
            self.fut_upnl_rest
        } else {
            self.live_positions(m).iter().map(|p| p.upnl).sum()
        }
    }

    pub fn equity(&self, m: &mut Market) -> f64 {
        let (qf, ql, inv, _) = self.spot_parts(m);
        qf + ql + inv + self.fut_wallet + self.fut_upnl(m)
    }

    // updates (shared by live streams, REST and the simulator)

    /// Touch the market (instrument for an asset) unless the caller holds it borrowed.
    fn touch_asset(&self, a: &str) {
        if let Some(m) = &self.market
            && let Ok(mut m) = m.try_borrow_mut()
        {
            m.asset_inst(a);
        }
    }

    fn touch_symbol(&self, symbol: &str, venue: Venue) {
        if let Some(m) = &self.market
            && let Ok(mut m) = m.try_borrow_mut()
        {
            m.ensure(symbol, venue, None);
        }
    }

    pub fn set_balances<S: AsRef<str>>(&mut self, rows: impl IntoIterator<Item = (S, f64, f64)>, replace: bool) {
        if replace {
            self.balances.clear();
        }
        for (a, f, l) in rows {
            let a = a.as_ref();
            if f != 0.0 || l != 0.0 || !replace {
                self.balances.insert(a.to_string(), (f, l));
            }
            if a != QUOTE && f + l > 0.0 {
                self.touch_asset(a);
            }
        }
        self.updated = now_ms();
    }

    /// REST futures wallet: `total` includes the USDT balance `usdt` as of `u`; a newer USDT balance from
    /// the stream is kept (unless the stream's is a minute older than the request at t0: then REST wins).
    pub fn set_fut_wallet(&mut self, total: f64, usdt: f64, u: i64, t0: i64) {
        let other = total - usdt;
        if u >= self.fut_usdt_u || self.fut_usdt_u < t0 - STALE_MS {
            (self.fut_usdt, self.fut_usdt_u) = (usdt, u);
        }
        self.fut_wallet = other + self.fut_usdt;
    }

    /// u: update time of this position; an older one than held is ignored, unless what is held is a
    /// minute older than the REST request at t0 (a missed stream event must not pin a position).
    pub fn set_position(&mut self, symbol: &str, amt: f64, entry: f64, u: Option<i64>, t0: i64) {
        if let Some(u) = u {
            let held = self.pos_u.get(symbol).copied().unwrap_or(0);
            if u < held && held >= t0 - STALE_MS {
                return;
            }
            self.pos_u.insert(symbol.to_string(), u);
        }
        self.positions.insert(symbol.to_string(), (amt, entry));
        if amt != 0.0 {
            self.touch_symbol(symbol, self.perp);
        }
    }

    #[allow(clippy::too_many_arguments)]
    pub fn order_update(&mut self, venue: Venue, symbol: &str, oid: &str, side: Side, price: f64, left: f64, open: bool,
                        created: Option<i64>) {
        let k = venue_key(venue, oid);
        if open {
            self.open.insert(k.clone(), Open { symbol: symbol.to_string(), venue, side, price, left });
            self.open_since.entry(k).or_insert_with(|| created.filter(|c| *c != 0).unwrap_or_else(now_ms));
            self.traded.insert(venue_key(venue, symbol));
            self.touch_symbol(symbol, venue);
        } else {
            self.open.remove(&k);
            self.open_since.remove(&k);
        }
    }

    pub fn fee(&self, venue: Venue, symbol: &str) -> Option<(f64, f64)> {
        self.fees.iter().find(|((v, s), _)| *v == venue && s == symbol).map(|x| x.1)
    }

    /// A rate read at `now`. One that differs from the baseline is a change from now on, unless it is the
    /// rate already held: a change seen before a restart keeps its time, and one already there with no time
    /// counts from the first read after it.
    pub fn set_fee(&mut self, venue: Venue, symbol: &str, maker: f64, taker: f64, now: i64) {
        let v = (maker, taker);
        let prev = match self.fees.iter_mut().find(|((ve, s), _)| *ve == venue && s == symbol) {
            Some(x) => Some(std::mem::replace(&mut x.1, v)),
            None => {
                self.fees.push(((venue, symbol.to_string()), v));
                None
            }
        };
        let k = (venue, symbol.to_string());
        let Some(&base) = self.first_fees.get(&k) else {
            self.first_fees.insert(k, v);
            let cb = self.on_fee.clone();
            cb(self, venue, symbol, v);
            return;
        };
        let since = if same_fee(v, base) {
            None
        } else if prev.is_some_and(|p| !same_fee(p, v)) || !self.fee_changed.contains_key(&k) {
            Some(now)
        } else {
            return;   // the change already held
        };
        match since {
            Some(t) => {
                self.fee_changed.insert(k, t);
            }
            None if self.fee_changed.remove(&k).is_none() => return,
            None => {}
        }
        let cb = self.on_fee_change.clone();
        cb(self, venue, symbol, since);
    }

    /// Changes held `FEE_CHANGE_HOLD_MS` become the baseline.
    pub fn expire_fees(&mut self, now: i64) {
        let done: Vec<(Venue, String)> =
            self.fee_changed.iter().filter(|(_, t)| now - **t >= FEE_CHANGE_HOLD_MS).map(|(k, _)| k.clone()).collect();
        for k in done {
            let Some(v) = self.fee(k.0, &k.1) else { continue };   // not read since a restart: waits for it
            self.fee_changed.remove(&k);
            self.first_fees.insert(k.clone(), v);
            let (cb, cc) = (self.on_fee.clone(), self.on_fee_change.clone());
            cb(self, k.0, &k.1, v);
            cc(self, k.0, &k.1, None);
        }
    }

    pub fn fee_rows(&self) -> Vec<P::FeeRate> {
        let mut out = vec![];
        for venue in Venue::all() {
            let ks: Vec<_> = self.fees.iter().filter(|((v, _), _)| *v == venue).collect();
            if ks.is_empty() {
                continue;
            }
            let specific: Vec<_> = ks.iter().filter(|((_, s), _)| s != "*").collect();
            let (maker, taker) = specific.last().map_or_else(|| ks.last().unwrap().1, |x| x.1);
            let changed = ks.iter().any(|(k, v)| !same_fee(*v, self.first_fees.get(k).copied().unwrap_or(*v)));
            out.push(P::FeeRate { venue, maker_bps: maker * 1e4, taker_bps: taker * 1e4, changed });
        }
        out
    }

    // what a connector reports

    /// One thing the exchange said about this account. Runs while the account is borrowed (`on_fill` and the fee
    /// and distribution callbacks run inside it and must not borrow it).
    pub fn apply(&mut self, ev: Event) {
        match ev {
            Event::Balances { u, rows } => {
                let mut fresh = Vec::with_capacity(rows.len());
                for (a, f, l) in rows {
                    if u >= self.bal_u.get(&a).copied().unwrap_or(0) {
                        self.bal_u.insert(a.clone(), u);
                        fresh.push((a, f, l));
                    }
                }
                self.set_balances(fresh, false);
            }
            Event::BalanceSnapshot { u, rows } => {
                let assets: HashSet<String> = self.balances.keys().chain(rows.keys()).cloned().collect();
                for a in assets {
                    if self.bal_u.get(&a).copied().unwrap_or(0) > u {
                        continue;
                    }
                    let (f, l) = rows.get(&a).copied().unwrap_or((0.0, 0.0));
                    if f != 0.0 || l != 0.0 {
                        if a != QUOTE {
                            self.touch_asset(&a);
                        }
                        self.balances.insert(a.clone(), (f, l));
                    } else {
                        self.balances.remove(&a);
                    }
                    self.bal_u.insert(a, u);
                }
                self.updated = now_ms();
                self.spot_loaded = true;
            }
            Event::BalancesRead { rows } => {
                self.set_balances(rows, true);
                self.spot_loaded = true;
            }
            Event::Move(mv) => self.moves.push(mv),
            Event::OrderPlaced { t } => self.count_new(t),
            Event::Order { venue, symbol, id, side, price, left, open, created } => {
                self.order_update(venue, &symbol, &id, side, price, left, open, created);
            }
            Event::OpenOrders { venue, rows } => {
                let pre = format!("{venue}:");
                self.open.retain(|k, _| !k.starts_with(&pre));
                for (symbol, id, side, price, left, open, created) in rows {
                    self.order_update(venue, &symbol, &id, side, price, left, open, created);
                }
                let Account { open, open_since, .. } = self;
                open_since.retain(|k, _| open.contains_key(k));
            }
            Event::Fill { fill, perp_trade } => {
                self.traded.insert(venue_key(fill.venue, &fill.symbol));
                if let Some(id) = perp_trade {
                    self.fut_fill(&fill.symbol.clone(), id, &fill);
                }
                let cb = self.on_fill.clone();
                cb(*fill);
            }
            Event::PerpUpdate { u, funding, moves, settle, positions } => {
                let t = if u != 0 { u } else { now_ms() };
                if let Some(usd) = funding {
                    // no symbol on the event (a cross position sends the balance only): the one position held
                    let held: Vec<&String> = self.positions.iter().filter(|(_, (amt, _))| *amt != 0.0).map(|(s, _)| s).collect();
                    if let [sym] = held[..]
                        && usd != 0.0
                    {
                        let sym = sym.clone();
                        let ds = self.day_start;
                        self.funding_stream.retain(|x| x.0 >= ds);
                        self.funding_stream.push((t, sym, usd));
                    }
                }
                for (asset, d) in moves {
                    self.moves.push(Move::new(t, &asset, d));
                }
                if let Some(wb) = settle
                    && u >= self.fut_usdt_u
                {
                    self.fut_wallet += wb - self.fut_usdt;
                    (self.fut_usdt, self.fut_usdt_u) = (wb, u);
                }
                for (symbol, amt, entry) in positions {
                    self.set_position(&symbol, amt, entry, Some(u), 0);
                }
                self.updated = now_ms();
            }
            Event::PerpSnapshot { t0, wallet, settle, upnl, available, positions } => {
                match settle {
                    Some((balance, u)) => self.set_fut_wallet(wallet, balance, u, t0),
                    None => self.fut_wallet = wallet,
                }
                self.fut_upnl_rest = upnl;
                self.fut_available = available;
                let mut seen = HashSet::new();
                for (symbol, amt, entry, u) in positions {
                    self.set_position(&symbol, amt, entry, Some(u), t0);
                    seen.insert(symbol);
                }
                // a position absent from the snapshot is dropped unless the stream set it after the request went out
                let gone: Vec<String> = self
                    .positions
                    .keys()
                    .filter(|s| !seen.contains(*s) && self.pos_u.get(*s).copied().unwrap_or(0) < t0)
                    .cloned()
                    .collect();
                for s in gone {
                    self.positions.remove(&s);
                    self.pos_u.remove(&s);
                }
                self.fut_loaded = true;
                self.updated = now_ms();
            }
            Event::PerpTotalsRead { wallet, upnl, available } => {
                (self.fut_wallet, self.fut_upnl_rest, self.fut_available) = (wallet, upnl, available);
            }
            Event::PerpPositionsRead { rows } => {
                let seen: HashSet<String> = rows.iter().map(|r| r.0.clone()).collect();
                for (symbol, amt, entry) in rows {
                    self.set_position(&symbol, amt, entry, None, 0);
                }
                self.positions.retain(|s, _| seen.contains(s));
                self.fut_loaded = true;
                self.updated = now_ms();
            }
            Event::PerpDayStart { ds } => {
                if self.fut_day.values().any(|d| d.ds != ds) {
                    self.fut_day.clear();
                }
            }
            Event::PerpDay { symbol, mut day } => {
                // fills the stream added while the sweep was answering are newer than its list: kept
                if let Some(cur) = self.fut_day.get(&symbol).filter(|c| c.ds == day.ds) {
                    for (id, t) in &cur.trades {
                        day.trades.entry(*id).or_insert(*t);
                    }
                }
                self.fut_day.insert(symbol, day);
            }
            Event::Fee { venue, symbol, maker, taker, now } => self.set_fee(venue, &symbol, maker, taker, now),
            Event::OrderCounts { per_10s, per_day } => {
                if let Some((n, limit)) = per_10s {
                    (self.orders_10s, self.orders_10s_limit) = (n, limit);
                }
                if let Some((n, limit)) = per_day {
                    (self.orders_1d, self.orders_1d_limit) = (n, limit);
                }
            }
            Event::CountOrdersHere { per_10s, per_day } => {
                self.no_order_counts = true;
                self.stream_limits = (per_10s, per_day);
            }
            Event::Distribution { id, row } => self.add_dividend(&id, row),
        }
    }

    /// A user-stream futures fill into today's fills, at once: the position moves with it, so leaving it to the
    /// next REST pass would count it as held since the day start.
    fn fut_fill(&mut self, sym: &str, id: i64, f: &FillRec) {
        let ds = self.day_start;
        if ds == 0 || f.ts < ds {
            return;
        }
        let mut fee = f.fee;
        if !matches!(f.fee_asset.as_str(), "USDT" | "USDC" | "")
            && let Some(m) = &self.market
        {
            fee *= m.try_borrow_mut().ok().and_then(|mut m| m.asset_price(&f.fee_asset)).unwrap_or(0.0);
        }
        let d = self.fut_day.entry(sym.to_string()).or_insert_with(|| FutDay::new(ds));
        if d.ds != ds {
            *d = FutDay::new(ds);
        }
        let sq = if f.side == Side::Buy { f.qty } else { -f.qty };
        d.trades.entry(id).or_insert((f.ts, sq, f.price, fee));
    }

}

/// One transfer: (time, from email, to email, asset, amount), and its USD value, fixed when first
/// valued (the asset's price at the time, or the value of the stream move it confirms).
#[derive(Debug, Clone, PartialEq)]
pub struct Transfer {
    pub ts: i64,
    pub frm: String,
    pub to: String,
    pub asset: String,
    pub amount: f64,
    pub usd: Option<f64>,
}

/// Does the history record r confirm the stream move mv of the account with this (lowercase) email?
fn confirms(r: &Transfer, mv: &Move, email: &str) -> bool {
    (r.ts - mv.t).abs() < MOVE_HOLD_MS
        && r.asset == mv.asset
        && (r.amount - mv.d.abs()).abs() < 1e-9
        && (if mv.d > 0.0 { r.to.to_lowercase() } else { r.frm.to_lowercase() }) == email
}

/// A past day's distributions, as a connector read them: each goes to on_dividend (the store keeps it), and the rebates
/// are summed at the asset's price now (USDT at 1, another stablecoin at its USDT pair).
pub fn past_rebates(acct: &AccountRef, rows: &[(String, Dividend)]) -> f64 {
    let a = acct.borrow();
    let mut m = a.market.as_ref().map(|m| m.borrow_mut());
    let mut sum = 0.0;
    for (id, d) in rows {
        (a.on_dividend)(&a, id, d);
        if d.rebate {
            let px = m.as_mut().and_then(|m| m.asset_price(&d.asset)).or_else(|| STABLES.contains(&d.asset.as_str()).then_some(1.0));
            sum += d.amount * px.unwrap_or(0.0);
        }
    }
    sum
}

pub type TransfersRef = Rc<RefCell<Transfers>>;
/// Called once per new transfer record (the store keeps them).
pub type OnRecord = Rc<dyn Fn(&str, &Transfer)>;

/// What the master's key sees: transfers since the day start, as a connector finds them.
pub struct Transfers {
    pub loaded: bool,   // opening equity waits for the first history
    pub master: Option<AccountRef>,
    pub accounts: Vec<AccountRef>,
    pub feed: FeedRef,
    pub records: HashMap<String, Transfer>,
    pub on_record: OnRecord,
    pub sub_info: String,
}

impl Transfers {
    pub fn new(master: Option<AccountRef>, accounts: Vec<AccountRef>) -> Self {
        let (loaded, detail) = match &master {
            None => (true, "no [master] configured".to_string()),
            Some(m) => {
                let m = m.borrow();
                (m.creds.is_none(), m.rest_feed.borrow().detail.clone())
            }
        };
        Transfers {
            loaded,
            master,
            accounts,
            feed: Feed::shared("master transfers", FeedKind::Rest, detail),
            records: HashMap::new(),
            on_record: Rc::new(|_, _| {}),
            sub_info: String::new(),
        }
    }

    pub fn add(&mut self, tid: &str, rec: Transfer) {
        if !self.records.contains_key(tid) {
            (self.on_record)(tid, &rec);
            self.records.insert(tid.to_string(), rec);
        }
    }

    /// Match each stream move to at most one history leg and each history leg to
    /// at most one move. Prefer the nearest timestamp, with stable tie breakers.
    /// A same-account wallet transfer has two legs too: consuming only its incoming
    /// move through an equal external receipt would leave a false outgoing flow.
    fn matched_moves<'a>(&'a self, acct: &Account) -> Vec<Option<&'a str>> {
        let mut matched = vec![None; acct.moves.len()];
        let email = acct.email.to_lowercase();
        if email.is_empty() {
            return matched;
        }
        let mut candidates = vec![];
        for (id, r) in &self.records {
            for (i, mv) in acct.moves.iter().enumerate() {
                if mv.d != 0.0 && confirms(r, mv, &email) {
                    candidates.push(((r.ts - mv.t).abs(), r.ts, id.as_str(), i, mv.d > 0.0));
                }
            }
        }
        candidates.sort_unstable();
        let mut used = HashSet::new();
        for (_, _, id, i, incoming) in candidates {
            if matched[i].is_none() && used.insert((id, incoming)) {
                matched[i] = Some(id);
            }
        }
        matched
    }

    /// Values once what is not yet valued, and drops the stream moves past MOVE_HOLD_MS. A stream move takes
    /// its asset's price at its time; a record takes the price of a move it confirms, so a move confirmed
    /// later keeps its value, else its asset's price at its time (the price now when the market's ring does
    /// not reach back that far, as for rows stored before values were). A newly valued record goes to
    /// on_record, so the store keeps its value.
    pub fn value(&mut self, m: &mut Market, now: i64) {
        for a in &self.accounts {
            let mut a = a.borrow_mut();
            a.moves.retain(|mv| now - mv.t < MOVE_HOLD_MS);
            for mv in a.moves.iter_mut().filter(|mv| mv.px.is_none()) {
                mv.px = m.asset_price_at(&mv.asset, mv.t);
            }
        }
        let mut move_prices = HashMap::new();
        for a in &self.accounts {
            let a = a.borrow();
            for (mv, id) in a.moves.iter().zip(self.matched_moves(&a)) {
                if let (Some(id), Some(px)) = (id, mv.px) {
                    move_prices.entry(id.to_owned()).or_insert(px);
                }
            }
        }
        let mut ids: Vec<String> = self.records.iter().filter(|(_, r)| r.usd.is_none()).map(|(k, _)| k.clone()).collect();
        ids.sort();
        for id in ids {
            let r = &self.records[&id];
            let px = move_prices.get(&id).copied()
                .or_else(|| m.asset_price_at(&r.asset, r.ts));
            if let Some(px) = px {
                let r = self.records.get_mut(&id).expect("record");
                r.usd = Some(r.amount * px);
                (self.on_record)(&id, r);
            }
        }
    }

    /// The account's transfers since `since`, signed (+ in), at their fixed values: the history's records, and
    /// the stream moves no record confirms yet (provisional: sub-to-sub moves are matched by the history
    /// within a poll or two; a move between the account's own spot and futures shows on both streams and
    /// nets out; one never confirmed drops after MOVE_HOLD_MS). Without an email the history cannot confirm a
    /// move, so none is taken provisionally. Not yet valued: left out.
    pub fn legs(&self, acct: &Account, since: i64) -> Vec<Flow> {
        let email = acct.email.to_lowercase();
        if email.is_empty() {
            return vec![];
        }
        let mut out = vec![];
        for (id, r) in &self.records {
            let (frm, to) = (r.frm.to_lowercase(), r.to.to_lowercase());
            let Some(usd) = r.usd else { continue };
            if r.ts < since || frm == to || r.amount == 0.0 {
                continue;
            }
            let px = usd / r.amount;
            for (side, sign) in [(&to, 1.0), (&frm, -1.0)] {
                if *side == email {
                    out.push(Flow { key: format!("t:{id}"), ts: r.ts, asset: r.asset.clone(), qty: sign * r.amount, px });
                }
            }
        }
        for (mv, matched) in acct.moves.iter().zip(self.matched_moves(acct)) {
            let Some(px) = mv.px else { continue };
            if mv.t < since || matched.is_some_and(|id| self.records[id].usd.is_some()) {
                continue;
            }
            out.push(Flow { key: format!("m:{}:{}:{}:{}", acct.id, mv.t, mv.asset, mv.d), ts: mv.t, asset: mv.asset.clone(),
                            qty: mv.d, px });
        }
        out
    }

    /// Net transfers into the account since `since`, in USD at their fixed values (Day PnL takes them off).
    pub fn net_in_live(&self, acct: &Account, since: i64) -> f64 {
        self.legs(acct, since).iter().map(|l| l.qty * l.px).sum()
    }

    /// The desk's flows since `since`: every desk account's legs, netted by transfer, so a transfer between two
    /// of the desk's accounts nets to nothing. Π books these; their value is the sum of the accounts' net_in_live.
    pub fn desk_flows(&self, since: i64) -> Vec<Flow> {
        let mut by: BTreeMap<String, Flow> = BTreeMap::new();
        for a in &self.accounts {
            for l in self.legs(&a.borrow(), since) {
                match by.get_mut(&l.key) {
                    Some(f) => f.qty += l.qty,
                    None => {
                        by.insert(l.key.clone(), l);
                    }
                }
            }
        }
        by.into_values().filter(|f| f.qty.abs() > 1e-12).collect()
    }

    pub fn roll(&mut self, since: i64) {
        self.records.retain(|_, v| v.ts >= since);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::binance::events::{apply_fut_snapshot, apply_spot_snapshot, on_fut_event, on_spot_event};
    use crate::market::{Book, Info, SymbolInfo};
    use approx::assert_relative_eq;
    use serde_json::{Value, json};

    fn info(spot: &[(&str, SymbolInfo)]) -> Info {
        let mut i = Info::new();
        i.insert(Venue::SPOT, spot.iter().cloned().map(|(k, v)| (k.to_string(), v)).collect());
        i.insert(Venue::USDM, HashMap::new());
        i
    }

    fn cfg(id: &str, email: &str) -> AccountCfg {
        AccountCfg::new(id, id, email, Role::Sub)
    }

    // account state

    fn acct() -> (Account, MarketRef) {
        let mut m = Market::new(info(&[("XUSDT", SymbolInfo::new("X", "USDT", 5.0))]), 120.0, 100.0);
        m.ensure("XUSDT", Venue::SPOT, None);
        m.on_book(Venue::SPOT, &Book::new("XUSDT", 100.0, 100.0, Some(1)));
        let m = Rc::new(RefCell::new(m));
        let mut c = cfg("a", "");
        c.markets.push(Venue::USDM);
        let mut a = Account::new(c, None, "");
        a.market = Some(m.clone());
        (a, m)
    }

    fn snap(u: i64, x: f64, usdt: f64) -> Value {
        json!({"updateTime": u, "balances": [{"asset": "X", "free": x.to_string(), "locked": "0"},
                                             {"asset": "USDT", "free": usdt.to_string(), "locked": "0"}]})
    }

    fn pos(u: i64, rows: &[(&str, f64, f64)]) -> Value {
        json!({"e": "outboundAccountPosition", "E": u + 1, "u": u,
               "B": rows.iter().map(|(a, f, l)| json!({"a": a, "f": f.to_string(), "l": l.to_string()})).collect::<Vec<_>>()})
    }

    fn eq(a: &Account, m: &MarketRef) -> f64 {
        a.equity(&mut m.borrow_mut())
    }

    /// Hold 1 X (100) + 900 USDT. REST reads the account at u=100; a sell of 1 X at 100 lands at u=200
    /// and the stream reports it; then the REST response is applied; then a USDT-only update (an order
    /// locking 50) at u=300. Equity must stay 1000 throughout (before the fix: 1100 until the next snapshot).
    #[test]
    fn snapshot_read_before_fill_applied_after_does_not_double_count() {
        let (mut a, m) = acct();
        apply_spot_snapshot(&mut a, &snap(50, 1.0, 900.0)).unwrap();
        assert_relative_eq!(eq(&a, &m), 1000.0);
        let stale = snap(100, 1.0, 900.0);   // read now ...
        on_spot_event(&mut a, &pos(200, &[("X", 0.0, 0.0), ("USDT", 1000.0, 0.0)])).unwrap();   // ... the fill on the stream
        assert_relative_eq!(eq(&a, &m), 1000.0);
        apply_spot_snapshot(&mut a, &stale).unwrap();   // ... applied late
        assert_relative_eq!(eq(&a, &m), 1000.0);
        assert!(a.balances.get("X").is_none_or(|x| *x == (0.0, 0.0)));
        on_spot_event(&mut a, &pos(300, &[("USDT", 950.0, 50.0)])).unwrap();
        assert_relative_eq!(eq(&a, &m), 1000.0);
        apply_spot_snapshot(&mut a, &json!({"updateTime": 300, "balances": [{"asset": "USDT", "free": "950", "locked": "50"}]}))
            .unwrap();
        assert_eq!(a.balances, HashMap::from([("USDT".to_string(), (950.0, 50.0))]));
        assert_relative_eq!(eq(&a, &m), 1000.0);
    }

    #[test]
    fn stream_event_older_than_snapshot_is_dropped() {
        let (mut a, _m) = acct();
        apply_spot_snapshot(&mut a, &snap(500, 2.0, 800.0)).unwrap();
        on_spot_event(&mut a, &pos(400, &[("X", 1.0, 0.0), ("USDT", 900.0, 0.0)])).unwrap();
        assert!(a.balances["X"] == (2.0, 0.0) && a.balances["USDT"] == (800.0, 0.0));
        on_spot_event(&mut a, &pos(500, &[("X", 3.0, 0.0)])).unwrap();   // same update time: absolute values, applied
        assert_eq!(a.balances["X"], (3.0, 0.0));
    }

    fn fut(positions: &[(&str, f64, i64)], usdt: (f64, i64), total: f64) -> Value {
        json!({"totalWalletBalance": total.to_string(), "totalUnrealizedProfit": "0", "availableBalance": "0",
               "assets": [{"asset": "USDT", "walletBalance": usdt.0.to_string(), "updateTime": usdt.1}],
               "positions": positions.iter().map(|(s, amt, u)| json!({"symbol": s, "positionAmt": amt.to_string(),
                   "unrealizedProfit": "0", "notional": (amt * 10.0).to_string(), "updateTime": u})).collect::<Vec<_>>()})
    }

    fn acct_update(t: i64, wb: Option<f64>, positions: &[(&str, f64)]) -> Value {
        let b: Vec<Value> = wb.map(|wb| json!({"a": "USDT", "wb": wb.to_string(), "cw": wb.to_string(), "bc": "0"})).into_iter().collect();
        json!({"e": "ACCOUNT_UPDATE", "E": t + 1, "T": t,
               "a": {"m": "ORDER", "B": b,
                     "P": positions.iter().map(|(s, amt)| json!({"s": s, "pa": amt.to_string(), "ep": "10", "ps": "BOTH"})).collect::<Vec<_>>()}})
    }

    #[test]
    fn futures_snapshot_does_not_overwrite_newer_stream_position_or_wallet() {
        let (mut a, _m) = acct();
        apply_fut_snapshot(&mut a, &fut(&[("YUSDT", 5.0, 100)], (1000.0, 100), 1003.0), 150).unwrap();
        assert!(a.positions["YUSDT"].0 == 5.0);
        assert_relative_eq!(a.fut_wallet, 1003.0);
        let stale = fut(&[("YUSDT", 5.0, 100)], (1000.0, 100), 1003.0);   // read at 300 ...
        on_fut_event(&mut a, &acct_update(400, Some(998.0), &[("YUSDT", 2.0), ("ZUSDT", -1.0)])).unwrap();   // ... a fill at 400
        assert!(a.positions["YUSDT"].0 == 2.0);
        assert_relative_eq!(a.fut_wallet, 1001.0);
        apply_fut_snapshot(&mut a, &stale, 300).unwrap();
        assert!(a.positions["YUSDT"].0 == 2.0 && a.positions["ZUSDT"].0 == -1.0);
        assert_relative_eq!(a.fut_wallet, 1001.0);
        // a later snapshot that saw the fill wins, and drops what it no longer lists
        apply_fut_snapshot(&mut a, &fut(&[("YUSDT", 2.0, 400)], (998.0, 400), 1001.5), 500).unwrap();
        assert_eq!(a.positions.len(), 1);
        assert_eq!(a.positions["YUSDT"].0, 2.0);
        assert_relative_eq!(a.positions["YUSDT"].1, 10.0);
        assert_relative_eq!(a.fut_wallet, 1001.5);
        // a stream value a minute older than the request no longer pins anything
        on_fut_event(&mut a, &acct_update(600, None, &[("YUSDT", 7.0)])).unwrap();
        apply_fut_snapshot(&mut a, &fut(&[("YUSDT", 3.0, 0)], (998.0, 0), 1001.5), 70_000).unwrap();
        assert_eq!(a.positions["YUSDT"].0, 3.0);
    }

    // account P&L

    fn tr(ts: i64, frm: &str, to: &str, asset: &str, amount: f64) -> Transfer {
        Transfer { ts, frm: frm.into(), to: to.into(), asset: asset.into(), amount, usd: None }
    }

    /// The owner sends 12 888.89 USDC to an account and it sells them on USDCUSDT at once. Equity, the
    /// opening equity and the transfer all price USDC at USDCUSDT's mid, so neither the transfer nor a
    /// conversion at the mid makes Day PnL (at 1.0 each would have booked +0.0012 a dollar).
    #[test]
    fn usdc_in_then_converted_leaves_day_pnl_unchanged() {
        let mut m = Market::new(info(&[("USDCUSDT", SymbolInfo::new("USDC", "USDT", 5.0))]), 120.0, 100.0);
        m.asset_inst("USDC");
        m.on_book(Venue::SPOT, &Book::new("USDCUSDT", 1.0011, 1.0013, Some(1_000)));
        let a = Account::new(cfg("usdc", "u@x.io"), None, "").shared();
        a.borrow_mut().set_balances([("USDT", 1000.0, 0.0), ("USDC", 500.0, 0.0)], true);
        let open = a.borrow().equity(&mut m);
        assert_relative_eq!(open, 1000.0 + 500.0 * 1.0012, max_relative = 1e-12);
        let mut t = Transfers::new(None, vec![a.clone()]);
        let x = 12_888.888_888_88;
        t.add("1", tr(2_500, "master@x.io", "u@x.io", "USDC", x));
        t.value(&mut m, 3_000);
        assert_relative_eq!(t.records["1"].usd.unwrap(), x * 1.0012, max_relative = 1e-12);
        let day = |a: &AccountRef, m: &mut Market, t: &Transfers| {
            crate::metrics::day_pnl(a.borrow().equity(m), open, t.net_in_live(&a.borrow(), 0))
        };
        a.borrow_mut().set_balances([("USDC", 500.0 + x, 0.0)], false);
        assert_relative_eq!(day(&a, &mut m, &t), 0.0, epsilon = 1e-9);
        // sold at the mid: USDC out, USDT in
        a.borrow_mut().set_balances([("USDC", 500.0, 0.0), ("USDT", 1000.0 + x * 1.0012, 0.0)], false);
        assert_relative_eq!(day(&a, &mut m, &t), 0.0, epsilon = 1e-9);
        // USDT itself stays at 1
        assert_eq!(m.asset_price("USDT"), Some(1.0));
    }

    #[test]
    fn day_pnl_excludes_transfers() {
        let mut m = Market::new(info(&[]), 120.0, 100.0);
        let a = Account::new(cfg("a", "a@x.io"), None, "").shared();
        let b = Account::new(cfg("b", "B@x.io"), None, "").shared();
        let mut t = Transfers::new(None, vec![a.clone(), b.clone()]);
        t.add("1", tr(100, "master@x.io", "a@x.io", "USDT", 1000.0));
        t.add("2", tr(200, "a@x.io", "b@x.io", "USDC", 300.0));
        t.add("3", tr(50, "a@x.io", "b@x.io", "USDT", 999.0));   // before the day start
        t.add("4", tr(300, "b@x.io", "b@x.io", "USDT", 50.0));   // inside one account (spot -> futures)
        t.value(&mut m, 400);
        assert_relative_eq!(t.net_in_live(&a.borrow(), 100), 700.0);
        assert_relative_eq!(t.net_in_live(&b.borrow(), 100), 300.0);
        // equity 10_000 at open, 1000 transferred in, 700 net in: +40 of trading (metrics::day_pnl)
        assert_relative_eq!(10_740.0 - 10_000.0 - 700.0, 40.0);
        // the desk: only what crossed its edge, the master's 1000 USDT in
        let d = t.desk_flows(100);
        assert!(d.len() == 1 && d[0].key == "t:1" && d[0].asset == "USDT");
        assert_relative_eq!(d[0].qty * d[0].px, 1000.0);
    }

    fn bnb_market() -> Market {
        let mut m = Market::new(info(&[("BNBUSDT", SymbolInfo::new("BNB", "USDT", 5.0))]), 120.0, 100.0);
        m.ensure("BNBUSDT", Venue::SPOT, None);
        m
    }

    fn bnb(m: &mut Market, t: i64, px: f64) {
        m.on_book(Venue::SPOT, &Book::new("BNBUSDT", px, px, Some(t)));
    }

    #[test]
    fn a_transfer_keeps_the_value_it_had_when_it_happened() {
        // 5 BNB leave the desk at 750; BNB then moves to 760: the transfer still takes 3750 off, so the day's
        // P&L carries no exposure to BNB that is no longer there
        let mut m = bnb_market();
        bnb(&mut m, 9_000, 750.0);
        let a = Account::new(cfg("mm1", "Master@x.io"), None, "").shared();
        let v = t_stored();
        let mut t = Transfers::new(None, vec![a.clone()]);
        let v2 = v.clone();
        t.on_record = Rc::new(move |id, r| v2.borrow_mut().push((id.to_string(), r.usd)));
        t.add("9", tr(10_400, "master@x.io", "out@x.io", "BNB", 5.0));
        bnb(&mut m, 20_000, 760.0);
        t.value(&mut m, 20_500);   // the ring reaches back to the transfer: 750
        assert_relative_eq!(t.net_in_live(&a.borrow(), 0), -3750.0);
        bnb(&mut m, 30_000, 770.0);
        t.value(&mut m, 30_500);
        assert_relative_eq!(t.net_in_live(&a.borrow(), 0), -3750.0);
        // stored when seen (no value yet), then once with its value
        assert_eq!(*v.borrow(), [("9".to_string(), None), ("9".to_string(), Some(3750.0))]);
        // the desk sees 5 BNB out at 750
        let d = t.desk_flows(0);
        assert!(d.len() == 1 && d[0].qty == -5.0);
        assert_relative_eq!(d[0].px, 750.0);
        // a record stored with its value keeps it (a restart)
        let mut t = Transfers::new(None, vec![a.clone()]);
        let mut r = tr(10_400, "master@x.io", "out@x.io", "BNB", 5.0);
        r.usd = Some(3750.0);
        t.records.insert("9".into(), r);
        t.value(&mut m, 30_500);
        assert_relative_eq!(t.net_in_live(&a.borrow(), 0), -3750.0);
    }

    type Stored = Rc<RefCell<Vec<(String, Option<f64>)>>>;

    fn t_stored() -> Stored {
        Rc::default()
    }

    #[test]
    fn a_confirmed_move_keeps_its_value_and_counts_once() {
        // the stream shows 5 BNB out at 750; the history confirms it later, when BNB is at 760 and the ring no
        // longer reaches back: the record takes the move's value, and the desk's flow is the same 5 at 750
        let mut m = bnb_market();
        bnb(&mut m, 1_000, 750.0);
        let a = Account::new(cfg("a", "a@x.io"), None, "").shared();
        let mut t = Transfers::new(None, vec![a.clone()]);
        on_spot_event(&mut a.borrow_mut(), &json!({"e": "balanceUpdate", "a": "BNB", "d": "-5", "T": 1_000})).unwrap();
        t.value(&mut m, 2_000);
        assert_relative_eq!(t.net_in_live(&a.borrow(), 0), -3750.0);
        let d = t.desk_flows(0);
        assert!(d.len() == 1 && d[0].key.starts_with("m:a:1000:BNB"));
        bnb(&mut m, 900_000, 760.0);
        t.add("1", tr(1_005, "a@x.io", "b@x.io", "BNB", 5.0));
        t.value(&mut m, 60_000);
        assert_relative_eq!(t.net_in_live(&a.borrow(), 0), -3750.0);
        let d = t.desk_flows(0);
        assert!(d.len() == 1 && d[0].key == "t:1" && d[0].qty == -5.0);
        assert_relative_eq!(d[0].px, 750.0);
        // an unconfirmed move drops after MOVE_HOLD_MS, from Day PnL and from the desk's flows alike
        on_spot_event(&mut a.borrow_mut(), &json!({"e": "balanceUpdate", "a": "BNB", "d": "2", "T": 70_000})).unwrap();
        t.value(&mut m, 71_000);
        assert_eq!(t.desk_flows(0).len(), 2);
        t.value(&mut m, 70_000 + MOVE_HOLD_MS);
        assert_eq!(t.desk_flows(0).len(), 1);
        assert_relative_eq!(t.net_in_live(&a.borrow(), 0), -3750.0);
    }

    #[test]
    fn a_transfer_between_desk_accounts_is_no_flow_of_the_desk() {
        let mut m = bnb_market();
        bnb(&mut m, 1_000, 750.0);
        let a = Account::new(cfg("a", "a@x.io"), None, "").shared();
        let b = Account::new(cfg("b", "b@x.io"), None, "").shared();
        let mut t = Transfers::new(None, vec![a.clone(), b.clone()]);
        // seen on both streams first, then in the history
        on_spot_event(&mut a.borrow_mut(), &json!({"e": "balanceUpdate", "a": "BNB", "d": "-5", "T": 1_000})).unwrap();
        on_spot_event(&mut b.borrow_mut(), &json!({"e": "balanceUpdate", "a": "BNB", "d": "5", "T": 1_000})).unwrap();
        t.value(&mut m, 2_000);
        let d = t.desk_flows(0);
        assert_relative_eq!(d.iter().map(|f| f.qty * f.px).sum::<f64>(), 0.0);
        assert_relative_eq!(t.net_in_live(&a.borrow(), 0), -3750.0);
        assert_relative_eq!(t.net_in_live(&b.borrow(), 0), 3750.0);
        t.add("1", tr(1_002, "a@x.io", "b@x.io", "BNB", 5.0));
        t.value(&mut m, 60_000);
        assert!(t.desk_flows(0).is_empty());
        assert_relative_eq!(t.net_in_live(&a.borrow(), 0), -3750.0);
        assert_relative_eq!(t.net_in_live(&b.borrow(), 0), 3750.0);
    }

    #[test]
    fn internal_transfer_and_equal_subaccount_receipts_do_not_create_profit() {
        // The master's own-wallet transfer of 100 is followed by four sub-account
        // receipts, one also exactly 100.
        let mut m = Market::new(info(&[]), 120.0, 100.0);
        let master = Account::new(cfg("master", "master@x.io"), None, "").shared();
        let amounts = [100.0, 99.99, 99.99, 99.99];
        let mut accounts = vec![master.clone()];
        for (i, amount) in amounts.iter().enumerate() {
            let a = Account::new(cfg(&format!("sub{i}"), &format!("sub{i}@x.io")), None, "").shared();
            a.borrow_mut().moves.push(Move::new(2_000, "USDT", -amount));
            accounts.push(a);
            master.borrow_mut().moves.push(Move::new(2_000, "USDT", *amount));
        }
        master.borrow_mut().moves.extend([
            Move::new(1_000, "USDT", -100.0),
            Move::new(1_001, "USDT", 100.0),
        ]);
        let mut t = Transfers::new(None, accounts);
        t.value(&mut m, 3_000);
        let total: f64 = amounts.iter().sum();
        assert_relative_eq!(t.net_in_live(&master.borrow(), 0), total);
        assert_relative_eq!(t.desk_flows(0).iter().map(|f| f.qty * f.px).sum::<f64>(), 0.0, epsilon = 1e-9);

        // Even a partial history must consume each stream receipt only once.
        t.add("external0", tr(2_000, "sub0@x.io", "master@x.io", "USDT", amounts[0]));
        t.value(&mut m, 48_000);
        assert_relative_eq!(t.net_in_live(&master.borrow(), 0), total);
        assert_relative_eq!(t.desk_flows(0).iter().map(|f| f.qty * f.px).sum::<f64>(), 0.0, epsilon = 1e-9);

        t.add("internal", tr(1_000, "master@x.io", "master@x.io", "USDT", 100.0));
        for (i, amount) in amounts.iter().enumerate().skip(1) {
            t.add(&format!("external{i}"), tr(2_000, &format!("sub{i}@x.io"), "master@x.io", "USDT", *amount));
        }
        t.value(&mut m, 60_000);
        assert_relative_eq!(t.net_in_live(&master.borrow(), 0), total);
        assert!(t.desk_flows(0).is_empty());
        t.value(&mut m, 2_000 + MOVE_HOLD_MS);
        assert_relative_eq!(t.net_in_live(&master.borrow(), 0), total);
        assert!(t.desk_flows(0).is_empty());
    }

    #[test]
    fn equal_transfers_keep_the_prices_of_their_own_stream_moves() {
        let mut m = bnb_market();
        bnb(&mut m, 1_000, 750.0);
        let a = Account::new(cfg("a", "a@x.io"), None, "").shared();
        let mut t = Transfers::new(None, vec![a.clone()]);
        a.borrow_mut().moves.push(Move::new(1_000, "BNB", -5.0));
        t.value(&mut m, 2_000);
        bnb(&mut m, 10_000, 760.0);
        a.borrow_mut().moves.push(Move::new(11_000, "BNB", -5.0));
        t.value(&mut m, 11_500);
        t.add("1", tr(1_005, "a@x.io", "b@x.io", "BNB", 5.0));
        t.add("2", tr(11_005, "a@x.io", "b@x.io", "BNB", 5.0));
        t.value(&mut m, 12_000);
        assert_relative_eq!(t.records["1"].usd.unwrap(), 3750.0);
        assert_relative_eq!(t.records["2"].usd.unwrap(), 3800.0);
        assert_relative_eq!(t.net_in_live(&a.borrow(), 0), -7550.0);
    }

    #[test]
    fn fee_change_holds_a_day_then_becomes_the_baseline() {
        type Log = Rc<RefCell<Vec<String>>>;
        let log: Log = Rc::default();
        let hooked = |log: &Log| {
            let mut a = Account::new(cfg("a", ""), None, "");
            let (l1, l2) = (log.clone(), log.clone());
            a.on_fee = Rc::new(move |_, v, s, x| l1.borrow_mut().push(format!("fee:{v}:{s}={},{}", x.0, x.1)));
            a.on_fee_change = Rc::new(move |_, v, s, t| l2.borrow_mut().push(format!("feechg:{v}:{s}={t:?}")));
            a
        };
        let h = 3_600_000;
        let mut a = hooked(&log);
        a.set_fee(Venue::SPOT, "XUSDT", 0.0, 0.0001, 0);   // the first rate seen is the baseline
        a.set_fee(Venue::SPOT, "XUSDT", 0.0, 0.0001, h);
        assert!(!a.fee_rows()[0].changed && a.fee_changed.is_empty());
        a.set_fee(Venue::SPOT, "XUSDT", 0.0, 0.001, 2 * h);   // changed: active from now
        a.set_fee(Venue::SPOT, "XUSDT", 0.0, 0.001, 3 * h);   // the same change: keeps its time
        assert!(a.fee_rows()[0].changed);
        assert_eq!(a.fee_changed[&(Venue::SPOT, "XUSDT".into())], 2 * h);
        a.expire_fees(2 * h + FEE_CHANGE_HOLD_MS - 1);
        assert!(a.fee_rows()[0].changed);
        a.set_fee(Venue::SPOT, "XUSDT", 0.0, 0.002, 4 * h);   // changed again: the day restarts
        a.expire_fees(2 * h + FEE_CHANGE_HOLD_MS);
        assert_eq!(a.fee_changed[&(Venue::SPOT, "XUSDT".into())], 4 * h);
        a.expire_fees(4 * h + FEE_CHANGE_HOLD_MS);   // held a day: the new baseline
        assert!(!a.fee_rows()[0].changed && a.fee_changed.is_empty());
        assert_eq!(a.first_fees[&(Venue::SPOT, "XUSDT".into())], (0.0, 0.002));
        assert_eq!(*log.borrow(), [
            "fee:spot:XUSDT=0,0.0001",
            &format!("feechg:spot:XUSDT=Some({})", 2 * h),
            &format!("feechg:spot:XUSDT=Some({})", 4 * h),
            "fee:spot:XUSDT=0,0.002",
            "feechg:spot:XUSDT=None",
        ]);

        // a restart inside the day: the baseline and the change's time come back from kv and the clock runs on
        log.borrow_mut().clear();
        let mut b = hooked(&log);
        b.first_fees.insert((Venue::SPOT, "XUSDT".into()), (0.0, 0.0001));
        b.fee_changed.insert((Venue::SPOT, "XUSDT".into()), 2 * h);
        b.set_fee(Venue::SPOT, "XUSDT", 0.0, 0.001, 10 * h);
        assert!(b.fee_rows()[0].changed && log.borrow().is_empty());
        assert_eq!(b.fee_changed[&(Venue::SPOT, "XUSDT".into())], 2 * h);
        b.expire_fees(2 * h + FEE_CHANGE_HOLD_MS);
        assert_eq!(b.first_fees[&(Venue::SPOT, "XUSDT".into())], (0.0, 0.001));
        // back to the baseline inside the day: the change ends
        b.set_fee(Venue::SPOT, "XUSDT", 0.0, 0.002, 30 * h);
        b.set_fee(Venue::SPOT, "XUSDT", 0.0, 0.001, 31 * h);
        assert!(!b.fee_rows()[0].changed && b.fee_changed.is_empty());

        // a rate already differing at startup with no time kept counts from the first read
        let mut c = hooked(&log);
        c.first_fees.insert((Venue::USDM, "*".into()), (0.0002, 0.0005));
        c.set_fee(Venue::USDM, "*", 0.0, 0.0004, 50 * h);
        assert_eq!(c.fee_changed[&(Venue::USDM, "*".into())], 50 * h);
        c.expire_fees(50 * h + FEE_CHANGE_HOLD_MS);
        assert!(!c.fee_rows()[0].changed);
    }

    #[test]
    fn stream_moves_count_until_history_confirms() {
        let mut m = Market::new(info(&[]), 120.0, 100.0);
        let a = Account::new(cfg("a", "a@x.io"), None, "").shared();
        let b = Account::new(cfg("b", "b@x.io"), None, "").shared();
        let mut t = Transfers::new(None, vec![a.clone(), b.clone()]);
        on_spot_event(&mut a.borrow_mut(), &json!({"e": "balanceUpdate", "a": "USDT", "d": "-363", "T": 1_000})).unwrap();
        on_spot_event(&mut b.borrow_mut(), &json!({"e": "balanceUpdate", "a": "USDT", "d": "363", "T": 1_000})).unwrap();
        // before the history poll: the move is already out of both accounts' PnL
        t.value(&mut m, 2_000);
        assert_relative_eq!(t.net_in_live(&a.borrow(), 0), -363.0);
        assert_relative_eq!(t.net_in_live(&b.borrow(), 0), 363.0);
        // the history shows it: counted once
        t.add("1", tr(1_005, "a@x.io", "b@x.io", "USDT", 363.0));
        t.value(&mut m, 3_000);
        assert_relative_eq!(t.net_in_live(&a.borrow(), 0), -363.0);
        assert_relative_eq!(t.net_in_live(&b.borrow(), 0), 363.0);
        // long after: history only
        t.value(&mut m, 400_000);
        assert!(b.borrow().moves.is_empty());
        assert_relative_eq!(t.net_in_live(&b.borrow(), 0), 363.0);
    }

    #[test]
    fn futures_leg_closed_form_with_fees_and_funding() {
        // Short 2 at the start (opening mark 100); sell 1 at 99 (fee 0.04) and buy 0.5 at 97 (fee 0.02);
        // mark now 96; funding received 0.3. Price P&L = -2 (96-100) - 1 (96-99) + 0.5 (96-97) = 10.5.
        let mut m = Market::new(info(&[]), 120.0, 100.0);
        let id = m.ensure("XUSDT", Venue::USDM, None);
        m.insts[id].mark = Some(96.0);
        (m.insts[id].bid, m.insts[id].ask) = (96.05, 96.15);   // mid 96.1
        let mut a = Account::new(cfg("a", ""), None, "");
        a.positions.insert("XUSDT".into(), (-2.5, 99.0));
        let mut d = FutDay::new(0);
        d.trades = BTreeMap::from([(1, (1, -1.0, 99.0, 0.04)), (2, (2, 0.5, 97.0, 0.02))]);
        (d.funding, d.m0) = (0.3, Some(100.0));
        a.fut_day.insert("XUSDT".into(), d);
        let l = a.fut_leg(&m, "XUSDT");
        assert_relative_eq!(l.q0, -2.0);
        assert!(l.q == -2.5 && l.m0 == Some(100.0) && l.mark == Some(96.0) && l.fills == 2);
        assert_relative_eq!(l.price.unwrap(), 10.5);
        assert_relative_eq!(l.fees, 0.06);
        assert_eq!(l.funding, 0.3);
        a.fut_day.get_mut("XUSDT").unwrap().m0 = None;   // opening mark unknown with a position held at the start: no price P&L yet
        assert!(a.fut_leg(&m, "XUSDT").price.is_none());
    }

    #[test]
    fn stream_funding_counts_until_rest_has_it() {
        let mut m = Market::new(info(&[]), 120.0, 100.0);
        let id = m.ensure("XUSDT", Venue::USDM, None);
        m.insts[id].mark = Some(100.0);
        let mut a = Account::new(cfg("a", ""), None, "");
        a.day_start = 1_000;
        a.positions.insert("XUSDT".into(), (-2.0, 100.0));
        let mut d = FutDay::new(1_000);
        (d.m0, d.funding, d.rest_t) = (Some(100.0), -1.5, 2_000);
        a.fut_day.insert("XUSDT".into(), d);
        // funding on the stream: the balance only, no symbol; the one position held takes it
        let ev = |t: i64, bc: &str| json!({"e": "ACCOUNT_UPDATE", "E": t, "T": t, "a": {"m": "FUNDING_FEE",
            "B": [{"a": "USDT", "wb": "1000", "cw": "1000", "bc": bc}]}});
        on_fut_event(&mut a, &ev(3_000, "0.7")).unwrap();
        assert_relative_eq!(a.fut_leg(&m, "XUSDT").funding, -1.5 + 0.7);
        // the next REST pass has it: counted once
        let d = a.fut_day.get_mut("XUSDT").unwrap();
        (d.funding, d.rest_t) = (-1.5 + 0.7, 4_000);
        assert_relative_eq!(a.fut_leg(&m, "XUSDT").funding, -1.5 + 0.7);
        // with two positions held the stream cannot tell whose it is: REST books it
        a.positions.insert("YUSDT".into(), (1.0, 10.0));
        on_fut_event(&mut a, &ev(5_000, "1.0")).unwrap();
        assert_relative_eq!(a.fut_leg(&m, "XUSDT").funding, -1.5 + 0.7);
    }

    #[test]
    fn futures_stream_fill_counts_before_rest_and_day_change_drops_the_old_day() {
        // Flat at the start (opening mark 100); the stream sells 2 at 90 and the position follows. Before any
        // REST pass the fill is today's, not a position held since the start: price P&L = -2 (88-90) = 4.
        let mut m = Market::new(info(&[]), 120.0, 100.0);
        let id = m.ensure("XUSDT", Venue::USDM, None);
        m.insts[id].mark = Some(88.0);
        let mut a = Account::new(cfg("a", ""), None, "");
        a.day_start = 1_000;
        let mut d = FutDay::new(1_000);
        d.m0 = Some(100.0);
        a.fut_day.insert("XUSDT".into(), d);
        on_fut_event(&mut a, &json!({"e": "ORDER_TRADE_UPDATE", "E": 2_001, "T": 2_000, "o": {"s": "XUSDT", "S": "SELL", "i": 9,
            "p": "90", "q": "2", "z": "2", "X": "FILLED", "x": "TRADE", "t": 77, "L": "90", "l": "2", "n": "0.07",
            "N": "USDT", "m": false, "T": 2_000}})).unwrap();
        a.positions.insert("XUSDT".into(), (-2.0, 90.0));
        let l = a.fut_leg(&m, "XUSDT");
        assert!(l.q0.abs() < 1e-12 && l.fills == 1);
        assert_relative_eq!(l.price.unwrap(), 4.0);
        assert_relative_eq!(l.fees, 0.07);
        // a new day before REST has caught up: the old day's fills are not the new day's
        a.day_start = 86_401_000;
        assert!(a.fut_leg(&m, "XUSDT").m0.is_none() && a.fut_leg(&m, "XUSDT").fills == 0);
    }

    // the user-stream fill and fee callbacks

    #[test]
    fn execution_report_fills_and_counts() {
        let got: Rc<RefCell<Vec<FillRec>>> = Rc::default();
        let g = got.clone();
        let mut a = Account::new(cfg("a", ""), None, "");
        a.on_fill = Rc::new(move |f| g.borrow_mut().push(f));
        a.no_order_counts = true;
        on_spot_event(&mut a, &json!({"e": "executionReport", "E": 1_000, "s": "XUSDT", "S": "BUY", "x": "NEW", "X": "NEW",
                                "i": 7, "p": "10", "q": "2", "z": "0", "O": 900})).unwrap();
        assert_eq!(a.orders_10s, 1);
        assert_eq!(a.open_since["spot:7"], 900);
        on_spot_event(&mut a, &json!({"e": "executionReport", "E": 1_100, "s": "XUSDT", "S": "BUY", "x": "TRADE", "X": "FILLED",
                                "i": 7, "p": "10", "q": "2", "z": "2", "t": 55, "T": 1_050, "L": "10", "l": "2",
                                "n": "0.001", "N": "BNB", "m": true})).unwrap();
        assert!(a.open.is_empty() && a.open_since.is_empty());
        let f = &got.borrow()[0];
        assert!(f.id == "a:spot:XUSDT:55" && f.ts == 1_050 && f.side == Side::Buy && f.qty == 2.0 && f.fee_asset == "BNB" && f.maker);
    }
}
