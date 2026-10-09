//! Per-account state: balances, futures, orders, fees and user streams, from REST and WebSocket.
use std::cell::RefCell;
use std::collections::{BTreeMap, HashMap, HashSet, VecDeque};
use std::future::Future;
use std::rc::Rc;
use std::time::Duration;

use anyhow::{Result, anyhow, bail};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tokio::task::JoinHandle;

use crate::binance::rest::{CLOCK, Params, Rest, RestError};
use crate::binance::sign::{Credentials, query};
use crate::binance::ws::{USDM_PRIVATE, WS_API, WsConn, WsHandle, run_ws, ws_api_call};
use crate::config::AccountCfg;
use crate::feeds::{Feed, FeedKind, FeedRef, now_ms};
use crate::fills::FillRec;
use crate::market::{Market, STABLES};
use crate::params;
use crate::protocol::{self as P, Role, Side, UserStream, Venue};

pub const OPEN_STATES: [&str; 2] = ["NEW", "PARTIALLY_FILLED"];
pub const MOVE_HOLD_MS: i64 = 180_000;
pub const STALE_MS: i64 = 60_000;   // a stream value this much older than a REST request no longer outranks the REST one

pub type MarketRef = Rc<RefCell<Market>>;
pub type AccountRef = Rc<RefCell<Account>>;
/// Called with each fill seen on a user stream. Runs while the account is borrowed: must not borrow it.
pub type OnFill = Rc<dyn Fn(FillRec)>;
/// Called with the first commission rate seen per (venue, symbol).
pub type OnFee = Rc<dyn Fn(&Account, Venue, &str, (f64, f64))>;

/// A resting order: (symbol, venue, side, price, qty left).
#[derive(Debug, Clone, PartialEq)]
pub struct Open {
    pub symbol: String,
    pub venue: Venue,
    pub side: Side,
    pub price: f64,
    pub left: f64,
}

/// (symbol, amt, entry, mark, upnl, notional) at live marks.
#[derive(Debug, Clone, PartialEq)]
pub struct LivePosition {
    pub symbol: String,
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
}

impl FutDay {
    pub fn new(ds: i64) -> Self {
        FutDay { ds, trades: BTreeMap::new(), funding: 0.0, m0: None }
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

// JSON helpers: Binance sends numbers as strings or numbers; a missing required field is Python's KeyError.

fn get<'a>(v: &'a Value, k: &str) -> Result<&'a Value> {
    v.get(k).ok_or_else(|| anyhow!("KeyError: {k}"))
}

fn to_f(v: &Value) -> Result<f64> {
    match v {
        Value::String(s) => s.trim().parse().map_err(|_| anyhow!("ValueError: could not convert {s:?} to float")),
        Value::Number(n) => n.as_f64().ok_or_else(|| anyhow!("ValueError: {n}")),
        Value::Bool(b) => Ok(f64::from(u8::from(*b))),
        _ => bail!("ValueError: not a number: {v}"),
    }
}

fn to_i(v: &Value) -> Result<i64> {
    match v {
        Value::Number(n) => n.as_i64().or_else(|| n.as_f64().map(|x| x as i64)).ok_or_else(|| anyhow!("ValueError: {n}")),
        Value::String(s) => s.trim().parse().map_err(|_| anyhow!("ValueError: invalid int {s:?}")),
        Value::Bool(b) => Ok(i64::from(*b)),
        _ => bail!("ValueError: not an int: {v}"),
    }
}

fn truthy(v: &Value) -> bool {
    match v {
        Value::Null => false,
        Value::Bool(b) => *b,
        Value::Number(n) => n.as_f64() != Some(0.0),
        Value::String(s) => !s.is_empty(),
        Value::Array(a) => !a.is_empty(),
        Value::Object(o) => !o.is_empty(),
    }
}

/// Python `float(v[k])`.
fn f(v: &Value, k: &str) -> Result<f64> {
    to_f(get(v, k)?)
}

/// Python `v.get(k) or ...`: the first truthy value among `keys`.
fn first<'a>(v: &'a Value, keys: &[&str]) -> Option<&'a Value> {
    keys.iter().filter_map(|k| v.get(*k)).find(|x| truthy(x))
}

/// Python `int(v.get(a) or v.get(b) or default)`.
fn int_or(v: &Value, keys: &[&str], default: i64) -> Result<i64> {
    first(v, keys).map_or(Ok(default), to_i)
}

/// Python `float(v.get(k) or 0)`.
fn f_or0(v: &Value, k: &str) -> Result<f64> {
    first(v, &[k]).map_or(Ok(0.0), to_f)
}

fn s<'a>(v: &'a Value, k: &str) -> Result<&'a str> {
    get(v, k)?.as_str().ok_or_else(|| anyhow!("{k}: not a string"))
}

/// An id as Python's `str()` / f-string shows it.
fn id_str(v: &Value) -> String {
    match v {
        Value::String(s) => s.clone(),
        Value::Null => "None".into(),
        other => other.to_string(),
    }
}

fn side_of(s: &str) -> Side {
    if s.eq_ignore_ascii_case("buy") { Side::Buy } else { Side::Sell }
}

fn venue_key(venue: Venue, x: impl std::fmt::Display) -> String {
    format!("{}:{x}", venue.as_str())
}

/// Python `f"{type(e).__name__}: {e}"[:200]`.
fn err_text(e: &anyhow::Error) -> String {
    let s = if e.downcast_ref::<RestError>().is_some() { format!("RestError: {e}") } else { format!("{e:#}") };
    s.chars().take(200).collect()
}

/// One Binance account as the monitor sees it: balances, futures, orders, fees.
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
    pub positions: HashMap<String, (f64, f64)>,   // symbol -> (amt, entry)
    pub pos_u: HashMap<String, i64>,              // symbol -> update time of the position held
    pub orders_10s: i64,
    pub orders_10s_limit: i64,
    pub orders_1d: i64,
    pub orders_1d_limit: i64,
    pub open: HashMap<String, Open>,       // venue:orderId -> order
    pub open_since: HashMap<String, i64>,  // venue:orderId -> creation time
    pub traded: HashSet<String>,           // venue:symbol filled or quoted
    pub fee_turn: usize,
    pub fee_next: [i64; 2],   // ms, indexed by Venue::index(); each venue's next per-symbol commission lookup
    pub fees: Vec<((Venue, String), (f64, f64))>,   // insertion-ordered like the Python dict
    pub first_fees: HashMap<(Venue, String), (f64, f64)>,
    pub equity_open: Option<f64>,
    pub day_start: i64,                      // set by the desk; the futures day below is read from it
    pub fut_day: HashMap<String, FutDay>,
    /// spot symbols whose fills the desk tracks (set by the desk): the myTrades sweep reads these
    pub spot_symbols: Vec<String>,
    /// the myTrades sweep has covered today up to here (ms)
    pub trades_upto: i64,    // symbol -> today's futures fills, funding and opening mark
    pub transfers_day: f64,
    pub updated: i64,
    pub feeds: Vec<FeedRef>,
    pub rest_feed: FeedRef,
    pub on_fill: OnFill,
    pub on_fee: OnFee,
    pub market: Option<MarketRef>,
    pub via_master: bool,
    pub moves: Vec<(i64, String, f64)>,   // (time, asset, signed amount) from the user streams
    pub no_order_counts: bool,
    pub new_ts: VecDeque<i64>,
}

