//! The trading engine's own figures, pushed to the desk: `POST /api/ingest/engine` (gzip JSON, a bearer token)
//! every 15 s or so from the engine's box, read back by `/api/engine/latest` (the last payload, whole) and
//! `/api/engine/series` (numbers over time).
//!
//! The payload's shape is the engine's: nothing here depends on its names. Each sample is flattened to its
//! numeric leaves ("metrics.hedge_target", "balances.mm1.USDT.free"; an array of objects is keyed by the first
//! of their `name`, `account`, `symbol`, ... fields), compressed and kept in its own SQLite file next to the
//! desk's, so the desk's db and its writer are never touched. `quotes` (the per-symbol quoting table) is kept in
//! the latest payload only. Samples are kept every one for `KEEP_FINE_MS`, then one per `THIN_MS`, for `KEEP_MS`.
//! A push may stop or come late: readers get the gaps as they are.
use std::collections::BTreeMap;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};

use anyhow::{Context, Result};
use axum::Router;
use axum::body::Bytes;
use axum::extract::{DefaultBodyLimit, Query, State};
use axum::http::{HeaderMap, StatusCode, header};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use flate2::Compression;
use flate2::read::{GzDecoder, ZlibDecoder};
use flate2::write::ZlibEncoder;
use rusqlite::{Connection, OptionalExtension, params};
use serde::Deserialize;
use serde_json::{Map, Value, json};
use subtle::ConstantTimeEq;
use tracing::{info, warn};

pub const INGEST_PATH: &str = "/api/ingest/engine";
/// Every sample this long; older ones thinned to one per `THIN_MS`.
const KEEP_FINE_MS: i64 = 7 * 86_400_000;
const THIN_MS: i64 = 300_000;
const KEEP_MS: i64 = 180 * 86_400_000;
/// How often the old samples are thinned (on an ingest).
const PRUNE_EVERY_MS: i64 = 3_600_000;
/// A body at most (compressed), and inflated.
const MAX_BODY: usize = 1 << 20;
const MAX_JSON: u64 = 8 << 20;
/// Points per series at most in one answer: a longer range is thinned to one per bucket (the last).
const MAX_POINTS: i64 = 4000;
/// Keys (or `prefix*` patterns) per series request.
const MAX_KEYS: usize = 128;
/// Top-level parts kept in the latest payload only, not flattened into the samples.
const LATEST_ONLY: [&str; 1] = ["quotes"];
/// Fields that name an element of an array of objects, in order of preference.
const ID_FIELDS: [&str; 8] = ["name", "account", "symbol", "asset", "venue", "reason", "bucket", "id"];
/// An array longer than this is not flattened (a table, not a few named figures).
const MAX_ARRAY: usize = 128;

fn now_ms() -> i64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map_or(0, |d| d.as_millis() as i64)
}

pub struct Telemetry {
    path: PathBuf,
    token: Option<Vec<u8>>,
    conn: Mutex<Connection>,
    /// The last payload, as it came (inflated), and when.
    latest: Mutex<Option<(i64, Arc<Value>)>>,
    pruned: Mutex<i64>,
}

impl Telemetry {
    /// `db`: the desk's db; the engine's samples go to `engine.db` beside it. `token`: the bearer the push
    /// must send (none: the ingest answers 404, the readers still read what is kept).
    pub fn open(db: &Path, token: Option<String>) -> Result<Arc<Self>> {
        let path = db.with_file_name("engine.db");
        let conn = Connection::open(&path).with_context(|| format!("open {}", path.display()))?;
        conn.execute_batch(
            "PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL;
             CREATE TABLE IF NOT EXISTS samples (t INTEGER PRIMARY KEY, z BLOB NOT NULL);
             CREATE TABLE IF NOT EXISTS latest (k INTEGER PRIMARY KEY CHECK (k = 0), t INTEGER NOT NULL, z BLOB NOT NULL);",
        )?;
        let latest = conn
            .query_row("SELECT t, z FROM latest WHERE k = 0", [], |r| Ok((r.get::<_, i64>(0)?, r.get::<_, Vec<u8>>(1)?)))
            .optional()?
            .and_then(|(t, z)| inflate(&z).ok().and_then(|b| serde_json::from_slice::<Value>(&b).ok()).map(|v| (t, Arc::new(v))));
        let token = token.filter(|t| !t.is_empty()).map(String::into_bytes);
        if token.is_none() {
            info!("engine telemetry: no BNDESK_INGEST_TOKEN, ingest off");
        }
        Ok(Arc::new(Self { path, token, conn: Mutex::new(conn), latest: Mutex::new(latest), pruned: Mutex::new(0) }))
    }

