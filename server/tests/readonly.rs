//! The monitor is read-only: no order, cancel or transfer endpoint anywhere. On Binance the only non-GET REST calls are
//! USD-M listenKey creation and keepalive; on Hyperliquid a read is itself a POST, so there the guarantee is one path, a
//! list of types and no way to sign. The source scans read src/**/*.rs without their unit-test modules. A connector is a
//! read-only thing or it does not ship: what the desk can ask one is listed here method by method, only a connector's own
//! directory speaks to its exchange, and each connector's requests are watched on a stand-in server.
use std::path::{Path, PathBuf};
use std::rc::Rc;
use std::sync::{Arc, Mutex};

use axum::Router;
use axum::extract::{Request, State};
use axum::response::{IntoResponse, Response};
use desk::accounts::{Account, Transfers};
use desk::binance::Binance;
use desk::binance::account::{self as bn, Passes};
use desk::binance::rest::{ALLOWED_WRITES, Rest, check_method, governors};
use desk::binance::ws::WS_API_METHODS;
use desk::config::{AccountCfg, DEFAULT_EXCHANGE};
use desk::hyperliquid::public as hl_ws;
use desk::hyperliquid::rest::{self as hl, Reads};

use desk::connector::{self, Connector};
use desk::protocol::{MARKETS, Role, Venue};
use desk::sign::{Credentials, Signer};
use regex::Regex;

fn sources() -> Vec<(PathBuf, String)> {
    fn walk(d: &Path, out: &mut Vec<(PathBuf, String)>) {
        for e in std::fs::read_dir(d).unwrap() {
            let p = e.unwrap().path();
            if p.is_dir() {
                walk(&p, out);
            } else if p.extension().is_some_and(|x| x == "rs") {
                let text = std::fs::read_to_string(&p).unwrap();
                // unit tests (a trailing `#[cfg(test)]` module) may talk to the desk's own test server
                let text = text.split("#[cfg(test)]").next().unwrap().to_string();
                out.push((p, text));
            }
        }
    }
    let mut out = vec![];
    walk(&Path::new(env!("CARGO_MANIFEST_DIR")).join("src"), &mut out);
    out
}

fn name(p: &Path) -> &str {
    p.file_name().unwrap().to_str().unwrap()
}

#[test]
fn only_listen_key_writes() {
    assert_eq!(ALLOWED_WRITES, [("POST", "/fapi/v1/listenKey"), ("PUT", "/fapi/v1/listenKey")]);
    check_method("GET", "/api/v3/account").unwrap();
    check_method("POST", "/fapi/v1/listenKey").unwrap();
    for (method, path) in [
        ("POST", "/api/v3/order"), ("DELETE", "/api/v3/order"), ("DELETE", "/api/v3/openOrders"),
        ("POST", "/sapi/v1/sub-account/universalTransfer"), ("DELETE", "/fapi/v1/listenKey"),
        ("PUT", "/api/v3/order/cancelReplace"), ("POST", "/fapi/v1/order"),
    ] {
        assert!(check_method(method, path).is_err(), "{method} {path}");
    }
}

#[test]
fn ws_api_methods_are_user_data_only() {
    assert_eq!(WS_API_METHODS, ["session.logon", "userDataStream.subscribe", "userDataStream.subscribe.signature"]);
}

