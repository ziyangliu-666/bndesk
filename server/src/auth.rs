//! One shared password, long sessions.
//!
//! The password is stored only as a scrypt hash (env DESK_PASSWORD_HASH). A correct login gets a
//! random session token in an HttpOnly, Secure, SameSite=Strict cookie, valid for a year and renewed
//! while in use. Sessions live in SQLite, so restarts keep everyone logged in; changing the password
//! ends every session. Logins are slowed per IP (5 misses lock it, the lock doubles each time) and
//! globally (one attempt per second), on top of scrypt's own cost.
//!
//! axum needs `Send` state, so the shared state sits behind a `std::sync::Mutex` (never held
//! across an `.await`) instead of `Rc<RefCell<..>>`.
use std::collections::HashMap;
use std::net::SocketAddr;
use std::ops::Deref;
use std::path::Path;
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use axum::body::Body;
use axum::extract::{ConnectInfo, Request, State};
use axum::http::{HeaderMap, HeaderValue, Method, StatusCode, header};
use axum::middleware::Next;
use axum::response::{IntoResponse, Response};
use base64::Engine;
use base64::engine::general_purpose::{STANDARD as B64, URL_SAFE_NO_PAD};
use rand::{Rng, RngCore};
use rusqlite::{Connection, params};
use sha2::{Digest, Sha256};
use subtle::ConstantTimeEq;

pub const COOKIE: &str = "bndesk_session";
pub const SESSION_S: i64 = 365 * 86400;
pub const TOUCH_S: i64 = 3600; // write last_seen at most hourly
pub const PER_IP_TRIES: u32 = 5;
pub const LOCK_S: i64 = 15 * 60;
pub const N: u64 = 1 << 15; // scrypt cost: ~50-100 ms, 32 MiB
pub const R: u32 = 8;
pub const PAR: u32 = 1;
pub const PUBLIC: [&str; 2] = ["/login", "/healthz"];
const MAXMEM: u64 = 64 << 20;
const MAX_BODY: usize = 1 << 20; // aiohttp's client_max_size

fn now() -> f64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs_f64())
        .unwrap_or(0.0)
}

fn scrypt_raw(password: &[u8], salt: &[u8], n: u64, r: u32, p: u32) -> Option<[u8; 32]> {
    // hashlib.scrypt (OpenSSL): n a power of two > 1, memory 128*r*(n+p+2) within maxmem
    if n < 2 || !n.is_power_of_two() || r == 0 || p == 0 {
        return None;
    }
    if 128u128 * r as u128 * (n as u128 + p as u128 + 2) > MAXMEM as u128 {
        return None;
    }
    let params = scrypt::Params::new(n.trailing_zeros() as u8, r, p, 32).ok()?;
    let mut out = [0u8; 32];
    scrypt::scrypt(password, salt, &params, &mut out).ok()?;
    Some(out)
}

pub fn hash_password(password: &str) -> String {
    let mut salt = [0u8; 16];
    rand::rng().fill_bytes(&mut salt);
    let h = scrypt_raw(password.as_bytes(), &salt, N, R, PAR).expect("scrypt params");
    format!(
        "scrypt${N}${R}${PAR}${}${}",
        B64.encode(salt),
        B64.encode(h)
    )
}

pub fn verify_password(password: &str, stored: &str) -> bool {
    let parts: Vec<&str> = stored.split('$').collect();
    let [_, n, r, p, salt, h] = parts[..] else {
        return false;
    };
    let (Ok(n), Ok(r), Ok(p)) = (n.parse::<u64>(), r.parse::<u32>(), p.parse::<u32>()) else {
        return false;
    };
    let (Ok(salt), Ok(h)) = (B64.decode(salt), B64.decode(h)) else {
        return false;
    };
    match scrypt_raw(password.as_bytes(), &salt, n, r, p) {
        Some(got) => bool::from(got[..].ct_eq(&h[..])),
        None => false,
    }
}

pub fn new_password() -> String {
    const ALPHABET: &[u8] = b"abcdefghijkmnopqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789";
    let mut rng = rand::rng();
    (0..4)
        .map(|_| {
            (0..6)
                .map(|_| ALPHABET[rng.random_range(0..ALPHABET.len())] as char)
                .collect::<String>()
        })
        .collect::<Vec<_>>()
        .join("-") // ~140 bits
}