    fn authorized(&self, headers: &HeaderMap) -> Option<bool> {
        let want = self.token.as_ref()?;
        let got = headers
            .get(header::AUTHORIZATION)
            .and_then(|v| v.to_str().ok())
            .and_then(|v| v.strip_prefix("Bearer "))
            .unwrap_or("");
        Some(got.len() == want.len() && bool::from(got.as_bytes().ct_eq(want)))
    }

    /// Keeps one payload received at `t`.
    pub fn ingest(&self, t: i64, payload: Value) -> Result<usize> {
        let mut flat = BTreeMap::new();
        if let Value::Object(m) = &payload {
            for (k, v) in m {
                if !LATEST_ONLY.contains(&k.as_str()) {
                    flatten(k, v, &mut flat);
                }
            }
        }
        let n = flat.len();
        let z = deflate(&serde_json::to_vec(&flat)?)?;
        let whole = deflate(&serde_json::to_vec(&payload)?)?;
        {
            let c = self.conn.lock().unwrap();
            let tx = c.unchecked_transaction()?;
            tx.execute("INSERT OR REPLACE INTO samples (t, z) VALUES (?1, ?2)", params![t, z])?;
            tx.execute("INSERT OR REPLACE INTO latest (k, t, z) VALUES (0, ?1, ?2)", params![t, whole])?;
            tx.commit()?;
        }
        *self.latest.lock().unwrap() = Some((t, Arc::new(payload)));
        let due = {
            let mut p = self.pruned.lock().unwrap();
            let due = t - *p >= PRUNE_EVERY_MS;
            if due {
                *p = t;
            }
            due
        };
        if due && let Err(e) = self.prune(t) {
            warn!("engine telemetry: prune: {e:#}");
        }
        Ok(n)
    }

    /// Thins the samples older than `KEEP_FINE_MS` to one per `THIN_MS` (the first) and drops those past `KEEP_MS`.
    fn prune(&self, now: i64) -> Result<()> {
        let c = self.conn.lock().unwrap();
        c.execute("DELETE FROM samples WHERE t < ?1", params![now - KEEP_MS])?;
        c.execute(
            "DELETE FROM samples WHERE t < ?1 AND t NOT IN (SELECT MIN(t) FROM samples WHERE t < ?1 GROUP BY t / ?2)",
            params![now - KEEP_FINE_MS, THIN_MS],
        )?;
        Ok(())
    }

    /// The samples in [from, to] for `keys` (a key, or `prefix*`), thinned to one per `step` ms (the last in each).
    pub fn series(&self, from: i64, to: i64, step: i64, keys: &[String]) -> Result<Value> {
        let rows: Vec<(i64, Vec<u8>)> = {
            let c = Connection::open_with_flags(&self.path, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY)?;
            // one row per bucket chosen in SQL (the last): only those are read and inflated
            if step > 0 {
                let mut q = c.prepare(
                    "SELECT t, z FROM samples WHERE t IN \
                     (SELECT MAX(t) FROM samples WHERE t >= ?1 AND t <= ?2 GROUP BY t / ?3) ORDER BY t",
                )?;
                q.query_map(params![from, to, step], |r| Ok((r.get(0)?, r.get(1)?)))?.collect::<rusqlite::Result<_>>()?
            } else {
                let mut q = c.prepare("SELECT t, z FROM samples WHERE t >= ?1 AND t <= ?2 ORDER BY t")?;
                q.query_map(params![from, to], |r| Ok((r.get(0)?, r.get(1)?)))?.collect::<rusqlite::Result<_>>()?
            }
        };
        // the last row of each bucket
        let mut picked: Vec<&(i64, Vec<u8>)> = Vec::new();
        for r in &rows {
            match picked.last_mut() {
                Some(last) if step > 0 && last.0.div_euclid(step) == r.0.div_euclid(step) => *last = r,
                _ => picked.push(r),
            }
        }
        let (exact, prefixes): (Vec<&String>, Vec<&str>) = {
            let mut e = Vec::new();
            let mut p = Vec::new();
            for k in keys {
                match k.strip_suffix('*') {
                    Some(pre) => p.push(pre),
                    None => e.push(k),
                }
            }
            (e, p)
        };
        let mut ts = Vec::with_capacity(picked.len());
        let mut cols: BTreeMap<String, Vec<Option<f64>>> = BTreeMap::new();
        for k in &exact {
            cols.insert((*k).clone(), Vec::with_capacity(picked.len()));
        }
        for (t, z) in &picked {
            let Ok(m) = inflate(z).and_then(|b| Ok(serde_json::from_slice::<BTreeMap<String, f64>>(&b)?)) else { continue };
            ts.push(*t);
            for k in m.keys() {
                if !cols.contains_key(k) && prefixes.iter().any(|p| k.starts_with(p)) {
                    cols.insert(k.clone(), vec![None; ts.len() - 1]);
                }
            }
            for (k, col) in cols.iter_mut() {
                col.resize(ts.len() - 1, None);
                col.push(m.get(k).copied());
            }
        }
        let v: Map<String, Value> = cols.into_iter().map(|(k, c)| (k, json!(c))).collect();
        Ok(json!({ "t": ts, "v": v }))
    }

