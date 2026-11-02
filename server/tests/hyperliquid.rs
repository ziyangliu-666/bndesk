//! Hyperliquid against a stand-in built from its published API docs (market data was checked against the exchange; the
//! account reads here were not, and take no key): an account read from an address, what it sends, and what the desk makes
//! of a session on it, alone and beside Binance, with the parts adding up to Day PnL.
use std::cell::RefCell;
use std::collections::HashMap;
use std::rc::Rc;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use approx::assert_relative_eq;
use axum::Router;
use axum::extract::{Request, State};
use axum::response::{IntoResponse, Response};
use desk::accounts::{Account, AccountRef, Event, Transfers, TransfersRef};
use desk::app::pnl_book;
use desk::binance::events as bn;
use desk::clock::CLOCK;
use desk::config::{AccountCfg, Config, MarketCfg};
use desk::connector::{self, Connector};
use desk::fills::{FillBook, FillRec};
use desk::hyperliquid::Hyperliquid;
use desk::hyperliquid::events::{on_user_message, perp_state, spot_state, transfer_of};
use desk::hyperliquid::names::{Names, NamesRef};
use desk::hyperliquid::rest::READS;
use desk::market::{Book, Info, Mark, Market, SymbolInfo, Venue};
use desk::metrics as me;
use desk::pnl::PnlBook;
use desk::protocol::{InstRole, Role, Roles};
use futures_util::{SinkExt, StreamExt};
use serde_json::{Value, json};
use tokio_tungstenite::tungstenite::Message;

const ME: &str = "0x00000000000000000000000000000000000000aa";
const OTHER: &str = "0x00000000000000000000000000000000000000bb";
const D: i64 = 1_760_000_000_000 - 1_760_000_000_000 % 86_400_000;

fn t(min: i64) -> i64 {
    D + min * 60_000
}

fn meta() -> Value {
    json!([{"universe": [{"szDecimals": 5, "name": "BTC", "maxLeverage": 40}, {"szDecimals": 0, "name": "kPEPE", "maxLeverage": 10}], "collateralToken": 0},
           [{"funding": "0.0000125", "markPx": "101000.0", "prevDayPx": "100000.0", "dayNtlVlm": "5000.0", "dayBaseVlm": "0.05", "midPx": "101000.5"},
            {"funding": "0.0000125", "markPx": "0.004822", "prevDayPx": "0.004979", "dayNtlVlm": "1.0", "dayBaseVlm": "200.0", "midPx": null}]])
}

fn spot_meta() -> Value {
    json!([{"universe": [{"tokens": [150, 0], "name": "@107", "index": 107, "isCanonical": false}],
            "tokens": [{"name": "USDC", "index": 0, "szDecimals": 8}, {"name": "HYPE", "index": 150, "szDecimals": 2}]},
           [{"coin": "@107", "markPx": "20.0", "midPx": "20.0", "prevDayPx": "19.0", "dayNtlVlm": "100.0", "dayBaseVlm": "5.0"}]])
}

#[allow(clippy::too_many_arguments)]
fn fill(coin: &str, side: &str, px: &str, sz: &str, time: i64, tid: i64, fee: &str, token: &str, crossed: bool) -> Value {
    json!({"closedPnl": "0.0", "coin": coin, "crossed": crossed, "dir": "Open Long", "hash": "0xa166", "oid": 90542681, "px": px, "side": side,
           "startPosition": "0.0", "sz": sz, "time": time, "fee": fee, "feeToken": token, "tid": tid})
}

/// Answers `/info` as its docs say, and notes every request: method, path, type, and whether anything looked like a key.
#[derive(Default)]
struct Seen {
    reads: Vec<(String, String, String)>,
    headers: Vec<String>,
}

type SeenRef = Arc<Mutex<Seen>>;

