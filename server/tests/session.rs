//! A Binance session replayed through the desk: exchange info, books, every REST pass and user-stream event an
//! account takes, in order. What the desk makes of it (accounts, positions, fills, Π, the hedge legs, transfers,
//! exposure), every request it sent and every record it kept are compared with `data/binance_session.json`, written
//! once from the code before the connector split. `DESK_BLESS=1 cargo test --test session` rewrites it.
use std::cell::RefCell;
use std::collections::{BTreeMap, HashMap, VecDeque};
use std::rc::Rc;

use anyhow::Result;
use desk::accounts::{self as ac, Account, AccountRef, Dividend, Transfer, Transfers, TransfersRef};
use desk::binance::account::{self as bn, Passes, commissions, dividends, fut_account, fut_today, master_fut, master_spot, open_orders, rate_limits,
                             spot_account, spot_trades};
use desk::binance::events as ev;
use desk::binance::public::{on_book_raw, on_mark_raw, parse_exchange_info, parse_order_limits};
use desk::binance::rest::{RestError, RestGet};
use desk::clock::CLOCK;
use desk::config::{AccountCfg, Config, MarketCfg, Ref};
use desk::fills::{FillBook, FillRec};
use desk::market::{Info, Market, Venue};
use desk::metrics as me;
use desk::pnl::PnlBook;
use desk::protocol::{self as P, Role};
use serde::Serialize;
use serde_json::{Value, json};

// ---- how the session reaches the desk: all of Binance's JSON goes in through these ----

fn spot_event(a: &AccountRef, e: &Value) {
    ev::on_spot_event(&mut a.borrow_mut(), e).unwrap();
}

fn fut_event(a: &AccountRef, e: &Value) {
    ev::on_fut_event(&mut a.borrow_mut(), e).unwrap();
}

fn book(m: &Rc<RefCell<Market>>, venue: Venue, raw: &str) {
    on_book_raw(&mut m.borrow_mut(), venue, raw);
}

fn mark(m: &Rc<RefCell<Market>>, raw: &str) {
    on_mark_raw(&mut m.borrow_mut(), Venue::USDM, raw);
}

fn info(spot: &Value, usdm: &Value) -> Info {
    let mut i: Info = HashMap::new();
    i.insert(Venue::SPOT, parse_exchange_info(spot));
    i.insert(Venue::USDM, parse_exchange_info(usdm));
    i
}

fn limits(spot: &Value) -> Value {
    let (a, b) = parse_order_limits(spot);
    json!([a, b])
}

async fn rebates_between(a: &AccountRef, r: &Script, from: i64, to: i64) -> Result<f64> {
    Ok(ac::past_rebates(a, &bn::distributions(r, from, to).await?))
}

// ---- the script ----

/// Answers each path from a queue of canned replies, and logs every request as it was asked.
#[derive(Default)]
struct Script {
    replies: RefCell<HashMap<String, VecDeque<Reply>>>,
    log: RefCell<Vec<Value>>,
}

enum Reply {
    Ok(Value),
    Refuse(u16, &'static str),
}

impl Script {
    fn on(&self, path: &str, v: Value) {
        self.replies.borrow_mut().entry(path.into()).or_default().push_back(Reply::Ok(v));
    }