    pub fn latest(&self) -> Option<(i64, Arc<Value>)> {
        self.latest.lock().unwrap().clone()
    }
}

/// The numeric leaves of `v` under `path` (bools as 0 / 1).
fn flatten(path: &str, v: &Value, out: &mut BTreeMap<String, f64>) {
    match v {
        Value::Number(n) => {
            if let Some(x) = n.as_f64().filter(|x| x.is_finite()) {
                out.insert(path.to_string(), x);
            }
        }
        Value::Bool(b) => {
            out.insert(path.to_string(), if *b { 1.0 } else { 0.0 });
        }
        Value::Object(m) => {
            // {"name": "hedge_target", "value": 1.0}: a named figure
            if let (Some(Value::String(name)), Some(val)) = (m.get("name"), m.get("value"))
                && m.len() == 2
            {
                flatten(&format!("{path}.{name}"), val, out);
                return;
            }
            for (k, x) in m {
                flatten(&format!("{path}.{k}"), x, out);
            }
        }
        Value::Array(a) if a.len() <= MAX_ARRAY => {
            for (i, x) in a.iter().enumerate() {
                let id = match x {
                    Value::Object(m) => {
                        let parts: Vec<String> = ID_FIELDS
                            .iter()
                            .filter_map(|f| match m.get(*f) {
                                Some(Value::String(s)) => Some(s.clone()),
                                Some(Value::Number(n)) if *f == "id" || *f == "bucket" => Some(n.to_string()),
                                _ => None,
                            })
                            .collect();
                        if parts.is_empty() { i.to_string() } else { parts.join(".") }
                    }
                    _ => i.to_string(),
                };
                // {"name": "hedge_target", "value": 1.0} in a list: the value under its name
                if let Value::Object(m) = x
                    && m.len() == 2
                    && let (Some(Value::String(_)), Some(val)) = (m.get("name"), m.get("value"))
                {
                    flatten(&format!("{path}.{id}"), val, out);
                    continue;
                }
                flatten(&format!("{path}.{id}"), x, out);
            }
        }
        _ => {}
    }
}

fn deflate(b: &[u8]) -> Result<Vec<u8>> {
    let mut e = ZlibEncoder::new(Vec::new(), Compression::default());
    e.write_all(b)?;
    Ok(e.finish()?)
}

fn inflate(z: &[u8]) -> Result<Vec<u8>> {
    let mut out = Vec::new();
    ZlibDecoder::new(z).take(MAX_JSON).read_to_end(&mut out)?;
    Ok(out)
}

fn text(code: StatusCode, msg: &'static str) -> Response {
    (code, msg).into_response()
}