async fn stand_in(State(seen): State<SeenRef>, req: Request) -> Response {
    let (method, path) = (req.method().to_string(), req.uri().path().to_string());
    let headers: Vec<String> = req.headers().keys().map(|k| k.to_string()).collect();
    let body = axum::body::to_bytes(req.into_body(), 1 << 20).await.unwrap();
    let q: Value = serde_json::from_slice(&body).unwrap();
    let ty = q["type"].as_str().unwrap_or("").to_string();
    {
        let mut s = seen.lock().unwrap();
        s.reads.push((method, path, ty.clone()));
        s.headers.extend(headers);
    }
    let v = match ty.as_str() {
        "exchangeStatus" => json!({"specialStatuses": null, "time": 1793599807038i64}),
        "metaAndAssetCtxs" => meta(),
        "spotMetaAndAssetCtxs" => spot_meta(),
        "l2Book" => json!({"coin": q["coin"], "time": 1, "levels": [[{"px": "100999.0", "sz": "1", "n": 1}], [{"px": "101001.0", "sz": "1", "n": 1}]]}),
        "candleSnapshot" => json!([{"t": q["req"]["startTime"], "T": 0, "s": q["req"]["coin"], "i": "1m", "o": "100000.0", "c": "100100.0", "h": "100200.0", "l": "99900.0", "v": "1.5", "n": 3}]),
        "clearinghouseState" => json!({"assetPositions": [{"type": "oneWay", "position": {"coin": "BTC", "cumFunding": {"allTime": "0", "sinceChange": "0", "sinceOpen": "0"},
            "entryPx": "100000.0", "leverage": {"rawUsd": "0", "type": "cross", "value": 20}, "liquidationPx": null, "marginUsed": "2500", "maxLeverage": 40,
            "positionValue": "50500.0", "returnOnEquity": "0", "szi": "0.5", "unrealizedPnl": "500.0"}}],
            "crossMaintenanceMarginUsed": "0.0", "crossMarginSummary": {"accountValue": "10500.0", "totalMarginUsed": "2500", "totalNtlPos": "50500", "totalRawUsd": "0"},
            "marginSummary": {"accountValue": "10500.0", "totalMarginUsed": "2500", "totalNtlPos": "50500", "totalRawUsd": "0"}, "time": t(1), "withdrawable": "8000.0"}),
        "spotClearinghouseState" => json!({"balances": [{"coin": "USDC", "token": 0, "hold": "100.0", "total": "1000.0", "entryNtl": "0.0"},
                                                        {"coin": "HYPE", "token": 150, "hold": "0.0", "total": "10.0", "entryNtl": "150.0"},
                                                        {"coin": "+1230", "hold": "0.0", "total": "25.0", "entryNtl": "12.5"}]}),
        "frontendOpenOrders" => json!([{"coin": "BTC", "isPositionTpsl": false, "isTrigger": false, "limitPx": "99000.0", "oid": 91490942, "orderType": "Limit", "origSz": "0.1", "reduceOnly": false, "side": "B", "sz": "0.1", "timestamp": t(0), "triggerCondition": "N/A", "triggerPx": "0.0"},
                                       {"coin": "@107", "isPositionTpsl": false, "isTrigger": false, "limitPx": "21.0", "oid": 91490943, "orderType": "Limit", "origSz": "1", "reduceOnly": false, "side": "A", "sz": "1", "timestamp": t(0), "triggerCondition": "N/A", "triggerPx": "0.0"},
                                       {"coin": "BTC", "isPositionTpsl": true, "isTrigger": true, "limitPx": "90000.0", "oid": 91490944, "orderType": "Stop Market", "origSz": "0.5", "reduceOnly": true, "side": "A", "sz": "0.5", "timestamp": t(0), "triggerCondition": "below", "triggerPx": "90000.0"}]),
        "userFees" => json!({"dailyUserVlm": [], "feeSchedule": {"cross": "0.00045", "add": "0.00015"}, "userCrossRate": "0.000315", "userAddRate": "-0.00001", "userSpotCrossRate": "0.00049", "userSpotAddRate": "0.00028"}),
        "userAbstraction" => json!("default"),
        "userFillsByTime" => json!([fill("BTC", "B", "100000.0", "0.5", t(1), 1001, "0.1", "USDC", true), fill("@107", "B", "20.0", "10", t(2), 1002, "0.01", "HYPE", false),
                                    fill("xyz:NVDA", "B", "145.0", "1", t(2), 1003, "0.01", "USDC", false), fill("BTC", "A", "90000.0", "1", D - 1000, 1000, "0.1", "USDC", true)]),
        "userFunding" => json!([{"delta": {"coin": "BTC", "fundingRate": "0.0000417", "szi": "0.5", "type": "funding", "usdc": "-3.5", "nSamples": null}, "hash": "0xa1", "time": t(0) + 1}]),
        "userNonFundingLedgerUpdates" => json!([{"time": t(0) + 5, "hash": "0xd1", "delta": {"type": "deposit", "usdc": "1000.0"}},
                                                {"time": t(0) + 6, "hash": "0xd2", "delta": {"type": "accountClassTransfer", "usdc": "100.0", "toPerp": true}},
                                                {"time": t(0) + 7, "hash": "0xd3", "delta": {"type": "rewardsClaim", "amount": "1.0"}}]),
        _ => return (axum::http::StatusCode::UNPROCESSABLE_ENTITY, "Failed to deserialize the JSON body into the target type").into_response(),
    };
    ([("content-type", "application/json")], v.to_string()).into_response()
}

/// A socket that notes all it is sent, and pushes what the test queues once the address has subscribed.
async fn ws_stand_in(listener: tokio::net::TcpListener, got: Arc<Mutex<Vec<Value>>>, push: Vec<Value>) {
    loop {
        let (s, _) = listener.accept().await.unwrap();
        let (got, push) = (got.clone(), push.clone());
        tokio::spawn(async move {
            let Ok(mut ws) = tokio_tungstenite::accept_async(s).await else { return };
            let mut pushed = false;
            while let Some(Ok(m)) = ws.next().await {
                let Message::Text(text) = m else { continue };
                let v: Value = serde_json::from_str(text.as_str()).unwrap();
                let user_sub = v["subscription"]["type"] == "spotState";
                got.lock().unwrap().push(v);
                if user_sub && !pushed {
                    pushed = true;
                    for p in &push {
                        ws.send(Message::text(p.to_string())).await.unwrap();
                    }
                }
            }
        });
    }
}

