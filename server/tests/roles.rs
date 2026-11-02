//! What roles do to the figures: a desk that makes markets on perps gets Trading PnL, market making and the rest for what
//! it trades and Hedge for what hedges, whichever market each is on, and the parts add up to Day PnL. The session is an
//! exchange in a few lines, through the same events and code as `session.rs`.
use std::cell::RefCell;
use std::collections::HashMap;
use std::rc::Rc;

use approx::assert_relative_eq;
use desk::accounts::{Account, AccountRef, Event, FutDay};
use desk::app::pnl_book;
use desk::binance::events as ev;
use desk::binance::public::on_mark_raw;
use desk::clock::CLOCK;
use desk::config::{AccountCfg, Config, MarketCfg, Ref};
use desk::fills::{FillBook, FillRec};
use desk::market::{Book, Info, Market, SymbolInfo, Venue};
use desk::metrics as me;
use desk::pnl::PnlBook;
use desk::protocol::{self as P, InstRole, Role, Roles};
use serde_json::json;

/// The clock is one, fixed by each test.
static SERIAL: std::sync::Mutex<()> = std::sync::Mutex::new(());

const D: i64 = 1_760_000_000_000 - 1_760_000_000_000 % 86_400_000;

fn t(min: i64) -> i64 {
    D + min * 60_000
}

/// A perp as the exchange counts it: wallet, position, entry. A fill realizes what it closes; fees and funding come off
/// or onto the wallet.
#[derive(Default, Clone, Copy)]
struct Book1 {
    amt: f64,
    entry: f64,
}

struct Desk {
    m: Rc<RefCell<Market>>,
    a: AccountRef,
    fills: Rc<RefCell<FillBook>>,
    pnl: Rc<RefCell<PnlBook>>,
    filled: Rc<RefCell<Vec<String>>>,
    cfg: Config,
    wallet: f64,
    pos: HashMap<&'static str, Book1>,
    tid: i64,
}

fn market() -> Market {
    let mut i: Info = HashMap::new();
    i.insert(Venue::SPOT, HashMap::from([("BBBUSDT".to_string(), SymbolInfo::new("BBB", "USDT", 5.0)), ("AAAUSDT".to_string(), SymbolInfo::new("AAA", "USDT", 5.0))]));
    i.insert(Venue::USDM, HashMap::from([("AAAUSDT".to_string(), SymbolInfo::new("AAA", "USDT", 5.0)), ("HHHUSDT".to_string(), SymbolInfo::new("HHH", "USDT", 5.0))]));
    Market::new(i, 120.0, 100.0)
}

impl Desk {
    fn new(roles: Roles) -> Desk {
        CLOCK.set_fixed(Some(t(0)));
        let m = Rc::new(RefCell::new(market()));
        let mut c = AccountCfg::new("mm", "mm", "", Role::Sub);
        c.markets.push(Venue::USDM);
        let mut acct = Account::new(c, None, "");
        acct.market = Some(m.clone());
        acct.day_start = D;
        acct.roles = Rc::new(roles.clone());
        let a = acct.shared();
        let cfg = Config { roles, ..Default::default() };
        let fills = Rc::new(RefCell::new(FillBook::new()));
        let filled: Rc<RefCell<Vec<String>>> = Rc::default();
        let pnl = Rc::new(RefCell::new(pnl_book(&cfg, std::slice::from_ref(&a), filled.clone(), D, Box::new(|_| 1.0))));
        {
            // as the desk's on_fill
            let (fills, m, pnl, filled, roles) = (fills.clone(), m.clone(), pnl.clone(), filled.clone(), cfg.roles.clone());
            a.borrow_mut().on_fill = Rc::new(move |f: FillRec| {
                let key = f.key();
                let booked = (roles.booked(&f.symbol, f.venue) && !f.conversion()).then(|| f.clone());
                let mut mk = m.borrow_mut();
                if fills.borrow_mut().add(&mut mk, f, true)
                    && let Some(f) = booked
                {
                    if !filled.borrow().contains(&key) {
                        filled.borrow_mut().push(key);
                    }
                    pnl.borrow_mut().on_fill_at(&mut mk, &f, true);
                }
            });
        }
        Desk { m, a, fills, pnl, filled, cfg, wallet: 1000.0, pos: HashMap::new(), tid: 100 }
    }

