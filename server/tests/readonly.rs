//! The monitor is read-only: no order, cancel or transfer endpoint anywhere; the only non-GET REST
//! calls are USD-M listenKey creation and keepalive. The source scans read src/**/*.rs without their
//! unit-test modules.
use std::path::{Path, PathBuf};

use desk::binance::rest::{ALLOWED_WRITES, check_method};
use desk::binance::ws::WS_API_METHODS;
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
    for (path, text) in sources() {
        assert!(!write_call.is_match(&text), "{}", path.display());
        assert!(name(&path) == "rest.rs" || !request.is_match(&text), "{}", path.display());
        for line in text.lines() {
            if verb.is_match(line) {
                assert!(name(&path) == "rest.rs" || line.contains("listen_key("), "{}: {line}", path.display());
            }
        }
    }
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