fn sha256_hex(s: &str) -> String {
    hex::encode(Sha256::digest(s.as_bytes()))
}

pub struct Db {
    pub conn: Connection,
    pub sessions: HashMap<String, f64>, // token_hash -> last_seen
}

pub struct AuthInner {
    pub stored: String,
    pub fp: String, // password fingerprint
    pub db: Mutex<Db>,
    pub fails: Mutex<HashMap<String, (u32, u32, f64)>>, // ip -> (misses, locks, locked until)
    pub gate: tokio::sync::Mutex<()>,
    pub behind_fly: bool,
}

#[derive(Clone)]
pub struct Auth(Arc<AuthInner>);

impl Deref for Auth {
    type Target = AuthInner;
    fn deref(&self) -> &AuthInner {
        &self.0
    }
}

impl Auth {
    pub fn new(stored_hash: &str, db: &Path) -> rusqlite::Result<Auth> {
        let fp = sha256_hex(stored_hash)[..16].to_string();
        let conn = Connection::open(db)?;
        conn.pragma_update(None, "journal_mode", "WAL")?;
        conn.execute(
            "CREATE TABLE IF NOT EXISTS sessions (token_hash TEXT PRIMARY KEY, created INTEGER, \
             last_seen INTEGER, ip TEXT, ua TEXT, pw_fp TEXT)",
            [],
        )?;
        conn.execute(
            "DELETE FROM sessions WHERE pw_fp != ? OR last_seen < ?",
            params![fp, now() - SESSION_S as f64],
        )?;
        let sessions = {
            let mut st = conn.prepare("SELECT token_hash, last_seen FROM sessions")?;
            st.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, f64>(1)?)))?
                .collect::<rusqlite::Result<HashMap<_, _>>>()?
        };
        Ok(Auth(Arc::new(AuthInner {
            stored: stored_hash.to_string(),
            fp,
            db: Mutex::new(Db { conn, sessions }),
            fails: Mutex::new(HashMap::new()),
            gate: tokio::sync::Mutex::new(()),
            behind_fly: std::env::var("FLY_APP_NAME").is_ok_and(|v| !v.is_empty()),
        })))
    }

    // sessions

    fn h(token: &str) -> String {
        sha256_hex(token)
    }

    pub fn valid(&self, token: Option<&str>) -> bool {
        let Some(token) = token.filter(|t| !t.is_empty()) else {
            return false;
        };
        let k = Self::h(token);
        let mut db = self.db.lock().unwrap();
        let Some(&seen) = db.sessions.get(&k) else {
            return false;
        };
        let now = now();
        if now - seen > SESSION_S as f64 {
            return false;
        }
        if now - seen > TOUCH_S as f64 {
            db.sessions.insert(k.clone(), now);
            let _ = db.conn.execute(
                "UPDATE sessions SET last_seen = ? WHERE token_hash = ?",
                params![now as i64, k],
            );
        }
        true
    }

    fn open(&self, ip: &str, ua: &str) -> String {
        let mut raw = [0u8; 32];
        rand::rng().fill_bytes(&mut raw);
        let token = URL_SAFE_NO_PAD.encode(raw);
        let now = now() as i64;
        let k = Self::h(&token);
        let ua: String = ua.chars().take(200).collect();
        let mut db = self.db.lock().unwrap();
        let _ = db.conn.execute(
            "INSERT INTO sessions VALUES (?,?,?,?,?,?)",
            params![k, now, now, ip, ua, self.fp],
        );
        db.sessions.insert(k, now as f64);
        token
    }

    fn close(&self, token: Option<&str>) {
        let Some(token) = token.filter(|t| !t.is_empty()) else {
            return;
        };
        let k = Self::h(token);
        let mut db = self.db.lock().unwrap();
        if db.sessions.remove(&k).is_some() {
            let _ = db
                .conn
                .execute("DELETE FROM sessions WHERE token_hash = ?", params![k]);
        }
    }

    // requests

    pub fn ip(&self, req: &Request) -> String {
        if self.behind_fly
            && let Some(ip) = req
                .headers()
                .get("Fly-Client-IP")
                .and_then(|v| v.to_str().ok())
                .filter(|s| !s.is_empty())
        {
            return ip.to_string();
        }
        req.extensions()
            .get::<ConnectInfo<SocketAddr>>()
            .map(|c| c.0.ip().to_string())
            .unwrap_or_else(|| "?".to_string())
    }

    fn cookie(&self, resp: &mut Response, secure: bool, token: &str) {
        let mut c =
            format!("{COOKIE}={token}; HttpOnly; Max-Age={SESSION_S}; Path=/; SameSite=Strict");
        if secure {
            c.push_str("; Secure");
        }
        resp.headers_mut()
            .append(header::SET_COOKIE, HeaderValue::from_str(&c).unwrap());
    }
}