#[test]
fn no_write_calls_in_source() {
    // reqwest writes: Client::{post, put, delete, patch} or request(Method::..) (rings have `.put(` too)
    let write_call = Regex::new(r"\b(client|http|session)\s*\.(post|delete|put|patch)\(").unwrap();
    let request = Regex::new(r"\.request\(").unwrap();
    let verb = Regex::new(r#""(POST|DELETE|PUT|PATCH)"|Method::(POST|DELETE|PUT|PATCH)"#).unwrap();
    // what a connector's client is made of: each exchange's rest.rs, and nothing else
    let client = |p: &Path| name(p) == "rest.rs" && ["binance", "hyperliquid"].iter().any(|d| p.parent().unwrap().ends_with(d));
    for (path, text) in sources() {
        assert!(!write_call.is_match(&text), "{}", path.display());
        assert!(client(&path) || !request.is_match(&text), "{}", path.display());
        for line in text.lines() {
            if verb.is_match(line) {
                assert!(client(&path) || line.contains("listen_key("), "{}: {line}", path.display());
            }
        }
    }
}

/// Everything in Hyperliquid's directory: an address reads an account there, so nothing in it holds or uses a key, and
/// the path that trades is never named. The directory names a key only to refuse one.
fn hyperliquid_sources() -> Vec<(PathBuf, String)> {
    let dir = Path::new(env!("CARGO_MANIFEST_DIR")).join("src/hyperliquid");
    sources().into_iter().filter(|(p, _)| p.starts_with(&dir)).collect()
}

#[test]
fn hyperliquid_has_one_path_and_cannot_sign() {
    let src = hyperliquid_sources();
    assert!(src.len() >= 4);
    let signs = Regex::new(r"\bSigner\b|\.sign\(|ed25519|hmac|secp256k1|keccak|private_key|crate::sign::credentials").unwrap();
    let trades = Regex::new(r#""/exchange"|"post"|"action""#).unwrap();
    for (path, text) in &src {
        for line in text.lines().filter(|l| !l.trim_start().starts_with("//")) {
            assert!(!signs.is_match(line), "{}: {line}", path.display());
            // refused by name in the gate, sent by nothing
            assert!(name(path) == "rest.rs" && line.contains("[\"action\", \"signature\", \"nonce\"]") || !trades.is_match(line), "{}: {line}", path.display());
        }
    }
    // the path of `/info` is the only one in the source; a method other than POST is not there either
    let quoted = Regex::new(r#""(/[a-zA-Z]\w*)""#).unwrap();
    let paths: Vec<String> = src.iter().flat_map(|(_, t)| quoted.captures_iter(t).map(|c| c[1].to_string()).collect::<Vec<_>>()).collect();
    assert_eq!(paths, ["/info"]);
}

#[test]
fn hyperliquid_reads_are_a_list_with_no_trade_on_it() {
    let trades = Regex::new(r"(?i)order$|^order|cancel|modify|withdraw|transfer|leverage|approve|^update|schedule").unwrap();
    for (ty, weight) in hl::READS {
        assert!(!trades.is_match(ty) || ty == "frontendOpenOrders" || ty == "userNonFundingLedgerUpdates", "{ty}");
        assert!(weight > 0);
        hl::check_read(hl::PATH, &serde_json::json!({"type": ty})).unwrap();
    }
    for ty in ["order", "cancel", "batchModify", "withdraw3", "usdSend", "scheduleCancel", "updateLeverage", "approveAgent"] {
        assert!(hl::check_read(hl::PATH, &serde_json::json!({"type": ty})).is_err(), "{ty}");
    }
    assert!(hl::check_read("/exchange", &serde_json::json!({"type": "l2Book"})).is_err());
    assert_eq!(hl_ws::WS_METHODS, ["subscribe", "ping"]);
    assert!(hl_ws::subscribe("post", "coin", "BTC").is_err());
}

/// A read the gate refuses never leaves the process.
#[tokio::test(flavor = "current_thread")]
async fn the_gate_is_on_the_client_hyperliquid_holds() {
    let c = hl::Info::new(connector::client(), "http://127.0.0.1:9", None);
    for ty in ["order", "cancel"] {
        let e = c.read(serde_json::json!({"type": ty})).await.unwrap_err();
        assert!(e.to_string().contains("read-only monitor refuses"), "{e}");
    }
    let e = c.read(serde_json::json!({"type": "l2Book", "action": {}})).await.unwrap_err();
    assert!(e.to_string().contains("read-only monitor refuses"), "{e}");
}

#[test]
fn no_order_or_transfer_endpoints_requested() {
    let quoted = Regex::new(r#""(/(?:api|fapi|sapi)/[\w/.]+)""#).unwrap();
    let mut paths = std::collections::HashSet::new();
    for (_, text) in sources() {
        paths.extend(quoted.captures_iter(&text).map(|c| c[1].to_string()));
    }
    // /order (not /orders, not rateLimit/order), /batchOrders, /cancel, /allOpenOrders, /leverage, /marginType
    let order = Regex::new(r"/order($|[^s])").unwrap();
    let other = Regex::new(r"/batchOrders|/cancel|/allOpenOrders|/leverage|/marginType").unwrap();
    let bad: Vec<_> = paths
        .iter()
        .filter(|p| other.is_match(p) || order.find_iter(p).any(|m| !p[..m.start()].ends_with("rateLimit")))
        .collect();
    assert!(bad.is_empty(), "{bad:?}");
    let transfers: Vec<_> =
        paths.iter().filter(|p| p.contains("Transfer") && *p != "/sapi/v1/sub-account/universalTransfer").collect();
    assert!(transfers.is_empty(), "{transfers:?}");
    assert!(!paths.contains("/api/v3/order") && !paths.contains("/fapi/v1/order"));
}

/// Every method the desk can call on a connector. A new one is a new thing a connector does: it reads, or it does not
/// go on this list.
const READS: [(&str, &[&str]); 4] = [
    ("PublicFeed", &["watch", "feeds", "stop"]),
    ("KlineSource", &["id", "bars", "ticker"]),
    ("AccountReader", &["balances", "perp_positions", "perp_trades", "perp_funding"]),
    ("Connector", &["id", "markets", "allowed_writes", "clock", "sync_clock", "keep_clock", "instruments", "public_feed", "book_tops", "bars", "trade_at",
                    "mark_bars", "kline_source", "rest_bans", "credentials", "start_accounts", "reader", "is_rebate", "distributions"]),
];

fn connector_source() -> String {
    std::fs::read_to_string(Path::new(env!("CARGO_MANIFEST_DIR")).join("src/connector.rs")).unwrap()
}

#[test]
fn a_connector_can_only_be_asked_to_read() {
    let text = connector_source();
    let method = Regex::new(r"(?m)^\s*fn (\w+)").unwrap();
    let block = Regex::new(r"(?ms)^pub trait (\w+)[^{]*\{(.*?)^\}").unwrap();
    let got: Vec<(String, Vec<String>)> = block
        .captures_iter(&text)
        .map(|c| (c[1].to_string(), method.captures_iter(&c[2]).map(|m| m[1].to_string()).collect()))
        .collect();
    let want: Vec<(String, Vec<String>)> =
        READS.iter().map(|(t, ms)| (t.to_string(), ms.iter().map(|m| m.to_string()).collect())).collect();
    assert_eq!(got, want);
    let trades = Regex::new(r"(?i)order|cancel|place|amend|withdraw|borrow|repay|leverage|margin_type").unwrap();
    for (_, ms) in READS {
        for m in ms {
            assert!(!trades.is_match(m), "{m}");
        }
    }
}

#[test]
fn every_market_has_a_read_only_connector() {
    // every connector in the source is reachable from the markets, and says what it writes
    let impls = sources().iter().map(|(_, t)| t.matches("impl Connector for").count()).sum::<usize>();
    let mut ids: Vec<String> = MARKETS.iter().map(|m| m.exchange.to_lowercase()).collect();
    ids.sort();
    ids.dedup();
    assert_eq!(impls, ids.len());
    assert!(ids.contains(&DEFAULT_EXCHANGE.to_string()));
    let rt = tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap();
    rt.block_on(tokio::task::LocalSet::new().run_until(async {
        for id in &ids {
            let c = connector::open(id, connector::client(), None).unwrap();
            assert_eq!(c.id(), id);
            for v in c.markets() {
                assert_eq!(v.market().exchange.to_lowercase(), *id);
            }
            for (method, path) in c.allowed_writes() {
                assert!(["POST", "PUT"].contains(method) && path.to_lowercase().contains("listenkey"), "{method} {path}");
            }
            for ban in c.rest_bans() {
                assert!(!ban.banned, "{}", ban.name);
            }
        }
    }));
    assert!(connector::open("elsewhere", connector::client(), None).is_err());
}

#[test]
fn only_a_connector_speaks_to_its_exchange() {
    let url = Regex::new(r#""(?:wss?|https?)://([^/:"]+)"#).unwrap();
    let endpoint = Regex::new(r#""/(api/v3|fapi|sapi|info\b)"#).unwrap();
    let names = Regex::new(r"crate::(binance|hyperliquid)|\b(binance|hyperliquid)::").unwrap();
    let src = Path::new(env!("CARGO_MANIFEST_DIR")).join("src");
    for (path, text) in sources() {
        if path.starts_with(src.join("binance")) || path.starts_with(src.join("hyperliquid")) {
            continue;
        }
        for c in url.captures_iter(&text) {
            assert!(matches!(&c[1], "localhost" | "127.0.0.1"), "{}: {}", path.display(), &c[0]);
        }
        assert!(!endpoint.is_match(&text), "{}", path.display());
        // connector.rs is where connectors are named
        assert!(name(&path) == "connector.rs" || !names.is_match(&text), "{}", path.display());
    }
}

type Seen = Arc<Mutex<Vec<(String, String)>>>;

async fn stand_in(State(seen): State<Seen>, req: Request) -> Response {
    let path = req.uri().path().to_string();
    seen.lock().unwrap().push((req.method().to_string(), path.clone()));
    let body = match path.as_str() {
        "/api/v3/time" => r#"{"serverTime":1000}"#,
        "/api/v3/exchangeInfo" | "/fapi/v1/exchangeInfo" => r#"{"symbols":[]}"#,
        "/api/v3/account" => r#"{"updateTime":1,"balances":[]}"#,
        "/fapi/v3/account" => r#"{"totalWalletBalance":"0","totalUnrealizedProfit":"0","availableBalance":"0"}"#,
        "/fapi/v1/listenKey" => r#"{"listenKey":"k"}"#,
        "/sapi/v3/sub-account/assets" => r#"{"balances":[]}"#,
        "/sapi/v2/sub-account/futures/account" => r#"{"futureAccountResp":{"totalWalletBalance":"0","totalUnrealizedProfit":"0"}}"#,
        "/sapi/v2/sub-account/futures/positionRisk" | "/sapi/v1/sub-account/list" | "/sapi/v1/sub-account/universalTransfer"
        | "/sapi/v1/asset/assetDividend" => "{}",
        _ => "[]",
    };
    ([("content-type", "application/json")], body).into_response()
}

/// Every read a Binance account and the desk make, against a server that notes each request: nothing but GETs and the
/// listen key reach it. The key is made up, and only ever goes to this server.
#[tokio::test(flavor = "current_thread")]
async fn binance_sends_only_reads_to_the_exchange() {
    let seen: Seen = Arc::default();
    let app = Router::new().fallback(stand_in).with_state(seen.clone());
    let l = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let base = format!("http://{}", l.local_addr().unwrap());
    tokio::spawn(async move { axum::serve(l, app).await.unwrap() });

    let c: Rc<dyn Connector> = Rc::new(Binance::with_bases(connector::client(), None, &base, &base));
    c.sync_clock().await.unwrap();
    c.instruments().await.unwrap();
    for v in c.markets() {
        c.book_tops(v, &["XUSDT".to_string()]).await.unwrap();
        let key = format!("{v}:XUSDT");
        c.bars(&key, "1m", 0, 60_000).await.unwrap();
        c.trade_at(&key, 0).await.unwrap();
    }
    c.mark_bars("XUSDT", 0, 60_000).await.unwrap();
    let kl = c.kline_source();
    for v in c.markets() {
        let _ = kl.bars("XUSDT", v, "1m", 0, 60_000, 10).await;
    }

    let creds = Rc::new(Credentials { api_key: "made-up".into(), signer: Signer::hmac("made-up") });
    let rest = Rest::new(connector::client(), governors(), Some(creds.clone()), None).with_bases(&base, &base);
    let mut cfg = AccountCfg::new("a", "a", "a@x.io", Role::Sub);
    cfg.markets.push(Venue::USDM);
    let a = Account::new(cfg, Some(creds), "").shared();
    a.borrow_mut().day_start = 1_000;
    a.borrow_mut().spot_symbols = vec!["XUSDT".into()];
    a.borrow_mut().traded.extend(["spot:XUSDT".to_string(), "usdm:XUSDT".to_string()]);
    let p = Passes::new(a.clone());
    bn::spot_account(&a, &rest).await.unwrap();
    bn::fut_account(&a, &rest).await.unwrap();
    bn::rate_limits(&a, &rest).await.unwrap();
    bn::open_orders(&a, &rest).await.unwrap();
    let _ = bn::commissions(&p, &rest).await;
    bn::spot_trades(&p, &rest).await.unwrap();
    bn::dividends(&a, &rest).await.unwrap();
    bn::fut_today(&a, &rest).await.unwrap();
    bn::master_spot(&a, &rest).await.unwrap();
    bn::master_fut(&a, &rest).await.unwrap();
    bn::distributions(&rest, 0, 1).await.unwrap();
    let t = Rc::new(std::cell::RefCell::new(Transfers::new(Some(a.clone()), vec![a.clone()])));
    bn::transfers_poll(&t, &rest, 0, &|| 1_000).await.unwrap();
    let _: serde_json::Value = rest.listen_key("POST").await.unwrap();
    let _: serde_json::Value = rest.listen_key("PUT").await.unwrap();

    // the reader needs keys from the environment, as a real account's: made-up names only this test sets
    // SAFETY: no other test in this binary reads these.
    unsafe {
        std::env::set_var("DESK_READONLY_TEST_KEY", "made-up");
        std::env::set_var("DESK_READONLY_TEST_SECRET", "made-up");
    }
    let mut cfg = AccountCfg::new("r", "r", "", Role::Sub);
    (cfg.api_key_env, cfg.secret_env) = ("DESK_READONLY_TEST_KEY".into(), "DESK_READONLY_TEST_SECRET".into());
    let r = c.reader(&cfg).unwrap();
    r.balances().await.unwrap();
    r.perp_positions().await.unwrap();
    r.perp_trades("XUSDT", 0).await.unwrap();
    r.perp_funding("XUSDT", 0, 1).await.unwrap();

    let seen = seen.lock().unwrap();
    let writes: Vec<_> = seen.iter().filter(|(m, _)| m != "GET").cloned().collect();
    assert_eq!(writes, [("POST".to_string(), "/fapi/v1/listenKey".to_string()), ("PUT".to_string(), "/fapi/v1/listenKey".to_string())]);
    // and it did exercise them
    let paths: std::collections::HashSet<&str> = seen.iter().map(|x| x.1.as_str()).collect();
    assert!(paths.len() >= 20, "{paths:?}");
}

/// A write the gate refuses never leaves the process, from any path a connector could name.
#[tokio::test(flavor = "current_thread")]
async fn the_gate_is_on_the_client_a_connector_holds() {
    let rest = Rest::new(connector::client(), governors(), None, None).with_bases("http://127.0.0.1:9", "http://127.0.0.1:9");
    for m in ["DELETE", "PATCH"] {
        let e = rest.listen_key::<serde_json::Value>(m).await.unwrap_err();
        assert!(e.to_string().contains("read-only monitor refuses"), "{e}");
    }
}