impl Account {
    pub fn new(cfg: AccountCfg, creds: Option<Rc<Credentials>>, reason: &str) -> Self {
        let mut feeds = vec![Feed::shared(format!("{} spot user", cfg.id), FeedKind::User, "")];
        if cfg.futures {
            feeds.push(Feed::shared(format!("{} usdm user", cfg.id), FeedKind::User, ""));
        }
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
            fut_loaded: !cfg.futures,
            fut_wallet: 0.0,
            fut_upnl_rest: 0.0,
            fut_available: 0.0,
            fut_usdt: 0.0,
            fut_usdt_u: 0,
            positions: HashMap::new(),
            pos_u: HashMap::new(),
            orders_10s: 0,
            orders_10s_limit: 0,
            orders_1d: 0,
            orders_1d_limit: 0,
            open: HashMap::new(),
            open_since: HashMap::new(),
            traded: HashSet::new(),
            fee_turn: 0,
            fee_next: [0, 0],
            fees: vec![],
            first_fees: HashMap::new(),
            equity_open: None,
            day_start: 0,
            fut_day: HashMap::new(),
            spot_symbols: vec![],
            trades_upto: 0,
            transfers_day: 0.0,
            updated: 0,
            feeds,
            rest_feed,
            on_fill: Rc::new(|_| {}),
            on_fee: Rc::new(|_, _, _, _| {}),
            market: None,
            via_master: false,
            moves: vec![],
            no_order_counts: false,
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

    /// Orders placed as seen on the user stream: stands in for /api/v3/rateLimit/order,
    /// which read-only keys may not call (Binance spot limits 100 per 10 s, 200k per day).
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
        (self.orders_10s, self.orders_10s_limit, self.orders_1d_limit) = (self.new_ts.len() as i64, 100, 200_000);
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

    /// (quote free, quote locked, inventory value, all priced)
    pub fn spot_parts(&self, m: &mut Market) -> (f64, f64, f64, bool) {
        let (mut qf, mut ql, mut inv) = (0.0, 0.0, 0.0);
        let mut priced = true;
        for (a, &(f, l)) in &self.balances {
            if STABLES.contains(&a.as_str()) {
                qf += f;
                ql += l;
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
                .get(&format!("usdm:{s}"))
                .and_then(|i| i.mark.filter(|x| *x != 0.0).or_else(|| i.mid()))
                .filter(|x| *x != 0.0)
                .unwrap_or(entry);
            out.push(LivePosition { symbol: s.clone(), amt, entry, mark, upnl: (mark - entry) * amt, notional: amt * mark });
        }
        out
    }

    /// Today on futures symbol s. Price P&L = Q0 (M_T - M_D) + sum s q (M_T - p): the same closed form as
    /// the spot Π; None while the opening mark is unknown and a position was held at the start.
    pub fn fut_leg(&self, m: &Market, s: &str) -> FutLeg {
        let q = self.positions.get(s).map_or(0.0, |p| p.0);
        let mark = m
            .get(&format!("usdm:{s}"))
            .and_then(|i| i.mark.filter(|x| *x != 0.0).or_else(|| i.mid()))
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
        FutLeg { q0, q, m0: d.m0, mark, fills: d.trades.len() as i64, price, fees, funding: d.funding }
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
            if !STABLES.contains(&a) && f + l > 0.0 {
                self.touch_asset(a);
            }
        }
        self.updated = now_ms();
    }

    /// REST /api/v3/account: replaces the balances, except assets the user stream has set since the
    /// snapshot's updateTime (absent from the snapshot = zero).
    pub fn apply_spot_snapshot(&mut self, r: &Value) -> Result<()> {
        let u = int_or(r, &["updateTime"], 0)?;
        let mut rows: HashMap<String, (f64, f64)> = HashMap::new();
        for b in get(r, "balances")?.as_array().ok_or_else(|| anyhow!("balances: not a list"))? {
            rows.insert(s(b, "asset")?.to_string(), (f(b, "free")?, f(b, "locked")?));
        }
        let assets: HashSet<String> = self.balances.keys().chain(rows.keys()).cloned().collect();
        for a in assets {
            if self.bal_u.get(&a).copied().unwrap_or(0) > u {
                continue;
            }
            let (f, l) = rows.get(&a).copied().unwrap_or((0.0, 0.0));
            if f != 0.0 || l != 0.0 {
                if !STABLES.contains(&a.as_str()) {
                    self.touch_asset(&a);
                }
                self.balances.insert(a.clone(), (f, l));
            } else {
                self.balances.remove(&a);
            }
            self.bal_u.insert(a, u);
        }
        self.updated = now_ms();
        Ok(())
    }

    /// outboundAccountPosition: absolute free / locked of the assets that changed, as of `u`.
    pub fn apply_spot_position(&mut self, e: &Value) -> Result<()> {
        let u = int_or(e, &["u", "E"], 0)?;
        let mut rows = vec![];
        for b in get(e, "B")?.as_array().ok_or_else(|| anyhow!("B: not a list"))? {
            let a = s(b, "a")?;
            if u >= self.bal_u.get(a).copied().unwrap_or(0) {
                self.bal_u.insert(a.to_string(), u);
                rows.push((a.to_string(), f(b, "f")?, f(b, "l")?));
            }
        }
        self.set_balances(rows, false);
        Ok(())
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
            self.touch_symbol(symbol, Venue::Usdm);
        }
    }