    /// Both a perp's book and mark at px, and spot's own pairs.
    fn price(&self, at: i64, sym: &str, venue: Venue, px: f64) {
        CLOCK.set_fixed(Some(at));
        let mut m = self.m.borrow_mut();
        m.ensure(sym, venue, None);
        m.on_book(venue, &Book::new(sym, px, px, Some(at)));
        if !venue.is_spot() {
            on_mark_raw(&mut m, venue, &format!(r#"{{"s":"{sym}","p":"{px}","r":"","T":0}}"#));
        }
    }

    fn open_position(&mut self, sym: &'static str, amt: f64, entry: f64) {
        self.pos.insert(sym, Book1 { amt, entry });
        let mut a = self.a.borrow_mut();
        let rows = self.pos.iter().map(|(s, p)| (s.to_string(), p.amt, p.entry, t(0))).collect();
        a.apply(Event::PerpSnapshot { t0: t(0), wallet: self.wallet, settle: Some((self.wallet, t(0))), upnl: 0.0, available: self.wallet, positions: rows });
    }

    fn balance(&self, at: i64, asset: &str, free: f64) {
        self.a.borrow_mut().apply(Event::Balances { u: at, rows: vec![(asset.to_string(), free, 0.0)] });
    }

    /// A perp fill as the exchange reports it: the fill, then the account with what it realized.
    fn perp_fill(&mut self, at: i64, sym: &'static str, buy: bool, px: f64, qty: f64, fee: f64) {
        let s = if buy { 1.0 } else { -1.0 };
        let p = self.pos.entry(sym).or_default();
        let closed = if p.amt * s < 0.0 { p.amt.abs().min(qty) } else { 0.0 };
        self.wallet += closed * -s * (px - p.entry) - fee;
        let opened = qty - closed;
        let new = p.amt + s * qty;
        p.entry = if opened > 0.0 { (p.amt.abs() * p.entry * (closed == 0.0) as i32 as f64 + opened * px) / new.abs() } else { p.entry };
        p.amt = new;
        let (amt, entry) = (p.amt, p.entry);
        self.tid += 1;
        let side = if buy { "BUY" } else { "SELL" };
        let mut a = self.a.borrow_mut();
        ev::on_fut_event(&mut a, &json!({"e": "ORDER_TRADE_UPDATE", "E": at + 1, "T": at, "o": {"s": sym, "S": side, "i": self.tid, "p": px.to_string(), "q": qty.to_string(), "z": qty.to_string(),
            "X": "FILLED", "x": "TRADE", "t": self.tid, "L": px.to_string(), "l": qty.to_string(), "n": fee.to_string(), "N": "USDT", "m": true, "T": at}})).unwrap();
        ev::on_fut_event(&mut a, &json!({"e": "ACCOUNT_UPDATE", "E": at + 2, "T": at + 1, "a": {"m": "ORDER",
            "B": [{"a": "USDT", "wb": self.wallet.to_string(), "cw": self.wallet.to_string(), "bc": "0"}],
            "P": [{"s": sym, "pa": amt.to_string(), "ep": entry.to_string(), "ps": "BOTH"}]}})).unwrap();
    }

    #[allow(clippy::too_many_arguments)]
    fn spot_fill(&mut self, at: i64, sym: &str, asset: &str, buy: bool, px: f64, qty: f64, fee: f64, new_asset: f64, new_usdt: f64) {
        let mut f = FillRec::new(format!("mm:spot:{sym}:{at}"), at, "mm", sym, Venue::SPOT, if buy { P::Side::Buy } else { P::Side::Sell }, px, qty);
        f.fee = fee;
        f.fee_asset = "USDT".into();
        let mut a = self.a.borrow_mut();
        a.apply(Event::Balances { u: at, rows: vec![(asset.to_string(), new_asset, 0.0), ("USDT".to_string(), new_usdt, 0.0)] });
        a.apply(Event::Fill { fill: Box::new(f), perp_trade: None });
    }

    /// The accounts' sweep of a symbol's day: its opening mark and funding.
    fn sweep(&self, sym: &str, m0: f64, funding: f64) {
        let mut d = FutDay::new(D);
        d.m0 = Some(m0);
        d.funding = funding;
        self.a.borrow_mut().apply(Event::PerpDay { symbol: sym.to_string(), day: d });
    }

    fn start(&self) {
        let mut a = self.a.borrow_mut();
        a.spot_loaded = true;
        a.fut_loaded = true;
        let mut m = self.m.borrow_mut();
        a.take_opening(&mut m, true).expect("opening taken");
        drop(a);
        self.pnl.borrow_mut().begin(&mut m, CLOCK.now());
    }

    fn figures(&self, now: i64) -> Figures {
        CLOCK.set_fixed(Some(now));
        let mut m = self.m.borrow_mut();
        let mut pnl = self.pnl.borrow_mut();
        pnl.step(&mut m, now);
        let mut fb = self.fills.borrow_mut();
        fb.mature(&m, now);
        let _ = fb.take_dirty();
        let roles = &self.cfg.roles;
        let agg = me::aggregate(&fb.fills, now, roles);
        let mm = me::mm_split(&mut m, &fb.fills, 60, now, roles, |b| pnl.pos.contains_key(b));
        let by_base = pnl.by_base(&mut m);
        let accounts = std::slice::from_ref(&self.a);
        let symbols = me::symbol_rows(&mut m, accounts, &by_base, &agg, &mm);
        let summary = pnl.summary(&mut m);
        let row = me::account_row(&mut m, &mut self.a.borrow_mut(), now);
        let bv = me::beta_weighted_spot(&self.cfg, &mut m, accounts, None);
        let expo = me::exposure(&self.cfg, &m, std::slice::from_ref(&row), bv, false, now);
        let legs = pnl.hedge_legs(&mut m, i64::MAX);
        let hedge = me::hedge_day(&self.cfg, &m, accounts, summary.ref_hedge, summary.factor_hedge, legs);
        let assets = me::inventory_assets(&mut m, accounts);
        Figures { row, summary, symbols, expo, hedge, mm_total: mm.total, fills_day: agg.fills_day, volume_day: agg.volume_day, bv, assets }
    }
}

struct Figures {
    row: P::Account,
    summary: P::PnlSummary,
    symbols: Vec<P::SymbolRow>,
    expo: P::Exposure,
    hedge: P::HedgeDay,
    mm_total: f64,
    fills_day: i64,
    volume_day: f64,
    bv: f64,
    assets: i64,
}

impl Figures {
    fn other(&self) -> f64 {
        self.row.pnl_day - self.summary.trading - self.hedge.hedge_pnl.unwrap() - self.row.rebates
    }

    fn sym(&self, s: &str, v: Venue) -> &P::SymbolRow {
        self.symbols.iter().find(|r| r.symbol == s && r.venue == v).unwrap()
    }
}

/// Long 2 AAA overnight at 90, marked 100 at the day start; sold through zero, bought back through zero, funding paid in;
/// marked 102 at the end. Short 1 HHH overnight at 200, marked 200 → 198.
fn session(d: &mut Desk) -> Figures {
    d.balance(t(0), "USDT", 500.0);
    d.price(t(0), "AAAUSDT", Venue::USDM, 100.0);
    d.price(t(0), "HHHUSDT", Venue::USDM, 200.0);
    d.open_position("AAAUSDT", 2.0, 90.0);
    d.open_position("HHHUSDT", -1.0, 200.0);
    d.sweep("AAAUSDT", 100.0, 0.0);
    d.sweep("HHHUSDT", 200.0, 0.0);
    d.start();
    assert_relative_eq!(d.a.borrow().equity_open.unwrap(), 500.0 + 1000.0 + 2.0 * 10.0);

    d.price(t(1), "AAAUSDT", Venue::USDM, 101.0);
    d.perp_fill(t(1) + 500, "AAAUSDT", false, 101.0, 3.0, 0.03);   // long 2 -> short 1
    d.price(t(2) + 500, "AAAUSDT", Venue::USDM, 100.5);
    d.figures(t(3));
    d.price(t(3), "AAAUSDT", Venue::USDM, 100.0);
    d.perp_fill(t(3) + 500, "AAAUSDT", true, 100.0, 1.0, 0.01);    // flat
    d.perp_fill(t(3) + 600, "AAAUSDT", true, 100.5, 1.0, 0.01);    // long 1 at 100.5
    d.figures(t(4));
    // funding, paid onto the wallet: the sweep has it
    d.wallet += 0.5;
    d.sweep("AAAUSDT", 100.0, 0.5);
    d.a.borrow_mut().apply(Event::PerpUpdate { u: t(5), funding: None, moves: vec![], settle: Some(d.wallet), positions: vec![] });
    d.price(t(6), "HHHUSDT", Venue::USDM, 198.0);
    d.price(t(6), "AAAUSDT", Venue::USDM, 102.0);
    d.figures(t(10))
}

const FEES: f64 = 0.05;
/// Q0 (M_T − M_D) + Σ s q (M_T − p) − fees + funding.
const AAA: f64 = 2.0 * 2.0 - 3.0 * (102.0 - 101.0) + (102.0 - 100.0) + (102.0 - 100.5) - FEES + 0.5;
const HHH: f64 = 200.0 - 198.0;

#[test]
fn with_no_role_a_perp_is_hedge_and_the_parts_add_up() {
    let _serial = SERIAL.lock().unwrap_or_else(|e| e.into_inner());
    let mut d = Desk::new(Roles::default());
    let f = session(&mut d);
    assert_relative_eq!(f.row.pnl_day, AAA + HHH, epsilon = 1e-9);
    assert_relative_eq!(f.summary.trading, 0.0);
    assert_relative_eq!(f.mm_total, 0.0);
    assert_relative_eq!(f.hedge.hedge_pnl.unwrap(), AAA + HHH, epsilon = 1e-9);
    assert_eq!((f.fills_day, f.volume_day), (0, 0.0));
    assert_relative_eq!(f.other(), 0.0, epsilon = 1e-9);
    assert_eq!(f.sym("AAAUSDT", Venue::USDM).trading_pnl, 0.0);
    assert!(d.pnl.borrow().pos.is_empty());
}

#[test]
fn a_desk_that_makes_markets_on_perps_gets_its_figures() {
    let _serial = SERIAL.lock().unwrap_or_else(|e| e.into_inner());
    let mut roles = Roles::default();
    roles.set_market(Venue::USDM, InstRole::Traded);
    roles.set("HHHUSDT", Venue::USDM, InstRole::Hedge);
    let mut d = Desk::new(roles);
    let f = session(&mut d);
    // Day PnL is what it was; the parts are now in their places
    assert_relative_eq!(f.row.pnl_day, AAA + HHH, epsilon = 1e-9);
    assert_relative_eq!(f.summary.trading, AAA, epsilon = 1e-9);
    assert_relative_eq!(f.hedge.hedge_pnl.unwrap(), HHH, epsilon = 1e-9);
    assert_relative_eq!(f.other(), 0.0, epsilon = 1e-9);
    assert_eq!(f.hedge.legs.iter().map(|l| l.symbol.as_str()).collect::<Vec<_>>(), ["HHHUSDT"]);
    // funding is in Trading PnL, and said so
    assert_relative_eq!(f.summary.funding_day, 0.5);
    // the realized split holds across a position through zero
    assert_relative_eq!(f.summary.realized + f.summary.realized_old + f.summary.floating, AAA, epsilon = 1e-9);
    // sold 2 of the opening at 101 against M_D = 100
    assert_relative_eq!(f.summary.realized_old, 2.0, epsilon = 1e-9);
    // short 1 at 101 bought back at 100, less all fees, plus funding
    assert_relative_eq!(f.summary.realized, 1.0 - FEES + 0.5, epsilon = 1e-9);
    assert_relative_eq!(f.summary.floating, 102.0 - 100.5, epsilon = 1e-9);
    // market making: each fill against its own market's mid 60 s on (the sell: 100.5 then; the buys: still 100), less fees
    let mm = 3.0 * (101.0 - 100.5) + (100.0 - 100.0) + (100.0 - 100.5) - FEES;
    assert_relative_eq!(f.mm_total, mm, epsilon = 1e-6);
    assert_relative_eq!(f.summary.trading - f.mm_total, AAA - mm, epsilon = 1e-6);
    // the instrument's row carries what the desk's figures sum
    let r = f.sym("AAAUSDT", Venue::USDM);
    assert_relative_eq!(r.trading_pnl, AAA, epsilon = 1e-9);
    assert_relative_eq!(r.mm_pnl, mm, epsilon = 1e-6);
    assert_relative_eq!(r.inv_pnl, AAA - mm, epsilon = 1e-6);
    assert_eq!(f.sym("HHHUSDT", Venue::USDM).trading_pnl, 0.0);
    // what it trades is its volume and its inventory; what hedges is the hedge notional
    assert_eq!(f.fills_day, 3);
    assert_relative_eq!(f.volume_day, 303.0 + 100.0 + 100.5, epsilon = 1e-9);
    assert_relative_eq!(f.expo.spot_value, 102.0, epsilon = 1e-9);
    assert_relative_eq!(f.expo.futures_notional, -198.0, epsilon = 1e-9);
    assert_relative_eq!(f.expo.hedge_notional, -198.0, epsilon = 1e-9);
    assert_relative_eq!(f.bv, 102.0, epsilon = 1e-9);
    assert_eq!(f.assets, 1);
    // M_k moved on the grid to the mark, so Π's position is the account's
    let pb = d.pnl.borrow();
    assert_relative_eq!(pb.pos["usdm:AAAUSDT"].q, 1.0, epsilon = 1e-12);
    assert!(pb.position_gaps(&mut d.m.borrow_mut(), &HashMap::from([("usdm:AAAUSDT".to_string(), 1.0)]), 0.01).is_empty());
}

#[test]
fn a_restart_and_a_new_day_keep_a_traded_perp() {
    let _serial = SERIAL.lock().unwrap_or_else(|e| e.into_inner());
    let mut roles = Roles::default();
    roles.set_market(Venue::USDM, InstRole::Traded);
    let mut d = Desk::new(roles);
    let before = session(&mut d);
    // a restart: a new book, today's fills reloaded, state kept
    let (_, state) = d.pnl.borrow_mut().flush();
    let state: desk::pnl::PnlState = serde_json::from_str(&serde_json::to_string(&state).unwrap()).unwrap();
    let mut fresh = pnl_book(&d.cfg, std::slice::from_ref(&d.a), d.filled.clone(), D, Box::new(|_| 1.0));
    {
        let mut m = d.m.borrow_mut();
        fresh.load_fills(&mut m, d.fills.borrow().fills.iter());
        fresh.load_state(Some(state), None);
        fresh.begin(&mut m, t(11));
        assert_relative_eq!(fresh.summary(&mut m).trading, before.summary.trading, epsilon = 1e-9);
    }
    *d.pnl.borrow_mut() = fresh;
    // the new day opens at the last mark, Π from 0; the position carries
    let ds = D + 86_400_000;
    let mut m = d.m.borrow_mut();
    let mut p = d.pnl.borrow_mut();
    p.step(&mut m, t(20));
    d.a.borrow_mut().day_start = ds;
    p.roll(&mut m, ds, None);
    assert_relative_eq!(p.summary(&mut m).trading, 0.0, epsilon = 1e-9);
    assert_relative_eq!(p.pos["usdm:AAAUSDT"].q0, 1.0, epsilon = 1e-12);
    assert_relative_eq!(p.m0["usdm:AAAUSDT"], 102.0);
    m.on_mark(Venue::USDM, &desk::market::Mark { symbol: "AAAUSDT", price: 103.0, funding: None, next_funding: None });
    assert_relative_eq!(p.summary(&mut m).trading, 1.0, epsilon = 1e-9);
}

#[test]
fn a_spot_asset_that_hedges_is_hedge_and_a_traded_perp_with_its_reference_has_h() {
    let _serial = SERIAL.lock().unwrap_or_else(|e| e.into_inner());
    let mut roles = Roles::default();
    roles.set_market(Venue::USDM, InstRole::Traded);
    roles.set("BBBUSDT", Venue::SPOT, InstRole::Hedge);
    let mut d = Desk::new(roles);
    // the book's scope is what the desk configures
    d.cfg.markets.push(MarketCfg { reference: Some(Ref { symbol: "AAAUSDT".into(), venue: Venue::SPOT }), ..MarketCfg::new("AAAUSDT", Venue::USDM) });
    {
        let mut m = d.m.borrow_mut();
        m.ensure("AAAUSDT", Venue::USDM, Some(("AAAUSDT", Venue::SPOT)));
    }
    d.balance(t(0), "USDT", 500.0);
    d.balance(t(0), "BBB", 10.0);
    d.price(t(0), "BBBUSDT", Venue::SPOT, 10.0);
    d.price(t(0), "AAAUSDT", Venue::SPOT, 100.0);
    d.price(t(0), "AAAUSDT", Venue::USDM, 100.0);
    d.open_position("AAAUSDT", 1.0, 100.0);
    d.sweep("AAAUSDT", 100.0, 0.0);
    d.filled.borrow_mut().push("spot:BBBUSDT".into());
    d.start();
    d.price(t(1), "BBBUSDT", Venue::SPOT, 10.5);
    d.spot_fill(t(1) + 500, "BBBUSDT", "BBB", true, 10.5, 2.0, 0.02, 12.0, 500.0 - 21.0 - 0.02);
    d.price(t(2), "BBBUSDT", Venue::SPOT, 11.0);
    d.price(t(2), "AAAUSDT", Venue::SPOT, 101.0);
    d.price(t(2), "AAAUSDT", Venue::USDM, 101.0);
    let f = d.figures(t(4));
    let bbb = 10.0 * (11.0 - 10.0) + 2.0 * (11.0 - 10.5) - 0.02;
    assert_relative_eq!(f.summary.trading, 1.0, epsilon = 1e-9);
    assert_relative_eq!(f.hedge.hedge_pnl.unwrap(), bbb, epsilon = 1e-9);
    assert_relative_eq!(f.row.pnl_day, 1.0 + bbb, epsilon = 1e-9);
    assert_relative_eq!(f.other(), 0.0, epsilon = 1e-9);
    let leg = &f.hedge.legs[0];
    assert_eq!((leg.symbol.as_str(), leg.venue, leg.fills), ("BBBUSDT", Venue::SPOT, 1));
    assert_relative_eq!(leg.fees, 0.02);
    assert_relative_eq!(leg.qty, 12.0, epsilon = 1e-12);
    // the spot hedge is out of the desk's fills, market making, volume and inventory
    assert_eq!((f.fills_day, f.volume_day), (0, 0.0));
    assert_relative_eq!(f.mm_total, 0.0);
    assert_relative_eq!(f.row.hedge_value, 12.0 * 11.0, epsilon = 1e-9);
    assert_relative_eq!(f.expo.spot_value, 101.0, epsilon = 1e-9);
    assert_relative_eq!(f.expo.hedge_notional, 132.0, epsilon = 1e-9);
    assert_relative_eq!(f.bv, 101.0, epsilon = 1e-9);
    // the inventory is what Trading PnL is of
    assert_eq!(f.assets, 1);
}