async fn ingest(State(t): State<Arc<Telemetry>>, headers: HeaderMap, body: Bytes) -> Response {
    match t.authorized(&headers) {
        None => return text(StatusCode::NOT_FOUND, "not found"),
        Some(false) => return text(StatusCode::UNAUTHORIZED, "bad token"),
        Some(true) => {}
    }
    let gz = headers
        .get(header::CONTENT_ENCODING)
        .and_then(|v| v.to_str().ok())
        .is_some_and(|v| v.eq_ignore_ascii_case("gzip"));
    let json = if gz {
        let mut out = Vec::new();
        if GzDecoder::new(&body[..]).take(MAX_JSON).read_to_end(&mut out).is_err() {
            return text(StatusCode::BAD_REQUEST, "bad gzip");
        }
        out
    } else {
        body.to_vec()
    };
    let Ok(payload) = serde_json::from_slice::<Value>(&json) else { return text(StatusCode::BAD_REQUEST, "bad json") };
    if !payload.is_object() {
        return text(StatusCode::BAD_REQUEST, "want an object");
    }
    let now = now_ms();
    match tokio::task::spawn_blocking(move || t.ingest(now, payload)).await {
        Ok(Ok(n)) => (StatusCode::OK, axum::Json(json!({ "t": now, "figures": n }))).into_response(),
        Ok(Err(e)) => {
            warn!("engine telemetry: ingest: {e:#}");
            text(StatusCode::INTERNAL_SERVER_ERROR, "store failed")
        }
        Err(_) => text(StatusCode::INTERNAL_SERVER_ERROR, "store failed"),
    }
}

async fn latest(State(t): State<Arc<Telemetry>>) -> Response {
    let now = now_ms();
    let body = match t.latest() {
        Some((at, v)) => json!({ "t": at, "now": now, "payload": &*v }),
        None => json!({ "t": null, "now": now, "payload": null }),
    };
    let mut r = axum::Json(body).into_response();
    r.headers_mut().insert(header::CACHE_CONTROL, header::HeaderValue::from_static("no-store"));
    r
}

#[derive(Deserialize)]
struct SeriesQ {
    from: Option<i64>,
    to: Option<i64>,
    /// Comma-separated keys; a key ending in `*` is every key with that prefix.
    keys: String,
    /// Bucket, seconds (at least the range over `MAX_POINTS`).
    step: Option<i64>,
}

async fn series(State(t): State<Arc<Telemetry>>, Query(q): Query<SeriesQ>) -> Response {
    let now = now_ms();
    let to = q.to.unwrap_or(now);
    // never more than what is kept: a wider range reads nothing more and costs memory
    let from = q.from.unwrap_or(to.saturating_sub(86_400_000)).max(to.saturating_sub(KEEP_MS));
    if from > to {
        return text(StatusCode::BAD_REQUEST, "from after to");
    }
    let keys: Vec<String> = q.keys.split(',').map(str::trim).filter(|k| !k.is_empty()).map(String::from).collect();
    if keys.is_empty() || keys.len() > MAX_KEYS {
        return text(StatusCode::BAD_REQUEST, "keys: 1 to 128");
    }
    let step = q.step.unwrap_or(0).clamp(0, KEEP_MS / 1000) * 1000;
    let step = step.max((to - from) / MAX_POINTS);
    match tokio::task::spawn_blocking(move || t.series(from, to, step, &keys)).await {
        Ok(Ok(v)) => axum::Json(v).into_response(),
        Ok(Err(e)) => {
            warn!("engine telemetry: series: {e:#}");
            text(StatusCode::INTERNAL_SERVER_ERROR, "read failed")
        }
        Err(_) => text(StatusCode::INTERNAL_SERVER_ERROR, "read failed"),
    }
}