pub fn secure(req: &Request) -> bool {
    req.uri().scheme_str() == Some("https")
        || req
            .headers()
            .get("X-Forwarded-Proto")
            .is_some_and(|v| v == "https")
}

/// The value of one cookie from the Cookie header(s); the last one wins, quotes stripped.
pub fn get_cookie<'a>(headers: &'a HeaderMap, name: &str) -> Option<&'a str> {
    let mut found = None;
    for v in headers.get_all(header::COOKIE) {
        let Ok(v) = v.to_str() else { continue };
        for part in v.split(';') {
            if let Some((k, val)) = part.trim().split_once('=')
                && k.trim() == name
            {
                let val = val.trim();
                found = Some(
                    val.strip_prefix('"')
                        .and_then(|s| s.strip_suffix('"'))
                        .unwrap_or(val),
                );
            }
        }
    }
    found
}

fn text(status: StatusCode, body: &str) -> Response {
    (
        status,
        [(header::CONTENT_TYPE, "text/plain; charset=utf-8")],
        body.to_string(),
    )
        .into_response()
}

fn see_other(location: &'static str) -> Response {
    let mut r = Response::new(Body::empty());
    *r.status_mut() = StatusCode::SEE_OTHER;
    r.headers_mut()
        .insert(header::LOCATION, HeaderValue::from_static(location));
    r
}