    #[allow(clippy::too_many_arguments)]
    pub fn order_update(&mut self, venue: Venue, symbol: &str, oid: &str, side: &str, price: f64, left: f64, status: &str,
                        created: Option<i64>) {
        let k = venue_key(venue, oid);
        if OPEN_STATES.contains(&status) {
            self.open.insert(k.clone(), Open { symbol: symbol.to_string(), venue, side: side_of(side), price, left });
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

    pub fn set_fee(&mut self, venue: Venue, symbol: &str, maker: f64, taker: f64) {
        let v = (maker, taker);
        match self.fees.iter_mut().find(|((ve, s), _)| *ve == venue && s == symbol) {
            Some(x) => x.1 = v,
            None => self.fees.push(((venue, symbol.to_string()), v)),
        }
        let k = (venue, symbol.to_string());
        if let std::collections::hash_map::Entry::Vacant(slot) = self.first_fees.entry(k) {
            slot.insert(v);
            let cb = self.on_fee.clone();
            cb(self, venue, symbol, v);
        }
    }

    pub fn fee_rows(&self) -> Vec<P::FeeRate> {
        let mut out = vec![];
        for venue in Venue::ALL {
            let ks: Vec<_> = self.fees.iter().filter(|((v, _), _)| *v == venue).collect();
            if ks.is_empty() {
                continue;
            }
            let specific: Vec<_> = ks.iter().filter(|((_, s), _)| s != "*").collect();
            let (maker, taker) = specific.last().map_or_else(|| ks.last().unwrap().1, |x| x.1);
            let changed = ks.iter().any(|(k, (m, t))| {
                let (m0, t0) = self.first_fees.get(k).copied().unwrap_or((*m, *t));
                (m - m0).abs() > 1e-9 || (t - t0).abs() > 1e-9
            });
            out.push(P::FeeRate { venue, maker_bps: maker * 1e4, taker_bps: taker * 1e4, changed });
        }
        out
    }

    // user data events

    pub fn on_spot_event(&mut self, e: &Value) -> Result<()> {
        match e.get("e").and_then(Value::as_str) {
            Some("outboundAccountPosition") => self.apply_spot_position(e)?,
            Some("balanceUpdate") => {
                // a transfer in or out, seconds before the transfer history shows it
                let t = int_or(e, &["T", "E"], 0)?;
                let t = if t != 0 { t } else { now_ms() };
                self.moves.push((t, s(e, "a")?.to_string(), f(e, "d")?));
            }
            Some("executionReport") => {
                let x = s(e, "x")?;
                if x == "NEW" {
                    let t = int_or(e, &["E"], 0)?;
                    self.count_new(if t != 0 { t } else { now_ms() });
                }
                let sym = s(e, "s")?;
                let created = first(e, &["O"]).map(to_i).transpose()?;
                self.order_update(Venue::Spot, sym, &id_str(get(e, "i")?), s(e, "S")?, f(e, "p")?, f(e, "q")? - f(e, "z")?,
                                  s(e, "X")?, created);
                if x == "TRADE" {
                    self.traded.insert(venue_key(Venue::Spot, sym));
                    let mut fr = FillRec::new(format!("{}:spot:{sym}:{}", self.id, id_str(get(e, "t")?)), to_i(get(e, "T")?)?,
                                              self.id.clone(), sym, Venue::Spot, side_of(s(e, "S")?), f(e, "L")?, f(e, "l")?);
                    fr.fee = f_or0(e, "n")?;
                    fr.fee_asset = first(e, &["N"]).and_then(Value::as_str).unwrap_or("").to_string();
                    fr.maker = truthy(get(e, "m")?);
                    let cb = self.on_fill.clone();
                    cb(fr);
                }
            }
            _ => {}
        }
        Ok(())
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

    pub fn on_fut_event(&mut self, e: &Value) -> Result<()> {
        match e.get("e").and_then(Value::as_str) {
            Some("ORDER_TRADE_UPDATE") => {
                let o = get(e, "o")?;
                let sym = s(o, "s")?;
                let created = first(e, &["T"]).map(to_i).transpose()?;
                self.order_update(Venue::Usdm, sym, &id_str(get(o, "i")?), s(o, "S")?, f(o, "p")?, f(o, "q")? - f(o, "z")?,
                                  s(o, "X")?, created);
                if s(o, "x")? == "TRADE" {
                    self.traded.insert(venue_key(Venue::Usdm, sym));
                    let mut fr = FillRec::new(format!("{}:usdm:{sym}:{}", self.id, id_str(get(o, "t")?)), to_i(get(o, "T")?)?,
                                              self.id.clone(), sym, Venue::Usdm, side_of(s(o, "S")?), f(o, "L")?, f(o, "l")?);
                    fr.fee = f_or0(o, "n")?;
                    fr.fee_asset = first(o, &["N"]).and_then(Value::as_str).unwrap_or("").to_string();
                    fr.maker = o.get("m").is_some_and(truthy);
                    self.fut_fill(sym, to_i(get(o, "t")?)?, &fr);
                    let cb = self.on_fill.clone();
                    cb(fr);
                }
            }
            Some("ACCOUNT_UPDATE") => {
                let a = get(e, "a")?;
                let u = int_or(e, &["T", "E"], 0)?;
                let empty = vec![];
                let bs = a.get("B").and_then(Value::as_array).unwrap_or(&empty);
                let reason = a.get("m").and_then(Value::as_str);
                if !matches!(reason, Some("ORDER" | "FUNDING_FEE")) {
                    // transfers: "bc" is the wallet change apart from P&L
                    for b in bs {
                        let bc = f_or0(b, "bc")?;
                        if bc != 0.0 {
                            self.moves.push((if u != 0 { u } else { now_ms() }, s(b, "a")?.to_string(), bc));
                        }
                    }
                }
                for b in bs {
                    if b.get("a").and_then(Value::as_str) == Some("USDT") && u >= self.fut_usdt_u {
                        let wb = f(b, "wb")?;
                        self.fut_wallet += wb - self.fut_usdt;
                        (self.fut_usdt, self.fut_usdt_u) = (wb, u);
                    }
                }
                for p in a.get("P").and_then(Value::as_array).unwrap_or(&empty) {
                    if matches!(p.get("ps").and_then(Value::as_str).unwrap_or("BOTH"), "BOTH" | "LONG" | "SHORT") {
                        self.set_position(s(p, "s")?, f(p, "pa")?, f(p, "ep")?, Some(u), 0);
                    }
                }
                self.updated = now_ms();
            }
            _ => {}
        }
        Ok(())
    }

    /// REST /fapi/v3/account, requested at t0 (server clock): a position or USDT balance the stream has
    /// updated since the snapshot's own updateTime is kept; a position absent from the snapshot is dropped
    /// unless the stream set it after the request went out.
    pub fn apply_fut_snapshot(&mut self, r: &Value, t0: i64) -> Result<()> {
        let empty = vec![];
        let usdt = r
            .get("assets")
            .and_then(Value::as_array)
            .unwrap_or(&empty)
            .iter()
            .find(|a| a.get("asset").and_then(Value::as_str) == Some("USDT"));
        match usdt {
            Some(usdt) => {
                self.set_fut_wallet(f(r, "totalWalletBalance")?, f(usdt, "walletBalance")?, int_or(usdt, &["updateTime"], 0)?, t0)
            }
            None => self.fut_wallet = f(r, "totalWalletBalance")?,
        }
        self.fut_upnl_rest = f(r, "totalUnrealizedProfit")?;
        self.fut_available = f(r, "availableBalance")?;
        let mut seen = HashSet::new();
        for p in r.get("positions").and_then(Value::as_array).unwrap_or(&empty) {
            let amt = f(p, "positionAmt")?;
            if amt != 0.0 {
                let upnl = match p.get("unrealizedProfit").or_else(|| p.get("unRealizedProfit")) {
                    Some(v) => to_f(v)?,
                    None => 0.0,
                };
                let notional = f(p, "notional")?;
                let sym = s(p, "symbol")?;
                self.set_position(sym, amt, (notional - upnl) / amt, Some(int_or(p, &["updateTime"], 0)?), t0);
                seen.insert(sym.to_string());
            }
        }
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
        Ok(())
    }
}

// live connections

/// The REST GETs an account makes (a fake in tests).
pub trait RestGet {
    fn get_json(&self, path: &str, params: &[(String, String)], weight: i64, signed: bool) -> impl Future<Output = Result<Value>>;
}

impl RestGet for Rest {
    async fn get_json(&self, path: &str, params: &[(String, String)], weight: i64, signed: bool) -> Result<Value> {
        self.get(path, params, weight, signed).await
    }
}

#[derive(Clone, Copy)]
enum Job {
    SpotAccount,
    RateLimits,
    OpenOrders,
    Commissions,
    FutAccount,
    FutToday,
    SpotTrades,
    MasterSpot,
    MasterFut,
}

async fn run_job(job: Job, acct: &AccountRef, rest: &Rest) -> Result<()> {
    match job {
        Job::SpotAccount => spot_account(acct, rest).await,
        Job::RateLimits => rate_limits(acct, rest).await,
        Job::OpenOrders => open_orders(acct, rest).await,
        Job::Commissions => commissions(acct, rest).await,
        Job::FutAccount => fut_account(acct, rest).await,
        Job::FutToday => fut_today(acct, rest).await,
        Job::SpotTrades => spot_trades(acct, rest).await,
        Job::MasterSpot => master_spot(acct, rest).await,
        Job::MasterFut => master_fut(acct, rest).await,
    }
}

async fn poll(acct: AccountRef, rest: Rest, job: Job, every: f64, delay: f64) {
    tokio::time::sleep(Duration::from_secs_f64(delay)).await;
    loop {
        let r = run_job(job, &acct, &rest).await;
        let feed = acct.borrow().rest_feed.clone();
        match r {
            Ok(()) => feed.borrow_mut().set_up(true, Some("")),
            Err(e) => feed.borrow_mut().set_up(false, Some(&err_text(&e))),
        }
        tokio::time::sleep(Duration::from_secs_f64(every)).await;
    }
}

/// The account's own key: user streams and REST polls, as `spawn_local` tasks (abort to stop).
/// `rest` carries the account's credentials and its `rest_feed`.
pub fn start(acct: &AccountRef, rest: Rest) -> Vec<JoinHandle<()>> {
    let (has_creds, futures) = {
        let a = acct.borrow();
        (a.creds.is_some(), a.cfg.futures)
    };
    if !has_creds {
        return vec![];
    }
    let p = |job, every, delay| tokio::task::spawn_local(poll(acct.clone(), rest.clone(), job, every, delay));
    let mut tasks = vec![
        tokio::task::spawn_local(spot_user(acct.clone())),
        p(Job::SpotAccount, 15.0, 0.0),
        p(Job::RateLimits, 15.0, 0.0),
        p(Job::OpenOrders, 60.0, 0.0),
        p(Job::Commissions, 60.0, 5.0),
        p(Job::SpotTrades, 600.0, 20.0),
    ];
    if futures {
        tasks.push(tokio::task::spawn_local(fut_user(acct.clone(), rest.clone())));
        tasks.push(p(Job::FutAccount, 10.0, 0.0));
        tasks.push(p(Job::FutToday, 60.0, 8.0));
    }
    tasks
}

/// Today's spot fills from REST, for those the user stream did not deliver (the monitor down or the
/// stream dropping): each tracked or traded symbol from where the last sweep reached, less 15 min. The
/// fill ids are the stream's, so a fill already seen is not added twice.
pub async fn spot_trades(acct: &AccountRef, rest: &impl RestGet) -> Result<()> {
    let (ds, from, syms, id, on_fill) = {
        let a = acct.borrow();
        if a.day_start == 0 {
            return Ok(());
        }
        let mut syms: Vec<String> = a.spot_symbols.clone();
        syms.extend(a.traded.iter().filter_map(|k| k.strip_prefix("spot:")).map(String::from));
        syms.sort();
        syms.dedup();
        let from = if a.trades_upto > a.day_start { (a.trades_upto - 15 * 60_000).max(a.day_start) } else { a.day_start };
        (a.day_start, from, syms, a.id.clone(), a.on_fill.clone())
    };
    let started = CLOCK.now();
    for sym in syms {
        let mut start = from;
        loop {
            let q: Params = params!["symbol" => sym, "startTime" => start, "limit" => 1000];
            let r = rest.get_json("/api/v3/myTrades", &q, 20, true).await?;
            let rows = r.as_array().ok_or_else(|| anyhow!("myTrades: not a list"))?;
            for x in rows {
                let ts = to_i(get(x, "time")?)?;
                if ts < ds {
                    continue;
                }
                let side = if truthy(get(x, "isBuyer")?) { Side::Buy } else { Side::Sell };
                let mut fr = FillRec::new(format!("{id}:spot:{sym}:{}", id_str(get(x, "id")?)), ts, id.clone(), &sym,
                                          Venue::Spot, side, f(x, "price")?, f(x, "qty")?);
                fr.fee = f_or0(x, "commission")?;
                fr.fee_asset = first(x, &["commissionAsset"]).and_then(Value::as_str).unwrap_or("").to_string();
                fr.maker = truthy(get(x, "isMaker")?);
                on_fill(fr);
            }
            match rows.last() {
                Some(last) if rows.len() >= 1000 => start = to_i(get(last, "time")?)? + 1,
                _ => break,
            }
        }
    }
    let mut a = acct.borrow_mut();
    if a.day_start == ds {
        a.trades_upto = started;
    }
    Ok(())
}

/// No key of its own: `master_rest` carries the master's credentials and this account's `rest_feed`.
pub fn start_via_master(acct: &AccountRef, master_rest: Rest, delay: f64) -> Vec<JoinHandle<()>> {
    vec![
        tokio::task::spawn_local(poll(acct.clone(), master_rest.clone(), Job::MasterSpot, 30.0, delay)),
        tokio::task::spawn_local(poll(acct.clone(), master_rest, Job::MasterFut, 30.0, delay + 2.0)),
    ]
}

async fn master_spot(acct: &AccountRef, rest: &impl RestGet) -> Result<()> {
    let email = acct.borrow().email.clone();
    let r = rest.get_json("/sapi/v3/sub-account/assets", &params!["email" => email], 60, true).await?;
    let mut rows = vec![];
    for b in get(&r, "balances")?.as_array().ok_or_else(|| anyhow!("balances: not a list"))? {
        rows.push((s(b, "asset")?.to_string(), f(b, "free")?, f(b, "locked")?));
    }
    let mut a = acct.borrow_mut();
    a.set_balances(rows, true);
    a.spot_loaded = true;
    Ok(())
}

async fn master_fut(acct: &AccountRef, rest: &impl RestGet) -> Result<()> {
    let email = acct.borrow().email.clone();
    let q: Params = params!["email" => email, "futuresType" => 1];
    let r = rest.get_json("/sapi/v2/sub-account/futures/account", &q, 10, true).await?;
    let a = get(&r, "futureAccountResp")?;
    let wallet = f(a, "totalWalletBalance")?;
    let upnl = f(a, "totalUnrealizedProfit")?;
    let avail = match a.get("maxWithdrawAmount").or_else(|| a.get("availableBalance")) {
        Some(v) => to_f(v)?,
        None => 0.0,
    };
    {
        let mut ac = acct.borrow_mut();
        (ac.fut_wallet, ac.fut_upnl_rest, ac.fut_available) = (wallet, upnl, avail);
    }
    let r = rest.get_json("/sapi/v2/sub-account/futures/positionRisk", &q, 10, true).await?;
    let mut rows = vec![];
    if let Some(ps) = r.get("futurePositionRiskVOS").and_then(Value::as_array) {
        for p in ps {
            let amt = f(p, "positionAmount")?;
            if amt != 0.0 {
                rows.push((s(p, "symbol")?.to_string(), amt, f(p, "entryPrice")?));
            }
        }
    }
    let mut ac = acct.borrow_mut();
    let seen: HashSet<String> = rows.iter().map(|r| r.0.clone()).collect();
    for (sym, amt, entry) in rows {
        ac.set_position(&sym, amt, entry, None, 0);
    }
    ac.positions.retain(|s, _| seen.contains(s));
    ac.fut_loaded = true;
    ac.updated = now_ms();
    Ok(())
}

async fn spot_account(acct: &AccountRef, rest: &impl RestGet) -> Result<()> {
    let r = rest.get_json("/api/v3/account", &params!["omitZeroBalances" => "true"], 20, true).await?;
    let mut a = acct.borrow_mut();
    a.apply_spot_snapshot(&r)?;
    if let Some(c) = first(&r, &["commissionRates"]) {
        a.set_fee(Venue::Spot, "*", f(c, "maker")?, f(c, "taker")?);
    }
    a.spot_loaded = true;
    Ok(())
}

async fn fut_account(acct: &AccountRef, rest: &impl RestGet) -> Result<()> {
    let t0 = CLOCK.now();
    let r = rest.get_json("/fapi/v3/account", &[], 5, true).await?;
    acct.borrow_mut().apply_fut_snapshot(&r, t0)
}

/// Today's futures fills, funding and each symbol's mark at the day start, from REST: complete
/// across monitor restarts, unlike the user stream.
pub async fn fut_today(acct: &AccountRef, rest: &impl RestGet) -> Result<()> {
    let (ds, syms, market) = {
        let mut a = acct.borrow_mut();
        let ds = a.day_start;
        if ds == 0 {
            return Ok(());
        }
        if a.fut_day.values().any(|d| d.ds != ds) {
            a.fut_day.clear();
        }
        let mut syms: HashSet<String> =
            a.positions.iter().filter(|(_, (amt, _))| *amt != 0.0).map(|(s, _)| s.clone()).collect();
        syms.extend(a.traded.iter().filter_map(|k| k.strip_prefix("usdm:")).map(String::from));
        syms.extend(a.fut_day.keys().cloned());
        (ds, syms, a.market.clone())
    };
    if syms.is_empty() {
        return Ok(());
    }
    let mut funding: HashMap<String, f64> = HashMap::new();
    let mut t = ds;
    loop {
        let q: Params = params!["incomeType" => "FUNDING_FEE", "startTime" => t, "limit" => 1000];
        let r = rest.get_json("/fapi/v1/income", &q, 30, true).await?;
        let rows = r.as_array().ok_or_else(|| anyhow!("income: not a list"))?;
        for x in rows {
            *funding.entry(s(x, "symbol")?.to_string()).or_insert(0.0) += f(x, "income")?;
        }
        match rows.last() {
            Some(last) if rows.len() >= 1000 => t = to_i(get(last, "time")?)? + 1,
            _ => break,
        }
    }
    let mut all: Vec<String> = syms.into_iter().chain(funding.keys().cloned()).collect::<HashSet<_>>().into_iter().collect();
    all.sort();
    for sym in all {
        let mut d = acct.borrow().fut_day.get(&sym).cloned().unwrap_or_else(|| FutDay::new(ds));
        let mut trades = BTreeMap::new();
        let mut frm: Option<i64> = None;
        loop {
            let mut q: Params = params!["symbol" => sym, "limit" => 1000];
            match frm {
                Some(id) => q.push(("fromId".into(), id.to_string())),
                None => q.push(("startTime".into(), ds.to_string())),
            }
            let r = rest.get_json("/fapi/v1/userTrades", &q, 5, true).await?;
            let rows = r.as_array().ok_or_else(|| anyhow!("userTrades: not a list"))?;
            for x in rows {
                let ts = to_i(get(x, "time")?)?;
                if ts < ds {
                    continue;
                }
                let qty = f(x, "qty")?;
                let mut fee = f(x, "commission")?;
                let asset = s(x, "commissionAsset")?;
                if !matches!(asset, "USDT" | "USDC")
                    && let Some(m) = &market
                {
                    fee *= m.borrow_mut().asset_price(asset).unwrap_or(0.0);
                }
                trades.insert(to_i(get(x, "id")?)?, (ts, if s(x, "side")? == "BUY" { qty } else { -qty }, f(x, "price")?, fee));
            }
            match rows.last() {
                Some(last) if rows.len() >= 1000 => frm = Some(to_i(get(last, "id")?)? + 1),
                _ => break,
            }
        }
        d.trades = trades;
        d.funding = funding.get(&sym).copied().unwrap_or(0.0);
        if d.m0.is_none() {
            let q: Params = params!["symbol" => sym, "interval" => "1m", "startTime" => ds, "limit" => 1];
            let k = rest.get_json("/fapi/v1/markPriceKlines", &q, 1, false).await?;
            if let Some(k0) = k.as_array().and_then(|k| k.first())
                && to_i(&k0[0])? == ds
            {
                d.m0 = Some(to_f(&k0[1])?);
            }
        }
        // fills the stream added while REST was answering are newer than its list: kept
        let mut a = acct.borrow_mut();
        if let Some(cur) = a.fut_day.get(&sym).filter(|c| c.ds == d.ds) {
            for (id, t) in &cur.trades {
                d.trades.entry(*id).or_insert(*t);
            }
        }
        a.fut_day.insert(sym, d);
    }
    Ok(())
}

async fn rate_limits(acct: &AccountRef, rest: &impl RestGet) -> Result<()> {
    if acct.borrow().no_order_counts {
        return Ok(());
    }
    let rows = match rest.get_json("/api/v3/rateLimit/order", &[], 40, true).await {
        Ok(r) => r,
        Err(e) if e.downcast_ref::<RestError>().is_some() => {
            if !e.to_string().contains("-2015") {
                return Err(e);
            }
            acct.borrow_mut().no_order_counts = true;   // this endpoint wants a trading key; read-only keys get -2015
            return Ok(());
        }
        Err(e) => return Err(e),
    };
    let mut a = acct.borrow_mut();
    for r in rows.as_array().ok_or_else(|| anyhow!("rateLimit/order: not a list"))? {
        if s(r, "rateLimitType")? != "ORDERS" {
            continue;
        }
        let count = match r.get("count") {
            Some(v) => to_i(v)?,
            None => 0,
        };
        match s(r, "interval")? {
            "SECOND" => (a.orders_10s, a.orders_10s_limit) = (count, to_i(get(r, "limit")?)?),
            "DAY" => (a.orders_1d, a.orders_1d_limit) = (count, to_i(get(r, "limit")?)?),
            _ => {}
        }
    }
    Ok(())
}

async fn open_orders(acct: &AccountRef, rest: &impl RestGet) -> Result<()> {
    let orders = rest.get_json("/api/v3/openOrders", &[], 80, true).await?;
    let mut rows = vec![];
    for o in orders.as_array().ok_or_else(|| anyhow!("openOrders: not a list"))? {
        let created = first(o, &["time"]).map(to_i).transpose()?;
        rows.push((s(o, "symbol")?.to_string(), id_str(get(o, "orderId")?), s(o, "side")?.to_string(), f(o, "price")?,
                   f(o, "origQty")? - f(o, "executedQty")?, s(o, "status")?.to_string(), created));
    }
    let mut a = acct.borrow_mut();
    a.open.retain(|k, _| !k.starts_with("spot:"));
    for (sym, oid, side, price, left, status, created) in rows {
        a.order_update(Venue::Spot, &sym, &oid, &side, price, left, &status, created);
    }
    let Account { open, open_since, .. } = &mut *a;
    open_since.retain(|k, _| open.contains_key(k));
    Ok(())
}

/// One symbol per venue per lookup (hourly), rotating: the spot endpoint costs 20 weight a symbol.
/// Until a venue has a symbol to ask about, its account-wide default rate stands in; so polled each
/// minute, and a venue's hour counts from its first lookup.
pub async fn commissions(acct: &AccountRef, rest: &impl RestGet) -> Result<()> {
    let now = CLOCK.now();
    let (spot, usdm, turn) = {
        let mut a = acct.borrow_mut();
        let (si, ui) = (Venue::Spot.index(), Venue::Usdm.index());
        let mut spot: Vec<String> = if now >= a.fee_next[si] {
            a.traded.iter().filter_map(|k| k.strip_prefix("spot:")).map(String::from).collect()
        } else {
            vec![]
        };
        spot.sort();
        let mut usdm: Vec<String> = if !a.cfg.futures || now < a.fee_next[ui] {
            vec![]
        } else {
            let mut set: HashSet<String> =
                a.positions.iter().filter(|(_, (amt, _))| *amt != 0.0).map(|(p, _)| p.clone()).collect();
            set.extend(a.traded.iter().filter_map(|k| k.strip_prefix("usdm:")).map(String::from));
            set.into_iter().collect()
        };
        usdm.sort();
        if spot.is_empty() && usdm.is_empty() {
            return Ok(());
        }
        let turn = a.fee_turn;
        a.fee_turn += 1;
        if !spot.is_empty() {
            a.fee_next[si] = now + 3_600_000;
        }
        (spot, usdm, turn)
    };
    if !spot.is_empty() {
        let sym = &spot[turn % spot.len()];
        let r = rest.get_json("/api/v3/account/commission", &params!["symbol" => sym], 20, true).await?;
        let parts: Vec<&Value> = ["standardCommission", "specialCommission", "taxCommission"]
            .iter()
            .map(|k| first(&r, &[k]).unwrap_or(&Value::Null))
            .collect();
        let sum = |k: &str| -> Result<f64> {
            parts.iter().map(|p| p.get(k).map_or(Ok(0.0), to_f)).sum()
        };
        let (maker, taker) = (sum("maker")?, sum("taker")?);
        acct.borrow_mut().set_fee(Venue::Spot, sym, maker, taker);
    }
    if !usdm.is_empty() {
        acct.borrow_mut().fee_next[Venue::Usdm.index()] = now + 3_600_000;
        let sym = &usdm[turn % usdm.len()];
        let r = rest.get_json("/fapi/v1/commissionRate", &params!["symbol" => sym], 20, true).await?;
        let (maker, taker) = (f(&r, "makerCommissionRate")?, f(&r, "takerCommissionRate")?);
        acct.borrow_mut().set_fee(Venue::Usdm, sym, maker, taker);
    }
    Ok(())
}

#[derive(Serialize)]
struct LogonParams<'a> {
    #[serde(rename = "apiKey")]
    api_key: &'a str,
    timestamp: i64,
    signature: String,
}

fn status_msg(m: &Value) -> String {
    m.get("error")
        .and_then(|e| e.get("msg"))
        .or_else(|| m.get("status"))
        .map_or_else(|| "None".into(), id_str)
}

/// Spot user data over the WS API: `session.logon` (Ed25519) then subscribe, or a signed subscribe (HMAC).
async fn spot_user(acct: AccountRef) {
    let (feed, creds) = {
        let a = acct.borrow();
        (a.feeds[0].clone(), a.creds.clone().expect("spot user stream without credentials"))
    };
    let ws_ref: Rc<RefCell<Option<WsHandle>>> = Rc::default();
    let w1 = ws_ref.clone();
    let on_open = async move |ws: &mut WsConn| -> Result<()> {
        *w1.borrow_mut() = Some(ws.handle());
        let timestamp = CLOCK.now();
        let payload = query(&[("apiKey", creds.api_key.clone()), ("timestamp", timestamp.to_string())]);
        let params = LogonParams { api_key: &creds.api_key, timestamp, signature: creds.signer.sign(&payload) };
        if creds.signer.kind() == "ed25519" {
            ws_api_call(ws, "logon", "session.logon", Some(&params)).await?;
            // subscribe only once logged on
            let r = tokio::time::timeout(Duration::from_secs(10), ws.recv_text()).await.map_err(|_| anyhow!("session.logon: timeout"))??;
            let r: Value = serde_json::from_str(&r)?;
            if r.get("status").and_then(Value::as_i64) != Some(200) {
                bail!("session.logon: {}", status_msg(&r));
            }
            ws_api_call(ws, "sub", "userDataStream.subscribe", None::<()>).await?;
        } else {
            ws_api_call(ws, "sub", "userDataStream.subscribe.signature", Some(&params)).await?;
        }
        Ok(())
    };
    let f2 = feed.clone();
    let on_msg = move |raw: &str| {
        let Ok(m) = serde_json::from_str::<Value>(raw) else { return };
        let close = || {
            if let Some(ws) = ws_ref.borrow().as_ref() {
                ws.close();
            }
        };
        if let Some(e) = m.get("event").filter(|e| !e.is_null()) {
            if e.get("e").and_then(Value::as_str) == Some("eventStreamTerminated") {
                f2.borrow_mut().error = "event stream terminated".into();
                close();
            } else if let Err(err) = acct.borrow_mut().on_spot_event(e) {
                tracing::warn!("spot user event: {err:#}");
            }
        } else if m.get("status").and_then(Value::as_i64).unwrap_or(200) != 200 {
            f2.borrow_mut().error = format!("{}: {}", m.get("id").map_or_else(|| "None".into(), id_str), status_msg(&m));
            close();
        }
    };
    run_ws(|| WS_API.to_string(), feed, on_msg, on_open, None).await;
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ListenKey {
    listen_key: String,
}

#[derive(Default)]
struct FutState {
    key: String,
    ws: Option<WsHandle>,
}

async fn new_key(rest: &Rest, feed: &FeedRef, state: &RefCell<FutState>) {
    loop {
        let r: Result<ListenKey> = rest.listen_key("POST").await;
        match r {
            Ok(k) => {
                state.borrow_mut().key = k.listen_key;
                return;
            }
            Err(e) => {
                let d: String = format!("listenKey: {e:#}").chars().take(200).collect();
                feed.borrow_mut().set_up(false, Some(&d));
                tokio::time::sleep(Duration::from_secs(30)).await;
            }
        }
    }
}

async fn renew(rest: Rest, feed: FeedRef, state: Rc<RefCell<FutState>>) {
    new_key(&rest, &feed, &state).await;
    let ws = state.borrow().ws.clone();
    if let Some(ws) = ws {
        ws.close();
    }
}

async fn keepalive(rest: Rest, feed: FeedRef, state: Rc<RefCell<FutState>>) {
    loop {
        tokio::time::sleep(Duration::from_secs(1800)).await;
        let r: Result<Value> = rest.listen_key("PUT").await;
        if r.is_err() {
            renew(rest.clone(), feed.clone(), state.clone()).await;
        }
    }
}

struct AbortOnDrop(JoinHandle<()>);

impl Drop for AbortOnDrop {
    fn drop(&mut self) {
        self.0.abort();
    }
}

/// USD-M user data: listenKey stream, kept alive every 30 min, renewed when it expires.
async fn fut_user(acct: AccountRef, rest: Rest) {
    let feed = acct.borrow().feeds[1].clone();
    let state: Rc<RefCell<FutState>> = Rc::default();
    new_key(&rest, &feed, &state).await;
    let _ka = AbortOnDrop(tokio::task::spawn_local(keepalive(rest.clone(), feed.clone(), state.clone())));
    let s1 = state.clone();
    let on_open = async move |ws: &mut WsConn| -> Result<()> {
        s1.borrow_mut().ws = Some(ws.handle());
        Ok(())
    };
    let (f2, s2) = (feed.clone(), state.clone());
    let on_msg = move |raw: &str| {
        let Ok(m) = serde_json::from_str::<Value>(raw) else { return };
        if m.get("e").and_then(Value::as_str) == Some("listenKeyExpired") {
            f2.borrow_mut().error = "listen key expired".into();
            tokio::task::spawn_local(renew(rest.clone(), f2.clone(), s2.clone()));
        } else if let Err(err) = acct.borrow_mut().on_fut_event(&m) {
            tracing::warn!("usdm user event: {err:#}");
        }
    };
    let s3 = state.clone();
    run_ws(move || format!("{USDM_PRIVATE}{}", s3.borrow().key), feed, on_msg, on_open, None).await;
}

/// One universal transfer: (time, from email, to email, asset, amount).
#[derive(Debug, Clone, PartialEq)]
pub struct Transfer {
    pub ts: i64,
    pub frm: String,
    pub to: String,
    pub asset: String,
    pub amount: f64,
}

pub type TransfersRef = Rc<RefCell<Transfers>>;
/// Called once per new transfer record (the store keeps them).
pub type OnRecord = Rc<dyn Fn(&str, &Transfer)>;

/// Master-key view: universal transfers since the day start, and the sub-account list.
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

    /// Transfer history, plus stream-seen moves the history does not show yet. A move stays
    /// provisional for MOVE_HOLD_MS: sub-to-sub moves are matched by the history within a poll or
    /// two; a move between the account's own spot and futures shows on both streams and nets out.
    pub fn net_in_live(&self, acct: &mut Account, m: &mut Market, since: i64, now: i64) -> f64 {
        let mut net = self.net_in(&acct.email, m, since);
        acct.moves.retain(|mv| now - mv.0 < MOVE_HOLD_MS);
        let email = acct.email.to_lowercase();
        if email.is_empty() {
            // without an email the history cannot confirm a move; do not book it provisionally
            return net;
        }
        for (t, asset, d) in &acct.moves {
            if *t < since {
                continue;
            }
            let seen = self.records.values().any(|r| {
                (r.ts - t).abs() < MOVE_HOLD_MS
                    && r.asset == *asset
                    && (r.amount - d.abs()).abs() < 1e-9
                    && r.frm.to_lowercase() != r.to.to_lowercase()
                    && (if *d > 0.0 { r.to.to_lowercase() } else { r.frm.to_lowercase() }) == email
            });
            if !seen {
                net += d * m.asset_price(asset).unwrap_or(0.0);
            }
        }
        net
    }

    pub fn net_in(&self, email: &str, m: &mut Market, since: i64) -> f64 {
        if email.is_empty() {
            return 0.0;
        }
        let email = email.to_lowercase();
        let mut net = 0.0;
        for r in self.records.values() {
            let (frm, to) = (r.frm.to_lowercase(), r.to.to_lowercase());
            if r.ts < since || frm == to {
                continue;
            }
            let v = r.amount * m.asset_price(&r.asset).unwrap_or(0.0);
            if to == email {
                net += v;
            }
            if frm == email {
                net -= v;
            }
        }
        net
    }

    pub fn roll(&mut self, since: i64) {
        self.records.retain(|_, v| v.ts >= since);
    }
}

async fn transfers_poll(t: &TransfersRef, rest: &impl RestGet, n: u64, day_start: &impl Fn() -> i64) -> Result<()> {
    if n.is_multiple_of(60) {
        let r = rest.get_json("/sapi/v1/sub-account/list", &params!["limit" => 200], 1, true).await?;
        let empty = vec![];
        let subs = r.get("subAccounts").and_then(Value::as_array).unwrap_or(&empty);
        let frozen = subs.iter().filter(|s| s.get("isFreeze").is_some_and(truthy)).count();
        t.borrow_mut().sub_info =
            format!("{} sub-accounts", subs.len()) + &if frozen > 0 { format!(", {frozen} frozen") } else { String::new() };
    }
    let start = day_start();
    let (master_email, froms) = {
        let tb = t.borrow();
        let master_email = tb.master.as_ref().map(|m| m.borrow().email.clone()).unwrap_or_default();
        let mut froms: Vec<Option<String>> = vec![None];
        for a in &tb.accounts {
            let a = a.borrow();
            if !a.email.is_empty() && a.role == Role::Sub {
                froms.push(Some(a.email.clone()));
            }
        }
        (master_email, froms)
    };
    for frm in froms {
        let mut p: Params = params!["startTime" => start, "endTime" => CLOCK.now(), "limit" => 500];
        if let Some(frm) = frm {
            p.push(("fromEmail".into(), frm));
        }
        let r = rest.get_json("/sapi/v1/sub-account/universalTransfer", &p, 1, true).await?;
        let mut tb = t.borrow_mut();
        for x in r.get("result").and_then(Value::as_array).into_iter().flatten() {
            if x.get("status").and_then(Value::as_str).unwrap_or("SUCCESS") != "SUCCESS" {
                continue;
            }
            let email = |k: &str| first(x, &[k]).and_then(Value::as_str).map_or_else(|| master_email.clone(), String::from);
            let rec = Transfer {
                ts: to_i(get(x, "createTimeStamp")?)?,
                frm: email("fromEmail"),
                to: email("toEmail"),
                asset: s(x, "asset")?.to_string(),
                amount: f(x, "amount")?,
            };
            tb.add(&id_str(get(x, "tranId")?), rec);
        }
    }
    let mut tb = t.borrow_mut();
    tb.feed.borrow_mut().hit(1);
    tb.loaded = true;
    let d = format!("{} transfers today; {}", tb.records.len(), tb.sub_info);
    tb.feed.borrow_mut().set_up(true, Some(&d));
    Ok(())
}

/// Poll the transfer history every minute (the sub-account list hourly); `rest` carries the master's key.
pub async fn run_transfers(t: TransfersRef, rest: Rest, day_start: impl Fn() -> i64) {
    let ok = t.borrow().master.as_ref().is_some_and(|m| m.borrow().creds.is_some());
    if !ok {
        return;
    }
    let mut n = 0u64;
    loop {
        if let Err(e) = transfers_poll(&t, &rest, n, &day_start).await {
            let feed = t.borrow().feed.clone();
            feed.borrow_mut().set_up(false, Some(&err_text(&e)));
        }
        n += 1;
        tokio::time::sleep(Duration::from_secs(60)).await;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::market::{BookTicker, Info, SymbolInfo};
    use approx::assert_relative_eq;
    use serde_json::json;

    fn info(spot: &[(&str, SymbolInfo)]) -> Info {
        let mut i = Info::new();
        i.insert(Venue::Spot, spot.iter().cloned().map(|(k, v)| (k.to_string(), v)).collect());
        i.insert(Venue::Usdm, HashMap::new());
        i
    }

    fn cfg(id: &str, email: &str) -> AccountCfg {
        AccountCfg::new(id, id, email, Role::Sub)
    }

    // account state

    fn acct() -> (Account, MarketRef) {
        let mut m = Market::new(info(&[("XUSDT", SymbolInfo::new("X", "USDT", 5.0))]), 120.0, 100.0);
        m.ensure("XUSDT", Venue::Spot, None);
        m.on_book(Venue::Spot, &BookTicker::new("XUSDT", 100.0, 100.0, Some(1)));
        let m = Rc::new(RefCell::new(m));
        let mut c = cfg("a", "");
        c.futures = true;
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
        a.apply_spot_snapshot(&snap(50, 1.0, 900.0)).unwrap();
        assert_relative_eq!(eq(&a, &m), 1000.0);
        let stale = snap(100, 1.0, 900.0);   // read now ...
        a.on_spot_event(&pos(200, &[("X", 0.0, 0.0), ("USDT", 1000.0, 0.0)])).unwrap();   // ... the fill on the stream
        assert_relative_eq!(eq(&a, &m), 1000.0);
        a.apply_spot_snapshot(&stale).unwrap();   // ... applied late
        assert_relative_eq!(eq(&a, &m), 1000.0);
        assert!(a.balances.get("X").is_none_or(|x| *x == (0.0, 0.0)));
        a.on_spot_event(&pos(300, &[("USDT", 950.0, 50.0)])).unwrap();
        assert_relative_eq!(eq(&a, &m), 1000.0);
        a.apply_spot_snapshot(&json!({"updateTime": 300, "balances": [{"asset": "USDT", "free": "950", "locked": "50"}]}))
            .unwrap();
        assert_eq!(a.balances, HashMap::from([("USDT".to_string(), (950.0, 50.0))]));
        assert_relative_eq!(eq(&a, &m), 1000.0);
    }

    #[test]
    fn stream_event_older_than_snapshot_is_dropped() {
        let (mut a, _m) = acct();
        a.apply_spot_snapshot(&snap(500, 2.0, 800.0)).unwrap();
        a.on_spot_event(&pos(400, &[("X", 1.0, 0.0), ("USDT", 900.0, 0.0)])).unwrap();
        assert!(a.balances["X"] == (2.0, 0.0) && a.balances["USDT"] == (800.0, 0.0));
        a.on_spot_event(&pos(500, &[("X", 3.0, 0.0)])).unwrap();   // same update time: absolute values, applied
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
        a.apply_fut_snapshot(&fut(&[("YUSDT", 5.0, 100)], (1000.0, 100), 1003.0), 150).unwrap();
        assert!(a.positions["YUSDT"].0 == 5.0);
        assert_relative_eq!(a.fut_wallet, 1003.0);
        let stale = fut(&[("YUSDT", 5.0, 100)], (1000.0, 100), 1003.0);   // read at 300 ...
        a.on_fut_event(&acct_update(400, Some(998.0), &[("YUSDT", 2.0), ("ZUSDT", -1.0)])).unwrap();   // ... a fill at 400
        assert!(a.positions["YUSDT"].0 == 2.0);
        assert_relative_eq!(a.fut_wallet, 1001.0);
        a.apply_fut_snapshot(&stale, 300).unwrap();
        assert!(a.positions["YUSDT"].0 == 2.0 && a.positions["ZUSDT"].0 == -1.0);
        assert_relative_eq!(a.fut_wallet, 1001.0);
        // a later snapshot that saw the fill wins, and drops what it no longer lists
        a.apply_fut_snapshot(&fut(&[("YUSDT", 2.0, 400)], (998.0, 400), 1001.5), 500).unwrap();
        assert_eq!(a.positions.len(), 1);
        assert_eq!(a.positions["YUSDT"].0, 2.0);
        assert_relative_eq!(a.positions["YUSDT"].1, 10.0);
        assert_relative_eq!(a.fut_wallet, 1001.5);
        // a stream value a minute older than the request no longer pins anything
        a.on_fut_event(&acct_update(600, None, &[("YUSDT", 7.0)])).unwrap();
        a.apply_fut_snapshot(&fut(&[("YUSDT", 3.0, 0)], (998.0, 0), 1001.5), 70_000).unwrap();
        assert_eq!(a.positions["YUSDT"].0, 3.0);
    }

    // account P&L

    fn tr(ts: i64, frm: &str, to: &str, asset: &str, amount: f64) -> Transfer {
        Transfer { ts, frm: frm.into(), to: to.into(), asset: asset.into(), amount }
    }

    #[test]
    fn day_pnl_excludes_transfers() {
        let mut m = Market::new(info(&[]), 120.0, 100.0);
        let a = Account::new(cfg("a", "a@x.io"), None, "").shared();
        let b = Account::new(cfg("b", "B@x.io"), None, "").shared();
        let mut t = Transfers::new(None, vec![a, b]);
        t.add("1", tr(100, "master@x.io", "a@x.io", "USDT", 1000.0));
        t.add("2", tr(200, "a@x.io", "b@x.io", "USDC", 300.0));
        t.add("3", tr(50, "a@x.io", "b@x.io", "USDT", 999.0));   // before the day start
        t.add("4", tr(300, "b@x.io", "b@x.io", "USDT", 50.0));   // inside one account (spot -> futures)
        assert_relative_eq!(t.net_in("a@x.io", &mut m, 100), 700.0);
        assert_relative_eq!(t.net_in("b@x.io", &mut m, 100), 300.0);
        // equity 10_000 at open, 1000 transferred in, 700 net in: +40 of trading (metrics::day_pnl)
        assert_relative_eq!(10_740.0 - 10_000.0 - 700.0, 40.0);
    }

    struct FakeRest {
        calls: RefCell<Vec<(String, String, i64)>>,
    }

    impl RestGet for FakeRest {
        async fn get_json(&self, path: &str, params: &[(String, String)], weight: i64, _signed: bool) -> Result<Value> {
            let sym = params.iter().find(|(k, _)| k == "symbol").map(|x| x.1.clone()).unwrap();
            self.calls.borrow_mut().push((path.into(), sym, weight));
            Ok(json!({"standardCommission": {"maker": "0.0001", "taker": "0.0002"}}))
        }
    }

    #[tokio::test(flavor = "current_thread")]
    async fn resting_notional_and_commission_rotation() {
        let a = Account::new(cfg("a", ""), None, "").shared();
        let r = FakeRest { calls: RefCell::new(vec![]) };
        commissions(&a, &r).await.unwrap();   // no symbol seen yet: waits, the default rate stands
        assert!(a.borrow().fee_next[Venue::Spot.index()] == 0 && r.calls.borrow().is_empty());
        {
            let mut a = a.borrow_mut();
            a.order_update(Venue::Spot, "XUSDT", "1", "BUY", 10.0, 3.0, "NEW", None);
            a.order_update(Venue::Spot, "XUSDT", "2", "SELL", 12.0, 1.0, "PARTIALLY_FILLED", None);
            a.order_update(Venue::Spot, "YUSDT", "3", "BUY", 5.0, 2.0, "NEW", None);
            a.order_update(Venue::Spot, "YUSDT", "3", "BUY", 5.0, 0.0, "FILLED", None);
            assert_eq!(a.resting(), (30.0, 12.0));
        }
        for _ in 0..3 {
            commissions(&a, &r).await.unwrap();
            commissions(&a, &r).await.unwrap();   // within the hour: no lookup
            a.borrow_mut().fee_next[Venue::Spot.index()] = 0;
        }
        let syms: Vec<String> = r.calls.borrow().iter().map(|c| c.1.clone()).collect();
        assert_eq!(syms, ["XUSDT", "YUSDT", "XUSDT"]);   // one symbol per poll, rotating
        assert!(r.calls.borrow().iter().all(|c| c.0 == "/api/v3/account/commission" && c.2 == 20));
        let rows = a.borrow().fee_rows();
        assert_eq!(rows.len(), 1);
        assert!(rows[0].venue == Venue::Spot && !rows[0].changed);
        assert_relative_eq!(rows[0].maker_bps, 1.0);
        assert_relative_eq!(rows[0].taker_bps, 2.0);
    }

    #[test]
    fn stream_moves_count_until_history_confirms() {
        let mut m = Market::new(info(&[]), 120.0, 100.0);
        let a = Account::new(cfg("a", "a@x.io"), None, "").shared();
        let b = Account::new(cfg("b", "b@x.io"), None, "").shared();
        let mut t = Transfers::new(None, vec![a.clone(), b.clone()]);
        a.borrow_mut().on_spot_event(&json!({"e": "balanceUpdate", "a": "USDT", "d": "-363", "T": 1_000})).unwrap();
        b.borrow_mut().on_spot_event(&json!({"e": "balanceUpdate", "a": "USDT", "d": "363", "T": 1_000})).unwrap();
        // before the history poll: the move is already out of both accounts' PnL
        assert_relative_eq!(t.net_in_live(&mut a.borrow_mut(), &mut m, 0, 2_000), -363.0);
        assert_relative_eq!(t.net_in_live(&mut b.borrow_mut(), &mut m, 0, 2_000), 363.0);
        // the history shows it: counted once
        t.add("1", tr(1_005, "a@x.io", "b@x.io", "USDT", 363.0));
        assert_relative_eq!(t.net_in_live(&mut a.borrow_mut(), &mut m, 0, 3_000), -363.0);
        assert_relative_eq!(t.net_in_live(&mut b.borrow_mut(), &mut m, 0, 3_000), 363.0);
        // long after: history only
        assert_relative_eq!(t.net_in_live(&mut b.borrow_mut(), &mut m, 0, 400_000), 363.0);
    }

    #[test]
    fn futures_leg_closed_form_with_fees_and_funding() {
        // Short 2 at the start (opening mark 100); sell 1 at 99 (fee 0.04) and buy 0.5 at 97 (fee 0.02);
        // mark now 96; funding received 0.3. Price P&L = -2 (96-100) - 1 (96-99) + 0.5 (96-97) = 10.5.
        let mut m = Market::new(info(&[]), 120.0, 100.0);
        let id = m.ensure("XUSDT", Venue::Usdm, None);
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
    fn futures_stream_fill_counts_before_rest_and_day_change_drops_the_old_day() {
        // Flat at the start (opening mark 100); the stream sells 2 at 90 and the position follows. Before any
        // REST pass the fill is today's, not a position held since the start: price P&L = -2 (88-90) = 4.
        let mut m = Market::new(info(&[]), 120.0, 100.0);
        let id = m.ensure("XUSDT", Venue::Usdm, None);
        m.insts[id].mark = Some(88.0);
        let mut a = Account::new(cfg("a", ""), None, "");
        a.day_start = 1_000;
        let mut d = FutDay::new(1_000);
        d.m0 = Some(100.0);
        a.fut_day.insert("XUSDT".into(), d);
        a.on_fut_event(&json!({"e": "ORDER_TRADE_UPDATE", "E": 2_001, "T": 2_000, "o": {"s": "XUSDT", "S": "SELL", "i": 9,
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
        a.on_spot_event(&json!({"e": "executionReport", "E": 1_000, "s": "XUSDT", "S": "BUY", "x": "NEW", "X": "NEW",
                                "i": 7, "p": "10", "q": "2", "z": "0", "O": 900})).unwrap();
        assert_eq!(a.orders_10s, 1);
        assert_eq!(a.open_since["spot:7"], 900);
        a.on_spot_event(&json!({"e": "executionReport", "E": 1_100, "s": "XUSDT", "S": "BUY", "x": "TRADE", "X": "FILLED",
                                "i": 7, "p": "10", "q": "2", "z": "2", "t": 55, "T": 1_050, "L": "10", "l": "2",
                                "n": "0.001", "N": "BNB", "m": true})).unwrap();
        assert!(a.open.is_empty() && a.open_since.is_empty());
        let f = &got.borrow()[0];
        assert!(f.id == "a:spot:XUSDT:55" && f.ts == 1_050 && f.side == Side::Buy && f.qty == 2.0 && f.fee_asset == "BNB" && f.maker);
    }
}