/// `/api/ingest/engine` must be public to the session check (it has its own token); the readers are not.
pub fn routes(t: Arc<Telemetry>) -> Router {
    Router::new()
        .route(INGEST_PATH, post(ingest).layer(DefaultBodyLimit::max(MAX_BODY)))
        .route("/api/engine/latest", get(latest))
        .route("/api/engine/series", get(series))
        .with_state(t)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn flattens_named_figures_and_keyed_arrays() {
        let v = json!({
            "metrics": [{"name": "hedge_target", "value": -1780.5}, {"name": "paused", "value": 0}],
            "balances": [{"account": "mm1", "asset": "USDT", "free": 10.0, "locked": 2.5}],
            "kill": {"active": false},
            "label": "x",
        });
        let mut out = BTreeMap::new();
        for (k, x) in v.as_object().unwrap() {
            flatten(k, x, &mut out);
        }
        assert_eq!(out["metrics.hedge_target"], -1780.5);
        assert_eq!(out["metrics.paused"], 0.0);
        assert_eq!(out["balances.mm1.USDT.free"], 10.0);
        assert_eq!(out["balances.mm1.USDT.locked"], 2.5);
        assert_eq!(out["kill.active"], 0.0);
        assert!(!out.contains_key("label"));
    }

    #[test]
    fn keeps_thins_and_reads_back() {
        let dir = tempfile::tempdir().unwrap();
        let t = Telemetry::open(&dir.path().join("d.db"), Some("tok".into())).unwrap();
        let base = 1_800_000_000_000i64;
        for i in 0..10 {
            t.ingest(base + i * 15_000, json!({"metrics": {"hedge_target": i as f64}, "quotes": [{"symbol": "A"}]})).unwrap();
        }
        let s = t.series(base, base + 1_000_000, 0, &["metrics.*".into()]).unwrap();
        assert_eq!(s["t"].as_array().unwrap().len(), 10);
        assert_eq!(s["v"]["metrics.hedge_target"][9], 9.0);
        // one per minute: the last of each
        let s = t.series(base, base + 1_000_000, 60_000, &["metrics.hedge_target".into()]).unwrap();
        assert!(s["t"].as_array().unwrap().len() <= 4);
        // quotes only in the latest payload
        assert!(t.latest().unwrap().1["quotes"].is_array());
        let s = t.series(base, base + 1_000_000, 0, &["quotes*".into()]).unwrap();
        assert!(s["v"].as_object().unwrap().is_empty());
        // a reopen keeps the latest
        drop(t);
        let t = Telemetry::open(&dir.path().join("d.db"), None).unwrap();
        assert_eq!(t.latest().unwrap().0, base + 9 * 15_000);
        assert!(t.authorized(&HeaderMap::new()).is_none());
        // thinning: past KEEP_FINE_MS one per THIN_MS remains
        t.prune(base + KEEP_FINE_MS + 1_000_000).unwrap();
        let s = t.series(base, base + 1_000_000, 0, &["metrics.hedge_target".into()]).unwrap();
        assert_eq!(s["t"].as_array().unwrap().len(), 1);
    }

    #[test]
    fn token_is_checked() {
        let dir = tempfile::tempdir().unwrap();
        let t = Telemetry::open(&dir.path().join("d.db"), Some("s3cret".into())).unwrap();
        let mut h = HeaderMap::new();
        assert_eq!(t.authorized(&h), Some(false));
        h.insert(header::AUTHORIZATION, "Bearer nope".parse().unwrap());
        assert_eq!(t.authorized(&h), Some(false));
        h.insert(header::AUTHORIZATION, "Bearer s3cret".parse().unwrap());
        assert_eq!(t.authorized(&h), Some(true));
    }

    #[tokio::test]
    async fn ingest_is_public_to_its_token_and_readers_need_a_session() {
        use flate2::write::GzEncoder;
        let dir = tempfile::tempdir().unwrap();
        let t = Telemetry::open(&dir.path().join("d.db"), Some("tok-123".into())).unwrap();
        let au = crate::auth::Auth::new(&crate::auth::hash_password("pw"), &dir.path().join("d.db")).unwrap();
        let app = routes(t).layer(axum::middleware::from_fn_with_state(au, crate::auth::middleware));
        let l = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let host = l.local_addr().unwrap();
        tokio::spawn(async move {
            axum::serve(l, app.into_make_service_with_connect_info::<std::net::SocketAddr>()).await.unwrap();
        });
        let c = reqwest::Client::new();
        let mut gz = GzEncoder::new(Vec::new(), Compression::default());
        gz.write_all(br#"{"metrics":[{"name":"hedge_target","value":-1780}],"quotes":[]}"#).unwrap();
        let body = gz.finish().unwrap();
        let post = |tok: &str| {
            c.post(format!("http://{host}{INGEST_PATH}"))
                .header("Content-Encoding", "gzip")
                .header("Authorization", format!("Bearer {tok}"))
                .body(body.clone())
                .send()
        };
        assert_eq!(post("wrong").await.unwrap().status(), 401);
        let r = post("tok-123").await.unwrap();
        assert_eq!(r.status(), 200);
        assert_eq!(r.json::<Value>().await.unwrap()["figures"], 1);
        assert_eq!(c.get(format!("http://{host}/api/engine/latest")).send().await.unwrap().status(), 401);
        assert_eq!(c.get(format!("http://{host}/api/engine/series?keys=metrics.*")).send().await.unwrap().status(), 401);
    }
}