/// `/login`, GET and POST (Python routes every method here; anything but GET is a login attempt).
pub async fn login(State(auth): State<Auth>, req: Request) -> Response {
    if req.method() == Method::GET {
        return page("", StatusCode::OK);
    }
    let ip = auth.ip(&req);
    let (mut misses, mut locks, until) = auth
        .fails
        .lock()
        .unwrap()
        .get(&ip)
        .copied()
        .unwrap_or((0, 0, 0.0));
    let now = now();
    if until > now {
        let min = ((until - now) / 60.0).floor() as i64 + 1;
        return page(
            &format!("Too many attempts. Try again in {min} min."),
            StatusCode::TOO_MANY_REQUESTS,
        );
    }
    let form_ct = req
        .headers()
        .get(header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .is_some_and(|v| {
            v.to_ascii_lowercase()
                .starts_with("application/x-www-form-urlencoded")
        });
    let ua = req
        .headers()
        .get(header::USER_AGENT)
        .map(|v| String::from_utf8_lossy(v.as_bytes()).into_owned())
        .unwrap_or_default();
    let mut resp = see_other("/");
    let sec = secure(&req);
    let Ok(body) = axum::body::to_bytes(req.into_body(), MAX_BODY).await else {
        return text(
            StatusCode::PAYLOAD_TOO_LARGE,
            "413: Request Entity Too Large",
        );
    };
    let password: String = if form_ct {
        url::form_urlencoded::parse(&body)
            .find(|(k, _)| k == "password")
            .map(|(_, v)| v.chars().take(256).collect())
            .unwrap_or_default()
    } else {
        String::new()
    };
    let ok = {
        let _g = auth.gate.lock().await; // one check at a time, at most one per second, across all clients
        let stored = auth.stored.clone();
        let ok = tokio::task::spawn_blocking(move || verify_password(&password, &stored))
            .await
            .unwrap_or(false);
        tokio::time::sleep(Duration::from_secs(1)).await;
        ok
    };
    if !ok {
        misses += 1;
        let mut fails = auth.fails.lock().unwrap();
        if misses >= PER_IP_TRIES {
            locks += 1;
            fails.insert(
                ip,
                (
                    0,
                    locks,
                    now + (LOCK_S * (1i64 << (locks - 1).min(40))) as f64,
                ),
            );
        } else {
            fails.insert(ip, (misses, locks, 0.0));
        }
        return page("Wrong password.", StatusCode::UNAUTHORIZED);
    }
    auth.fails.lock().unwrap().remove(&ip);
    let token = auth.open(&ip, &ua);
    auth.cookie(&mut resp, sec, &token);
    resp
}

/// `/logout` (POST).
pub async fn logout(State(auth): State<Auth>, req: Request) -> Response {
    auth.close(get_cookie(req.headers(), COOKIE));
    let mut resp = see_other("/login");
    resp.headers_mut().append(
        header::SET_COOKIE,
        HeaderValue::from_str(&format!(
            "{COOKIE}=\"\"; expires=Thu, 01 Jan 1970 00:00:00 GMT; Max-Age=0; Path=/"
        ))
        .unwrap(),
    );
    resp
}

/// For `axum::middleware::from_fn_with_state(auth, auth::middleware)`.
pub async fn middleware(State(auth): State<Auth>, req: Request, next: Next) -> Response {
    let path = req.uri().path();
    if PUBLIC.contains(&path) || path.starts_with("/login") {
        return next.run(req).await;
    }
    if !auth.valid(get_cookie(req.headers(), COOKIE)) {
        if path.starts_with("/api") || path == "/ws" {
            return text(StatusCode::UNAUTHORIZED, "login required");
        }
        let mut r = text(StatusCode::SEE_OTHER, "303: See Other");
        r.headers_mut()
            .insert(header::LOCATION, HeaderValue::from_static("/login"));
        return r;
    }
    if path == "/ws" {
        // a page on another site must not ride on the cookie
        let origin = req
            .headers()
            .get(header::ORIGIN)
            .and_then(|v| v.to_str().ok())
            .unwrap_or("");
        let origin = origin.split_once("://").map_or(origin, |(_, rest)| rest);
        let host = req
            .headers()
            .get(header::HOST)
            .and_then(|v| v.to_str().ok())
            .or_else(|| req.uri().authority().map(|a| a.as_str()))
            .unwrap_or("");
        if origin != host {
            return text(StatusCode::FORBIDDEN, "cross-origin WebSocket refused");
        }
    }
    next.run(req).await
}

/// For `axum::middleware::from_fn(auth::security_headers)`, outermost.
pub async fn security_headers(req: Request, next: Next) -> Response {
    let sec = secure(&req);
    let mut resp = next.run(req).await;
    let h = resp.headers_mut();
    for (k, v) in [
        ("X-Frame-Options", "DENY"),
        ("X-Content-Type-Options", "nosniff"),
        ("Referrer-Policy", "no-referrer"),
    ] {
        h.entry(k).or_insert(HeaderValue::from_static(v));
    }
    if sec {
        h.entry("Strict-Transport-Security")
            .or_insert(HeaderValue::from_static("max-age=31536000"));
    }
    resp
}

fn html_escape(s: &str) -> String {
    let mut o = String::with_capacity(s.len());
    for c in s.chars() {
        match c {
            '&' => o.push_str("&amp;"),
            '<' => o.push_str("&lt;"),
            '>' => o.push_str("&gt;"),
            '"' => o.push_str("&quot;"),
            '\'' => o.push_str("&#x27;"),
            c => o.push(c),
        }
    }
    o
}

pub fn page_html(error: &str) -> String {
    let msg = if error.is_empty() {
        String::new()
    } else {
        format!("<p class=\"err\">{}</p>", html_escape(error))
    };
    format!(
        r#"<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>bndesk</title>
<style>
html,body{{height:100%;margin:0;background:#000;color:#f5f7fa;font:14px "IBM Plex Sans",system-ui,sans-serif}}
main{{height:100%;display:grid;place-items:center}}
form{{width:280px;display:grid;gap:10px}}
h1{{font-size:16px;font-weight:600;margin:0 0 4px}}
input{{background:#07090c;border:1px solid #20262f;border-radius:3px;color:#f5f7fa;padding:9px 10px;font:inherit}}
input:focus{{outline:1px solid #7ea6f6;border-color:#7ea6f6}}
button{{background:#12161d;border:1px solid #20262f;border-radius:3px;color:#f5f7fa;padding:8px;font:inherit;cursor:pointer}}
button:hover{{border-color:#7ea6f6}}
.err{{color:#ff6a5c;margin:0}}
</style></head><body><main><form method="post" action="/login">
<h1>bndesk</h1>{msg}
<input type="text" name="username" value="bndesk" autocomplete="username" hidden>
<input type="password" name="password" placeholder="Password" autocomplete="current-password" autofocus required>
<button type="submit">Log in</button>
</form></main></body></html>"#
    )
}

fn page(error: &str, status: StatusCode) -> Response {
    (
        status,
        [(header::CONTENT_TYPE, "text/html; charset=utf-8")],
        page_html(error),
    )
        .into_response()
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::Router;
    use axum::routing::{any, get, post};

    #[test]
    fn test_hash_and_verify() {
        let h = hash_password("correct horse");
        assert!(verify_password("correct horse", &h));
        assert!(!verify_password("wrong", &h));
        assert!(!verify_password("x", "garbage"));
        assert_eq!(new_password().len(), 27);
    }

    #[test]
    fn stored_hash_verifies() {
        // a stored DESK_PASSWORD_HASH
        let h = "scrypt$32768$8$1$AAECAwQFBgcICQoLDA0ODw==$8vnHgDf7E9RQuI5RfsdygZDVR43Pk7iMIozL2sAe8FY=";
        assert!(verify_password("s3cret", h));
        assert!(!verify_password("s3cre", h));
    }

    #[test]
    fn login_page_is_stable() {
        // sha256 of the login page bodies
        assert_eq!(
            sha256_hex(&page_html("")),
            "02548f38e7433aa18bfe0e5242718b90285d5a52b9f72cefdaf7200798eb92a2"
        );
        assert_eq!(
            sha256_hex(&page_html("Wrong password.")),
            "90a21a7719f45ff7b71d94fef4b8d61ee9f5a6a146f8f145d73c100e057d0b5e"
        );
    }

    async fn client(dir: &Path, pw: &str) -> (String, Auth, reqwest::Client) {
        let au = Auth::new(&hash_password(pw), &dir.join("d.db")).unwrap();
        async fn page(_: Request) -> &'static str {
            "desk"
        }
        let app = Router::new()
            .route("/login", any(login))
            .route("/logout", post(logout))
            .route("/healthz", get(page))
            .route("/", get(page))
            .route("/api/snapshot", get(page))
            .route("/ws", get(page))
            .layer(axum::middleware::from_fn_with_state(au.clone(), middleware))
            .layer(axum::middleware::from_fn(security_headers))
            .with_state(au.clone());
        let l = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let host = l.local_addr().unwrap().to_string();
        tokio::spawn(async move {
            axum::serve(l, app.into_make_service_with_connect_info::<SocketAddr>())
                .await
                .unwrap();
        });
        let c = reqwest::Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .build()
            .unwrap();
        (host, au, c)
    }

    fn session_of(r: &reqwest::Response) -> String {
        let sc = r.headers()[header::SET_COOKIE].to_str().unwrap();
        sc.split(';')
            .next()
            .unwrap()
            .split_once('=')
            .unwrap()
            .1
            .to_string()
    }

    #[tokio::test]
    async fn test_login_flow_and_session() {
        let tmp = tempfile::tempdir().unwrap();
        let (host, au, c) = client(tmp.path(), "s3cret").await;
        let u = |p: &str| format!("http://{host}{p}");
        let r = c.get(u("/")).send().await.unwrap();
        assert!(r.status() == 303 && r.headers()["Location"] == "/login");
        assert_eq!(
            c.get(u("/api/snapshot")).send().await.unwrap().status(),
            401
        );
        assert_eq!(c.get(u("/ws")).send().await.unwrap().status(), 401);
        assert_eq!(c.get(u("/healthz")).send().await.unwrap().status(), 200);
        let r = c.get(u("/login")).send().await.unwrap();
        assert_eq!(r.status(), 200);
        assert_eq!(r.text().await.unwrap(), page_html(""));
        let r = c
            .post(u("/login"))
            .form(&[("password", "nope")])
            .send()
            .await
            .unwrap();
        assert_eq!(r.status(), 401);
        let r = c
            .post(u("/login"))
            .form(&[("password", "s3cret")])
            .send()
            .await
            .unwrap();
        let sc = r.headers()[header::SET_COOKIE]
            .to_str()
            .unwrap()
            .to_string();
        assert!(r.status() == 303 && sc.contains("HttpOnly") && sc.contains("SameSite=Strict"));
        assert!(!sc.contains("Secure"));
        let token = session_of(&r);
        let ck = format!("{COOKIE}={token}");
        assert_eq!(
            c.get(u("/api/snapshot"))
                .header("Cookie", &ck)
                .send()
                .await
                .unwrap()
                .status(),
            200
        );
        assert_eq!(
            c.get(u("/"))
                .header("Cookie", &ck)
                .send()
                .await
                .unwrap()
                .headers()["X-Frame-Options"],
            "DENY"
        );
        // a WebSocket from another origin is refused even with the cookie
        let r = c
            .get(u("/ws"))
            .header("Cookie", &ck)
            .header("Origin", "https://evil.example")
            .send()
            .await
            .unwrap();
        assert_eq!(r.status(), 403);
        let r = c
            .get(u("/ws"))
            .header("Cookie", &ck)
            .header("Origin", format!("http://{host}"))
            .send()
            .await
            .unwrap();
        assert_eq!(r.status(), 200);
        // Secure behind a TLS proxy
        let r = c
            .post(u("/login"))
            .header("X-Forwarded-Proto", "https")
            .form(&[("password", "s3cret")])
            .send()
            .await
            .unwrap();
        assert!(
            r.headers()[header::SET_COOKIE]
                .to_str()
                .unwrap()
                .ends_with("; Secure")
        );
        assert_eq!(r.headers()["Strict-Transport-Security"], "max-age=31536000");
        // sessions survive a restart (same db), and end when the password changes
        assert!(
            Auth::new(&au.stored, &tmp.path().join("d.db"))
                .unwrap()
                .valid(Some(&token))
        );
        assert!(
            !Auth::new(&hash_password("new"), &tmp.path().join("d.db"))
                .unwrap()
                .valid(Some(&token))
        );
        let r = c
            .post(u("/logout"))
            .header("Cookie", &ck)
            .send()
            .await
            .unwrap();
        assert!(r.status() == 303 && r.headers()["Location"] == "/login");
        assert_eq!(
            c.get(u("/api/snapshot"))
                .header("Cookie", &ck)
                .send()
                .await
                .unwrap()
                .status(),
            401
        );
    }

    #[tokio::test]
    async fn test_per_ip_lockout() {
        let tmp = tempfile::tempdir().unwrap();
        let (host, au, c) = client(tmp.path(), "s3cret").await;
        let u = format!("http://{host}/login");
        for _ in 0..PER_IP_TRIES {
            assert_eq!(
                c.post(&u)
                    .form(&[("password", "x")])
                    .send()
                    .await
                    .unwrap()
                    .status(),
                401
            );
        }
        let r = c
            .post(&u)
            .form(&[("password", "s3cret")])
            .send()
            .await
            .unwrap();
        assert_eq!(r.status(), 429); // locked even with the right password
        assert!(
            r.text()
                .await
                .unwrap()
                .contains("Too many attempts. Try again in 15 min.")
        );
        {
            let mut fails = au.fails.lock().unwrap();
            let ip = fails.keys().next().unwrap().clone();
            fails.insert(ip, (0, 1, now() - 1.0)); // lock over
        }
        assert_eq!(
            c.post(&u)
                .form(&[("password", "s3cret")])
                .send()
                .await
                .unwrap()
                .status(),
            303
        );
    }
}