    fn refuse(&self, path: &str, status: u16, body: &'static str) {
        self.replies.borrow_mut().entry(path.into()).or_default().push_back(Reply::Refuse(status, body));
    }
}

impl RestGet for Script {
    async fn get_json(&self, path: &str, params: &[(String, String)], weight: i64, signed: bool) -> Result<Value> {
        self.log.borrow_mut().push(json!([path, params, weight, signed]));
        let reply = self.replies.borrow_mut().get_mut(path).and_then(VecDeque::pop_front);
        match reply {
            Some(Reply::Ok(v)) => Ok(v),
            Some(Reply::Refuse(status, body)) => Err(RestError { status, body: body.into() }.into()),
            None => panic!("no reply scripted for {path} {params:?}"),
        }
    }
}

const D: i64 = 1_760_000_000_000 - 1_760_000_000_000 % 86_400_000;

fn t(min: i64) -> i64 {
    D + min * 60_000
}

fn acct(id: &str, role: Role, futures: bool) -> Account {
    let mut c = AccountCfg::new(id, id, &format!("{id}@x.io"), role);
    if futures {
        c.markets.push(Venue::USDM);
    }
    Account::new(c, None, "")
}

#[allow(clippy::too_many_arguments)]
fn exec(tm: i64, sym: &str, side: &str, x: &str, status: &str, oid: i64, p: &str, q: &str, z: &str) -> Value {
    json!({"e": "executionReport", "E": tm, "s": sym, "S": side, "x": x, "X": status, "i": oid, "p": p, "q": q, "z": z, "O": tm - 5})
}

#[allow(clippy::too_many_arguments)]
fn trade(tm: i64, sym: &str, side: &str, status: &str, oid: i64, tid: i64, p: &str, q: &str, z: &str, l: &str, n: &str, asset: &str, maker: bool) -> Value {
    json!({"e": "executionReport", "E": tm + 1, "s": sym, "S": side, "x": "TRADE", "X": status, "i": oid, "p": p, "q": q, "z": z,
           "O": tm - 100, "t": tid, "T": tm, "L": p, "l": l, "n": n, "N": asset, "m": maker})
}

fn pos(u: i64, rows: &[(&str, &str, &str)]) -> Value {
    json!({"e": "outboundAccountPosition", "E": u + 1, "u": u,
           "B": rows.iter().map(|(a, f, l)| json!({"a": a, "f": f, "l": l})).collect::<Vec<_>>()})
}

fn sorted<V: Serialize>(m: impl IntoIterator<Item = (String, V)>) -> Value {
    serde_json::to_value(m.into_iter().collect::<BTreeMap<String, V>>()).unwrap()
}

struct Session {
    m: Rc<RefCell<Market>>,
    accounts: Vec<AccountRef>,
    transfers: TransfersRef,
    fills: Rc<RefCell<FillBook>>,
    pnl: Rc<RefCell<PnlBook>>,
    kept: Rc<RefCell<Vec<Value>>>,
    cfg: Config,
}

impl Session {
    /// All the desk's figures at `now`, as the snapshot would carry them.
    fn figures(&self, now: i64) -> Value {
        CLOCK.set_fixed(Some(now));
        let mut m = self.m.borrow_mut();
        self.transfers.borrow_mut().value(&mut m, now);
        let tr = self.transfers.borrow();
        let mut rows = vec![];
        let mut account_state = serde_json::Map::new();
        for a in &self.accounts {
            let mut a = a.borrow_mut();
            a.day_start = D;
            a.transfers_day = tr.net_in_live(&a, D);
            if a.equity_open.is_none() && a.valued(&mut m) {
                a.equity_open = Some(a.equity(&mut m) - a.transfers_day);
            }
            let mut r = me::account_row(&mut m, &mut a, now);
            r.updated = 0;
            rows.push(r);
            let parts = a.spot_parts(&mut m);
            let mut legs: Vec<String> = a.fut_day.keys().chain(a.positions.keys()).cloned().collect();
            legs.sort();
            legs.dedup();
            let mut balances: Vec<_> = a.balances.iter().map(|(k, v)| (k.clone(), *v)).collect();
            balances.sort_by(|x, y| x.0.cmp(&y.0));
            let mut open: Vec<_> = a
                .open
                .iter()
                .map(|(k, o)| json!([k, o.symbol, o.venue, o.side, o.price, o.left, a.open_since.get(k)]))
                .collect();
            open.sort_by_key(|x| x[0].as_str().unwrap_or("").to_string());
            let mut traded: Vec<_> = a.traded.iter().cloned().collect();
            traded.sort();
            account_state.insert(a.id.clone(), json!({
                "balances": balances,
                "spot_parts": [parts.0, parts.1, parts.2, parts.3],
                "ready": a.ready(),
                "fut": [a.fut_wallet, a.fut_upnl_rest, a.fut_available, a.fut_usdt, a.fut_usdt_u],
                "legs": legs.iter().map(|s| {
                    let l = a.fut_leg(&m, s);
                    json!([s, l.q0, l.q, l.m0, l.mark, l.fills, l.price, l.fees, l.funding])
                }).collect::<Vec<_>>(),
                "open": open,
                "traded": traded,
                "moves": a.moves.iter().map(|mv| json!([mv.t, mv.asset, mv.d, mv.px])).collect::<Vec<_>>(),
                "funding_stream": a.funding_stream,
                "no_order_counts": a.no_order_counts,
                "equity": a.equity(&mut m),
                "rebates": a.rebates(&mut m),
                "net_in": tr.net_in_live(&a, D),
            }));
        }
        let flows: Vec<Value> = tr.desk_flows(D).iter().map(|f| json!([f.key, f.ts, f.asset, f.qty, f.px])).collect();
        let records = sorted(tr.records.iter().map(|(k, r)| (k.clone(), json!([r.ts, r.frm, r.to, r.asset, r.amount, r.usd]))));
        let mut fb = self.fills.borrow_mut();
        fb.mature(&m, now);
        let _ = fb.take_dirty();
        let fills: Vec<P::Fill> = fb.fills.iter().map(FillRec::proto).collect();
        let mut pnl = self.pnl.borrow_mut();
        if pnl.started() {
            pnl.step(&mut m, now);
        } else {
            pnl.begin(&mut m, now);
        }
        let agg = me::aggregate(&fb.fills, now);
        let mm = me::mm_split(&mut m, &fb.fills, 60, now, |b| pnl.pos.contains_key(b));
        let by_base = pnl.by_base(&mut m);
        let symbols = me::symbol_rows(&mut m, &self.accounts, &by_base, &agg, &mm);
        let summary = pnl.summary(&mut m);
        let bv = me::beta_weighted_spot(&self.cfg, &mut m, &self.accounts, None);
        let expo = me::exposure(&self.cfg, &m, &rows, bv, false, now);
        let hedge = me::hedge_day(&self.cfg, &m, &self.accounts, summary.ref_hedge, summary.factor_hedge);
        let orders = me::open_orders(&m, &self.accounts);
        let mut orders = serde_json::to_value(&orders).unwrap();
        orders.as_array_mut().unwrap().sort_by_key(|x| x["id"].as_str().unwrap_or("").to_string());
        json!({
            "accounts": rows, "state": account_state, "flows": flows, "transfers": records, "fills": fills, "symbols": symbols,
            "pnl": summary, "mm": [mm.total, mm.spread, mm.unmarked, mm.unmarked_notional], "exposure": expo, "hedge_day": hedge,
            "orders": orders, "markouts": me::markout_stats(&agg), "assets": me::inventory_assets(&mut m, &self.accounts),
        })
    }
}

/// A form two runs agree on: accounts hold balances and positions in hash maps, so a list of positions comes in any
/// order and a sum over them can differ in its last bits. Fields added to the protocol since, which no figure depends
/// on, are left out.
fn canon(v: &mut Value) {
    match v {
        Value::Object(o) => {
            for k in ["positions", "legs"] {
                // their `venue` came after the file: what they say is checked by the session's symbols and marks
                if let Some(Value::Array(rows)) = o.get_mut(k) {
                    rows.iter_mut().filter_map(Value::as_object_mut).for_each(|r| {
                        r.remove("venue");
                    });
                }
            }
            o.values_mut().for_each(canon)
        }
        Value::Array(a) => {
            a.iter_mut().for_each(canon);
            if a.iter().all(|x| x.get("symbol").is_some()) {
                a.sort_by_key(|x| (x["symbol"].to_string(), x["venue"].to_string()));
            }
        }
        Value::Number(n) if n.is_f64() => {
            if let Some(x) = n.as_f64().and_then(|x| serde_json::Number::from_f64((x * 1e9).round() / 1e9)) {
                *n = x;
            }
        }
        _ => {}
    }
}

#[tokio::test(flavor = "current_thread")]
async fn a_binance_session_gives_the_figures_it_always_did() {
    CLOCK.set_fixed(Some(t(0)));
    let spot_info = json!({"rateLimits": [
            {"rateLimitType": "REQUEST_WEIGHT", "interval": "MINUTE", "intervalNum": 1, "limit": 6000},
            {"rateLimitType": "ORDERS", "interval": "SECOND", "intervalNum": 10, "limit": 90},
            {"rateLimitType": "ORDERS", "interval": "DAY", "intervalNum": 1, "limit": 150000}],
        "symbols": [
            {"symbol": "AAAUSDT", "status": "TRADING", "baseAsset": "AAA", "quoteAsset": "USDT", "filters": [{"filterType": "NOTIONAL", "minNotional": "5.00"}]},
            {"symbol": "BBBUSDT", "status": "TRADING", "baseAsset": "BBB", "quoteAsset": "USDT", "filters": [{"filterType": "NOTIONAL", "minNotional": "10"}]},
            {"symbol": "BNBUSDT", "status": "TRADING", "baseAsset": "BNB", "quoteAsset": "USDT", "filters": []},
            {"symbol": "USDCUSDT", "status": "TRADING", "baseAsset": "USDC", "quoteAsset": "USDT", "filters": []},
            {"symbol": "OLDUSDT", "status": "BREAK", "baseAsset": "OLD", "quoteAsset": "USDT", "filters": []}]});
    let usdm_info = json!({"symbols": [
        {"symbol": "AAAUSDT", "status": "TRADING", "contractStatus": "TRADING", "baseAsset": "AAA", "quoteAsset": "USDT",
         "filters": [{"filterType": "MIN_NOTIONAL", "notional": "100"}]},
        {"symbol": "HHHUSDT", "status": "TRADING", "baseAsset": "HHH", "quoteAsset": "USDT", "filters": []}]});
    let limits = limits(&spot_info);
    let m = Rc::new(RefCell::new(Market::new(info(&spot_info, &usdm_info), 120.0, 100.0)));
    let kept: Rc<RefCell<Vec<Value>>> = Rc::default();
    let fills = Rc::new(RefCell::new(FillBook::new()));
    let tracked = ["spot:AAAUSDT".to_string(), "spot:BBBUSDT".to_string()];
    let accounts: Vec<AccountRef> = vec![acct("mm", Role::Sub, true), acct("sub", Role::Sub, false), acct("via", Role::Sub, true)]
        .into_iter()
        .map(Account::shared)
        .collect();
    let by_id: HashMap<String, AccountRef> = accounts.iter().map(|a| (a.borrow().id.clone(), a.clone())).collect();
    let pnl = {
        let (ba, sc) = (accounts.clone(), tracked.to_vec());
        Rc::new(RefCell::new(PnlBook::new(
            D,
            Box::new(move |b: &str| ba.iter().map(|a| a.borrow().balances.get(b).map_or(0.0, |(f, l)| f + l)).sum()),
            Box::new(move || sc.clone()),
            Box::new(|_: &str| 1.0),
            Some("usdm:HHHUSDT".into()),
            None,
        )))
    };
    let on_fill: ac::OnFill = {
        let (fills, m, pnl, kept) = (fills.clone(), m.clone(), pnl.clone(), kept.clone());
        Rc::new(move |f: FillRec| {
            kept.borrow_mut().push(json!(["fill", f.id, f.ts, f.fee, f.fee_asset, f.maker]));
            let spot = (f.venue.is_spot() && !f.conversion()).then(|| f.clone());
            let mut mk = m.borrow_mut();
            if fills.borrow_mut().add(&mut mk, f, true)
                && let Some(f) = spot
            {
                pnl.borrow_mut().on_fill_at(&mut mk, &f, true);
            }
        })
    };
    for a in &accounts {
        let mut a = a.borrow_mut();
        a.market = Some(m.clone());
        a.on_fill = on_fill.clone();
        a.day_start = D;
        a.spot_symbols = vec!["AAAUSDT".into(), "BBBUSDT".into()];
        let k = kept.clone();
        a.on_fee = Rc::new(move |a: &Account, v: Venue, s: &str, x: (f64, f64)| k.borrow_mut().push(json!(["fee", a.id, v, s, x.0, x.1])));
        let k = kept.clone();
        a.on_fee_change = Rc::new(move |a: &Account, v: Venue, s: &str, x: Option<i64>| k.borrow_mut().push(json!(["feechg", a.id, v, s, x])));
        let k = kept.clone();
        a.on_dividend = Rc::new(move |a: &Account, id: &str, d: &Dividend| k.borrow_mut().push(json!(["dividend", a.id, id, d.ts, d.asset, d.amount, d.info])));
    }
    let (mm, sub, via) = (by_id["mm"].clone(), by_id["sub"].clone(), by_id["via"].clone());
    via.borrow_mut().use_master();
    let mm_passes = Passes::new(mm.clone());
    let master = Account::new(AccountCfg::new("master", "master", "master@x.io", Role::Master), None, "").shared();
    let transfers: TransfersRef = {
        let mut tr = Transfers::new(Some(master), accounts.clone());
        let k = kept.clone();
        tr.on_record = Rc::new(move |id: &str, r: &Transfer| k.borrow_mut().push(json!(["transfer", id, r.ts, r.frm, r.to, r.asset, r.amount, r.usd])));
        Rc::new(RefCell::new(tr))
    };
    let cfg = Config {
        target_ratio: Some(1.0),
        band_usd: Some(100.0),
        hedge_symbols: vec!["HHHUSDT".into()],
        markets: vec![MarketCfg { reference: Some(Ref { symbol: "AAAUSDT".into(), venue: Venue::USDM }), ..MarketCfg::new("AAAUSDT", Venue::SPOT) },
                      MarketCfg::new("BBBUSDT", Venue::SPOT)],
        ..Default::default()
    };
    {
        let mut mk = m.borrow_mut();
        for mc in &cfg.markets {
            let id = mk.ensure(&mc.symbol, mc.venue, mc.reference.as_ref().map(|r| (r.symbol.as_str(), r.venue)));
            mk.keep_fine(id);
        }
        mk.ensure("HHHUSDT", Venue::USDM, None);
        mk.asset_inst("USDC");
    }
    let s = Session { m: m.clone(), accounts: accounts.clone(), transfers: transfers.clone(), fills, pnl, kept: kept.clone(), cfg };
    let r = Script::default();
    let mut out: Vec<Value> = vec![json!({"limits": limits})];
    let mut errors: Vec<String> = vec![];
    let tick = |t: i64, b: f64, a: f64| {
        book(&m, Venue::SPOT, &format!(r#"{{"s":"AAAUSDT","b":"{b}","a":"{a}","E":{t}}}"#));
        book(&m, Venue::USDM, &format!(r#"{{"s":"AAAUSDT","b":"{}","a":"{}","E":{t}}}"#, b * 1.001, a * 1.001));
        book(&m, Venue::SPOT, &format!(r#"{{"s":"BBBUSDT","b":{},"a":{},"E":{t}}}"#, b / 10.0, a / 10.0));
        book(&m, Venue::SPOT, &format!(r#"{{"s":"BNBUSDT","b":"500","a":"500.2","E":{t}}}"#));
        book(&m, Venue::SPOT, &format!(r#"{{"s":"USDCUSDT","b":"1.0001","a":"1.0003","E":{t}}}"#));
        book(&m, Venue::USDM, &format!(r#"{{"s":"HHHUSDT","b":"{}","a":"{}","E":{t}}}"#, b * 2.0, a * 2.0));
        mark(&m, &format!(r#"{{"e":"markPriceUpdate","E":{t},"s":"HHHUSDT","p":"{}","r":"0.0001","T":{}}}"#, b * 2.0, t + 3_600_000));
        mark(&m, &format!(r#"{{"s":"AAAUSDT","p":"{b}","r":"","T":0}}"#));
    };
    tick(t(0), 100.0, 100.1);

    // the first REST passes
    r.on("/api/v3/account", json!({"updateTime": t(0), "commissionRates": {"maker": "0.0001", "taker": "0.0002"},
        "balances": [{"asset": "USDT", "free": "9000", "locked": "500"}, {"asset": "AAA", "free": "10", "locked": "2"},
                     {"asset": "BNB", "free": "1", "locked": "0"}, {"asset": "USDC", "free": "100", "locked": "0"}, {"asset": "ZERO", "free": "0", "locked": "0"}]}));
    spot_account(&mm, &r).await.unwrap();
    r.on("/api/v3/account", json!({"updateTime": t(0), "balances": [{"asset": "USDT", "free": "2000", "locked": "0"}, {"asset": "BBB", "free": "50", "locked": "0"}]}));
    spot_account(&sub, &r).await.unwrap();
    r.on("/fapi/v3/account", json!({"totalWalletBalance": "5010", "totalUnrealizedProfit": "12", "availableBalance": "4000",
        "assets": [{"asset": "USDT", "walletBalance": "5000", "updateTime": t(0)}, {"asset": "USDC", "walletBalance": "10", "updateTime": 1}],
        "positions": [{"symbol": "HHHUSDT", "positionAmt": "-4", "unrealizedProfit": "12", "notional": "-800", "updateTime": t(0)}]}));
    CLOCK.set_fixed(Some(t(0) + 5));
    fut_account(&mm, &r).await.unwrap();
    r.refuse("/api/v3/rateLimit/order", 401, r#"{"code":-2015,"msg":"Invalid API-key, IP, or permissions for action."}"#);
    rate_limits(&mm, &r).await.unwrap();
    r.on("/api/v3/rateLimit/order", json!([{"rateLimitType": "ORDERS", "interval": "SECOND", "intervalNum": 10, "limit": 90, "count": 3},
        {"rateLimitType": "ORDERS", "interval": "DAY", "intervalNum": 1, "limit": 150000, "count": 77},
        {"rateLimitType": "REQUEST_WEIGHT", "interval": "MINUTE", "limit": 6000}]));
    rate_limits(&sub, &r).await.unwrap();
    r.on("/api/v3/openOrders", json!([
        {"symbol": "AAAUSDT", "orderId": 1, "side": "BUY", "price": "99", "origQty": "5", "executedQty": "0", "status": "NEW", "time": t(0) - 9},
        {"symbol": "AAAUSDT", "orderId": 2, "side": "SELL", "price": "101", "origQty": "2", "executedQty": "0.5", "status": "PARTIALLY_FILLED", "time": t(0) - 8}]));
    open_orders(&mm, &r).await.unwrap();
    r.on("/sapi/v3/sub-account/assets", json!({"balances": [{"asset": "USDT", "free": "300", "locked": "0"}, {"asset": "BBB", "free": "5", "locked": "1"}, {"asset": "NIL", "free": "0", "locked": "0"}]}));
    master_spot(&via, &r).await.unwrap();
    r.on("/sapi/v2/sub-account/futures/account", json!({"futureAccountResp": {"totalWalletBalance": "700", "totalUnrealizedProfit": "-3", "maxWithdrawAmount": "650"}}));
    r.on("/sapi/v2/sub-account/futures/positionRisk", json!({"futurePositionRiskVOS": [{"symbol": "AAAUSDT", "positionAmount": "1.5", "entryPrice": "98"}, {"symbol": "HHHUSDT", "positionAmount": "0", "entryPrice": "0"}]}));
    master_fut(&via, &r).await.unwrap();
    out.push(s.figures(t(1)));

    // commissions: the account's default until a symbol is seen, one symbol per venue per hour, rotating
    r.on("/api/v3/account/commission", json!({"standardCommission": {"maker": "0.0001", "taker": "0.0002"}, "taxCommission": {"maker": "0.00001", "taker": "0"}, "specialCommission": {}}));
    r.on("/fapi/v1/commissionRate", json!({"makerCommissionRate": "0.0002", "takerCommissionRate": "0.0005"}));
    commissions(&mm_passes, &r).await.unwrap();
    commissions(&mm_passes, &r).await.unwrap();
    CLOCK.set_fixed(Some(t(1)));

    // the user streams
    tick(t(2), 100.2, 100.3);
    spot_event(&mm, &exec(t(2), "AAAUSDT", "BUY", "NEW", "NEW", 10, "100", "3", "0"));
    spot_event(&mm, &trade(t(2) + 50, "AAAUSDT", "BUY", "PARTIALLY_FILLED", 10, 500, "100", "3", "1", "1", "0.0001", "BNB", true));
    spot_event(&mm, &pos(t(2) + 50, &[("AAA", "11", "2"), ("USDT", "8900", "700")]));
    spot_event(&mm, &trade(t(2) + 90, "AAAUSDT", "BUY", "FILLED", 10, 501, "100", "3", "3", "2", "0.002", "AAA", false));
    spot_event(&mm, &pos(t(2) + 90, &[("AAA", "12.998", "2"), ("USDT", "8700", "700")]));
    spot_event(&sub, &exec(t(2) + 10, "BBBUSDT", "SELL", "NEW", "NEW", 20, "10.1", "4", "0"));
    spot_event(&sub, &trade(t(2) + 200, "BBBUSDT", "SELL", "FILLED", 20, 900, "10.1", "4", "4", "4", "0.01", "USDT", true));
    spot_event(&sub, &pos(t(2) + 200, &[("BBB", "46", "0"), ("USDT", "2040.39", "0")]));
    spot_event(&mm, &trade(t(2) + 300, "USDCUSDT", "SELL", "FILLED", 11, 502, "1.0002", "50", "50", "50", "0.005", "USDT", false));
    spot_event(&mm, &pos(t(2) + 300, &[("USDC", "50", "0"), ("USDT", "8750.005", "700")]));
    // a stream value older than the balance held is not applied
    spot_event(&mm, &pos(t(2) - 1000, &[("AAA", "999", "0")]));
    // a transfer seen on the stream, before the history shows it
    spot_event(&sub, &json!({"e": "balanceUpdate", "a": "USDT", "d": "-150", "T": t(3)}));
    spot_event(&mm, &json!({"e": "balanceUpdate", "a": "USDT", "d": "150", "T": t(3)}));
    spot_event(&sub, &pos(t(3), &[("USDT", "1890.39", "0")]));
    spot_event(&mm, &pos(t(3), &[("USDT", "8900.005", "700")]));
    spot_event(&mm, &json!({"e": "ignored"}));
    out.push(s.figures(t(4)));

    // USD-M: a fill and its position, a transfer, funding with one position held
    tick(t(5), 101.0, 101.1);
    fut_event(&mm, &json!({"e": "ORDER_TRADE_UPDATE", "E": t(5) + 1, "T": t(5), "o": {"s": "HHHUSDT", "S": "BUY", "i": 70, "p": "202", "q": "1", "z": "0", "X": "NEW", "x": "NEW"}}));
    fut_event(&mm, &json!({"e": "ORDER_TRADE_UPDATE", "E": t(5) + 21, "T": t(5) + 20, "o": {"s": "HHHUSDT", "S": "BUY", "i": 70, "p": "202", "q": "1", "z": "1",
        "X": "FILLED", "x": "TRADE", "t": 7001, "L": "202", "l": "1", "n": "0.04", "N": "USDT", "m": true, "T": t(5) + 20}}));
    fut_event(&mm, &json!({"e": "ORDER_TRADE_UPDATE", "E": t(5) + 41, "T": t(5) + 40, "o": {"s": "HHHUSDT", "S": "BUY", "i": 71, "p": "202", "q": "0.5", "z": "0.5",
        "X": "FILLED", "x": "TRADE", "t": 7002, "L": "202", "l": "0.5", "n": "0.00001", "N": "BNB", "m": false, "T": t(5) + 40}}));
    fut_event(&mm, &json!({"e": "ACCOUNT_UPDATE", "E": t(5) + 42, "T": t(5) + 41, "a": {"m": "ORDER",
        "B": [{"a": "USDT", "wb": "4999.96", "cw": "4999.96", "bc": "0"}],
        "P": [{"s": "HHHUSDT", "pa": "-2.5", "ep": "199", "ps": "BOTH"}, {"s": "XXXUSDT", "pa": "1", "ep": "1", "ps": "HEDGE"}]}}));
    fut_event(&mm, &json!({"e": "ACCOUNT_UPDATE", "E": t(6) + 1, "T": t(6), "a": {"m": "DEPOSIT",
        "B": [{"a": "USDT", "wb": "5099.96", "cw": "5099.96", "bc": "100"}]}}));
    fut_event(&mm, &json!({"e": "ACCOUNT_UPDATE", "E": t(7) + 1, "T": t(7), "a": {"m": "FUNDING_FEE",
        "B": [{"a": "USDT", "wb": "5100.46", "cw": "5100.46", "bc": "0.5"}, {"a": "BNB", "wb": "0", "cw": "0", "bc": "0.1"}]}}));
    // a position held on another symbol: the next funding cannot be told apart, REST books it
    fut_event(&mm, &json!({"e": "ACCOUNT_UPDATE", "E": t(7) + 2, "T": t(7) + 1, "a": {"m": "ORDER", "B": [],
        "P": [{"s": "AAAUSDT", "pa": "2", "ep": "101", "ps": "BOTH"}]}}));
    fut_event(&mm, &json!({"e": "ACCOUNT_UPDATE", "E": t(8), "T": t(8), "a": {"m": "FUNDING_FEE",
        "B": [{"a": "USDT", "wb": "5101", "cw": "5101", "bc": "0.54"}]}}));
    out.push(s.figures(t(9)));

    // a snapshot read before a fill and applied after it does not undo the fill
    r.on("/api/v3/account", json!({"updateTime": t(2), "balances": [{"asset": "USDT", "free": "1", "locked": "0"}, {"asset": "AAA", "free": "1", "locked": "0"}]}));
    spot_account(&mm, &r).await.unwrap();
    // the same for USD-M: a position and wallet newer than the snapshot stand
    r.on("/fapi/v3/account", json!({"totalWalletBalance": "5000", "totalUnrealizedProfit": "0", "availableBalance": "3500",
        "assets": [{"asset": "USDT", "walletBalance": "4990", "updateTime": t(1)}],
        "positions": [{"symbol": "HHHUSDT", "positionAmt": "-4", "unRealizedProfit": "0", "notional": "-800", "updateTime": t(1)}]}));
    CLOCK.set_fixed(Some(t(9)));
    fut_account(&mm, &r).await.unwrap();
    out.push(s.figures(t(10)));

    // the transfer history confirms the moves; a failed row is skipped
    let rows = json!({"result": [
        {"tranId": 1, "createTimeStamp": t(3) + 2, "fromEmail": "sub@x.io", "toEmail": "mm@x.io", "asset": "USDT", "amount": "150", "status": "SUCCESS"},
        {"tranId": 2, "createTimeStamp": t(6), "toEmail": "mm@x.io", "asset": "USDT", "amount": "100"},
        {"tranId": 3, "createTimeStamp": t(6), "fromEmail": "mm@x.io", "asset": "BBB", "amount": "1", "status": "PROCESS"}]});
    r.on("/sapi/v1/sub-account/list", json!({"subAccounts": [{"email": "a", "isFreeze": false}, {"email": "b", "isFreeze": true}]}));
    for _ in 0..4 {
        r.on("/sapi/v1/sub-account/universalTransfer", rows.clone());
    }
    bn::transfers_poll(&transfers, &r, 0, &|| D).await.unwrap();
    let feed = transfers.borrow().feed.clone();
    let feed = (feed.borrow().up, feed.borrow().detail.clone(), feed.borrow().msgs);
    out.push(json!({"transfers_feed": feed, "sub_info": transfers.borrow().sub_info, "loaded": transfers.borrow().loaded}));
    out.push(s.figures(t(11)));

    // today's sweeps: spot fills the stream did not give, one symbol refused; distributions; the USD-M day
    r.on("/api/v3/myTrades", json!([
        {"id": 500, "time": t(2) + 50, "isBuyer": true, "price": "100", "qty": "1", "commission": "0.0001", "commissionAsset": "BNB", "isMaker": true},
        {"id": 503, "time": t(1), "isBuyer": false, "price": "100.5", "qty": "0.5", "commission": "0.05", "commissionAsset": "USDT", "isMaker": false},
        {"id": 400, "time": D - 10, "isBuyer": false, "price": "1", "qty": "1", "commission": "0", "commissionAsset": "USDT", "isMaker": false}]));
    r.refuse("/api/v3/myTrades", 400, r#"{"code":-1121,"msg":"Invalid symbol."}"#);
    r.on("/api/v3/myTrades", json!([]));
    errors.push(format!("{:#}", spot_trades(&mm_passes, &r).await.unwrap_err()));
    r.on("/sapi/v1/asset/assetDividend", json!({"rows": [
        {"id": 31, "divTime": t(4), "asset": "USDT", "amount": "0.25", "enInfo": "Spot MM Rebate-Spot 26-10-15 07:00"},
        {"id": 32, "divTime": t(5), "asset": "BNB", "amount": "0.001", "enInfo": "Spot MM Rebate-Spot 26-10-15 08:00"},
        {"id": 33, "divTime": t(6), "asset": "AAA", "amount": "2", "enInfo": "Launchpool distribution"},
        {"id": 34, "divTime": t(6), "asset": "AAA", "amount": "2"}], "total": 4}));
    dividends(&mm, &r).await.unwrap();
    r.on("/fapi/v1/income", json!([{"symbol": "HHHUSDT", "income": "-1.5", "time": t(1)}, {"symbol": "AAAUSDT", "income": "0.25", "time": t(2)}, {"symbol": "HHHUSDT", "income": "0.75", "time": t(3)}]));
    // AAAUSDT: no trades, its opening mark from the mark klines; HHHUSDT: REST's fills, one the stream already gave
    r.on("/fapi/v1/userTrades", json!([]));
    r.on("/fapi/v1/markPriceKlines", json!([[D, "99.5", "100", "99", "99.8", "0"]]));
    r.on("/fapi/v1/userTrades", json!([
        {"id": 7001, "time": t(5) + 20, "side": "BUY", "qty": "1", "price": "202", "commission": "0.04", "commissionAsset": "USDT", "maker": true},
        {"id": 7000, "time": t(4), "side": "SELL", "qty": "2", "price": "198", "commission": "0.0001", "commissionAsset": "BNB", "maker": false}]));
    r.on("/fapi/v1/markPriceKlines", json!([[D, "197", "198", "196", "197.5", "0"]]));
    fut_today(&mm, &r).await.unwrap();
    out.push(s.figures(t(12)));

    // a day's rebates asked for later: every row kept, the rebates summed at the price now
    r.on("/sapi/v1/asset/assetDividend", json!({"rows": [
        {"id": 41, "divTime": D - 3_600_000, "asset": "USDT", "amount": "1.5", "enInfo": "Spot MM Rebate-Spot 26-10-14 07:00"},
        {"id": 42, "divTime": D - 3_500_000, "asset": "BNB", "amount": "0.002", "enInfo": "Spot MM Rebate-Spot 26-10-14 08:00"},
        {"id": 43, "divTime": D - 3_400_000, "asset": "AAA", "amount": "9", "enInfo": "Airdrop"}]}));
    let past = rebates_between(&mm, &r, D - 86_400_000, D).await.unwrap();
    out.push(json!({"past_rebates": past}));

    // fee changes held across the session
    tick(t(13), 102.0, 102.2);
    CLOCK.set_fixed(Some(t(70)));
    mm_passes.commissions_due();
    r.on("/api/v3/account/commission", json!({"standardCommission": {"maker": "0.0003", "taker": "0.0004"}}));
    r.on("/fapi/v1/commissionRate", json!({"makerCommissionRate": "0.0001", "takerCommissionRate": "0.0005"}));
    commissions(&mm_passes, &r).await.unwrap();
    out.push(s.figures(t(71)));
    tick(t(72), 103.0, 103.1);
    out.push(s.figures(t(80)));
    CLOCK.set_fixed(None);

    let mut got = json!({"checkpoints": out, "errors": errors, "kept": *s.kept.borrow(), "requests": *r.log.borrow()});
    canon(&mut got);
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/data/binance_session.json");
    let got = serde_json::to_string_pretty(&got).unwrap() + "\n";
    if std::env::var_os("DESK_BLESS").is_some() {
        std::fs::write(&path, &got).unwrap();
    }
    let want = std::fs::read_to_string(&path).unwrap();
    if got != want {
        let dir = std::env::temp_dir().join("desk-session-got.json");
        std::fs::write(&dir, &got).unwrap();
        panic!("the session's figures changed: compare {} with {}", dir.display(), path.display());
    }
}