async fn wait_until(what: &str, mut f: impl FnMut() -> bool) {
    let t0 = std::time::Instant::now();
    while !f() {
        assert!(t0.elapsed() < Duration::from_secs(20), "never: {what}");
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
}

#[test]
fn an_account_is_read_from_an_address_and_only_read() {
    let rt = tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap();
    rt.block_on(tokio::task::LocalSet::new().run_until(async {
        let seen: SeenRef = Arc::default();
        let l = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base = format!("http://{}", l.local_addr().unwrap());
        let app = Router::new().fallback(stand_in).with_state(seen.clone());
        tokio::spawn(async move { axum::serve(l, app).await.unwrap() });
        let wl = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let ws_url = format!("ws://{}/ws", wl.local_addr().unwrap());
        let got: Arc<Mutex<Vec<Value>>> = Arc::default();
        let now = CLOCK.now();
        let ds = now - now.rem_euclid(86_400_000);
        let push = vec![
            json!({"channel": "subscriptionResponse", "data": {"method": "subscribe", "subscription": {"type": "userFills", "user": ME}}}),
            json!({"channel": "userFills", "data": {"isSnapshot": true, "user": ME, "fills": [fill("BTC", "B", "100000.0", "0.5", ds - 5, 7000, "0.1", "USDC", true)]}}),
            json!({"channel": "userFills", "data": {"user": ME, "fills": [fill("BTC", "B", "100500.0", "0.1", now - 10, 7001, "-0.001", "USDC", false)]}}),
            json!({"channel": "orderUpdates", "data": [{"order": {"coin": "kPEPE", "side": "A", "limitPx": "0.005", "sz": "100", "oid": 5, "timestamp": now - 20, "origSz": "100"}, "status": "open", "statusTimestamp": now - 20}]}),
            json!({"channel": "userFundings", "data": {"user": ME, "fundings": [{"time": now - 5, "coin": "BTC", "usdc": "-1.25", "szi": "0.5", "fundingRate": "0.00001"}]}}),
            json!({"channel": "userNonFundingLedgerUpdates", "data": {"isSnapshot": false, "user": ME, "nonFundingLedgerUpdates": [{"time": now - 4, "hash": "0xee", "delta": {"type": "internalTransfer", "usdc": "50.0", "user": ME, "destination": OTHER, "fee": "1.0"}}]}}),
        ];
        tokio::spawn(ws_stand_in(wl, got.clone(), push));

        let c: Rc<dyn Connector> = Rc::new(Hyperliquid::with_bases(connector::client(), None, &base, &ws_url));
        c.sync_clock().await.unwrap();
        let info = c.instruments().await.unwrap();
        let market = Rc::new(RefCell::new(Market::new(info, 120.0, 100.0)));
        assert_eq!(market.borrow().info[&Venue::HL]["KPEPE"], SymbolInfo::new("KPEPE", "USDC", 10.0));
        assert_eq!(c.book_tops(Venue::HL, &["BTC".to_string(), "NOPE".to_string()]).await.unwrap(), [("BTC".to_string(), 100999.0, 101001.0)]);
        let bars = c.bars("hl:BTC", "1m", 60_000, 60_000).await.unwrap();
        assert_eq!(bars, [(60_000, 100000.0, 100100.0)]);
        // what the desk reads as "none, for good"
        assert!(c.bars("hl:BTC", "1s", 0, 1).await.unwrap_err().downcast_ref::<connector::RestError>().is_some_and(|e| e.status == 400));
        assert_eq!(c.trade_at("hl:BTC", 0).await.unwrap(), None);
        assert_eq!(c.mark_bars("BTC", 60_000, 60_000).await.unwrap(), bars);
        let tk = c.kline_source().ticker("BTC", Venue::HL).await.ok().flatten().unwrap();
        assert_eq!((tk.last, tk.open, tk.volume, tk.quote_volume, tk.high, tk.low), (101000.0, 100000.0, 0.05, 5000.0, Some(101000.0), Some(99900.0)));
        assert_eq!(c.kline_source().ticker("HYPEUSDC", Venue::HL_SPOT).await.ok().flatten().unwrap().last, 20.0);

        // an address in the environment, as a key would be: never a key
        // SAFETY: no other test in this binary reads this variable.
        unsafe { std::env::set_var("DESK_HL_TEST_ADDRESS", ME) };
        let mut cfg = AccountCfg::new("h", "h", "", Role::Sub);
        (cfg.exchange, cfg.markets, cfg.address_env) = ("hyperliquid".into(), vec![Venue::HL, Venue::HL_SPOT], "DESK_HL_TEST_ADDRESS".into());
        assert!(matches!(c.credentials(&cfg), Ok(None)));
        let mut bad = cfg.clone();
        bad.address_env = "DESK_HL_UNSET".into();
        assert!(c.credentials(&bad).err().unwrap().contains("no address"));

        let fills: Rc<RefCell<Vec<FillRec>>> = Rc::default();
        let f2 = fills.clone();
        let mut acct = Account::new(cfg.clone(), None, "");
        acct.readable = true;
        acct.market = Some(market.clone());
        acct.day_start = ds;
        acct.on_fill = Rc::new(move |f| f2.borrow_mut().push(f));
        let a = acct.shared();
        let transfers: TransfersRef = Rc::new(RefCell::new(Transfers::new(None, vec![a.clone()])));
        assert!(transfers.borrow().ready());
        let tasks = c.start_accounts(std::slice::from_ref(&a), &transfers, Rc::new(std::cell::Cell::new(ds)));
        assert!(!transfers.borrow().ready(), "the day waits for the ledger");
        wait_until("the account read", || a.borrow().ready()).await;
        wait_until("the ledger read", || transfers.borrow().ready()).await;
        wait_until("the socket's messages", || a.borrow().traded.contains("hl:KPEPE") && transfers.borrow().records.len() >= 3).await;
        wait_until("the orders read", || a.borrow().open.len() >= 2).await;
        {
            let a = a.borrow();
            // the margin account: value less what is unrealized is the wallet; the balances are the spot side's
            assert_eq!((a.fut_wallet, a.fut_upnl_rest, a.fut_available), (10000.0, 500.0, 8000.0));
            assert_eq!(a.positions["BTC"], (0.5, 100000.0));
            assert_eq!((a.balances["USDC"], a.balances["HYPE"]), ((900.0, 100.0), (10.0, 0.0)));
            assert_eq!(a.perp, Venue::HL);
            // the stand-in's address names it in transfers, and one socket carries both markets
            assert_eq!((a.email.as_str(), a.feeds.len(), a.feeds[0].borrow().name.as_str()), (ME, 1, "h user"));
            assert!(a.feeds[0].borrow().up);
            // funding names its coin: no guessing from the one position held
            assert_eq!(a.funding_stream.len(), 1);
            assert_eq!((a.funding_stream[0].1.as_str(), a.funding_stream[0].2), ("BTC", -1.25));
        }
        {
            let rows = transfers.borrow();
            let kinds = |asset: &str, amount: f64, frm: &str, to: &str| rows.records.values().any(|r| r.asset == asset && r.amount == amount && r.frm == frm && r.to == to);
            assert!(kinds("USDC", 1000.0, "", ME), "a deposit");
            assert!(kinds("USDC", 100.0, ME, ME), "between its own two sides");
            assert!(kinds("USDC", 50.0, ME, OTHER), "to another address, from the socket");
            assert!(!rows.records.values().any(|r| r.amount == 1.0), "a reward is not money moved");
            // the socket's new fill, a rebate on it; the snapshot's fill from before the day is left out
            let f = fills.borrow();
            assert!(!f.iter().any(|f| f.ts < ds));
            let live = f.iter().find(|f| f.id.ends_with(":7001")).expect("the stream's fill");
            assert_eq!((live.venue, live.symbol.as_str(), live.price, live.qty, live.fee, live.fee_asset.as_str(), live.maker), (Venue::HL, "BTC", 100500.0, 0.1, -0.001, "USDC", true));
        }
        wait_until("the fees", || a.borrow().fee(Venue::HL, "*").is_some()).await;
        assert_eq!(a.borrow().fee(Venue::HL, "*"), Some((-0.00001, 0.000315)));
        assert_eq!(a.borrow().fee(Venue::HL_SPOT, "*"), Some((0.00028, 0.00049)));
        let r = c.reader(&cfg).unwrap();
        let b = r.balances().await.unwrap();
        assert!(b.rows.contains(&("HYPE".to_string(), 10.0)) && b.updated.is_none());
        assert_eq!(r.perp_positions().await.unwrap(), [("BTC".to_string(), 0.5)]);
        assert_eq!(r.perp_funding("BTC", t(0), t(1)).await.unwrap(), [(t(0) + 1, -3.5)]);
        assert_eq!(r.perp_trades("BTC", t(0)).await.unwrap().len(), 2);
        wait_until("the day's sweep", || a.borrow().fut_day.contains_key("BTC")).await;
        for t in &tasks {
            t.abort();
        }

        // all it sent: POST /info of a listed type, no key in any header
        let s = seen.lock().unwrap();
        for (method, path, ty) in &s.reads {
            assert_eq!((method.as_str(), path.as_str()), ("POST", "/info"));
            assert!(READS.iter().any(|r| r.0 == ty), "{ty}");
        }
        for ty in ["clearinghouseState", "spotClearinghouseState", "frontendOpenOrders", "userFees", "userAbstraction", "userFunding", "userFillsByTime", "userNonFundingLedgerUpdates", "candleSnapshot", "l2Book", "exchangeStatus", "metaAndAssetCtxs", "spotMetaAndAssetCtxs"] {
            assert!(s.reads.iter().any(|r| r.2 == ty), "{ty} was not exercised");
        }
        assert!(!s.headers.iter().any(|h| h.contains("key") || h.contains("auth") || h.contains("mbx")), "{:?}", s.headers);
        // and on the socket: subscriptions to the address's own feeds, nothing else
        let got = got.lock().unwrap();
        assert!(got.iter().all(|m| m["method"] == "subscribe" || m["method"] == "ping"), "{got:?}");
        assert_eq!(got.iter().filter(|m| m["subscription"]["user"] == ME).count(), 6);
    }));
}

// ---- what the desk makes of a session ----

fn names() -> NamesRef {
    let mut n = Names::default();
    n.read(&meta(), &spot_meta());
    Arc::new(std::sync::RwLock::new(n))
}

/// A perp account as the exchange counts it.
struct Exchange {
    wallet: f64,
    amt: f64,
    entry: f64,
    mark: f64,
    tid: i64,
}

impl Exchange {
    fn state(&self) -> Value {
        let upnl = (self.mark - self.entry) * self.amt;
        let positions = if self.amt == 0.0 { vec![] } else { vec![json!({"type": "oneWay", "position": {"coin": "BTC", "szi": self.amt.to_string(), "entryPx": self.entry.to_string(), "unrealizedPnl": upnl.to_string()}})] };
        json!({"assetPositions": positions, "marginSummary": {"accountValue": (self.wallet + upnl).to_string()}, "withdrawable": self.wallet.to_string()})
    }

    fn fill(&mut self, buy: bool, px: f64, qty: f64, fee: f64) {
        let s = if buy { 1.0 } else { -1.0 };
        let closed = if self.amt * s < 0.0 { self.amt.abs().min(qty) } else { 0.0 };
        self.wallet += closed * -s * (px - self.entry) - fee;
        let opened = qty - closed;
        let new = self.amt + s * qty;
        self.entry = if opened > 0.0 { (self.amt.abs() * self.entry * f64::from(u8::from(closed == 0.0)) + opened * px) / new.abs() } else { self.entry };
        self.amt = new;
    }
}

struct Desk {
    m: Rc<RefCell<Market>>,
    names: NamesRef,
    accounts: Vec<AccountRef>,
    transfers: TransfersRef,
    fills: Rc<RefCell<FillBook>>,
    pnl: Rc<RefCell<PnlBook>>,
    cfg: Config,
}

fn account(id: &str, exchange: &str, markets: Vec<Venue>, m: &Rc<RefCell<Market>>, roles: &Roles, email: &str) -> AccountRef {
    let mut c = AccountCfg::new(id, id, email, Role::Sub);
    (c.exchange, c.markets) = (exchange.into(), markets);
    let mut a = Account::new(c, None, "");
    a.market = Some(m.clone());
    a.day_start = D;
    a.roles = Rc::new(roles.clone());
    a.shared()
}

impl Desk {
    fn new(roles: Roles, beside_binance: bool) -> Desk {
        CLOCK.set_fixed(Some(t(0)));
        let mut i: Info = HashMap::new();
        i.insert(Venue::HL, HashMap::from([("BTC".to_string(), SymbolInfo::new("BTC", "USDC", 10.0))]));
        i.insert(Venue::HL_SPOT, HashMap::from([("HYPEUSDC".to_string(), SymbolInfo::new("HYPE", "USDC", 10.0))]));
        i.insert(Venue::USDM, HashMap::from([("HHHUSDT".to_string(), SymbolInfo::new("HHH", "USDT", 5.0))]));
        i.insert(Venue::SPOT, HashMap::new());
        let m = Rc::new(RefCell::new(Market::new(i, 120.0, 100.0)));
        let mut accounts = vec![account("h", "hyperliquid", vec![Venue::HL, Venue::HL_SPOT], &m, &roles, ME)];
        if beside_binance {
            accounts.push(account("b", "binance", vec![Venue::SPOT, Venue::USDM], &m, &roles, "b@x.io"));
        }
        let mut cfg = Config { roles, markets: vec![MarketCfg::new("HYPEUSDC", Venue::HL_SPOT)], ..Default::default() };
        cfg.exchanges = vec!["hyperliquid".into(), "binance".into()];
        let fills = Rc::new(RefCell::new(FillBook::new()));
        let filled: Rc<RefCell<Vec<String>>> = Rc::default();
        let pnl = Rc::new(RefCell::new(pnl_book(&cfg, &accounts, filled.clone(), D, Box::new(|_| 1.0))));
        for a in &accounts {
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
        let transfers = Rc::new(RefCell::new(Transfers::new(None, accounts.clone())));
        Desk { m, names: names(), accounts, transfers, fills, pnl, cfg }
    }

    fn price(&self, at: i64, sym: &str, venue: Venue, px: f64) {
        CLOCK.set_fixed(Some(at));
        let mut m = self.m.borrow_mut();
        m.ensure(sym, venue, None);
        m.on_book(venue, &Book::new(sym, px, px, Some(at)));
        if !venue.is_spot() {
            m.on_mark(venue, &Mark { symbol: sym, price: px, funding: None, next_funding: None });
        }
    }

    fn message(&self, m: Value, at: i64, unified: bool) {
        let names = self.names.read().unwrap();
        on_user_message(&mut self.accounts[0].borrow_mut(), &names, &m, at, unified).unwrap();
    }

    fn state(&self, x: &Exchange, at: i64) {
        self.message(json!({"channel": "clearinghouseState", "data": {"dex": "", "user": ME, "clearinghouseState": x.state()}}), at, false);
    }

    fn balances(&self, usdc: f64, hype: f64) {
        self.message(json!({"channel": "spotState", "data": {"user": ME, "spotState": {"balances": [
            {"coin": "USDC", "token": 0, "hold": "0", "total": usdc.to_string(), "entryNtl": "0"}, {"coin": "HYPE", "token": 150, "hold": "0", "total": hype.to_string(), "entryNtl": "0"}]}}}), t(0), false);
    }

    /// A fill on the account's socket, then the state the exchange pushes after it.
    fn trade(&self, x: &mut Exchange, at: i64, buy: bool, px: f64, qty: f64, fee: f64) {
        x.fill(buy, px, qty, fee);
        x.tid += 1;
        CLOCK.set_fixed(Some(at));
        self.message(json!({"channel": "userFills", "data": {"user": ME, "fills": [fill("BTC", if buy { "B" } else { "A" }, &px.to_string(), &qty.to_string(), at, x.tid, &fee.to_string(), "USDC", false)]}}), at, false);
        self.state(x, at + 1);
    }

    fn ledger(&self, row: Value) {
        let (id, rec) = transfer_of(&row, ME).unwrap().unwrap();
        self.transfers.borrow_mut().add(&id, rec);
    }

    fn start(&self) {
        let mut m = self.m.borrow_mut();
        for a in &self.accounts {
            let mut a = a.borrow_mut();
            a.spot_loaded = true;
            a.fut_loaded = true;
            a.take_opening(&mut m, true).expect("opening taken");
        }
        self.pnl.borrow_mut().begin(&mut m, CLOCK.now());
    }

    /// Day PnL, Trading PnL, Hedge, and what they leave.
    fn figures(&self, now: i64) -> (f64, f64, f64, f64) {
        CLOCK.set_fixed(Some(now));
        let mut m = self.m.borrow_mut();
        {
            let mut tr = self.transfers.borrow_mut();
            tr.value(&mut m, now);
            let mut pnl = self.pnl.borrow_mut();
            pnl.set_flows(&mut m, &tr.desk_flows(D), now);
            for a in &self.accounts {
                let td = tr.net_in_live(&a.borrow(), D);
                a.borrow_mut().transfers_day = td;
            }
        }
        let mut pnl = self.pnl.borrow_mut();
        pnl.step(&mut m, now);
        let mut fb = self.fills.borrow_mut();
        fb.mature(&m, now);
        let _ = fb.take_dirty();
        let summary = pnl.summary(&mut m);
        let legs = pnl.hedge_legs(&mut m, i64::MAX);
        let day: f64 = self.accounts.iter().map(|a| me::account_row(&mut m, &mut a.borrow_mut(), now).pnl_day).sum();
        let hedge = me::hedge_day(&self.cfg, &m, &self.accounts, summary.ref_hedge, summary.factor_hedge, legs).hedge_pnl.unwrap();
        (day, summary.trading, hedge, day - summary.trading - hedge)
    }
}

fn traded_perps() -> Roles {
    let mut r = Roles::default();
    r.set_market(Venue::HL, InstRole::Traded);
    r
}

/// Long 2 at 90 overnight, marked 100; sold through zero, bought back; funding; money in; a spot asset priced on its pair.
fn session(d: &Desk, x: &mut Exchange) -> (f64, f64, f64, f64) {
    d.price(t(0), "BTC", Venue::HL, 100.0);
    d.price(t(0), "HYPEUSDC", Venue::HL_SPOT, 20.0);
    d.balances(500.0, 10.0);
    d.state(x, t(0));
    let mut day = desk::accounts::FutDay::new(D);
    day.m0 = Some(100.0);
    d.accounts[0].borrow_mut().apply(Event::PerpDay { symbol: "BTC".into(), day: day.clone() });
    d.start();
    assert_relative_eq!(d.accounts[0].borrow().equity_open.unwrap(), 500.0 + 200.0 + 1000.0 + 20.0);

    d.price(t(1), "BTC", Venue::HL, 101.0);
    x.mark = 101.0;
    d.trade(x, t(1) + 500, false, 101.0, 3.0, 0.03);   // long 2 -> short 1
    d.figures(t(2));
    d.price(t(3), "BTC", Venue::HL, 100.0);
    x.mark = 100.0;
    d.trade(x, t(3) + 500, true, 100.0, 1.0, -0.01);   // flat, with a maker rebate
    d.trade(x, t(3) + 600, true, 100.5, 1.0, 0.01);    // long 1 at 100.5
    d.figures(t(4));
    // the hour's funding on the socket, naming its coin, and in the wallet
    x.wallet += 0.5;
    d.state(x, t(5));
    d.message(json!({"channel": "userFundings", "data": {"user": ME, "fundings": [{"time": t(5), "coin": "BTC", "usdc": "0.5", "szi": "1", "fundingRate": "0.0001"}]}}), t(5), false);
    // money in, as the wallet and the ledger both say
    x.wallet += 100.0;
    d.state(x, t(6));
    d.ledger(json!({"time": t(6), "hash": "0xd1", "delta": {"type": "deposit", "usdc": "100.0"}}));
    // between its own two sides: out of one, into the other
    x.wallet -= 50.0;
    d.state(x, t(7));
    d.balances(550.0, 10.0);
    d.ledger(json!({"time": t(7), "hash": "0xd2", "delta": {"type": "accountClassTransfer", "usdc": "50.0", "toPerp": false}}));
    d.price(t(8), "BTC", Venue::HL, 102.0);
    d.price(t(8), "HYPEUSDC", Venue::HL_SPOT, 21.0);
    x.mark = 102.0;
    d.state(x, t(8));
    d.figures(t(9))
}

#[test]
fn a_desk_on_hyperliquid_alone_adds_up() {
    let d = Desk::new(traded_perps(), false);
    let mut x = Exchange { wallet: 1000.0, amt: 2.0, entry: 90.0, mark: 100.0, tid: 100 };
    let (day, trading, hedge, other) = session(&d, &mut x);
    // by hand: the perp from 100: +2 to 101, then −1 × (100 − 101), 1 × (102 − 100.5), less net fees 0.03; funding 0.5;
    // HYPE, a configured spot market, 10 × 1, priced on its own pair
    let perp = 2.0 + 1.0 + 1.5 - 0.03 + 0.5;
    assert_relative_eq!(day, perp + 10.0, epsilon = 1e-9);
    assert_relative_eq!(trading, perp + 10.0, epsilon = 1e-9);
    assert_relative_eq!(hedge, 0.0, epsilon = 1e-9);
    assert_relative_eq!(other, 0.0, epsilon = 1e-9);
    assert_eq!(d.accounts[0].borrow().transfers_day, 100.0);
    assert_eq!(d.fills.borrow().fills.iter().filter(|f| f.venue == Venue::HL).count(), 3);
}

#[test]
fn a_desk_whose_perps_hedge_has_them_in_hedge() {
    let d = Desk::new(Roles::default(), false);
    let mut x = Exchange { wallet: 1000.0, amt: 2.0, entry: 90.0, mark: 100.0, tid: 100 };
    let (day, trading, hedge, other) = session(&d, &mut x);
    let perp = 2.0 + 1.0 + 1.5 - 0.03 + 0.5;
    assert_relative_eq!(day, perp + 10.0, epsilon = 1e-9);
    assert_relative_eq!(trading, 10.0, epsilon = 1e-9);
    assert_relative_eq!(hedge, perp, epsilon = 1e-9);
    assert_relative_eq!(other, 0.0, epsilon = 1e-9);
}

#[test]
fn a_desk_beside_binance_adds_both_up_with_a_position_each() {
    let mut roles = traded_perps();
    roles.set("HHHUSDT", Venue::USDM, InstRole::Hedge);
    let d = Desk::new(roles, true);
    // a Binance account shorting another instrument, through Binance's own events
    {
        let mut b = d.accounts[1].borrow_mut();
        d.price(t(0), "HHHUSDT", Venue::USDM, 200.0);
        bn::apply_fut_snapshot(&mut b, &json!({"assets": [{"asset": "USDT", "walletBalance": "1000", "updateTime": t(0)}], "totalWalletBalance": "1000", "totalUnrealizedProfit": "0", "availableBalance": "1000",
            "positions": [{"symbol": "HHHUSDT", "positionAmt": "-1", "notional": "-200", "unrealizedProfit": "0", "updateTime": t(0)}]}), t(0)).unwrap();
        bn::apply_spot_snapshot(&mut b, &json!({"updateTime": t(0), "balances": [{"asset": "USDT", "free": "300", "locked": "0"}]})).unwrap();
        let mut day = desk::accounts::FutDay::new(D);
        day.m0 = Some(200.0);
        b.apply(Event::PerpDay { symbol: "HHHUSDT".into(), day });
    }
    let mut x = Exchange { wallet: 1000.0, amt: 2.0, entry: 90.0, mark: 100.0, tid: 100 };
    let hh = |d: &Desk, at, px| d.price(at, "HHHUSDT", Venue::USDM, px);
    hh(&d, t(0), 200.0);
    let _ = session(&d, &mut x);
    hh(&d, t(9), 198.0);
    let (day, trading, hedge, other) = d.figures(t(10));
    let perp = 2.0 + 1.0 + 1.5 - 0.03 + 0.5;
    assert_relative_eq!(day, perp + 10.0 + 2.0, epsilon = 1e-9);
    assert_relative_eq!(trading, perp + 10.0, epsilon = 1e-9);
    assert_relative_eq!(hedge, 2.0, epsilon = 1e-9);
    assert_relative_eq!(other, 0.0, epsilon = 1e-9);
    // each account's positions on its own market
    let m = d.m.borrow();
    assert_eq!(d.accounts[0].borrow().live_positions(&m)[0].venue, Venue::HL);
    assert_eq!(d.accounts[1].borrow().live_positions(&m)[0].venue, Venue::USDM);
    CLOCK.set_fixed(None);
}

#[test]
fn a_unified_account_counts_its_balance_once() {
    let n = names();
    let names = n.read().unwrap();
    let st = json!({"assetPositions": [{"type": "oneWay", "position": {"coin": "BTC", "szi": "1", "entryPx": "100", "unrealizedPnl": "5"}}],
                    "marginSummary": {"accountValue": "505"}, "withdrawable": "400"});
    let Event::PerpSnapshot { wallet, upnl, .. } = perp_state(&names, &st, 1, false).unwrap() else { panic!() };
    assert_eq!((wallet, upnl), (500.0, 5.0));
    // "unified account or portfolio margin": the spot balances are the whole of it
    let Event::PerpSnapshot { wallet, upnl, positions, .. } = perp_state(&names, &st, 1, true).unwrap() else { panic!() };
    assert_eq!((wallet, upnl, positions.len()), (0.0, 5.0, 1));
    let Event::BalancesRead { rows } = spot_state(&json!({"balances": [{"coin": "USDC", "hold": "10", "total": "500", "entryNtl": "0"}]})).unwrap() else { panic!() };
    assert_eq!(rows, [("USDC".to_string(), 490.0, 10.0)]);
}

#[test]
fn every_ledger_kind_its_docs_list() {
    let row = |delta: Value| json!({"time": 5, "hash": "0xab", "delta": delta});
    let t = |delta: Value| transfer_of(&row(delta), ME).unwrap().map(|(_, r)| (r.frm, r.to, r.asset, r.amount));
    let me = ME.to_string();
    let usdc = "USDC".to_string();
    assert_eq!(t(json!({"type": "deposit", "usdc": 5.0})), Some((String::new(), me.clone(), usdc.clone(), 5.0)));
    assert_eq!(t(json!({"type": "withdraw", "usdc": "5.0", "nonce": 1, "fee": "1"})), Some((me.clone(), String::new(), usdc.clone(), 5.0)));
    assert_eq!(t(json!({"type": "internalTransfer", "usdc": "5", "user": OTHER, "destination": ME.to_uppercase().replace("0X", "0x"), "fee": "0"})), Some((OTHER.to_string(), me.clone(), usdc.clone(), 5.0)));
    assert_eq!(t(json!({"type": "subAccountTransfer", "usdc": "5", "user": ME, "destination": OTHER})), Some((me.clone(), OTHER.to_string(), usdc.clone(), 5.0)));
    assert_eq!(t(json!({"type": "spotTransfer", "token": "HYPE", "amount": "2", "usdcValue": "40", "user": ME, "destination": OTHER, "fee": "0"})), Some((me.clone(), OTHER.to_string(), "HYPE".to_string(), 2.0)));
    assert_eq!(t(json!({"type": "accountClassTransfer", "usdc": "5", "toPerp": true})), Some((me.clone(), me.clone(), usdc.clone(), 5.0)));
    assert_eq!(t(json!({"type": "vaultDeposit", "vault": OTHER, "usdc": "5"})), Some((me.clone(), OTHER.to_string(), usdc.clone(), 5.0)));
    assert_eq!(t(json!({"type": "vaultDistribution", "vault": OTHER, "usdc": "5"})), Some((OTHER.to_string(), me.clone(), usdc.clone(), 5.0)));
    assert_eq!(t(json!({"type": "vaultWithdraw", "vault": OTHER, "user": ME, "requestedUsd": "9", "commission": "1", "closingCost": "0", "basis": "0", "netWithdrawnUsd": "5"})), Some((OTHER.to_string(), me.clone(), usdc.clone(), 5.0)));
    // what is not money moved stays in P&L
    for k in ["liquidation", "vaultLeaderCommission", "spotGenesis", "rewardsClaim", "somethingNew"] {
        assert_eq!(t(json!({"type": k, "usdc": "5", "amount": "5", "token": "X"})), None, "{k}");
    }
}
